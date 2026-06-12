/**
 * Tests for drawer toggle/close semantics under the ADAPTIVE drawer contract.
 *
 * The margin-vs-inline decision is pure CSS (see InspectStep.svelte drawer CSS
 * and e2e/drawer-left.spec.ts for the geometry proofs). These tests cover the
 * JS-observable behaviour, which is identical in both regimes:
 *   - toggle tab opens/closes the drawer (aria-expanded, data-open)
 *   - the ✕ close button closes the drawer
 *   - no backdrop element exists at any viewport width
 *   - DOM order is drawer → tab → diff (inline mode re-orders visually via flex
 *     `order`, never via DOM manipulation)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

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

describe('InspectStep — drawer toggle semantics', () => {
  it('toggle tab opens the drawer: aria-expanded and data-open flip to true', async () => {
    const { container } = renderStep()
    const toggleBtn = screen.getByRole('button', { name: /open file tree/i })
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(toggleBtn)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.file-tree-drawer')?.getAttribute('data-open')).toBe('true')
  })

  it('toggle tab closes an open drawer again', async () => {
    const { container } = renderStep()
    const toggleBtn = screen.getByRole('button', { name: /open file tree/i })
    await userEvent.click(toggleBtn)
    await userEvent.click(toggleBtn)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.file-tree-drawer')?.getAttribute('data-open')).toBe('false')
  })

  it('✕ close button inside the drawer closes it', async () => {
    const { container } = renderStep()
    const toggleBtn = screen.getByRole('button', { name: /open file tree/i })
    await userEvent.click(toggleBtn)
    const closeBtn = container.querySelector('.tree-drawer-close') as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    await userEvent.click(closeBtn)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.file-tree-nav')).toBeNull()
  })
})

describe('InspectStep — no backdrop at any viewport width', () => {
  for (const width of [700, 1100, 1440, 1900]) {
    it(`@ ${width}px + open: no backdrop element is rendered`, async () => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width)
      const { container } = renderStep()
      await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
      expect(container.querySelector('.tree-backdrop')).toBeNull()
    })
  }
})

describe('InspectStep — DOM order is drawer → tab → diff', () => {
  it('drawer wrapper precedes the toggle tab, which precedes the diff column', async () => {
    const { container } = renderStep()
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    const layout = container.querySelector('.inspect-layout')
    const children = Array.from(layout?.children ?? [])
    const drawerIdx = children.findIndex(el => el.classList.contains('file-tree-drawer'))
    const tabIdx = children.findIndex(el => el.classList.contains('tree-toggle-tab'))
    const diffIdx = children.findIndex(el => el.classList.contains('diff-column'))
    expect(drawerIdx).toBeGreaterThanOrEqual(0)
    expect(tabIdx).toBeGreaterThan(drawerIdx)
    expect(diffIdx).toBeGreaterThan(tabIdx)
  })
})
