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
import type { PrComment } from '../github/comments'
import type { CiSummary } from '../github/checks'
import type { LlmUsage } from '../llm/llm'
import type { ModelCostRow } from '../ai/modelCostBreakdown'
import type {
  AttentionResult,
  VerdictResult,
  TestInsight,
  SkillReviewResult,
  StoryOrderResult,
  GraphResult,
  RiskJudgeResult,
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
  changedFiles: 6,
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
 * Six changed files with believable unified-diff patches, hand-written so each
 * one lands in a DIFFERENT Story-mode layer (data → api → config → logic →
 * tests → ui). That gives the demo's Story walkthrough one step per layer and
 * tells the debounce-and-cancel change as a narrative: the query shape gains a
 * signal (data) → fetchResults honours it (api) → the debounce constant is
 * extracted (config) → the hook wires it together (logic) → tests pin it
 * (tests) → the search box consumes the hook (ui). Patch line counts match each
 * file's additions/deletions and every `@@` header is internally consistent.
 */
export const demoFiles: PrFile[] = [
  {
    // ── data ── the query/result shapes gain the optional AbortSignal field.
    filename: 'src/search/types.ts',
    status: 'added',
    additions: 12,
    deletions: 0,
    patch: `@@ -0,0 +1,12 @@
+export interface Result {
+  id: string
+  title: string
+  url: string
+}
+
+export interface SearchQuery {
+  text: string
+  /** Optional signal so a stale request can be aborted mid-flight. */
+  signal?: AbortSignal
+}
+`,
  },
  {
    // ── api ── fetchResults now accepts and FORWARDS the AbortSignal to fetch.
    // This is the file the old verdict flagged as "not shown in this diff"; it
    // is now in the diff, so the cancellation actually reaches the network.
    filename: 'src/search/api.ts',
    status: 'modified',
    additions: 5,
    deletions: 2,
    patch: `@@ -1,7 +1,10 @@
 import type { Result } from './types'

-export async function fetchResults(query: string): Promise<Result[]> {
-  const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`)
+export async function fetchResults(
+  query: string,
+  signal?: AbortSignal,
+): Promise<Result[]> {
+  const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`, { signal })
   if (!res.ok) throw new Error(\`search failed: \${res.status}\`)
   return (await res.json()) as Result[]
 }`,
  },
  {
    // ── config ── the magic 250ms debounce becomes a shared constant.
    filename: 'src/search/config.ts',
    status: 'added',
    additions: 6,
    deletions: 0,
    patch: `@@ -0,0 +1,6 @@
+/** Debounce window (ms) for the search box — shared by the hook and its test. */
+export const DEBOUNCE_MS = 250
+
+/** Max results rendered before the list virtualizes. */
+export const MAX_RESULTS = 50
+`,
  },
  {
    // ── logic ── the hook wires debounce + abort together, importing the
    // shared constant and forwarding the signal into fetchResults.
    filename: 'src/search/useSearch.ts',
    status: 'modified',
    additions: 15,
    deletions: 2,
    patch: `@@ -1,16 +1,29 @@
 import { useState, useEffect, useRef } from 'react'
-import { fetchResults, type Result } from './api'
+import { fetchResults } from './api'
+import type { Result } from './types'
+import { DEBOUNCE_MS } from './config'

 export function useSearch(query: string): Result[] {
   const [results, setResults] = useState<Result[]>([])
+  const controllerRef = useRef<AbortController | null>(null)

   useEffect(() => {
     if (query === '') {
       setResults([])
       return
     }
-    fetchResults(query).then(setResults)
+    const handle = setTimeout(() => {
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
   }, [query])

   return results
 }`,
  },
  {
    // ── tests ── two focused tests pin the debounce + abort semantics.
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
  {
    // ── ui ── a small component consumes the hook and renders the results.
    filename: 'src/search/SearchBox.tsx',
    status: 'added',
    additions: 17,
    deletions: 0,
    patch: `@@ -0,0 +1,17 @@
+import { useState } from 'react'
+import { useSearch } from './useSearch'
+
+export function SearchBox() {
+  const [query, setQuery] = useState('')
+  const results = useSearch(query)
+  return (
+    <div className="search-box">
+      <input value={query} onChange={(e) => setQuery(e.target.value)} />
+      <ul>
+        {results.map((r) => (
+          <li key={r.id}>{r.title}</li>
+        ))}
+      </ul>
+    </div>
+  )
+}`,
  },
]

/**
 * Existing PR comments for the demo — the conversation a reviewer walks into.
 *
 * Illustrative, like everything else here: the authors are named `demo-*` and
 * the URLs point at example.com, so nothing reads as a real person or vendor.
 *
 * Shaped to exercise what the comment surfaces actually have to handle:
 *   - one UNRESOLVED thread anchored inside a hunk (renders inline in the diff)
 *   - one RESOLVED thread WITH a reply, also anchored inline — the reply's id
 *     is in demoResolvedCommentIds too, which is why a thread count can never
 *     be taken from that Set's size
 *   - two RESOLVED file-level threads, BOTH written by a bot, which land in the
 *     per-file "General" group — the block the screenshot showed filling a
 *     viewport. These are what proves the two filters do not double-count: they
 *     are resolved AND a bot's, and exactly one of the toolbar's two counts
 *     claims them.
 *   - one UNRESOLVED BOT thread whose entire body is NESTED DISCLOSURES, the
 *     shape that costs ~200px to show nothing — and which carries a "Prompt to
 *     fix with AI (copy-paste)" section, so the drop and its receipt are
 *     demonstrable
 *   - one UNRESOLVED BOT thread A PERSON HAS ANSWERED, which the "Hide bots"
 *     switch must never take away: the reviewer's words are the point
 *   - bodies that OPEN with markup — a raw HTML link-wrapped badge and a
 *     markdown link badge, the way review bots write them. The collapsed
 *     one-line summary has to strip those to plain text before truncating, or
 *     it shows sixty characters of tags and no words.
 *   - THREE MORE HIDDEN GROUPS INSIDE ONE SHORT HUNK of src/search/useSearch.ts
 *     (#295), because the report that moved the notice out of the code flow was
 *     a screenshot of FOUR of them stacked through twenty lines. One group per
 *     marker is not the complaint; a column of them is. And one of those lines
 *     — RIGHT 19 — carries a RESOLVED thread and a BOT thread AT ONCE, the case
 *     the gutter marker has to hold without blurring two filters into one
 *     count: two bars, a label that states each reason's own count, and a
 *     separate way back per reason once they are shown.
 *
 * Two DIFFERENT bot logins, because a real PR has them: the vendor name is not
 * what makes a comment a bot's, the `[bot]` suffix is (isReviewBotAuthor).
 *
 * DELIBERATELY NO <img>: the demo's contract is no network, and a remote badge
 * image would fire a request from a rendered comment body (and make
 * scripts/capture-shots.mjs non-deterministic). The image-alt path of the
 * summary's markup stripping is covered in ExistingThread.test.ts instead.
 *
 * RIGHT line 7 of src/search/api.ts is the `fetch(..., { signal })` line and
 * line 5 is `signal?: AbortSignal,` — both present in that patch, so both
 * anchor inline rather than falling back to the bottom list. In
 * src/search/useSearch.ts, RIGHT line 22 is the `if (err.name !== 'AbortError')
 * throw err` line and line 16 is `controllerRef.current?.abort()` — likewise
 * both in the patch, so the two new bot threads render INLINE where the noise
 * actually hurts, rather than in the bottom list. RIGHT 8 is
 * `const controllerRef = useRef<AbortController | null>(null)` and RIGHT 19 is
 * `fetchResults(query, controller.signal)`, both in the same hunk — which is
 * what puts four hidden groups inside fifteen lines of one file.
 */
export const demoComments: PrComment[] = [
  {
    id: 9001,
    author: 'demo-reviewer',
    authorAvatar: null,
    body: 'Good — the signal reaches `fetch` here, so `abort()` actually cancels the in-flight request rather than just ignoring its result.',
    createdAt: '2024-05-02T09:12:00Z',
    path: 'src/search/api.ts',
    line: 7,
    side: 'RIGHT',
    inReplyTo: null,
  },
  {
    id: 9002,
    author: 'demo-reviewer',
    authorAvatar: null,
    body: 'Should `signal` be required rather than optional? An optional one is easy to forget at a call site.',
    createdAt: '2024-05-02T09:14:00Z',
    path: 'src/search/api.ts',
    line: 5,
    side: 'RIGHT',
    inReplyTo: null,
  },
  {
    id: 9003,
    author: 'demo-dev',
    authorAvatar: null,
    body: 'Optional keeps the existing call sites compiling; the one caller that matters passes it. Leaving it optional for now.',
    createdAt: '2024-05-02T10:02:00Z',
    path: 'src/search/api.ts',
    line: 5,
    side: 'RIGHT',
    inReplyTo: 9002,
  },
  {
    id: 9004,
    author: 'demo-lint-bot[bot]',
    authorAvatar: null,
    body: '<a href="#"><strong>P1</strong></a> Re-throwing a non-`AbortError` inside `.catch()` rejects with no handler, surfacing as an unhandled rejection. Route failures to component state instead.',
    createdAt: '2024-05-02T09:20:00Z',
    path: 'src/search/useSearch.ts',
    line: null,
    side: null,
    inReplyTo: null,
  },
  {
    id: 9005,
    author: 'demo-lint-bot[bot]',
    authorAvatar: null,
    body: '[**P2**](https://example.com/rules/p2) The debounce test hard-codes 250ms — import `DEBOUNCE_MS` so the test and the implementation cannot drift apart.',
    createdAt: '2024-05-02T09:21:00Z',
    path: 'src/search/useSearch.ts',
    line: null,
    side: null,
    inReplyTo: null,
  },
  {
    // THE 200px COMMENT. Four collapsed <details> and nothing outside them, the
    // shape that renders as a stack of shut doors conveying a title. Anchored
    // inline at RIGHT line 22, unresolved, and written by a DIFFERENT bot from
    // the two above — a real PR carries more than one.
    //
    // It is here so three behaviours stay demonstrable forever: the first
    // section opens instead of showing nothing, the "Prompt to fix with AI
    // (copy-paste)" section is dropped with a stated receipt, and the section
    // labels are the AUTHOR'S words rather than uppercase semibold chrome.
    id: 9006,
    author: 'demo-scan-bot[bot]',
    authorAvatar: null,
    body: [
      '<details><summary>Issue description</summary>',
      '',
      'Re-throwing inside `.catch()` rejects a promise nobody is holding, so the',
      'failure surfaces as an unhandled rejection rather than as an error the',
      'component can render.',
      '',
      '</details>',
      '<details><summary>Why we think this is a valid issue</summary>',
      '',
      'The effect returns a cleanup function, not the promise, so there is no',
      'rejection handler anywhere up the chain.',
      '',
      '</details>',
      '<details><summary>Suggested fix</summary>',
      '',
      'Set an error state instead of re-throwing:',
      '',
      '```ts',
      ".catch((err) => { if (err.name !== 'AbortError') setError(err) })",
      '```',
      '',
      '</details>',
      '<details><summary>Prompt to fix with AI (copy-paste)</summary>',
      '',
      'In src/search/useSearch.ts, replace the re-throw in the catch handler with',
      'component error state. Keep the AbortError check.',
      '',
      '</details>',
    ].join('\n'),
    createdAt: '2024-05-02T09:25:00Z',
    path: 'src/search/useSearch.ts',
    line: 22,
    side: 'RIGHT',
    inReplyTo: null,
  },
  {
    // A BOT FINDING THE REVIEWER ANSWERED. Unresolved, anchored inline at RIGHT
    // line 16. The "Hide bots" switch must leave this whole thread alone — the
    // reply below is a person's reasoning, it exists nowhere else in this app,
    // and "hide the noise" was never a request to hide it.
    id: 9007,
    author: 'demo-scan-bot[bot]',
    authorAvatar: null,
    body: 'Calling `abort()` on every keystroke cancels a request that may already have resolved. Consider checking `controller.signal.aborted` first.',
    createdAt: '2024-05-02T09:26:00Z',
    path: 'src/search/useSearch.ts',
    line: 16,
    side: 'RIGHT',
    inReplyTo: null,
  },
  {
    id: 9008,
    author: 'demo-reviewer',
    authorAvatar: null,
    body: 'Aborting a settled request is a no-op, so the check would only add a branch. Leaving it.',
    createdAt: '2024-05-02T09:31:00Z',
    path: 'src/search/useSearch.ts',
    line: 16,
    side: 'RIGHT',
    inReplyTo: 9007,
  },
  {
    // ── The stack (#295) ──────────────────────────────────────────────────
    // A FINISHED conversation at RIGHT 8. On its own it is unremarkable; its
    // job is to be the first of four hidden groups inside one hunk, which is
    // the shape the report was a screenshot of.
    id: 9009,
    author: 'demo-reviewer',
    authorAvatar: null,
    body: 'A ref rather than state here is right — re-rendering on every controller swap would re-run the effect.',
    createdAt: '2024-05-02T09:35:00Z',
    path: 'src/search/useSearch.ts',
    line: 8,
    side: 'RIGHT',
    inReplyTo: null,
  },
  {
    // TWO FILTERS ON ONE LINE, part 1: an unresolved BOT thread at RIGHT 19.
    id: 9010,
    author: 'demo-lint-bot[bot]',
    authorAvatar: null,
    body: '[**P3**](https://example.com/rules/p3) `fetchResults` is called without an `await` inside a `setTimeout` callback — the returned promise is handled, but a linter that cannot see the `.then()` chain will flag it.',
    createdAt: '2024-05-02T09:36:00Z',
    path: 'src/search/useSearch.ts',
    line: 19,
    side: 'RIGHT',
    inReplyTo: null,
  },
  {
    // TWO FILTERS ON ONE LINE, part 2: a RESOLVED HUMAN thread at the SAME
    // line. Neither filter can claim both, so the marker at RIGHT 19 has to
    // carry two counts the reader can act on separately.
    id: 9011,
    author: 'demo-dev',
    authorAvatar: null,
    body: 'Forwarding the signal here is the whole point of the change — confirmed against the api.ts side.',
    createdAt: '2024-05-02T09:37:00Z',
    path: 'src/search/useSearch.ts',
    line: 19,
    side: 'RIGHT',
    inReplyTo: null,
  },
]

/**
 * Which of demoComments belong to a RESOLVED thread — the shape
 * provider.getResolvedCommentIds() returns (GitHub/GitLab; Bitbucket has no
 * resolved threads and returns an empty Set).
 *
 * Note 9003: a resolved thread's REPLIES are in the Set too. Five threads are
 * resolved here, not six, which is why the count shown in the UI is computed
 * from grouped threads rather than from this Set's size.
 *
 * 9006–9008 and 9010 are deliberately ABSENT: the bot threads are open, so the
 * demo shows the bot filter doing its own work rather than riding on the
 * resolved one. 9004 and 9005 are in both categories at once, which is the case
 * the two toolbar counts must not each claim. 9011 is resolved and 9010 is not,
 * and they sit on the SAME line — which is the case one gutter marker must
 * carry as two counts (#295).
 */
export const demoResolvedCommentIds: Set<number> = new Set([9002, 9003, 9004, 9005, 9009, 9011])

/**
 * Canned Story-mode walkthrough (StoryOrderResult). The steps are already in
 * canonical reading order (0-based index), one per layer, each referencing the
 * real `demoFiles` paths above. Captions tell the change as a story; the logic
 * step links the test file as a related test. Conceptually valid against
 * validateStoryOrder: every step has a non-empty files array, an integer index,
 * and a valid StoryLayer.
 */
export const demoStory: StoryOrderResult = {
  steps: [
    {
      index: 0,
      files: ['src/search/types.ts'],
      caption:
        'Start with the **data shape**: `SearchQuery` gains an optional `signal` so a request can be aborted mid-flight, and `Result` is the row the UI renders.',
      layer: 'data',
      relatedTests: [],
    },
    {
      index: 1,
      files: ['src/search/api.ts'],
      caption:
        'The **API** honours it: `fetchResults` now takes an `AbortSignal` and forwards it to `fetch`, so cancelling a request actually reaches the network.',
      layer: 'api',
      relatedTests: [],
    },
    {
      index: 2,
      files: ['src/search/config.ts'],
      caption:
        'The magic number moves to **config**: `DEBOUNCE_MS = 250` is extracted so the hook and its test share one source of truth.',
      layer: 'config',
      relatedTests: [],
    },
    {
      index: 3,
      files: ['src/search/useSearch.ts'],
      caption:
        'The **hook** wires it together — debounce the input by `DEBOUNCE_MS`, abort the previous controller before each new request, and swallow only `AbortError`.',
      layer: 'logic',
      relatedTests: ['src/search/useSearch.test.ts'],
    },
    {
      index: 4,
      files: ['src/search/useSearch.test.ts'],
      caption:
        'Two **tests** pin the behaviour: rapid keystrokes collapse to a single call for the latest query, and the prior request is aborted when the query changes.',
      layer: 'tests',
      relatedTests: [],
    },
    {
      index: 5,
      files: ['src/search/SearchBox.tsx'],
      caption:
        'Finally the **UI**: `SearchBox` consumes `useSearch(query)` and renders the result list — the user-facing payoff of the whole change.',
      layer: 'ui',
      relatedTests: [],
    },
  ],
}

/**
 * Pre-generated summary. The ===READING-ORDER=== sentinel block is parsed by
 * parseReadingOrder() (and stripped for display by stripReadingOrder()) exactly
 * as a live summary would be.
 */
export const demoSummary = `This PR fixes a race condition in the search box. Previously \`useSearch\` fired a request on every keystroke and rendered whichever response resolved last, so a slow early request could clobber the results for a newer query.

The fix spans the search feature end to end: \`SearchQuery\` gains an optional \`AbortSignal\` (\`src/search/types.ts\`), \`fetchResults\` now accepts that signal and forwards it to \`fetch\` (\`src/search/api.ts\`), the \`DEBOUNCE_MS = 250\` constant is extracted (\`src/search/config.ts\`), and \`useSearch\` wires the two together: a **250ms debounce** so rapid typing collapses into a single request, and an **AbortController** so the previous in-flight request is cancelled before a new one starts. \`AbortError\` is swallowed; any other error still propagates. The effect's cleanup clears the pending timeout, so unmounting mid-type can't fire a stray request.

Two focused tests cover the new behaviour: one asserts rapid keystrokes debounce to a single call with the latest query, the other asserts the prior request is aborted when the query changes. The \`SearchBox\` component consumes the hook and renders the result list.

===READING-ORDER===
src/search/types.ts
src/search/api.ts
src/search/config.ts
src/search/useSearch.ts
src/search/useSearch.test.ts
src/search/SearchBox.tsx
===END===`

/** Pre-generated hotspots + test flags (AttentionResult schema). */
export const demoAttention: AttentionResult = {
  readingOrder: [
    'src/search/types.ts',
    'src/search/api.ts',
    'src/search/config.ts',
    'src/search/useSearch.ts',
    'src/search/useSearch.test.ts',
    'src/search/SearchBox.tsx',
  ],
  hotspots: [
    {
      path: 'src/search/useSearch.ts',
      reason:
        'Core of the change — debounce timer + AbortController lifecycle. Check the cleanup clears the timeout and the abort runs before the next fetch.',
      level: 'high',
    },
    {
      path: 'src/search/api.ts',
      reason:
        'fetchResults now forwards the AbortSignal to fetch — confirm the signal is actually threaded through so abort() cancels the network request.',
      level: 'medium',
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

/**
 * Pre-generated LLM risk judgment (RiskJudgeResult schema) — the "AI judgment"
 * factor in the Review effort breakdown, with a couple of risky snippets.
 */
export const demoRiskJudge: RiskJudgeResult = {
  score: 2,
  rationale: 'Async cancellation + debounce timing interact — subtle ordering bugs hide in the cleanup path.',
  snippets: [
    {
      path: 'src/search/useSearch.ts',
      line: 24,
      reason: 'Abort-then-refetch ordering: confirm the old controller aborts before the new request starts.',
    },
    {
      path: 'src/search/api.ts',
      line: 11,
      reason: 'AbortError is swallowed — verify other fetch failures still propagate to the caller.',
    },
  ],
}

/**
 * Pre-generated verdict (VerdictResult schema) — now carrying cross-model
 * verification (`evidenceVerification`) and multi-generator provenance
 * (`evidenceRaisedBy`) on a couple of evidence rows, so the verdict's evidence
 * chips show the SAME confirmed / flagged / "raised by" treatment the finding
 * cards do. Keyed by evidence array index (Plan M / Plan O), exactly as the live
 * fusion path attaches them.
 */
export const demoVerdict: VerdictResult = {
  level: 'minor-changes',
  evidence: [
    'Adds a 250ms debounce in useSearch so rapid keystrokes collapse to one request (src/search/useSearch.ts).',
    'Aborts the previous in-flight request via AbortController before starting a new one, fixing the stale-response overwrite.',
    'Swallows AbortError but re-throws other errors, so cancellation is silent while real failures still surface.',
    'Effect cleanup clears the pending timeout, preventing a stray request after unmount or a fast follow-up keystroke.',
    'fetchResults now accepts an AbortSignal and forwards it to fetch (src/search/api.ts), so abort() actually cancels the network request.',
  ],
  // src/search/api.ts is now IN the diff (it forwards the signal to fetch), so
  // the previous "not shown in this diff" caveat no longer applies. Nothing
  // material is left unanalyzed.
  notAnalyzed: [],
  // Cross-model verification per evidence row (Plan M). Row 1 (the abort claim)
  // is CONFIRMED by 3/4 models; row 2 (the re-throw claim) is DEMOTED — only one
  // model surfaced it and the others pushed back.
  evidenceVerification: {
    1: {
      confirmedBy: 3,
      polledModels: 4,
      surfaced: true,
      perModel: [
        { provider: 'OpenAI', model: 'GPT-5.5', verdict: 'confirm', reason: 'AbortController is created and stored before the fetch; the prior controller is aborted first.', raised: true },
        { provider: 'DeepSeek', model: 'DeepSeek V4 Pro', verdict: 'confirm', reason: 'controllerRef is aborted on every re-run, so only the latest request can resolve into state.' },
        { provider: 'Anthropic', model: 'Claude Opus 4.8', verdict: 'confirm', reason: 'Cancellation ordering is correct: abort precedes the new request.' },
        { provider: 'Gemini', model: 'Gemini 3.5 Flash', verdict: 'uncertain', reason: 'Depends on fetchResults honouring the signal, which is outside this diff.' },
      ],
    },
    2: {
      confirmedBy: 1,
      polledModels: 4,
      surfaced: false,
      perModel: [
        { provider: 'OpenAI', model: 'GPT-5.5', verdict: 'confirm', reason: 'The catch re-throws when err.name !== "AbortError".', raised: true },
        { provider: 'Anthropic', model: 'Claude Opus 4.8', verdict: 'refute', reason: 'A re-thrown rejection inside .then().catch() has no handler — it surfaces as an unhandled rejection, not to the user.' },
        { provider: 'DeepSeek', model: 'DeepSeek V4 Pro', verdict: 'refute', reason: '"Real failures still surface" overstates it — nothing routes the error to component state.' },
        { provider: 'Gemini', model: 'Gemini 3.5 Flash', verdict: 'uncertain', reason: 'Behaviour depends on the host’s unhandledrejection handling.' },
      ],
    },
    // Row 4 (the signal-forwarding claim) is CONFIRMED unanimously now that
    // src/search/api.ts is in the diff and visibly forwards the signal to fetch.
    4: {
      confirmedBy: 4,
      polledModels: 4,
      surfaced: true,
      perModel: [
        { provider: 'OpenAI', model: 'GPT-5.5', verdict: 'confirm', reason: 'fetchResults takes signal and passes { signal } to fetch — verifiable in api.ts.', raised: true },
        { provider: 'DeepSeek', model: 'DeepSeek V4 Pro', verdict: 'confirm', reason: 'The signal reaches fetch, so abort() cancels the request.', raised: true },
        { provider: 'Anthropic', model: 'Claude Opus 4.8', verdict: 'confirm', reason: 'Confirmed: the AbortSignal is threaded end-to-end now.' },
        { provider: 'Gemini', model: 'Gemini 3.5 Flash', verdict: 'confirm', reason: 'fetch receives the signal in its options object.' },
      ],
    },
  },
  // Multi-generator provenance (Plan O 'generate' mode): row 1 was independently
  // raised by BOTH generators (high recall agreement); row 2 only by one; row 4
  // (the now-confirmable signal-forwarding claim) by both.
  evidenceRaisedBy: {
    1: ['GPT-5.5', 'DeepSeek V4 Pro'],
    2: ['GPT-5.5'],
    4: ['GPT-5.5', 'DeepSeek V4 Pro'],
  },
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

/**
 * Pre-generated skill-reviewer findings — the ORIGINAL single reviewer, kept so
 * existing consumers/tests that import it still resolve. The demo run now drives
 * its reviewer column from `demoReviewers` below (several personas), of which
 * this is the first.
 */
export const demoSkillFindings: SkillReviewResult = {
  skillName: 'Correctness & race conditions',
  findings: [
    {
      path: 'src/search/api.ts',
      line: 7,
      severity: 'medium',
      body: 'fetchResults now forwards the AbortSignal to fetch via the `{ signal }` option — good. Confirm every call site passes the controller signal so abort() truly cancels the in-flight network request.',
    },
    {
      path: 'src/search/useSearch.ts',
      line: 22,
      severity: 'low',
      body: 'Re-throwing non-AbortError inside a .catch() rejects the promise with no handler, surfacing as an unhandled rejection. Consider surfacing the error to component state instead so the user sees a failure message.',
    },
    {
      path: 'src/search/useSearch.test.ts',
      line: 52,
      severity: 'low',
      body: 'The debounce test hard-codes 250ms. Import DEBOUNCE_MS from src/search/config.ts so the test and implementation can never drift apart.',
    },
  ],
}

/**
 * The DEMO'S DIFFERENTIATOR SHOWCASE — several fake reviewer PERSONAS, each a
 * pre-generated SkillReviewResult, exercising the key finding/verification UI
 * states offline:
 *
 *   1. Security Reviewer — a CONFIRMED finding (cross-model verification
 *      surfaced=true, confirmed by 3/4) anchored INLINE in the diff, carrying
 *      multi-generator provenance (`raisedBy` → "raised by GPT-5.5, DeepSeek V4
 *      Pro"). Drives the "✓ verified" trust chip + per-vote tooltip.
 *   2. Performance Reviewer — a DEMOTED finding (surfaced=false, flagged by
 *      1/5): finding-triage collapses it into the per-file "N more findings"
 *      group instead of an inline card.
 *   3. Pragmatic Senior Reviewer — a confirmed FILE-LEVEL (null-line) finding so
 *      the popover/fallback placement renders, plus a plain low inline note.
 *   4. Resiliency & SRE Reviewer — NO findings, so the "✓ no significant issues"
 *      state renders too.
 *
 * Every verdict carries a real `model` + a one-line `reason` so the tooltip reads
 * cleanly. Line numbers stay inside the demo diff's `+1,29` hunk for useSearch.ts
 * (and api.ts's `+1,10` / config.ts's `+1,6` hunks) so the inline cards anchor.
 */
export const demoReviewers: SkillReviewResult[] = [
  {
    skillName: 'Security Reviewer (OWASP-minded)',
    findings: [
      {
        // CONFIRMED + inline + multi-generator provenance.
        path: 'src/search/useSearch.ts',
        line: 22,
        severity: 'high',
        body: 'The `AbortError` is swallowed, but a non-abort failure from `fetchResults` is re-thrown into a `.catch()` with no further handler — an attacker probing the search endpoint can drive a stream of unhandled rejections (potential DoS on error-logging sinks). Route failures to component state and surface a bounded error instead.',
        raisedBy: ['GPT-5.5', 'DeepSeek V4 Pro'],
        verification: {
          confirmedBy: 3,
          polledModels: 4,
          surfaced: true,
          perModel: [
            { provider: 'OpenAI', model: 'GPT-5.5', verdict: 'confirm', reason: 'Re-thrown rejection has no downstream handler — unhandled rejection.', raised: true },
            { provider: 'DeepSeek', model: 'DeepSeek V4 Pro', verdict: 'confirm', reason: 'Confirmed: the .catch() re-throws and nothing catches it.', raised: true },
            { provider: 'Anthropic', model: 'Claude Opus 4.8', verdict: 'confirm', reason: 'Agreed; an error path should set component error state, not re-throw.' },
            { provider: 'Gemini', model: 'Gemini 3.5 Flash', verdict: 'uncertain', reason: 'Severity depends on whether a global handler exists.' },
          ],
        },
      },
    ],
  },
  {
    skillName: 'Performance Reviewer',
    findings: [
      {
        // DEMOTED (surfaced=false) — triaged into the collapsed per-file group.
        path: 'src/search/config.ts',
        line: 2,
        severity: 'low',
        body: 'A fixed 250ms debounce may feel sluggish for short queries. Consider a shorter leading-edge debounce so the first keystroke fires immediately.',
        verification: {
          confirmedBy: 1,
          polledModels: 5,
          surfaced: false,
          perModel: [
            { provider: 'OpenAI', model: 'GPT-5.5', verdict: 'confirm', reason: 'A leading-edge debounce would feel snappier.', raised: true },
            { provider: 'DeepSeek', model: 'DeepSeek V4 Pro', verdict: 'refute', reason: '250ms is a standard, well-justified search debounce — not a real issue.' },
            { provider: 'Anthropic', model: 'Claude Opus 4.8', verdict: 'refute', reason: 'This is a UX preference, not a defect in the PR.' },
            { provider: 'Gemini', model: 'Gemini 3.5 Flash', verdict: 'uncertain', reason: 'No latency budget is stated, so impact is unclear.' },
            { provider: 'DeepSeek', model: 'DeepSeek V4 Flash', verdict: 'refute', reason: 'Debounce constant is reasonable; no change needed.' },
          ],
        },
      },
    ],
  },
  {
    skillName: 'Pragmatic Senior Reviewer',
    findings: [
      {
        // FILE-LEVEL (null line) → renders in the reviewer-chip popover / fallback.
        path: 'src/search/useSearch.ts',
        line: null,
        severity: 'medium',
        body: 'The effect now owns three concerns (debounce timer, abort lifecycle, error handling). Consider extracting a small `useDebouncedSearch` hook so this stays testable as it grows.',
        verification: {
          confirmedBy: 2,
          polledModels: 3,
          surfaced: true,
          perModel: [
            { provider: 'DeepSeek', model: 'DeepSeek V4 Pro', verdict: 'confirm', reason: 'The effect is doing a lot; extraction would help.', raised: true },
            { provider: 'Anthropic', model: 'Claude Opus 4.8', verdict: 'confirm', reason: 'Agreed — separable concerns.' },
            { provider: 'Gemini', model: 'Gemini 3.5 Flash', verdict: 'uncertain', reason: 'Fine for now at this size.' },
          ],
        },
      },
      {
        // Plain inline low-severity note (no verification) in the test file.
        path: 'src/search/useSearch.test.ts',
        line: 52,
        severity: 'low',
        body: 'The debounce test hard-codes 250ms. Import `DEBOUNCE_MS` from the module so the test and implementation can never drift apart.',
      },
    ],
  },
  {
    // Empty findings → "✓ no significant issues" chip state.
    skillName: 'Resiliency & SRE Reviewer',
    findings: [],
  },
]

// ---------------------------------------------------------------------------
// Step-3 "Review cost & model performance" — per-model breakdown (Plan N/P)
// ---------------------------------------------------------------------------

/**
 * Pre-generated per-model cost + performance for the WHOLE demo review: TWO
 * generators (DeepSeek V4 Pro + GPT-5.5) and a couple of verifiers (Claude Opus
 * 4.8 + Gemini 3.5 Flash). Every model id is in `modelCatalog.ts` so the panel
 * prices the $ column. Each row's `total` equals the sum of its `byTask` usage,
 * and the four rows' totals sum to `demoTotalUsage` — so the panel reconciles
 * exactly as a live review would. Plausible token counts; display-only, offline.
 */
function usage(prompt: number, completion: number): LlmUsage {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

export const demoModelCostBreakdown: ModelCostRow[] = [
  {
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
    role: 'generator',
    // Story now "ran" too — its byTask line is included, so this row's total
    // and demoTotalUsage both account for it (the panel reconciles exactly).
    total: usage(35_600, 5_100),
    surfaced: 3,
    uniqueCatch: 1,
    byTask: [
      { task: 'Verdict', usage: usage(9_800, 1_300) },
      { task: 'Story', usage: usage(7_200, 900) },
      { task: 'Reviewer: Security Reviewer (OWASP-minded)', usage: usage(8_900, 1_500) },
      { task: 'Reviewer: Pragmatic Senior Reviewer', usage: usage(9_700, 1_400) },
    ],
  },
  {
    providerId: 'openai',
    modelId: 'gpt-5.5',
    role: 'generator',
    total: usage(26_100, 3_800),
    surfaced: 2,
    uniqueCatch: 1,
    byTask: [
      { task: 'Verdict', usage: usage(9_500, 1_200) },
      { task: 'Reviewer: Security Reviewer (OWASP-minded)', usage: usage(8_400, 1_300) },
      { task: 'Reviewer: Performance Reviewer', usage: usage(8_200, 1_300) },
    ],
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-8',
    role: 'verifier',
    total: usage(18_900, 2_100),
    impact: { confirms: 3, refutes: 2, uncertains: 0, decisive: 2 },
    byTask: [
      { task: 'Verdict', usage: usage(6_400, 700) },
      { task: 'Reviewer: Security Reviewer (OWASP-minded)', usage: usage(6_300, 700) },
      { task: 'Reviewer: Performance Reviewer', usage: usage(6_200, 700) },
    ],
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-3.5-flash',
    role: 'verifier',
    total: usage(17_400, 1_600),
    impact: { confirms: 0, refutes: 0, uncertains: 4, decisive: 0 },
    byTask: [
      { task: 'Verdict', usage: usage(5_900, 550) },
      { task: 'Reviewer: Security Reviewer (OWASP-minded)', usage: usage(5_800, 550) },
      { task: 'Reviewer: Performance Reviewer', usage: usage(5_700, 500) },
    ],
  },
]

/**
 * Aggregate token usage for the demo review — the SUM of every cost row's total
 * (35_600+5_100 + 26_100+3_800 + 18_900+2_100 + 17_400+1_600). The deepseek row
 * now includes the Story task, so its total (and this aggregate) account for it.
 * Drives the "This review used … total" headline; prices against the active model.
 */
export const demoTotalUsage: LlmUsage = usage(
  35_600 + 26_100 + 18_900 + 17_400,
  5_100 + 3_800 + 2_100 + 1_600,
)

// ---------------------------------------------------------------------------
// Change-impact / blast-radius diagram — the demo's sample diagram
// ---------------------------------------------------------------------------

/**
 * Pre-generated change-impact (blast-radius) view for the demo PR — the tiny
 * graph the Understand step (and ContextRail) shows in normal mode. It answers
 * "what does this change touch?" centred on the changed `useSearch` hook:
 *
 *   callers (affected):  SearchBox            (src/search/SearchBox.tsx)
 *   changed (centre):    useSearch (changed)  (src/search/useSearch.ts)
 *   callees (uses):      fetchResults         (src/search/api.ts)
 *                        AbortController       (constructed for cancellation)
 *                        DEBOUNCE_MS           (src/search/config.ts)
 *
 * `kind: 'flow'` with EMPTY before/after graphs is valid — the panel prefers
 * `impact` when present + renderable. Curated (not a mechanical mirror of the
 * diff): only the genuinely load-bearing 1-hop neighbours of the changed hook.
 * Conceptually valid against validateChangeImpact / validateGraphResult.
 */
export const demoGraph: GraphResult = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
  impact: {
    changed: [
      { symbol: 'useSearch', file: 'src/search/useSearch.ts', kind: 'changed' },
    ],
    callers: [
      { symbol: 'SearchBox', file: 'src/search/SearchBox.tsx' },
    ],
    callees: [
      { symbol: 'fetchResults', file: 'src/search/api.ts' },
      { symbol: 'AbortController' },
      { symbol: 'DEBOUNCE_MS', file: 'src/search/config.ts' },
    ],
  },
}
