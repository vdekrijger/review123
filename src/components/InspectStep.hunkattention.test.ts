/**
 * InspectStep × per-hunk attention: the toolbar off switch, its persistence,
 * and composition with the surfaces that already guide attention ACROSS files
 * (risk-first sort + the collapsed mechanical tail, #223).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { tick } from 'svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import {
  getHunkAttentionEnabled,
  _resetHunkAttentionPrefForTest,
} from '../lib/guide/hunkAttentionPref.svelte'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})
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

async function settle() {
  await tick()
  await new Promise((r) => setTimeout(r, 50))
  await tick()
  await new Promise((r) => setTimeout(r, 10))
}

const PATCH = [
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

const FILES: PrFile[] = [
  { filename: 'src/compact.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
]

function renderInspect(files: PrFile[] = FILES) {
  return render(InspectStep, {
    props: {
      files,
      changedFiles: files.length,
      mode: 'unified',
      onmode: () => {},
      draftStore: null,
    },
  })
}

describe('InspectStep — the hunk-focus toggle', () => {
  it('renders on by default and shows the per-file strip', async () => {
    renderInspect()
    await settle()
    const toggle = screen.getByTestId('hunk-attention-toggle')
    expect(toggle.textContent).toContain('Hunk focus: on')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('change-strip')).toBeTruthy()
  })

  it('turning it off removes the strip and the receded rows', async () => {
    const { container } = renderInspect()
    await settle()
    expect(container.querySelectorAll('.hunk-receded').length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('hunk-attention-toggle'))
    await settle()

    expect(screen.getByTestId('hunk-attention-toggle').textContent).toContain('Hunk focus: off')
    expect(screen.queryByTestId('change-strip')).toBeNull()
    expect(screen.queryByTestId('hunk-marker')).toBeNull()
    expect(container.querySelectorAll('.hunk-receded').length).toBe(0)
  })

  it('persists the choice per browser', async () => {
    renderInspect()
    await settle()
    await userEvent.click(screen.getByTestId('hunk-attention-toggle'))
    await settle()
    _resetHunkAttentionPrefForTest()
    expect(getHunkAttentionEnabled()).toBe(false)
  })

  it('composes with the risk-first sort and the mechanical tail', async () => {
    const files: PrFile[] = [
      ...FILES,
      { filename: 'pnpm-lock.yaml', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,1 +1,1 @@\n-a: 1\n+a: 2' },
    ]
    renderInspect(files)
    await settle()
    // Risk-first groups the lockfile into the low-attention tail…
    await userEvent.click(screen.getByRole('button', { name: /risk first/i }))
    await settle()
    // …and the real file still gets its within-file guidance.
    const strips = screen.getAllByTestId('change-strip')
    expect(strips.length).toBeGreaterThan(0)
    expect(strips[0].textContent).toContain('resolveCompactor')
  })
})
