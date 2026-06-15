# Plan M — Cross-Model Verification ("fusion beats frontier")

## Goal

After the active model generates review findings, the user's OTHER configured AI
providers independently JUDGE each finding adversarially. Only findings that
survive cross-model agreement are surfaced (tagged "✓ confirmed by N/M models");
findings only the generator believes are demoted into a collapsed "lower
confidence" group. Higher precision, less reviewer fatigue.

Default ON, but a strict no-op (byte-identical to today) unless ≥2 providers
have keys configured. Single-key users are completely unaffected.

## Where applied

The precision-critical, finding-bearing tasks ONLY:
- **Skill reviews** (`SkillReviewResult.findings`)
- **Verdict** (`VerdictResult.evidence` → file-level findings)

NOT summary / diagrams / tests / alternatives / story / attention. Respects
per-task modes (#113): a task that's `off` is never run, so never verified.
Composes with deep mode (#82): whatever findings were generated (deep or single
pass) get verified.

## Core plumbing — explicit-provider completion

`src/lib/llm/llm.ts`:
- New `ProviderConfig = { providerId, model: LlmModelDef, key: string }`.
- `llmJsonWithRepairFor<T>(cfg, opts, validate)` — same two-attempt JSON-repair
  loop as `llmJsonWithRepair`, but routes through the transport adapters of an
  EXPLICITLY specified provider config rather than the active one. Reuses the
  existing `openaiCompatComplete` / `anthropicComplete` / `geminiComplete`
  adapters via a key/provider override (the key is passed in, not read from
  settings, so a verifier provider's key is used). OpenAI still goes via the
  `/api/llm/openai` proxy (its `baseUrl`).
- Internals refactored so the transport adapters accept an explicit
  `{ key }` override; the active-config path passes `getKeyForProvider(...)`.

`src/lib/llm/config.ts`:
- `verifierProviderConfigs(): ProviderConfig[]` — every provider with a key set,
  EXCLUDING the active generator provider, in `PROVIDERS` order, capped at 3.
  Each uses that provider's default model.

## Verification engine — `src/lib/ai/crossVerify.ts`

Input: generated findings (`{ id, path, line, body, severity }`), the relevant
code context per finding (coachContext-style `excerpt` + bounded `fileWindow`),
and verifier provider configs.

For each verifier (in PARALLEL): send findings + context, ask it to judge each
finding ADVERSARIALLY — `{ id, verdict: 'confirm'|'refute'|'uncertain', reason }`.
Framing defaults to refute/uncertain unless clearly a real, code-grounded issue
(mirrors review-swarm adversarial-verify + evidence-discipline calibration).
JSON via `llmJsonWithRepairFor`.

Aggregate per finding:
- The generator counts as **1 confirm** (it raised it).
- Each verifier adds confirm (1) / refute (0) / uncertain (0.5).
- `score = (generatorConfirm=1 + Σ verifier weights)`, `polled = 1 + #verifiers`.
- **Threshold: SURFACE iff `score >= polled / 2`** (≥ half of all polled models,
  generator included, with uncertain as a neutral half-vote). Otherwise DEMOTE.
  Intent: convergence surfaces, divergence demotes. A single-verifier refute on
  a generator-only finding → score 1 / polled 2 → 1 >= 1 → still surfaced (tie
  goes to surface; one dissent isn't enough to bury). Two refutes → 1/3 <1.5 →
  demoted. A refute that drops below half demotes; all-confirm always surfaces.
- Carry `verification = { confirmedBy, polledModels, surfaced, perModel: [...] }`
  on each finding. `confirmedBy` = count of confirm votes (incl. generator).

Graceful: a verifier call that throws is skipped (its vote omitted, `polledModels`
decremented); never blocks. If ALL verifiers fail → findings shown unverified
(no `verification` attached → no chip, no demotion), with the original findings
fully intact.

## Settings + gating — `src/lib/settings/settings.ts`

- New `crossModelVerify: boolean`, DEFAULT **true**. Coerced + setter
  `setCrossModelVerify`, mirroring `storyMode`.
- `crossModelVerifyEffective()` helper (config.ts): true iff
  `crossModelVerify` AND `verifierProviderConfigs().length >= 1` (active + ≥1
  other). With 0–1 keys → false → engine is a strict no-op.

## Integration — `src/lib/ai/run.svelte.ts`

After skill/verdict findings are generated (BEFORE caching), if
`crossModelVerifyEffective()`:
- build per-finding code context (reuse `buildCoachCodeContext` via a new
  `verifyCodeContext` input callback that owns files+contents, same as
  `coachCodeContext`),
- run `crossVerify(...)`, attach `verification` to each finding, report progress
  via the panel `activity` channel ("Cross-checking with {Names}…"),
- fold verifier usage into the task's `usage` (so totals + footer include it).
- Cache the VERIFIED result (cache key already carries PROMPT_VERSION; verified
  output is part of the cached value). Partial/failed verification → cache the
  unverified findings (so we don't persist a half-verification).

## UI

- `SkillFindingCard`: new optional `verification` prop → "✓ confirmed by N/M
  models" chip (reuses `.skill-state-chip` styling) with a `title` tooltip
  listing per-model verdicts.
- `InspectStep` / verdict: split findings into surfaced vs demoted; demoted go
  into a collapsed `<details>` "Lower confidence — flagged by 1 model, not
  confirmed by others (K)" group (native details/summary pattern). Never dropped.
- `AiProgress`: the "Cross-checking with {ProviderNames}…" line rides the
  existing `activity` channel.
- Token cost (#90/#97): verifier usage already folded into task usage → existing
  `showTokenCost` footer reflects it.

## Caching

Verification rides the existing per-task cache value (keyed by finding-set +
verifier ids via the PROMPT_VERSION bump). Re-opening a PR returns the cached
verified findings — no re-verify. Partial/failed verification is not cached as
"verified" (we cache the plain findings instead).

## Eval — `eval/` + `src/lib/eval`

- `harness.ts`: `RunCaseOptions.crossVerify?: boolean` + an injected
  `verify?: VerifyFn` (mirrors `CompleteFn`). When set, after producing findings
  run a mock/live verify pass and DROP demoted findings before scoring, so
  precision/recall/noise-rate are measured WITH verification.
- `run-eval.mts`: `--cross-verify` flag; live mode wires real verifier configs.
- `eval/README.md`: how to compare with/without (`pnpm eval -- --cross-verify`).

## PROMPT_VERSION

Bump 17 → **18** (new verify prompt + verified-result cache shape). Invalidates
cached skill/verdict results so they re-run and verify under the new shape.

## TDD coverage

- `llm.test.ts`: `llmJsonWithRepairFor` routes to the specified provider's
  transport with the passed key (per-provider fixtures).
- `crossVerify.test.ts`: aggregation (generator+verifiers → confirmedBy/threshold/
  surface-vs-demote), uncertain = half, a refuted finding demoted, all-confirm
  surfaced, verifier-failure skips a vote, all-fail → unverified passthrough.
- `config.test.ts`: `verifierProviderConfigs` excludes active, caps at 3, order;
  `crossModelVerifyEffective` gating (<2 keys → false).
- `settings.test.ts`: `crossModelVerify` default true + coercion.
- run integration: skill/verdict findings carry verification when effective;
  no-op byte-identical when <2 keys.
- eval: cross-verify scorer path (mock) drops demoted findings.
- UI: confirmed chip renders; demoted collapsed group; single-key → no chip.
- e2e: 2-provider fixture → confirmed chip + demoted group; single-key → no
  cross-verify UI.
