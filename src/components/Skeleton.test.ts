import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import Skeleton from './Skeleton.svelte'

describe('Skeleton', () => {
  it('renders with aria-hidden=true', () => {
    const { container } = render(Skeleton, { props: { lines: 3 } })
    const root = container.querySelector('.skeleton-block')
    expect(root).toBeTruthy()
    expect(root!.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders correct number of lines (default 3)', () => {
    const { container } = render(Skeleton, { props: {} })
    const lines = container.querySelectorAll('.skeleton-line')
    expect(lines).toHaveLength(3)
  })

  it('renders correct number of lines when overridden', () => {
    const { container } = render(Skeleton, { props: { lines: 5 } })
    const lines = container.querySelectorAll('.skeleton-line')
    expect(lines).toHaveLength(5)
  })

  it('renders header block when header=true', () => {
    const { container } = render(Skeleton, { props: { header: true } })
    expect(container.querySelector('.skeleton-header')).toBeTruthy()
  })

  it('does NOT render header block when header=false (default)', () => {
    const { container } = render(Skeleton, { props: {} })
    expect(container.querySelector('.skeleton-header')).toBeNull()
  })
})

describe('Skeleton — content-shaped variants', () => {
  it('text variant (default) renders lines of varying width', () => {
    const { container } = render(Skeleton, { props: { lines: 4 } })
    const lines = [...container.querySelectorAll<HTMLElement>('.skeleton-line')]
    expect(lines).toHaveLength(4)
    const widths = new Set(lines.map((l) => l.style.width))
    expect(widths.size).toBeGreaterThan(1)
  })

  it('block variant renders ONE rectangular block and no text lines', () => {
    const { container } = render(Skeleton, { props: { variant: 'block' } })
    expect(container.querySelectorAll('.skeleton-rect')).toHaveLength(1)
    expect(container.querySelector('.skeleton-line')).toBeNull()
  })

  it('cards variant renders TWO card-shaped blocks', () => {
    const { container } = render(Skeleton, { props: { variant: 'cards' } })
    expect(container.querySelectorAll('.skeleton-card')).toHaveLength(2)
    expect(container.querySelector('.skeleton-rect')).toBeNull()
  })
})
