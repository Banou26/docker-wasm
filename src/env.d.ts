// Ambient declarations for plain-JS dependencies served from public/ via
// classic <script> tags ahead of the module entry. These run before main.ts
// and expose their APIs as globals.

// ws-delegate.js (upstream c2w) — used only when `?net=delegate=<address>`.
// We don't author this; it's the WebSocket tunnel mode for testing.
declare const delegate: (
  worker: Worker,
  workerImageName: string,
  address: string,
) => (msg: MessageEvent) => void
