# Cache the per-model performance breakdown so Step-3 table survives a cache hit

Date: 2026-06-16
Branch: `fix/cache-model-performance`

## Problem (verified)

The Step-3 "Review cost & model performance" table (`ReviewCostPanel`, fed by
`AiRun.modelPerformance`) is EMPTY on a cache hit, even though the aggregate
token total still shows.

Root cause in `src/lib/ai/run.svelte.ts`:

- `modelPerformance` getter (~line 2112) aggregates `verdictModelsState` +
  every `skillReviewsState[i].state.models`. Both are RUN-STATE, populated only
  during a FRESH run.
- On a CACHE HIT, the verdict task (cache-hit branches ~1337/1347) restores
  `verdictState.usage` but NOT `verdictModelsState`; likewise
  `executeSkillReview`'s cache-hit branches (~1815 deep / ~1832 non-deep)
  restore the result/usage but NOT `.models`.
- So cached usage feeds the total, but the per-model breakdown vanishes → empty
  table on any re-opened / previously-reviewed PR.

## Fix — companion cache entry keyed off the SAME content hash

Do NOT change the existing result / `DeepCached` cache shapes (avoids
invalidating caches + backward-compat risk). Instead store the model breakdown
as a SEPARATE cache blob keyed off the same content hash, with a `|models`
discriminant appended so it never collides with the result entry, and load it on
hit.

`cacheKey(prKey, task, PROMPT_VERSION)` — append `|models` to `task`.

### Verdict task

- **Companion key**: `cacheKey(prKey, (deep.enabled ? 'verdict|deep' : 'verdict') + '|models', PROMPT_VERSION)`.
- **On store** (after both the deep / non-deep `setCached` result sites, ~1438):
  `await setCached<VerdictModelBreakdown[]>(verdictModelsKey, verdictModelsState)`.
  `verdictModelsState` is already populated (unconditional baseline ~1399 +
  cross-verify replacement ~1430).
- **On cache hit** (both deep ~1337 and non-deep ~1347 branches): after restoring
  result/usage, add
  `verdictModelsState = (await getCached<VerdictModelBreakdown[]>(verdictModelsKey)) ?? []`.
  Old caches with no companion entry → `null` → `[]` (graceful).

### Skill reviews (`executeSkillReview`)

- **Companion key**: `cacheKey(prKey, 'skill:' + djb2(skill.content) + (deep.enabled ? '|deep' : '') + '|models', PROMPT_VERSION)`.
- **On store** (after the deep / non-deep `setCached` result sites, ~1953): also
  `await setCached<VerdictModelBreakdown[]>(skillModelsKey, skillModels ?? [])`.
- **On cache hit** (deep ~1817 and non-deep ~1834 branches): load
  `const models = await getCached<VerdictModelBreakdown[]>(skillModelsKey)` and
  include `...(models && models.length ? { models } : {})` in the restored
  `state`.

Keep everything else byte-identical. Do NOT bump PROMPT_VERSION (results
unchanged; `|models` companion key is additive, old caches degrade gracefully).

## Tests (src/lib/ai/run.test.ts)

- Verdict round-trip: run fresh (writes companion), run again same inputs →
  verdict result cache hit → assert `verdictModels` / `modelPerformance`
  non-empty after the hit, and no new verdict generation call.
- Skill review round-trip: a cached reviewer restores its `.models` so it
  contributes to `modelPerformance`.
- Backward-compat: result cache hit with NO companion `|models` entry →
  `modelPerformance` empty for that task, nothing throws, usage total unaffected.

## Gates

`pnpm check`, `pnpm test`, full e2e Playwright, `pnpm build`.
