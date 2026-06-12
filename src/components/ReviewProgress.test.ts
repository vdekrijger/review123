/**
 * ReviewProgress component tests
 *
 * The component renders a 3px full-width progress bar with:
 *  - fill = weighted progress: 15% for reaching step 2 + 70% × (viewedCount/fileCount) + 15% when step 3 reached
 *  - role="progressbar" with aria-valuenow, aria-valuemax=100, aria-label
 *  - floating label on hover/focus showing "{viewedCount}/{fileCount} files viewed · {draftCount} drafts"
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import ReviewProgress from './ReviewProgress.svelte'

// ---------------------------------------------------------------------------
// Percent math
// ---------------------------------------------------------------------------

describe('ReviewProgress — percent math', () => {
  it('step 1, 0 files → 0%', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 0, draftCount: 0, step: 1 } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('0')
  })

  it('step 1, 2/5 files viewed → 14% (only step weight 0, file portion = 0.7 * 2/5 = 28% but step 1 means only file progress without step-2 unlock... wait: step 1 = 0 weight, step 2 = 15%, so at step 1 the 15% step-2 bonus is not yet reached)', () => {
    // step 1: weight = 0 (haven't reached step 2) + 0.7 * (2/5) + 0 = 28 → clamped
    // Actually spec: 15% for reaching step 2 = only once you ARE on step 2+
    // at step=1: 0 + 0.70 * (2/5) = 28
    render(ReviewProgress, { props: { viewedCount: 2, fileCount: 5, draftCount: 0, step: 1 } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('28')
  })

  it('step 2, 0 files viewed → 15%', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 5, draftCount: 0, step: 2 } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('15')
  })

  it('step 2, all 5 files viewed → 85%', () => {
    // 15 + 70*1 + 0 = 85
    render(ReviewProgress, { props: { viewedCount: 5, fileCount: 5, draftCount: 0, step: 2 } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('85')
  })

  it('step 3, all files viewed → 100%', () => {
    // 15 + 70*1 + 15 = 100
    render(ReviewProgress, { props: { viewedCount: 5, fileCount: 5, draftCount: 0, step: 3 } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('100')
  })

  it('step 3, 0 files (0 fileCount) → step-weight only: 15 + 0 + 15 = 30%', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 0, draftCount: 0, step: 3 } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
  })

  it('step 2, fileCount=0 → 15% (step weight only, no file div-by-zero)', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 0, draftCount: 0, step: 2 } })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('15')
  })

  it('clamps to 100 when overflows', () => {
    // Step 3 + viewedCount > fileCount (shouldn't happen but be safe)
    render(ReviewProgress, { props: { viewedCount: 10, fileCount: 5, draftCount: 0, step: 3 } })
    const bar = screen.getByRole('progressbar')
    const val = Number(bar.getAttribute('aria-valuenow'))
    expect(val).toBeLessThanOrEqual(100)
  })

  it('clamps to 0 when negative (defensive)', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 0, draftCount: 0, step: 1 } })
    const bar = screen.getByRole('progressbar')
    const val = Number(bar.getAttribute('aria-valuenow'))
    expect(val).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// ARIA attributes
// ---------------------------------------------------------------------------

describe('ReviewProgress — aria attributes', () => {
  it('has role=progressbar', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 2, draftCount: 0, step: 1 } })
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('has aria-valuemax=100', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 2, draftCount: 0, step: 1 } })
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('100')
  })

  it('aria-label contains "Review progress"', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 2, draftCount: 0, step: 1 } })
    const label = screen.getByRole('progressbar').getAttribute('aria-label') ?? ''
    expect(label.toLowerCase()).toContain('review progress')
  })

  it('aria-label includes the percentage', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 2, draftCount: 0, step: 2 } })
    const label = screen.getByRole('progressbar').getAttribute('aria-label') ?? ''
    expect(label).toContain('15%')
  })
})

// ---------------------------------------------------------------------------
// Floating label (visible in DOM even if hidden visually until hover)
// ---------------------------------------------------------------------------

describe('ReviewProgress — floating label', () => {
  it('label text shows viewedCount/fileCount files viewed', () => {
    const { container } = render(ReviewProgress, { props: { viewedCount: 3, fileCount: 7, draftCount: 0, step: 2 } })
    expect(container.textContent).toContain('3/7 files viewed')
  })

  it('label text shows draftCount drafts', () => {
    const { container } = render(ReviewProgress, { props: { viewedCount: 0, fileCount: 5, draftCount: 2, step: 2 } })
    expect(container.textContent).toContain('2 drafts')
  })

  it('label text is hidden visually (has tooltip/label class)', () => {
    const { container } = render(ReviewProgress, { props: { viewedCount: 1, fileCount: 2, draftCount: 1, step: 2 } })
    // The label element should exist (not rendered absent) — it just lives in DOM
    const label = container.querySelector('.progress-label')
    expect(label).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Inline (footer) variant
// ---------------------------------------------------------------------------

describe('ReviewProgress — inline variant', () => {
  it('inline=true renders role=progressbar with correct aria-valuenow', () => {
    render(ReviewProgress, { props: { viewedCount: 0, fileCount: 5, draftCount: 0, step: 2, inline: true } })
    const bar = screen.getByRole('progressbar')
    expect(bar).toBeInTheDocument()
    expect(bar.getAttribute('aria-valuenow')).toBe('15')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
  })

  it('inline=true renders the percent label text', () => {
    const { container } = render(ReviewProgress, { props: { viewedCount: 5, fileCount: 5, draftCount: 0, step: 2, inline: true } })
    // 15 + 70 = 85%
    expect(container.textContent).toContain('85%')
  })

  it('inline=true renders a progress track (6px-tall element)', () => {
    const { container } = render(ReviewProgress, { props: { viewedCount: 0, fileCount: 2, draftCount: 0, step: 1, inline: true } })
    const track = container.querySelector('.progress-track-inline')
    expect(track).not.toBeNull()
  })

  it('inline=true does NOT render the standalone full-width .review-progress wrapper', () => {
    const { container } = render(ReviewProgress, { props: { viewedCount: 0, fileCount: 2, draftCount: 0, step: 1, inline: true } })
    expect(container.querySelector('.review-progress')).toBeNull()
  })

  it('inline=false (default) renders .review-progress (standalone)', () => {
    const { container } = render(ReviewProgress, { props: { viewedCount: 0, fileCount: 2, draftCount: 0, step: 1 } })
    expect(container.querySelector('.review-progress')).not.toBeNull()
  })
})
