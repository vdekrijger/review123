#!/usr/bin/env node
/**
 * scripts/capture-shots.mjs — regenerates docs/design/shots/.
 *
 *   node scripts/capture-shots.mjs                  # build, serve, shoot all 18
 *   node scripts/capture-shots.mjs --check          # shoot to a temp dir, compare, write nothing
 *   node scripts/capture-shots.mjs --only step2-inspect-split
 *   node scripts/capture-shots.mjs --base-url http://localhost:4173   # reuse a running preview
 *
 * WHY THIS FILE EXISTS. `docs/design/shots/` is the before/after evidence for
 * the whole UI refactor, and the recipe that produced it was not committed
 * anywhere — so THREE separate agents reverse-engineered it from scratch, and
 * the third still could not re-shoot six of the fourteen. Each rediscovery was
 * a guess re-validated by rebuilding `origin/main` and reproducing a committed
 * shot. This file is that recipe, written down once.
 *
 * THE SIX-STALE-SHOTS BLOCKER IS GONE, and it is worth saying why, because the
 * plan still records it as open. Batch 2D slice 2 deferred the six review-flow
 * shots believing their fixture "exists only inside an e2e spec", so re-shooting
 * would have meant inventing one and destroying the comparison the directory
 * exists for. That is no longer true — and arguably never was. The fixture is
 * `src/lib/demo/fixture.ts`, a committed, in-app, hand-written example PR served
 * at `/demo`, with every AI panel PRE-GENERATED into the 'done' state: no
 * spinners, no streaming, no network, no clock. `e2e/diff-density.spec.ts`
 * already measures against it. So the review-flow surfaces are reachable by
 * anything that can open a URL, this script included, and nothing had to be
 * factored out of `e2e/` to get here.
 *
 * DETERMINISM. Every shot pins what it depends on rather than inheriting it:
 *   - viewport 1440x1000, deviceScaleFactor 1 (retina would double every file);
 *   - the full settings object in localStorage BEFORE first paint, so no shot
 *     depends on a default. `diffWidth` is pinned to 'centered' on purpose even
 *     though the app now DEFAULTS to 'full' — see the note on SHOTS below;
 *   - analytics blocked, so no network request can vary a shot;
 *   - fonts loaded and two animation frames idle before the shutter.
 *
 * THE QUEUE SHOTS pin three more things, because the review queue is the one
 * surface in this set whose content does NOT come from a committed in-app
 * fixture. See QUEUE_ROWS and seedQueue below:
 *   - a fixed wall clock, so `8h ago` is a constant and not "8h after whenever
 *     you ran this";
 *   - the whole GitHub API faked at the network boundary — REST *and* GraphQL,
 *     since the row's CI state, unresolved-conversation count, diff size and
 *     base standing all arrive in one batched GraphQL query now — so the rows
 *     are the fixture's and nothing is fetched;
 *   - the shutter held until EVERY row's signals have landed, not just its size
 *     chip. The effort gauge is scaled to the largest churn CURRENTLY in the
 *     queue, so a shot taken mid-fetch sizes every bar against a smaller
 *     maximum; and a shot taken before the CI marks land is a different
 *     picture of the same page. settleQueueSignals waits on all four counts,
 *     each derived from the fixture so it cannot drift from it.
 *
 * FULL PAGE vs VIEWPORT, which is the one genuinely non-obvious part. Most
 * surfaces are shot `fullPage`, but the two step-2 diff surfaces are shot at
 * the VIEWPORT, because the demo diff makes that document ~2900px (unified) and
 * ~3200px (split) tall and a full-page shot of it is both unreadable and large.
 * The committed files are what proves this is the original recipe rather than a
 * preference: `step1-understand-*.png` is 1440x1120 — taller than the viewport,
 * so it can only be full-page — while `step2-inspect-*.png` is exactly 1440x1000
 * against a 2867px document, so it can only be a viewport clip.
 *
 * RESAMPLING. `/settings` is one long document (~6000px). It is shot full-page
 * at 1440 CSS px — so the LAYOUT is the real desktop layout — and then
 * downsampled to 780px wide with `sips`, which is what keeps a 6000px page to
 * ~550KB. `sips` is macOS-only; the script says so rather than failing oddly.
 *
 * SIZE DISCIPLINE. Eighteen shots, ~2.9MB total. If a change pushes that up,
 * that is a signal to look at the shot, not to raise the budget.
 *
 * WHAT DETERMINISM DOES NOT COVER, because it will mislead you otherwise. Two
 * runs of the SAME build give eighteen byte-identical files. Across commits,
 * TEN of them change even when nothing visual moved: BuildIndicator.svelte
 * renders BUILD_SHA and BUILD_TIME (Vite bakes them in at build time), and that
 * footer falls inside the captured area on landing-* (y=969 of a 1000px page),
 * settings-models-* (y=5983 of 6014), step1-understand-* (y=1089 of 1120 — the
 * footer is why that shot is 1120 and not 1000) and both queue-* pairs. It never
 * enters the step-2 shots, which clip at 1000px while the footer sits at y=2836,
 * and on step3-verdict-* the sticky draft bar covers it. So a byte diff on those
 * ten proves nothing on its own; the reported DIMENSIONS, and the other eight
 * files, are the signal worth reading.
 *
 * The queue shots cannot escape that, and it is worth saying why rather than
 * leaving the next person to retry it. Both queue pages are SHORTER than the
 * viewport, and App.svelte's sticky-footer column therefore pins the footer to
 * the bottom of the frame (e2e/build-footer-sticky.spec.ts). Clipping earlier
 * does not help: the footer only leaves the frame once the content itself
 * reaches 1000px, at which point the clip cuts the queue card instead. A
 * complete card with a changing footer beats a truncated card without one.
 */

import { chromium } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'

const SHOTS_DIR = 'docs/design/shots'

/** Viewport every shot is taken at. Changing it invalidates the whole set. */
const VIEWPORT = { width: 1440, height: 1000 }

/**
 * The review-flow settings, pinned in full.
 *
 * `diffWidth: 'centered'` is deliberate and is NOT a stale value. The app's
 * default moved to 'full' (plan, Phase 3 item 4 — 72 columns per split pane
 * against 51, and 4.1 % of rows wrapping against 16.2 %). The shots stay
 * centered so that the before/after axis of this directory remains the TOKEN
 * AND COMPONENT layer, one variable at a time. A width comparison is a
 * different measurement and belongs in the plan's own table, not smuggled into
 * every diff shot at once.
 */
const REVIEW_SETTINGS = {
  diffMode: 'unified',
  diffWidth: 'centered',
  focusMode: 'imports',
  railCollapsed: true,
  deepseekKey: '',
}

/**
 * The review queue's settings. The queue section only EXISTS when a provider
 * has auth configured, and Prepare only renders live (rather than disabled with
 * a "no API key" title) when the active LLM provider has a credential — so both
 * are pinned here. Neither token is ever used: every request either side of
 * them would make is faked in seedQueue.
 */
const QUEUE_SETTINGS = {
  githubAuth: { token: 'ghp_design_shot', method: 'pat', scopes: [] },
  deepseekKey: 'sk-design-shot',
  aiProvider: 'deepseek',
}

/**
 * The wall clock the queue shots are taken at. `relativeTime` renders every row
 * as "35m ago" / "3d ago" against Date.now(), so without a fixed clock the
 * ages in the committed PNGs would be whatever they happened to be the day
 * someone re-shot them, and every re-shoot would diff.
 */
const QUEUE_NOW = new Date('2026-03-12T15:00:00.000Z')

/**
 * The queue fixture — twelve pull requests over four repos.
 *
 * It exists to PHOTOGRAPH the row layout, so it is shaped to make that layout
 * work: five-digit PR numbers next to two-digit ones, titles from 12 to 95
 * characters, diffs from `+4 −0` to `+1183 −1902` (a 760× churn spread, so the
 * effort gauge has both ends of its range on screen), four repo groups, and
 * both lists — "Your open PRs" and "Awaiting your review" — non-empty.
 *
 * The signals columns are fixtured the same way, so the shot documents STATES
 * and not just a layout. Between them the rows cover every branch the row can
 * take:
 *   ci         — 'SUCCESS' | 'FAILURE' | 'PENDING', and `null` for a PR with no
 *                checks configured at all (which draws no mark — the one thing
 *                it must not look like is a pass).
 *   unresolved — 0 through 12, so the column has an empty case and a two-digit
 *                one. Every row is served one RESOLVED thread on top, which is
 *                what makes the shot evidence that the count is of threads and
 *                not of everything in the list — and, since the row renders a
 *                FRACTION, what puts a visible denominator in the picture:
 *                `2/3`, `4/5`, `12/13`. The +1 is the whole reason the
 *                numerator and denominator differ in the shot at all.
 *   merge      — 'BEHIND' (draws the Update control), 'DIRTY' (draws
 *                "conflicts", deliberately NOT a button) and 'CLEAN' (draws
 *                nothing). Only meaningful on `mine` rows, since that is the
 *                only subset whose base standing the page resolves.
 *
 * ONE ROW STATE IS DELIBERATELY NOT IN THESE SHOTS, and it is worth saying so
 * rather than leaving the next person to wonder whether they broke it. The
 * actions column's "Fix CI" control appears only when a bridge is PAIRED,
 * write-enabled, has a coding agent on PATH, and HAS that pull request's head
 * commit in its object store — see canOfferCiFix in Landing.svelte. No shot
 * pairs a bridge, so no shot draws it, and `posthog-foss#91` (mine, FAILURE) is
 * photographed exactly as a user without a bridge sees it. Shooting it would
 * mean faking a local process into a picture captioned "signed in and full",
 * which documents a state most readers never reach.
 *
 * (That last condition used to read "is checked out at that exact pull
 * request's head", which is what made the control unreachable in practice — a
 * checkout sits on one commit at a time. It is containment now, so several rows
 * can offer it at once. It still takes a paired bridge, so these shots are
 * unaffected either way.)
 *
 * `e2e/queue-columns.spec.ts` has a deliberately similar fixture and they are
 * NOT shared on purpose: that one MEASURES column alignment and is free to
 * change its data whenever a tighter measurement wants different numbers, while
 * this one is the subject of committed PNGs and must not move under them.
 *
 * `ageMin` is minutes before QUEUE_NOW, not before now.
 */
const QUEUE_OWNER = 'posthog'
const QUEUE_ROWS = [
  // Your open PRs — the section the page now leads with.
  { repo: 'posthog', n: 21990, title: 'feat: add a new dashboard tile type', add: 41, del: 12, ageMin: 90, mine: true, ci: 'SUCCESS', unresolved: 2, merge: 'BEHIND' },
  { repo: 'posthog-foss', n: 91, title: 'feat(api): expose the query endpoint to personal api keys with scoped permissions', add: 155, del: 43, ageMin: 45, mine: true, ci: 'FAILURE', unresolved: 4, merge: 'DIRTY' },
  { repo: 'posthog-foss', n: 88, title: 'build: pin node to 20', add: 9, del: 9, ageMin: 720, mine: true, ci: 'SUCCESS', unresolved: 0, merge: 'CLEAN' },
  // Awaiting your review.
  { repo: 'posthog', n: 21902, title: 'fix: flaky test', add: 4, del: 0, ageMin: 35, ci: 'SUCCESS', unresolved: 0 },
  { repo: 'posthog', n: 21841, title: 'feat(surveys): allow multiple choice questions to be randomized', add: 216, del: 179, ageMin: 480, ci: 'FAILURE', unresolved: 3 },
  { repo: 'posthog', n: 21733, title: 'refactor(insights): extract the trends query runner out of the insight serializer', add: 66, del: 4, ageMin: 125, ci: 'PENDING', unresolved: 1 },
  { repo: 'posthog', n: 20117, title: 'chore(deps): bump the whole frontend toolchain to the latest majors and regenerate the lockfile', add: 1183, del: 1902, ageMin: 4320, ci: 'SUCCESS', unresolved: 12 },
  { repo: 'posthog-js', n: 1211, title: 'feat: session recording canvas support behind a flag', add: 402, del: 88, ageMin: 1560, ci: 'FAILURE', unresolved: 0 },
  { repo: 'posthog-js', n: 1204, title: 'fix(autocapture): do not capture password inputs', add: 18, del: 7, ageMin: 300, ci: null, unresolved: 2 },
  { repo: 'posthog-js', n: 1180, title: 'docs: readme', add: 6, del: 2, ageMin: 10080, ci: 'SUCCESS', unresolved: 0 },
  { repo: 'plugin-server', n: 3312, title: 'fix(ingestion): drop events with malformed distinct ids instead of dead-lettering them', add: 240, del: 64, ageMin: 15, ci: 'PENDING', unresolved: 5 },
  { repo: 'plugin-server', n: 3290, title: 'chore: tidy imports', add: 12, del: 30, ageMin: 2880, ci: 'SUCCESS', unresolved: 0 },
]

/**
 * The set. Each entry is shot once per theme as `<name>-<theme>.png`.
 *
 * `step` is how far into the demo review flow to walk: 1 = Understand (the
 * landing step of /demo), 2 = Inspect, 3 = Verdict.
 *
 * `queue` is 'rows' or 'empty' — see seedQueue.
 */
const SHOTS = [
  {
    name: 'landing',
    path: '/',
    settings: {},
    fullPage: true,
  },
  {
    // The review queue, signed in and full. Twelve rows still fit inside the
    // viewport, so full-page and a viewport clip produce the same 1440x1000
    // frame — full-page is the honest label for what it is.
    name: 'queue',
    path: '/',
    settings: QUEUE_SETTINGS,
    queue: 'rows',
    fullPage: true,
  },
  {
    // The queue's empty state (p.203-204: an empty state is a designed state).
    // Signed in, nothing waiting. Full-page, because the whole document is
    // shorter than the viewport.
    name: 'queue-empty',
    path: '/',
    settings: QUEUE_SETTINGS,
    queue: 'empty',
    fullPage: true,
  },
  {
    name: 'settings-models',
    path: '/settings/ai-models',
    settings: {},
    fullPage: true,
    // Shot at 1440 then downsampled; see RESAMPLING above.
    resampleWidth: 780,
  },
  {
    name: 'step1-understand',
    path: '/demo',
    settings: REVIEW_SETTINGS,
    step: 1,
    fullPage: true,
  },
  {
    name: 'step2-inspect-unified',
    path: '/demo',
    settings: { ...REVIEW_SETTINGS, diffMode: 'unified' },
    step: 2,
    fullPage: false,
  },
  {
    name: 'step2-inspect-split',
    path: '/demo',
    settings: { ...REVIEW_SETTINGS, diffMode: 'split' },
    step: 2,
    fullPage: false,
  },
  {
    // KNOWN DUPLICATE, reproduced faithfully rather than quietly "fixed".
    // focus-dim-*.png is byte-identical to step2-inspect-unified-*.png in the
    // committed set, because focus mode's import dimming is already on in the
    // unified shot (`focusMode: 'imports'`), so the two recipes ARE the same
    // recipe. The plan records the duplication too. Giving this shot a distinct
    // subject (e.g. shooting it against `focusMode: 'off'` to show the contrast)
    // is a content decision about what the directory should document, not a
    // capture-tooling one, so it is left for whoever makes that call.
    name: 'focus-dim',
    path: '/demo',
    settings: { ...REVIEW_SETTINGS, diffMode: 'unified', focusMode: 'imports' },
    step: 2,
    fullPage: false,
  },
  {
    name: 'step3-verdict',
    path: '/demo',
    settings: REVIEW_SETTINGS,
    step: 3,
    fullPage: true,
  },
]

const THEMES = ['light', 'dark']

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const arg = (flag) => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}
const CHECK = argv.includes('--check')
const ONLY = arg('--only')
const BASE_URL = arg('--base-url')
/**
 * A port nothing else is on.
 *
 * The default used to be the literal 4820. Every finished agent worktree in
 * this repo tends to leave a `vite preview` behind, so a fixed default is a
 * collision waiting to happen — and with --strictPort the failure is a bare
 * "port in use", while WITHOUT it the far worse outcome is photographing
 * another worktree's build and never knowing. playwright.config.ts documents
 * the same hazard and answers it with E2E_PORT; this asks the OS instead, so
 * there is no number for anyone to keep out of the way of.
 *
 * An explicit --port is still honoured verbatim, and still strict: someone who
 * names a port wants that port, and should be told when it is taken.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    // No host: bind every interface, so the probe sees a port as taken whether
    // the squatter is on 127.0.0.1 or ::1. `vite preview` binds ::1, and the
    // stale servers this exists to dodge were all IPv6 — probing 127.0.0.1
    // alone would have called those ports free.
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const PORT = arg('--port') !== undefined ? Number(arg('--port')) : await freePort()

const selected = ONLY ? SHOTS.filter((s) => s.name === ONLY) : SHOTS
if (selected.length === 0) {
  console.error(`No shot named "${ONLY}". Known: ${SHOTS.map((s) => s.name).join(', ')}`)
  process.exit(1)
}

const outDir = CHECK ? mkdtempSync(join(tmpdir(), 'shots-check-')) : resolve(SHOTS_DIR)
mkdirSync(outDir, { recursive: true })

// ---------------------------------------------------------------------------
// preview server
// ---------------------------------------------------------------------------

/**
 * Serve the CURRENT tree. The shots must show the build under review, so this
 * always builds rather than trusting whatever is in dist/ — unless the caller
 * points at their own server with --base-url.
 */
async function serve() {
  if (BASE_URL) return { base: BASE_URL, stop: () => {} }

  console.log('• building…')
  execFileSync('pnpm', ['build'], { stdio: 'inherit' })

  console.log(`• serving on :${PORT}…`)
  const proc = spawn('pnpm', ['preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  })
  const base = `http://localhost:${PORT}`
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const r = await fetch(base + '/')
      if (r.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview did not come up on ${base}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return { base, stop: () => proc.kill() }
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/** PNG dimensions straight out of the IHDR chunk — no image dependency. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * Walk the demo to `step`. /demo opens ON step 1, so 1 is a no-op.
 *
 * Step 2's "Next step" is matched with .first() because the story controls
 * carry one too; step 3's lives in the draft bar, which is unambiguous.
 */
async function gotoStep(page, step) {
  if (step >= 2) {
    await page.getByRole('button', { name: /next step/i }).first().click()
    await page.locator('.diff-tailwindcss-wrapper').first().waitFor({ timeout: 30_000 })
  }
  if (step >= 3) {
    await page.locator('.draft-bar').getByRole('button', { name: /next step/i }).click()
  }
}

/**
 * Fake the whole GitHub API for a queue shot.
 *
 * `mode` is 'rows' (serve QUEUE_ROWS) or 'empty' (serve nothing, so the queue's
 * designed empty state renders — note it needs auth configured to exist at all,
 * which is why the empty shot still carries QUEUE_SETTINGS).
 *
 * Three endpoints matter. `/search/issues` is asked twice by
 * githubProvider.getMyQueue — once with `review-requested:@me` and once with
 * `author:@me` — and those two answers are what split the page's two lists.
 * `/graphql` is the batched signals query: CI state, unresolved review threads,
 * diff size and base standing for every row in one document (and a second,
 * separate document for the `mine` rows' merge state). `/repos/:o/:r/pulls/:n`
 * is the REST size fetch, which is now only reached for rows the GraphQL query
 * could not answer — it stays faked so a fixture mistake shows up as a missing
 * chip rather than as a live request. Anything else answers `[]` rather than
 * escaping to the network.
 */
async function seedQueue(context, mode) {
  const rows = mode === 'empty' ? [] : QUEUE_ROWS
  const searchItem = (r) => ({
    number: r.n,
    title: r.title,
    updated_at: new Date(QUEUE_NOW.getTime() - r.ageMin * 60_000).toISOString(),
    repository_url: `https://api.github.com/repos/${QUEUE_OWNER}/${r.repo}`,
  })

  /**
   * Pull the aliased PRs out of a signals document, in order.
   *
   * Both documents the app sends are built the same way — `pN: repository(owner:
   * "…", name: "…") { … pullRequest(number: N) …` — so one matcher reads either,
   * and the response is keyed by the alias the app itself chose rather than by
   * an index this file would have to keep in step.
   */
  const aliasesOf = (query) =>
    [...query.matchAll(/(p\d+): repository\(owner: "[^"]+", name: "([^"]+)"\)[\s\S]*?pullRequest\(number: (\d+)\)/g)]
      .map(([, alias, repo, number]) => ({
        alias,
        row: rows.find((r) => r.repo === repo && String(r.n) === number),
      }))

  const signalsNode = (row) => ({
    viewerPermission: 'WRITE',
    pullRequest: {
      additions: row.add,
      deletions: row.del,
      mergeable: row.merge === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE',
      headRefOid: `sha${row.n}`,
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [
          ...Array.from({ length: row.unresolved ?? 0 }, () => ({ isResolved: false })),
          // One RESOLVED thread on every row. The count in the shot is of
          // unresolved threads, and a fixture that only ever served unresolved
          // ones would photograph a total just as happily.
          { isResolved: true },
        ],
      },
      commits: { nodes: [{ commit: { statusCheckRollup: row.ci ? { state: row.ci } : null } }] },
    },
  })

  await context.route('**/api.github.com/**', (route) => {
    const url = new URL(route.request().url())

    if (url.pathname === '/graphql') {
      const query = JSON.parse(route.request().postData() ?? '{}').query ?? ''
      // The merge-state document is the one that does NOT ask for threads.
      const isMergeState = !query.includes('reviewThreads')
      const data = {}
      for (const { alias, row } of aliasesOf(query)) {
        if (!row) continue
        data[alias] = isMergeState
          ? { pullRequest: { mergeStateStatus: row.merge ?? 'CLEAN' } }
          : signalsNode(row)
      }
      return route.fulfill({ json: { data } })
    }

    if (url.pathname === '/search/issues') {
      const mine = (url.searchParams.get('q') ?? '').includes('author:')
      const items = rows.filter((r) => Boolean(r.mine) === mine).map(searchItem)
      return route.fulfill({ json: { total_count: items.length, items } })
    }

    const m = url.pathname.match(/^\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/)
    if (m) {
      const row = rows.find((r) => r.repo === m[1] && String(r.n) === m[2])
      return route.fulfill({ json: { additions: row?.add ?? 0, deletions: row?.del ?? 0 } })
    }

    return route.fulfill({ json: [] })
  })
}

/**
 * What the queue shot must be holding before the shutter fires, derived from
 * QUEUE_ROWS so it cannot drift from the fixture.
 *
 * A count per column, because every one of them is filled ASYNCHRONOUSLY and
 * each has its own way of making two runs differ:
 *   size       — the effort gauge scales each bar to the largest churn CURRENTLY
 *                known, so a shot with ten of twelve sizes in hand draws ten
 *                bars against the wrong maximum;
 *   ci         — a mark that lands after the shutter is simply a different
 *                picture of the same page;
 *   unresolved — same;
 *   base       — the Update control and the "conflicts" note arrive on a SECOND
 *                request (the merge-state document), so they can land a beat
 *                after everything else.
 *
 * Only rows that actually DRAW something are counted: a PR with no CI
 * configured draws no mark, a PR with nothing unresolved draws no count, and a
 * CLEAN branch draws nothing at all. Counting rows instead of marks would wait
 * forever on elements that are correctly absent.
 */
function queueExpectations() {
  return {
    'queue-size': QUEUE_ROWS.length,
    'queue-ci': QUEUE_ROWS.filter((r) => r.ci).length,
    'queue-unresolved': QUEUE_ROWS.filter((r) => (r.unresolved ?? 0) > 0).length,
    'queue-base': QUEUE_ROWS.filter((r) => r.merge === 'BEHIND' || r.merge === 'DIRTY').length,
  }
}

/** Hold the shutter until every signal the fixture promises is on screen. */
async function settleQueueSignals(page, mode) {
  if (mode === 'empty') return
  for (const [testid, expected] of Object.entries(queueExpectations())) {
    try {
      await page.waitForFunction(
        ({ testid: id, n }) => document.querySelectorAll(`[data-testid="${id}"]`).length === n,
        { testid, n: expected },
        { timeout: 30_000 },
      )
    } catch (err) {
      // A bare "Timeout 30000ms exceeded" names neither the column that never
      // landed nor how far off it was, and the fixture is the first place to
      // look for both. Saying it costs one evaluate on a path that is already
      // failing.
      const actual = await page
        .evaluate((id) => document.querySelectorAll(`[data-testid="${id}"]`).length, testid)
        .catch(() => 'unknown')
      throw new Error(
        `queue shot: waited for ${expected} [data-testid="${testid}"], saw ${actual}. ` +
          `Either the fixture and queueExpectations() disagree, or the page never finished ` +
          `loading that column. (${err.message})`,
      )
    }
  }
}

/** Fonts done + two idle frames, so nothing is mid-layout when the shutter fires. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  await page.waitForTimeout(400)
}

async function capture(browser, base, shot, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  // No shot may depend on the network.
  await context.route('**/*posthog.com/**', (r) => r.abort())
  await context.route('**/us.i.posthog.com/**', (r) => r.abort())
  if (shot.queue) {
    // Date.now() frozen; timers keep running, so the app still loads normally.
    await context.clock.setFixedTime(QUEUE_NOW)
    await seedQueue(context, shot.queue)
  }
  await context.addInitScript(
    (s) => localStorage.setItem('review123:settings', JSON.stringify(s)),
    { ...shot.settings, theme },
  )

  const page = await context.newPage()
  await page.goto(base + shot.path, { waitUntil: 'networkidle' })
  await gotoStep(page, shot.step ?? 1)
  if (shot.queue) await settleQueueSignals(page, shot.queue)
  await settle(page)

  const file = join(outDir, `${shot.name}-${theme}.png`)
  await page.screenshot({ path: file, fullPage: shot.fullPage })
  await context.close()

  if (shot.resampleWidth) {
    try {
      execFileSync('sips', ['--resampleWidth', String(shot.resampleWidth), file, '--out', file], {
        stdio: 'ignore',
      })
    } catch (err) {
      throw new Error(
        `sips failed for ${file}. sips is macOS-only; on another platform ` +
          `resample to ${shot.resampleWidth}px wide by hand. (${err.message})`,
      )
    }
  }

  const buf = readFileSync(file)
  return { file, ...pngSize(buf), bytes: buf.length }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const { base, stop } = await serve()
const browser = await chromium.launch()
const rows = []

try {
  for (const shot of selected) {
    for (const theme of THEMES) {
      // Read the committed dimensions BEFORE shooting: outside --check the
      // shot overwrites the very file it is compared against, so reading after
      // would compare a file with itself and report "same size" forever.
      const committed = join(SHOTS_DIR, `${shot.name}-${theme}.png`)
      const was = existsSync(committed) ? pngSize(readFileSync(committed)) : null

      const got = await capture(browser, base, shot, theme)
      const verdict = !was
        ? 'new'
        : was.width === got.width && was.height === got.height
          ? 'same size'
          : `SIZE CHANGED ${was.width}x${was.height} → ${got.width}x${got.height}`
      rows.push(
        `${(shot.name + '-' + theme).padEnd(28)} ${String(got.width).padStart(5)}x${String(
          got.height,
        ).padEnd(5)} ${String(Math.round(got.bytes / 1024)).padStart(5)}KB  ${verdict}`,
      )
      console.log('  ' + rows.at(-1))
    }
  }
} finally {
  await browser.close()
  stop()
}

const total = selected.flatMap((s) =>
  THEMES.map((t) => statSync(join(outDir, `${s.name}-${t}.png`)).size),
).reduce((a, b) => a + b, 0)

console.log(`\n${rows.length} shots, ${(total / 1024 / 1024).toFixed(2)} MB`)
if (CHECK) console.log(`--check: wrote nothing to ${SHOTS_DIR}; output in ${outDir}`)
