module c2w-webvpn-proxy

go 1.23.0

require (
	github.com/containers/gvisor-tap-vsock v0.8.5
	github.com/sirupsen/logrus v1.9.3
	gvisor.dev/gvisor v0.0.0-20240916094835-a174eb65023f
)

require (
	github.com/apparentlymart/go-cidr v1.1.0 // indirect
	github.com/google/btree v1.1.2 // indirect
	github.com/google/gopacket v1.1.19 // indirect
	github.com/insomniacslk/dhcp v0.0.0-20240710054256-ddd8a41251c9 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/u-root/uio v0.0.0-20240224005618-d2acac8f3701 // indirect
	golang.org/x/crypto v0.36.0 // indirect
	golang.org/x/sys v0.31.0 // indirect
	golang.org/x/time v0.5.0 // indirect
)

replace github.com/sirupsen/logrus => github.com/sirupsen/logrus v1.9.3-0.20230531171720-7165f5e779a5

replace github.com/insomniacslk/dhcp => github.com/ktock/insomniacslk-dhcp v0.0.0-20230911142651-b86573a014b1

replace github.com/u-root/uio => github.com/ktock/u-root-uio v0.0.0-20230911142931-5cf720bc8a29

replace github.com/containers/gvisor-tap-vsock => github.com/ktock/gvisor-tap-vsock v0.0.0-20250428083527-5f02d9ba79d4
