/**
 * src/lib/symbols/treeSitter.ts — tree-sitter WASM backend for the symbol
 * index (symbol click-through, Tier 3).
 *
 * The symbol index (symbolIndex.ts) is synchronous by contract, but loading
 * WASM grammars is async. This module is the bridge:
 *
 *   initTreeSitterBackend(langs?) — lazy, idempotent, fire-and-forget. Dynamic-
 *     imports web-tree-sitter and loads the requested grammars' .wasm (all of
 *     them by default) via Vite `?url` asset imports, so the main bundle stays
 *     lean and wasm only ever loads on demand. Kicked off from the symbol-
 *     source registration path (the first time a review renders a file of a
 *     supported language) — NOT at app startup. Load failures are logged and
 *     swallowed: the heuristic backend simply keeps answering.
 *
 *   extractDocumentSymbols(filename, text) — SYNCHRONOUS. Once a grammar is
 *     loaded, parsing is synchronous in web-tree-sitter, so buildSymbolIndex
 *     can call this inline. Returns null when the language is unsupported,
 *     its grammar hasn't finished loading, or the parse throws — the caller
 *     then falls back to the heuristic path.
 *
 *   onBackendUpgraded(cb) — fired whenever a grammar becomes available.
 *     symbolSources.ts subscribes to invalidate its cached index, so the next
 *     symbol click rebuilds with tree-sitter accuracy.
 *
 * Supported grammars: TypeScript, TSX, JavaScript/JSX, Python, Go, Ruby —
 * the same languages the heuristic has definition rules for. Svelte/Vue
 * single-file components deliberately stay on the heuristic (their mixed
 * markup defeats a plain TS parse); so does everything else.
 *
 * Grammar .wasm files come from the OFFICIAL per-grammar npm packages
 * (tree-sitter-typescript etc.), which ship prebuilt binaries compatible with
 * the pinned web-tree-sitter runtime — no build-time emscripten step. Their
 * native-binding install scripts are unused and intentionally not run.
 */

import type { DefinitionKind } from './symbolIndex'

// WASM asset URLs. `?url` emits each file as a static asset and inlines only
// the URL string — the binaries are fetched lazily by initTreeSitterBackend.
import coreWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import typescriptWasmUrl from 'tree-sitter-typescript/tree-sitter-typescript.wasm?url'
import tsxWasmUrl from 'tree-sitter-typescript/tree-sitter-tsx.wasm?url'
import javascriptWasmUrl from 'tree-sitter-javascript/tree-sitter-javascript.wasm?url'
import pythonWasmUrl from 'tree-sitter-python/tree-sitter-python.wasm?url'
import goWasmUrl from 'tree-sitter-go/tree-sitter-go.wasm?url'
import rubyWasmUrl from 'tree-sitter-ruby/tree-sitter-ruby.wasm?url'

// ---------------------------------------------------------------------------
// Language mapping (finer-grained than codeNoise's CodeLang: ts ≠ tsx ≠ js)
// ---------------------------------------------------------------------------

export type TreeSitterLang = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'ruby'

const ALL_LANGS: readonly TreeSitterLang[] = ['typescript', 'tsx', 'javascript', 'python', 'go', 'ruby']

const EXT_TO_TS_LANG: Record<string, TreeSitterLang> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go',
  rb: 'ruby',
}

/**
 * The grammar for a filename, or null when the file stays on the heuristic
 * backend (unsupported language — including .svelte/.vue, whose mixed markup
 * a plain TS grammar can't parse honestly).
 */
export function treeSitterLangForFilename(filename: string): TreeSitterLang | null {
  const base = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return EXT_TO_TS_LANG[base.slice(dot + 1).toLowerCase()] ?? null
}

// ---------------------------------------------------------------------------
// Minimal structural view of web-tree-sitter's Tree/Node (keeps the extractor
// decoupled from the library's concrete classes and stubbable in tests)
// ---------------------------------------------------------------------------

export interface TSNodeLike {
  type: string
  text: string
  startPosition: { row: number }
  namedChildCount: number
  namedChild(index: number): TSNodeLike | null
  childForFieldName(fieldName: string): TSNodeLike | null
  parent: TSNodeLike | null
}

export interface TSTreeLike {
  rootNode: TSNodeLike
  /** web-tree-sitter trees hold wasm memory — freed after extraction. */
  delete?: () => void
}

export type TreeSitterParse = (text: string) => TSTreeLike | null

// ---------------------------------------------------------------------------
// Loaded-grammar registry + upgrade notifications
// ---------------------------------------------------------------------------

const parsers = new Map<TreeSitterLang, TreeSitterParse>()
const upgradeListeners = new Set<() => void>()

/**
 * Subscribe to "a grammar just became available" — the moment cached indexes
 * built on the heuristic go stale. Returns an unsubscribe function.
 */
export function onBackendUpgraded(cb: () => void): () => void {
  upgradeListeners.add(cb)
  return () => upgradeListeners.delete(cb)
}

function notifyUpgraded(): void {
  for (const cb of [...upgradeListeners]) cb()
}

// ---------------------------------------------------------------------------
// Lazy init (dynamic import + wasm fetch; per-grammar memoization)
// ---------------------------------------------------------------------------

const GRAMMAR_WASM_URLS: Record<TreeSitterLang, string> = {
  typescript: typescriptWasmUrl,
  tsx: tsxWasmUrl,
  javascript: javascriptWasmUrl,
  python: pythonWasmUrl,
  go: goWasmUrl,
  ruby: rubyWasmUrl,
}

type WebTreeSitterModule = typeof import('web-tree-sitter')

let corePromise: Promise<WebTreeSitterModule | null> | null = null
const grammarPromises = new Map<TreeSitterLang, Promise<void>>()

function loadCore(): Promise<WebTreeSitterModule | null> {
  if (!corePromise) {
    corePromise = (async () => {
      const mod = await import('web-tree-sitter')
      await mod.Parser.init({ locateFile: () => coreWasmUrl })
      return mod
    })().catch((err) => {
      console.warn('[symbols] tree-sitter runtime failed to load — heuristic backend stays active', err)
      return null
    })
  }
  return corePromise
}

function loadGrammar(lang: TreeSitterLang): Promise<void> {
  let p = grammarPromises.get(lang)
  if (!p) {
    p = (async () => {
      const mod = await loadCore()
      if (!mod) return
      const language = await mod.Language.load(GRAMMAR_WASM_URLS[lang])
      const parser = new mod.Parser()
      parser.setLanguage(language)
      parsers.set(lang, (text) => parser.parse(text))
      notifyUpgraded()
    })().catch((err) => {
      console.warn(`[symbols] tree-sitter grammar '${lang}' failed to load — heuristic fallback for it`, err)
    })
    grammarPromises.set(lang, p)
  }
  return p
}

/**
 * Load the tree-sitter runtime + the given grammars (all supported ones by
 * default). Lazy and idempotent per grammar; never rejects — failures are
 * logged and the heuristic backend keeps answering. Callers fire-and-forget.
 */
export function initTreeSitterBackend(langs: readonly TreeSitterLang[] = ALL_LANGS): Promise<void> {
  return Promise.all(langs.map(loadGrammar)).then(() => undefined)
}

// ---------------------------------------------------------------------------
// Extraction: AST → definitions + identifier occurrences per line
// ---------------------------------------------------------------------------

/** Same identifier shape the heuristic index accepts. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export interface ExtractedDefinition {
  name: string
  kind: DefinitionKind
  /** 1-based line of the definition's NAME node. */
  line: number
}

export interface ExtractedSymbols {
  definitions: ExtractedDefinition[]
  /** 1-based line → identifier names appearing on it (strings/comments never do). */
  identifiersByLine: Map<number, Set<string>>
}

/** Node types that ARE identifiers (per grammar family). */
const JS_IDENT_TYPES = new Set([
  'identifier',
  'property_identifier',
  'type_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'statement_identifier',
])
const IDENT_NODE_TYPES: Record<TreeSitterLang, Set<string>> = {
  typescript: JS_IDENT_TYPES,
  tsx: JS_IDENT_TYPES,
  javascript: JS_IDENT_TYPES,
  python: new Set(['identifier']),
  go: new Set(['identifier', 'type_identifier', 'field_identifier', 'package_identifier']),
  ruby: new Set(['identifier', 'constant']),
}

/** JS value node types that make a `const x = …` a function-ish definition. */
const JS_FN_VALUE_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function'])

function nameOf(node: TSNodeLike, kind: DefinitionKind): { nameNode: TSNodeLike; kind: DefinitionKind } | null {
  const nameNode = node.childForFieldName('name')
  return nameNode ? { nameNode, kind } : null
}

/** Is `node` (a def) nested inside a class/module scope (nearest wins)? */
function nestedInClass(node: TSNodeLike, classTypes: readonly string[], fnTypes: readonly string[]): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (classTypes.includes(p.type)) return true
    if (fnTypes.includes(p.type)) return false
  }
  return false
}

function definitionAt(node: TSNodeLike, lang: TreeSitterLang): { nameNode: TSNodeLike; kind: DefinitionKind } | null {
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      switch (node.type) {
        case 'function_declaration':
        case 'generator_function_declaration':
        case 'function_signature':
          return nameOf(node, 'function')
        case 'class_declaration':
        case 'abstract_class_declaration':
          return nameOf(node, 'class')
        case 'method_definition':
        case 'method_signature':
        case 'abstract_method_signature': {
          const found = nameOf(node, 'method')
          // `constructor` is never a useful click target (same rule as the
          // heuristic's method blocklist) — the class definition covers it.
          return found && found.nameNode.text !== 'constructor' ? found : null
        }
        case 'interface_declaration':
        case 'type_alias_declaration':
        case 'enum_declaration':
          return nameOf(node, 'type')
        case 'variable_declarator': {
          const value = node.childForFieldName('value')
          return value && JS_FN_VALUE_TYPES.has(value.type) ? nameOf(node, 'variable') : null
        }
        case 'public_field_definition': {
          // Class-property arrow fns (`handleClick = () => {}`) are methods.
          const value = node.childForFieldName('value')
          return value && JS_FN_VALUE_TYPES.has(value.type) ? nameOf(node, 'method') : null
        }
        default:
          return null
      }
    case 'python':
      switch (node.type) {
        case 'function_definition':
          return nameOf(node, nestedInClass(node, ['class_definition'], ['function_definition']) ? 'method' : 'function')
        case 'class_definition':
          return nameOf(node, 'class')
        default:
          return null
      }
    case 'go':
      switch (node.type) {
        case 'function_declaration':
          return nameOf(node, 'function')
        case 'method_declaration':
          return nameOf(node, 'method')
        case 'type_spec':
        case 'type_alias':
          return nameOf(node, 'type')
        default:
          return null
      }
    case 'ruby':
      switch (node.type) {
        case 'method':
        case 'singleton_method':
          return nameOf(node, nestedInClass(node, ['class', 'module'], ['method', 'singleton_method']) ? 'method' : 'function')
        case 'class':
        case 'module': {
          // `class Foo::Bar` names a scope_resolution — the leaf constant is
          // the clickable identifier.
          let nameNode = node.childForFieldName('name')
          if (nameNode?.type === 'scope_resolution') nameNode = nameNode.childForFieldName('name')
          return nameNode ? { nameNode, kind: 'class' } : null
        }
        default:
          return null
      }
  }
}

function extractFromTree(root: TSNodeLike, lang: TreeSitterLang): ExtractedSymbols {
  const identTypes = IDENT_NODE_TYPES[lang]
  const definitions: ExtractedDefinition[] = []
  const identifiersByLine = new Map<number, Set<string>>()
  // Iterative DFS (explicit stack): deeply nested real-world files must not
  // blow the call stack. Children are pushed in reverse so visit order stays
  // source order — definitions come out top-to-bottom like the heuristic's.
  const stack: TSNodeLike[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (identTypes.has(node.type)) {
      const name = node.text
      if (IDENT_RE.test(name)) {
        const line = node.startPosition.row + 1
        let set = identifiersByLine.get(line)
        if (!set) {
          set = new Set()
          identifiersByLine.set(line, set)
        }
        set.add(name)
      }
    } else {
      const def = definitionAt(node, lang)
      if (def && IDENT_RE.test(def.nameNode.text)) {
        definitions.push({ name: def.nameNode.text, kind: def.kind, line: def.nameNode.startPosition.row + 1 })
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i)
      if (child) stack.push(child)
    }
  }
  return { definitions, identifiersByLine }
}

/**
 * Parse `text` as `filename`'s language and extract definitions + per-line
 * identifier occurrences. SYNCHRONOUS — safe to call from buildSymbolIndex.
 * Returns null (→ heuristic fallback) when the language is unsupported, its
 * grammar hasn't loaded yet, or the parse throws. Error-tolerant otherwise:
 * reconstructed patch fragments parse with ERROR nodes but still yield
 * identifiers, which is exactly what we want.
 */
export function extractDocumentSymbols(filename: string, text: string): ExtractedSymbols | null {
  const lang = treeSitterLangForFilename(filename)
  if (!lang) return null
  const parse = parsers.get(lang)
  if (!parse) return null
  let tree: TSTreeLike | null = null
  try {
    tree = parse(text)
    if (!tree) return null
    return extractFromTree(tree.rootNode, lang)
  } catch {
    return null
  } finally {
    tree?.delete?.()
  }
}

// ---------------------------------------------------------------------------
// Test-only hooks
// ---------------------------------------------------------------------------

/** Test-only: install a parser (real or stub) and fire the upgrade hook. */
export function _installTreeSitterParserForTest(lang: TreeSitterLang, parse: TreeSitterParse): void {
  parsers.set(lang, parse)
  notifyUpgraded()
}

/** Test-only: drop all loaded parsers and init memoization. */
export function _resetTreeSitterForTest(): void {
  parsers.clear()
  grammarPromises.clear()
  corePromise = null
}
