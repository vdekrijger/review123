import '@testing-library/jest-dom/vitest'

// Node 26 exposes a native localStorage getter that returns undefined (requires
// --localstorage-file flag). This prevents vitest's jsdom environment from
// overriding it because populateGlobal skips keys that already exist in global.
// Manually restore localStorage/sessionStorage from the jsdom instance so that
// tests relying on Web Storage work correctly.
// TODO: remove when vitest/jsdom populateGlobal handles Node's native localStorage
// getter (see vitest issue tracker: populateGlobal skips keys already present on
// globalThis).
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

// HTMLDialogElement polyfill for jsdom (jsdom ≤ 29 does not implement
// showModal / close). Components call showModal() on mount to get true
// top-layer behaviour; without these stubs vitest tests would throw.
// The polyfill is minimal: showModal() sets open=true, close() sets
// open=false. A guard prevents double-polyfilling if a future jsdom
// version adds native support.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    if (this.open) throw new DOMException('The dialog is already open.', 'InvalidStateError')
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, _returnValue?: string) {
    if (!this.open) return
    this.open = false
  }
}
