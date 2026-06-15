/**
 * SectionStatus.test.ts — the per-section header run-state indicator.
 *
 * Drives the SAME PanelStatus values the AiRun emits through the component and
 * asserts the rendered treatment per state: spinner while pending, a quiet ready
 * cue when done, a muted hint for no-key/declined/error — never a spinner for a
 * non-running state. Also checks the aria-live announcement text.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import SectionStatus from './SectionStatus.svelte'
import type { PanelStatus } from '../../lib/ai/run.svelte'

function renderStatus(status: PanelStatus) {
  return render(SectionStatus, { props: { status, title: 'Full summary' } })
}

describe('SectionStatus — pending states show the spinner', () => {
  for (const status of ['idle', 'loading', 'streaming'] as PanelStatus[]) {
    it(`renders the unified spinner for status="${status}"`, () => {
      const { container } = renderStatus(status)
      expect(container.querySelector('.ui-spinner')).not.toBeNull()
      // No ready/hint glyphs while pending
      expect(container.querySelector('.section-status-ready')).toBeNull()
      expect(container.querySelector('.section-status-hint')).toBeNull()
    })
  }

  it('does not announce noisy "loading" text while pending', () => {
    const { container } = renderStatus('loading')
    expect(container.querySelector('.section-status-live')?.textContent).toBe('')
  })
})

describe('SectionStatus — done state shows a quiet ready cue (no spinner)', () => {
  it('renders the ready cue and no spinner', () => {
    const { container } = renderStatus('done')
    expect(container.querySelector('.ui-spinner')).toBeNull()
    expect(container.querySelector('.section-status-ready')).not.toBeNull()
  })

  it('politely announces "<title> ready"', () => {
    const { container } = renderStatus('done')
    const live = container.querySelector('.section-status-live')
    expect(live?.getAttribute('aria-live')).toBe('polite')
    expect(live?.textContent).toBe('Full summary ready')
  })
})

describe('SectionStatus — problem states show a muted hint (no spinner)', () => {
  for (const status of ['no-key', 'declined', 'error'] as PanelStatus[]) {
    it(`renders a muted hint (not a spinner) for status="${status}"`, () => {
      const { container } = renderStatus(status)
      expect(container.querySelector('.ui-spinner')).toBeNull()
      expect(container.querySelector('.section-status-hint')).not.toBeNull()
    })
  }

  it('announces an honest unavailable message for error', () => {
    const { container } = renderStatus('error')
    expect(container.querySelector('.section-status-live')?.textContent).toMatch(/unavailable/i)
  })

  it('announces a needs-key message for no-key', () => {
    const { container } = renderStatus('no-key')
    expect(container.querySelector('.section-status-live')?.textContent).toMatch(/api key/i)
  })
})
