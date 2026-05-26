// Entry file bundled by esbuild into webvpn-bundle.js.
// Exposes @webvpn + createWebvpnNetstack on globalThis so the classic-script
// stack.js can call them.

import { connect } from '@webvpn/net'
import * as dgram from '@webvpn/dgram'
import { serverProxyFetch } from '@fkn/lib'

// import the existing helper as a module (the file is dual-form — ends with a
// globalThis assignment when loaded classically; here we just import the function)
import './webvpn-netstack.js'

globalThis.webvpnConnect = connect
globalThis.webvpnDgram = dgram
globalThis.webvpnProxyFetch = serverProxyFetch
