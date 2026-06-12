/**
 * ReviewProgress component tests
 *
 * The component renders a scroll-based progress bar for step 2 (Inspect) only.
 * - Accepts a `percent` prop (0–100) computed by the parent from scroll position.
 * - Shows ONLY on step 2; hidden on steps 1 and 3.
 * - Inline variant label: "{percent}% · {viewedCount}/{fileCount} viewed"
 * - role="progressbar" with aria-valuenow, aria-valuemax=100, aria-label
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import ReviewProgress from './ReviewProgress.svelte'

// ---------------------------------------------------------------------------
// percent prop — aria-valuenow reflects prop
// ---------------------------------------------------------------------------

describe('ReviewProgress — percent prop (scroll-based API)', () => {
  it('aria-valuenow equals the percent prop passed in', () => {
    render(ReviewProgress, { props: { percent: 42, viewedCount: 1, fileCount: 3, step: 2, inline: true } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
  })

  it('aria-valuenow is 0 when percent=0', () => {
    render(ReviewProgress, { props: { percent: 0, viewedCount: 0, fileCount: 3, step: 2, inline: true } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('0')
  })

  it('aria-valuenow is 100 when percent=100', () => {
    render(ReviewProgress, { props: { percent: 100, viewedCount: 3, fileCount: 3, step: 2, inline: true } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('100')
  })
})

// ---------------------------------------------------------------------------
// Step gating — only visible on step 2
// ---------------------------------------------------------------------------

describe('ReviewProgress — step gating (only shown on step 2)', () => {
  it('renders progressbar on step 2', () => {
    render(ReviewProgress, { props: { percent: 30, viewedCount: 1, fileCount: 3, step: 2, inline: true } })
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('does NOT render progressbar on step 1 regardless of percent', () => {
    render(ReviewProgress, { props: { percent: 50, viewedCount: 1, fileCount: 3, step: 1, inline: true } })
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('does NOT render progressbar on step 3 regardless of percent', () => {
    render(ReviewProgress, { props: { percent: 100, viewedCount: 3, fileCount: 3, step: 3, inline: true } })
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ARIA attributes
// ---------------------------------------------------------------------------

describe('ReviewProgress — aria attributes', () => {
  it('has role=progressbar on step 2', () => {
    render(ReviewProgress, { props: { percent: 0, viewedCount: 0, fileCount: 2, step: 2 } })
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('has aria-valuemax=100', () => {
    render(ReviewProgress, { props: { percent: 0, viewedCount: 0, fileCount: 2, step: 2 } })
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('100')
  })

  it('aria-label contains "Review progress"', () => {
    render(ReviewProgress, { props: { percent: 25, viewedCount: 1, fileCount: 2, step: 2 } })
    const label = screen.getByRole('progressbar').getAttribute('aria-label') ?? ''
    expect(label.toLowerCase()).toContain('review progress')
  })

  it('aria-label includes the percentage', () => {
    render(ReviewProgress, { props: { percent: 25, viewedCount: 1, fileCount: 2, step: 2 } })
    const label = screen.getByRole('progressbar').getAttribute('aria-label') ?? ''
    expect(label).toContain('25%')
  })
})

// ---------------------------------------------------------------------------
// Label format ({percent}% · {viewedCount}/{fileCount} viewed)
// ---------------------------------------------------------------------------

describe('ReviewProgress — label format ({percent}% · {viewedCount}/{fileCount} viewed)', () => {
  it('label contains percent and viewedCount/fileCount viewed', () => {
    const { container } = render(ReviewProgress, {
      props: { percent: 55, viewedCount: 2, fileCount: 4, step: 2, inline: true },
    })
    expect(container.textContent).toContain('55%')
    expect(container.textContent).toContain('2/4 viewed')
  })

  it('label shows 0% and 0/0 viewed when no files', () => {
    const { container } = render(ReviewProgress, {
      props: { percent: 0, viewedCount: 0, fileCount: 0, step: 2, inline: true },
    })
    expect(container.textContent).toContain('0%')
    expect(container.textContent).toContain('0/0 viewed')
  })

  it('standalone label shows percent and viewed counts', () => {
    const { container } = render(ReviewProgress, {
      props: { percent: 75, viewedCount: 3, fileCount: 4, step: 2 },
    })
    expect(container.textContent).toContain('75%')
    expect(container.textContent).toContain('3/4 viewed')
  })
})

// ---------------------------------------------------------------------------
// Inline (footer) variant
// ---------------------------------------------------------------------------

describe('ReviewProgress — inline variant', () => {
  it('inline=true renders role=progressbar with correct aria-valuenow', () => {
    render(ReviewProgress, { props: { percent: 40, viewedCount: 0, fileCount: 5, step: 2, inline: true } })
    const bar = screen.getByRole('progressbar')
    expect(bar).toBeInTheDocument()
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
  })

  it('inline=true renders the percent label text', () => {
    const { container } = render(ReviewProgress, { props: { percent: 85, viewedCount: 5, fileCount: 5, step: 2, inline: true } })
    expect(container.textContent).toContain('85%')
  })

  it('inline=true renders a progress track element', () => {
    const { container } = render(ReviewProgress, { props: { percent: 0, viewedCount: 0, fileCount: 2, step: 2, inline: true } })
    const track = container.querySelector('.progress-track-inline')
    expect(track).not.toBeNull()
  })

  it('inline=true does NOT render the standalone full-width .review-progress wrapper', () => {
    const { container } = render(ReviewProgress, { props: { percent: 0, viewedCount: 0, fileCount: 2, step: 2, inline: true } })
    expect(container.querySelector('.review-progress')).toBeNull()
  })

  it('inline=false (default) renders .review-progress (standalone) on step 2', () => {
    const { container } = render(ReviewProgress, { props: { percent: 0, viewedCount: 0, fileCount: 2, step: 2 } })
    expect(container.querySelector('.review-progress')).not.toBeNull()
  })
})
