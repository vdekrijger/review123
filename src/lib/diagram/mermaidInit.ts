/**
 * mermaidInit.ts — shared mermaid lazy-loader + initializer.
 *
 * Exports getMermaid() which lazy-imports mermaid and initializes it ONCE
 * with the shared config: securityLevel strict, dark theme when OS prefers
 * dark, 14px fonts, and useMaxWidth for flowcharts.
 *
 * Security: securityLevel:'strict' prevents mermaid from injecting arbitrary
 * HTML/JS from diagram source strings.
 */

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
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches

    m.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: prefersDark ? 'dark' : 'default',
      themeVariables: { fontSize: '14px' },
      flowchart: { useMaxWidth: true },
    })
    mermaidInitialized = true
  }
  return m
}
