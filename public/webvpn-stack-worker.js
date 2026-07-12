// webvpn-stack-worker.js - runs c2w-webvpn-proxy.wasm.
// Variant of upstream stack-worker.js, with @webvpn egress imports instead of
// the http_* fetch bridge. Inlines just the wasiHack pieces we need so we
// don't have to importScripts a file with its own onmessage handler.
importScripts(location.origin + "/browser_wasi_shim/index.js");
importScripts(location.origin + "/browser_wasi_shim/wasi_defs.js");
importScripts(location.origin + "/worker-util.js");
importScripts(location.origin + "/wasi-util.js");
importScripts(location.origin + "/webvpn-imports.js");

// from wasi-libc
const ERRNO_INVAL = 28;

// Minimal wasiHack: just stdio + poll_oneoff. No cert/fd-3 dance - our proxy
// doesn't open fd 3.
function wasiHack(wasi, connfd) {
    wasi.wasiImport.fd_fdstat_set_flags = (fd, fdflags) => 0;
    var _fd_write = wasi.wasiImport.fd_write;
    wasi.wasiImport.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
        if (fd == 1 || fd == 2) {
            var buffer = new DataView(wasi.inst.exports.memory.buffer);
            var buffer8 = new Uint8Array(wasi.inst.exports.memory.buffer);
            var iovecs = Ciovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
            var wtotal = 0;
            for (var i = 0; i < iovecs.length; i++) {
                var iovec = iovecs[i];
                var buf = buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len);
                if (buf.length == 0) continue;
                console.log("[proxy]", new TextDecoder().decode(buf));
                wtotal += buf.length;
            }
            buffer.setUint32(nwritten_ptr, wtotal, true);
            return 0;
        }
        return _fd_write.apply(wasi.wasiImport, [fd, iovs_ptr, iovs_len, nwritten_ptr]);
    };
    wasi.wasiImport.poll_oneoff = (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
        if (nsubscriptions == 0) return ERRNO_INVAL;
        let buffer = new DataView(wasi.inst.exports.memory.buffer);
        let in_ = Subscription.read_bytes_array(buffer, in_ptr, nsubscriptions);
        let isReadPollConn = false;
        let isClockPoll = false;
        let pollSubConn, clockSub;
        let timeout = Number.MAX_VALUE;
        for (let sub of in_) {
            if (sub.u.tag.variant == "fd_read") {
                if (sub.u.data.fd != connfd) return ERRNO_INVAL;
                isReadPollConn = true;
                pollSubConn = sub;
            } else if (sub.u.tag.variant == "clock") {
                if (sub.u.data.timeout < timeout) {
                    timeout = sub.u.data.timeout;
                    isClockPoll = true;
                    clockSub = sub;
                }
            } else {
                return ERRNO_INVAL;
            }
        }
        let events = [];
        if (isReadPollConn || isClockPoll) {
            var sockreadable = sockWaitForReadable(timeout / 1000000000);
            if (isReadPollConn && sockreadable === true) {
                let ev = new Event();
                ev.userdata = pollSubConn.userdata;
                ev.error = 0;
                ev.type = new EventType("fd_read");
                events.push(ev);
            }
            if (isClockPoll) {
                let ev = new Event();
                ev.userdata = clockSub.userdata;
                ev.error = 0;
                ev.type = new EventType("clock");
                events.push(ev);
            }
        }
        Event.write_bytes_array(buffer, out_ptr, events);
        buffer.setUint32(nevents_ptr, events.length, true);
        return 0;
    };
}

onmessage = (msg) => {
    serveIfInitMsg(msg);
    var fds = [undefined, undefined, undefined, undefined, undefined, undefined];
    var listenfd = 4;
    var args = ['arg0', '--net-listenfd=' + listenfd];
    if (new URLSearchParams(location.search).has('publish')) args.push('--ingress');
    var env = [];
    var wasi = new WASI(args, env, fds);
    wasiHack(wasi, 5);
    wasiHackSocket(wasi, listenfd, 5);
    fetch(getImagename(), { credentials: 'same-origin' }).then((resp) => {
        resp['arrayBuffer']().then((wasm) => {
            WebAssembly.instantiate(wasm, {
                "wasi_snapshot_preview1": wasi.wasiImport,
                "env": webvpnEnvImports(wasi),
            }).then((inst) => {
                wasi.start(inst.instance);
            });
        })
    });
};
