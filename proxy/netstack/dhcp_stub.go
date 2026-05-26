//go:build !wasip1

package netstack

import "log"

// startDHCP is a no-op off wasip1: gvisor-tap-vsock's dhcp service depends on a
// dhcp library that's patched for wasm and won't build for native targets. The
// native test build uses a statically-addressed guest, so DHCP isn't needed.
func (n *Network) startDHCP(cfg Config) error {
	log.Printf("netstack: DHCP disabled (non-wasip1 build); guest must use a static address")
	return nil
}
