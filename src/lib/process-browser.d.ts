declare module 'process/browser.js' {
  const value: { nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void }
  export default value
}
