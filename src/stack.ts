// SharedArrayBuffer-bridged message handler between the c2w container worker
// (worker.js) and the netstack-proxy worker (webvpn-stack-worker.js).
//
// `newStack` allocates two SAB-backed channels and returns the main-thread
// message handler the VM worker posts to. The handler services socket / HTTP /
// cert / webvpn_* request types from the proxy + VM workers.

import type { Netstack, ImageCache } from './webvpn-netstack'

type BufRef = { buf: Uint8Array }
type CertBuf = { buf: Uint8Array; done: boolean }
type Conn = { sendbuf: BufRef; recvbuf: BufRef }

type WorkerHandler = (msg: MessageEvent) => void

type HttpConn = {
  address: string
  request: {
    method?: string
    headers?: Record<string, string>
    body?: Uint8Array
    mode?: string
    credentials?: string
  }
  requestSent: boolean
  reqBodybuf: Uint8Array
  reqBodyEOF: boolean
  response?: Uint8Array
  done?: boolean
  respBodybuf?: Uint8Array
}

const appendData = (a: Uint8Array, b: ArrayBuffer | Uint8Array): Uint8Array => {
  const bb = b instanceof Uint8Array ? b : new Uint8Array(b)
  const out = new Uint8Array(a.byteLength + bb.byteLength)
  out.set(a, 0)
  out.set(bb, a.byteLength)
  return out
}

export const newStack = (
  worker: Worker,
  workerImageName: string,
  stackWorker: Worker,
  stackImageName: string,
  netstack: () => Netstack | null,
): WorkerHandler => {
  const p2vbuf: BufRef = { buf: new Uint8Array(0) }   // proxy -> vm
  const v2pbuf: BufRef = { buf: new Uint8Array(0) }   // vm    -> proxy
  const proxyConn: Conn = { sendbuf: p2vbuf, recvbuf: v2pbuf }
  const vmConn: Conn = { sendbuf: v2pbuf, recvbuf: p2vbuf }

  const proxyShared = new SharedArrayBuffer(12 + 4096)
  const certbuf: CertBuf = { buf: new Uint8Array(0), done: false }
  stackWorker.onmessage = connect('proxy', proxyShared, proxyConn, certbuf, netstack)
  stackWorker.postMessage({ type: 'init', buf: proxyShared, imagename: stackImageName })

  const vmShared = new SharedArrayBuffer(12 + 4096)
  worker.postMessage({ type: 'init', buf: vmShared, imagename: workerImageName })
  return connect('vm', vmShared, vmConn, certbuf, netstack)
}

const connect = (
  name: string,
  shared: SharedArrayBuffer,
  conn: Conn,
  certbuf: CertBuf,
  netstack: () => Netstack | null,
): WorkerHandler => {
  const streamCtrl = new Int32Array(shared, 0, 1)
  const streamStatus = new Int32Array(shared, 4, 1)
  const streamLen = new Int32Array(shared, 8, 1)
  const streamData = new Uint8Array(shared, 12)
  const sendbuf = conn.sendbuf
  const recvbuf = conn.recvbuf
  let accepted = false
  const httpConnections: Record<number, HttpConn> = {}
  let curID = 0
  const maxID = 0x7FFFFFFF
  let timeoutHandler: ReturnType<typeof setTimeout> | null = null

  const getID = (): number => {
    const startID = curID
    while (true) {
      if (httpConnections[curID] == undefined) return curID
      curID = curID >= maxID ? 0 : curID + 1
      if (curID === startID) return -1
    }
  }

  const serveData = (data: Uint8Array, len: number): Uint8Array => {
    let length = len
    if (length > streamData.byteLength) length = streamData.byteLength
    if (length > data.byteLength) length = data.byteLength
    const buf = data.slice(0, length)
    const remain = data.slice(length, data.byteLength)
    streamLen[0] = buf.byteLength
    streamData.set(buf, 0)
    return remain
  }

  return (msg: MessageEvent) => {
    const req_ = msg.data
    if (!(typeof req_ === 'object' && req_ && typeof req_.type === 'string')) {
      console.log('UNKNOWN MSG ' + msg)
      return
    }
    // First refusal for c2w-webvpn egress messages - fall through to the
    // existing switch for legacy http_*/accept/send/etc.
    if ((req_.type as string).indexOf('webvpn_') === 0) {
      const w = netstack()
      if (!w) {
        streamStatus[0] = -1
        Atomics.store(streamCtrl, 0, 1)
        Atomics.notify(streamCtrl, 0)
        return
      }
      // handle() may be sync (returns true) or async (returns a Promise) -
      // async handlers do their own SAB writes; we notify when they settle.
      Promise.resolve(w.handle(req_, { streamStatus, streamLen, streamData }))
        .catch(() => { streamStatus[0] = -1 })
        .then(() => {
          Atomics.store(streamCtrl, 0, 1)
          Atomics.notify(streamCtrl, 0)
        })
      return
    }

    switch (req_.type) {
      case 'accept':
        accepted = true
        streamData[0] = 1
        streamStatus[0] = 0
        break
      case 'send':
        if (!accepted) { console.log(name + ': cannot send to unaccepted socket'); streamStatus[0] = -1; break }
        sendbuf.buf = appendData(sendbuf.buf, req_.buf)
        streamStatus[0] = 0
        break
      case 'recv':
        if (!accepted) { console.log(name + ': cannot recv from unaccepted socket'); streamStatus[0] = -1; break }
        recvbuf.buf = serveData(recvbuf.buf, req_.len)
        streamStatus[0] = 0
        break
      case 'recv-is-readable': {
        if (recvbuf.buf.byteLength > 0) {
          streamData[0] = 1
        } else if (req_.timeout != undefined && req_.timeout > 0) {
          if (timeoutHandler) clearTimeout(timeoutHandler)
          timeoutHandler = setTimeout(() => {
            if (timeoutHandler) { clearTimeout(timeoutHandler); timeoutHandler = null }
            streamData[0] = recvbuf.buf.byteLength > 0 ? 1 : 0
            streamStatus[0] = 0
            Atomics.store(streamCtrl, 0, 1)
            Atomics.notify(streamCtrl, 0)
          }, req_.timeout * 1000)
          return
        } else {
          streamData[0] = 0
        }
        streamStatus[0] = 0
        break
      }
      case 'http_send': {
        const reqObj = JSON.parse(new TextDecoder().decode(req_.req))
        reqObj.mode = 'cors'
        reqObj.credentials = 'omit'
        if (reqObj.headers && reqObj.headers['User-Agent'] !== '') {
          delete reqObj.headers['User-Agent']   // browser adds its own
        }
        const reqID = getID()
        if (reqID < 0) { console.log(name + ': failed to get id'); streamStatus[0] = -1; break }
        httpConnections[reqID] = {
          address: new TextDecoder().decode(req_.address),
          request: reqObj,
          requestSent: false,
          reqBodybuf: new Uint8Array(0),
          reqBodyEOF: false,
        }
        streamStatus[0] = reqID
        break
      }
      case 'http_writebody': {
        const c = httpConnections[req_.id]!
        c.reqBodybuf = appendData(c.reqBodybuf, req_.body)
        c.reqBodyEOF = req_.isEOF
        streamStatus[0] = 0
        if (req_.isEOF && !c.requestSent) {
          c.requestSent = true
          if (c.request.method !== 'HEAD' && c.request.method !== 'GET') {
            c.request.body = c.reqBodybuf
          }
          fetch(c.address, c.request as RequestInit).then((resp) => {
            c.response = new TextEncoder().encode(JSON.stringify({
              bodyUsed: resp.bodyUsed,
              headers: resp.headers,
              redirected: resp.redirected,
              status: resp.status,
              statusText: resp.statusText,
              type: resp.type,
              url: resp.url,
            }))
            c.done = false
            c.respBodybuf = new Uint8Array(0)
            if (resp.ok) {
              resp.arrayBuffer().then((data) => {
                c.respBodybuf = new Uint8Array(data)
                c.done = true
              }).catch((error) => {
                c.respBodybuf = new Uint8Array(0)
                c.done = true
                console.log('failed to fetch body: ' + error)
              })
            } else {
              c.done = true
            }
          }).catch((_error) => {
            c.response = new TextEncoder().encode(JSON.stringify({
              status: 503,
              statusText: 'Service Unavailable',
            }))
            c.respBodybuf = new Uint8Array(0)
            c.done = true
          })
        }
        break
      }
      case 'http_isreadable': {
        const c = httpConnections[req_.id]
        streamData[0] = c && c.response ? 1 : 0
        streamStatus[0] = 0
        break
      }
      case 'http_recv': {
        const c = httpConnections[req_.id]
        if (!c || !c.response) { console.log(name + ': response is not available'); streamStatus[0] = -1; break }
        c.response = serveData(c.response, req_.len)
        streamStatus[0] = c.response.byteLength === 0 ? 1 : 0
        break
      }
      case 'http_readbody': {
        const c = httpConnections[req_.id]
        if (!c || !c.respBodybuf) { console.log(name + ': response body is not available'); streamStatus[0] = -1; break }
        c.respBodybuf = serveData(c.respBodybuf, req_.len)
        streamStatus[0] = 0
        if (c.done && c.respBodybuf.byteLength === 0) {
          streamStatus[0] = 1
          delete httpConnections[req_.id]
        }
        break
      }
      case 'send_cert':
        certbuf.buf = appendData(certbuf.buf, req_.buf)
        certbuf.done = true
        streamStatus[0] = 0
        break
      case 'recv_cert':
        if (!certbuf.done) { streamStatus[0] = -1; break }
        certbuf.buf = serveData(certbuf.buf, req_.len)
        streamStatus[0] = certbuf.buf.byteLength === 0 ? 1 : 0
        break
      default:
        console.log(name + ': unknown request: ' + req_.type)
        return
    }
    Atomics.store(streamCtrl, 0, 1)
    Atomics.notify(streamCtrl, 0)
  }
}

// Re-export type for main.ts convenience.
export type { Netstack, ImageCache }
