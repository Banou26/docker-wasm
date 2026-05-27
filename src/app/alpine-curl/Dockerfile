# A tiny networking smoke-test image: Alpine + curl + DNS tools.
#
# Built into a browser-runnable wasm by c2w, then given real TCP/UDP egress by
# the c2w-webvpn netstack. Unlike container2wasm's fetch()-based networking,
# this can reach non-CORS sites, do real DNS over UDP, etc.
#
# Inside the running container (browser terminal), try:
#   curl -sS https://example.com
#   curl -sS https://ifconfig.me        # your @webvpn exit IP
#   nslookup github.com                 # real UDP DNS via the gateway forwarder
FROM alpine:3.19
RUN apk add --no-cache curl bind-tools ca-certificates
CMD ["/bin/sh"]
