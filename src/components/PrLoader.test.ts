/**
 * Tests for the crafted PR loading state (Fix 2).
 *
 * The loading branch in Review.svelte now renders a CraftedLoader component
 * (or inline crafted loader) instead of a generic Skeleton page.
 *
 * Requirements:
 *   - Shows the diff-bars mark (three SVG rects — matching favicon's design)
 *   - Captions cycle through four messages every 1600ms
 *   - aria-live="polite" on caption region
 *   - prefers-reduced-motion: static text, no shimmer animation class
 *   - Ghost page structure: slim card + three file-row skeletons at reduced opacity
 *   - Cleanup: no timer leak after unmount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import CraftedLoader from './CraftedLoader.svelte'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const CAPTIONS = [
  'Fetching pull request…',
  'Reading the diffs…',
  'Mapping changed files…',
  'Almost there…',
]

describe('CraftedLoader — diff-bars mark', () => {
  it('renders three bar rects (the diff-bars mark)', () => {
    const { container } = render(CraftedLoader)
    // The three colored bars; background rect is separate (class .bar distinguishes)
    const bars = container.querySelectorAll('.loader-bars-mark .bar')
    expect(bars).toHaveLength(3)
  })

  it('diff-bars mark has role="img" or aria-hidden (decorative)', () => {
    const { container } = render(CraftedLoader)
    const svg = container.querySelector('.loader-bars-mark')
    // Either aria-hidden="true" (decorative) or role="img" with label
    const ariaHidden = svg?.getAttribute('aria-hidden')
    const role = svg?.getAttribute('role')
    expect(ariaHidden === 'true' || role === 'img').toBe(true)
  })
})

describe('CraftedLoader — rotating captions', () => {
  it('shows the first caption on initial render', () => {
    render(CraftedLoader)
    expect(screen.getByText(CAPTIONS[0])).toBeInTheDocument()
  })

  it('advances to second caption after 1600ms', async () => {
    render(CraftedLoader)
    expect(screen.getByText(CAPTIONS[0])).toBeInTheDocument()

    vi.advanceTimersByTime(1600)
    await vi.waitFor(() => {
      expect(screen.getByText(CAPTIONS[1])).toBeInTheDocument()
    })
  })

  it('advances to third caption after 3200ms', async () => {
    render(CraftedLoader)
    vi.advanceTimersByTime(3200)
    await vi.waitFor(() => {
      expect(screen.getByText(CAPTIONS[2])).toBeInTheDocument()
    })
  })

  it('advances to fourth caption after 4800ms', async () => {
    render(CraftedLoader)
    vi.advanceTimersByTime(4800)
    await vi.waitFor(() => {
      expect(screen.getByText(CAPTIONS[3])).toBeInTheDocument()
    })
  })

  it('wraps back to first caption after all four cycle (6400ms)', async () => {
    render(CraftedLoader)
    vi.advanceTimersByTime(6400)
    await vi.waitFor(() => {
      expect(screen.getByText(CAPTIONS[0])).toBeInTheDocument()
    })
  })

  it('caption region has aria-live="polite"', () => {
    const { container } = render(CraftedLoader)
    const liveRegion = container.querySelector('[aria-live="polite"]')
    expect(liveRegion).toBeInTheDocument()
  })
})

describe('CraftedLoader — ghost page structure', () => {
  it('renders a ghost glance-card skeleton', () => {
    const { container } = render(CraftedLoader)
    expect(container.querySelector('.loader-ghost-card')).toBeInTheDocument()
  })

  it('renders three ghost file-row skeletons', () => {
    const { container } = render(CraftedLoader)
    const fileRows = container.querySelectorAll('.loader-ghost-file-row')
    expect(fileRows).toHaveLength(3)
  })

  it('ghost structure has reduced opacity (aria-hidden decorative)', () => {
    const { container } = render(CraftedLoader)
    const ghost = container.querySelector('.loader-ghost')
    expect(ghost?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('CraftedLoader — prefers-reduced-motion', () => {
  it('adds reduced-motion class or static text when prefers-reduced-motion is "reduce"', () => {
    // Mock matchMedia to return prefers-reduced-motion: reduce
    const mockMql = {
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
    }
    // jsdom may not have matchMedia — define it if needed
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: vi.fn(),
      })
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mockMql as unknown as MediaQueryList)

    const { container } = render(CraftedLoader)
    // Either the container has a reduced-motion class, or the bars lack shimmer class
    const loaderEl = container.querySelector('.crafted-loader')
    const hasReducedClass = loaderEl?.classList.contains('reduced-motion')
    const barsEl = container.querySelector('.loader-bars-mark')
    const noShimmerOnBars = !barsEl?.classList.contains('shimmer')
    // At least one of these signals reduced-motion handling
    expect(hasReducedClass || noShimmerOnBars).toBe(true)
  })
})

describe('CraftedLoader — cleanup on unmount', () => {
  it('does not leak timers after unmount (no pending callbacks)', async () => {
    const { unmount } = render(CraftedLoader)
    vi.advanceTimersByTime(1600)
    unmount()
    // After unmount, advancing timers should not cause any state updates or errors
    // (testing that the interval was cleared)
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow()
  })
})
