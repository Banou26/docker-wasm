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

# Pre-baked storage config: write the same defaults the auto-paste script writes
# so buildah works directly on first invocation.
RUN mkdir -p /etc/containers /var/lib/containers/storage /run/containers/storage && \
    printf '[storage]\ndriver = "vfs"\ngraphroot = "/var/lib/containers/storage"\nrunroot = "/run/containers/storage"\n[storage.options]\n' > /etc/containers/storage.conf && \
    printf 'unqualified-search-registries = ["docker.io"]\n' > /etc/containers/registries.conf

# Bake a `docker save`d alpine:3.19 tar into the image. The auto-paste boot
# script does `buildah pull docker-archive:` on first run so simple Dockerfiles
# (FROM alpine:*) don't need to pull from Docker Hub — currently impossible
# inside Bochs because @webvpn TCP RTT exceeds buildah's 30-s connect deadline.
COPY alpine.tar /var/cache/playground/alpine.tar

WORKDIR /work
CMD ["/bin/sh"]
