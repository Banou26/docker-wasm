//go:build wasip1

// webvpn.go: the egress seam.
//
// container2wasm's gVisor netstack terminates the guest's TCP/UDP flows and
// then needs to dial the real destination. Upstream c2w-net-proxy can't do
// that in WASI (Go's wasip1 has no outbound sock_connect), so it only serves
// an HTTP/HTTPS proxy bridged to the browser's fetch(). That caps the guest at
// HTTP/HTTPS.
//
// Here we replace that dial with calls into the JS host, which owns real
// TCP/UDP egress via @webvpn/net and @webvpn/dgram (WebTransport to a VPN
// server). Every flow the netstack terminates becomes a webvpnConn whose
// Read/Write/Close cross into JS through the wasmimports below.
//
// The model is deliberately non-blocking on the JS side (same discipline as
// libtorrent's library_fkn.js): the import calls never await. They poke/drain
// per-socket ring buffers that JS fills from async @webvpn callbacks while this
// worker is parked in Atomics.wait between calls. Go-side blocking Read/Write
// is synthesised by polling the import and time.Sleep()-ing, which yields to
// the Go scheduler and lets the main-thread event loop make progress.

package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"runtime"
	"strconv"
	"sync"
	"time"
	"unsafe"
)

// ---- wasmimport ABI ------------------------------------------------------
//
// network: 0 = TCP, 1 = UDP (connected datagram socket - the netstack always
// dials a fixed remote, so we never need per-datagram addressing here).
//
// All functions return 0 on success or a non-zero errno-ish code. Output
// values are written through the *P pointer arguments. recv flags bit0 = EOF.

//go:wasmimport env webvpn_connect
func webvpn_connect(network uint32, hostP uint32, hostLen uint32, port uint32, idP uint32) uint32

//go:wasmimport env webvpn_send
func webvpn_send(id uint32, bufP uint32, bufLen uint32, nwrittenP uint32) uint32

//go:wasmimport env webvpn_recv
func webvpn_recv(id uint32, bufP uint32, bufLen uint32, nreadP uint32, flagsP uint32) uint32

//go:wasmimport env webvpn_close
func webvpn_close(id uint32) uint32

// webvpn_dns_query pipes raw DNS wire-format bytes through DoH on the host side
// (via @fkn/lib's serverProxyFetch). Returns 0 on success and writes the
// response length to *respLenP; non-zero on failure.
//
//go:wasmimport env webvpn_dns_query
func webvpn_dns_query(queryP uint32, queryLen uint32, respP uint32, respCap uint32, respLenP uint32) uint32

// webvpn_image_size returns the byte length of an in-browser-pulled image
// (docker-archive tar) keyed by its reference. The JS side runs the OCI Registry
// V2 client and stashes the result; the netstack proxy's gateway HTTP server
// calls this to learn the Content-Length before streaming.
//
//go:wasmimport env webvpn_image_size
func webvpn_image_size(refP uint32, refLen uint32, sizeP uint32) uint32

// webvpn_image_chunk reads up to bufCap bytes starting at `offset` from the
// pulled image's docker-archive tar. Writes the actual chunk length to nReadP.
// Used by the gateway HTTP server to stream the tar to the guest.
//
//go:wasmimport env webvpn_image_chunk
func webvpn_image_chunk(refP uint32, refLen uint32, offset uint32, bufP uint32, bufCap uint32, nReadP uint32) uint32

// resolveDNS is the Config.ResolveDNS function the wasip1 build injects.
func resolveDNS(query []byte) ([]byte, error) {
	const cap = 4096 // response buffer in linear memory
	resp := make([]byte, cap)
	var n uint32
	rc := webvpn_dns_query(bytesPtr(query), uint32(len(query)), bytesPtr(resp), cap, u32Ptr(&n))
	runtime.KeepAlive(query)
	runtime.KeepAlive(resp)
	if rc != 0 {
		return nil, errConnIO
	}
	return resp[:n], nil
}

// wasmImagePuller implements netstack.ImagePuller via the webvpn_image_*
// wasmimports - JS-side does the actual OCI Registry V2 pull, we just stream
// the resulting docker-archive bytes to the guest through gateway:9090.
type wasmImagePuller struct{}

func (wasmImagePuller) Size(ref string) (int, error) {
	rb := []byte(ref)
	var size uint32
	rc := webvpn_image_size(bytesPtr(rb), uint32(len(rb)), u32Ptr(&size))
	runtime.KeepAlive(rb)
	if rc != 0 {
		return 0, errConnIO
	}
	return int(size), nil
}

func (wasmImagePuller) Chunk(ref string, offset int, buf []byte) (int, error) {
	if len(buf) == 0 {
		return 0, nil
	}
	rb := []byte(ref)
	var n uint32
	rc := webvpn_image_chunk(bytesPtr(rb), uint32(len(rb)), uint32(offset),
		bytesPtr(buf), uint32(len(buf)), u32Ptr(&n))
	runtime.KeepAlive(rb)
	runtime.KeepAlive(buf)
	if rc != 0 {
		return 0, errConnIO
	}
	return int(n), nil
}

const (
	netTCP uint32 = 0
	netUDP uint32 = 1

	// How long Read/Write park between JS round-trips when the socket would
	// block. Small enough to keep latency low, large enough not to spin the
	// CPU. The main thread keeps filling buffers via @webvpn callbacks while
	// we sleep.
	pollInterval = 2 * time.Millisecond
)

var (
	errConnFailed = errors.New("webvpn: connect failed")
	errConnIO     = errors.New("webvpn: io error")
)

// bytesPtr / u32Ptr expose linear-memory addresses to the host. The host reads
// this module's memory directly (it has the WebAssembly.Memory), so we hand it
// raw offsets. Callers must runtime.KeepAlive the backing object across the
// import call so the GC can't move/free it mid-call.
func bytesPtr(b []byte) uint32 {
	if len(b) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(unsafe.SliceData(b))))
}

func u32Ptr(p *uint32) uint32 {
	return uint32(uintptr(unsafe.Pointer(p)))
}

// timeoutError satisfies net.Error so the gVisor UDP proxy's idle-timeout
// logic (which keys off Timeout()) keeps working.
type timeoutError struct{}

func (timeoutError) Error() string   { return "webvpn: i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

type webvpnAddr struct {
	network string
	address string
}

func (a webvpnAddr) Network() string { return a.network }
func (a webvpnAddr) String() string  { return a.address }

// webvpnConn is a net.Conn backed by a JS-side @webvpn socket identified by id.
type webvpnConn struct {
	id      uint32
	network string
	remote  webvpnAddr

	mu           sync.Mutex
	closed       bool
	readDeadline time.Time
}

// dialWebvpn is the dial function we plug into the TCP and UDP forwarders in
// place of net.Dial.
func dialWebvpn(network, address string) (net.Conn, error) {
	var nw uint32
	switch network {
	case "tcp", "tcp4", "tcp6":
		nw = netTCP
	case "udp", "udp4", "udp6":
		nw = netUDP
	default:
		return nil, fmt.Errorf("webvpn: unsupported network %q", network)
	}

	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, err
	}

	hb := []byte(host)
	var id uint32
	rc := webvpn_connect(nw, bytesPtr(hb), uint32(len(hb)), uint32(port), u32Ptr(&id))
	runtime.KeepAlive(hb)
	if rc != 0 {
		return nil, errConnFailed
	}
	return &webvpnConn{id: id, network: network, remote: webvpnAddr{network, address}}, nil
}

func (c *webvpnConn) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	for {
		c.mu.Lock()
		closed := c.closed
		deadline := c.readDeadline
		c.mu.Unlock()
		if closed {
			return 0, io.EOF
		}
		if !deadline.IsZero() && time.Now().After(deadline) {
			return 0, timeoutError{}
		}

		var n, flags uint32
		rc := webvpn_recv(c.id, bytesPtr(b), uint32(len(b)), u32Ptr(&n), u32Ptr(&flags))
		runtime.KeepAlive(b)
		if rc != 0 {
			return 0, errConnIO
		}
		if n > 0 {
			return int(n), nil
		}
		if flags&1 != 0 { // peer FIN / socket closed
			return 0, io.EOF
		}
		time.Sleep(pollInterval) // would-block: yield, let JS fill the buffer
	}
}

func (c *webvpnConn) Write(b []byte) (int, error) {
	total := 0
	for total < len(b) {
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		if closed {
			return total, errConnIO
		}

		var n uint32
		rc := webvpn_send(c.id, bytesPtr(b[total:]), uint32(len(b)-total), u32Ptr(&n))
		runtime.KeepAlive(b)
		if rc != 0 {
			return total, errConnIO
		}
		if n == 0 { // backpressure: socket buffer full, retry shortly
			time.Sleep(pollInterval)
			continue
		}
		total += int(n)
	}
	return total, nil
}

func (c *webvpnConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	webvpn_close(c.id)
	return nil
}

func (c *webvpnConn) LocalAddr() net.Addr  { return webvpnAddr{c.network, "0.0.0.0:0"} }
func (c *webvpnConn) RemoteAddr() net.Addr { return c.remote }

func (c *webvpnConn) SetDeadline(t time.Time) error {
	return c.SetReadDeadline(t)
}

func (c *webvpnConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline = t
	c.mu.Unlock()
	return nil
}

// Writes never block on a timeout in this model (send returns immediately or
// reports backpressure), so the write deadline is a no-op.
func (c *webvpnConn) SetWriteDeadline(time.Time) error { return nil }
