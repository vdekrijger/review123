/**
 * mermaidInit.ts — shared mermaid lazy-loader + initializer.
 *
 * Exports getMermaid() which lazy-imports mermaid and initializes it ONCE
 * with the shared config: securityLevel strict, theme from resolvedTheme(),
 * 14px fonts, and useMaxWidth for flowcharts.
 *
 * Security: securityLevel:'strict' prevents mermaid from injecting arbitrary
 * HTML/JS from diagram source strings.
 *
 * Note: mermaid is initialized once at first call. If the user changes the
 * theme setting, diagram colors will update on next page reload.
 */
import { resolvedTheme } from '../settings/appearance.svelte'

let mermaidMod: typeof import('mermaid') | null = null
let mermaidInitialized = false

/**
 * Lazy-import mermaid and initialize once.
 * Returns the mermaid default export (the mermaid API object).
 */
export async function getMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidMod) {
    mermaidMod = await import('mermaid')
  }
  const m = mermaidMod.default
  if (!mermaidInitialized) {
    m.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: resolvedTheme() === 'dark' ? 'dark' : 'default',
      themeVariables: { fontSize: '14px' },
      flowchart: { useMaxWidth: true },
    })
    mermaidInitialized = true
  }
  return m
}
