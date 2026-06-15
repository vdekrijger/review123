/// <reference types="svelte" />
/// <reference types="vite/client" />

// Injected by Vite's `define` at build time (see vite.config.ts): the short git
// sha and an ISO build timestamp of the running bundle. Declared here so TS
// resolves the bare globals; buildInfo.ts guards them with a typeof check for
// environments (vitest) where the define is absent.
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string

// svelte-check's default (non-incremental) mode uses the TypeScript language service,
// which strips the *.svelte ambient declaration from svelte/types/index.d.ts and is
// supposed to resolve .svelte imports via its own snapshot mechanism. However, with
// moduleResolution: "bundler" the LS falls back to ambient lookup when the snapshot
// path resolves to the raw .svelte file (not a .d.svelte.ts virtual path). This shim
// re-adds the minimal declaration so the import succeeds. It uses `Record<string, any>`
// (not `unknown`) to remain open to any props without suppressing access.
declare module '*.svelte' {
  import type { Component } from 'svelte'
  const component: Component<Record<string, any>>
  export default component
}
