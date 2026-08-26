/**
 * src/lib/ai/outcomeTests.ts — Deterministic outcome↔test cross-reference.
 *
 * Each expected-outcome claim carries the changed SYMBOLS it hinges on
 * (ExpectedOutcomesResult.outcomes[].symbols — named by the LLM, which is
 * instructed to list bare changed function/class names). This module resolves
 * those symbols against the PR's changed TEST FILE contents through the #95
 * symbol↔test pairing machinery (src/lib/diff/symbolTests.ts) — so the
 * "✓ asserted by X.test.ts" chip is DETERMINISTIC post-processing: the LLM
 * never guesses test names, and an outcome with no matching test gets the
 * honest "no test asserts this outcome" state.
 *
 * Conservative by inheritance (pairSymbolsWithTests): whole-word matches only,
 * symbols shorter than 3 chars refused, no match → omitted. Confidence labels
 * follow #95: 'named' (symbol appears in a test TITLE) beats 'referenced'
 * (called/imported only — rendered with the "likely" qualifier).
 *
 * Pure — no LLM, no network. Test file contents come from the app's already
 * fetched full-file contents (the Review route's contentsMap).
 */

import { pairSymbolsWithTests, type TestFileContent, type PairingConfidence } from '../diff/symbolTests'
import type { ChangedSymbol } from '../diff/symbols'

export type { TestFileContent }

/** One test that asserts (part of) an outcome claim. */
export interface OutcomeTestRef {
  testFile: string
  /** 'named' = symbol in a test title; 'referenced' = used in the test only. */
  confidence: PairingConfidence
  /** The test title when the symbol was named in one. */
  title?: string
  /** 1-based inclusive line range of the matched test block. */
  lineRange: { start: number; end: number }
}

/** Cap on refs shown per outcome — the lead evidence, not an inventory. */
export const OUTCOME_TEST_REFS_MAX = 3

/**
 * Resolve one outcome claim's symbols against the PR's changed test files.
 *
 * Returns the matched tests deduped BY TEST FILE (an outcome usually names
 * several symbols that live in the same test file — one chip per file, keeping
 * the highest-confidence match), 'named' matches first, capped at
 * OUTCOME_TEST_REFS_MAX. Empty when the claim names no symbols, no test
 * contents are available, or nothing matches — the caller renders the honest
 * "no test asserts this outcome" state.
 */
export function matchOutcomeTests(
  symbols: string[],
  testContents: TestFileContent[],
): OutcomeTestRef[] {
  const cleaned = [...new Set(symbols.map((s) => s.trim()).filter((s) => s.length > 0))]
  if (cleaned.length === 0 || testContents.length === 0) return []

  // pairSymbolsWithTests only matches on `symbol`; implFile/lineRange are
  // echoed into its output (which we discard), so placeholders are safe here.
  const changed: ChangedSymbol[] = cleaned.map((symbol) => ({
    symbol,
    file: '',
    lineRange: { start: 0, end: 0 },
  }))

  const pairings = pairSymbolsWithTests(changed, testContents)

  // Dedupe by test file, keeping the highest-confidence ref per file.
  const byFile = new Map<string, OutcomeTestRef>()
  for (const p of pairings) {
    for (const t of p.tests) {
      const existing = byFile.get(t.testFile)
      if (existing && (existing.confidence === 'named' || t.confidence !== 'named')) continue
      byFile.set(t.testFile, {
        testFile: t.testFile,
        confidence: t.confidence,
        ...(t.title !== undefined ? { title: t.title } : {}),
        lineRange: t.lineRange,
      })
    }
  }

  const out = [...byFile.values()]
  // Named first; stable within each confidence group (insertion order).
  out.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'named' ? -1 : 1))
  return out.slice(0, OUTCOME_TEST_REFS_MAX)
}
