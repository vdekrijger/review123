# Review 1-2-3 — Plan K: Story-Mode Coverage Confidence

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development. Established patterns are
> law. Files mode stays byte-identical. The viewed store semantics (revision-aware un-viewing, since-last-visit
> interdiff) must not be corrupted. Both themes. Analytics: allowlisted ids/counts only.

**Goal:** Give users CONFIDENCE that Story Mode covers the WHOLE PR. Files mode shows the file list + "viewed
X/Y", so coverage is legible. Story Mode reorders / groups / caps (STORY_MAX_STEPS=12) / sinks generated files,
so it's opaque whether every changed file is actually somewhere in the walkthrough. Four parts (user-approved)
plus a scroll-to-top quality fix, all in `StorySlideshow.svelte` + `schemas.ts` (+ a `visitedFiles` prop on
`DiagramPanel.svelte`).

## Source of truth

The **file-set accounting** (Parts 1–3) is the source of truth. The change-map diagram (Part 4) is the *visual*
layer and must NOT be a dependency of the accounting — a node that can't map to a file simply doesn't get a
check (graceful).

## Part 1 — Structural 100% coverage (catch-all step)

New pure function in `schemas.ts`:

```
appendCatchAllStep(steps: StoryStep[], prFilenames: string[]): StoryStep[]
```

After the existing shaping pipeline in `StorySlideshow`'s `steps` derived (matchStoryPath map → dedupe →
sinkGenerated), compute the union of every step's `files`. Any changed PR file NOT placed in some step's
primary `files` is swept into a final synthetic step `{ layer: 'other', caption: 'Other changes (N)', files:
[...unplaced], relatedTests: [] }` appended last. So union(all steps' files) == all changed PR files, provably.

- `'other'` is added to `STORY_LAYERS` so the StoryLayer type + LAYER_LABEL covers it (label "Other changes").
- Generated files (#102) already sink last; unplaced generated files land in the catch-all — nothing is
  silently dropped either way.
- The catch-all renders like a normal step (its files via FileDiff). relatedTests are not used as primary
  placement, so a file that is ONLY ever a relatedTest still counts as unplaced and gets swept in (its FileDiff
  shows once, as a primary — that's the desired "everything is somewhere" guarantee).
- Deterministic. Tests: unplaced file → appears in catch-all; union(all steps.files) == all PR filenames.

## Part 2 — Deduped viewed progress parity

Carry Files-mode "viewed X/Y" into Story mode, sharing the per-file `viewed` store both directions.

- **Denominator (DEDUP):** count of UNIQUE changed file paths across the WHOLE story (every step's `files`,
  which after Part 1 == all changed PR files). A file referenced by multiple steps (primary in one + secondary
  /relatedTest in another) counts ONCE. Build a unique-path set.
- **"Seen" semantics:** a file is VIEWED when the user visits a slide showing it as a PRIMARY file (we call
  `viewedStore.toggle`-equivalent — actually a one-way *mark* so we never UN-view). If a file legitimately
  spans MULTIPLE primary slides (rare post-#94 dedupe, but possible via the catch-all + a step), it is only
  counted fully-seen once ALL slides showing it have been visited. Common case: one slide = whole file = viewed.
- Reuse `viewedStore.isViewed(path, patch)` as the per-file truth (shared with Files mode). Progress indicator
  "N / M files seen" rendered in the story controls (reusing the viewed store; M = unique changed files).
- Marking is one-way (visiting a slide marks-viewed; never auto-unviews) to keep revision-aware un-viewing
  (manual toggle in FileDiff) intact.

## Part 3 — End-of-story reconciliation panel

On the LAST step, a compact coverage readout:

- all unique changed files seen → "✓ You've walked all M changed files".
- else → "You haven't viewed these K files yet" + each unseen file listed with a **Jump** button that goes to
  the step/slide covering that file and `scrollToFileCard`s it (reuse the step-jump + scrollToFileCard mech).

## Part 4 — Change-map as coverage map (visited state)

Extend `DiagramPanel` with a `visitedFiles: string[]` prop. Visited files' nodes get a `story-node-visited`
class (a check/tint), giving a visual "what's left". Best-effort label/basename mapping (as today); unmappable
nodes just don't get checked. Does NOT feed the Part 1–3 accounting.

## ALSO — scroll-to-top on step change

On any step change (Next / Prev / jump / node-click), scroll the slideshow step container back to the TOP
(instant). Currently it retains the prior scroll position.

## Constraints / seams

- Files mode unchanged. Viewed store semantics shared and not corrupted.
- No storyOrder PROMPT change (catch-all is deterministic post-processing) → no PROMPT_VERSION bump.
- Analytics: allowlisted `story_coverage_complete` (counts/ids only) if added.
- MERGE-SEAM: feat/per-task-ai-modes (run.svelte.ts) + feat/reviewer-chip-jump-to-findings (InspectStep) in
  flight. This touches StorySlideshow + schemas + DiagramPanel. Re-merge main + rerun ALL gates if main moves.

## TDD

catch-all (unplaced → in catch-all; union == all); dedup (file in 2 steps counts once; multi-primary fully-seen
only when all slides visited); viewed parity (visiting a slide marks its files viewed in the shared store);
reconciliation (all-seen vs K-unseen + jump invoked); scroll-to-top on step change; change-map visited state.
e2e: walk to end → "all N files seen"; skip a file → reconciliation lists it + jump works; Next scrolls to top.

## Gates

`pnpm check && pnpm test && E2E_PORT=4801 pnpm exec playwright test && pnpm build` — all four green before push.
