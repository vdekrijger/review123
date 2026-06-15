# Plan O — Fusion v2: Multi-Generator Recall + Diverse Verifier Lenses

Status: in progress · Branch `feat/fusion-v2-multigen` · Builds on Plan M (#128/#130
cross-verify) + Plan N (#133 configurable ensemble).

## The gap

Plan M/N fusion is **precision-only**. The active model is the sole generator;
verifiers can only PRUNE its findings, never SURFACE what it missed. So the real
"fusion beats frontier" win — RECALL from independent generators — is absent. A
real bug only model B would catch is never raised, because only model A generates.

## The win

Two orthogonal upgrades, each gated and back-compat:

- **Part A — Multi-generator (recall):** every ensemble participant generates
  findings independently; the union is dedup-merged (`raisedBy: string[]`); each
  merged finding is cross-confirmed by the models that did NOT raise it. A finding
  one model raised and others confirm now SURFACES (recall win); one others refute
  demotes.
- **Part B — Diverse verifier lenses (decorrelation):** each verifier gets a
  distinct lens (`correctness`/`security`/`performance`/`reproducibility`/
  `maintainability`) rather than the same adversarial prompt — decorrelating
  verifier errors (review-swarm perspective diversity).

## Gating / back-compat (the spine)

- New setting `fusionMode: 'verify' | 'generate'`, **default `'verify'`**. In
  `'verify'` mode everything is **byte-identical to #130/#133**: single generator
  (active model) + verifiers, same prompts (lenses are layered so `'verify'` keeps
  the existing adversarial prompt OR adopts lenses — see Part B note), same
  aggregation.
- `'generate'` activates multi-gen **only when the ensemble has ≥2 participants
  AND ≥2 keyed models** AND `crossModelVerifyEffective()`. Single-model /
  single-key users: untouched.
- Composes with per-task modes (#113 / Plan J) and deep (#82): each generator can
  be deep; multi-gen only changes WHO generates, not the per-task run decision.
- Cost: `'generate'` is N generations + N×(N−1) verifications. The
  `ENSEMBLE_RUNAWAY_BACKSTOP` (20) still caps participants; settings copy WARNs
  clearly that `'generate'` with many models is expensive.
- `PROMPT_VERSION` bump (18 → 19): new generator-union framing + per-lens verify
  prompts change cached-result shape. Cache keys already include `PROMPT_VERSION`,
  so the bump invalidates Plan M/N cached findings cleanly. `'verify'`-mode users
  re-run once under the new shape but get identical results.

## Part A — Multi-generator merge/dedup

### Dedup approach (shared with the eval scorer)

Findings from different generators referring to the SAME issue collapse into one.
Match = **same file** AND **line proximity ±N** AND **fuzzy description Jaccard ≥
threshold** — exactly the eval scorer's `isMatch` shape (`src/lib/eval/scorer.ts`:
`isMatch`, `descOverlap`, `tokenize`). Extract the pure predicate into a shared
helper `src/lib/ai/findingMatch.ts` (`findingsMatch(a, b, cfg)`), and have
`scorer.ts` re-export/use it so there is ONE matching definition. Defaults:
`lineTolerance: 3`, `descOverlapThreshold: 0.12` (the scorer's `DEFAULT_MATCH_CONFIG`).

Merge: group findings transitively (union-find by pairwise match). Each group →
one finding, attributed to all raisers: `raisedBy: string[]` (provider ids /
display names). Representative finding = highest-severity raiser's body+anchor
(ties → first). Severity = max across the group.

### Cross-confirm the merged union (generalized threshold)

The current `aggregateFinding` counts the generator as 1 implicit confirm + verifier
votes, surfacing iff `score >= polled/2`. Generalize to **multiple raisers**:

- Each finding has a set of raisers (≥1). The models that did NOT raise it VERIFY
  it (the raisers are implicit confirms).
- `score = (#raisers) + Σ verifierVoteWeight + 0.5×uncertain`, `polled = #participants`.
- `surfaced = score >= polled/2`.

So a finding ONE model raised but OTHERS confirm now surfaces (recall); one model
raised + others refute demotes. This is a strict generalization: with 1 raiser +
verifiers it reduces to today's formula. New fn `aggregateMultiRaiser(raisers,
verifierVotes, totalParticipants)` in `crossVerify.ts`; keep `aggregateFinding`
as the 1-raiser delegating wrapper (so Plan M tests stay green and `'verify'` mode
is unchanged).

`FindingVerification` gains nothing structurally required, but we extend the UI
signal: `raisedBy: string[]` lives on the finding (schemas: `SkillFinding.raisedBy?`,
verdict evidence parallel map). `perModel` already lists generator-vs-verifier
verdicts; raisers map to implicit `confirm`.

### Per-model impact extends (recall headline)

A generator's impact now includes findings IT uniquely surfaced (raised alone +
survived) that others missed — `uniqueCatch: number`. `VerdictModelBreakdown` /
`VerifierImpact` (and `modelImpact.ts` formatter) gain `uniqueCatch`; the headline
in `ModelBreakdownTable` reads e.g. "caught 2 the others missed". In `'verify'`
mode `uniqueCatch` is 0/absent (single generator), so the breakdown is unchanged.

## Part B — Diverse verifier lenses

Lens set, rotated in order, cycling if >5 verifiers:
`['correctness', 'security', 'performance', 'reproducibility', 'maintainability']`.

- `buildVerifyPrompt(findings, lens?)` gains an optional lens param; when present,
  the system prompt is specialized to judge each finding THROUGH that lens (e.g.
  security: injection/authz/secrets; reproducibility: "would this actually trigger?
  grounded in the diff?"). The verdict schema (confirm/refute/uncertain + reason)
  is UNCHANGED — only framing differs.
- Lens assignment: `assignLenses(verifierCount) → Lens[]` (K verifiers → K distinct
  lenses, cycling). New helper `src/lib/ai/lenses.ts`.
- Record each verifier's lens: `VerifierImpact.lens`, `ParticipantUsage` /
  breakdown carry it so the UI shows "Sonnet (security lens): refuted 1".
- **`'verify'`-mode behavior:** lenses are layered into BOTH modes (decorrelation
  helps verify too). To keep #130 byte-identical, gate lens framing behind
  `fusionMode === 'generate'` initially — `'verify'` keeps the existing adversarial
  prompt (lens `undefined`). (Documented as a deliberate scope line; flipping lenses
  on for `'verify'` is a one-line follow-up once eval validates no precision regress.)

## Eval — measure the recall lift

Extend `eval/run-eval.mts` + `src/lib/eval/harness.ts`:

- New flag `--fusion generate` (and keep `--cross-verify` for the verify pass).
- In `'generate'` mode the harness runs the review tasks under ≥2 simulated
  generators (mock: per-generator response maps `mock/responses.<gen>.json`,
  falling back to `responses.json`; live: same provider twice as a stand-in, like
  the existing single-verifier simplification), dedup-merges via `findingsMatch`,
  cross-confirms, then scores. Golden cases have known-real findings; multi-gen
  should catch MORE of them → measurable **recall lift** vs single-gen.
- Document in `eval/README.md`: run `pnpm eval -- --live` (single-gen baseline) vs
  `pnpm eval -- --live --fusion generate` and compare recall. This validates the win.

## UI

- Settings AI-models (`AiModelsSection.svelte`): add a `fusionMode` control
  (Verify / Generate) with honest cost copy ("Generate: every model also writes
  findings — higher recall, more tokens; expensive with many models"). Disabled /
  no-op hint when <2 keyed models.
- Findings: where multi-raised, show "raised by A,B · confirmed N/M"; recall
  headline in per-model impact ("caught X others missed"). Demoted group unchanged.

## TDD coverage

1. **Dedup/merge** (`findingMatch.test.ts`, `crossVerify.test.ts`): two generators'
   overlapping findings merge with `raisedBy=[A,B]`; non-matching stay separate.
2. **Multi-raiser surface** (`crossVerify.test.ts`): a finding 1 model raised + others
   confirm SURFACES; raised + others refute DEMOTES; 1-raiser path == today.
3. **Lens assignment** (`lenses.test.ts`): K verifiers → K distinct lenses; >5 cycles;
   prompt carries the lens framing (`buildVerifyPrompt` with lens includes lens text).
4. **fusionMode gating** (`crossVerifyConfig.test.ts` / `run.test.ts`): `'verify'`
   default byte-identical; `'generate'` needs ≥2 keyed models, else falls back to verify.
5. **Impact unique-catch** (`modelImpact.test.ts`): formatter shows "caught X the
   others missed".
6. **Eval recall** (scorer/harness test): `--fusion generate` catches more known-real
   than single-gen on a golden case.
7. **e2e** (`e2e/cross-model-verify.spec.ts` extension): a 2-model `'generate'`
   ensemble where model B raises a finding A missed and A confirms → surfaces with
   "raised by B · confirmed 2/2".

## Gates (all four, before push)

`pnpm check && pnpm test && E2E_PORT=4927 pnpm exec playwright test && pnpm build`
— capture playwright's own exit code. Re-merge main + rerun all if the seam moves.

## Files touched (anticipated)

- `src/lib/ai/findingMatch.ts` (new) — shared `findingsMatch` predicate.
- `src/lib/ai/lenses.ts` (new) — lens set + `assignLenses`.
- `src/lib/ai/crossVerify.ts` — `buildVerifyPrompt(lens?)`, `aggregateMultiRaiser`,
  multi-gen merge in `crossVerify` (or a new `fuseGenerate`), `VerifierImpact.lens`,
  `uniqueCatch`.
- `src/lib/llm/config.ts` — `fusionMode` resolution helper, gating.
- `src/lib/settings/settings.ts` — `fusionMode` field + default + migration.
- `src/lib/ai/schemas.ts` — `raisedBy?`, breakdown `uniqueCatch`/`lens`.
- `src/lib/ai/run.svelte.ts` — multi-gen path in verdict + skill review when
  `fusionMode==='generate'`; impact wiring.
- `src/lib/ai/modelImpact.ts` + `ModelBreakdownTable.svelte` — unique-catch headline,
  lens label.
- `src/components/settings/AiModelsSection.svelte` — fusionMode control + cost copy.
- `src/lib/eval/scorer.ts` (use shared matcher) + `harness.ts` + `eval/run-eval.mts`
  + `eval/README.md` — `--fusion generate` recall measurement.
- `src/lib/ai/tasks.ts` — `PROMPT_VERSION` 18 → 19.
- Tests as listed above.
