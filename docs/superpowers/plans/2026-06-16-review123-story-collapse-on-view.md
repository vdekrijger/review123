# Story mode: manual mark-viewed collapses the diff

## Problem

In **Files mode**, marking a file "viewed" collapses its diff to the header
(`FileDiff.svelte`: `collapsed = !forceExpanded && viewed && !manuallyExpanded`),
and unviewing re-expands it.

In **Story mode** this collapse is suppressed: `StorySlideshow.svelte` renders the
slide's PRIMARY diff with `forceExpanded={true}`. That prop exists so the slideshow's
auto-mark-on-advance (a file becomes viewed for coverage tracking the instant its slide
is reached) does NOT collapse the very diff being narrated (header-only → no body, no
syntax highlighting).

The user wants: in Story mode, when they **manually** tick the "viewed" checkbox, the
diff should collapse (header-only), and unticking re-expands. The narrated/auto-marked
diff must still stay expanded by default (no regression to the auto-mark behaviour).

## Approach

Distinguish a USER manual mark-viewed from the `forceExpanded` default inside
`src/components/FileDiff.svelte`. `forceExpanded` keeps the diff expanded *by default*,
but a deliberate user tick overrides it.

### Changes (`FileDiff.svelte`)

1. Add session state `let userMarkedViewed = $state(false)`.
2. In `handleViewedChange`, when the checkbox is CHECKED (`checked === true`) set
   `userMarkedViewed = true`. (The existing un-check branch already sets
   `manuallyExpanded = true`.)
3. Change the collapse derived so a manual view collapses even under `forceExpanded`:
   ```ts
   const collapsed = $derived(viewed && !manuallyExpanded && (!forceExpanded || userMarkedViewed))
   ```
4. In the existing reset effect, also reset `userMarkedViewed` when not viewed:
   ```ts
   $effect(() => { if (!viewed) { manuallyExpanded = false; userMarkedViewed = false } })
   ```

### Why this is safe

- **Files mode** (`forceExpanded = false`): `!forceExpanded` is already `true`, so the
  derived simplifies to `viewed && !manuallyExpanded` — byte-identical to today.
- **Story narrated / auto-marked diff** (`forceExpanded = true`, viewed set by the store
  WITHOUT a checkbox click): `userMarkedViewed` stays `false`, so
  `(!forceExpanded || userMarkedViewed)` is `false` → stays expanded. No regression.
- **Story manual view** (`forceExpanded = true`, user ticks the checkbox):
  `userMarkedViewed` becomes `true` → collapses. Unticking flips `viewed` false → the
  reset effect clears `userMarkedViewed` → re-expands.

`StorySlideshow.svelte`'s auto-mark-on-advance logic is unchanged.

## Tests (`FileDiff.test.ts`)

Extend the existing `forceExpanded` collapse tests:

- `forceExpanded=true`: an auto/externally-set `viewed` WITHOUT the user clicking the
  checkbox stays expanded (narrated-diff case — existing test already covers this).
- `forceExpanded=true`: ticking the checkbox then having the parent flip `viewed=true`
  (simulated via `rerender`) collapses the diff (header-only). Then unticking +
  `viewed=false` re-expands.
- `forceExpanded=false`: behaviour unchanged (existing tests cover this).

## Gates

`pnpm check`, `pnpm test`, full e2e `CI=1 E2E_PORT=4293 pnpm exec playwright test`,
`pnpm build`. Then commit (identity `akatchi <akatchi@codekrijger.io>`), push, PR to main.
