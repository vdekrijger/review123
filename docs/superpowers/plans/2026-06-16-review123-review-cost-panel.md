# Plan — Consolidated "Review cost & model performance" panel (Step 3)

Date: 2026-06-16 · Branch: feat/consolidated-review-cost-panel

## Problem
Per-model AI cost + performance is scattered across the three steps:
- the verdict task's per-model "Models used" table is on **Step 3** (`VerdictStep`),
- the reviewers' per-model tables are on **Step 2** (`InspectStep`),
- the aggregate token total is on **Step 1** (`UnderstandStep`).

Worse: the Step-3 verdict table only renders when the verdict produced EVIDENCE
rows that got cross-verified. On an evidence-free verdict (or a single-model
run) it is blank even though the verdict ran and cost tokens. Users look at
Step 3 ("Verdict") for "what did this review cost / which models earned their
keep" and find nothing.

Goal: build ONE consolidated panel on Step 3 that shows the whole review's cost
+ per-model performance (verdict generator/verifiers + every reviewer's models,
aggregated), and fix the always-blank verdict generator row.

## FIX A — verdict always records its generator row (`run.svelte.ts`)
Today `verdictModelsState` is set ONLY inside
`if (crossModelVerifyEffective()) { … if (verdictVerify.byId.size > 0) { … } }`.
So with no evidence (or no ensemble), no row is recorded.

Change in `runVerdictTask` (~line 1382, right after `finalResult` is built):
- Hoist `const generatorUsage = verdictUsage` (generation usage, captured BEFORE
  any verifier usage is folded in) OUT of the `if (crossModelVerifyEffective())`
  block.
- Set a baseline `verdictModelsState = buildVerdictModels(generatorUsage, 0, [], [])`
  UNCONDITIONALLY. `buildVerdictModels` already emits a GENERATOR row first.
- Keep the existing fuller `buildVerdictModels(generatorUsage, surfacedCount, …)`
  call inside `if (verdictVerify.byId.size > 0)` — it REPLACES the baseline with
  generator + verifier rows when evidence was cross-verified.

Net: the verdict's generator (model + generation cost) is always recorded;
verifier rows are added when they ran.

NOTE (pre-existing behavior, unchanged): the cache-hit early-return path does
NOT populate per-model data — per-model data is not cached today. Left as-is.

## FIX B — consolidated aggregate
1. **Pure aggregation helper** — new module `src/lib/ai/modelPerformance.ts`
   exporting `aggregateModelPerformance(rowSets: VerdictModelBreakdown[][]): VerdictModelBreakdown[]`.
   Flattens all rows, groups by `${providerId}:${modelId}:${role}`, summing:
   `usage` (via `addUsage`), `surfaced`, `uniqueCatch` (generators), and
   `impact.confirms/refutes/uncertains/decisive` (verifiers). Omits `lens`
   (varies per task). Stable order: all generators first then verifiers, each
   sorted by providerId then modelId. Empty input → empty.
2. **AiRun getter** — add `modelPerformance: VerdictModelBreakdown[]` to the
   `AiRun` interface and implement the getter by aggregating `verdictModelsState`
   together with every `skillReviewsState[i].state.models ?? []`.

## Component — consolidated panel on Step 3
- New `src/components/ReviewCostPanel.svelte`:
  1. Aggregate headline: total tokens (+ $ when `settingsState.current.showTokenCost`)
     from `totalUsage` via `formatUsageLabel` — matches the UnderstandStep
     pattern. Label: "This review used … total".
  2. Per-model breakdown via the EXISTING `ModelBreakdownTable`
     (`models={modelPerformance} showCost={showTokenCost} title="Model performance" compact`).
  - Renders only when `modelPerformance.length > 0` OR there is usage to show.
  - Props: `modelPerformance: VerdictModelBreakdown[]`, `totalUsage: LlmUsage | undefined`.
- `VerdictStep.svelte`: REPLACE the verdict-only
  `<ModelBreakdownTable models={verdictModels} … title="Models used" />` with
  `<ReviewCostPanel {modelPerformance} {totalUsage} />`. Drop the now-unused
  `verdictModels` prop (replaced by `modelPerformance` + `totalUsage`). Keep the
  per-reviewer per-model tables on Step 2 (InspectStep) UNTOUCHED.
- `Review.svelte`: pass `modelPerformance={aiRun ? aiRun.modelPerformance : []}`
  and `totalUsage={aiRun ? aiRun.totalUsage : undefined}` (replacing `verdictModels`).

## Tests
- `modelPerformance.test.ts` — sums usage + surfaced/uniqueCatch (generators) and
  confirms/refutes/uncertains/decisive (verifiers) across row-sets by
  (provider,model,role); a model present as generator in one set and verifier in
  another → TWO rows; same (model,role) across sets → summed; empty → empty;
  ordering generators-then-verifiers, stable.
- `run.svelte.ts` behavior — a verdict run with NO evidence still yields a
  `verdictModels`/`modelPerformance` generator row carrying the generator's
  `usage` (role==='generator', usage present).
- `ReviewCostPanel` component — renders the aggregate total + a per-model row;
  cost column/$ only when `showTokenCost` on, impact always.
- Update VerdictStep + e2e assertions on the old "Models used" / `verdictModels`
  to target the new panel (same commit).

## Gates (from worktree root)
`pnpm check` (0 errors); `pnpm test`; full e2e
`CI=1 E2E_PORT=4283 pnpm exec playwright test`; `pnpm build` (exit 0).
