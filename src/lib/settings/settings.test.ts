import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setGithubPat, setDeepseekKey, setDiffMode } from './settings'

describe('settings', () => {
  beforeEach(() => localStorage.clear())

  it('returns defaults when nothing stored', () => {
    expect(getSettings()).toEqual({ githubPat: null, deepseekKey: null, diffMode: 'unified' })
  })

  it('stores and retrieves a PAT', () => {
    setGithubPat('ghp_abc123')
    expect(getSettings().githubPat).toBe('ghp_abc123')
  })

  it('rejects empty PAT (EC-04a)', () => {
    expect(() => setGithubPat('')).toThrow('empty')
    expect(() => setGithubPat('   ')).toThrow('empty')
    expect(getSettings().githubPat).toBeNull()
  })

  it('trims whitespace-padded PAT (EC-04b)', () => {
    setGithubPat('  ghp_x  ')
    expect(getSettings().githubPat).toBe('ghp_x')
  })

  it('clears a PAT via null', () => {
    setGithubPat('ghp_x')
    setGithubPat(null)
    expect(getSettings().githubPat).toBeNull()
  })

  it('persists diff mode preference', () => {
    setDiffMode('split')
    expect(getSettings().diffMode).toBe('split')
  })

  it('survives corrupt stored JSON', () => {
    localStorage.setItem('review123:settings', '{not json')
    expect(getSettings()).toEqual({ githubPat: null, deepseekKey: null, diffMode: 'unified' })
  })
})
