# Plan: Reviewer concurrency queue + error-chip hover

Date: 2026-06-16
Branch: `feat/reviewer-queue-and-error-hover`

Two cohesive features in ONE PR; both touch the reviewer-dispatch layer
(`src/lib/ai/run.svelte.ts`) and the reviewer chips (`src/components/InspectStep.svelte`).

## Root cause (Feature A)

`runSkillReviews()` launches EVERY enabled reviewer at once via
`Promise.all(skills.map(executeSkillReview))`. With ~6 reviewers that means 6
concurrent LLM calls, which trips provider rate limits — some reviewers fail.
A manual single-reviewer retry then succeeds because only one call is in flight.

## Feature A — cap in-flight reviewers at 2 (a real queue)

1. `run.svelte.ts`: add `'queued'` to the `PanelStatus` union (with doc comment).
2. `coachBatch.ts`: add `export const REVIEWER_CONCURRENCY = 2` next to
   `COACH_CHUNK_CONCURRENCY`. Reuse the existing `mapWithConcurrency` helper.
3. `run.svelte.ts`: import `REVIEWER_CONCURRENCY`; rewrite `runSkillReviews()`
   dispatch:
   - initialize every entry as `status: 'queued'`, `onUpdate?.()`
   - dispatch through `mapWithConcurrency(skills, REVIEWER_CONCURRENCY, worker)`
   - `worker(skill, idx)` flips the entry to `loading` + `onUpdate?.()` BEFORE
     calling `executeSkillReview` (so the chip moves waiting → running exactly
     when a slot frees).
   - `retrySkill()` unchanged (bypasses the queue — a single manual call).
4. `InspectStep.svelte`: split chips into THREE buckets:
   `runningEntries` (loading), `queuedEntries` (queued),
   `settledEntries` (done|error). Render a muted "Waiting (N)" region for
   queued entries (no spinner). `isRunning`/`runningCount` treat loading OR
   queued as "in progress".

## Feature B — hover the error chip to see the actual error

`InspectStep.svelte`, error branch (`status === 'error'`):
- `entry.state.error` is already set in `executeSkillReview`'s catch via
  `humanMessage(kind)` but never surfaced.
- Set `title` to `` `${error} — click to retry` `` (fallback "Click to retry")
  and include the error in `aria-label` for keyboard reachability.
- Keep retry-on-click + restarted indicator. Do not touch result/suggestion
  chip popovers.

## Tests

- Unit (`src/lib/ai/`): concurrency cap — mock the transport to record peak
  simultaneous active calls; 5 reviewers → peak ≤ 2, all 5 complete.
- Component (`InspectStep`): queued entries render in Waiting region not
  settled; flipping to loading moves to Running.
- Component (`InspectStep`): errored entry exposes `state.error` via
  title/aria-label and still calls `onRetrySkill` on click.

## Gates

`pnpm check`, `pnpm test`, full Playwright E2E (`CI=1 E2E_PORT=4255`,
captured exit code), `pnpm build`.
