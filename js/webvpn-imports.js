// webvpn-imports.js — WORKER side (runs in stack-worker.js).
//
// Defines the four `env` wasmimports that c2w-webvpn-proxy.wasm calls for
// egress. Each one is a synchronous, blocking round-trip to the main thread
// over the existing SharedArrayBuffer stream protocol (streamCtrl/streamStatus/
// streamLen/streamData, set up by worker-util.js's registerSocketBuffer):
//
//   1. write request args into a postMessage
//   2. Atomics.wait on streamCtrl until the main thread services it
//   3. read the result back out of streamStatus/streamLen/streamData
//
// This is the identical mechanism stack-worker.js already uses for http_send /
// http_recv, so it composes with the existing WASI plumbing untouched.
//
// Wiring: in stack-worker.js, merge these into the object returned by
// envHack(wasi):
//
//   importScripts(location.origin + "/webvpn-imports.js");
//   ...
//   "env": Object.assign(envHack(wasi), webvpnEnvImports(wasi)),
//
// The Go-side ABI is declared in proxy/webvpn.go. Keep the two in sync.

// from wasi-libc errno
const WEBVPN_ERRNO_INVAL = 28;

function webvpnEnvImports(wasi) {
    function mem() {
        return wasi.inst.exports.memory.buffer;
    }

    return {
        // webvpn_connect(network, hostP, hostLen, port, idP) -> errno
        // network: 0 = TCP, 1 = UDP. Writes the new socket id to *idP.
        webvpn_connect: function (network, hostP, hostLen, port, idP) {
            const host = new Uint8Array(mem(), hostP, hostLen).slice();
            streamCtrl[0] = 0;
            postMessage({ type: "webvpn_connect", network: network, host: host, port: port });
            Atomics.wait(streamCtrl, 0, 0);
            if (streamStatus[0] < 0) {
                return WEBVPN_ERRNO_INVAL;
            }
            new DataView(mem()).setUint32(idP, streamStatus[0], true);
            return 0;
        },

        // webvpn_send(id, bufP, bufLen, nwrittenP) -> errno
        // Writes the number of bytes accepted to *nwrittenP (0 = backpressure).
        webvpn_send: function (id, bufP, bufLen, nwrittenP) {
            const buf = new Uint8Array(mem(), bufP, bufLen).slice();
            streamCtrl[0] = 0;
            postMessage({ type: "webvpn_send", id: id, buf: buf });
            Atomics.wait(streamCtrl, 0, 0);
            if (streamStatus[0] < 0) {
                return WEBVPN_ERRNO_INVAL;
            }
            new DataView(mem()).setUint32(nwrittenP, streamStatus[0], true);
            return 0;
        },

        // webvpn_recv(id, bufP, bufLen, nreadP, flagsP) -> errno
        // Writes bytes read to *nreadP (0 = would-block) and flags to *flagsP
        // (bit0 = EOF). Capped to the SAB data window per call; the Go side
        // loops.
        webvpn_recv: function (id, bufP, bufLen, nreadP, flagsP) {
            let len = bufLen;
            if (len > streamData.byteLength) {
                len = streamData.byteLength;
            }
            streamCtrl[0] = 0;
            postMessage({ type: "webvpn_recv", id: id, len: len });
            Atomics.wait(streamCtrl, 0, 0);
            if (streamStatus[0] < 0) {
                return WEBVPN_ERRNO_INVAL;
            }
            const n = streamLen[0];
            const view = new DataView(mem());
            if (n > 0) {
                new Uint8Array(mem()).set(streamData.slice(0, n), bufP);
            }
            view.setUint32(nreadP, n, true);
            view.setUint32(flagsP, streamStatus[0] === 1 ? 1 : 0, true);
            return 0;
        },

        // webvpn_close(id) -> errno
        webvpn_close: function (id) {
            streamCtrl[0] = 0;
            postMessage({ type: "webvpn_close", id: id });
            Atomics.wait(streamCtrl, 0, 0);
            return 0;
        },

        // webvpn_dns_query(queryP, queryLen, respP, respCap, respLenP) -> errno
        // Pipes a DNS query (wire format) to the main-thread handler, which does
        // DoH via @fkn/lib's serverProxyFetch and returns the raw response.
        webvpn_dns_query: function (queryP, queryLen, respP, respCap, respLenP) {
            const query = new Uint8Array(mem(), queryP, queryLen).slice();
            streamCtrl[0] = 0;
            postMessage({ type: "webvpn_dns_query", query: query });
            Atomics.wait(streamCtrl, 0, 0);
            if (streamStatus[0] < 0) return WEBVPN_ERRNO_INVAL;
            const n = Math.min(streamLen[0], respCap);
            if (n > 0) new Uint8Array(mem()).set(streamData.slice(0, n), respP);
            new DataView(mem()).setUint32(respLenP, n, true);
            return 0;
        },
    };
}

if (typeof globalThis !== "undefined") {
    globalThis.webvpnEnvImports = webvpnEnvImports;
}
