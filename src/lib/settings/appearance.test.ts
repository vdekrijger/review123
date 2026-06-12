import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setTheme, setUiFont, setDiffWidth } from './settings'

// Mock matchMedia — controlled per test
let _prefersDark = false
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? _prefersDark : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
})

// Reset module state and localStorage between tests
beforeEach(async () => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-font')
  document.documentElement.removeAttribute('data-diffwidth')
  _prefersDark = false
  vi.resetModules()
})

describe('applyAppearance', () => {
  it('sets data-theme=dark when theme is dark', async () => {
    setTheme('dark')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('sets data-theme=light when theme is light', async () => {
    setTheme('light')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('removes data-theme attribute when theme is auto', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    setTheme('auto')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('removes data-font attribute when uiFont is plex (default)', async () => {
    document.documentElement.setAttribute('data-font', 'serif') // pre-set
    setUiFont('plex')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.hasAttribute('data-font')).toBe(false)
  })

  it('sets data-font=serif when uiFont is serif', async () => {
    setUiFont('serif')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-font')).toBe('serif')
  })

  it('sets data-font=system when uiFont is system (overrides default Plex)', async () => {
    setUiFont('system')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-font')).toBe('system')
  })
})

describe('resolvedTheme', () => {
  it('returns dark when theme is explicitly dark', async () => {
    setTheme('dark')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('dark')
  })

  it('returns light when theme is explicitly light', async () => {
    setTheme('light')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('light')
  })

  it('returns dark for auto when matchMedia prefers-dark is true', async () => {
    _prefersDark = true
    setTheme('auto')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('dark')
  })

  it('returns light for auto when matchMedia prefers-dark is false', async () => {
    _prefersDark = false
    setTheme('auto')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('light')
  })
})

// ---------------------------------------------------------------------------
// applyAppearance — data-diffwidth attribute (fix: attribute-driven diff width)
// ---------------------------------------------------------------------------

describe('applyAppearance — data-diffwidth', () => {
  it('sets data-diffwidth=full when diffWidth is full', async () => {
    setDiffWidth('full')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-diffwidth')).toBe('full')
  })

  it('sets data-diffwidth=centered when diffWidth is centered', async () => {
    setDiffWidth('centered')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-diffwidth')).toBe('centered')
  })

  it('removes stale data-diffwidth=full when reset to centered', async () => {
    setDiffWidth('full')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-diffwidth')).toBe('full')
    setDiffWidth('centered')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-diffwidth')).toBe('centered')
  })
})
