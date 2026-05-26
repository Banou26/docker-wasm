// Package netstack is the in-browser gVisor network stack for container2wasm,
// with the outbound dial left pluggable. main.go (wasip1) injects the @webvpn
// dialer; tests inject net.Dial. This is the only thing that differs from
// upstream c2w-net-proxy — see the package README.
package netstack

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/services/forwarder"
	gvntap "github.com/containers/gvisor-tap-vsock/pkg/tap"
	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
	gvntypes "github.com/containers/gvisor-tap-vsock/pkg/types"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/network/arp"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/icmp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

const (
	GatewayIP     = "192.168.127.1"
	GatewayMAC    = "5a:94:ef:e4:0c:dd"
	SubnetCIDR    = "192.168.127.0/24"
	MTU           = 1500
	nicID         = 1
	linkLocalCIDR = "169.254.0.0/16"

	// UDP flows are reaped after this idle period (mirrors gvisor-tap-vsock's
	// internal, unexported UDPConnTrackTimeout).
	udpConnTrackTimeout = 90 * time.Second
)

// DialFunc dials the real destination of a terminated flow. In the browser
// build this routes through @webvpn; in tests it's net.Dial.
type DialFunc func(network, address string) (net.Conn, error)

// ResolveDNSFunc takes a raw DNS query (wire format) and returns the raw DNS
// response. In the browser this is plumbed through @fkn/lib's serverProxyFetch
// to a DoH endpoint — much faster than tunnelling a fresh @webvpn UDP socket
// per query. Optional; if nil, the gateway:53 forwarder falls back to
// dialing UpstreamDNS via Dial("udp", …).
type ResolveDNSFunc func(query []byte) ([]byte, error)

// Config configures the network stack.
type Config struct {
	Debug       bool
	Dial        DialFunc // required
	UpstreamDNS string   // e.g. "1.1.1.1:53"; if empty DNS forwarding is disabled
	ResolveDNS  ResolveDNSFunc
}

// Network is an assembled stack ready to serve a guest connection.
type Network struct {
	stack *stack.Stack
	sw    *gvntap.Switch
	pool  *gvntap.IPPool
}

// New assembles the gVisor stack + tap switch from gvisor-tap-vsock's exported
// building blocks (mirrors virtualnetwork.New/createStack) and installs the
// dial-pluggable TCP/UDP forwarders plus a gateway DNS forwarder.
func New(cfg Config) (*Network, error) {
	if cfg.Dial == nil {
		return nil, errors.New("netstack: Config.Dial is required")
	}

	_, subnet, err := net.ParseCIDR(SubnetCIDR)
	if err != nil {
		return nil, fmt.Errorf("parse subnet: %w", err)
	}

	pool := gvntap.NewIPPool(subnet)
	pool.Reserve(net.ParseIP(GatewayIP), GatewayMAC)

	tapEndpoint, err := gvntap.NewLinkEndpoint(cfg.Debug, MTU, GatewayMAC, GatewayIP, nil)
	if err != nil {
		return nil, fmt.Errorf("create tap endpoint: %w", err)
	}
	sw := gvntap.NewSwitch(cfg.Debug, MTU)
	tapEndpoint.Connect(sw)
	sw.Connect(tapEndpoint)

	s := stack.New(stack.Options{
		NetworkProtocols: []stack.NetworkProtocolFactory{
			ipv4.NewProtocol,
			arp.NewProtocol,
		},
		TransportProtocols: []stack.TransportProtocolFactory{
			tcp.NewProtocol,
			udp.NewProtocol,
			icmp.NewProtocol4,
		},
	})
	if tcpErr := s.CreateNIC(nicID, tapEndpoint); tcpErr != nil {
		return nil, errors.New(tcpErr.String())
	}
	if tcpErr := s.AddProtocolAddress(nicID, tcpip.ProtocolAddress{
		Protocol:          ipv4.ProtocolNumber,
		AddressWithPrefix: tcpip.AddrFrom4Slice(net.ParseIP(GatewayIP).To4()).WithPrefix(),
	}, stack.AddressProperties{}); tcpErr != nil {
		return nil, errors.New(tcpErr.String())
	}
	s.SetSpoofing(nicID, true)
	s.SetPromiscuousMode(nicID, true)

	tcpipSubnet, err := tcpip.NewSubnet(tcpip.AddrFromSlice(subnet.IP), tcpip.MaskFromBytes(subnet.Mask))
	if err != nil {
		return nil, fmt.Errorf("build tcpip subnet: %w", err)
	}
	s.SetRouteTable([]tcpip.Route{{Destination: tcpipSubnet, NIC: nicID}})

	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpForwarder(s, cfg.Dial).HandlePacket)
	s.SetTransportProtocolHandler(udp.ProtocolNumber, udpForwarder(s, cfg.Dial).HandlePacket)

	n := &Network{stack: s, sw: sw, pool: pool}

	// DHCP hands the guest its address + points its resolver at the gateway.
	// The gvisor-tap-vsock dhcp service only compiles for wasip1 (its dhcp
	// dependency is patched for wasm), so it's behind a build tag; the native
	// test build uses a no-op and a statically-addressed guest.
	if err := n.startDHCP(cfg); err != nil {
		return nil, fmt.Errorf("dhcp: %w", err)
	}

	if cfg.UpstreamDNS != "" || cfg.ResolveDNS != nil {
		if err := n.serveDNS(cfg.Dial, cfg.UpstreamDNS, cfg.ResolveDNS); err != nil {
			log.Printf("dns forwarder failed to start: %v", err)
		}
	}

	return n, nil
}

// Stack exposes the underlying gVisor stack (used by tests).
func (n *Network) Stack() *stack.Stack { return n.stack }

// Serve reads QEMU-protocol ethernet frames from conn until it closes.
func (n *Network) Serve(ctx context.Context, conn net.Conn) error {
	return n.sw.Accept(ctx, conn, gvntypes.QemuProtocol)
}

func tcpForwarder(s *stack.Stack, dial DialFunc) *tcp.Forwarder {
	return tcp.NewForwarder(s, 0, 10, func(r *tcp.ForwarderRequest) {
		id := r.ID()
		if linkLocal().Contains(id.LocalAddress) {
			r.Complete(true)
			return
		}
		address := fmt.Sprintf("%s:%d", id.LocalAddress, id.LocalPort)
		outbound, err := dial("tcp", address)
		if err != nil {
			log.Printf("dial(tcp, %s) = %v", address, err)
			r.Complete(true)
			return
		}

		var wq waiter.Queue
		ep, tcpErr := r.CreateEndpoint(&wq)
		r.Complete(false)
		if tcpErr != nil {
			outbound.Close()
			return
		}

		remote := tcpproxy.DialProxy{
			DialContext: func(context.Context, string, string) (net.Conn, error) { return outbound, nil },
		}
		remote.HandleConn(gonet.NewTCPConn(&wq, ep))
	})
}

func udpForwarder(s *stack.Stack, dial DialFunc) *udp.Forwarder {
	return udp.NewForwarder(s, func(r *udp.ForwarderRequest) {
		id := r.ID()
		if linkLocal().Contains(id.LocalAddress) || id.LocalAddress == header.IPv4Broadcast {
			return
		}
		var wq waiter.Queue
		ep, tcpErr := r.CreateEndpoint(&wq)
		if tcpErr != nil {
			return
		}
		address := fmt.Sprintf("%s:%d", id.LocalAddress, id.LocalPort)
		p, err := forwarder.NewUDPProxy(
			&autoStoppingListener{underlying: gonet.NewUDPConn(&wq, ep)},
			func() (net.Conn, error) { return dial("udp", address) },
		)
		if err != nil {
			ep.Close()
			return
		}
		go func() {
			p.Run()
			ep.Close()
		}()
	})
}

// serveDNS binds UDP on the gateway's port 53 and relays each query out through
// dial to upstream (the guest's resolver is pointed at the gateway by DHCP).
func (n *Network) serveDNS(dial DialFunc, upstream string, resolve ResolveDNSFunc) error {
	conn, err := gonet.DialUDP(n.stack, &tcpip.FullAddress{
		NIC:  nicID,
		Addr: tcpip.AddrFrom4Slice(net.ParseIP(GatewayIP).To4()),
		Port: 53,
	}, nil, ipv4.ProtocolNumber)
	if err != nil {
		return err
	}
	go func() {
		buf := make([]byte, MTU)
		for {
			nb, from, err := conn.ReadFrom(buf)
			if err != nil {
				log.Printf("dns: read error: %v", err)
				return
			}
			query := append([]byte(nil), buf[:nb]...)
			go func(query []byte, from net.Addr) {
				// Preferred path: hand bytes to the host's DoH (no per-query
				// UDP socket through @webvpn).
				if resolve != nil {
					resp, err := resolve(query)
					if err == nil && len(resp) > 0 {
						_, _ = conn.WriteTo(resp, from)
						return
					}
					// fall through to UDP dial if DoH fails and we have one.
					if upstream == "" {
						return
					}
				}
				up, err := dial("udp", upstream)
				if err != nil {
					return
				}
				defer up.Close()
				if _, err := up.Write(query); err != nil {
					return
				}
				_ = up.SetReadDeadline(time.Now().Add(5 * time.Second))
				resp := make([]byte, MTU)
				rn, err := up.Read(resp)
				if err != nil {
					return
				}
				_, _ = conn.WriteTo(resp[:rn], from)
			}(query, from)
		}
	}()
	return nil
}

func linkLocal() *tcpip.Subnet {
	_, parsed, _ := net.ParseCIDR(linkLocalCIDR)
	subnet, _ := tcpip.NewSubnet(tcpip.AddrFromSlice(parsed.IP), tcpip.MaskFromBytes(parsed.Mask))
	return &subnet
}

type autoStoppingListener struct {
	underlying interface {
		ReadFrom([]byte) (int, net.Addr, error)
		WriteTo([]byte, net.Addr) (int, error)
		SetReadDeadline(time.Time) error
		io.Closer
	}
}

func (l *autoStoppingListener) ReadFrom(b []byte) (int, net.Addr, error) {
	_ = l.underlying.SetReadDeadline(time.Now().Add(udpConnTrackTimeout))
	return l.underlying.ReadFrom(b)
}

func (l *autoStoppingListener) WriteTo(b []byte, addr net.Addr) (int, error) {
	_ = l.underlying.SetReadDeadline(time.Now().Add(udpConnTrackTimeout))
	return l.underlying.WriteTo(b, addr)
}

func (l *autoStoppingListener) SetReadDeadline(t time.Time) error {
	return l.underlying.SetReadDeadline(t)
}

func (l *autoStoppingListener) Close() error { return l.underlying.Close() }
