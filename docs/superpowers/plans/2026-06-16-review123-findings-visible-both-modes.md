# Findings visible in both modes (Story + Files)

## Root cause

Reviewer findings in `InspectStep.svelte` are split into three categories:

1. **Line-anchored, confirmed** → `lineSkillFindingsByPath` (`$derived.by`) → passed to
   `FileDiff` as `skillFindings` → rendered inline. The ONLY category Story mode renders.
2. **Demoted by cross-model verification** (`isDemoted(s)` = `!!s.verification && !s.verification.surfaced`)
   → excluded from `lineSkillFindingsByPath` and `fileLevelSuggestionsByPath`, collected into
   `demotedFindings`, rendered ONLY inside a collapsed `<details class="lower-confidence-group">`
   that lives ONLY in the Files-view branch.
3. **File-level / null-line** (`finding.line === null`) → `fileLevelSuggestionsByPath` → cards
   rendered ONLY in the Files-view branch.

Meanwhile the reviewer chip count and the popover nav list (`navFindingsBySkill`) include ALL
findings (demoted + file-level + line). So a chip says "2 findings", the popover lists them, but
`jumpToFinding(path, key)` targets a `data-finding-key` element that does NOT exist in the DOM
(Story mode) or sits inside a collapsed `<details>` (Files mode demoted group). The click is a
silent no-op.

This is NOT a reactivity bug (the popover already shows the data) and NOT the retry path. It is
purely that some finding categories are not rendered as cards in all views.

## The fix (A–E)

- **A.** Stop excluding demoted findings from inline rendering. Remove `!isDemoted(s)` from
  `lineSkillFindingsByPath` (keep `!dismissedKeys.has` and `s.line !== null`). Demoted line
  findings flow through to `FileDiff` carrying their `verification`.
- **B.** Mark demoted cards visually in `SkillFindingCard.svelte`: when `verification && !verification.surfaced`,
  add a dimmed `lower-confidence` class and a badge "flagged by {confirmedBy}/{polledModels} ·
  lower confidence". Works inline (anchored) and unanchored. Field names from `FindingVerification`
  in `schemas.ts`: `confirmedBy`, `polledModels`, `surfaced`.
- **C.** Retire the collapsed "Lower confidence" group in Files mode and the now-dead
  `demotedFindings` derived + its CSS. Demoted findings now render inline.
- **D.** Include demoted null-line findings in `fileLevelSuggestionsByPath` (drop the `!isDemoted`
  filter there), and render file-level findings in Story mode by passing
  `fileLevelSuggestionsByPath` into `StorySlideshow` and rendering the cards per file (mirroring
  Files mode, above each file's `FileDiff`).
- **E.** Result: every finding a chip counts/links to has a visible DOM card with the right
  `data-finding-key` in BOTH modes; chip navigation always lands.

## Tests

- SkillFindingCard: lower-confidence badge + dimmed class when `surfaced === false`; none when surfaced.
- InspectStep: a demoted line finding renders inline (not in a collapsed group); a null-line
  finding renders in Story mode.
- e2e skill-reviewers: a demoted reviewer finding renders a clickable card and chip nav lands on
  it in story mode.

## Scope boundary

Do NOT touch the chip popover / `jumpToFinding` / `activateChip` / error-chip code. Making the
card render (so the jump target exists) is what fixes navigation.
