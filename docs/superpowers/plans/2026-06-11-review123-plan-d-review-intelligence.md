# Review 1-2-3 — Plan D: Review Intelligence

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Established codebase patterns apply (typed results, DI seams, TDD, allowlist analytics). Contracts below are binding; implementation follows existing module conventions.

**Goal (user-driven, from real-PR usage):** (D1) a visual change-map graph that colors what changed/moved/stayed; (D2) an AI test-insight panel ("what do the tests actually cover?"); (D3) per-file viewed-state that survives revisions intelligently + "what changed since my last visit" interdiff; (D4) an AI comment coach scoring drafted comments pre-submit.

**PROMPT_VERSION bumps to 4** (D1 diagram schema change + D2/D4 new tasks).

**Branch:** `feat/plan-d-review-intelligence`. Waves: {1} → {2, 5} → {3, 4, 6, 7} → {8}.

---

### Task 1: Schemas + prompts (D1/D2/D4 foundations)
`src/lib/diagram/types.ts`: Graph nodes/edges gain optional `status?: 'added' | 'removed' | 'changed' | 'unchanged'`. GraphResult gains optional `changeMap?: Graph` (single merged graph with statuses; before/after stay for the toggle).
`src/lib/ai/schemas.ts`: validators accept the new optional fields (reject invalid enum); new:
```ts
export interface TestInsight { covered: { behavior: string; test: string; file: string }[]; gaps: string[] }
export interface CommentReview { index: number; clarity: 1|2|3|4|5; actionable: boolean; tone: 'ok'|'blunt'|'harsh'; biasQuestion: string | null; suggestion: string | null }
export interface CoachResult { reviews: CommentReview[] }
```
`src/lib/ai/tasks.ts` (PROMPT_VERSION = 4): diagramsPrompt asks primarily for `changeMap` (statuses on every node/edge, ≤14 nodes) plus compact before/after; `testInsightPrompt(ctx)` — analyze changed test files: behaviors covered in plain language (≤10), gaps where behavior changed without test coverage; `coachPrompt(drafts: {index, path, line, body}[])` — per comment: clarity 1–5, actionable, tone, one anti-bias question when the comment smells like preference-stated-as-defect, optional suggested rewording. Structural tests per established pattern.

### Task 2: Orchestrator — tests panel + on-demand coach
`src/lib/ai/run.svelte.ts`: fifth PanelState `tests: PanelState<TestInsight>` running with the parallel batch (cached, isolated — all existing invariants). NEW on-demand method `coach(drafts): Promise<CoachResult | { error: string }>` — NOT part of start(); respects the same no-key/consent gates (private repos: comments may quote code); never cached (drafts change). Tests: tests-panel isolation/caching; coach gating + error mapping.

### Task 3: Change-map serializer + UI (D1)
`src/lib/diagram/mermaid.ts`: status-aware serialization — classDefs `added` (green), `removed` (red, dashed), `changed` (amber), `unchanged` (muted); edges: removed=dashed, added=thick; emit `class nX status` lines. Adversarial label tests extended for status graphs. `DiagramPanel.svelte`: change-map rendered FIRST with a legend row; before/after behind a toggle; overlay unchanged. Empty changeMap (cached v3 results) → falls back to before/after only (backward compatible).

### Task 4: Test-insight UI (D2)
`UnderstandStep.svelte` glance card: tests chip (`✓ N behaviors covered` / `⚠ M gaps`, click → expander). New collapsed details "Test coverage (AI-inferred)": covered list as a checklist (behavior — `test` in `file`, file links jump to Inspect), gaps as warning rows. Same "AI-inferred — not measured coverage" labeling rule as attention flags (EC-13d precedent). AiPanel states for loading/error/no-key.

### Task 5: Viewed-state (D3a)
`src/lib/viewed/viewed.ts`: localStorage `review123:viewed`, entries keyed `owner/repo#number` → `{ path, patchHash, viewedAt }[]` (patchHash = simple djb2 of the file's patch string; hash util exported + tested). API: `isViewed(prId, path, patch)` (true only when hash matches), `setViewed(prId, path, patch, viewed: boolean)`, `viewedCount(prId, files)`. Shape-validated, capped at 50 PRs LRU. `InspectStep/FileDiff`: "Viewed" checkbox in each file header; viewed files collapse to header-only (still expandable manually); auto-unviewed (hash mismatch → checkbox cleared + file expanded + "changed since you viewed it" badge). Sticky bar gains `viewed x/y`. Tests: hash-mismatch unview, persistence, collapse behavior.

### Task 6: Since-last-visit interdiff (D3b)
`src/lib/github/compare.ts`: `compareCommits(repo, base, head)` → GET `/repos/{o}/{r}/compare/{base}...{head}` mapped to PrFile[] (same RawPrFile mapping — reuse/extract from api.ts). `src/lib/visits/visits.ts`: localStorage last-visited headSha per PR (`review123:visits`, recorded on PR ready). `Review.svelte`: when stored sha exists ≠ current headSha → banner in Inspect: "This PR changed since your last visit (N files) — [Show only what changed]" toggle: Inspect renders compare-derived files instead of full set (mode indicator + exit toggle). Falls back gracefully when compare 404s (force-push pruned the old sha — show message, full diff). Tests: visit recording, banner logic, compare mapping, 404 fallback.

### Task 7: Comment coach UI (D4)
`VerdictStep.svelte`: above Submit, "Coach my comments" button (visible when drafts > 0 AND deepseek key present; disabled while running; private repos behind existing consent — gate via run.coach()). Results per comment card: clarity stars, tone/actionable chips, the anti-bias question (highlighted, e.g. "Is this a preference or a defect? Would you block a colleague's PR over this?"), suggestion with [Apply] (replaces draft body via store.upsert) / [Dismiss]. `track('ai_task_completed', {task:'coach',...})` (allowlist already permits task names). Never blocks submission — purely advisory. Tests: gating, apply-suggestion mutates store, advisory (submit enabled regardless).

### Task 8: Verify script D + e2e + docs
`scripts/verify-review123-plan-d.sh` (established pattern; honest skips). e2e additions to review-flow.spec.ts: tests-panel populates from fixture; viewed checkbox collapses + persists across reload; coach flow with mocked response (fixture button → suggestion applied). README: feature notes. Re-run scripts A–C (no regressions).

## Definition of done
All gates green (unit + e2e + check + build); scripts A–D pass; human checkpoint: real-PR pass judging change-map usefulness, test-insight accuracy, coach tone.
