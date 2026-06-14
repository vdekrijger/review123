# Review 1-2-3 — Plan H: Story Mode

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Established
> patterns are law. Contracts binding. Files mode stays byte-identical when selected.

**Goal:** Step 2 (Inspect) gets a guided NARRATIVE walkthrough of the PR diff — one coherent change
at a time, in a logical reading sequence (data → API/logic → tests → UI), with the related tests
shown inline for sense-checking and the change-map diagram acting as a progress map. This is an
ALTERNATIVE to the all-files diff ("Files" mode), not a replacement. Story mode is a classification
task, so it requires an LLM key.

This is **orchestration + one new AI task + one new slideshow component + a mode switch** — NOT a
diff-rendering rewrite. The slideshow reuses `FileDiff` verbatim (syntax highlighting, focus-mode
dimming, hide-whitespace, test-file display, comment/draft/viewed widgets all come for free).

## Gating + default (the rule)

`storyMode: boolean` setting (default **true**), coerced + `setStoryMode`, exposed via
`settingsState`.

- **LLM key configured** (`activeProviderHasKey()`): Story mode is AVAILABLE. The step-2 switch
  offers `Story | Files`, and **Story is the default** (lead with the narrative) UNLESS the user has
  flipped to Files — that per-browser choice persists in `storyMode` and wins.
- **No LLM key:** Story mode is UNAVAILABLE. The settings toggle is disabled with a hint; the step-2
  switch does not render Story; classic Files is the only flow. No-key users never see any story UI.
- Even with a key, the in-step `Files` button drops back to the existing all-files diff anytime, and
  that choice persists (writes `storyMode=false`). Flipping back to `Story` writes `storyMode=true`.

The step-2 effective mode = `storyAvailable && storyMode ? 'story' : 'files'` where
`storyAvailable = activeProviderHasKey()`.

## Classification + ordering (new AI task `storyOrder`)

New task in `src/lib/ai/tasks.ts` (`storyOrderPrompt`), schema + validator in
`src/lib/ai/schemas.ts` (`validateStoryOrder` / `StoryOrderResult`), wiring in
`src/lib/ai/run.svelte.ts` (`runStoryOrderTask`, `story` PanelState, added to `start()` /
`retry()` / `TaskName`).

**Layer taxonomy (7 layers):** `data` (data model / migration / schema), `api` (API / service /
transport), `logic` (business logic), `config` (validation / config / foundational-shared), `tests`,
`ui` (UI / frontend), `foundational` (shared primitives depended on by many layers).

**Ordering rule:** chronological/logical reading order —
`data → api → logic → tests → ui`, with `config`/`foundational` woven in **just before** the first
step that depends on it (a shared primitive precedes its first consumer; a migration precedes the
API that reads the new column). Each layer's steps stay grouped; within a layer, most load-bearing
first. The model emits an ALREADY-ORDERED `steps` array (index 0..n-1); ordering is the model's job,
the validator only enforces shape + index monotonicity-tolerance (consumer re-indexes defensively).

**StoryStep shape (each carries):**
```
{
  index: number,            // ordered position, 0-based
  files: string[],          // file path(s) this step covers (≥1, must be in the PR)
  caption: string,          // one-line narrative ("The schema gains a `provider` column…")
  layer: 'data'|'api'|'logic'|'config'|'tests'|'ui'|'foundational',
  relatedTests: string[]    // test file paths to show inline for sense-checking (may be empty)
}
StoryOrderResult = { steps: StoryStep[] }
```

`relatedTests` reuses the existing test-insight / import-graph signal: the prompt is handed the
packed `importGraph` and told to pair a step's code with the test files that cover it. The consumer
filters `files`/`relatedTests` to paths actually present in the PR (unknown paths dropped, like
`readingOrder`); a step whose `files` all vanish is dropped.

**Harness:** runs through the deep harness when `aiDeepReview` is on (the `runDeepJson` pattern —
verify ordering/test-pairing by reading deps), single-pass otherwise. Follows the EXACT branch shape
the other deep tasks use (`deepReviewAvailability`, `'story|deep'` cache marker, `DeepCached<T>`,
activity lines, `toolCallsUsed`). Partial loops never cached.

**PROMPT_VERSION bump 13 → 14** (new task prompt added; bump invalidates nothing else materially but
keeps the cache-keying contract honest). Cache note added.

## Slideshow UI (`StorySlideshow.svelte`)

New component renders ONE story step at a time:
- the narrative **caption** + a layer chip + step counter ("3 of 8");
- the step's **diff** via `FileDiff` (one card per file in `files`) — same props InspectStep passes
  (drafts, comments, viewed, contents, askFn, skillFindings, whitespace, focusMode) so a file in a
  slide behaves EXACTLY as in Files mode;
- the **related tests** inline beneath, also via `FileDiff` (read-for-context), each labelled "Related test";
- **Prev/Next** buttons + **←/→ keyboard** nav + a step counter.

Comments/drafts/viewed state work per slide because the SAME draft/viewed/comment stores are threaded
through (keyed by file). Viewed semantics stay MANUAL (matching Files mode — InspectStep never
auto-marks viewed on scroll; a slide is not "more seen" than a scrolled card, so we don't auto-mark).

**Change-map as the map:** the `DiagramPanel` change-map sits ABOVE the slides as the progress
indicator. New `highlightNodeIds` prop on DiagramPanel highlights the node(s) for the current step
(done / current / upcoming visual states via a class on matching nodes), and clicking a node jumps to
the first step that covers that file. Node↔file mapping is by label match against the step's `files`.
If diagrams haven't arrived yet (async), the slideshow renders WITHOUT the map and wires the highlight
in when `diagrams.status === 'done'` — the story NEVER blocks on the diagram.

**Loading / empty / fallback:**
- `story.status` loading/streaming → crafted `Skeleton` (reuse existing) under the switch.
- `story.status === 'error'` OR a `done` result with zero usable steps → **fall back to Files mode**
  with a one-line note ("Story mode unavailable for this PR — showing all files."). Never a dead end.
- No-key → none of this renders (gated out before the switch).

## Analytics (allowlisted, ids/index only)

Two new events through the choke-point in `src/lib/analytics/analytics.ts`:
- `story_mode_entered: []` — fired when the user enters Story mode (no content).
- `story_step_viewed: ['index']` — `index` is the integer step position only — no paths, captions,
  or content. PRIVACY DECISION comment added.

## Files touched

```
src/lib/ai/tasks.ts          + storyOrderPrompt; PROMPT_VERSION 14; STORY_LAYERS export
src/lib/ai/schemas.ts        + StoryStep / StoryOrderResult / validateStoryOrder
src/lib/ai/run.svelte.ts     + story PanelState, runStoryOrderTask (deep+single), TaskName, start/retry
src/lib/settings/settings.ts + storyMode field + default true + coerce + setStoryMode
src/lib/analytics/analytics.ts + story_mode_entered / story_step_viewed allowlist
src/components/StorySlideshow.svelte   NEW — slideshow (FileDiff reuse + DiagramPanel map)
src/components/DiagramPanel.svelte     + highlightNodeIds prop + onnodeclick + node state classes
src/components/InspectStep.svelte      + Story|Files switch (gated), renders StorySlideshow or files
src/routes/Review.svelte               threads run.story + diagrams + storyMode wiring to InspectStep
```

## TDD

- `storyOrderPrompt` construction tests (layer taxonomy named, ordering rule stated, JSON-only,
  importGraph embedded, deep variant adds verify guidance via `withDeepReviewGuidance`).
- `validateStoryOrder` schema tests (valid; bad layer enum → null; missing files → null; non-array
  steps → null; tolerant of extra keys; empty steps valid).
- `run.svelte.ts` story-task tests: single-pass cache hit/miss; deep cache `|deep` marker + toolCalls;
  fallback note; partial-never-cached; toggle-off path byte-identical (no loop invoked).
- `StorySlideshow` component tests: nav (next/prev clamp), keyboard ←/→, step counter, per-slide
  draft comment wiring, fallback-to-Files on empty/error, related-tests render.
- gating tests: no key → switch shows no Story + settings toggle disabled; key → Story default on;
  switch flip persists `storyMode`.
- diagram-highlight-current test: DiagramPanel highlights nodes whose label ∈ current step files.
- e2e `story-mode.spec.ts`: fixture-backed — enter story, walk slides, assert caption + diff + inline
  tests + diagram highlight + a draft comment on a slide persists; plus a no-key fallback test.

## Gates (all four; capture playwright's own exit code)

`pnpm check && pnpm test && E2E_PORT=4669 pnpm exec playwright test && pnpm build`

## Done

Gates green; Files mode byte-identical when selected; no-key users never see story UI; checkpoint:
user walks a real PR's story and judges the ordering + captions.
