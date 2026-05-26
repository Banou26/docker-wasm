# dockerfile-playground

A little website where you drop a Dockerfile, the backend builds it
(`docker build` + `c2w`) on the host, and the resulting wasm container runs in
your browser with real TCP/UDP egress via the `c2w-webvpn` netstack.

```
┌──────────────────────────────────────────────────────────────────────┐
│  drop UI  (web/)            backend.cjs            alpine-curl/htdocs/│
│  ───────────────────  fetch+SSE  ─────────────────  reused runtime    │
│  paste/drop Dockerfile ───────▶ POST /api/build                       │
│                       ◀───────  job id                                │
│                       ◀── SSE ─ docker build … c2w …                  │
│                                                                       │
│  click "Run" ──────────────▶ window.location =                        │
│                              /?net=webvpn&wasm=<jobId>                │
│                              (runtime fetches /wasm/<jobId>/out.wasm) │
└──────────────────────────────────────────────────────────────────────┘
```

## Prereqs

The same dev environment that `examples/alpine-curl/build.sh` needs:

- Docker with working network *inside build containers*
- Go ≥ 1.23, `c2w` on `PATH`
- node + npm

And, for the actual run: `~/dev/fkn/webvpn` + `~/dev/fkn/web` running locally
(see `../alpine-curl/README.md` for the recipe), with `examples/alpine-curl/`
already built once (so its `htdocs/` exists with the netstack proxy + the
@webvpn bundle).

## Run

```sh
# one-time: prepare the runtime assets (proxy wasm + @webvpn bundle)
cd examples/alpine-curl
FKN_API="http://127.0.0.1:1234/api.html" ./build.sh

# start the playground (port 8080, COOP/COEP enabled)
cd ../dockerfile-playground
node backend.cjs
```

Open <http://127.0.0.1:8080/playground/>. Drop or paste a Dockerfile. After
the build, click **Run**.

## Try

A trivial first build:

```dockerfile
FROM alpine:3.19
RUN apk add --no-cache curl
CMD ["/bin/sh"]
```

Inside the booted shell:

```sh
echo nameserver 192.168.127.1 > /etc/resolv.conf
curl -sS https://example.com | head -5
```

## Notes / sharp edges

- **Builds are slow.** Each `c2w` run takes minutes — it ships a real x86
  emulator + the rootfs. Subsequent builds are faster (buildkit cache).
- **Single build at a time.** Backend serializes jobs to avoid disk/CPU thrash.
- **Dockerfile only, no context.** v1 only accepts the Dockerfile text — no
  `COPY` of local files. Add zip-context support if needed.
- **No isolation of arbitrary builds.** The backend runs `docker build` on
  whatever you drop. Trust your own input.
- **Jobs land in `/tmp/c2w-playground/<jobId>/`.** Each is ~120 MiB; cleanup
  is manual for now.
