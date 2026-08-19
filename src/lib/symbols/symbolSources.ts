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
 */

import { buildSymbolIndex, type SymbolIndex, type SymbolSource } from './symbolIndex'

const entries = new Map<string, { count: number; source: SymbolSource }>()
let cached: SymbolIndex | null = null

/** Register (or refresh) a file's text. Pair every call with an unregister. */
export function registerSymbolSource(source: SymbolSource): void {
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
