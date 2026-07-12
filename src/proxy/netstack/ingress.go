package netstack

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
)

const ingressPollInterval = 20 * time.Millisecond

type IngressConn struct {
	Network   string
	Conn      net.Conn
	GuestPort uint16
}

type PollIngressFunc func() (IngressConn, bool, error)

func (n *Network) serveIngress(ctx context.Context, poll PollIngressFunc, configuredGuestIP string) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		incoming, ok, err := poll()
		if err != nil {
			log.Printf("ingress poll failed: %v", err)
			if !waitIngressPoll(ctx, time.Second) {
				return
			}
			continue
		}
		if !ok {
			if !waitIngressPoll(ctx, ingressPollInterval) {
				return
			}
			continue
		}
		if incoming.Network != "tcp" || incoming.Conn == nil || incoming.GuestPort == 0 {
			if incoming.Conn != nil {
				incoming.Conn.Close()
			}
			continue
		}
		go n.forwardTCPIngress(ctx, incoming, configuredGuestIP)
	}
}

func (n *Network) forwardTCPIngress(parent context.Context, incoming IngressConn, configuredGuestIP string) {
	lookupCtx, cancelLookup := context.WithTimeout(parent, 2*time.Minute)
	guestIP, err := n.waitForGuestIPv4(lookupCtx, configuredGuestIP)
	cancelLookup()
	if err != nil {
		incoming.Conn.Close()
		log.Printf("ingress guest lookup failed: %v", err)
		return
	}

	guest, err := gonet.DialContextTCP(parent, n.stack, tcpip.FullAddress{
		NIC:  nicID,
		Addr: tcpip.AddrFrom4Slice(guestIP),
		Port: incoming.GuestPort,
	}, ipv4.ProtocolNumber)
	if err != nil {
		incoming.Conn.Close()
		return
	}
	proxyTCP(parent, incoming.Conn, guest)
}

func proxyTCP(ctx context.Context, a, b net.Conn) {
	done := make(chan error, 2)
	finished := make(chan struct{})
	defer close(finished)
	defer a.Close()
	defer b.Close()

	go func() {
		select {
		case <-ctx.Done():
			a.Close()
			b.Close()
		case <-finished:
		}
	}()
	copyOneWay := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		if err == nil {
			if closeWriter, ok := dst.(interface{ CloseWrite() error }); ok {
				err = closeWriter.CloseWrite()
			} else {
				err = dst.Close()
			}
		}
		done <- err
	}
	go copyOneWay(a, b)
	go copyOneWay(b, a)
	if err := <-done; err != nil {
		a.Close()
		b.Close()
	}
	<-done
}

func waitIngressPoll(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (n *Network) waitForGuestIPv4(ctx context.Context, configured string) ([]byte, error) {
	if configured != "" {
		ip := net.ParseIP(configured).To4()
		if ip == nil || configured == GatewayIP {
			return nil, fmt.Errorf("invalid guest IPv4 address %q", configured)
		}
		return ip, nil
	}

	ticker := time.NewTicker(ingressPollInterval)
	defer ticker.Stop()
	for {
		for address := range n.pool.Leases() {
			if address == GatewayIP {
				continue
			}
			if ip := net.ParseIP(address).To4(); ip != nil {
				return ip, nil
			}
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("guest address was not assigned before timeout")
		case <-ticker.C:
		}
	}
}
