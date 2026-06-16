/**
 * src/lib/demo/fixture.ts — the bundled example PR for the "Try a live demo"
 * onboarding path (no API key, no auth, no network).
 *
 * This is a small, honest, self-contained example: a plausible little bugfix
 * that adds debounce + cancellation to a search box. The diffs are real
 * (hand-written unified-diff hunks), and the AI results are PRE-GENERATED to
 * match the real schema types so the actual review components render them
 * exactly as they would for a live PR. Everything here is illustrative and
 * clearly labelled as a demo in the UI — nothing is fabricated to mislead.
 */

import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type {
  AttentionResult,
  VerdictResult,
  TestInsight,
  SkillReviewResult,
} from '../ai/schemas'

/** Stable local-storage key for the demo's draft / viewed / decision stores. */
export const DEMO_PR_KEY = 'demo:acme/web-app#42@demo-head'

/** Fixture PR identity (used by the demo route + ContextRail meta). */
export const demoMeta: PrMeta = {
  title: 'Debounce the search box and cancel stale requests',
  state: 'open',
  merged: false,
  body:
    'The search box fired a request on every keystroke and rendered whichever ' +
    'response arrived last — so a slow early request could overwrite a newer ' +
    'one. This debounces input (250ms) and aborts the previous request before ' +
    'starting a new one, so the visible results always match the latest query.',
  baseSha: 'a1b2c3d0000000000000000000000000000base',
  headSha: 'd4e5f6a0000000000000000000000000000head',
  private: false,
  changedFiles: 2,
  authorLogin: 'demo-dev',
}

/**
 * CI summary for the demo: an explicit "no CI configured" (total 0). Passing a
 * settled CI object — rather than null — keeps the CI panel out of its loading
 * (aria-busy) skeleton: the demo shows zero pending UI.
 */
export const demoCi: CiSummary = {
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
  failures: [],
}

/**
 * Two changed files with believable unified-diff patches. The first is the
 * fix; the second is its test. Patch line counts match the additions/deletions.
 */
export const demoFiles: PrFile[] = [
  {
    filename: 'src/search/useSearch.ts',
    status: 'modified',
    additions: 18,
    deletions: 5,
    patch: `@@ -1,14 +1,27 @@
 import { useState, useEffect, useRef } from 'react'
 import { fetchResults, type Result } from './api'

+const DEBOUNCE_MS = 250
+
 export function useSearch(query: string): Result[] {
   const [results, setResults] = useState<Result[]>([])
+  const controllerRef = useRef<AbortController | null>(null)

   useEffect(() => {
-    if (query === '') {
-      setResults([])
-      return
-    }
-    fetchResults(query).then(setResults)
-  }, [query])
+    if (query === '') {
+      setResults([])
+      return
+    }
+    const handle = setTimeout(() => {
+      // Cancel any in-flight request so a slow earlier response can't
+      // overwrite the results for the query the user is actually looking at.
+      controllerRef.current?.abort()
+      const controller = new AbortController()
+      controllerRef.current = controller
+      fetchResults(query, controller.signal)
+        .then(setResults)
+        .catch((err) => {
+          if (err.name !== 'AbortError') throw err
+        })
+    }, DEBOUNCE_MS)
+    return () => clearTimeout(handle)
+  }, [query])

   return results
 }`,
  },
  {
    filename: 'src/search/useSearch.test.ts',
    status: 'modified',
    additions: 22,
    deletions: 0,
    patch: `@@ -40,6 +40,28 @@ describe('useSearch', () => {
     await waitFor(() => expect(result.current).toEqual(rows))
   })

+  it('debounces rapid keystrokes into a single request', async () => {
+    const fetchSpy = vi.spyOn(api, 'fetchResults').mockResolvedValue([])
+    const { rerender } = renderHook(({ q }) => useSearch(q), {
+      initialProps: { q: 'r' },
+    })
+    rerender({ q: 're' })
+    rerender({ q: 'rea' })
+    rerender({ q: 'react' })
+    await act(() => vi.advanceTimersByTimeAsync(250))
+    expect(fetchSpy).toHaveBeenCalledTimes(1)
+    expect(fetchSpy).toHaveBeenLastCalledWith('react', expect.any(AbortSignal))
+  })
+
+  it('aborts the previous request when the query changes', async () => {
+    const aborted: boolean[] = []
+    vi.spyOn(api, 'fetchResults').mockImplementation((_q, signal) => {
+      signal?.addEventListener('abort', () => aborted.push(true))
+      return new Promise(() => {})
+    })
+    const { rerender } = renderHook(({ q }) => useSearch(q), { initialProps: { q: 'a' } })
+    await act(() => vi.advanceTimersByTimeAsync(250))
+    rerender({ q: 'ab' })
+    await act(() => vi.advanceTimersByTimeAsync(250))
+    expect(aborted).toContain(true)
+  })
+
   it('clears results for an empty query', async () => {
     const { result } = renderHook(() => useSearch(''))
     expect(result.current).toEqual([])`,
  },
]

/**
 * Pre-generated summary. The ===READING-ORDER=== sentinel block is parsed by
 * parseReadingOrder() (and stripped for display by stripReadingOrder()) exactly
 * as a live summary would be.
 */
export const demoSummary = `This PR fixes a race condition in the search box. Previously \`useSearch\` fired a request on every keystroke and rendered whichever response resolved last, so a slow early request could clobber the results for a newer query.

The fix introduces a **250ms debounce** so rapid typing collapses into a single request, and an **AbortController** so the previous in-flight request is cancelled before a new one starts. \`AbortError\` is swallowed; any other error still propagates. The effect's cleanup clears the pending timeout, so unmounting mid-type can't fire a stray request.

Two focused tests cover the new behaviour: one asserts rapid keystrokes debounce to a single call with the latest query, the other asserts the prior request is aborted when the query changes.

===READING-ORDER===
src/search/useSearch.ts
src/search/useSearch.test.ts
===END===`

/** Pre-generated hotspots + test flags (AttentionResult schema). */
export const demoAttention: AttentionResult = {
  readingOrder: ['src/search/useSearch.ts', 'src/search/useSearch.test.ts'],
  hotspots: [
    {
      path: 'src/search/useSearch.ts',
      reason:
        'Core of the change — debounce timer + AbortController lifecycle. Check the cleanup clears the timeout and the abort runs before the next fetch.',
      level: 'high',
    },
    {
      path: 'src/search/useSearch.test.ts',
      reason:
        'New tests drive the debounce + abort behaviour with fake timers — the best place to confirm the intended semantics are actually pinned down.',
      level: 'medium',
    },
  ],
  testFlags: [
    {
      path: 'src/search/useSearch.test.ts',
      note: 'New tests use fake timers — make sure advanceTimersByTimeAsync matches the 250ms debounce constant.',
    },
  ],
}

/** Pre-generated verdict (VerdictResult schema). */
export const demoVerdict: VerdictResult = {
  level: 'minor-changes',
  evidence: [
    'Adds a 250ms debounce in useSearch so rapid keystrokes collapse to one request (src/search/useSearch.ts).',
    'Aborts the previous in-flight request via AbortController before starting a new one, fixing the stale-response overwrite.',
    'Swallows AbortError but re-throws other errors, so cancellation is silent while real failures still surface.',
    'Effect cleanup clears the pending timeout, preventing a stray request after unmount or a fast follow-up keystroke.',
  ],
  notAnalyzed: [
    'src/search/api.ts — fetchResults must accept and honour the AbortSignal; not shown in this diff.',
  ],
}

/** Pre-generated test insight (TestInsight schema). */
export const demoTests: TestInsight = {
  covered: [
    {
      behavior: 'Rapid keystrokes debounce into a single request for the latest query',
      test: 'debounces rapid keystrokes into a single request',
      file: 'src/search/useSearch.test.ts',
    },
    {
      behavior: 'The previous request is aborted when the query changes',
      test: 'aborts the previous request when the query changes',
      file: 'src/search/useSearch.test.ts',
    },
  ],
  gaps: [
    'No test asserts that a non-AbortError from fetchResults still propagates.',
    'No test covers the cleanup path when the component unmounts before the debounce fires.',
  ],
}

/** Pre-generated skill-reviewer findings — varied severity (SkillReviewResult schema). */
export const demoSkillFindings: SkillReviewResult = {
  skillName: 'Correctness & race conditions',
  findings: [
    {
      path: 'src/search/useSearch.ts',
      line: 22,
      severity: 'medium',
      body: 'fetchResults is called with the AbortSignal, but this diff does not show src/search/api.ts honouring it. If fetchResults ignores the signal, abort() will not actually cancel the network request — verify the signal is forwarded to fetch().',
    },
    {
      path: 'src/search/useSearch.ts',
      line: 27,
      severity: 'low',
      body: 'Re-throwing non-AbortError inside a .catch() rejects the promise with no handler, surfacing as an unhandled rejection. Consider surfacing the error to component state instead so the user sees a failure message.',
    },
    {
      path: 'src/search/useSearch.test.ts',
      line: 52,
      severity: 'low',
      body: 'The debounce test hard-codes 250ms. Import DEBOUNCE_MS from the module so the test and implementation can never drift apart.',
    },
  ],
}
