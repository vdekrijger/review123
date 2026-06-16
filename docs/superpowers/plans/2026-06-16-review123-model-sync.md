# Plan: Daily automated model-lineup sync (review123)

Branch: `feat/model-sync-automation`. Goal: a daily GitHub Action that syncs the
hand-maintained LLM model lineup against OpenRouter's public models API, opens a
PR, and auto-merges it when a PAT secret is present.

## Part 1 — Extract a model catalog (behavior-preserving)

`src/lib/llm/providers.ts` currently inlines each provider's `models:
LlmModelDef[]`. Move every model entry **verbatim** into a new
`src/lib/llm/modelCatalog.ts` exporting:

```ts
export const MODEL_CATALOG: Record<LlmProviderId, LlmModelDef[]>
```

- Move the per-model pricing/deprecation comments along with the entries.
- `providers.ts` imports `MODEL_CATALOG` and `LlmProviderId`, sets each
  provider's `models: MODEL_CATALOG[id]`. Everything else (id, displayName,
  transport, baseUrl, **defaultModel**, keyHint, maxTokensParam) stays authored
  in `providers.ts`.
- `LlmModelDef`/`LlmProviderId` types stay exported from `providers.ts`;
  `modelCatalog.ts` imports them (avoids a circular type cycle since the catalog
  only needs the type, not the runtime PROVIDERS array).
- Zero behavior change → every existing test passes unchanged.

## Part 2 — `scripts/sync-models.mts`

Pure core (exported) + thin IO shell, mirroring `eval/*.mts` (Node runs `.mts`
directly; app code loaded via a throwaway Vite SSR server for extensionless
imports).

`computeCatalogSync(openrouterModels, currentCatalog) => { nextCatalog, changes }`

- Provider → OpenRouter prefix: openai→`openai/`, deepseek→`deepseek/`,
  anthropic→`anthropic/`, gemini→`google/`.
- Match our `id` to an upstream id whose part after the prefix equals our id
  (suffix match; strip upstream variant suffixes like `:free`).
- Pricing: upstream `pricing.prompt`/`pricing.completion` are per-token decimal
  strings; ×1_000_000 → `inputPer1M`/`outputPer1M`. "Changed" only beyond ~1%
  relative tolerance (avoid float churn).
- **added**: upstream models we don't list (label = humanized id,
  contextWindowTokens = upstream `context_length`, pricing from upstream).
- **pricingUpdated**: existing model whose pricing drifted (id + old/new $).
- **maybeRemoved**: catalog model with no upstream match — listed, NOT deleted
  (stays in `nextCatalog`).
- Never touch `defaultModel`. Deterministic + idempotent: stable ordering,
  empty `changes` & `nextCatalog deep-equals input` when nothing drifts.

IO shell: `fetch('https://openrouter.ai/api/v1/models')` (public, no auth),
call core; if `changes` non-empty rewrite `modelCatalog.ts` from `nextCatalog`
(valid TS, re-imports `LlmModelDef`, matches existing format) and write a
markdown summary to stdout + `model-sync-changes.md`. Print a "no changes"
marker + exit 0 when nothing drifts.

## Part 3 — `scripts/sync-models.test.ts` (vitest, pure core, no network)

added; pricing drift > tol → pricingUpdated; within tol → no change; absent
upstream → maybeRemoved AND still in nextCatalog; defaultModel/provider fields
untouched; no-drift → empty changes + nextCatalog deep-equals input.

## Part 4 — `.github/workflows/model-sync.yml`

- `schedule: cron '0 6 * * *'` + `workflow_dispatch`.
- checkout, pnpm/action-setup, setup-node (22, matching CI), install,
  `node scripts/sync-models.mts`.
- `git diff --quiet` clean → log "no drift", end.
- changed → sanity gate `pnpm check && pnpm test && pnpm build` (no e2e).
  gate fail → open PR WITHOUT auto-merge, stop.
- gate pass → commit to `chore/model-sync` (force-updatable), author
  `akatchi <akatchi@codekrijger.io>`, body from `model-sync-changes.md`,
  open/refresh PR.
- Auto-merge: if `secrets.MODEL_SYNC_TOKEN` set → create PR with that PAT (so
  required ci/e2e checks fire) + `gh pr merge --auto --merge`. Else open with
  `GITHUB_TOKEN` for 1-click manual merge + log the hint. Documented in a
  header comment.

## Gates
`pnpm check`, `pnpm test`, Playwright e2e (`CI=1 E2E_PORT=4281 pnpm exec
playwright test`), `pnpm build`. actionlint unavailable → workflow reviewed by
hand.
