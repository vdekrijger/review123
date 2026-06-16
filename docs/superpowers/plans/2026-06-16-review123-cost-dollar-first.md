# Plan — Dollar-first cost display + backfill missing model pricing

Date: 2026-06-16
Branch: `feat/cost-dollar-first`
Repo: vdekrijger/review123 (Svelte 5 + Vite + TS frontend-only SPA)

## Goal

Two parts, both around the Step-3 "Model performance" table (and every place per-model / aggregate cost is shown):

1. **Dollar-first display.** Make the `$` value PRIMARY (first, normal weight) and the token count SECONDARY (muted, after a separator). Today the cost cell reads `15.0k tokens · <$0.01` or just `16.7k tokens`. Flip to `$0.13 · 14.0k tokens` (dollar first). Keep `<$0.01` for sub-cent. Every row must show a `$` value: a row whose model has pricing → real computed `$`; a row whose model has NO pricing → an honest `$—` marker with a `title` tooltip ("no pricing on file for <model>"), never blank.

2. **Backfill missing pricing.** Every model in `MODEL_CATALOG` (`src/lib/llm/modelCatalog.ts`) that lacks `pricing` gets it. Source from OpenRouter's public API via `scripts/sync-models.mts`, supplemented with provider-published rates where OpenRouter has no entry. Report priced vs left-unpriced.

Cost is still gated on `settingsState.current.showTokenCost` (unchanged) — only ORDER/emphasis within the cost cell changes.

## Files

- `src/lib/ai/tokenCost.ts` — `formatUsageLabel` and `formatModelUsageLabel`: flip to `$ · tokens`.
  - New behavior: when a model has pricing → `<$cost> · <tokens> tokens`. When the model has NO pricing → in the per-model case return a sentinel so the cell can render `$—` with a tooltip. For the aggregate header (`formatUsageLabel`, prices against the active model) keep returning a string; if the active model has no pricing show `tokens` only (the aggregate "This review used …" headline — active model nearly always priced after backfill).
- `src/components/ModelBreakdownTable.svelte` — cost cell: render `$—` (with `title`) when no priced label, else the dollar-first label.
- `src/components/ReviewCostPanel.svelte` — aggregate "This review used … total" already uses `formatUsageLabel`; it inherits the dollar-first order.
- `src/lib/llm/modelCatalog.ts` — backfill `pricing` on every unpriced model.
- Tests: `tokenCost.test.ts`, `VerdictStep.test.ts` (cost-panel describe), e2e `model-ensemble.spec.ts` / `cross-model-verify.spec.ts` (cost-column assertions), plus a new `ModelBreakdownTable` dollar-first/`$—` test.

## Approach to the format util

`formatModelUsageLabel(providerId, modelId, usage)`:
- usage missing / zero → `null` (unchanged; caller renders nothing for that case — but the table always passes usage for a row that ran).
- model has pricing → `"<costLabel> · <tokens> tokens"` (dollar first).
- model has NO pricing → return a structured "unpriced" result so the cell shows `$—` + a token count, e.g. `"$— · <tokens> tokens"` with the cell adding a `title`. Simplest: return the string `$— · <tokens> tokens` and let the component attach the tooltip via the model id. Keep it a pure string return for reuse.

Decision: keep the function returning a **string** (table cell stays dumb), and have it return `"$— · 14.0k tokens"` when unpriced. The component adds `title="no pricing on file for <modelId>"` on the cell whenever the label starts with `$—`. This keeps "every row shows a $ value" honest and testable.

`formatUsageLabel(usage)` (aggregate, active-model-priced):
- pricing → `"<costLabel> · <tokens> tokens"`.
- no pricing → `"<tokens> tokens"` (no fake `$`; the active model is nearly always priced post-backfill, and `$—` in a prose headline reads worse than just tokens).

## Pricing backfill

Run `node scripts/sync-models.mts` to pull OpenRouter pricing for matched models, KEEP pricing fills on existing models, evaluate any brand-new additions (keep if reasonable, else revert to pricing-only). For ids OpenRouter has no entry for (speculative ids like `deepseek-v4-pro`, `gpt-5.2`, `claude-fable-5`, `claude-opus-4-8`), use provider-published rates where known; otherwise leave unpriced (UI shows `$—`). Report the split.

## Gates

`pnpm check` (0), `pnpm test`, full e2e `CI=1 E2E_PORT=4289 pnpm exec playwright test` (capture exit code), `pnpm build` (exit 0). Commit as `akatchi <akatchi@codekrijger.io>`, push, PR to main, auto-merge.
