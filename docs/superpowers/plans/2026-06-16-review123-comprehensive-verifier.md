# Comprehensive verifier — retire per-lens verification

Date: 2026-06-16
Branch: `feat/comprehensive-verifier`

## Decision (already made)

Cross-model verification currently assigns each verifier a ROTATING lens
(correctness → security → performance → reproducibility → maintainability,
`verifier[i] → LENSES[i % 5]`) so each judges a finding through ONE narrow
perspective. This is REPLACED: every verifier now gets the SAME strong,
COMPREHENSIVE adversarial check that weighs ALL dimensions at once.

Rationale: content-blind lens rotation can suppress a valid finding (a real
SQL-injection bug judged only through the `maintainability` lens gets refuted).
Decorrelation should come from MODEL/PROVIDER diversity, not from blinkering
each judge. The per-lens machinery (incl. the verify-tooltip lens tag) is retired.

## Part 1 — Comprehensive verify prompt (`src/lib/ai/crossVerify.ts`)

- `buildVerifyPrompt(findings)` takes NO `lens`. It ALWAYS uses ONE comprehensive
  adversarial framing instructing the verifier to judge each finding skeptically
  across correctness, security, performance, reproducibility, AND maintainability
  — reusing the concrete per-dimension wording previously in `lensFraming`,
  concatenated into one prompt so the quality phrasing is preserved. Confirm ONLY
  when the code clearly shows a real defect under ANY dimension; default to
  refute/uncertain when unsure. Response schema unchanged (confirm/refute/
  uncertain + ≤1-sentence reason).
- Remove the `lens` param from `buildVerifyPrompt`, the `VerifyFn` signature, and
  `crossVerify`/`fuseConfirm` + every verify call site.
- Remove `lens` from the `perModel` `FindingVerdict` rows (`aggregateFinding`,
  `aggregateMultiRaiser`), from `VerifierVote`, `VerifierImpact`, and the
  responder-lens plumbing inside `crossVerify`/`fuseConfirm`.

## Part 2 — Retire the lens plumbing

- `src/lib/ai/lenses.ts`: delete the file (its dimension text folds into the
  comprehensive prompt). Remove every import of it.
- `src/lib/ai/run.svelte.ts`: drop the `assignLenses` import and every
  `assignLenses(...)` call (~503/626/687/780/784). `buildFusionModels(...)` and
  `buildVerdictModels(...)` drop their lens arg/handling. `VerdictModelBreakdown`
  loses `lens?`. `realVerify` drops the lens param.
- `src/lib/ai/schemas.ts`: remove `lens?` from `FindingVerdict`.
- `src/lib/ai/modelImpact.ts`: drop `Lens` import, `lens?` on `VerifierImpactRow`,
  the `lensPrefix`, and `formatLensLabel` (unused after removal → noUnusedLocals).
- `src/lib/ai/modelPerformance.ts`: drop the "drop lens" comment/logic (no lens to
  drop anymore).
- `src/components/SkillFindingCard.svelte`: verifier rows show model + verdict +
  reason, NO lens tag. The generator/raiser row still shows the "raised it"
  indicator. Keep the rest of the readable tooltip.
- `src/components/ModelBreakdownTable.svelte`: drop the `lens: m.lens` spread.
- Grep whole repo (`src/` + `e2e/`) for lens plumbing and remove/adjust each.
  NOTE: leave natural-language "No significant issues from this lens." phrasing
  in `builtinSkills.ts` / `tasks.ts` (skill prompts) — unrelated to the plumbing.

## Part 3 — Cache invalidation

- Bump `PROMPT_VERSION` (`src/lib/ai/tasks.ts`) 20 → 21 so cached lens-based
  verifications re-run under the comprehensive prompt. Add a PROMPT_VERSION 21
  note. Update the `tasks.test.ts` PROMPT_VERSION assertion.

## Tests

- `crossVerify.test.ts`: prompt no longer varies by lens; assert ONE comprehensive
  prompt references multiple dimensions (e.g. "security" and "performance");
  `perModel` rows carry NO lens; drop the lens-threading test.
- `SkillFindingCard.test.ts`: per-vote rows show model + verdict + reason, no lens
  tag; generator row still "raised it". Drop `lens` from fixtures.
- `modelImpact.test.ts` / `modelPerformance.test.ts`: drop lens-prefix / lens-omit
  assertions.
- `crossVerify`/fuseConfirm call-shape tests drop the lens arg.
- Delete `lenses.test.ts`.

## Gates

`pnpm check` (0 errors, no unused after removals), `pnpm test`, full e2e
(`CI=1 E2E_PORT=4299 pnpm exec playwright test` — capture exit code; real-pr smoke
may flake locally), `pnpm build`. Commit as `akatchi <akatchi@codekrijger.io>`,
push, PR to main, `gh pr merge --auto --merge`.
