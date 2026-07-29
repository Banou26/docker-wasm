# Fast path: confirmed divergences from `docker build`

The chroot fast path (`src/dockerfile.ts`, `src/build-script.ts`) is **not fit to
ship** until these are fixed. Every item below was found by a five-lens audit and
then independently verified by a second agent prompted to refute it; several
verifiers ran real `docker build` (server 29.3.0) to confirm Docker's own
behaviour rather than trusting memory. Claims that could not be reproduced were
dropped.

Severity is `silently-wrong` throughout unless noted: these produce a different
image with exit status 0 and no diagnostic, which is worse than a slow build.

**Nothing here is deployed.** The work is committed locally only (`86f75f0d4`).

## 1. Instruction ordering is not modelled at all

`planBuild` flattens `ENV` into one list and keeps `WORKDIR` as a single scalar,
so position is lost. `insideRootfs` then replays the whole lot before every `RUN`.

- **ENV is not positional.** `ENV` declared *after* a `RUN` still affects it, and
  a re-assigned variable takes its last value everywhere.
  `FROM alpine / ENV V=1 / RUN echo $V / ENV V=2` writes `2`; docker writes `1`.
- **Only the last WORKDIR survives**, and it applies to every `RUN`, including
  ones written above it.
- **Relative WORKDIR is not resolved** against the previous one. Docker treats
  `WORKDIR /usr` then `WORKDIR local` as `/usr/local`.

**Fix:** replace `runs: string[]` with an ordered step list, each step carrying
the env map and working directory in effect at its own position. This is the
root cause of three findings and should be done first.

## 2. WORKDIR never creates the directory

Docker creates it, documented, even if nothing later uses it. The generated
script only does `cd <dir> 2>/dev/null || true`, so on a base without that path
the `cd` fails, the error is discarded, `|| true` keeps the step green, and the
`RUN` executes in `/`. `WORKDIR /app` is the most common non-trivial line in a
Dockerfile and it is currently wrong on every image that lacks `/app`.

**Fix:** `mkdir -p` then `cd`, and let a genuine failure fail the build.

## 3. Base image config is parsed and then dropped

`pullRootfs` returns the config, and `runChrootBuild` passes only `Entrypoint`
and `Cmd`. The image's own `Env` (which carries `PATH` on most images) and
`WorkingDir` are ignored, so `RUN` steps run with whatever `PATH` the chroot's
`/bin/sh` defaults to.

**Fix:** seed the env map and working directory from the image config before
applying the Dockerfile's own.

## 4. ENV values are single-quoted, so nothing expands

Docker expands variables in `ENV` values (`ENV PATH=/opt/bin:$PATH`). `shellQuote`
makes that a literal.

**Fix:** expand against the env map already accumulated, then quote the result.

## 5. ENTRYPOINT / CMD resolution is wrong in two ways

- A Dockerfile `ENTRYPOINT` **does not reset the base image's `CMD`**. Docker
  clears the inherited `CMD` when `ENTRYPOINT` is set; this appends it.
- A **shell-form `ENTRYPOINT` still gets `CMD` appended**. Docker ignores `CMD`
  entirely when `ENTRYPOINT` is shell form.

## 6. No `/dev` inside the chroot

Nothing mounts or populates `/dev`, so:

- `RUN apt-get update` fails on every Debian and Ubuntu base.
- **`/dev/null` becomes a regular file**, accumulating everything redirected to
  it, and that file is then part of the launched container.

**Fix:** create at minimum `/dev/null`, `/dev/zero`, `/dev/random`,
`/dev/urandom`, `/dev/tty` before the first `RUN`, and mount `/proc` if cheap.

## 7. Overlay whiteouts are applied once after all layers

`applyWhiteouts` runs after the final layer, so a file deleted in layer 2 and
recreated in layer 3 ends up deleted. Whiteouts are per-layer and must be applied
between extractions. Related: a layer that changes a path's type (directory to
symlink) is mishandled, because `tar` merges into the existing directory.

**Fix:** apply whiteouts after each layer, inside the extraction loop.

## 8. Parser: continuations and comments

- Line continuations are joined with a literal newline, changing the command.
- A comment line *inside* a continued instruction terminates it, where Docker
  strips it and continues.

## Not bugs (verified and dropped)

Several plausible-looking claims were refuted, including cases the auditors
believed diverged but which `planBuild` already routes to buildah. The routing
check is doing its job; the failures above are all inside what it accepts.
