# Plan — Verify chip tooltip: model + lens, readable layout

Branch: `feat/verify-tooltip-model-lens`

## Problem

Each reviewer finding carries a cross-model-verification chip
("✓ confirmed by N/M models" / "flagged by C/P · lower confidence") in
`src/components/SkillFindingCard.svelte`. Hovering shows a native `title`
tooltip (`verifyTooltip`): one line per vote, `provider: verdict — reason`.

Two problems:
1. It shows only the **provider**, not the specific **model** or the verifier's
   **lens/mode** (correctness/security/…).
2. The native `title` is a cramped, unreadable wall of text.

## Part 1 — Enrich the data (model + lens)

`FindingVerdict` (`src/lib/ai/schemas.ts`) gains two OPTIONAL fields
(backward-compatible with old cached findings that lack them):
- `model?: string` — the specific model (display name or id).
- `lens?: Lens` — the verifier's lens; ABSENT on the generator/raiser row.

`src/lib/ai/crossVerify.ts`:
- Verifier-vote object shape gains `model?: string` and `lens?: Lens`.
- `aggregateFinding(generatorProvider, verifierVotes, generatorModel?)`:
  generator row carries `model` (no lens); each verifier verdict carries the
  vote's `model` + `lens`.
- `aggregateMultiRaiser(raisers, verifierVotes, total, raiserModels?)`: raiser
  rows carry `model` (no lens); verifier verdicts carry `model` + `lens`.
- `crossVerify`: thread the generator's model id (new param) + read each
  responder's `cfg.model.id` and lens into the votes.
- `fuseConfirm`: each vote carries `p.cfg.model.id` + that participant's lens;
  raiser rows carry their `raiserCfgs[i].model.id`.
- No prompt change → do NOT bump PROMPT_VERSION.

Call sites in `src/lib/ai/run.svelte.ts` pass the generator model id.

## Part 2 — Readable styled hover/focus tooltip (SkillFindingCard.svelte)

Replace native `title={verifyTooltip}` on BOTH the confirmed chip and the
lower-confidence chip with a CSS `:hover`/`:focus-within` styled tooltip:
- Heading: "Confirmed by N/M models" / "Flagged by C/P · lower confidence".
- One row per `verification.perModel` entry: color-coded verdict indicator
  (✓ confirm green / ✗ refute danger / ? uncertain amber), the model name
  (fallback to `provider`), the lens as a muted tag (generator row → "raised
  it"), the reason (muted, wraps) when non-empty.
- Chip is focusable (`tabindex="0"`, `role`), keeps the concise `aria-label`.
- Tooltip capped to `min(22rem, 90vw)`, wraps, positioned not to overflow.
- Chip label text unchanged.

## Tests
- crossVerify: a verifier verdict in perModel carries model + lens; the
  generator row carries model and NO lens.
- SkillFindingCard: hover/focus reveals tooltip listing model + lens + verdict;
  refute/uncertain show their indicator; falls back to provider when model
  absent.
- Update existing `title=`/`verifyTooltip` assertions in the same commit.

## Gates
`pnpm check`, `pnpm test`, full e2e, `pnpm build`. Commit as akatchi.
