# Plan: Multi-generator verdict (Plan O/P 'generate' mode for the verdict task)

Date: 2026-06-16
Branch: `feat/multi-generator-verdict`

## Problem

With 2+ generators configured in the unified model panel (emergent 'generate' /
recall mode), the SKILL REVIEWS already run multi-generator fusion (each generator
finds independently, union-merged + cross-confirmed, every generator gets a
`role:'generator'` row). But the VERDICT task does NOT honor 'generate' mode: it
always runs the single-generator VERIFY path — the PRIMARY generator generates the
verdict and every other model (including the user's 2nd configured *generator*) is
treated as a VERIFIER. So the Step-3 "Model performance" table shows only ONE
generator for the verdict and demotes the user's 2nd configured generator to a
verifier, contradicting the panel config.

The user wants the verdict to honor 'generate' mode: both generators generate, the
EVIDENCE is unioned + cross-confirmed (recall), and both appear as generator rows.

## Design

Mirror the skill-review fusion path (`fuseSkillReview` + `generateMultiGen` +
`fuseConfirm` + `buildFusionModels`) for the verdict, gated identically:
`fusionGenerateEffective() && !deep.enabled`. Deep multi-gen stays out of scope —
deep keeps the current single-gen + verify path.

### What gets fused vs. what gets taken from the primary

The verdict is a HOLISTIC judgment plus an evidence list. Only the EVIDENCE is a
recall problem; the single-judgment field (`level`) is a holistic call that cannot
be meaningfully union-merged. So:

- **Evidence** (`evidence: string[]`): treat each evidence bullet as a finding,
  union across generators (reuse `mergeGeneratorFindings` → `findingMatch.ts`:
  file + ±3 line + Jaccard, union-find, raisedBy[]), cross-confirm across ALL
  participants (`fuseConfirm`, lensed), and rebuild surfaced-first. Each surviving
  evidence row carries `evidenceVerification[i]` (already in the schema) and
  `evidenceRaisedBy[i]` (already in the schema — Plan O groundwork).
- **`level`** (the single holistic judgment): take the PRIMARY generator's value
  (`resolveEnsemble().generator`, i.e. the first configured generator). We do NOT
  merge holistic judgments — the user's intent is the EVIDENCE union (recall) with
  ONE recommendation. (Documented in a code comment too.)
- **`notAnalyzed`**: union of packed-context `notAnalyzed` + the PRIMARY generator's
  `notAnalyzed` (same as today's single-gen merge).

Evidence bullets have no real `line`, so we anchor them like the existing verify
path does: `path = extractEvidencePath(bullet) ?? '(no file)'`, `line = null`,
`severity = 'medium'`. The union still dedups identical/near-identical bullets via
the description-overlap (Jaccard) leg of `findingsMatch`.

### Per-model breakdown

Reuse `buildFusionModels(participants, generatorCount, genUsageByModel,
perModelUsage, generatorImpact, lenses)` exactly as the skill-review path does, so
EACH generator gets a `role:'generator'` row (with `surfaced` + `uniqueCatch`) and
verifiers get verifier rows. Assign to `verdictModelsState`.

### Cache

The verdict already persists its breakdown to the companion `|models` cache entry.
The multi-gen breakdown is just a `VerdictModelBreakdown[]` like the single-gen one,
so it flows through the SAME `setCached(verdictModelsKey, verdictModelsState)` /
restore-on-hit path unchanged. No cache shape change.

### Byte-identical guarantee

The existing verify-mode path (single generator, or `crossModelVerifyEffective()`
without ≥2 generators) stays byte-identical — we only ADD a `fusionHandled` branch
in front, exactly like `runSkillReview` does.

## Implementation steps

1. Add `fuseVerdict(prompts, onActivity)` helper in `run.svelte.ts`, modeled on
   `fuseSkillReview`: runs each generator's verdict via `generateMultiGen`, unions
   evidence into `MergedFinding[]`, cross-confirms via `fuseConfirm`, returns the
   rebuilt `VerdictResult` (primary `level` + union evidence + `evidenceVerification`
   + `evidenceRaisedBy`) plus summed usage + `buildFusionModels` breakdown. Returns
   `null` (caller falls back) when < 2 generators produced findings/results. Never
   throws.
2. In `runVerdictTask`, after building `prompts` and inside `try`, add the
   `if (fusionGenerateEffective() && !deep.enabled)` branch that calls `fuseVerdict`
   and, on success, sets `finalResult`, `verdictUsage`, `verdictModelsState`, and a
   `fusionHandled` flag — short-circuiting the existing single-pass + verify block.
3. Leave the existing single-pass generation + `crossModelVerifyEffective()` verify
   block untouched, guarded by `if (!fusionHandled)`.
4. Tests in `crossVerifyRun.test.ts` (mirror the skill-review fusion tests):
   - 2 generators → verdict `verdictModels` has TWO `role:'generator'` rows; evidence
     from both generators unioned (a bullet only one raised still surfaces, carrying
     `raisedBy`); primary generator's `level` used.
   - verify-mode (1 generator) → unchanged.

## Gates

`pnpm check`, `pnpm test`, full e2e, `pnpm build`. No prompt text changes →
`PROMPT_VERSION` NOT bumped. Grep `src/` + `e2e/` for verify-only/single-generator
verdict assertions and update in the same commit.
