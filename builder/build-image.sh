#!/bin/sh
# Runs INSIDE the builder guest. Inputs: the build context at /work. Output: /out/image, an OCI layout dir consumed by package-rootfs.sh
set -eu

: "${TAG:=built:latest}"

cd /work
# Network egress (base-image pull and RUN steps) uses the guest's normal networking, which in the browser is the c2w-webvpn netstack over @webvpn, so none of the sandbox-specific egress workarounds in the repo README are needed here
echo ">> buildah bud  (driver=vfs, isolation=chroot, tag=$TAG)"
buildah --storage-driver vfs bud --isolation chroot -t "$TAG" .

echo ">> exporting OCI layout to /out/image"
mkdir -p /out
rm -rf /out/image
buildah --storage-driver vfs push "$TAG" "oci:/out/image:${TAG%%:*}"

echo ">> done: /out/image  (OCI layout; feed to package-rootfs.sh)"
