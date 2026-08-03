// Both vendored files are UMD. Under an ES module they find no `module`/`define`, so they assign their exports onto `self`, which is the worker global scope.

import './vendor/browser-wasi-shim.js'
import './vendor/browser-wasi-defs.js'

export type WasiImports = Record<string, (...args: never[]) => unknown>

export type WasiInstance = {
  exports: {
    memory: WebAssembly.Memory
    _start: () => void
  }
}

export type Wasi = {
  wasiImport: WasiImports
  inst: WasiInstance
  start: (instance: WebAssembly.Instance) => void
}

export type IovecLike = { buf: number; buf_len: number }

type IovecStatics = {
  read_bytes_array: (view: DataView, ptr: number, len: number) => IovecLike[]
}

type WasiGlobals = {
  WASI: new (args: string[], env: string[], fds: unknown[]) => Wasi
  Iovec: IovecStatics
  Ciovec: IovecStatics
}

const globals = self as unknown as WasiGlobals

if (typeof globals.WASI !== 'function') {
  throw new Error('browser_wasi_shim did not install its globals')
}

export const WASI = globals.WASI
export const Iovec = globals.Iovec
export const Ciovec = globals.Ciovec

export const ERRNO_INVAL = 28
export const ERRNO_AGAIN = 6
