# Review 1-2-3 — Plan C: AI Features

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four AI features (summary + reading order, attention/hotspots with AI-inferred test flags, before/after Mermaid diagrams via deterministic serialization, 3-level behavior verdict), powered by a BYO DeepSeek key — with context packing, response caching, the private-repo consent gate, and CI check-run signals.

**Architecture:** All LLM calls behind `lib/llm` (OpenAI-compatible, configurable base URL + model — future model switching is config). Three structured tasks use JSON mode + schema validation + one repair retry; summary streams. `lib/context` packs prompt context within a token budget derived from model config. Results cached in IndexedDB keyed `repo#pr@headSha + task + promptVersion`. Private repos gated by per-repo consent. Each AI panel fails independently; the review flow never blocks on AI (EC-06h finally gets its real test).

**Tech additions:** `mermaid` (lazy-imported), `@playwright/test` + `msw` (dev, e2e fixtures). Schema validation hand-rolled typed guards (no new runtime dep).

**Criteria covered (must-haves):** REQ-10 (EC-10a,b,c,d,g), REQ-11 (all 7), REQ-12 (EC-12a,b,c,e,f), REQ-13 (EC-13c,d,e,g), REQ-14 (EC-14a,b,c,d,e,g,j,k,l), REQ-15 (EC-15a,c,e,f,g), REQ-16 (EC-16a,b,c,d,e,g,i,k), REQ-17 (EC-17a,b,c,d,e,i), REQ-06 EC-06h, REQ-20 (EC-20e hotspot jump + overlay). CH-03 (JSON tasks are spinner-then-result, only summary streams), CH-04 (no timing assumptions), CH-06 (budget from model config).

**Branch:** `feat/plan-c-ai`. Waves: 1 → {2,3,4,5,7} → 6 → 8 → 9 → 10.

---

### Task 1: lib/llm — DeepSeek client

**Files:** `src/lib/llm/llm.ts`, `src/lib/llm/config.ts`, tests.

- [ ] `config.ts`: `export const LLM_CONFIG = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', contextWindowTokens: 64_000, maxOutputTokens: 4_000 }` — single source for Task 2's budget (CH-06).
- [ ] `llm.ts`:
  - `llmComplete(opts: { system: string; user: string; json?: boolean; signal?: AbortSignal }): Promise<string>` — POST `${baseUrl}/chat/completions` with `Authorization: Bearer <deepseekKey from settings>`, `response_format: {type:'json_object'}` when json; returns `choices[0].message.content`. Errors → typed `LlmError` discriminants: `'no-key'` (key absent — checked before fetch), `'auth'` (401), `'rate-limited'` (429), `'server'`, `'network'`, `'timeout'` (AbortSignal.timeout(60_000) default).
  - `llmStream(opts minus json, onDelta: (text: string) => void): Promise<string>` — `stream: true`, parses SSE `data:` lines (`[DONE]` terminator), calls onDelta per content delta, returns full text. Interrupted stream → throws `LlmError('network')` with partial NOT returned as complete (EC-12f groundwork).
  - `llmJsonWithRepair<T>(opts, validate: (x: unknown) => T | null): Promise<T>` — parse+validate; on JSON parse failure or validator null, ONE retry appending the error + previous output to the prompt asking for corrected JSON; second failure → throw `LlmError('invalid-output')` (REQ-13 EC-13e / REQ-15 EC-15f / REQ-14 EC-14g shared mechanism).
- [ ] Tests (stub fetch): error mapping per status; no-key short-circuits without fetch; SSE parsing across chunk boundaries (delta split mid-line); stream interruption throws; repair retry fires exactly once with the validator error embedded; success after repair returns parsed value.

### Task 2: lib/context — prompt context packing (REQ-16)

**Files:** `src/lib/context/pack.ts`, tests.

- [ ] Contract:
  ```ts
  export interface PackedContext { text: string; notAnalyzed: string[]; includedFiles: string[] }
  export function packContext(input: { files: PrFile[]; contents: Map<string, { before: string | null; after: string | null }>; ci: CiSummary | null; budgetTokens: number }): PackedContext
  ```
  Pure. Token estimate = `Math.ceil(chars / 3.5)` (documented heuristic, multibyte-safe enough; EC-16j is nice-to-have). Order: per-file patch first (cheap), then before/after contents for files whose BOTH fit the remaining budget; lock/generated files excluded entirely (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `*.min.*`, `*.map`, paths matching `/dist/|/generated/`) (EC-16e); binary (no patch) excluded; deleted file → before only; added → after only (EC-16g); CI failures + annotation messages appended when present (EC-16i); anything trimmed or skipped lands in `notAnalyzed` (EC-16c/k); zero files → `{text:'', notAnalyzed:[], includedFiles:[]}` valid (EC-16a).
- [ ] Tests: every EC above + boundary determinism at budget, budget±1 (EC-16d — construct contents sized to land exactly on the boundary given the documented estimator).
- [ ] Content fetch helper `fetchContents(ref, files, meta, limit = 30): Promise<Map<...>>` in the same module: for the first `limit` files by patch size descending, `getFileAtRef` before@baseSha (skip when status added) and after@headSha (skip when removed) with **concurrency cap 4** (CH-01 secondary-rate-limit guard) — test the cap by asserting max in-flight with deferred promises.

### Task 3: lib/cache — AI response cache (REQ-17)

**Files:** `src/lib/cache/aiCache.ts`, tests (fake-indexeddb — follow lib/drafts patterns incl. in-memory fallback).

- [ ] `cacheKey(prKey: string, task: string, promptVersion: number): string`; `getCached<T>(key): Promise<T | null>`; `setCached<T>(key, value: T): Promise<void>`. DB `review123-ai-cache`, store `responses`. IndexedDB unavailable → both no-op gracefully (get→null) (EC-17e). Corrupt entry (JSON-incompatible) → null (treated as miss).
- [ ] Tests: miss→set→hit round trip (EC-17a); key changes with sha / task / promptVersion (EC-17b/c/i); unavailable fallback (EC-17e); only-completed semantics is the CALLER's job (Task 8) — document in a comment.

### Task 4: CI signals — check runs + annotations (REQ-10)

**Files:** `src/lib/github/checks.ts`, tests; `src/components/CiSummary.svelte` + test.

- [ ] `checks.ts`: `export interface CiSummary { total: number; passed: number; failed: number; pending: number; failures: { name: string; annotations: string[] }[] }`; `getCiSummary(ref: PrRef, headSha: string): Promise<CiSummary>` — GET `/repos/{o}/{r}/commits/{sha}/check-runs?per_page=100` (ghFetchPage, traverse next); for each failed run GET its annotations endpoint (cap 50/run); message strings passed through as plain text. Zero runs → all-zero summary (EC-10a).
- [ ] `CiSummary.svelte`: props `{ ci: CiSummary | null, error: boolean }` — null+!error → loading skeleton; error → "Couldn't load CI status" (rest of page unaffected, EC-10e nice); zero total → "No CI configured" (EC-10a); pending>0 → pending state (EC-10b); all pass → green count (EC-10c); failures list name + annotations as TEXT nodes (Svelte auto-escape — EC-10g test renders an annotation containing `<script>` and asserts no script element).
- [ ] Tests: mapping (mixed results EC-10d), pagination of check runs, component states.

### Task 5: consent gate (REQ-11)

**Files:** `src/lib/consent/consent.ts`, `src/components/ConsentDialog.svelte`, tests.

- [ ] `consent.ts`: `hasConsent(repo: string): boolean`, `grantConsent(repo: string): void`, `revokeAll(): void` — localStorage key `review123:ai-consent` (array of `owner/repo`). Cleared storage → re-asks (EC-11e fail-safe).
- [ ] `gateAi(opts: { repo: string; isPrivate: boolean | undefined; ask: () => Promise<boolean> }): Promise<boolean>` — public (`isPrivate === false`) → true immediately, NO dialog (EC-11a); private OR **undefined** visibility (EC-11f fail-safe) → consented? true : ask once and persist on accept. Single in-flight `ask` shared across concurrent callers (EC-11g — four AI tasks, one dialog; test with two concurrent gateAi calls asserting ask called once).
- [ ] `ConsentDialog.svelte`: explains exactly what is sent ("code from this private repository will be sent to DeepSeek"), Accept / Not now. Decline → AI panels show declined state, manual review unaffected (EC-11c — panel state handled in Task 8).
- [ ] Tests: every EC-11 must-have.

### Task 6: AI task definitions — prompts, schemas, parsers (REQ-12/13/15 core)

**Files:** `src/lib/ai/tasks.ts`, `src/lib/ai/schemas.ts`, tests. `PROMPT_VERSION = 1` exported (cache key input).

- [ ] `schemas.ts` — typed guards (validator fns returning `T | null`) for:
  ```ts
  export interface AttentionResult { readingOrder: string[]; hotspots: { path: string; reason: string; level: 'high' | 'medium' | 'low' }[]; testFlags: { path: string; note: string }[] }
  export interface VerdictResult { level: 'behavior-preserved' | 'minor-changes' | 'significant-changes'; evidence: string[]; notAnalyzed: string[] }
  export interface GraphResult { before: Graph; after: Graph; kind: 'flow' | 'module' }
  export interface Graph { nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string }[] }
  ```
  Validators reject wrong types, out-of-enum levels (EC-15a — a percentage string must fail), missing arrays. Tests per schema (valid, invalid-enum, wrong-type, extra-keys-tolerated).
- [ ] `tasks.ts` — one builder per task returning `{system, user}` prompts from a `PackedContext` (+ CI summary for verdict EC-15g — assert the prompt text contains the CI failure lines when present):
  - `summarize` (streaming, plain text): summary + "Suggested reading order:" file list section the UI can parse leniently (files not in PR are ignored by the consumer — EC-12e tested at the consumer in Task 8/9).
  - `analyzeAttention` (json): instructs the model that test mapping is inferred; schema above.
  - `generateDiagrams` (json): emits GraphResult — the model NEVER writes Mermaid (spec decision); few-shot example embedded in the system prompt; kind chosen by the model from change shape.
  - `assessBehavior` (json): three-level verdict, evidence bullets, notAnalyzed seeded from PackedContext.notAnalyzed (merged by the consumer).
  Prompt PROSE quality is a human-checkpoint concern (spec: tests cover plumbing, not prose) — tests assert structural requirements only: context text included, JSON-schema instructions present, CI lines present for verdict, few-shot present for diagrams.

### Task 7: lib/diagram — graph→Mermaid serializer + sandboxed renderer (REQ-14)

**Files:** `src/lib/diagram/mermaid.ts`, `src/components/DiagramPanel.svelte`, tests.

- [ ] `mermaid.ts`: `export function graphToMermaid(g: Graph, kind: 'flow' | 'module'): string` — deterministic: `flowchart TD` header; node ids sanitized to `n0,n1,...` (map-based — arbitrary id strings never reach Mermaid syntax); labels escaped via `"..."` with internal `"`→`#quot;`, newlines→spaces, backticks stripped (EC-14c); edges referencing unknown node ids are DROPPED and recorded (`{ mermaid, dropped: string[] }` return — adjust signature) (EC-14e); empty graph → `{ mermaid: '', dropped: [] }` and the panel renders "No structural changes detected" (EC-14a); single node fine (EC-14b); self-loops + cycles serialize naturally — test both (EC-14d).
- [ ] Property-style test: for a generator of adversarial labels (mermaid metachars `[]{}()<>"|;%%`, unicode, newlines) assert `mermaid.parse(graphToMermaid(g))` resolves without error (import mermaid in the test, `mermaid.parse` validates syntax without rendering) — this is the strongest EC-14c proof.
- [ ] `DiagramPanel.svelte`: props `{ result: GraphResult | null, state: 'idle'|'loading'|'error'|'declined' }`; lazy `import('mermaid')` on first render; `mermaid.initialize({ securityLevel: 'strict', startOnLoad: false })` (EC-14j); before/after side by side; click → full-screen overlay (`<dialog>`) with Esc/click-out close (EC-14k); `track('diagram_viewed')` on first successful render. Component test: overlay opens/closes; strict securityLevel asserted via the initialize spy.

### Task 8: AI orchestration — consent → cache → fire four tasks (REQ-12/13/15 flow, REQ-17 caller semantics)

**Files:** `src/lib/ai/run.svelte.ts`, tests.

- [ ] `createAiRun(input: { prKey: string; repo: string; isPrivate: boolean | undefined; pack: () => Promise<PackedContext>; ask: () => Promise<boolean> })` returning reactive state:
  ```ts
  { summary: PanelState<string>; attention: PanelState<AttentionResult>; diagrams: PanelState<GraphResult>; verdict: PanelState<VerdictResult>; start(): Promise<void>; retry(task): Promise<void> }
  // PanelState<T> = { status: 'idle'|'no-key'|'declined'|'loading'|'streaming'|'done'|'error'; value?: T|string; error?: string }
  ```
  start(): no deepseek key → all panels 'no-key' (EC-12a); `gateAi` declined → all 'declined' (EC-11c); else pack once, then four tasks in parallel, each independently: cache hit → done + `track('ai_task_completed', {task, duration_ms, cached: true})`; miss → run (summary via llmStream with deltas appended to value while status 'streaming'), success → setCached + done + track(cached:false); failure → 'error' + `track('ai_task_failed', {task, reason})`, OTHER panels unaffected (EC-12c/EC-13g isolation — test one task rejecting while others resolve). Partial/interrupted stream NEVER cached (EC-17d/EC-12f — cache write only after complete success; test: stream throws after deltas → getCached returns null, status 'error', retry available). retry(task) re-runs just that task.
- [ ] Verdict's notAnalyzed = union of PackedContext.notAnalyzed + model's own list (EC-15c).
- [ ] Tests: all of the above with stubbed llm/cache/consent (DI via optional deps param, Plan A loader pattern).

### Task 9: Understand step + context rail + attention integration (REQ-12/13/15 UI, REQ-20e, EC-06h)

**Files:** `src/components/UnderstandStep.svelte`, `src/components/ContextRail.svelte`, modify `src/components/InspectStep.svelte`, `src/routes/Review.svelte`; tests.

- [ ] `UnderstandStep.svelte`: PR description, `CiSummary`, summary panel (streaming text), `DiagramPanel`, verdict panel (level pill + evidence list + notAnalyzed section shown only when non-empty (EC-15c/d) — strings as text nodes (EC-15e)), per-panel error/retry/no-key/declined states with "Add a key in Settings" link (EC-12a/b).
- [ ] `ContextRail.svelte`: collapsible aside (state persisted in settings), available in ALL steps: summary (collapsed expandable), mini before/after diagram (click → overlay), hotspot list (click → set step 2 AND scroll to file via element id `file-<path-slug>` — EC-20e test: click sets step + targets correct id), tests-touched count from attention.testFlags, verdict level.
- [ ] InspectStep: order files by attention.readingOrder when available (files not listed keep original order after listed ones; order entries not in the PR ignored — EC-12e test); hotspot files get a level badge + reason line; testFlags render a warning block under the file labeled **"AI-inferred — not measured coverage"** (EC-13d exact-label test); attention referencing unknown paths ignored without crash (EC-13c).
- [ ] Review.svelte: builds pack() from fetchContents+packContext+getCiSummary (CI fetched in parallel with AI start, fed to verdict prompt), creates the AI run, renders rail + steps. **EC-06h test (the Plan A deferral, now real):** render Review with AI deps stubbed to NEVER resolve → diffs in step 2 render fully while all panels show loading — assert FileDiff content present.
- [ ] `track('hotspot_clicked')` on rail hotspot click; `ci_summary_viewed` with conclusion when CiSummary renders.

### Task 10: e2e + verify script + README

**Files:** `playwright.config.ts`, `e2e/review-flow.spec.ts`, `e2e/fixtures/*` (MSW or route-interception fixtures), `.github/workflows/ci.yml` (e2e job + tokenless real-PR smoke), `scripts/verify-review123-plan-c.sh`, README.

- [ ] Playwright: chromium only; `pnpm build && pnpm preview` server. Flow spec with `page.route` interception of api.github.com + api.deepseek.com fixtures: paste URL → diff renders → AI panels populate (fixture responses) → draft a comment → verdict step shows it (submission mocked 200). Smoke spec (CI-only, tokenless): real public PR (e.g. a small merged PR on a stable public repo) → diff renders; skipped locally via env flag.
- [ ] CI: new `e2e` job (needs Playwright browser install step, runs after build).
- [ ] `scripts/verify-review123-plan-c.sh` per plan-a/b pattern covering this plan's must-have list (verify every -t pattern matches; skip() honestly otherwise).
- [ ] README: AI features section (BYO DeepSeek key, what's sent where, consent gate for private repos, caching note "revisiting a PR costs zero tokens until it changes").

---

## Definition of done
- Plan C verify script green (0 fail); plans A+B scripts re-run clean (A's EC-06h skip is REPLACED by the real test — update plan-a script's skip line to a vt block referencing the new test).
- Full suite + check + build + e2e green locally and in CI.
- Human checkpoint: real DeepSeek key on a real PR — judge prompt quality (summary usefulness, diagram sanity, verdict calibration); consent dialog on a private repo.
