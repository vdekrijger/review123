import { describe, it, expect } from 'vitest'
import { BUILD_SHA, BUILD_TIME, commitUrl } from './buildInfo'

describe('buildInfo', () => {
  it('exposes a non-empty string SHA', () => {
    expect(typeof BUILD_SHA).toBe('string')
    expect(BUILD_SHA.length).toBeGreaterThan(0)
  })

  it('exposes a string build time', () => {
    expect(typeof BUILD_TIME).toBe('string')
    expect(BUILD_TIME.length).toBeGreaterThan(0)
  })

  it("falls back to 'test' under vitest where the vite define is absent", () => {
    // The vitest config injects no __BUILD_*__ defines, so buildInfo's
    // typeof-guard fallback is exercised here.
    expect(BUILD_SHA).toBe('test')
    expect(BUILD_TIME).toBe('test')
  })

  it('builds a GitHub commit URL for a real sha', () => {
    expect(commitUrl('8573932')).toBe(
      'https://github.com/vdekrijger/review123/commit/8573932',
    )
  })

  it('returns null commit URL for sentinel shas', () => {
    expect(commitUrl('dev')).toBeNull()
    expect(commitUrl('test')).toBeNull()
  })
})
