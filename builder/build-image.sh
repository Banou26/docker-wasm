#!/bin/sh
# Runs INSIDE the builder guest. Builds the user's Dockerfile with a rootless,
# daemonless buildah and exports the result as an OCI archive.
#
# Inputs : the user's build context (incl. Dockerfile) at /work
# Output : /out/image.tar  — hand to c2w packaging, or mount its rootfs in the
#          runtime emulator (external-bundle style)
#
# Network egress (base-image pull + RUN steps) uses the guest's normal
# networking, which in the browser is the c2w-webvpn netstack over @webvpn — so
# none of the sandbox-specific egress workarounds in the repo README are needed.
set -eu

: "${TAG:=built:latest}"

cd /work
echo ">> buildah bud  (driver=vfs, isolation=chroot, tag=$TAG)"
buildah --storage-driver vfs bud --isolation chroot -t "$TAG" .

echo ">> exporting OCI archive to /out/image.tar"
mkdir -p /out
buildah --storage-driver vfs push "$TAG" "oci-archive:/out/image.tar:${TAG%%:*}"

echo ">> done: /out/image.tar"
