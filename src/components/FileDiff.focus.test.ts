import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import { setFocusMode } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

// jsdom has no canvas — the diff library probes getContext for measurement.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

// requestAnimationFrame is used by the focus-dim action; jsdom may lack it.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame
}

beforeEach(() => {
  localStorage.clear()
  _resetSettingsStateForTest()
})

// A patch that adds an import line, a comment line, and a real code line.
const PATCH = [
  '@@ -1,2 +1,4 @@',
  " import { foo } from './foo'",
  ' const keep = 1',
  "+import { bar } from './bar'",
  '+// a trailing comment line',
  '+const added = 2',
].join('\n')

function makeFile(filename = 'src/sample.ts'): PrFile {
  return { filename, status: 'modified', additions: 3, deletions: 0, patch: PATCH }
}

/** Wait for the focus-dim action's rAF + MutationObserver to settle. */
async function settle() {
  await tick()
  await new Promise((r) => setTimeout(r, 50))
  await tick()
  await new Promise((r) => setTimeout(r, 10))
}

const DIM_SEL =
  '.diff-line-content.dimmed-noise, .diff-line-old-content.dimmed-noise, .diff-line-new-content.dimmed-noise'

function dimmedRowTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(DIM_SEL)].map(
    (r) => r.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
}

describe('FileDiff — focus mode dimming', () => {
  for (const mode of ['unified', 'split'] as const) {
    it(`[${mode}] focusMode 'off' dims nothing`, async () => {
      setFocusMode('off')
      _resetSettingsStateForTest()
      const { container } = render(FileDiff, { props: { file: makeFile(), mode } })
      await settle()
      expect(container.querySelectorAll(DIM_SEL).length).toBe(0)
    })

    it(`[${mode}] focusMode 'imports' dims import lines (added + context)`, async () => {
      setFocusMode('imports')
      _resetSettingsStateForTest()
      const { container } = render(FileDiff, { props: { file: makeFile(), mode } })
      await settle()
      const texts = dimmedRowTexts(container)
      // Both the context import and the added import should be dimmed.
      expect(texts.some((t) => t.includes("from './foo'"))).toBe(true)
      expect(texts.some((t) => t.includes("from './bar'"))).toBe(true)
      // Comments are NOT dimmed in 'imports' mode.
      expect(texts.some((t) => t.includes('a trailing comment line'))).toBe(false)
      // Real code is never dimmed.
      expect(texts.some((t) => t.includes('const keep'))).toBe(false)
      expect(texts.some((t) => t.includes('const added'))).toBe(false)
    })

    it(`[${mode}] focusMode 'imports-comments' dims imports AND comments`, async () => {
      setFocusMode('imports-comments')
      _resetSettingsStateForTest()
      const { container } = render(FileDiff, { props: { file: makeFile(), mode } })
      await settle()
      const texts = dimmedRowTexts(container)
      expect(texts.some((t) => t.includes("from './bar'"))).toBe(true)
      expect(texts.some((t) => t.includes('a trailing comment line'))).toBe(true)
      // Real code still never dimmed.
      expect(texts.some((t) => t.includes('const keep'))).toBe(false)
      expect(texts.some((t) => t.includes('const added'))).toBe(false)
    })
  }

  // A patch that ADDS a multi-line import spanning opener + continuation lines +
  // closing `} from '…'`, then a real code line that must stay bright.
  const MULTILINE_PATCH = [
    '@@ -1,1 +1,7 @@',
    ' const keep = 1',
    '+import {',
    '+  WIDGET_LIST_COUNT_EVENTS,',
    '+  WidgetCardContent,',
    "+} from '../../components/WidgetCard'",
    '+const added = 2',
  ].join('\n')

  function makeMultilineFile(filename = 'src/widget.tsx'): PrFile {
    return { filename, status: 'modified', additions: 5, deletions: 0, patch: MULTILINE_PATCH }
  }

  for (const mode of ['unified', 'split'] as const) {
    it(`[${mode}] dims EVERY line of a multi-line import span (continuation + closing)`, async () => {
      setFocusMode('imports')
      _resetSettingsStateForTest()
      const { container } = render(FileDiff, {
        props: { file: makeMultilineFile(), mode },
      })
      await settle()
      const texts = dimmedRowTexts(container)
      // Opener, every continuation name, and the `} from '…'` closing line.
      expect(texts.some((t) => t.includes('import {'))).toBe(true)
      expect(texts.some((t) => t.includes('WIDGET_LIST_COUNT_EVENTS'))).toBe(true)
      expect(texts.some((t) => t.includes('WidgetCardContent'))).toBe(true)
      expect(texts.some((t) => t.includes("from '../../components/WidgetCard'"))).toBe(true)
      // Real code after the span stays bright.
      expect(texts.some((t) => t.includes('const added'))).toBe(false)
      expect(texts.some((t) => t.includes('const keep'))).toBe(false)
    })

    it(`[${mode}] toggling focus off clears multi-line-import dimming`, async () => {
      setFocusMode('imports')
      _resetSettingsStateForTest()
      const { container } = render(FileDiff, {
        props: { file: makeMultilineFile(), mode },
      })
      await settle()
      expect(container.querySelectorAll(DIM_SEL).length).toBeGreaterThan(0)

      setFocusMode('off')
      _resetSettingsStateForTest()
      await settle()
      expect(container.querySelectorAll(DIM_SEL).length).toBe(0)
    })
  }

  it('unknown extension dims nothing even with focus on', async () => {
    setFocusMode('imports-comments')
    _resetSettingsStateForTest()
    const { container } = render(FileDiff, {
      props: { file: makeFile('data.unknownext'), mode: 'unified' },
    })
    await settle()
    expect(container.querySelectorAll(DIM_SEL).length).toBe(0)
  })

  it('toggling focus off after on removes the dimmed class', async () => {
    setFocusMode('imports')
    _resetSettingsStateForTest()
    const { container } = render(FileDiff, { props: { file: makeFile(), mode: 'unified' } })
    await settle()
    expect(container.querySelectorAll(DIM_SEL).length).toBeGreaterThan(0)

    setFocusMode('off')
    _resetSettingsStateForTest()
    await settle()
    expect(container.querySelectorAll(DIM_SEL).length).toBe(0)
  })
})
