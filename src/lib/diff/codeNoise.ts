/**
 * src/lib/diff/codeNoise.ts — Focus-mode "code noise" line classifier.
 *
 * Best-effort, CONSERVATIVE, line-level detection of import statements and
 * comment lines so Focus mode can visually DIM (never hide) them in the diff.
 *
 * Design notes
 * - This is a pure-heuristic classifier, NOT a parser. It looks only at a
 *   single line's text plus the file's language. It deliberately prefers FALSE
 *   NEGATIVES (missing some noise) over FALSE POSITIVES (dimming real code):
 *   dimming a real statement is more harmful than leaving one import bright.
 * - "Comment" detection is line-LEVEL: a line counts as a comment only when its
 *   first non-whitespace run begins with the language's comment token (or it is
 *   a continuation/close line inside a block comment, e.g. a line starting with
 *   a star). Trailing comments after code are intentionally NOT classified —
 *   that would risk dimming the code on the same line, which we cannot see here.
 * - String-literal awareness is shallow: because we only match LINE-LEADING
 *   tokens, a slash-slash or hash inside a string mid-line is never matched.
 *   The comment token must sit at column 0 of the trimmed text.
 */

export type CodeLang =
  | 'js' // JS / TS / JSX / TSX / Svelte / Vue
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'rust'
  | 'ruby'
  | 'css' // CSS / SCSS / LESS
  | 'sql'
  | 'html' // HTML / XML
  | 'shell'

export type NoiseKind = 'import' | 'comment'

// Extension → language. Lowercased, no leading dot.
const EXT_TO_LANG: Record<string, CodeLang> = {
  // JS / TS family
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  svelte: 'js', vue: 'js',
  // Python
  py: 'python', pyi: 'python',
  // Go
  go: 'go',
  // Java / Kotlin
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  // Rust
  rs: 'rust',
  // Ruby
  rb: 'ruby',
  // CSS family
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  // SQL
  sql: 'sql',
  // HTML / XML
  html: 'html', htm: 'html', xml: 'html', svg: 'html', xhtml: 'html',
  // Shell
  sh: 'shell', bash: 'shell', zsh: 'shell',
}

/**
 * Derive the (best-effort) language from a filename's extension.
 * Returns null when the extension is unknown — callers then dim nothing.
 */
export function langForFilename(filename: string): CodeLang | null {
  const base = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null // no extension, or dotfile with no real ext
  const ext = base.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

// ---------------------------------------------------------------------------
// Import detection (line-leading, conservative)
// ---------------------------------------------------------------------------

// JS/TS: `import …`, `export … from …`, `const/let/var x = require(...)`.
const RE_JS_IMPORT = /^\s*import\b/
const RE_JS_EXPORT_FROM = /^\s*export\b[^;]*\bfrom\b/
const RE_JS_REQUIRE = /^\s*(?:const|let|var)\s+[^=]+=\s*require\s*\(/

// Python: `import …` / `from … import …`
const RE_PY_IMPORT = /^\s*import\s+\S/
const RE_PY_FROM = /^\s*from\s+\S+\s+import\b/

// Go: `import "…"`, `import (`, and lines inside an import block: `\t"pkg"` or
// `\talias "pkg"`. We keep the block-line case narrow: a quoted string that is
// the whole (trimmed) line, optionally with a leading identifier/dot/underscore.
const RE_GO_IMPORT = /^\s*import\s*[("]/
const RE_GO_IMPORT_BLOCK_LINE = /^\s*(?:[\w./]+\s+)?"[^"]+"\s*$/

// Java / Kotlin: `import a.b.C;` (Kotlin omits the semicolon)
const RE_JAVA_IMPORT = /^\s*import\s+[\w.*]+\s*;?\s*$/
const RE_KOTLIN_IMPORT = /^\s*import\s+[\w.*]+(?:\s+as\s+\w+)?\s*$/

// Rust: `use …;`, optionally `pub use …;`
const RE_RUST_USE = /^\s*(?:pub\s+)?use\s+\S/

// Ruby: `require '…'` / `require_relative '…'`
const RE_RB_REQUIRE = /^\s*require(?:_relative)?\s+['"]/

// CSS: `@import …`
const RE_CSS_IMPORT = /^\s*@import\b/

function isImportLine(text: string, lang: CodeLang): boolean {
  switch (lang) {
    case 'js':
      return RE_JS_IMPORT.test(text) || RE_JS_EXPORT_FROM.test(text) || RE_JS_REQUIRE.test(text)
    case 'python':
      return RE_PY_IMPORT.test(text) || RE_PY_FROM.test(text)
    case 'go':
      // Go import blocks: an opening `import (` or a quoted package line. We
      // only treat a bare quoted line as an import inside Go files — acceptable
      // because a standalone quoted string statement is vanishingly rare in Go.
      return RE_GO_IMPORT.test(text) || RE_GO_IMPORT_BLOCK_LINE.test(text)
    case 'java':
      return RE_JAVA_IMPORT.test(text)
    case 'kotlin':
      return RE_KOTLIN_IMPORT.test(text)
    case 'rust':
      return RE_RUST_USE.test(text)
    case 'ruby':
      return RE_RB_REQUIRE.test(text)
    case 'css':
      return RE_CSS_IMPORT.test(text)
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Comment detection (line-leading only, conservative)
// ---------------------------------------------------------------------------

// Languages with `//` line comments and `/* … */` block comments.
const SLASH_LANGS = new Set<CodeLang>(['js', 'go', 'java', 'kotlin', 'rust', 'css'])
// Languages with `#` line comments.
const HASH_LANGS = new Set<CodeLang>(['python', 'ruby', 'shell'])

function isCommentLine(text: string, lang: CodeLang): boolean {
  const trimmed = text.trimStart()
  if (trimmed === '') return false

  if (SLASH_LANGS.has(lang)) {
    // Line comment, block-comment open, or a block-comment continuation/close
    // line (` * …`, ` */`). The leading-` * ` form is the conventional jsdoc /
    // doc-comment body line; treating it as comment is safe and intentional.
    if (trimmed.startsWith('//')) return true
    if (trimmed.startsWith('/*')) return true
    if (trimmed.startsWith('*/')) return true
    if (trimmed.startsWith('*')) return true
  }

  if (HASH_LANGS.has(lang)) {
    // `#` line comment. (Shebangs `#!` are still comments visually.)
    if (trimmed.startsWith('#')) return true
  }

  if (lang === 'sql') {
    if (trimmed.startsWith('--')) return true
    if (trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*')) return true
  }

  if (lang === 'html') {
    if (trimmed.startsWith('<!--')) return true
  }

  return false
}

/**
 * Classify a single diff line's raw text for Focus-mode dimming.
 *
 * @param text raw source text of the line (without the +/- diff marker)
 * @param lang language derived from the filename, or null when unknown
 * @returns 'import' | 'comment' | null
 *
 * Imports take precedence over comments (an `import` line is never a comment),
 * but the two never genuinely collide for a single line.
 */
export function classifyNoise(text: string, lang: CodeLang | null): NoiseKind | null {
  if (lang === null) return null
  if (text.trim() === '') return null
  if (isImportLine(text, lang)) return 'import'
  if (isCommentLine(text, lang)) return 'comment'
  return null
}
