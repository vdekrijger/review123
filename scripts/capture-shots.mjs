#!/usr/bin/env node
/**
 * scripts/capture-shots.mjs — regenerates docs/design/shots/.
 *
 *   node scripts/capture-shots.mjs                  # build, serve, shoot all 14
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
 * SIZE DISCIPLINE. Fourteen shots, ~2.5MB total. If a change pushes that up,
 * that is a signal to look at the shot, not to raise the budget.
 */

import { chromium } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

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
 * The set. Each entry is shot once per theme as `<name>-<theme>.png`.
 *
 * `step` is how far into the demo review flow to walk: 1 = Understand (the
 * landing step of /demo), 2 = Inspect, 3 = Verdict.
 */
const SHOTS = [
  {
    name: 'landing',
    path: '/',
    settings: {},
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
const PORT = Number(arg('--port') ?? 4820)

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
  await context.addInitScript(
    (s) => localStorage.setItem('review123:settings', JSON.stringify(s)),
    { ...shot.settings, theme },
  )

  const page = await context.newPage()
  await page.goto(base + shot.path, { waitUntil: 'networkidle' })
  await gotoStep(page, shot.step ?? 1)
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
