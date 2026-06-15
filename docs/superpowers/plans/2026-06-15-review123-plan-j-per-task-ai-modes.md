# Review 1-2-3 — Plan J: Per-task AI mode controls (save tokens)

> **For agentic workers:** Established patterns are law. Don't change WHAT a task produces — only
> WHETHER and HOW DEEP it runs. Off = zero tokens for that task (no LLM call, no context pack/fetch,
> no cache read). The single global `aiDeepReview` toggle is replaced by a per-task matrix; the old
> all-deep / all-standard behavior must remain reproducible.

**Goal:** Today one `aiDeepReview: boolean` governs the deep harness for ALL deep-capable tasks, and
every auto task always runs — burning tokens on tasks the user doesn't want. Give the user per-task
control: enable/disable each task AND choose harness depth per task, integrated into the EXISTING
"AI models" settings section.

## Model (the rule)

New setting `aiTaskModes: Record<AiTaskId, Mode>` in `settings.ts`.

- `AiTaskId` = the AUTO tasks that run on PR open — `summary, attention, diagrams, tests,
  alternatives, verdict` — PLUS `skills` (manual, but deep makes it the most expensive).
- `Mode = 'off' | 'standard' | 'deep'`.
- **Capability per task:**
  - `summary` — off / standard only (NO harness; it's pure description). 'deep' is never valid.
  - `attention, diagrams, tests, alternatives, verdict, skills` — off / standard / deep.
- `skills` is manual (Run-my-reviewers). 'off' disables/hides the entry; standard/deep choose depth
  when run. Keep it simple.
- `coach` stays AS-IS (manual, single-pass, already gets code context). **Out of scope — NOT in the
  matrix.** ask/story are likewise not user-facing here; `story` keeps reading `aiDeepReview`-derived
  depth via the matrix only insofar as it already shares the deep harness — see Run gating.

### Defaults (preserve today's behavior)

Every task `'standard'`; none `'off'`; none `'deep'` (deep stays opt-in). With defaults, behavior is
byte-identical to today's `aiDeepReview === false`.

### Migration (one-time, matrix becomes source of truth)

On load/coerce: if legacy `aiDeepReview === true` AND no explicit `aiTaskModes` is stored, set the
deep-capable tasks (`attention, diagrams, tests, alternatives, verdict, skills`) to `'deep'` and
`summary` to `'standard'`. This maps the old boolean → matrix once. After that the matrix is the
source of truth. We REPLACE `deepReviewAvailability(deepReview)`'s read of `aiDeepReview` with a
per-task mode resolution; `aiDeepReview` is no longer read for run decisions (kept as a coerced field
only for back-compat migration input, then ignored).

### Coercion / validation

Coerce `aiTaskModes` like other settings: per-key, accept only valid modes for that task (drop
invalid; `summary='deep'` coerces to `'standard'`). Merge over defaults so unknown/missing keys fall
back to `'standard'`. Reactive via `settingsState` (already auto-refreshes). New setter
`setAiTaskMode(task, mode)` + helpers for the quick-set rows.

## Run gating (`src/lib/ai/run.svelte.ts`)

New `PanelStatus` member `'disabled'`. Each auto task's run function consults its mode FIRST:

- `'off'` → DO NOT run: no LLM call, no context fetch/pack for that task, no cache read. The task's
  PanelState goes straight to `status: 'disabled'`. In `start()`, gate each task before
  `Promise.all`; a task that is off short-circuits to `disabled` without touching `pack()`/`ci()`.
  Optimization: in `start()`, if EVERY task that needs the packed context is off, skip `pack()`
  entirely (cheap win — guard the `getPackedContext()` call).
- `'standard'` → single-pass (current non-deep path).
- `'deep'` → harness path for capable tasks. Deep STILL also requires a key + tool-capable model
  (keep the existing availability check); if a task is set `'deep'` but the model can't do tools,
  fall back to standard WITH the existing honest note.

Resolution helper: `resolveTaskMode(task, deepSource): { run: boolean; deep: boolean; note?: string }`
replacing the per-task `deepReviewAvailability(deepReview)` calls. It reads `aiTaskModes[task]` from
settings; `'off'` → `run:false`; `'standard'` → `run:true, deep:false`; `'deep'` → run the existing
tool-capability gate (model supports tools + source present) → `deep:true` or `deep:false`+note.
`summary` never resolves deep. `retry(task)` re-checks the mode (an off task's retry is a no-op that
re-asserts `disabled`). `runSkillReviews()` early-returns (no entries) when `skills` mode is `'off'`.

`setAllPanels` and the no-key/declined/error paths leave `disabled` tasks as-is is unnecessary — a
disabled task is set to `disabled` up front and the global no-key/declined sweep only runs before
task dispatch; ensure an off task ends `disabled` regardless (off wins — no tokens even to discover
no-key). Decision: set off tasks to `disabled` even on no-key/declined (off is a stronger, cheaper
state). `totalUsage` ignores disabled tasks (no usage).

## UI — disabled section state

`AiPanel.svelte` is the single shared wrapper for summary/attention(rail)/diagrams/tests/
alternatives/verdict. Add a `{:else if state.status === 'disabled'}` branch rendering a COMPACT muted
state: "Disabled — enable in AI settings" with a link to `/settings` (reuse the existing
`goToSettings` handler / settings-return-to pattern). NO skeleton, NO spinner, NO empty — it's
intentionally off. The section header stays present (callers already render the header/`<summary>`
around `AiPanel`), so the user sees the section exists and is off.

ContextRail Hotspots block reads `run.attention.status` directly — add a `disabled` branch there too
(compact muted line, no skeleton). InspectStep skills area: when `skills` is off, the Run button is
hidden and a compact muted "Reviewers disabled — enable in AI settings" line shows (don't render the
skill-run affordance).

**Merge-seam:** the new `'disabled'` status must coexist with the section-status indicators from
`feat/expand-all-section-status` and the reviewer layout from `feat/organize-reviewer-run`. When
re-merging main, keep ALL features: a disabled section still shows its header + status chip (status
chip should reflect "off"/disabled, not error). Re-run every resolved test file.

## Settings UI (`AiModelsSection.svelte`)

New "What runs (and how deep)" subsection — a tidy list/table. Each task name + a 3-way segmented
control (Off / Standard / Deep), with **Deep disabled/omitted for `summary`**. Themed segmented
control consistent with the sibling controls (radios under the hood). A quick-set row:
**"Deep review: All / None / Off-all-extras"**:

- **All** → every deep-capable task `'deep'`, `summary` `'standard'` (reproduces old `aiDeepReview=on`).
- **None** → every task `'standard'` (reproduces old `aiDeepReview=off`).
- **Off-all-extras** → keep `summary`+`verdict` `'standard'`, set the rest `'off'` (minimal tokens).

Reactive save (applies immediately like the other AI-models controls — no separate Save). Optional
tiny per-row cost hint ("more tokens" for deep). Make clear Off = no tokens for that task. Both
themes. REMOVE the old single "Deep review (agentic)" checkbox (its behavior is now the All/None
quick-set + per-row Deep). `setAiDeepReview` may stay exported for back-compat but is no longer wired
in the UI.

## Analytics

If events are added, allowlist task-id + mode enums only (no content). Reuse the existing
`ai_task_completed` allowlist; if a settings-change event is added, allow `task` + `mode` enum strings
only.

## TDD (write tests first)

- **settings.test.ts** — coercion (invalid mode dropped → default; `summary='deep'` → `'standard'`;
  missing keys default `'standard'`); migration (legacy `aiDeepReview=true` + no `aiTaskModes` →
  deep-capable tasks `'deep'`, summary `'standard'`; legacy false → all `'standard'`); explicit
  `aiTaskModes` wins over legacy boolean.
- **run gating (deepRun.test.ts / run.test.ts)** — off → task never calls LLM/pack/cache, status
  `'disabled'`; standard → single-pass; deep → harness; deep-but-tool-incapable-model → standard
  fallback + note; all-extras-off → `pack()` skipped when no task needs context. Update the existing
  deep tests to seed `aiTaskModes` instead of `aiDeepReview` (keep them green).
- **AiPanel.test / panel tests** — renders the disabled state (link to settings) for an off task; no
  skeleton/spinner present.
- **AiModelsSection.test.ts** — renders per-task controls; Deep omitted for summary; changing a
  control writes the mode; quick-set All/None/Off-all-extras set the expected matrix.
- **e2e** — set diagrams Off in settings → open a PR → diagrams section shows disabled, NOT a
  skeleton, and no diagram LLM/network call fires; set a task Deep → it runs the harness.

## Gates (ALL FOUR must pass before push — capture playwright's own exit code)

```
pnpm check && pnpm test && E2E_PORT=4783 pnpm exec playwright test && pnpm build
```

## Constraints

Don't change task OUTPUT. The existing single-toggle behavior must be reproducible (All=all-deep,
None=all-standard). Both themes. Re-merge main and resolve keeping ALL in-flight features
(expand-all-section-status, organize-reviewer-run, story-snippet-polish,
test-snippet-multiline-signature); rerun all gates after each re-merge.
