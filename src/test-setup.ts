import '@testing-library/jest-dom/vitest'

// Node 26 exposes a native localStorage getter that returns undefined (requires
// --localstorage-file flag). This prevents vitest's jsdom environment from
// overriding it because populateGlobal skips keys that already exist in global.
// Manually restore localStorage/sessionStorage from the jsdom instance so that
// tests relying on Web Storage work correctly.
declare const jsdom: { window: Window & typeof globalThis }
if (typeof jsdom !== 'undefined' && jsdom.window) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdom.window.localStorage,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: jsdom.window.sessionStorage,
    writable: true,
    configurable: true,
  })
}
