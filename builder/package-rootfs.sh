#!/bin/sh
# Runs INSIDE the builder guest. Packages the built OCI image into rootfs.bin -
# the Rock-Ridge ISO disk that the runtime emulator mounts and whose /oci tree
# its init runc-runs.
#
# Inputs : /out/image    - OCI layout from build-image.sh
#          $VM_ROOTFS    - the FIXED c2w VM userland (busybox/runc/init/tini/…).
#                          Built once and baked into this builder guest; it does
#                          NOT change per build - only the container rootfs +
#                          spec do.
# Output : /out/rootfs.bin
#
# c2w on-disk layout (mirrors container2wasm's embedded Dockerfile):
#   <iso>/oci/rootfs          container rootfs (overlayfs lowerdir at runtime)
#   <iso>/oci/image.json      OCI image config (used by init)
#   <iso>/oci/spec.json       OCI runtime spec (used by init -> runc)
#   <iso>/oci/initconfig.json init boot config
#   <iso>/sbin/init, /sbin/runc, busybox, …   from $VM_ROOTFS
set -eu

: "${OCI_LAYOUT:=/out/image}"
: "${PLATFORM:=linux/amd64}"
: "${VM_ROOTFS:=/vmrootfs}"
: "${OUT:=/out/rootfs.bin}"

pack="$(mktemp -d)"
mkdir -p "$pack/oci/rootfs"

echo ">> create-spec: unpack image + generate spec/init config"
# create-spec writes image.json/spec.json/initconfig.json to the CWD and
# unpacks the image layers into the rootfs argument.
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
