# The fast-path guest.
#
# Buildah's own bookkeeping is where in-browser build time goes: loading a 3.6 MB
# base image into its overlay store costs ~55s and committing a layer another
# ~33s, measured, out of a 92s build whose RUN step is a single `echo`. None of
# that is emulation: riscv64 and amd64 spend the same time on it.
#
# So the fast path does not use buildah, and therefore does not need the builder
# image that carries it. Everything it does need is already in busybox: `wget` to
# pull the base rootfs from the page's artifact bridge, `tar` to extract it, and
# `chroot` to run the Dockerfile's RUN steps inside it. That makes this guest
# roughly a third the size of the builder and, more importantly, a TinyEMU-class
# boot rather than a Bochs one.
#
# No RUN steps on purpose: this builds for riscv64 with no binfmt handler
# registered, the same reason the preset images are shaped this way.
FROM alpine:3.21

WORKDIR /work
CMD ["/bin/sh"]
