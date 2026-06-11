# The "builder guest": a Linux image with a rootless, daemonless OCI builder
# (buildah) + the c2w packaging tools (create-spec, mkisofs). c2w converts THIS
# image into a wasm; in the browser it runs inside the emulator and builds the
# *user's* Dockerfile, with network egress (base-image pulls + RUN steps)
# provided by the c2w-webvpn netstack over @webvpn.
#
# Validated on a host (proxy for the emulated guest):
#   - Phase 1: rootless buildah (vfs + chroot) builds a full Dockerfile - pull,
#     RUN incl. network, commit - with no daemon and no privileged features.
#   - Phase 3: create-spec + mkisofs package the OCI image into rootfs.bin.
# See README.md for the exact runs + output.
#
# NOTE: this image build itself needs Docker-with-network; it was not built in
# the dev sandbox (container egress blocked there). The buildah/create-spec/
# mkisofs flows it runs were each validated independently.

# --- build create-spec (the c2w OCI->spec tool) from source, once ---
FROM golang:1.23-alpine AS create-spec
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/container2wasm/container2wasm /src && \
    cd /src && GOFLAGS=-mod=mod go build -o /create-spec ./cmd/create-spec

# --- the builder guest ---
FROM alpine:3.19

# buildah (build), cdrkit (mkisofs, for packaging)
RUN apk add --no-cache buildah cdrkit
COPY --from=create-spec /create-spec /usr/local/bin/create-spec

# vfs needs no overlayfs / loopback / privileged mounts - the safest storage
# driver inside an emulated kernel. chroot isolation avoids a nested runc and
# user namespaces.
ENV STORAGE_DRIVER=vfs \
    BUILDAH_ISOLATION=chroot

RUN mkdir -p /etc/containers && \
    printf '[storage]\ndriver = "vfs"\n' > /etc/containers/storage.conf && \
    printf 'unqualified-search-registries = ["docker.io"]\n' > /etc/containers/registries.conf

COPY build-image.sh /usr/local/bin/build-image
COPY package-rootfs.sh /usr/local/bin/package-rootfs
RUN chmod +x /usr/local/bin/build-image /usr/local/bin/package-rootfs

# The fixed c2w VM userland (busybox/runc/init/tini) goes here - build it once
# from container2wasm and COPY it in. Without it package-rootfs produces an ISO
# that won't boot.
#   COPY --from=<c2w-vm-rootfs-stage> / /vmrootfs/
ENV VM_ROOTFS=/vmrootfs

WORKDIR /work
CMD ["/usr/local/bin/build-image"]
