# Plan: Demo showcases the differentiator — multi-reviewer + cross-model fusion + cost

Date: 2026-06-16
Branch: `feat/demo-rich-fusion`

## Goal
Make the bundled `/demo` review SHOWCASE the product's differentiator: multiple AI
reviewer personas, cross-model verification (confirmed / demoted), multi-generator
recall ("raised by A, B"), and a Step-3 cost & model-performance panel — all
pre-generated and 100% offline (no fetch / LLM). The demo doubles as a UX testbed
that exercises the key finding/verification UI states without a real PR.

Stay in `src/lib/demo/*` + `Demo.svelte` + the demo tests (concurrent agents touch
`SkillFindingCard.svelte`/`VerdictPanel.svelte` and `drafts.svelte.ts`/`Landing.svelte`).

## Current shapes (read, confirmed)
- `SkillReviewEntry { skillId, name, state: PanelState<SkillReviewResult> }`.
- `SkillReviewResult { skillName, findings: SkillFinding[] }`.
- `SkillFinding { path, line: number|null, severity, body, verification?, raisedBy? }`.
- `FindingVerification { confirmedBy, polledModels, surfaced, perModel: FindingVerdict[] }`.
- `FindingVerdict { provider, model?, verdict:'confirm'|'refute'|'uncertain', reason, raised? }` (NO `lens`).
- `VerdictResult { level, evidence[], notAnalyzed[], evidenceVerification?, evidenceRaisedBy? }`.
- `ModelCostRow { providerId, modelId, role, total?, surfaced?, uniqueCatch?, impact?, byTask[] }`.
- Inline verification chip ("✓ confirmed by N/M") + demoted treatment render via
  `SkillFindingCard`, which is only mounted INLINE (via FileDiff `skillFindings`) —
  null-line findings go to the chip popover (inline markdown, no chip). So the
  CONFIRMED + DEMOTED findings must have real `line` values that anchor in the diff.
- Cost panel ($) gated on `settingsState.current.showTokenCost`. Demo enables it via
  `setShowTokenCost(true)` on mount. Aggregate total prices against the active model
  (DeepSeek V4 Flash default — priced); per-model rows price against their named model.
- Catalog models to use (all priced in `modelCatalog.ts`):
  generators DeepSeek V4 Pro (`deepseek:deepseek-v4-pro`) + GPT-5.5 (`openai:gpt-5.5`);
  verifiers Claude Opus 4.8 (`anthropic:claude-opus-4-8`) + Gemini 3.5 Flash (`gemini:gemini-3.5-flash`).

## Steps
1. `fixture.ts`: add `demoReviewers: SkillReviewResult[]` (4 personas):
   - Security Reviewer (OWASP-minded): a CONFIRMED finding anchored inline (line in
     useSearch.ts hunk) — verification surfaced=true, confirmedBy 3/4, perModel raiser
     (raised:true) + 3 verifiers (mostly confirm); plus `raisedBy: ['GPT-5.5','DeepSeek V4 Pro']`.
   - Performance Reviewer: a DEMOTED finding anchored inline — surfaced=false,
     confirmedBy 1/5, perModel one raiser + refute/uncertain verifiers.
   - Pragmatic Senior Reviewer: a confirmed file-level (null-line) finding (popover) +
     a low inline one.
   - Resiliency & SRE Reviewer: empty findings → "✓ no significant issues".
2. `fixture.ts`: add `demoModelCostBreakdown: ModelCostRow[]` (2 generators + 2 verifiers),
   per-task byTask drilldown, plausible tokens that sum to `total`. Add `demoTotalUsage`
   = sum of all rows' totals. Enrich `demoVerdict` with `evidenceVerification` +
   `evidenceRaisedBy` on a couple of evidence rows.
3. `demoRun.ts`: build `skillReviews` from `demoReviewers`; return `modelCostBreakdown`,
   `modelPerformance` (= same rows), `totalUsage`, `verdictModels`.
4. `Demo.svelte`: `setShowTokenCost(true)` on mount; pass `modelPerformance`,
   `modelCostBreakdown`, `totalUsage` to `VerdictStep` (as Review.svelte does).
5. Tests: extend `Demo.test.ts` (reviewer chips, confirmed/demoted, raised-by, cost panel,
   no external fetch) + `e2e/demo-onboarding.spec.ts`.

## Gates
`pnpm check` · `pnpm test` · full e2e · `pnpm build`. Commit as akatchi, PR to main.
