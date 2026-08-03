#!/bin/sh
# Runs INSIDE the builder guest. The ISO layout mirrors container2wasm's embedded Dockerfile:
# <iso>/oci/{rootfs,image.json,spec.json,initconfig.json} plus $VM_ROOTFS overlaid at the root.
set -eu

: "${OCI_LAYOUT:=/out/image}"
: "${PLATFORM:=linux/amd64}"
: "${VM_ROOTFS:=/vmrootfs}"
: "${OUT:=/out/rootfs.bin}"

pack="$(mktemp -d)"
mkdir -p "$pack/oci/rootfs"

echo ">> create-spec: unpack image + generate spec/init config"
# create-spec writes image.json/spec.json/initconfig.json to the CWD, hence the subshell
( cd "$pack/oci" && create-spec --rootfs-path=/oci/rootfs "$OCI_LAYOUT" "$PLATFORM" "$pack/oci/rootfs" )

echo ">> overlay the fixed VM userland"
if [ -d "$VM_ROOTFS" ]; then
	cp -a "$VM_ROOTFS"/. "$pack"/
else
	echo "   WARNING: \$VM_ROOTFS ($VM_ROOTFS) not present; the ISO will lack"
	echo "   init/runc/busybox and won't boot. Bake the c2w VM userland in."
fi

echo ">> mkisofs -R -> $OUT"
mkisofs -R -o "$OUT" "$pack"
rm -rf "$pack"
echo ">> done: $OUT  (mount in the runtime emulator at /pack/rootfs.bin)"
