// e2e_test.go — hermetic end-to-end test of the netstack data path.
//
// It can't use the real container2wasm emulator (that needs the c2w build
// toolchain) or @webvpn (browser-only), so it substitutes:
//   - the guest: a second gVisor stack with an ethernet link endpoint, wired to
//     the proxy over a loopback TCP connection carrying QEMU-protocol frames —
//     exactly the framing the real emulator emits.
//   - @webvpn egress: net.Dial to local echo servers.
//
// What it proves: a guest TCP/UDP flow is terminated by the proxy's gVisor
// stack, handed to the dial-pluggable forwarder, dialed out, and bytes flow
// both ways. That's the whole novel data path; only the two substituted ends
// differ from production.
package netstack

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/link/ethernet"
	"gvisor.dev/gvisor/pkg/tcpip/network/arp"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/icmp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

const guestIP = "192.168.127.10"
const guestMAC = "02:00:00:00:00:10"

// dstIP is an arbitrary off-subnet address the guest "connects to". The proxy
// forwarder extracts it from the terminated flow; the test's dial asserts it
// and redirects to a local echo server (standing in for @webvpn egress).
const dstIP = "10.0.0.1"

func TestTCPForwardThroughProxy(t *testing.T) {
	// 1. local "internet" TCP echo server (stands in for the @webvpn dest).
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echoLn.Close()
	go func() {
		for {
			c, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()

	const dstPort = 80
	var gotAddr string
	dial := func(network, address string) (net.Conn, error) {
		gotAddr = address
		return net.Dial("tcp", echoLn.Addr().String())
	}
	guest := setup(t, dial)

	// 2. guest dials the destination *through the proxy* and round-trips data.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := gonet.DialContextTCP(ctx, guest, tcpip.FullAddress{
		NIC:  1,
		Addr: tcpip.AddrFrom4Slice(net.ParseIP(dstIP).To4()),
		Port: dstPort,
	}, ipv4.ProtocolNumber)
	if err != nil {
		t.Fatalf("guest dial through proxy failed: %v", err)
	}
	defer conn.Close()

	want := []byte("hello over the @webvpn data path")
	if _, err := conn.Write(want); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len(want))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("echo mismatch: got %q want %q", got, want)
	}
	wantAddr := net.JoinHostPort(dstIP, "80")
	if gotAddr != wantAddr {
		t.Fatalf("forwarder extracted wrong destination: got %q want %q", gotAddr, wantAddr)
	}
	t.Logf("TCP round-trip OK: guest -> proxy forwarder (dst=%s) -> dial -> echo -> back (%d bytes)", gotAddr, len(got))
}

func TestUDPForwardThroughProxy(t *testing.T) {
	// local UDP echo server.
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			pc.WriteTo(buf[:n], addr)
		}
	}()
	const dstPort = 9999
	var gotAddr string
	dial := func(network, address string) (net.Conn, error) {
		gotAddr = address
		return net.Dial("udp", pc.LocalAddr().String())
	}
	guest := setup(t, dial)

	conn, err := gonet.DialUDP(guest, nil, &tcpip.FullAddress{
		NIC:  1,
		Addr: tcpip.AddrFrom4Slice(net.ParseIP(dstIP).To4()),
		Port: dstPort,
	}, ipv4.ProtocolNumber)
	if err != nil {
		t.Fatalf("guest udp dial failed: %v", err)
	}
	defer conn.Close()

	want := []byte("udp datagram via forwarder")
	if _, err := conn.Write(want); err != nil {
		t.Fatalf("udp write: %v", err)
	}
	got := make([]byte, 2048)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := conn.Read(got)
	if err != nil {
		t.Fatalf("udp read echo: %v", err)
	}
	if string(got[:n]) != string(want) {
		t.Fatalf("udp echo mismatch: got %q want %q", got[:n], want)
	}
	wantAddr := net.JoinHostPort(dstIP, "9999")
	if gotAddr != wantAddr {
		t.Fatalf("udp forwarder extracted wrong destination: got %q want %q", gotAddr, wantAddr)
	}
	t.Logf("UDP round-trip OK: guest -> proxy forwarder (dst=%s) -> dial -> echo -> back (%d bytes)", gotAddr, n)
}

// setup builds the proxy network + a guest stack connected to it over a
// QEMU-framed loopback connection, and returns the guest stack.
func setup(t *testing.T, dial DialFunc) *stack.Stack {
	t.Helper()

	// loopback transport between guest and proxy (buffered, unlike net.Pipe).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	guestConn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	proxyConn := <-accepted

	// proxy: our netstack, egress via the supplied dial (stands in for @webvpn).
	nw, err := New(Config{Dial: dial})
	if err != nil {
		t.Fatalf("netstack.New: %v", err)
	}
	go func() {
		if err := nw.Serve(context.Background(), proxyConn); err != nil {
			t.Logf("proxy serve ended: %v", err)
		}
	}()

	guest := newGuestStack(t, guestConn)
	t.Cleanup(func() { guestConn.Close(); proxyConn.Close() })
	return guest
}

// newGuestStack builds a minimal gVisor "guest" with an ethernet link endpoint
// bridged to conn via QEMU framing.
func newGuestStack(t *testing.T, conn net.Conn) *stack.Stack {
	t.Helper()

	hw, err := net.ParseMAC(guestMAC)
	if err != nil {
		t.Fatal(err)
	}
	base := channel.New(512, MTU, tcpip.LinkAddress(hw))
	ep := ethernet.New(base)

	s := stack.New(stack.Options{
		NetworkProtocols: []stack.NetworkProtocolFactory{ipv4.NewProtocol, arp.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{
			tcp.NewProtocol, udp.NewProtocol, icmp.NewProtocol4,
		},
	})
	if e := s.CreateNIC(1, ep); e != nil {
		t.Fatalf("guest CreateNIC: %v", e)
	}
	if e := s.AddProtocolAddress(1, tcpip.ProtocolAddress{
		Protocol:          ipv4.ProtocolNumber,
		AddressWithPrefix: tcpip.AddrFrom4Slice(net.ParseIP(guestIP).To4()).WithPrefix(),
	}, stack.AddressProperties{}); e != nil {
		t.Fatalf("guest AddProtocolAddress: %v", e)
	}
	_, sub, _ := net.ParseCIDR(SubnetCIDR)
	subnet, _ := tcpip.NewSubnet(tcpip.AddrFromSlice(sub.IP), tcpip.MaskFromBytes(sub.Mask))
	s.SetRouteTable([]tcpip.Route{
		{Destination: subnet, NIC: 1},
		{
			Destination: header.IPv4EmptySubnet,
			Gateway:     tcpip.AddrFrom4Slice(net.ParseIP(GatewayIP).To4()),
			NIC:         1,
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	// outbound: drain the guest's link queue, frame, write to conn.
	go func() {
		for {
			pkt := base.ReadContext(ctx)
			if pkt == nil {
				return
			}
			buf := pkt.ToBuffer()
			frame := buf.Flatten()
			pkt.DecRef()
			if err := writeQemuFrame(conn, frame); err != nil {
				return
			}
		}
	}()
	// inbound: read frames from conn, inject into the guest's link.
	go func() {
		for {
			frame, err := readQemuFrame(conn)
			if err != nil {
				return
			}
			pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{
				Payload: buffer.MakeWithData(frame),
			})
			base.InjectInbound(0, pkt)
			pkt.DecRef()
		}
	}()

	return s
}

// QEMU protocol: 32-bit big-endian frame length, then the ethernet frame.
func writeQemuFrame(w io.Writer, frame []byte) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(frame)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(frame)
	return err
}

func readQemuFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	frame := make([]byte, binary.BigEndian.Uint32(hdr[:]))
	if _, err := io.ReadFull(r, frame); err != nil {
		return nil, err
	}
	return frame, nil
}
