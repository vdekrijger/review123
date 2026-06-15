import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setCrossModelVerify } from './settings'

const KEY = 'review123:settings'

describe('settings.crossModelVerify (Plan M)', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to true', () => {
    expect(getSettings().crossModelVerify).toBe(true)
  })

  it('persists via setCrossModelVerify', () => {
    setCrossModelVerify(false)
    expect(getSettings().crossModelVerify).toBe(false)
    setCrossModelVerify(true)
    expect(getSettings().crossModelVerify).toBe(true)
  })

  it('coerces a non-boolean stored value back to the default (true)', () => {
    localStorage.setItem(KEY, JSON.stringify({ crossModelVerify: 'yes' }))
    expect(getSettings().crossModelVerify).toBe(true)
  })

  it('respects an explicitly stored false', () => {
    localStorage.setItem(KEY, JSON.stringify({ crossModelVerify: false }))
    expect(getSettings().crossModelVerify).toBe(false)
  })
})
