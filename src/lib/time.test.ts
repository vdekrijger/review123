import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { relativeTime } from './time'

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for times less than 60s ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-06-01T11:59:30Z')).toBe('just now')
  })

  it('returns Xm ago for times 1-59 minutes ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-06-01T11:45:00Z')).toBe('15m ago')
  })

  it('returns Xh ago for times 1-23 hours ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-06-01T09:00:00Z')).toBe('3h ago')
  })

  it('returns Xd ago for times 1+ days ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-05-29T12:00:00Z')).toBe('3d ago')
  })

  it('handles very old dates (years) as days', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
    expect(relativeTime('2024-06-01T00:00:00Z')).toBe('730d ago')
  })
})
