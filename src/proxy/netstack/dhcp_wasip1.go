//go:build wasip1

package netstack

import (
	"log"

	"github.com/containers/gvisor-tap-vsock/pkg/services/dhcp"
	gvntypes "github.com/containers/gvisor-tap-vsock/pkg/types"
)

func (n *Network) startDHCP(cfg Config) error {
	config := &gvntypes.Configuration{
		Debug:             cfg.Debug,
		MTU:               MTU,
		Subnet:            SubnetCIDR,
		GatewayIP:         GatewayIP,
		GatewayMacAddress: GatewayMAC,
		Protocol:          gvntypes.QemuProtocol,
	}
	server, err := dhcp.New(config, n.stack, n.pool)
	if err != nil {
		return err
	}
	go func() { log.Printf("dhcp server exited: %v", server.Serve()) }()
	return nil
}
