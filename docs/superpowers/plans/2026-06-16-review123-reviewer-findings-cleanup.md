# Plan — Reviewer findings + per-model info cleanup (Step 3 / InspectStep)

Date: 2026-06-16
Branch: `feat/reviewer-findings-cleanup`
Scope: ONLY `src/components/InspectStep.svelte` (+ its tests + e2e). Another agent owns
`ReviewCostPanel.svelte` / `run.svelte.ts` / `FileDiff.svelte` / `StorySlideshow.svelte` — stay out.

## Three UX fixes

### Fix D — remove the per-REVIEWER model breakdown
The `ensembleEntries` block (InspectStep.svelte ~1024-1048) renders a per-reviewer
collapsible `ModelBreakdownTable` ("{name} — N models"). Per-model cost/impact now lives
only in the consolidated Step-3 `ReviewCostPanel`, so this is redundant.

- Remove the whole `{@const ensembleEntries …}` + `{#if ensembleEntries.length > 0}` block.
- Remove the now-unused `.skill-model-breakdowns` / `.skill-model-summary` CSS.
- Remove the `import ModelBreakdownTable` (confirmed: only used by that block).
- Tests: `InspectStep.test.ts` "per-model skill breakdown (Plan N)" describe (3 its,
  ~251-336) asserts on `data-skill-models`, `.skill-model-breakdowns`, "N models". DELETE that
  describe. Verify single-model footer behavior is still covered elsewhere (the
  `.skill-usage-footer` assertion belongs to that describe — keep one footer assertion if it is
  the only coverage; otherwise drop). e2e: grep skill-reviewers/cross-model-verify/settings for
  `skill-model`/`N models` — none assert on it (only `models` substrings unrelated). Confirm.

### Fix E — render MARKDOWN in the reviewer-chip findings popover
Popover entries currently show `nav.title` = `findingTitle(body)` (first line, markers
stripped, sliced 120). Render the finding BODY as markdown instead so backticked code reads as
`<code>`. Use `renderInlineMarkdown` (src/lib/markdown/render.ts) via `{@html …}` for the entry
text. Keep the entry a navigable `role="menuitem"` button that still jumps on click.

### Fix B — widen the popover, show full finding, drop the redundant bottom card
- Widen `.findings-popover` (min-width ~22rem, max-width ~min(40rem, 90vw)); show the FULL body
  (markdown) not the 120-char title.
- Remove the redundant "bottom" cards: the `fileLevelSuggestionsByPath` `.file-level-finding`
  cards rendered above the FileDiff in InspectStep (~1197-1217). These are null-line (file-level)
  findings the user also sees in the popover — duplicate.
- KEEP: the INLINE anchored `SkillFindingCard`s rendered inside `FileDiff` (via
  `lineSkillFindingsByPath` / `skillFindings` prop) and the off-diff `.skill-findings-annotations`
  fallback block — both live INSIDE FileDiff.svelte (another agent's file), so untouched.
- Because the `.file-level-finding` bottom block is the ONLY place a null-line finding's
  card (with Add/Dismiss) renders in InspectStep, the popover MUST take over Add-as-draft +
  Dismiss for those. Enrich each popover entry with the full body + actions wired to
  `addFindingAsDraft` / `dismissFinding`, keyed by the nav finding's key.

## NavFinding enrichment
`NavFinding` currently = `{ key, path, line, title }`. Add `body: string` (full finding body)
so the popover can render markdown + drive Add-as-draft. Keep `title` only if still referenced
(it won't be after Fix E/B — drop `findingTitle` if fully unused). Build entries from
`result.findings` (already iterated in `navFindingsBySkill`).

## Popover markup (both result + summary popovers, ~959-979 and ~1066-1086)
Each entry becomes:
- a clickable region that jumps (keep `jumpToNavFinding`) showing `path:line` + body markdown,
- Add-as-draft + Dismiss buttons (do not jump; `stopPropagation`), reflecting
  `addedDraftKeys`/`dismissedKeys` state (e.g. hide actions / show "added" when added).
Roving-focus keydown targets `[role="menuitem"]`; keep the entry button as the menuitem, render
the action buttons alongside.

## Tests to ADD/UPDATE (same commit)
- Popover renders body markdown: a backticked token → `<code>`, not literal backticks; not truncated.
- Add-as-draft from popover calls the draft store; Dismiss records the decision.
- `.file-level-finding` bottom cards no longer render; a null-line finding appears in the popover
  (and its data-finding-key jump target now lives only inline/where applicable).
- Per-reviewer "N models" breakdown gone (delete that describe).
- Fix existing tests that asserted on `.file-level-finding` for null-line findings:
  - InspectStep.test.ts ~513-522 (`data-finding-key` jump target) — currently relies on the
    file-level card. Re-point to the popover/remaining target.
  - InspectStep.test.ts ~589-599 (demoted null-line file-level card) — update to popover.
  - InspectStep.test.ts ~601-618 (Story mode null-line) — STORY uses StorySlideshow (other
    agent's file) which still gets `fileLevelSuggestionsByPath`; this should still pass. Verify.
  - InspectStep.linefindings.test.ts ~119-122, 151-159, 161-188 — `.file-level-finding`
    assertions. Update: null-line findings no longer render above the file in InspectStep.
    (The `.skill-findings-annotations` off-diff cases live in FileDiff — keep as-is.)

## Gates
`pnpm check` (0), `pnpm test`, `CI=1 E2E_PORT=4295 pnpm exec playwright test`, `pnpm build`.
Git identity akatchi <akatchi@codekrijger.io>. Commit, push, gh pr create → main, auto-merge.
