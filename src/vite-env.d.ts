/// <reference types="svelte" />
/// <reference types="vite/client" />

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
