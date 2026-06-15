/**
 * highlightSnippet — syntax-highlight a SHORT, read-only code snippet using the
 * SAME engine the diff viewer uses (highlight.js, bundled with @git-diff-view's
 * lowlight in the `vendor-diff-view` lazy chunk).
 *
 * Why this exists: the diff highlights code internally inside @git-diff-view.
 * For inline "Tested by" test snippets we render OUTSIDE a FileDiff, so we need
 * the same token markup (`hljs-*` span classes) on our own `<pre>`. Reusing
 * highlight.js (already in the vendor-diff-view chunk) means we add NOTHING to
 * the entry bundle — the highlighter is dynamically imported on first use, so
 * it loads with the same chunk the diff route already pulls in.
 *
 * Output contract: returns a SANITIZED HTML string of `hljs-*` token spans,
 * safe to embed via {@html}. The token COLORS are supplied by the diff-view
 * stylesheet (already imported once by FileDiff) plus the snippet-scoped
 * overrides in SymbolTestPairing.svelte, so they're readable in light AND dark.
 */
import DOMPurify from 'dompurify'

// ---------------------------------------------------------------------------
// Extension → highlight.js language id. Only languages we register below.
// Distinct from codeNoise's CodeLang (which is a coarse family for dimming) —
// highlight.js needs the precise grammar id (e.g. 'typescript', not 'js').
// ---------------------------------------------------------------------------
const EXT_TO_HLJS: Record<string, string> = {
  json: 'json',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby',
  css: 'css', scss: 'css', less: 'css',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
}

/**
 * Derive the highlight.js language id from a filename's extension, or null when
 * the extension is unknown (caller then renders escaped plain text).
 */
export function snippetLangForFilename(filename: string): string | null {
  const base = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot + 1).toLowerCase()
  return EXT_TO_HLJS[ext] ?? null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// DOMPurify is a factory under jsdom/node; an initialized instance in a browser.
// Mirror render.ts's detection so the snippet goes through the same boundary.
function createPurify(): typeof DOMPurify {
  if (typeof DOMPurify === 'function' && !(DOMPurify as { isSupported?: boolean }).isSupported) {
    return (DOMPurify as unknown as (win: Window) => typeof DOMPurify)(
      globalThis.window ?? (globalThis as unknown as Window),
    )
  }
  return DOMPurify
}
const purify = createPurify()

// ---------------------------------------------------------------------------
// Lazy highlighter. highlight.js/lib/core is tree-shakeable; we register only
// the grammars we map above. The dynamic import keeps highlight.js out of the
// entry bundle (it lands in the vendor-diff-view chunk with the diff viewer).
// ---------------------------------------------------------------------------
type Hljs = {
  highlight: (code: string, opts: { language: string; ignoreIllegals?: boolean }) => { value: string }
  registerLanguage: (name: string, fn: unknown) => void
  getLanguage: (name: string) => unknown
}

let hljsPromise: Promise<Hljs> | null = null

async function loadHljs(): Promise<Hljs> {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const core = (await import('highlight.js/lib/core')).default as unknown as Hljs
      const langs: Array<[string, () => Promise<{ default: unknown }>]> = [
        ['json', () => import('highlight.js/lib/languages/json')],
        ['typescript', () => import('highlight.js/lib/languages/typescript')],
        ['javascript', () => import('highlight.js/lib/languages/javascript')],
        ['python', () => import('highlight.js/lib/languages/python')],
        ['go', () => import('highlight.js/lib/languages/go')],
        ['rust', () => import('highlight.js/lib/languages/rust')],
        ['java', () => import('highlight.js/lib/languages/java')],
        ['kotlin', () => import('highlight.js/lib/languages/kotlin')],
        ['ruby', () => import('highlight.js/lib/languages/ruby')],
        ['css', () => import('highlight.js/lib/languages/css')],
        ['sql', () => import('highlight.js/lib/languages/sql')],
        ['yaml', () => import('highlight.js/lib/languages/yaml')],
        ['xml', () => import('highlight.js/lib/languages/xml')],
        ['bash', () => import('highlight.js/lib/languages/bash')],
      ]
      await Promise.all(
        langs.map(async ([name, load]) => {
          core.registerLanguage(name, (await load()).default)
        }),
      )
      return core
    })()
  }
  return hljsPromise
}

/**
 * Highlight a snippet into sanitized `hljs-*` token markup.
 *
 * - `lang` null / unknown → returns HTML-escaped plain text (no tokens).
 * - On any highlighter failure, falls back to escaped plain text (never throws).
 * - Output is DOMPurify-sanitized → safe to embed via {@html}.
 */
export async function highlightSnippet(code: string, lang: string | null): Promise<string> {
  if (!lang) return escapeHtml(code)
  try {
    const hljs = await loadHljs()
    if (!hljs.getLanguage(lang)) return escapeHtml(code)
    const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true })
    // highlight.js already HTML-escapes text nodes; sanitize as belt-and-braces.
    return purify.sanitize(value)
  } catch {
    return escapeHtml(code)
  }
}
