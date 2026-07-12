// Package netstack is the in-browser gVisor network stack for container2wasm,
// with the outbound dial left pluggable. main.go (wasip1) injects the @webvpn
// dialer; tests inject net.Dial. This is the only thing that differs from
// upstream c2w-net-proxy - see the package README.
package netstack

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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
// to a DoH endpoint - much faster than tunnelling a fresh @webvpn UDP socket
// per query. Optional; if nil, the gateway:53 forwarder falls back to
// dialing UpstreamDNS via Dial("udp", …).
type ResolveDNSFunc func(query []byte) ([]byte, error)

// ImagePuller streams an in-browser-pulled docker-archive tar to the guest via
// a gateway HTTP server (default :9090). JS side runs the OCI Registry V2
// client (via @fkn/lib's serverProxyFetch) and stashes the resulting bytes per
// ref; we just byte-pump through the netstack to whatever runs in the guest
// (e.g. `wget http://192.168.127.1:9090/img/<ref>` piped to buildah pull).
type ImagePuller interface {
	Size(ref string) (int, error)
	Chunk(ref string, offset int, buf []byte) (int, error)
}

// ImageHTTPPort is the gateway port the image-streaming server listens on.
const ImageHTTPPort = 9090

// Config configures the network stack.
type Config struct {
	Debug       bool
	Dial        DialFunc // required
	UpstreamDNS string   // e.g. "1.1.1.1:53"; if empty DNS forwarding is disabled
	ResolveDNS  ResolveDNSFunc
	ImagePuller ImagePuller
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
			return nil, fmt.Errorf("start dns forwarder: %w", err)
		}
	}

	if cfg.ImagePuller != nil {
		if err := n.serveImageHTTP(cfg.ImagePuller); err != nil {
			log.Printf("image http server failed to start: %v", err)
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
						n, writeErr := conn.WriteTo(resp, from)
						if writeErr != nil || n != len(resp) {
							log.Printf("dns: write response to %s: wrote %d/%d bytes: %v", from, n, len(resp), writeErr)
						}
						return
					}
					if err != nil {
						log.Printf("dns: host resolver failed: %v", err)
					}
					// fall through to UDP dial if DoH fails and we have one.
					if upstream == "" {
						return
					}
				}
				up, err := dial("udp", upstream)
				if err != nil {
					log.Printf("dns: dial %s: %v", upstream, err)
					return
				}
				defer up.Close()
				if _, err := up.Write(query); err != nil {
					log.Printf("dns: write query to %s: %v", upstream, err)
					return
				}
				_ = up.SetReadDeadline(time.Now().Add(5 * time.Second))
				resp := make([]byte, MTU)
				rn, err := up.Read(resp)
				if err != nil {
					log.Printf("dns: read response from %s: %v", upstream, err)
					return
				}
				n, writeErr := conn.WriteTo(resp[:rn], from)
				if writeErr != nil || n != rn {
					log.Printf("dns: write response to %s: wrote %d/%d bytes: %v", from, n, rn, writeErr)
				}
			}(query, from)
		}
	}()
	return nil
}

// serveImageHTTP listens on the gateway's port (default 9090) and serves
// `/img/<ref>` by pulling sized chunks from puller. The guest's auto-paste
// script does `wget http://192.168.127.1:9090/img/<ref>` to drop the
// docker-archive tar into /tmp before `buildah pull docker-archive:`.
func (n *Network) serveImageHTTP(puller ImagePuller) error {
	l, err := gonet.ListenTCP(n.stack, tcpip.FullAddress{
		NIC:  nicID,
		Addr: tcpip.AddrFrom4Slice(net.ParseIP(GatewayIP).To4()),
		Port: ImageHTTPPort,
	}, ipv4.ProtocolNumber)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/img/", func(w http.ResponseWriter, r *http.Request) {
		ref := strings.TrimPrefix(r.URL.Path, "/img/")
		ref, err := url.PathUnescape(ref)
		if err != nil {
			http.Error(w, "bad ref", http.StatusBadRequest)
			return
		}
		size, err := puller.Size(ref)
		if err != nil || size <= 0 {
			log.Printf("imageHTTP size(%s) failed: size=%d err=%v", ref, size, err)
			http.Error(w, "image not available", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/x-tar")
		w.Header().Set("Content-Length", strconv.Itoa(size))
		w.WriteHeader(http.StatusOK)
		// Stream in 4 KiB chunks (matches the SAB data window on the JS bridge).
		buf := make([]byte, 4096)
		offset := 0
		for offset < size {
			want := size - offset
			if want > len(buf) {
				want = len(buf)
			}
			nb, err := puller.Chunk(ref, offset, buf[:want])
			if err != nil || nb == 0 {
				return
			}
			if _, err := w.Write(buf[:nb]); err != nil {
				return
			}
			offset += nb
		}
	})
	srv := &http.Server{Handler: mux}
	go func() {
		if err := srv.Serve(l); err != nil {
			log.Printf("image http server exited: %v", err)
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
