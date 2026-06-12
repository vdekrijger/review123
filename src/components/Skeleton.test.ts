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
