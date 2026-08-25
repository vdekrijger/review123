/**
 * src/lib/symbols/symbolSources.ts — Shared registry of the PR files whose
 * text feeds the symbol index (symbol click-through, Tier 1).
 *
 * Why a registry: each FileDiff instance only knows ITS OWN file, but symbol
 * navigation must see the whole PR (definition in one file, call points in
 * others). Every mounted FileDiff registers its file's text here (patch +
 * fetched full contents when available) and unregisters on unmount, so the
 * registry always mirrors the currently rendered review — no prop threading
 * through InspectStep required.
 *
 * Ref-counted per filename: Story mode can mount the same file in two places
 * (primary slide diff + related-test snippet); the source must survive until
 * the LAST instance unmounts. Re-registering the same filename (e.g. after
 * full contents arrive) refreshes the stored source.
 *
 * The built index is cached and invalidated on any registry change; it is
 * (re)built lazily on the next lookup — clicks are rare, mounts are not.
 *
 * Registration also kicks off the lazy tree-sitter backend (fire-and-forget,
 * per language actually present in the review — never at app startup), and
 * the cache is invalidated when a grammar finishes loading, so the NEXT
 * symbol click rebuilds with tree-sitter accuracy. Until then the heuristic
 * backend answers.
 */

import { buildSymbolIndex, type SymbolIndex, type SymbolSource } from './symbolIndex'
import { initTreeSitterBackend, onBackendUpgraded, treeSitterLangForFilename } from './treeSitter'

const entries = new Map<string, { count: number; source: SymbolSource }>()
let cached: SymbolIndex | null = null

// A grammar finished loading → any cached index may have been built on the
// heuristic. Drop it; the next lookup rebuilds syntax-aware.
onBackendUpgraded(() => {
  cached = null
})

/** Register (or refresh) a file's text. Pair every call with an unregister. */
export function registerSymbolSource(source: SymbolSource): void {
  // Fire-and-forget grammar load for this file's language (lazy + idempotent;
  // no-op for unsupported languages). Skipped under vitest: jsdom can't fetch
  // wasm, and the unit suites must stay deterministic on the heuristic path —
  // treeSitter.test.ts installs real parsers explicitly instead.
  const tsLang = treeSitterLangForFilename(source.filename)
  if (tsLang && import.meta.env.MODE !== 'test') void initTreeSitterBackend([tsLang])
  const existing = entries.get(source.filename)
  entries.set(source.filename, { count: (existing?.count ?? 0) + 1, source })
  cached = null
}

/** Drop one registration for `filename`; the source survives until count 0. */
export function unregisterSymbolSource(filename: string): void {
  const existing = entries.get(filename)
  if (!existing) return
  if (existing.count <= 1) entries.delete(filename)
  else existing.count -= 1
  cached = null
}

/**
 * The filenames currently registered (i.e. the PR files rendered in this
 * review). Repo search (Tier 2) excludes these from its results — call points
 * inside the PR's own files are already listed by the Tier 1 index.
 */
export function registeredSymbolFilenames(): Set<string> {
  return new Set(entries.keys())
}

/**
 * The registered source for one file, or null when it isn't rendered. The
 * symbol popover's definition peek reads from this — the SAME text the index
 * was built on (see lib/symbols/definitionPeek.ts).
 */
export function symbolSourceFor(filename: string): SymbolSource | null {
  return entries.get(filename)?.source ?? null
}

/** The symbol index over all currently registered files (lazily rebuilt). */
export function currentSymbolIndex(): SymbolIndex {
  if (!cached) {
    cached = buildSymbolIndex([...entries.values()].map((e) => e.source))
  }
  return cached
}

/** Test-only: clear all registrations and the cached index. */
export function _resetSymbolSourcesForTest(): void {
  entries.clear()
  cached = null
}
