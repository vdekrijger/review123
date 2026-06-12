import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import ProviderIcon from './ProviderIcon.svelte'

const ALL = ['github', 'gitlab', 'bitbucket'] as const

describe('ProviderIcon', () => {
  it.each(ALL)('renders an inline svg with a non-empty path for %s', (provider) => {
    const { container } = render(ProviderIcon, { provider })
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    const path = svg!.querySelector('path')
    expect(path).not.toBeNull()
    expect(path!.getAttribute('d')!.length).toBeGreaterThan(20)
  })

  it('renders a distinct mark per provider', () => {
    const ds = ALL.map((provider) => {
      const { container } = render(ProviderIcon, { provider })
      return container.querySelector('svg path')!.getAttribute('d')
    })
    expect(new Set(ds).size).toBe(3)
  })

  it('marks the svg as decorative (aria-hidden, not focusable)', () => {
    const { container } = render(ProviderIcon, { provider: 'github' })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
  })

  it.each(ALL)('defaults to currentColor fill for %s (monochrome theming)', (provider) => {
    const { container } = render(ProviderIcon, { provider })
    expect(container.querySelector('svg')!.getAttribute('fill')).toBe('currentColor')
  })

  it('brand variant uses the official GitLab orange and Bitbucket blue', () => {
    const gl = render(ProviderIcon, { provider: 'gitlab', brand: true })
    expect(gl.container.querySelector('svg')!.getAttribute('fill')).toBe('#FC6D26')
    const bb = render(ProviderIcon, { provider: 'bitbucket', brand: true })
    expect(bb.container.querySelector('svg')!.getAttribute('fill')).toBe('#0052CC')
    // GitHub's mark has no brand color distinct from text — stays currentColor
    const gh = render(ProviderIcon, { provider: 'github', brand: true })
    expect(gh.container.querySelector('svg')!.getAttribute('fill')).toBe('currentColor')
  })

  it('applies the size prop to width and height (default 14)', () => {
    const def = render(ProviderIcon, { provider: 'github' })
    const defSvg = def.container.querySelector('svg')!
    expect(defSvg.getAttribute('width')).toBe('14')
    expect(defSvg.getAttribute('height')).toBe('14')

    const sized = render(ProviderIcon, { provider: 'gitlab', size: 20 })
    const sizedSvg = sized.container.querySelector('svg')!
    expect(sizedSvg.getAttribute('width')).toBe('20')
    expect(sizedSvg.getAttribute('height')).toBe('20')
  })

  it('renders a visually-hidden text alternative when label is given', () => {
    const { container } = render(ProviderIcon, { provider: 'github', label: 'GitHub' })
    const sr = container.querySelector('.sr-only')
    expect(sr).not.toBeNull()
    expect(sr!.textContent).toBe('GitHub')
  })

  it('renders no text alternative when label is omitted', () => {
    const { container } = render(ProviderIcon, { provider: 'github' })
    expect(container.querySelector('.sr-only')).toBeNull()
    expect(container.textContent?.trim()).toBe('')
  })

  it('exposes the provider id as a data attribute for styling/tests', () => {
    const { container } = render(ProviderIcon, { provider: 'bitbucket' })
    expect(container.querySelector('[data-provider="bitbucket"]')).not.toBeNull()
  })
})
