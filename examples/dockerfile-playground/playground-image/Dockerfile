# The in-browser Dockerfile playground.
#
# c2w-converted ONCE into playground.wasm and served as a static asset. The
# user's Dockerfile is shipped via the URL hash; the frontend types a build+run
# script into the terminal at boot, which invokes buildah inside this guest.
# buildah's network egress (registry pulls + RUN steps' apk/apt fetches) flows
# through the c2w-webvpn netstack -> @webvpn.
FROM alpine:3.19

RUN apk add --no-cache buildah ca-certificates && update-ca-certificates

# vfs = no overlay/loopback/privileged needs.
# chroot isolation = no nested runc/userns.
ENV STORAGE_DRIVER=vfs \
    BUILDAH_ISOLATION=chroot

RUN mkdir -p /etc/containers && \
    printf '[storage]\ndriver = "vfs"\n' > /etc/containers/storage.conf && \
    printf 'unqualified-search-registries = ["docker.io"]\n' > /etc/containers/registries.conf

WORKDIR /work
CMD ["/bin/sh"]
