/**
 * Tests for mermaidInit shared helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInitialize = vi.fn()
const mockRender = vi.fn().mockResolvedValue({ svg: '<svg/>' })

vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}))

// Reset modules between tests so the singleton is reset
beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

describe('getMermaid', () => {
  it('initializes mermaid with securityLevel strict and startOnLoad false', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledOnce()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        startOnLoad: false,
      })
    )
  })

  it('initializes only once even when called multiple times', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    await getMermaid()
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledOnce()
  })

  it('includes themeVariables with fontSize 14px', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({ fontSize: '14px' }),
      })
    )
  })

  it('includes flowchart useMaxWidth true', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        flowchart: expect.objectContaining({ useMaxWidth: true }),
      })
    )
  })

  it('returns the mermaid default export', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    const m = await getMermaid()
    expect(m).toBeDefined()
    expect(typeof m.render).toBe('function')
  })

  it('uses dark mermaid theme when resolvedTheme returns dark', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'dark' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' })
    )
  })

  it('uses default mermaid theme when resolvedTheme returns light', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'default' })
    )
  })
})
