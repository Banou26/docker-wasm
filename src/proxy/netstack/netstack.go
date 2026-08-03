// Package netstack is the in-browser gVisor network stack for container2wasm,
// with the outbound dial left pluggable - the only thing that differs from upstream c2w-net-proxy.
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

	// Mirrors gvisor-tap-vsock's internal, unexported UDPConnTrackTimeout.
	udpConnTrackTimeout = 90 * time.Second
)

type DialFunc func(network, address string) (net.Conn, error)

type ResolveDNSFunc func(query []byte) ([]byte, error)

type ImagePuller interface {
	Size(ref string) (int, error)
	Chunk(ref string, offset int, buf []byte) (int, error)
}

const (
	ImageHTTPPort  = 9090
	imageChunkSize = 64 * 1024
)

type Config struct {
	Debug       bool
	Dial        DialFunc
	UpstreamDNS string
	ResolveDNS  ResolveDNSFunc
	ImagePuller ImagePuller
	GuestIP     string
	PollIngress PollIngressFunc
}

type Network struct {
	stack       *stack.Stack
	sw          *gvntap.Switch
	pool        *gvntap.IPPool
	pollIngress PollIngressFunc
	guestIP     string
}

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

	n := &Network{
		stack:       s,
		sw:          sw,
		pool:        pool,
		pollIngress: cfg.PollIngress,
		guestIP:     cfg.GuestIP,
	}

	// The gvisor-tap-vsock dhcp service only compiles for wasip1, so it's behind a build tag.
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

func (n *Network) Stack() *stack.Stack { return n.stack }

func (n *Network) Serve(ctx context.Context, conn net.Conn) error {
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if n.pollIngress != nil {
		go n.serveIngress(serveCtx, n.pollIngress, n.guestIP)
	}
	return n.sw.Accept(serveCtx, conn, gvntypes.QemuProtocol)
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
		// Fill the complete SharedArrayBuffer data window on each JS bridge call.
		buf := make([]byte, imageChunkSize)
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
