# Fast path: how far it matches `docker build`

The chroot fast path (`src/dockerfile.ts`, `src/layers.ts`, `src/build-script.ts`)
builds a Dockerfile without buildah, by pulling the base image's layers in the
page and running the RUN steps under `chroot` in the guest. That is worth a large
multiple of the buildah path's wall clock, and none of it is worth anything if
the image it produces is not the one the Dockerfile describes.

Its failure mode is the bad one: a build that exits 0 and hands back a different
image, with nothing in the log to suggest it. So the checks are differential
rather than unit. `npm run check-fast-path` runs the same Dockerfile through real
`docker build` and through the fast path and compares what each produced: 107
checks, of which 39 are direct comparisons against docker (server 29.3.0).

```
npm run check-fast-path              # needs docker
npm run check-fast-path -- --offline # parser and emitter only
npm run check-page                   # real builds in a real browser
```

`check-page` is the other half, and it is not optional in practice: the guest
chosen from the build plan, the artifact bridge, the emulated `wget`, the
`chroot` and the emulated `tar` exist nowhere else. A bug that made every build
from the page boot the wrong guest, so that none of the work below ever ran,
survived precisely because nothing drove that path. It attaches to a chromium
that is already running rather than launching one, because a headless chromium
stalls on the in-page gateway fetch.

## What the checks cover

| File | What it settles |
| --- | --- |
| `test/fast-path/unit.mjs` | parser, planner and emitted shell, including the fallbacks |
| `test/fast-path/diff.mjs` | 22 Dockerfiles built both ways, comparing what a RUN step sees |
| `test/fast-path/launch.mjs` | 9 ENTRYPOINT/CMD combinations, comparing what the container launches |
| `test/fast-path/chroot.mjs` | the real generated script against real layers, diffing the whole rootfs |
| `test/fast-path/opaque.mjs` | opaque directory markers, which buildkit will not produce on demand |

`chroot.mjs` is the strongest of them: it serves a four layer image over HTTP,
runs the unmodified generated script in a privileged container standing in for
the guest, and checks that the resulting rootfs hashes identically to the one
`docker build` produced from the same Dockerfile.

## Divergences that were found and fixed

Every item below was found by a five-lens audit, verified by a second agent
prompted to refute it, and now has a check that fails if it comes back.

1. **Instruction order was not modelled.** `ENV` was flattened into one list and
   `WORKDIR` kept as a scalar, then replayed before every `RUN`, so an `ENV`
   below a `RUN` reached it and only the last `WORKDIR` survived. The plan now
   carries an ordered step list, each step holding the env and working directory
   in effect at its own position.
2. **`WORKDIR` never created its directory**, and the `cd` was followed by
   `|| true`, so on a base without that path the step ran in `/` and stayed
   green. It is now `mkdir -p` then `cd`, and a failure fails the build.
3. **A relative `WORKDIR` did not resolve** against the previous one. Working
   directories are now applied as a `cd` chain, which is how docker composes
   them, and which resolves a `WORKDIR $VAR` correctly without the page having to
   know the value.
4. **The base image config was parsed and dropped.** Only `Entrypoint` and `Cmd`
   were used, so `RUN` steps ran without the image's own `Env` (which carries
   `PATH`) or `WorkingDir`.
5. **`ENV` values were single quoted**, so `ENV PATH=/opt/bin:$PATH` was literal.
   Values are now parsed into literal and variable parts, honouring the quoting
   rules docker applies, and rendered as something the shell expands exactly as
   far as docker would.
6. **`ENTRYPOINT` did not clear an inherited `CMD`**, and a shell form
   `ENTRYPOINT` still had `CMD` appended. Both now match, checked by running the
   built image and the fast path's launch side by side.
7. **There was no `/dev` in the chroot**, so `/dev/null` became a regular file
   that accumulated everything redirected to it and then shipped inside the
   image, and `apt-get` refused to run at all. `/dev` is bind mounted, with
   `mknod` of the usual six as a fallback, and `/proc` and `/sys` are mounted.
8. **Overlay whiteouts were applied once, after every layer**, so a file deleted
   in layer 2 and restored in layer 3 ended up missing. They are now resolved in
   the page, where the layers are still separate, and travel to the guest as
   explicit paths removed *before* the layer is extracted. That is also the only
   arrangement that gets an opaque directory right: after extraction, the lower
   layer's files and the marker's own layer's files are in one directory with
   nothing left to tell them apart.
9. **A path whose type changes between layers** (a file replaced by a directory)
   was merged rather than replaced, because that is what `tar` does. The layer
   scan tracks the accumulated type of every path and emits a removal when it
   changes.
10. **Line continuations were joined with a newline**, turning one command into
    several, and **a comment inside a continued instruction terminated it**.
11. **Instructions that mean something else entirely** now fall back to buildah
    rather than being run as shell: `RUN --mount=...` and friends, `RUN` with a
    heredoc, `FROM --platform=`, and a file carrying an `# escape=` or
    `# syntax=` directive.

## Known divergences that remain

Deliberate, and none of them silent:

- **`/etc/resolv.conf` is written into the rootfs.** docker mounts one for the
  duration of the build instead, so it is not part of the built image. The guest
  has no equivalent, and a container with no resolver is worse than an extra
  file.
- **Layer extraction is `busybox tar`**, so extended attributes (file
  capabilities in particular) are dropped. Ownership, permissions, symlinks and
  hardlinks survive.
- **A layer compressed with anything but gzip fails the extract**, loudly, rather
  than being handled. No registry this page pulls from serves one today.
- **Exec form `RUN` still goes through a shell**, with each argument quoted, so
  it behaves the same except on a base image with no `/bin/sh` at all.
- **`EXPOSE` does not expand variables.** It only feeds the page's port list.

Everything else the fast path cannot express falls back to buildah, which is the
whole point of `planBuild` being conservative: a wrong "no" costs time, a wrong
"yes" costs correctness.
