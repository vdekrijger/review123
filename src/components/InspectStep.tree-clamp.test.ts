/**
 * Tests for the tree height clamp wiring in InspectStep (--diff-col-h).
 *
 * The open .file-tree-nav must never be taller than the diff column it
 * accompanies. CSS cannot read a sibling's height, so InspectStep attaches a
 * ResizeObserver to .diff-column that mirrors its height into the
 * --diff-col-h custom property on .inspect-layout; the nav's CSS clamps to
 * min(calc(100vh - 5rem), max(12rem, var(--diff-col-h, 100vh))).
 *
 * jsdom cannot evaluate CSS and has no ResizeObserver, so these tests stub
 * the global ResizeObserver (the seam observeDiffColHeight defaults to) and
 * assert the WIRING: what gets observed, where the property lands, and that
 * everything is torn down on destroy. Geometry is proven in
 * e2e/tree-height-clamp.spec.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  callback: () => void
  observed: Element[] = []
  disconnected = false

  constructor(callback: () => void) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
}

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFiles(names: string[]): PrFile[] {
  return names.map(filename => ({
    filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH,
  }))
}

function renderStep() {
  return render(InspectStep, {
    props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
  })
}

beforeEach(() => {
  localStorage.clear()
  MockResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  // Deterministic rAF: run the frame synchronously
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('InspectStep — tree height clamp wiring (--diff-col-h)', () => {
  it('attaches a ResizeObserver to the .diff-column element', async () => {
    const { container } = renderStep()
    await tick()
    const diffCol = container.querySelector('.diff-column')
    expect(diffCol).toBeTruthy()
    expect(MockResizeObserver.instances).toHaveLength(1)
    expect(MockResizeObserver.instances[0].observed).toEqual([diffCol])
  })

  it('sets --diff-col-h on .inspect-layout from the diff column height', async () => {
    const { container } = renderStep()
    await tick()
    const layout = container.querySelector('.inspect-layout') as HTMLElement
    // jsdom geometry is all-zero; the wiring proof is that the property exists
    // in px and matches the (mocked) diff column rect height.
    expect(layout.style.getPropertyValue('--diff-col-h')).toBe('0px')

    // Simulate the diff column resizing (e.g. a card collapses)
    const diffCol = container.querySelector('.diff-column') as HTMLElement
    diffCol.getBoundingClientRect = () => ({ height: 512 }) as DOMRect
    MockResizeObserver.instances[0].callback()
    expect(layout.style.getPropertyValue('--diff-col-h')).toBe('512px')
  })

  it('disconnects the observer and removes the property on destroy', async () => {
    const { container, unmount } = renderStep()
    await tick()
    const layout = container.querySelector('.inspect-layout') as HTMLElement
    expect(layout.style.getPropertyValue('--diff-col-h')).toBe('0px')

    unmount()
    expect(MockResizeObserver.instances[0].disconnected).toBe(true)
    expect(layout.style.getPropertyValue('--diff-col-h')).toBe('')
  })

  it('does not observe anything when the PR has no files (no diff column)', async () => {
    render(InspectStep, {
      props: { files: [], changedFiles: 0, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    await tick()
    expect(MockResizeObserver.instances).toHaveLength(0)
  })
})

describe('InspectStep — renders without ResizeObserver (jsdom guard)', () => {
  it('mounts cleanly when ResizeObserver is undefined', async () => {
    // test-setup.ts stubs a global ResizeObserver (needed by @git-diff-view),
    // so absence must be simulated explicitly rather than assumed from jsdom.
    vi.stubGlobal('ResizeObserver', undefined)
    expect(typeof globalThis.ResizeObserver).toBe('undefined')
    const { container } = renderStep()
    await tick()
    const layout = container.querySelector('.inspect-layout') as HTMLElement
    expect(layout).toBeTruthy()
    expect(layout.style.getPropertyValue('--diff-col-h')).toBe('')
  })
})
