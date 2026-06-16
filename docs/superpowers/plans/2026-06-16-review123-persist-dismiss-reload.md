# Persist dismissals across a full page reload

## Problem

Dismissing a reviewer finding (or "Add as draft", which also hides the card)
persists across slide-nav, but is LOST on a full page reload — the finding
reappears. The suppression sets (`dismissedKeys`, `addedDraftKeys`) in
`InspectStep.svelte` are session-only `$state`; nothing seeds them from the
durable IndexedDB decision store on load.

The decision store (`src/lib/eval/decisions.ts`, DB `review123-decisions`)
ALREADY records every accept/dismiss outcome keyed by `prKey + findingKey`
(via `decisionStore.record(...)` in `recordDecision`). So the durable
ground-truth exists — we just never read it back into the in-memory
suppression sets.

The finding KEY format is identical on both sides:
`${skillId}:${path}:${line}:${body.slice(0,30)}`. So a finding that produces the
same content on reload yields the same key the store recorded — seeding matches.

## Approach

Seed the in-memory suppression sets from the decision store on InspectStep mount.

### Read API (decisions.ts)

The store is already PR-scoped (`createDecisionStore(prKey)`) and already
exposes the read API we need:

- `async load()` — populates the in-memory mirror from IndexedDB for THIS PR.
- `list(): DecisionRecord[]` — returns this PR's recorded decisions.

No new method is required: `load()` + `list()` IS the PR-scoped read. The parent
(`Review.svelte`) already calls `decisions.load()` after creating the store, but
that is async and un-awaited, so InspectStep must await its own `load()` before
reading `list()` (idempotent — re-loading just re-reads the same rows).

A small test will assert `list()` returns the recorded decisions for a prKey and
not another PR's (the existing `readDecisionsForPr` cross-PR test already covers
the cross-PR isolation of the underlying store; we add a `list()`-scoped assertion).

### Seeding (InspectStep.svelte)

Add an `$effect` that runs when `decisionStore` is set, awaiting `load()` then
merging the stored decisions into the existing sets:

- `'dismissed'` finding keys → merged into `dismissedKeys`
- `'accepted'` finding keys → merged into `addedDraftKeys` (so an added finding
  stays hidden; its draft persists separately in the draft store)

Merge (don't clobber session dismissals):
`dismissedKeys = new Set([...dismissedKeys, ...loadedDismissed])`.

The effect guards against re-seeding (only seeds once per store instance) so it
doesn't fight the retry path. Findings rendered before the async seed completes
hide reactively once the sets update — the derived filters
(`lineSkillFindingsByPath` / `fileLevelSuggestionsByPath` / `navFindingsBySkill`)
re-run. No flash-prevention needed.

### Retry path is untouched

`clearSuppressionForSkill(skillId)` still strips that reviewer's suppressed keys
so a deliberate re-run re-surfaces them. A reload seeds from the store; a reviewer
re-run un-suppresses — both behaviors stay intact. The seed effect runs once per
store, so a later retry's clear is not re-seeded over.

### PR scope

The store is bound to the current prKey, so `load()` + `list()` only ever return
the current PR's decisions. No cross-PR leakage.

## Tests

- `decisions.test.ts`: `list()` returns the PR's recorded decisions after
  `load()` from a fresh instance, and is empty for a different PR's store
  (PR-scoped read).
- `InspectStep.persist-dismiss.test.ts` (new): render InspectStep with a
  decisionStore pre-seeded (real `createDecisionStore` on fake-indexeddb)
  containing a `'dismissed'` decision for finding key A and an `'accepted'`
  decision for finding key B, plus an un-decided finding C. On mount:
    - finding A is NOT rendered (seeded dismissed → hidden),
    - finding B is NOT rendered (seeded accepted → hidden),
    - finding C IS rendered.

## Gates

`pnpm check` (0 errors), `pnpm test`, full e2e
(`CI=1 E2E_PORT=4301 pnpm exec playwright test`), `pnpm build`.
