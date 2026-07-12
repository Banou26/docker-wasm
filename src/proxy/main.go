//go:build wasip1

// c2w-webvpn-proxy: an in-browser network stack for container2wasm that gives
// the guest container *real* TCP/UDP egress via @webvpn, instead of the
// HTTP/HTTPS-only fetch() bridge upstream c2w-net-proxy is limited to.
//
// Drop-in replacement for c2w-net-proxy.wasm: same QEMU-socket framing from the
// emulator, same WASI/listenfd plumbing. The only difference is the egress
// seam (see webvpn.go + the netstack package).
//
// Build:  GOOS=wasip1 GOARCH=wasm go build -o c2w-webvpn-proxy.wasm .
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"os"
	"syscall"

	"github.com/sirupsen/logrus"

	"c2w-webvpn-proxy/netstack"
)

const upstreamDNS = "1.1.1.1:53"

func main() {
	var listenFd int
	flag.IntVar(&listenFd, "net-listenfd", 0, "fd to listen for the connection from the emulator")
	var debug bool
	flag.BoolVar(&debug, "debug", false, "debug log")
	var ingress bool
	flag.BoolVar(&ingress, "ingress", false, "forward published FKN TCP ports to the guest")
	flag.Parse()

	// Always send our own log.Println output to stderr so we can see startup,
	// dial errors etc. --debug only escalates the gvisor-tap-vsock verbosity.
	log.SetOutput(os.Stderr)
	if debug {
		logrus.SetLevel(logrus.DebugLevel)
	} else {
		logrus.SetLevel(logrus.FatalLevel)
	}

	cfg := netstack.Config{
		Debug:       debug,
		Dial:        dialWebvpn,
		UpstreamDNS: upstreamDNS,
		ResolveDNS:  resolveDNS,
		ImagePuller: wasmImagePuller{},
	}
	if ingress {
		cfg.PollIngress = pollWebvpnIngress
	}
	nw, err := netstack.New(cfg)
	if err != nil {
		panic(err)
	}

	l, err := findListener(listenFd)
	if err != nil {
		panic(err)
	}
	if l == nil {
		panic("emulator socket fd not found")
	}
	conn, err := l.Accept()
	if err != nil {
		panic(err)
	}
	log.Println("c2w-webvpn-proxy: serving guest network over @webvpn")
	if err := nw.Serve(context.TODO(), conn); err != nil {
		panic(err)
	}
}

// findListener locates the emulator's socket among the WASI preopens (or uses
// the explicit fd) and wraps it as a net.Listener. Copied from upstream
// c2w-net-proxy so the JS-side plumbing is unchanged.
func findListener(listenFd int) (net.Listener, error) {
	if listenFd == 0 {
		for preopenFd := 3; ; preopenFd++ {
			var stat syscall.Stat_t
			if err := syscall.Fstat(preopenFd, &stat); err != nil {
				var se syscall.Errno
				if errors.As(err, &se) && se == syscall.EBADF {
					err = nil
				}
				return nil, err
			} else if stat.Filetype == syscall.FILETYPE_SOCKET_STREAM {
				listenFd = preopenFd
				break
			}
		}
	}
	_ = syscall.SetNonblock(listenFd, true)
	f := os.NewFile(uintptr(listenFd), "")
	defer f.Close()
	return net.FileListener(f)
}
