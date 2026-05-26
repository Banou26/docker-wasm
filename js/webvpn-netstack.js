// webvpn-netstack.js — MAIN THREAD side (runs alongside stack.js).
//
// Owns the real egress sockets. When the proxy worker asks to connect/send/recv
// over a flow, those requests arrive here as postMessages and are serviced
// against @webvpn/net (TCP) and @webvpn/dgram (UDP) sockets, with per-socket
// ring buffers filled asynchronously by @webvpn callbacks between the worker's
// synchronous round-trips.
//
// The buffer discipline (copy every received chunk before stashing it, drain
// into the SAB on demand) is ported directly from libtorrent's library_fkn.js,
// where reusing @webvpn's backing buffers across reads caused silent
// corruption.
//
// Wiring: in stack.js, construct one of these and give the message handler
// first refusal on each request before its existing switch:
//
//   const webvpn = createWebvpnNetstack({ net, dgram });   // from @webvpn/*
//   ...
//   return function(msg){
//       const req_ = msg.data;
//       if (typeof req_ == "object" && req_.type) {
//           if (webvpn.handle(req_, { streamStatus, streamLen, streamData })) {
//               Atomics.store(streamCtrl, 0, 1);
//               Atomics.notify(streamCtrl, 0);
//               return;
//           }
//           switch (req_.type) { /* ... existing cases ... */ }
//       }
//   }

function createWebvpnNetstack(host) {
    if (!host || !host.net || !host.dgram) {
        throw new Error("createWebvpnNetstack: { net, dgram } required");
    }
    const sockets = new Map(); // id -> state
    let nextId = 1;

    function openTCP(hostname, port) {
        const id = nextId++;
        const sock = host.net.connect({ host: hostname, port: port });
        const st = { kind: "tcp", sock: sock, chunks: [], total: 0, fin: false, error: 0 };
        sock.on("data", (chunk) => {
            // Copy: @webvpn's stream reader may reuse backing buffers between
            // reads (see library_fkn.js). Stashing the original reference lets
            // a later read overwrite bytes we haven't drained yet.
            const src = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            const copy = new Uint8Array(src.length);
            copy.set(src);
            st.chunks.push(copy);
            st.total += copy.length;
        });
        sock.on("end", () => { st.fin = true; });
        sock.on("close", () => { st.fin = true; });
        sock.on("error", () => { st.error = 1; st.fin = true; });
        sockets.set(id, st);
        return id;
    }

    function openUDP(hostname, port) {
        const id = nextId++;
        const sock = host.dgram.createSocket({ type: "udp4" });
        const st = { kind: "udp", sock: sock, host: hostname, port: port, datagrams: [], error: 0 };
        sock.on("message", (data) => {
            const src = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
            const copy = new Uint8Array(src.length);
            copy.set(src);
            st.datagrams.push(copy); // message-oriented: one recv drains one datagram
        });
        sock.on("error", () => { st.error = 1; });
        sockets.set(id, st);
        return id;
    }

    // Drain up to len bytes of stream data across queued chunks.
    function drainTCP(st, len) {
        if (st.total === 0) {
            return { bytes: new Uint8Array(0), eof: st.fin || st.error !== 0 };
        }
        const need = Math.min(len, st.total);
        const out = new Uint8Array(need);
        let off = 0;
        while (off < need && st.chunks.length) {
            const chunk = st.chunks[0];
            const take = Math.min(chunk.length, need - off);
            out.set(chunk.subarray(0, take), off);
            if (take === chunk.length) {
                st.chunks.shift();
            } else {
                st.chunks[0] = chunk.subarray(take);
            }
            st.total -= take;
            off += take;
        }
        return { bytes: out, eof: false };
    }

    // Datagram socket: return one datagram per recv (UDP is message-oriented),
    // truncated to len. No EOF for UDP.
    function drainUDP(st, len) {
        if (!st.datagrams.length) {
            return { bytes: new Uint8Array(0), eof: false };
        }
        const dg = st.datagrams.shift();
        const take = Math.min(dg.length, len);
        return { bytes: dg.subarray(0, take), eof: false };
    }

    function close(id) {
        const st = sockets.get(id);
        if (!st) return;
        try {
            if (st.kind === "tcp") st.sock.destroy();
            else st.sock.close();
        } catch (e) { /* already gone */ }
        sockets.delete(id);
    }

    return {
        // Returns true if it handled the request (and populated sab); false to
        // let the caller's existing switch take it.
        handle(req_, sab) {
            const { streamStatus, streamLen, streamData } = sab;
            switch (req_.type) {
                case "webvpn_connect": {
                    const hostname = new TextDecoder().decode(req_.host);
                    const proto = req_.network === 1 ? "udp" : "tcp";
                    try {
                        streamStatus[0] = req_.network === 1
                            ? openUDP(hostname, req_.port)
                            : openTCP(hostname, req_.port);
                        console.log("[webvpn] connect " + proto + " " + hostname + ":" + req_.port + " -> id=" + streamStatus[0]);
                    } catch (e) {
                        console.log("[webvpn] connect " + proto + " " + hostname + ":" + req_.port + " FAILED: " + e);
                        streamStatus[0] = -1;
                    }
                    return true;
                }
                case "webvpn_send": {
                    const st = sockets.get(req_.id);
                    if (!st) { streamStatus[0] = -1; return true; }
                    try {
                        if (st.kind === "tcp") {
                            st.sock.write(req_.buf);
                        } else {
                            st.sock.send(req_.buf, 0, req_.buf.length, st.port, st.host);
                        }
                        streamStatus[0] = req_.buf.length; // accepted; @webvpn buffers
                    } catch (e) {
                        streamStatus[0] = -1;
                    }
                    return true;
                }
                case "webvpn_recv": {
                    const st = sockets.get(req_.id);
                    if (!st) { streamStatus[0] = -1; return true; }
                    let len = req_.len;
                    if (len > streamData.byteLength) len = streamData.byteLength;
                    const out = st.kind === "tcp" ? drainTCP(st, len) : drainUDP(st, len);
                    streamLen[0] = out.bytes.length;
                    if (out.bytes.length > 0) streamData.set(out.bytes, 0);
                    streamStatus[0] = out.eof ? 1 : 0;
                    return true;
                }
                case "webvpn_close": {
                    close(req_.id);
                    streamStatus[0] = 0;
                    return true;
                }
                case "webvpn_image_size": {
                    // Look up a pulled image's byte length. The image cache is
                    // populated by registry.js at page load (one entry per FROM
                    // ref in the Dockerfile). The promise may still be pending
                    // — await it.
                    const ref = new TextDecoder().decode(req_.ref);
                    const cache = globalThis.webvpnImages;
                    const entry = cache && cache.get(ref);
                    if (!entry) {
                        console.log("[webvpn] image_size: not in cache: " + ref);
                        streamStatus[0] = -1;
                        return true;
                    }
                    return Promise.resolve(entry.promise || entry.bytes).then((bytes) => {
                        entry.bytes = bytes;
                        streamStatus[0] = bytes.length;
                        console.log("[webvpn] image_size " + ref + " -> " + bytes.length + " bytes");
                    }).catch((e) => {
                        console.log("[webvpn] image_size failed: " + e);
                        streamStatus[0] = -1;
                    });
                }
                case "webvpn_image_chunk": {
                    const ref = new TextDecoder().decode(req_.ref);
                    const cache = globalThis.webvpnImages;
                    const entry = cache && cache.get(ref);
                    if (!entry || !entry.bytes) {
                        streamStatus[0] = -1;
                        return true;
                    }
                    const start = Math.max(0, req_.offset | 0);
                    const end = Math.min(start + (req_.len | 0), entry.bytes.length);
                    const slice = entry.bytes.subarray(start, end);
                    if (slice.length > 0) streamData.set(slice, 0);
                    streamLen[0] = slice.length;
                    streamStatus[0] = 0;
                    return true;
                }
                case "webvpn_dns_query": {
                    // Pipe raw DNS wire-format bytes through DoH (RFC 8484) —
                    // cloudflare-dns.com supports CORS, so plain fetch() works
                    // and we skip the slow per-query UDP socket through @webvpn.
                    return fetch("https://cloudflare-dns.com/dns-query", {
                        method: "POST",
                        headers: {
                            "Content-Type":  "application/dns-message",
                            "Accept":        "application/dns-message",
                        },
                        body: req_.query,
                    }).then(async (r) => {
                        const bytes = new Uint8Array(await r.arrayBuffer());
                        const n = Math.min(bytes.length, streamData.byteLength);
                        streamData.set(bytes.subarray(0, n), 0);
                        streamLen[0] = n;
                        streamStatus[0] = 0;
                    }).catch((e) => {
                        console.log("[webvpn] dns_query failed: " + e);
                        streamStatus[0] = -1;
                    });
                }
                default:
                    return false;
            }
        },
    };
}

if (typeof globalThis !== "undefined") {
    globalThis.createWebvpnNetstack = createWebvpnNetstack;
}
