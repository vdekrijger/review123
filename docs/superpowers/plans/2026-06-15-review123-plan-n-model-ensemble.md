# Plan N — Configurable Model Ensemble + Per-Model Cost + Per-Model Impact

Builds on Plan M (#128 cross-model verification) + #129 eval capture. Plan M's
verifiers are implicitly "every OTHER keyed provider, default model, ≤3". Plan N
replaces that with a USER-CONFIGURED ENSEMBLE of `{ provider, model }` participants —
crucially allowing MULTIPLE models from the SAME provider — and surfaces per-model
COST and per-model IMPACT in step 3 (Verdict).

## Goal

1. Configurable ensemble: a generator + verifier list, any model from any provider,
   including multiple models of the same provider (e.g. one Anthropic key →
   opus-4-8 generate + sonnet-4-6 + haiku-4-5 verify). This is the key unlock:
   cross-verify now works with a SINGLE provider key.
2. Per-model token + $ breakdown in step 3 (gated on `showTokenCost`).
3. Per-model impact in step 3 (always when cross-verify ran): generator surfaced
   count; per-verifier confirms/refutes and **decisive votes**.

Default behaviour byte-identical for existing users until they customize the
ensemble; single-model users completely unaffected.

## Part 1 — Configurable ensemble

### Shape — `settings.ts`

```ts
interface EnsembleParticipant { provider: AiProvider; model: string }
interface AiEnsemble {
  generator: EnsembleParticipant
  verifiers: EnsembleParticipant[]
}
aiEnsemble: AiEnsemble | null   // null = use the DEFAULT (reproduces #128)
```

`null`/absent → default ensemble = `{ generator: active provider+model,
verifiers: other keyed providers' default models (PROVIDERS order, capped) }`,
i.e. byte-identical to `verifierProviderConfigs()` today. Coercion validates each
participant `{provider, model}` against PROVIDERS (drops unknown), keeps `null`
when absent. Setter `setAiEnsemble`.

### Resolution — `config.ts`

- `MAX_ENSEMBLE_PARTICIPANTS = 4` (generator + ≤3 verifiers) — bounds cost.
- `resolveEnsemble(): { generator: EnsembleParticipantConfig | null; verifiers:
  ProviderConfig[] }` — reads `aiEnsemble` (or synthesizes the default), drops any
  participant whose provider key is missing, caps total. The GENERATOR is a
  resolved participant (provider+model+key) when its key exists; otherwise the
  ensemble is unusable (generation falls back to the normal active path — Part 1
  changes verification only at the call site, generation already uses the active
  config).
- `crossModelVerifyEffective()` now: `crossModelVerify` AND
  `resolveEnsemble().verifiers.length >= 1` AND a usable generator. So a single
  Anthropic key with 2+ Anthropic models → effective (the unlock).
- `verifierProviderConfigs()` kept as a thin wrapper over `resolveEnsemble().verifiers`
  so existing call sites/tests stay green; default path returns the same configs
  as before (byte-identical).

### Generation path

Generation continues to use the active provider+model via the existing
`activeLlmConfig()` path. When a custom ensemble names a generator that differs
from the active provider/model, the verifier side uses the ensemble; the
generator's identity for aggregation/impact is taken from the ensemble's
generator participant (display label), but the actual generation call is
unchanged (keeps caching + deep-mode plumbing intact and avoids a second
generation transport). This keeps default behaviour byte-identical and bounds
scope: the ensemble's verifier list is the behavioural change.

### Settings UI — `AiModelsSection.svelte`

New "Ensemble / verification" panel:
- Participant rows: provider dropdown + model dropdown (from PROVIDERS lineups).
- A "generator" radio designates which row generates; the rest verify.
- Rows whose provider has NO key are disabled with a hint ("Add the {Provider}
  key above to use this model").
- Add/remove rows; cap at `MAX_ENSEMBLE_PARTICIPANTS`. Reactive (writes
  `aiEnsemble`).
- Cost copy: "Each model you add verifies every finding — more accuracy, more
  tokens."
- The existing crossModelVerify toggle still governs on/off; the
  `crossVerifyAvailable` derived now becomes "≥2 usable models in the ensemble"
  (single key with 2 models counts).

## Part 2 — Per-model cost (step 3)

### Per-participant usage attribution

- New `ModelUsage = { participant: { provider, model }; role: 'generator'|'verifier';
  usage: LlmUsage }` accumulated during a run.
- `crossVerify` already fans out per verifier; extend `CrossVerifyOutcome` with
  `perModelUsage: { providerId, modelId, usage }[]` (one entry per responding
  verifier, tagged with the verifier's model id — same-provider models stay
  distinct by model id).
- Generator usage = the verdict/skill generation `usage`, tagged to the ensemble
  generator participant.
- Expose `verdict.modelUsage: ModelUsage[]` (and fold per-model verifier usage)
  on the run, summed per `{provider,model}`.

### Render — `VerdictStep.svelte`

When `showTokenCost`: a compact "Models used" table — `model · tokens · $`
(generator + each verifier), plus the existing total footer. `$` from
`estimateCostUsd(model, …)` (tokens-only when no price). Omit a row with no usage
(never fabricate).

## Part 3 — Per-model impact (step 3)

### Decisiveness — `crossVerify.ts`

Add `aggregateWithImpact` / extend the outcome with per-verifier impact:
- For each verifier and each finding: record confirm/refute/uncertain.
- A verifier's vote on a finding is **DECISIVE** when removing that verifier's
  vote FLIPS the surface/demote outcome — recompute `aggregateFinding` WITHOUT
  that voter; if `surfaced` changes, the vote is decisive.
- Per verifier: `{ confirms, refutes, uncertains, decisive }` where `decisive` =
  count of findings whose outcome it flipped.
- Generator impact = count of its findings that SURVIVED (surfaced === true).

Definition of decisive (precise): for finding F with verifier set V, let
`outcomeAll = aggregateFinding(gen, V).surfaced` and
`outcomeWithout_v = aggregateFinding(gen, V \ {v}).surfaced`. Vote v is decisive
on F iff `outcomeAll !== outcomeWithout_v`. A redundant confirm on a finding that
surfaces regardless is NOT decisive; a refute that tips a finding from surface to
demote IS.

### Render — `VerdictStep.svelte`

A compact "Model impact" readout next to the cost table, shown whenever
cross-verify ran (NOT gated on showTokenCost; only the $ column is gated):
- Generator: "{model} — generator · N surfaced findings".
- Verifier: "{model} — verifier · {decisive} decisive {refute/confirm}(s)" leading
  with decisiveness, then "{confirms}c/{refutes}r" detail. A rubber-stamp verifier
  (many confirms, 0 decisive) reads low-impact.

Impact data computed in crossVerify aggregation (it already has per-model
confirm/refute per finding) and threaded onto `verdict` state.

## Constraints

- Default byte-identical until the user customizes the ensemble; single-model
  users unaffected (no ensemble → no-op).
- Analytics: model ids allowlisted (not secrets); never keys.
- Cost + impact never fabricate: missing usage → omit row; missing price → tokens
  only.
- Graceful: a participant call failing → its votes skipped; impact/cost reflect
  only what ran.
- Both themes for the new tables.

## PROMPT_VERSION

No prompt change (verify prompt unchanged) → PROMPT_VERSION stays 18. The cached
verified shape gains optional impact metadata computed at aggregation time, not
persisted in a way that changes the finding identity, so no bump needed.

## TDD coverage

- `settings.test.ts`: `aiEnsemble` default null; coercion validates participants,
  drops unknown provider/model; setter.
- `config.test.ts` (ensemble): default reproduces #128 verifier configs; custom
  multi-model same-provider ensemble; key-missing participant skipped;
  `crossModelVerifyEffective` true with single key + 2 models, false with <2
  usable.
- `crossVerify.test.ts`: per-model usage attribution (each call tagged to its
  participant; per-model totals); decisive-vote computation (a vote that flips
  surface/demote is decisive; a redundant confirm is not); generator surfaced
  count.
- `VerdictStep` (component test or e2e): per-model cost table gated on
  showTokenCost; impact readout shown when cross-verify ran.
- `AiModelsSection` (e2e): add/remove participant, designate generator, disabled
  no-key row.
- e2e: 2-Anthropic-model ensemble (single key) → cross-verify runs → confirmed
  chip + step-3 per-model cost (cost on) + impact readout.
