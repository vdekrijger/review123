/**
 * src/lib/symbols/symbolIndex.ts — Symbol index for the PR's files
 * (symbol click-through, Tiers 1 + 3).
 *
 * buildSymbolIndex(sources) scans ALL text available client-side for this PR —
 * full before/after file contents when they've been fetched (the same
 * contentsMap that powers context expansion), otherwise both sides of the raw
 * patch — and answers two questions per identifier:
 *
 *   definitionsOf(name) — where is this symbol DEFINED in the PR's files?
 *   referencesOf(name)  — every line that mentions it.
 *
 * Every occurrence is tagged with file, 1-based line, side ('old' | 'new'),
 * a one-line context snippet, and `inDiff` — whether that line is inside the
 * rendered patch hunks (jumpable in the diff view) or only known from the
 * fetched full contents (an unchanged region the diff doesn't show unless the
 * user expands context).
 *
 * TWO BACKENDS, ONE CONTRACT:
 *
 *   1. tree-sitter (treeSitter.ts) — syntax-aware definitions and identifier
 *      references from a real parse (WASM grammars for TS/TSX/JS/JSX, Python,
 *      Go, Ruby). Strings and comments can never produce references, and
 *      definitions come from AST node types, not line regexes. Used per file
 *      side whenever the grammar has finished loading; patch-only sides are
 *      parsed from a gap-filled per-side reconstruction (tree-sitter is
 *      error-tolerant, so imperfect fragments still yield identifiers).
 *
 *   2. heuristic (this file) — per-language regex rules, cheap single-line
 *      string/comment stripping, and a keyword stoplist. The fallback for
 *      unsupported languages (incl. .svelte/.vue), grammar load failures, and
 *      the window before grammars finish loading. symbolSources.ts invalidates
 *      its cached index when a grammar lands, so the next click upgrades.
 *
 * Both backends keep the same query-side rules: word identifiers only,
 * MIN_NAME_LEN, the keyword stoplist, definition lines excluded from
 * references, snippets capped, and the old-side deletion-only indexing rule.
 * Repo-wide search (repoSearch.ts, Tier 2) reuses this index over fetched
 * repo files — "not in the index" honestly means "not findable in the
 * available text".
 *
 * Pure + deterministic given the loaded grammars — no LLM, no network,
 * unit-testable (unit tests exercise the heuristic path by default and
 * install real WASM parsers explicitly in treeSitter.test.ts).
 */

import type { PrFile } from '../github/types'
import { langForFilename, type CodeLang } from '../diff/codeNoise'
import { patchLineNumbers } from '../diff/patchLines'
import { extractDocumentSymbols } from './treeSitter'

// ---------------------------------------------------------------------------
// Public interface (kept small so a tree-sitter backend can implement it)
// ---------------------------------------------------------------------------

export type DiffSide = 'old' | 'new'

export interface SymbolOccurrence {
  file: string
  /** 1-based line number, relative to `side`'s version of the file. */
  line: number
  side: DiffSide
  /** One-line trimmed context snippet (capped). */
  snippet: string
  /**
   * True when the line is part of the rendered patch hunks — a jump target the
   * diff view can scroll to. False for lines known only from fetched full
   * contents (unchanged regions collapsed between hunks).
   */
  inDiff: boolean
}

export type DefinitionKind = 'function' | 'class' | 'method' | 'variable' | 'type'

export interface SymbolDefinition extends SymbolOccurrence {
  name: string
  kind: DefinitionKind
}

export interface SymbolReference extends SymbolOccurrence {
  name: string
}

export interface SymbolIndex {
  definitionsOf(name: string): SymbolDefinition[]
  referencesOf(name: string): SymbolReference[]
  /** Whether `name` is a plausible symbol with a definition or ≥1 reference. */
  has(name: string): boolean
}

/** What the index needs to know about one PR file. */
export interface SymbolSource {
  filename: string
  status?: PrFile['status']
  /** Raw GitHub-style patch (bare hunks). Absent for binary/huge files. */
  patch?: string
  /** Fetched full before/after contents when available (contentsMap entry). */
  contents?: { before: string | null; after: string | null } | null
}

// ---------------------------------------------------------------------------
// Identifier + keyword rules
// ---------------------------------------------------------------------------

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*'
const IDENT_RE = new RegExp(`^${IDENT}$`)

/** Minimum name length the index answers for — 1-char names are too noisy. */
const MIN_NAME_LEN = 2

/**
 * Shared stoplist: words that are keywords/builtins in enough of the covered
 * languages that clicking them is never useful. Per-language additions below.
 */
const SHARED_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'switch',
  'case', 'default', 'try', 'catch', 'finally', 'throw', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'class', 'function', 'const', 'let',
  'var', 'void', 'null', 'undefined', 'true', 'false', 'this', 'super',
  'import', 'export', 'from', 'as', 'async', 'await', 'yield', 'static',
  'extends', 'implements', 'interface', 'type', 'enum', 'public', 'private',
  'protected', 'readonly', 'abstract', 'namespace', 'declare', 'module',
  'require', 'package', 'get', 'set', 'is', 'not', 'and', 'or', 'def', 'end',
  'begin', 'then', 'elif', 'except', 'lambda', 'pass', 'raise', 'with',
  'assert', 'global', 'nonlocal', 'del', 'func', 'chan', 'defer', 'select',
  'struct', 'range', 'fallthrough', 'go', 'map', 'nil', 'self', 'unless',
  'until', 'rescue', 'ensure', 'elsif', 'when', 'next', 'redo', 'retry',
  'alias', 'None', 'True', 'False',
])

const LANG_KEYWORDS: Partial<Record<CodeLang, Set<string>>> = {
  js: new Set(['debugger', 'satisfies', 'keyof', 'infer', 'never', 'unknown', 'any', 'string', 'number', 'boolean', 'object', 'symbol', 'bigint']),
  python: new Set(['print', 'len', 'str', 'int', 'float', 'bool', 'dict', 'list', 'tuple', 'set']),
  go: new Set(['string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'byte', 'rune', 'bool', 'float32', 'float64', 'error', 'len', 'cap', 'make', 'append', 'panic', 'recover', 'iota']),
  ruby: new Set(['puts', 'attr_accessor', 'attr_reader', 'attr_writer']),
}

function isStopword(name: string, lang: CodeLang | null): boolean {
  if (SHARED_KEYWORDS.has(name)) return true
  if (lang && LANG_KEYWORDS[lang]?.has(name)) return true
  return false
}

// ---------------------------------------------------------------------------
// Cheap single-line string/comment stripping
// ---------------------------------------------------------------------------

/** Languages using `//` line comments (of the ones we classify). */
const SLASH_COMMENT_LANGS = new Set<CodeLang>(['js', 'go', 'java', 'kotlin', 'rust', 'css'])
/** Languages using `#` line comments. */
const HASH_COMMENT_LANGS = new Set<CodeLang>(['python', 'ruby', 'shell'])

/**
 * Blank out string-literal interiors and cut line comments so identifier
 * matching doesn't fire inside `"computeTotal"` or `// computeTotal()`.
 * Single-line only (no cross-line comment/string state) — cheap by design;
 * a line inside an unclosed block comment may still produce references.
 * Length is preserved for string interiors (replaced by spaces).
 */
export function stripLiteralsAndComments(text: string, lang: CodeLang | null): string {
  const slash = lang === null || SLASH_COMMENT_LANGS.has(lang)
  const hash = lang === null || HASH_COMMENT_LANGS.has(lang)
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') {
        out += '  '
        i++
        continue
      }
      if (ch === quote) {
        quote = null
        out += ch
      } else {
        out += ' '
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (slash && ch === '/' && text[i + 1] === '/') break
    if (slash && ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close === -1) break
      out += ' '.repeat(close + 2 - i)
      i = close + 1
      continue
    }
    if (hash && ch === '#') break
    out += ch
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-language definition rules (heuristic — see module note)
// ---------------------------------------------------------------------------

interface DefMatch {
  name: string
  kind: DefinitionKind
}

const JS_FUNCTION_RE = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`)
const JS_CLASS_RE = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`)
const JS_CONST_FN_RE = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]*?)?=\\s*(?:async\\s+)?(?:\\(|function\\b|${IDENT}\\s*=>)`)
const JS_TYPE_RE = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum)\\s+(${IDENT})`)
const JS_METHOD_RE = new RegExp(`^(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?(${IDENT})\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{\\s*$`)

const PY_DEF_RE = new RegExp(`^(?:async\\s+)?def\\s+(${IDENT})`)
const PY_CLASS_RE = new RegExp(`^class\\s+(${IDENT})`)

const GO_METHOD_RE = new RegExp(`^func\\s+\\([^)]*\\)\\s+(${IDENT})`)
const GO_FUNC_RE = new RegExp(`^func\\s+(${IDENT})`)
const GO_TYPE_RE = new RegExp(`^type\\s+(${IDENT})\\s`)

const RB_DEF_RE = new RegExp(`^def\\s+(?:self\\.)?(${IDENT})`)
const RB_CLASS_RE = new RegExp(`^(?:class|module)\\s+(${IDENT})`)

/** Words a JS method-shorthand match must never claim (flow keywords). */
const JS_METHOD_BLOCKLIST = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor'])

function definitionOnLine(code: string, lang: CodeLang | null): DefMatch | null {
  const t = code.trim()
  if (t === '') return null
  switch (lang) {
    case 'js': {
      let m = JS_FUNCTION_RE.exec(t)
      if (m) return { name: m[1], kind: 'function' }
      m = JS_CLASS_RE.exec(t)
      if (m) return { name: m[1], kind: 'class' }
      m = JS_CONST_FN_RE.exec(t)
      if (m) return { name: m[1], kind: 'variable' }
      m = JS_TYPE_RE.exec(t)
      if (m) return { name: m[1], kind: 'type' }
      m = JS_METHOD_RE.exec(t)
      if (m && !JS_METHOD_BLOCKLIST.has(m[1])) return { name: m[1], kind: 'method' }
      return null
    }
    case 'python': {
      let m = PY_DEF_RE.exec(t)
      if (m) return { name: m[1], kind: 'function' }
      m = PY_CLASS_RE.exec(t)
      if (m) return { name: m[1], kind: 'class' }
      return null
    }
    case 'go': {
      let m = GO_METHOD_RE.exec(t)
      if (m) return { name: m[1], kind: 'method' }
      m = GO_FUNC_RE.exec(t)
      if (m) return { name: m[1], kind: 'function' }
      m = GO_TYPE_RE.exec(t)
      if (m) return { name: m[1], kind: 'type' }
      return null
    }
    case 'ruby': {
      let m = RB_DEF_RE.exec(t)
      if (m) return { name: m[1], kind: 'function' }
      m = RB_CLASS_RE.exec(t)
      if (m) return { name: m[1], kind: 'class' }
      return null
    }
    default:
      // Generic fallback: references only, no definition detection.
      return null
  }
}

// ---------------------------------------------------------------------------
// Patch walking (text per side)
// ---------------------------------------------------------------------------

interface PatchText {
  /** New-side line number → text (context + additions). */
  newLines: Map<number, string>
  /** Old-side line number → text for DELETION lines only. */
  oldDeletions: Map<number, string>
  /** Old-side line number → text (context + deletions) — for removed files. */
  oldAll: Map<number, string>
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function walkPatch(patch: string | undefined): PatchText {
  const out: PatchText = { newLines: new Map(), oldDeletions: new Map(), oldAll: new Map() }
  if (!patch) return out
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const h = HUNK_HEADER.exec(raw)
    if (h) {
      oldLine = parseInt(h[1], 10)
      newLine = parseInt(h[2], 10)
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      out.newLines.set(newLine, raw.slice(1))
      newLine++
    } else if (raw.startsWith('-')) {
      out.oldDeletions.set(oldLine, raw.slice(1))
      out.oldAll.set(oldLine, raw.slice(1))
      oldLine++
    } else if (raw === '\\ No newline at end of file') {
      // marker — ignore
    } else {
      out.newLines.set(newLine, raw.startsWith(' ') ? raw.slice(1) : raw)
      out.oldAll.set(oldLine, raw.startsWith(' ') ? raw.slice(1) : raw)
      oldLine++
      newLine++
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/**
 * Full-contents safety cap: a fetched file larger than this many lines falls
 * back to patch-only indexing so a giant generated file can't stall the UI.
 */
const MAX_FULL_CONTENT_LINES = 20_000

/** Snippet display cap (chars). */
const MAX_SNIPPET_CHARS = 160

interface IndexedLine {
  file: string
  side: DiffSide
  line: number
  /** Raw text (for the snippet). */
  raw: string
  /** String/comment-stripped text (for heuristic matching). */
  code: string
  lang: CodeLang | null
  inDiff: boolean
  /**
   * Identifier names the tree-sitter parse found on this line, or null when
   * this line was indexed by the heuristic backend (→ regex-match `code`).
   * An empty set means "parsed, and nothing identifier-like here" — e.g. a
   * line that only holds string/comment content.
   */
  idents: ReadonlySet<string> | null
}

/** Shared empty set for parsed lines without identifiers. */
const NO_IDENTS: ReadonlySet<string> = new Set()

function snippetOf(raw: string): string {
  const t = raw.trim()
  return t.length > MAX_SNIPPET_CHARS ? t.slice(0, MAX_SNIPPET_CHARS - 1) + '…' : t
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Line-number → text map for full file contents (already split). */
function contentsMap(contentLines: string[]): Map<number, string> {
  const m = new Map<number, string>()
  for (let i = 0; i < contentLines.length; i++) m.set(i + 1, contentLines[i])
  return m
}

/**
 * Rebuild one side's text from its patch line map (gaps between hunks become
 * empty lines) so the tree-sitter backend can parse it. Null when there's
 * nothing to parse or the side's line numbers exceed the safety cap.
 */
function reconstructSideText(map: ReadonlyMap<number, string>): string | null {
  let max = 0
  for (const n of map.keys()) if (n > max) max = n
  if (max === 0 || max > MAX_FULL_CONTENT_LINES) return null
  const arr = new Array<string>(max).fill('')
  for (const [n, text] of map) arr[n - 1] = text
  return arr.join('\n')
}

export function buildSymbolIndex(sources: SymbolSource[]): SymbolIndex {
  const lines: IndexedLine[] = []
  const definitions = new Map<string, SymbolDefinition[]>()
  /** "file|side|line" keys of lines that DEFINE a given name. */
  const defLineKeys = new Map<string, Set<string>>()

  function addDefinition(name: string, kind: DefinitionKind, file: string, side: DiffSide, line: number, raw: string, inDiff: boolean): void {
    const d: SymbolDefinition = { name, kind, file, side, line, snippet: snippetOf(raw), inDiff }
    const arr = definitions.get(name) ?? []
    arr.push(d)
    definitions.set(name, arr)
    const keys = defLineKeys.get(name) ?? new Set<string>()
    keys.add(`${file}|${side}|${line}`)
    defLineKeys.set(name, keys)
  }

  /**
   * Index one side of one file.
   *
   * `emit` is the set of lines this side actually indexes (line → raw text) —
   * e.g. deletions only, for the old side of a modified file. `parseText` is
   * the side's full text for the tree-sitter backend; it may cover MORE lines
   * than `emit` (old-side context improves the parse but is never emitted —
   * it's byte-identical to its already-indexed new-side counterpart).
   * `inDiffLines` is hunk membership; null means every emitted line is part
   * of the rendered diff. Falls back to the heuristic when the tree-sitter
   * backend can't answer (unsupported lang / grammar not loaded / parse threw).
   */
  function indexSide(
    file: string,
    side: DiffSide,
    lang: CodeLang | null,
    emit: ReadonlyMap<number, string>,
    parseText: string | null,
    inDiffLines: ReadonlySet<number> | null,
  ): void {
    if (emit.size === 0) return
    const inDiffFor = (n: number): boolean => inDiffLines === null || inDiffLines.has(n)

    const extracted = parseText !== null ? extractDocumentSymbols(file, parseText) : null
    if (extracted) {
      for (const [n, raw] of emit) {
        lines.push({ file, side, line: n, raw, code: '', lang, inDiff: inDiffFor(n), idents: extracted.identifiersByLine.get(n) ?? NO_IDENTS })
      }
      for (const def of extracted.definitions) {
        const raw = emit.get(def.line)
        if (raw === undefined) continue // non-emitted line (e.g. old-side context)
        addDefinition(def.name, def.kind, file, side, def.line, raw, inDiffFor(def.line))
      }
      return
    }

    for (const [n, raw] of emit) {
      const code = stripLiteralsAndComments(raw, lang)
      lines.push({ file, side, line: n, raw, code, lang, inDiff: inDiffFor(n), idents: null })
      const def = definitionOnLine(code, lang)
      if (def) addDefinition(def.name, def.kind, file, side, n, raw, inDiffFor(n))
    }
  }

  for (const src of sources) {
    const lang = langForFilename(src.filename)
    const patchText = walkPatch(src.patch)

    if (src.status === 'removed') {
      // Removed file: only the old side exists. Prefer full "before" contents.
      const before = src.contents?.before ?? null
      const beforeLines = before !== null ? before.split('\n') : null
      if (before !== null && beforeLines && beforeLines.length <= MAX_FULL_CONTENT_LINES) {
        indexSide(src.filename, 'old', lang, contentsMap(beforeLines), before, patchLineNumbers(src.patch, 'LEFT'))
      } else {
        indexSide(src.filename, 'old', lang, patchText.oldAll, reconstructSideText(patchText.oldAll), null)
      }
      continue
    }

    // NEW side — the primary text. Full "after" contents when available,
    // otherwise the patch's new-side lines (context + additions).
    const after = src.contents?.after ?? null
    const afterLines = after !== null ? after.split('\n') : null
    if (after !== null && afterLines && afterLines.length <= MAX_FULL_CONTENT_LINES) {
      indexSide(src.filename, 'new', lang, contentsMap(afterLines), after, patchLineNumbers(src.patch, 'RIGHT'))
    } else {
      indexSide(src.filename, 'new', lang, patchText.newLines, reconstructSideText(patchText.newLines), null)
    }

    // OLD side — only DELETION lines are emitted. Old-side context is
    // byte-identical to its new-side counterpart (already indexed above);
    // re-indexing it would double-report every reference in an unchanged
    // region. The parse still sees context (oldAll) for a better tree.
    indexSide(src.filename, 'old', lang, patchText.oldDeletions, reconstructSideText(patchText.oldAll), null)
  }

  const refMemo = new Map<string, SymbolReference[]>()

  function referencesOf(name: string): SymbolReference[] {
    const memo = refMemo.get(name)
    if (memo) return memo
    if (!IDENT_RE.test(name) || name.length < MIN_NAME_LEN || SHARED_KEYWORDS.has(name)) {
      refMemo.set(name, [])
      return []
    }
    const word = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`)
    const defKeys = defLineKeys.get(name)
    const refs: SymbolReference[] = []
    for (const l of lines) {
      if (isStopword(name, l.lang)) continue
      // Parsed lines carry their identifier set (strings/comments excluded by
      // the grammar); heuristic lines fall back to the word-boundary regex.
      if (l.idents !== null ? !l.idents.has(name) : !word.test(l.code)) continue
      if (defKeys?.has(`${l.file}|${l.side}|${l.line}`)) continue
      refs.push({ name, file: l.file, side: l.side, line: l.line, snippet: snippetOf(l.raw), inDiff: l.inDiff })
    }
    refMemo.set(name, refs)
    return refs
  }

  function definitionsOf(name: string): SymbolDefinition[] {
    return definitions.get(name) ?? []
  }

  function has(name: string): boolean {
    if (!IDENT_RE.test(name) || name.length < MIN_NAME_LEN) return false
    if (SHARED_KEYWORDS.has(name)) return false
    if (definitions.has(name)) return true
    return referencesOf(name).length > 0
  }

  return { definitionsOf, referencesOf, has }
}
