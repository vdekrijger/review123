/**
 * AiProgress.test.ts — the unified AI pending/streaming treatment.
 *
 * Priority contract (highest first):
 *   1. streaming + tokens started → streaming content only (no status/skeleton)
 *   2. otherwise → status line (always while pending)
 *   3. + activity log beneath when the task emits activity lines
 *   4. + content-shaped skeleton beneath
 * NEVER a bare skeleton that later layers a spinner; NEVER a spinner with no context.
 */

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import AiProgress from './AiProgress.svelte'

describe('AiProgress — priority order', () => {
  it('pending (loading): status line + skeleton, NO bare spinner', () => {
    const { container, getByText } = render(AiProgress, {
      props: { task: 'summary', state: { status: 'loading' } },
    })
    expect(getByText('Summarizing the change…')).toBeInTheDocument()
    expect(container.querySelector('.skeleton-block')).not.toBeNull()
    // Unified treatment never uses a divergent spinner ring inside the block
    expect(container.querySelector('.spinner')).toBeNull()
  })

  it('idle counts as pending — status line + skeleton from the first render', () => {
    const { container, getByText } = render(AiProgress, {
      props: { task: 'verdict', state: { status: 'idle' } },
    })
    expect(getByText('Forming a verdict…')).toBeInTheDocument()
    expect(container.querySelector('.skeleton-block')).not.toBeNull()
  })

  it('pending with activity: status line + activity log + skeleton', () => {
    const { container, getByText } = render(AiProgress, {
      props: {
        task: 'verdict',
        state: { status: 'loading', activity: ['Reading src/foo.ts…', 'Reading src/bar.ts…'] },
      },
    })
    expect(getByText('Forming a verdict…')).toBeInTheDocument()
    const log = container.querySelector('.ai-activity-log')
    expect(log).not.toBeNull()
    expect(log!.textContent).toContain('Reading src/foo.ts…')
    expect(log!.textContent).toContain('Reading src/bar.ts…')
    expect(container.querySelector('.skeleton-block')).not.toBeNull()
  })

  it('streaming with tokens started → streaming children only, NO status/skeleton', () => {
    const { container, queryByText } = render(AiProgress, {
      props: { task: 'summary', state: { status: 'streaming', streamStarted: true } },
    })
    // status line and skeleton are suppressed once tokens stream
    expect(queryByText('Summarizing the change…')).toBeNull()
    expect(container.querySelector('.skeleton-block')).toBeNull()
    expect(container.querySelector('.ai-progress-streaming')).not.toBeNull()
  })

  it('streaming but NO tokens yet → still shows the status line (honest pending)', () => {
    const { getByText, container } = render(AiProgress, {
      props: { task: 'summary', state: { status: 'streaming', streamStarted: false } },
    })
    expect(getByText('Summarizing the change…')).toBeInTheDocument()
    expect(container.querySelector('.ai-progress-streaming')).toBeNull()
  })

  it('skill task uses the reviewer name in the status line', () => {
    const { getByText } = render(AiProgress, {
      props: { task: 'skill', name: 'Security Reviewer', state: { status: 'loading' } },
    })
    expect(getByText('Running Security Reviewer…')).toBeInTheDocument()
  })

  it('marks the region aria-busy and the status line aria-live=polite', () => {
    const { container } = render(AiProgress, {
      props: { task: 'tests', state: { status: 'loading' } },
    })
    const region = container.querySelector('[aria-busy="true"]')
    expect(region).not.toBeNull()
    const live = container.querySelector('[aria-live="polite"]')
    expect(live).not.toBeNull()
  })

  it('honours skeletonVariant + skeletonLines', () => {
    const { container } = render(AiProgress, {
      props: { task: 'diagrams', state: { status: 'loading' }, skeletonVariant: 'block' },
    })
    expect(container.querySelector('.skeleton-rect')).not.toBeNull()
  })

  it('can suppress the skeleton (status + activity only surfaces)', () => {
    const { container, getByText } = render(AiProgress, {
      props: { task: 'mining', state: { status: 'loading' }, skeleton: false },
    })
    expect(getByText('Reading your past reviews…')).toBeInTheDocument()
    expect(container.querySelector('.skeleton-block')).toBeNull()
  })
})
