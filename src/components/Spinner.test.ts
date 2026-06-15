import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import Spinner from './Spinner.svelte'

describe('Spinner — the one shared inline spinner token', () => {
  it('renders a single .ui-spinner element', () => {
    const { container } = render(Spinner)
    expect(container.querySelectorAll('.ui-spinner')).toHaveLength(1)
  })

  it('is aria-hidden (decorative — the surrounding control owns aria-busy)', () => {
    const { container } = render(Spinner)
    expect(container.querySelector('.ui-spinner')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('honours a custom size via the CSS var', () => {
    const { container } = render(Spinner, { props: { size: '1.2em' } })
    const el = container.querySelector('.ui-spinner') as HTMLElement
    expect(el.style.getPropertyValue('--ui-spinner-size')).toBe('1.2em')
  })
})
