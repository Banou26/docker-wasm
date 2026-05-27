# Build the c2w-webvpn netstack proxy as a wasip1/wasm Go binary.
#   src/proxy/         -> dist/c2w-webvpn-proxy.wasm
#
# The proxy lives in its own Go module (src/proxy/go.mod); it builds with
# stock Go >= 1.23 and the wasip1/wasm target. Run on host directly, or via
# `npm run make-docker` for hermetic builds against a pinned toolchain.

GOOS   := wasip1
GOARCH := wasm
GOTAGS := osusergo

WASM := c2w-webvpn-proxy.wasm

# dist/ is the canonical build output (mirrors libav-wasm). public/ holds a
# copy so vite-dev serves the wasm at /c2w-webvpn-proxy.wasm without needing
# the dist-middleware fallthrough — matches the URLs the runtime hardcodes.
all: public/$(WASM)

dist/$(WASM):
	mkdir -p dist && \
	cd src/proxy && GOOS=$(GOOS) GOARCH=$(GOARCH) go build -tags $(GOTAGS) -o ../../dist/$(WASM) .

public/$(WASM): dist/$(WASM)
	mkdir -p public && cp dist/$(WASM) public/$(WASM)

clean:
	rm -f dist/$(WASM) public/$(WASM)

.PHONY: all clean
