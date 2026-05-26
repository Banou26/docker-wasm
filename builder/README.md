# In-browser Dockerfile → wasm builder

Goal: paste a Dockerfile, build it **entirely in the browser**, and get a
runnable wasm — no server-side build.

## The key insight

`docker build` doesn't *transform* a Dockerfile, it *executes* it: every `RUN`
runs arch-specific Linux binaries (`sh`, `apk`, `gcc`). You can't interpret
those into wasm — you can only run them. So building a Linux image in the
browser requires running Linux in the browser, which is exactly the emulator
container2wasm already ships. The recursion closes:

```
build-time:  emulator(wasm) ─► Linux guest ─► buildah ─► executes the Dockerfile
                                                 │  pull base image + RUN steps
                                                 └──► over @webvpn  (this repo)
                                          ─► OCI image / rootfs in OPFS
             package rootfs ─► runnable wasm (reuse the prebuilt emulator;
                               only the rootfs changes per build)
run-time:    emulator(wasm) ─► Linux guest ─► the built container
                                                 └──► @webvpn networking again
```

You don't write a new "Dockerfile compiler." The build system **is the same
emulator** running a builder guest (this directory) whose job is to run buildah
and package the result. The emulator wasm is fixed and prebuilt — only the
rootfs differs per build.

## Phase 1 — VALIDATED ✅

The make-or-break unknown was: can a rootless, daemonless OCI builder run under
the constraints of the emulated guest (no Docker daemon, no privileged kernel
features)? **Yes.** Validated with `buildah` (vfs storage driver + chroot
isolation), building a full Dockerfile:

```
$ buildah --storage-driver vfs bud --isolation chroot -t alpine-curl-test .
STEP 1/4: FROM .../alpine:3.19          # base-image pull           ✅
STEP 2/4: RUN sed ... /etc/apk/repositories                          ✅ (chroot exec)
STEP 3/4: RUN apk add --no-cache curl && curl --version              ✅ (24 pkgs over network)
          ...  RUN-STEP-NETWORK-OK
STEP 4/4: CMD ["/bin/sh"]
COMMIT alpine-curl-test                                              ✅
Successfully tagged localhost/alpine-curl-test:latest
$ buildah ... push localhost/alpine-curl-test oci-archive:/out/image.tar
   -> image.tar (5.8 MB), rootfs mounts with /usr/bin/curl present  ✅
```

So: base-image pull, `RUN` execution, network-dependent `RUN`, commit, and
rootfs export all work daemonless/rootless with no privileged features — the
exact shape of the emulated guest. The only hops that needed help were the
**network egress** ones (the registry pull's TLS and `apk`'s fetch), which is
precisely what `@webvpn` provides in the browser; in this sandbox they were
worked around with a rate-limit-free mirror and http repos.

`Dockerfile` + `build-image.sh` here capture that exact, validated invocation —
they are what gets c2w-converted into the in-browser builder guest.

## What's NOT yet done

* **Phase 2 — wire @webvpn as the builder guest's network.** In the browser the
  guest's egress is the c2w-webvpn netstack, so registry pulls and `RUN apt/apk`
  "just work" with no CA/mirror hacks. (Unverified end-to-end; needs the browser
  harness + a live @webvpn.)
* **Phase 3 — package the built rootfs into a runnable wasm in the browser.**
  Reuse the prebuilt emulator; only mount the new rootfs (c2w `--external-bundle`
  style). The packaging step is itself a small image assembly — runnable in the
  guest or as a fixed JS step. Not built yet.
* **Phase 4 — chain to a runtime emulator** to run the built container (already
  the working part of this repo, plus @webvpn).

## Honest risks

* **Performance.** buildah on an emulated CPU with OPFS-backed vfs storage is
  *slow* — think CI-on-a-potato. The vfs driver copies whole layers (no
  overlay), trading speed for not needing privileged features.
* **Memory.** Builder guest RAM + image layers + OPFS, all in one tab. Big
  images may exceed the budget.
* **Download size.** The builder guest (a distro + buildah) is a chunky one-time
  asset, separate from the runtime emulator.
* **Double emulation.** Build emulator + run emulator are distinct guests.

## Try the builder guest (where Docker has network)

```sh
# build the builder image and run it against a user Dockerfile:
docker build -t c2w-webvpn-builder .
mkdir -p /tmp/ctx /tmp/out && cp /path/to/user/Dockerfile /tmp/ctx/
docker run --rm -v /tmp/ctx:/work -v /tmp/out:/out c2w-webvpn-builder
# -> /tmp/out/image.tar   (then convert with c2w / mount in the runtime emulator)
```

This runs the same buildah flow that would run inside the emulated guest.
