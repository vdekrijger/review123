# Plan: Re-key drafts by stable PR identity (no head-SHA in the draft prKey)

Date: 2026-06-16
Branch: `feat/draft-rekey-pr-identity`
Touches USER DATA (unsubmitted line-comment drafts in IndexedDB). Must be **lossless + idempotent**.

## Problem

Unsubmitted line-comment **drafts** are stored in IndexedDB (`review123-drafts`, store `drafts`,
out-of-line key `prKey|path|line|side|n`). The draft `prKey` is currently
`provider:owner/repo#number@headSha` — it **bakes in the PR's HEAD commit SHA**.

When the author pushes a new commit, `headSha` changes → the new session computes a new `prKey`
→ the current-sha store loads empty → existing drafts "orphan" under the OLD sha.

PR #120 added a recovery dance (`getOrphanDraftsForPr` + `migrateOrphanDrafts`, wired in
`Review.svelte`): on load, if the current-sha store is empty but other-sha drafts exist for the
same PR identity, adopt them. This fixes the symptom but is fragile (the "store.count > 0" guard
means it silently won't run if even one current-sha draft exists, so old-sha drafts can still
hide; it deletes sources; it's a load-time race).

## Goal

Re-key drafts by **stable PR IDENTITY** (`provider:owner/repo#number`, NO sha) so drafts NEVER
orphan on a new commit — WHILE preserving the ability to view and recover drafts made on OLDER
commits. NO draft may ever be lost.

## Current draft storage (as-is, verified)

- `src/lib/drafts/drafts.svelte.ts`
  - `Draft` = `{ prKey, path, line, startLine?, side, body, n?, updatedAt }` — **no commit field**.
  - `draftKey(d)` = `${prKey}|${path}|${line}|${side}|${n}`.
  - `parsePrKey(prKey)` → `{ prKey, provider, owner, repo, number, headSha }`. Already tolerates a
    **missing** `@sha` (`headSha === ''`). KEEP this — it's how identity keys parse.
  - `createDraftStore(prKey, dbName)` — `load()` cursors `prKey|…` range; legacy 4-part→5-part key
    migration already lives here.
  - `listDraftSummaries()` — one summary per raw prKey (sha variants stay separate).
  - `getOrphanDraftsForPr` / `migrateOrphanDrafts` — the #120 recovery.
  - `clearDraftsForPr(prKey)` — clears one prKey's range.
- `src/routes/Review.svelte`
  - L124 `prId = ${providerId}:${owner}/${repo}#${number}` — **the identity key already exists.**
  - L177 `prKey = ${providerId}:${owner}/${repo}#${number}@${meta.headSha}` → `createDraftStore(prKey)`.
  - L191-201 orphan-recovery wiring; `restoredDraftCount` note at L749-751.
  - L219-223 `recordVisit` uses `meta.headSha` (UNRELATED to drafts — leave alone).
- `src/routes/Landing.svelte`
  - `groupInflight()` already collapses sha variants to one identity row (`id = provider:owner/repo#number`).
  - `confirmDiscard()` clears every `row.prKeys` variant.
- `src/components/InspectStep.svelte`
  - `draftsForFile(path)` filters `draftStore.drafts` by path → `drafts={…}` into `FileDiff`.
  - removes via `draftStore.remove(draftKey(draft))`.
- `src/components/FileDiff.svelte`
  - `isAnchoredDraft(d)` → line present in patch hunks for its side.
  - anchored drafts render INLINE via `extendData`; **unanchored** drafts render in the fallback
    block (L774-797) via `DraftThread`. This block ALREADY handles drafts not in the current diff.
- `src/components/DraftThread.svelte` — renders one draft; header shows "Comment at line N".

## Design

### 1. Draft carries its source commit; prKey becomes identity-only

- Add `headSha?: string` to `Draft` (the commit the draft was MADE on). Optional for back-compat.
- The draft scoping `prKey` becomes the PR **identity**: `provider:owner/repo#number` (NO `@sha`).
- All of a PR's drafts — across every commit — live under ONE identity key, each tagged with
  `headSha`. `draftKey` is unchanged (it just uses the identity prKey now).
- `createDraftStore(prKey, dbName, makerSha?)`: add an optional 3rd arg = the CURRENT head sha,
  stamped onto `upsert`ed drafts as `headSha` so new drafts record the commit they were made on.
  (Default `undefined` keeps all existing callers/tests valid.)

### 2. Migration (lossless + idempotent + safe) — in `createDraftStore.load()`

`load(prKey = identity)` runs an in-place migration BEFORE reading, scoped to this PR identity:

1. Cursor the WHOLE store once. For each raw key, `parsePrKey(prKeySegment)`. Select records whose
   `provider+owner+repo+number` match THIS identity AND whose `prKeySegment !== identityPrKey`
   (i.e. legacy `@sha` keys, or any other variant). These are "to migrate".
2. For each, build the target key under the identity prKey: `draftKey({prKey: identity, path,
   line, side, n})`. Set `headSha` on the migrated record from the source's parsed `headSha`
   (`''` → leave `headSha` undefined). Preserve body/startLine/updatedAt.
3. **Collision rule (never lose a draft):** if the target key is free → put there, delete source.
   If the target key is OCCUPIED (an identity draft already at this anchor):
   - if bodies are identical → it's the same draft already migrated; just delete the source
     (idempotent dedup).
   - else → re-home the source to the next free `n` at that anchor (append, never overwrite),
     then delete source. This keeps BOTH. (Anchor = path|line|side; bump `n`.)
4. After migration, read the identity range and populate `drafts`.

Properties:
- **Idempotent:** second run finds no non-identity keys for this PR (all already moved) → no-op.
  The identical-body short-circuit also makes a partially-applied migration safe to re-run.
- **Lossless:** sources are deleted ONLY after the record is written under identity (adopt-then-
  delete, and collisions append rather than overwrite).
- Legacy 4-part→5-part key fixing still happens (unchanged) for identity-keyed records.

This **supersedes** #120: orphaning is impossible once drafts live under identity, and the
migration absorbs everything `getOrphanDraftsForPr`/`migrateOrphanDrafts` used to recover (drafts
across multiple old shas → all land under identity, deduped, none lost).

### 3. Remove the #120 recovery dance

- Delete `getOrphanDraftsForPr`, `migrateOrphanDrafts`, the `OrphanDraft` interface, and
  `idbDeleteLegacy` if it becomes unused.
- In `Review.svelte`: prKey becomes `prId` (identity). Pass `meta.headSha` as the maker-sha to
  `createDraftStore`. Replace the orphan block with a plain `await store.load()`.
- `restoredDraftCount` + the "Restored N draft comments from an earlier commit" note: REMOVE — the
  migration is now silent + always-on, and old-commit drafts simply stay visible (see #4). Removing
  it keeps `pnpm check` clean (no unused symbol). Update the e2e accordingly (#5).

### 4. Old-commit drafts stay viewable + source-commit note

- Because ALL identity drafts load regardless of current sha, a draft whose anchor IS in the
  current diff renders inline (today's path); one whose line moved/disappeared renders in
  FileDiff's EXISTING unanchored fallback block. No code needed to "keep them visible" — re-keying
  does it.
- Surface the source commit: in `DraftThread`, when `draft.headSha` is present AND differs from the
  current head sha, show a small muted note "from commit <short7>". Thread the current head sha
  down: `Review.svelte` (has `meta.headSha`) → `InspectStep` → `FileDiff` → `DraftThread` as
  `currentHeadSha`. DraftThread computes `showFromCommit = draft?.headSha && draft.headSha !==
  currentHeadSha` and renders `from commit ${draft.headSha.slice(0,7)}`.
  - Keep it additive/optional so the demo route and tests that don't pass `currentHeadSha` are fine.

### 5. Dependents

- `listDraftSummaries` / `groupInflight` / Landing in-flight + resume + discard: now each PR has a
  SINGLE identity prKey, so `groupInflight` naturally yields one row with one `prKeys` entry.
  `multipleShas` will be `false` (sha now lives per-draft, not per-key). The "from an earlier
  commit" hint on Landing keyed off `multipleShas` becomes effectively dead for new data; leave the
  grouping code (still correct + harmless for any residual legacy keys before their first load-time
  migration) — but the inflight tests that asserted multi-sha rows must be updated (#6).
- `clearDraftsForPr` + `confirmDiscard`: still correct (one identity key clears everything).
- Submission: drafts post against the CURRENT diff using path/line/side as today — unchanged. A
  draft from an old commit whose line isn't in the current diff already can't post inline (it sits
  in the fallback block); behavior is unchanged from today's unanchored drafts.

## Data-safety tests

In `src/lib/drafts/drafts.test.ts` (REPLACE the orphan describe-blocks):
- **migration-multi-sha:** seed legacy `…#5@sha1` and `…#5@sha2` drafts (distinct anchors) →
  `createDraftStore(identity).load()` → all appear under identity with correct per-draft `headSha`
  (`sha1`/`sha2`); none lost; raw store has no `@sha` keys for this PR afterward.
- **migration-idempotent:** run `load()` twice → second run = no change (same count, same bodies).
- **migration-collision-keep-both:** same anchor under two shas with DIFFERENT bodies → both
  survive (one at n, one appended at n+1); identical bodies → deduped to one.
- **maker-sha stamping:** `createDraftStore(identity, db, 'abc1234').upsert(...)` → stored draft
  has `headSha === 'abc1234'`.
- Keep `listDraftSummaries`/`clearDraftsForPr` tests (adjust expected keys to identity form).

In `src/routes/Landing.inflight.test.ts`:
- Replace the "groups multiple SHA variants" test: seed legacy multi-sha drafts, assert the row
  still shows the summed count after they're surfaced. (Migration happens on Review load, not
  Landing load — Landing reads raw summaries; grouping by identity still collapses them, so the
  count assertion holds.) Drop the `from an earlier commit` assertion (or keep it guarded behind
  legacy data — decide during impl; simplest: assert the single resumable row + summed count).

In FileDiff/DraftThread (component test, if a lightweight one fits):
- A draft with `headSha` ≠ current renders the "from commit" note; anchored draft renders inline;
  unanchored old-commit draft renders in the fallback block.

e2e (`e2e/orphan-draft-recovery.spec.ts`):
- Re-point to the new model: seed legacy `@oldsha` drafts, navigate to the PR, assert the drafts
  are VISIBLE (in recap / inspect) — NOT a "restored" note (that note is gone). Rename the spec
  intent to "old-commit drafts remain visible after re-key migration".
- `e2e/in-flight-reviews.spec.ts`: unchanged behavior (resume + discard) should still pass.

## Gates

`pnpm check` (0 errors, no unused symbols) · `pnpm test` · `CI=1 E2E_PORT=4307 pnpm exec
playwright test` (capture exit code; `real-pr.smoke` may flake locally on unauth rate-limit —
known) · `pnpm build` (exit 0).

## Risk / abort condition

If the collision/idempotency logic can't be made provably lossless (e.g. an anchor-append scheme
that could overwrite), STOP and report rather than risk user drafts. The adopt-then-delete +
append-on-collision scheme above never deletes a source before its content exists under identity,
so it is safe.
