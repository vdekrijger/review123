# Plan: Per-model cost drilldown that reconciles with the review total

Date: 2026-06-16
Branch: `feat/cost-drilldown`

## Problem

The Step-3 "Model performance" panel (`ReviewCostPanel.svelte`, fed by `AiRun.modelPerformance`)
shows per-model rows that only cover the verdict + each reviewer's cross-verify pass. The header
("This review used 2704k tokens · $0.39 total") sums EVERY task — including the single-pass tasks
(summary, hotspots/attention, diagrams, tests, alternatives, story, coach) that ran on the active
model. Those single-pass tasks are ~1/3 of spend and appear in NO row, so the rows don't reconcile
with the total.

## Goal

A per-model cost breakdown where:
- every model row's TOTAL is the sum of ALL its task contributions (single-pass + ensemble),
- the sum of all rows' usage === `totalUsage` (reconciliation invariant),
- each row is EXPANDABLE to a per-task list ("Summary — $X · Ntokens", dollar-first).

## Design

### 1) Pure module `src/lib/ai/modelCostBreakdown.ts`

```ts
export interface CostContribution {
  providerId: string
  modelId: string
  role: 'generator' | 'verifier'
  task: string
  usage?: LlmUsage
  surfaced?: number
  uniqueCatch?: number
  impact?: { confirms: number; refutes: number; uncertains: number; decisive: number }
}
export interface ModelCostRow {
  providerId; modelId; role
  total?: LlmUsage            // sum of contributions' usage
  surfaced?; uniqueCatch?     // summed (generator)
  impact?                     // summed (verifier)
  byTask: { task: string; usage?: LlmUsage }[]
}
export function buildModelCostBreakdown(contributions: CostContribution[]): ModelCostRow[]
```

- Group by `${providerId}:${modelId}:${role}`; sum usage (addUsage), surfaced/uniqueCatch (gen),
  impact (verifier). `byTask` in insertion order; same task appearing twice for a model merges into
  one byTask entry (so a model's byTask is one row per task).
- Stable order: generators first, then verifiers, each by providerId then modelId (matches
  `aggregateModelPerformance`).
- Pure + deterministic; empty input → empty.

### 2) `AiRun.modelCostBreakdown` getter (additive)

New getter assembling `CostContribution[]` with NO double-counting:
- Verdict: if `verdictModelsState` non-empty → one contribution per row, `task: 'Verdict'`, carrying
  row usage/role/impact/surfaced. (Don't also add verdict aggregate usage.)
- Each reviewer: if `e.state.models` non-empty → one contribution per model row,
  `task: 'Reviewer: ${name}'`. Else (single-model reviewer) → ONE generator contribution on the
  ACTIVE model, `usage = e.state.usage`, `task: 'Reviewer: ${name}'`.
- Single-pass tasks (summary/attention/diagrams/tests/alternatives/story/coach): if the verdict
  produced NO model rows (e.g. evidence-free, no-ensemble), the verdict's own `.usage` must still be
  emitted as a generator contribution. General rule: any task whose per-model rows are EMPTY emits
  ONE generator contribution on the ACTIVE model with that task's `.usage`.
- Active model = `activeLlmConfig()` `.provider.id` / `.model.id`.
- Labels: Summary, Hotspots, Diagrams, Tests, Alternatives, Story, Coach, Verdict.

KEY INVARIANT: Σ rows' total === `totalUsage`. Verified in tests.

`modelPerformance` getter kept as-is (additive change).

### 3) UI — `ReviewCostPanel.svelte`

Render `modelCostBreakdown` directly (NOT via ModelBreakdownTable — the expandable shape differs
enough that a dedicated render is cleaner; ModelBreakdownTable stays for Step-2 reviewer cards).
- Keep aggregate header.
- Top-level row per (model, role): `<button aria-expanded>` caret, model name, role, impact, and
  dollar-first total cost (reuse `formatModelUsageLabel`), gated on `showTokenCost`.
- Expanded → indented `byTask` list: "Task — $X · Ntokens" dollar-first.
- Collapsed by default; session `$state` expand map; keyboard/aria accessible.
- Cost gated on `settingsState.current.showTokenCost`; impact/role always shown.

VerdictStep passes a new `modelCostBreakdown` prop; Review.svelte wires `aiRun.modelCostBreakdown`.
Keep existing `modelPerformance` prop too (so existing tests/use stay valid) — but ReviewCostPanel
switches to driving its table off `modelCostBreakdown`. Update VerdictStep tests accordingly.

## Tests
- `modelCostBreakdown.test.ts`: grouping, byTask capture, totals, reconciliation, gen-before-verifier
  order, empty→empty.
- run.svelte test: reconciliation end-to-end; active generator row's byTask includes single-pass labels.
- ReviewCostPanel/VerdictStep test: rows render, click expands per-task list, dollar-first, gated.

## Gates
`pnpm check` (0), `pnpm test`, full e2e (capture exit code), `pnpm build` (0).

## Concurrency note (#154)
#154 edits the verdict/`modelPerformance` area. Keep run.svelte.ts edits additive (new getter +
read existing state); a textual conflict in the getters region is possible, hand-resolved.
