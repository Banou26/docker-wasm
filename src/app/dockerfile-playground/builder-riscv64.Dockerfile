# The in-browser Dockerfile builder, riscv64 edition.
#
# Same job as ./Dockerfile (alpine + buildah, converted once into a wasm artifact
# and served static), but targeting riscv64 so it runs on c2w's TinyEMU backend
# rather than Bochs. Bochs needs asyncify instrumentation and is the startup and
# throughput floor for everything built on it; TinyEMU needs neither, and the
# artifact is roughly a third the size.
#
# The cost is that the base image in the user's Dockerfile must have a riscv64
# variant. Alpine, Debian, Ubuntu and busybox do; plenty do not, which is why the
# amd64 builder stays and the page picks between them per Dockerfile.
#
# Nothing riscv64 executes during this build. The rootfs is cross-installed with
# apk from the build platform, which keeps the build reproducible and, more
# usefully, keeps it working on machines with no binfmt handler registered. A
# plain `RUN apk add` under `--platform linux/riscv64` needs one and fails with
# `exec format error` without it.

FROM --platform=$BUILDPLATFORM alpine:3.21 AS rootfs

ARG ALPINE_BRANCH=v3.21
ARG MIRROR=https://dl-cdn.alpinelinux.org/alpine

# alpine-keys carries every architecture's signing keys, so the foreign index is
# verified rather than pulled with --allow-untrusted.
RUN apk add --no-cache alpine-keys

# netavark is explicit rather than incidental: nothing depends on it, but buildah
# from 3.21 onwards initialises a network backend on every command, including
# `pull`, and aborts with `could not find "netavark"` when it is absent. The
# amd64 builder does not carry it because alpine:3.19 ships a buildah old enough
# not to look.

RUN mkdir -p /out/etc/apk && \
    printf '%s/%s/main\n%s/%s/community\n' "$MIRROR" "$ALPINE_BRANCH" "$MIRROR" "$ALPINE_BRANCH" \
        > /out/etc/apk/repositories && \
    apk --arch riscv64 --root /out --initdb --no-cache --no-scripts \
        --keys-dir /usr/share/apk/keys/riscv64 \
        --repositories-file /out/etc/apk/repositories \
        add alpine-baselayout busybox busybox-binsh apk-tools \
            buildah netavark ca-certificates-bundle

# --no-scripts skipped busybox's trigger, which is what normally creates the
# applet symlinks, leaving a rootfs with a shell but no `mkdir`, `cat` or `printf`
# on PATH. The package ships the full path list it would have used, so walk it
# here instead.
RUN while read -r applet; do \
        [ -n "$applet" ] || continue; \
        mkdir -p "/out/$(dirname "$applet")"; \
        [ -e "/out/$applet" ] || ln -s /bin/busybox "/out/$applet"; \
    done < /out/etc/busybox-paths.d/busybox

# The same storage defaults the generated build script would otherwise write, so
# buildah works on first invocation without a setup round trip. c2w's patched OCI
# spec mounts a tmpfs at the graphroot, which is what gives overlay native CoW;
# it cannot go directly on the guest's own overlay-backed root.
RUN mkdir -p /out/etc/containers /out/var/lib/containers/storage /out/run/containers/storage /out/work && \
    printf '[storage]\ndriver = "overlay"\ngraphroot = "/var/lib/containers/storage"\nrunroot = "/run/containers/storage"\n[storage.options.overlay]\nmountopt = "nodev"\n' \
        > /out/etc/containers/storage.conf && \
    printf 'unqualified-search-registries = ["docker.io"]\n' \
        > /out/etc/containers/registries.conf && \
    # crun otherwise tries to raise both RLIMIT_NOFILE and RLIMIT_NPROC to
    # 1048576 on every RUN, which needs CAP_SYS_RESOURCE; the c2w spec grants
    # CAP_SYS_ADMIN but not that, so the build dies at the first instruction with
    # "operation not permitted". Both have to be pinned: capping only nofile just
    # moves the failure to nproc. Covers `buildah run` as well as `bud`. alpine
    # 3.19's older buildah never attempts the raise, hence no equivalent on amd64.
    printf '[containers]\ndefault_ulimits = [\n  "nofile=1024:1024",\n  "nproc=1024:1024",\n]\n' \
        > /out/etc/containers/containers.conf

FROM scratch
COPY --from=rootfs /out/ /
ENV STORAGE_DRIVER=overlay \
    BUILDAH_ISOLATION=chroot
WORKDIR /work
CMD ["/bin/sh"]
