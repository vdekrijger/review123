/**
 * FileDiff × per-hunk attention (src/lib/guide/hunkAttention):
 *
 *   - mechanical hunks recede (class `hunk-receded`) in unified AND split,
 *     decision hunks never do, and expanded/unrelated rows are untouched
 *   - the in-diff marker names WHY, and "Show normally" restores the hunk
 *   - a hunk carrying a finding or a draft is NEVER receded (the override)
 *   - the per-file "what changed" strip: entries, jump targets, the
 *     "nothing substantive" case
 *   - composition with focus mode (both dimming layers coexist)
 *   - the off switch turns the whole layer inert
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { tick } from 'svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import { slugify } from '../lib/slug'
import { setFocusMode } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'
import {
  setHunkAttentionEnabled,
  getHunkAttentionEnabled,
  toggleHunkAttention,
  _resetHunkAttentionPrefForTest,
} from '../lib/guide/hunkAttentionPref.svelte'

// jsdom has no canvas — the diff library probes getContext for measurement.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

// jsdom implements no scrolling — the jump path calls scrollIntoView.
Element.prototype.scrollIntoView = function () {}

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame
}

beforeEach(() => {
  localStorage.clear()
  _resetSettingsStateForTest()
  _resetHunkAttentionPrefForTest()
})

/** Wait for the decorate action's rAF + MutationObserver to settle. */
async function settle() {
  await tick()
  await new Promise((r) => setTimeout(r, 50))
  await tick()
  await new Promise((r) => setTimeout(r, 10))
}

// Hunk 0: pure re-indentation (mechanical). Hunk 1: a real new branch inside
// resolveCompactor (decision).
const MIXED_PATCH = [
  '@@ -1,3 +1,3 @@',
  ' const header = 1',
  '-  const spacing = 2',
  '+    const spacing = 2',
  ' const footer = 3',
  '@@ -40,2 +40,3 @@ export function resolveCompactor() {',
  ' const pre = 1',
  '+  if (mode === "wide") return wide',
  ' const post = 2',
].join('\n')

function makeFile(patch = MIXED_PATCH, filename = 'src/compact.ts'): PrFile {
  return { filename, status: 'modified', additions: 2, deletions: 1, patch }
}

const RECEDED_SEL =
  '.diff-line-content.hunk-receded, .diff-line-old-content.hunk-receded, .diff-line-new-content.hunk-receded'

function recededTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(RECEDED_SEL)].map(
    (c) => c.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
}

describe('FileDiff — per-hunk recession', () => {
  for (const mode of ['unified', 'split'] as const) {
    it(`[${mode}] recedes the mechanical hunk and leaves the decision hunk bright`, async () => {
      const { container } = render(FileDiff, { props: { file: makeFile(), mode } })
      await settle()
      const texts = recededTexts(container)
      expect(texts.some((t) => t.includes('const spacing = 2'))).toBe(true)
      // Context lines of the mechanical hunk recede with it — the whole block
      // reads as one receded unit.
      expect(texts.some((t) => t.includes('const header = 1'))).toBe(true)
      // The decision hunk is untouched.
      expect(texts.some((t) => t.includes('if (mode ==='))).toBe(false)
      expect(texts.some((t) => t.includes('const pre = 1'))).toBe(false)
    })

    it(`[${mode}] renders a marker naming why, and restores on click`, async () => {
      const { container } = render(FileDiff, { props: { file: makeFile(), mode } })
      await settle()
      const marker = screen.getByTestId('hunk-marker')
      expect(marker.textContent).toContain('formatting only')
      expect(marker.textContent).toContain('2 lines')

      await userEvent.click(screen.getByTestId('hunk-marker-restore'))
      await settle()
      expect(container.querySelectorAll(RECEDED_SEL).length).toBe(0)
      expect(screen.queryByTestId('hunk-marker')).toBeNull()
    })

    it(`[${mode}] recedes nothing when the preference is off`, async () => {
      setHunkAttentionEnabled(false)
      const { container } = render(FileDiff, { props: { file: makeFile(), mode } })
      await settle()
      expect(container.querySelectorAll(RECEDED_SEL).length).toBe(0)
      expect(screen.queryByTestId('hunk-marker')).toBeNull()
      expect(screen.queryByTestId('change-strip')).toBeNull()
    })
  }

  it('never recedes a hunk that carries a reviewer finding', async () => {
    const { container } = render(FileDiff, {
      props: {
        file: makeFile(),
        mode: 'unified',
        skillFindings: [
          { skillName: 'sec', line: 2, severity: 'high', body: 'look here', key: 'f1' },
        ],
      },
    })
    await settle()
    expect(container.querySelectorAll(RECEDED_SEL).length).toBe(0)
    expect(screen.queryByTestId('hunk-marker')).toBeNull()
  })

  it('never recedes a hunk that carries a draft comment', async () => {
    const { container } = render(FileDiff, {
      props: {
        file: makeFile(),
        mode: 'unified',
        drafts: [
          { prKey: 'demo', path: 'src/compact.ts', line: 2, side: 'RIGHT', body: 'mine', n: 0 },
        ],
      },
    })
    await settle()
    expect(container.querySelectorAll(RECEDED_SEL).length).toBe(0)
  })

  it('composes with focus mode — an import hunk is both noise-dimmed and receded', async () => {
    setFocusMode('imports')
    _resetSettingsStateForTest()
    const patch = [
      '@@ -1,2 +1,3 @@',
      " import a from './a'",
      "+import b from './b'",
      ' const keep = 1',
      '@@ -30,2 +30,3 @@ function compute() {',
      ' const pre = 1',
      '+  return pre * 2',
      ' const post = 2',
    ].join('\n')
    const { container } = render(FileDiff, { props: { file: makeFile(patch), mode: 'unified' } })
    await settle()
    const both = [
      ...container.querySelectorAll('.diff-line-content.hunk-receded.dimmed-noise'),
    ].map((c) => c.textContent ?? '')
    expect(both.some((t) => t.includes("from './b'"))).toBe(true)
    // Focus mode alone still leaves the decision hunk's real code bright.
    expect(recededTexts(container).some((t) => t.includes('return pre * 2'))).toBe(false)
  })
})

describe('FileDiff — the "what changed" strip', () => {
  it('names the decision point, folds the churn, and carries jump targets', async () => {
    render(FileDiff, { props: { file: makeFile(), mode: 'unified' } })
    await settle()
    const strip = screen.getByTestId('change-strip')
    expect(strip.textContent).toContain('What changed')
    const entries = screen.getAllByTestId('change-strip-entry')
    expect(entries.map((e) => e.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'resolveCompactor +1',
      '1 formatting hunk',
    ])
    expect(entries[0].getAttribute('data-attention')).toBe('decision')
    expect(entries[0].getAttribute('data-hunk-index')).toBe('1')
    expect(entries[1].getAttribute('data-attention')).toBe('mechanical')
    expect(entries[1].getAttribute('data-hunk-index')).toBe('0')
  })

  it('renders a symbol entry as code and a group entry as prose', async () => {
    const { container } = render(FileDiff, { props: { file: makeFile(), mode: 'unified' } })
    await settle()
    const labels = [...container.querySelectorAll('.change-strip-label')]
    expect(labels[0].tagName).toBe('CODE')
    expect(labels[1].tagName).toBe('SPAN')
  })

  it('jumps to the hunk when an entry is clicked', async () => {
    // The jump reuses the symbol click-through mechanism, which resolves the
    // `#file-<slug>` wrapper InspectStep renders around every card — so the
    // test provides that wrapper as the render container.
    const file = makeFile()
    const host = document.createElement('div')
    host.id = `file-${slugify(file.filename)}`
    document.body.appendChild(host)
    render(FileDiff, { props: { file, mode: 'unified' }, target: host })
    await settle()

    await userEvent.click(screen.getAllByTestId('change-strip-entry')[0])
    await settle()
    const flashed = host.querySelector('tr.symbol-jump-flash')
    expect(flashed).not.toBeNull()
    expect(flashed?.textContent).toContain('const pre = 1')
  })

  it('says so plainly when nothing substantive changed', async () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' const header = 1',
      '-  const spacing = 2',
      '+    const spacing = 2',
      ' const footer = 3',
    ].join('\n')
    render(FileDiff, { props: { file: makeFile(patch), mode: 'unified' } })
    await settle()
    const strip = screen.getByTestId('change-strip')
    expect(strip.textContent).toContain('Nothing substantive')
    expect(strip.textContent).toContain('every hunk here is mechanical')
    expect(strip.textContent).not.toContain('What changed')
  })

  it('shows no strip for a file with no hunks to describe', async () => {
    render(FileDiff, {
      props: {
        file: { filename: 'img.png', status: 'modified', additions: 0, deletions: 0 },
        mode: 'unified',
      },
    })
    await settle()
    expect(screen.queryByTestId('change-strip')).toBeNull()
  })
})

describe('hunk-attention preference', () => {
  it('defaults to on', () => {
    expect(getHunkAttentionEnabled()).toBe(true)
  })

  it('persists across a reload', () => {
    setHunkAttentionEnabled(false)
    expect(localStorage.getItem('review123:hunk-attention')).toBe('{"enabled":false}')
    _resetHunkAttentionPrefForTest()
    expect(getHunkAttentionEnabled()).toBe(false)
  })

  it('toggles both ways', () => {
    expect(toggleHunkAttention()).toBe(false)
    expect(toggleHunkAttention()).toBe(true)
    expect(getHunkAttentionEnabled()).toBe(true)
  })

  it('reads a corrupt entry as on', () => {
    localStorage.setItem('review123:hunk-attention', 'not json')
    expect(getHunkAttentionEnabled()).toBe(true)
  })
})
