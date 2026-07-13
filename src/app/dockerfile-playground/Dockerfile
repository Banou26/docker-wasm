# The in-browser Dockerfile playground.
#
# c2w-converted ONCE into playground.wasm and served as a static asset. The
# user's Dockerfile is shipped via the URL hash; the frontend types a build+run
# script into the terminal at boot, which invokes buildah inside this guest.
# buildah's network egress (registry pulls + RUN steps' apk/apt fetches) flows
# through the c2w-webvpn netstack -> @webvpn.
FROM alpine:3.19

RUN apk add --no-cache buildah ca-certificates && update-ca-certificates

# Use c2w's dedicated tmpfs graphroot for native overlay CoW; chroot avoids a nested OCI runtime.
ENV STORAGE_DRIVER=overlay \
    BUILDAH_ISOLATION=chroot

# Pre-baked storage config: write the same defaults the auto-paste script writes
# so buildah works directly on first invocation.
RUN mkdir -p /etc/containers /var/lib/containers/storage /run/containers/storage && \
    printf '[storage]\ndriver = "overlay"\ngraphroot = "/var/lib/containers/storage"\nrunroot = "/run/containers/storage"\n[storage.options.overlay]\nmountopt = "nodev"\n' > /etc/containers/storage.conf && \
    printf 'unqualified-search-registries = ["docker.io"]\n' > /etc/containers/registries.conf

WORKDIR /work
CMD ["/bin/sh"]
