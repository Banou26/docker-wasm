# The "builder guest": a Linux image containing a rootless, daemonless OCI
# image builder (buildah). c2w converts THIS image into a wasm; in the browser
# it runs inside the emulator and builds the *user's* Dockerfile, with network
# egress (base-image pulls + RUN steps) provided by the c2w-webvpn netstack
# over @webvpn.
#
# Phase 1 (validated on a host as a proxy for the emulated guest): rootless
# buildah with the vfs storage driver + chroot isolation builds a complete
# Dockerfile — base-image pull, RUN steps including `apk add` over the network,
# and commit to an OCI archive — with no daemon and no privileged kernel
# features. See README.md for the exact run + output.
FROM alpine:3.19

RUN apk add --no-cache buildah

# vfs needs no overlayfs / loopback / privileged mounts — the safest storage
# driver inside an emulated kernel. chroot isolation avoids a nested runc and
# user namespaces.
ENV STORAGE_DRIVER=vfs \
    BUILDAH_ISOLATION=chroot

RUN mkdir -p /etc/containers && \
    printf '[storage]\ndriver = "vfs"\n' > /etc/containers/storage.conf && \
    printf 'unqualified-search-registries = ["docker.io"]\n' > /etc/containers/registries.conf

COPY build-image.sh /usr/local/bin/build-image
RUN chmod +x /usr/local/bin/build-image

WORKDIR /work
CMD ["/usr/local/bin/build-image"]
