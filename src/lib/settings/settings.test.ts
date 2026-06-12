import { describe, it, expect, beforeEach } from 'vitest'
import {
  getSettings, setGithubPat, setDeepseekKey, setDiffMode, saveTokens, saveGithubAuth,
  setTheme, setUiFont, setShowProgress, setTreeOpen,
} from './settings'

describe('settings', () => {
  beforeEach(() => localStorage.clear())

  it('returns defaults when nothing stored', () => {
    expect(getSettings()).toEqual({
      githubPat: null,
      deepseekKey: null,
      diffMode: 'unified',
      githubAuth: null,
      railCollapsed: false,
      theme: 'auto',
      uiFont: 'plex',
      showProgress: true,
      treeOpen: false,
    })
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
    expect(getSettings()).toEqual({
      githubPat: null,
      deepseekKey: null,
      diffMode: 'unified',
      githubAuth: null,
      railCollapsed: false,
      theme: 'auto',
      uiFont: 'plex',
      showProgress: true,
      treeOpen: false,
    })
  })

  it('coerces invalid field types back to defaults (shape validation)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffMode: 'wat', githubPat: 42 }))
    const s = getSettings()
    expect(s.diffMode).toBe('unified')
    expect(s.githubPat).toBeNull()
  })

  it('saveTokens with valid githubPat and null deepseekKey stores both atomically', () => {
    saveTokens({ githubPat: 'ghp_abc', deepseekKey: null })
    const s = getSettings()
    expect(s.githubPat).toBe('ghp_abc')
    expect(s.deepseekKey).toBeNull()
  })

  it('saveTokens throws and leaves storage completely unchanged when deepseekKey is whitespace', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ githubPat: 'ghp_original', deepseekKey: 'sk_original' }))
    expect(() => saveTokens({ githubPat: 'x', deepseekKey: '  ' })).toThrow()
    const s = getSettings()
    expect(s.githubPat).toBe('ghp_original')
    expect(s.deepseekKey).toBe('sk_original')
  })

  it('migration: legacy JSON with only githubPat coerces to githubAuth {token, method, scopes}', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ githubPat: 'ghp_x' }))
    const s = getSettings()
    expect(s.githubAuth).toEqual({ token: 'ghp_x', method: 'pat', scopes: [] })
    // githubPat field still accessible for backward compat
    expect(s.githubPat).toBe('ghp_x')
  })

  it('migration: githubAuth takes precedence over legacy githubPat when both stored', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      githubPat: 'ghp_old',
      githubAuth: { token: 'gho_new', method: 'oauth', scopes: ['public_repo'] },
    }))
    const s = getSettings()
    expect(s.githubAuth).toEqual({ token: 'gho_new', method: 'oauth', scopes: ['public_repo'] })
  })

  it('setGithubPat writes githubAuth in PAT shape', () => {
    setGithubPat('ghp_test')
    const s = getSettings()
    expect(s.githubAuth).toEqual({ token: 'ghp_test', method: 'pat', scopes: [] })
  })

  it('setGithubPat(null) clears githubAuth', () => {
    setGithubPat('ghp_test')
    setGithubPat(null)
    expect(getSettings().githubAuth).toBeNull()
  })

  it('saveGithubAuth(oauth) clears stale githubPat so no plaintext PAT lingers at rest', () => {
    setGithubPat('ghp_old')
    expect(getSettings().githubPat).toBe('ghp_old')
    saveGithubAuth({ token: 'gho_new', method: 'oauth', scopes: ['public_repo'] })
    const s = getSettings()
    expect(s.githubPat).toBeNull()
    expect(s.githubAuth).toEqual({ token: 'gho_new', method: 'oauth', scopes: ['public_repo'] })
  })

  describe('theme', () => {
    it('defaults to auto', () => {
      expect(getSettings().theme).toBe('auto')
    })

    it('setTheme persists dark', () => {
      setTheme('dark')
      expect(getSettings().theme).toBe('dark')
    })

    it('setTheme persists light', () => {
      setTheme('light')
      expect(getSettings().theme).toBe('light')
    })

    it('setTheme persists auto', () => {
      setTheme('dark')
      setTheme('auto')
      expect(getSettings().theme).toBe('auto')
    })

    it('coerces invalid theme value back to default (auto)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ theme: 'sepia' }))
      expect(getSettings().theme).toBe('auto')
    })
  })

  describe('uiFont', () => {
    it('defaults to plex', () => {
      expect(getSettings().uiFont).toBe('plex')
    })

    it('setUiFont persists system', () => {
      setUiFont('system')
      expect(getSettings().uiFont).toBe('system')
    })

    it('setUiFont persists serif', () => {
      setUiFont('serif')
      expect(getSettings().uiFont).toBe('serif')
    })

    it('setUiFont persists plex', () => {
      setUiFont('serif')
      setUiFont('plex')
      expect(getSettings().uiFont).toBe('plex')
    })

    it('coerces invalid uiFont value back to default (plex)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ uiFont: 'comic-sans' }))
      expect(getSettings().uiFont).toBe('plex')
    })

    it('coerces legacy "humanist" value to "system"', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ uiFont: 'humanist' }))
      expect(getSettings().uiFont).toBe('system')
    })
  })

  describe('showProgress', () => {
    it('defaults to true', () => {
      expect(getSettings().showProgress).toBe(true)
    })

    it('setShowProgress persists false', () => {
      setShowProgress(false)
      expect(getSettings().showProgress).toBe(false)
    })

    it('setShowProgress persists true', () => {
      setShowProgress(false)
      setShowProgress(true)
      expect(getSettings().showProgress).toBe(true)
    })

    it('coerces invalid showProgress value back to default (true)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ showProgress: 'yes' }))
      expect(getSettings().showProgress).toBe(true)
    })
  })

  describe('treeOpen', () => {
    it('defaults to false (diff-first)', () => {
      expect(getSettings().treeOpen).toBe(false)
    })

    it('setTreeOpen persists true', () => {
      setTreeOpen(true)
      expect(getSettings().treeOpen).toBe(true)
    })

    it('setTreeOpen persists false', () => {
      setTreeOpen(true)
      setTreeOpen(false)
      expect(getSettings().treeOpen).toBe(false)
    })

    it('coerces invalid treeOpen value back to default (false)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ treeOpen: 'yes' }))
      expect(getSettings().treeOpen).toBe(false)
    })

    it('returns defaults includes treeOpen false', () => {
      const s = getSettings()
      expect(s).toHaveProperty('treeOpen', false)
    })
  })
})
