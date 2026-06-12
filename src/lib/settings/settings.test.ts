import { describe, it, expect, beforeEach } from 'vitest'
import {
  getSettings, setGithubPat, setDeepseekKey, setDiffMode, saveTokens, saveGithubAuth,
  setTheme, setUiFont, setShowProgress, setTreeOpen, setTestFileDisplay, setGitlabToken,
  saveBitbucketAuth, setGitlabHost,
  setOpenaiKey, setAnthropicKey, setGeminiKey, setAiProvider, setAiModel,
} from './settings'

describe('settings', () => {
  beforeEach(() => localStorage.clear())

  it('returns defaults when nothing stored', () => {
    expect(getSettings()).toEqual({
      githubPat: null,
      deepseekKey: null,
      aiProvider: 'deepseek',
      aiModel: '',
      openaiKey: null,
      anthropicKey: null,
      geminiKey: null,
      diffMode: 'unified',
      githubAuth: null,
      gitlabToken: null,
      gitlabHost: 'gitlab.com',
      gitlabOAuth: null,
      bitbucketAuth: null,
      railCollapsed: false,
      theme: 'auto',
      uiFont: 'plex',
      showProgress: true,
      treeOpen: false,
      testFileDisplay: 'normal',
      diffWidth: 'centered',
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
      aiProvider: 'deepseek',
      aiModel: '',
      openaiKey: null,
      anthropicKey: null,
      geminiKey: null,
      diffMode: 'unified',
      githubAuth: null,
      gitlabToken: null,
      gitlabHost: 'gitlab.com',
      gitlabOAuth: null,
      bitbucketAuth: null,
      railCollapsed: false,
      theme: 'auto',
      uiFont: 'plex',
      showProgress: true,
      treeOpen: false,
      testFileDisplay: 'normal',
      diffWidth: 'centered',
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

  describe('testFileDisplay', () => {
    it('defaults to normal', () => {
      expect(getSettings().testFileDisplay).toBe('normal')
    })

    it('setTestFileDisplay persists highlight', () => {
      setTestFileDisplay('highlight')
      expect(getSettings().testFileDisplay).toBe('highlight')
    })

    it('setTestFileDisplay persists dim', () => {
      setTestFileDisplay('dim')
      expect(getSettings().testFileDisplay).toBe('dim')
    })

    it('setTestFileDisplay persists normal', () => {
      setTestFileDisplay('highlight')
      setTestFileDisplay('normal')
      expect(getSettings().testFileDisplay).toBe('normal')
    })

    it('coerces invalid testFileDisplay back to normal', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ testFileDisplay: 'glow' }))
      expect(getSettings().testFileDisplay).toBe('normal')
    })
  })

  describe('gitlabToken', () => {
    it('defaults to null', () => {
      expect(getSettings().gitlabToken).toBeNull()
    })

    it('setGitlabToken stores a trimmed token', () => {
      setGitlabToken('  glpat_abc123  ')
      expect(getSettings().gitlabToken).toBe('glpat_abc123')
    })

    it('setGitlabToken(null) clears the token', () => {
      setGitlabToken('glpat_abc123')
      setGitlabToken(null)
      expect(getSettings().gitlabToken).toBeNull()
    })

    it('setGitlabToken rejects empty string', () => {
      expect(() => setGitlabToken('')).toThrow('empty')
    })

    it('setGitlabToken rejects whitespace-only string', () => {
      expect(() => setGitlabToken('   ')).toThrow('empty')
    })

    it('persists gitlabToken across getSettings() calls', () => {
      setGitlabToken('glpat_persisted')
      expect(getSettings().gitlabToken).toBe('glpat_persisted')
      expect(getSettings().gitlabToken).toBe('glpat_persisted')
    })

    it('coerces invalid gitlabToken type to null', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ gitlabToken: 42 }))
      expect(getSettings().gitlabToken).toBeNull()
    })
  })

  describe('gitlabHost', () => {
    it('defaults to gitlab.com', () => {
      expect(getSettings().gitlabHost).toBe('gitlab.com')
    })

    it('setGitlabHost stores a bare hostname', () => {
      setGitlabHost('gitlab.mycompany.com')
      expect(getSettings().gitlabHost).toBe('gitlab.mycompany.com')
    })

    it('setGitlabHost normalizes an origin to just the hostname', () => {
      setGitlabHost('https://gitlab.mycompany.com')
      expect(getSettings().gitlabHost).toBe('gitlab.mycompany.com')
    })

    it('setGitlabHost normalizes an origin with trailing slash', () => {
      setGitlabHost('https://gitlab.mycompany.com/')
      expect(getSettings().gitlabHost).toBe('gitlab.mycompany.com')
    })

    it('setGitlabHost rejects empty string', () => {
      expect(() => setGitlabHost('')).toThrow()
    })

    it('setGitlabHost rejects whitespace-only string', () => {
      expect(() => setGitlabHost('   ')).toThrow()
    })

    it('setGitlabHost rejects an invalid value (not a hostname or origin)', () => {
      expect(() => setGitlabHost('not a hostname!')).toThrow()
    })

    it('setGitlabHost accepts "gitlab.com" (restores default)', () => {
      setGitlabHost('custom.host.io')
      setGitlabHost('gitlab.com')
      expect(getSettings().gitlabHost).toBe('gitlab.com')
    })

    it('coerces invalid gitlabHost type to default (gitlab.com)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ gitlabHost: 42 }))
      expect(getSettings().gitlabHost).toBe('gitlab.com')
    })

    it('coerces stored empty string gitlabHost to default (gitlab.com)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ gitlabHost: '' }))
      expect(getSettings().gitlabHost).toBe('gitlab.com')
    })

    it('persists gitlabHost across getSettings() calls', () => {
      setGitlabHost('mygitlab.corp.internal')
      expect(getSettings().gitlabHost).toBe('mygitlab.corp.internal')
      expect(getSettings().gitlabHost).toBe('mygitlab.corp.internal')
    })

    it('shape-coerces: defaults include gitlabHost: gitlab.com', () => {
      const s = getSettings()
      expect(s).toHaveProperty('gitlabHost', 'gitlab.com')
    })
  })

  describe('saveTokens — OAuth preservation (Bug 1 regression)', () => {
    it('saveTokens with githubPat: null does NOT clear githubAuth when method is oauth', () => {
      // Seed OAuth auth
      saveGithubAuth({ token: 'gho_oauth_token', method: 'oauth', scopes: ['repo'] })
      expect(getSettings().githubAuth?.method).toBe('oauth')

      // Simulate SettingsPanel.save() with empty PAT field while oauth is active
      saveTokens({ githubPat: null, deepseekKey: null })

      // githubAuth must be preserved
      expect(getSettings().githubAuth).toEqual({ token: 'gho_oauth_token', method: 'oauth', scopes: ['repo'] })
    })

    it('saveTokens with githubPat: null DOES clear githubAuth when method is pat', () => {
      saveGithubAuth({ token: 'ghp_pat', method: 'pat', scopes: [] })
      expect(getSettings().githubAuth?.method).toBe('pat')

      saveTokens({ githubPat: null, deepseekKey: null })

      expect(getSettings().githubAuth).toBeNull()
    })

    it('saveTokens with a non-empty githubPat while method is oauth switches to pat method', () => {
      saveGithubAuth({ token: 'gho_oauth', method: 'oauth', scopes: ['repo'] })

      saveTokens({ githubPat: 'ghp_newpat', deepseekKey: null })

      const s = getSettings()
      expect(s.githubAuth).toEqual({ token: 'ghp_newpat', method: 'pat', scopes: [] })
      expect(s.githubPat).toBe('ghp_newpat')
    })
  })

  describe('bitbucketAuth', () => {
    it('defaults to null', () => {
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('saveBitbucketAuth stores email and token', () => {
      saveBitbucketAuth({ email: 'user@example.com', token: 'ATBBTOKEN' })
      const s = getSettings()
      expect(s.bitbucketAuth).toEqual({ email: 'user@example.com', token: 'ATBBTOKEN' })
    })

    it('saveBitbucketAuth(null) clears the auth', () => {
      saveBitbucketAuth({ email: 'user@example.com', token: 'ATBBTOKEN' })
      saveBitbucketAuth(null)
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('saveBitbucketAuth trims whitespace from email and token', () => {
      saveBitbucketAuth({ email: '  user@example.com  ', token: '  tk123  ' })
      const s = getSettings()
      expect(s.bitbucketAuth).toEqual({ email: 'user@example.com', token: 'tk123' })
    })

    it('saveBitbucketAuth throws and does not write if email is empty', () => {
      expect(() => saveBitbucketAuth({ email: '', token: 'token' })).toThrow(/email.*empty/i)
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('saveBitbucketAuth throws and does not write if email is whitespace only', () => {
      expect(() => saveBitbucketAuth({ email: '   ', token: 'token' })).toThrow(/email.*empty/i)
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('saveBitbucketAuth throws and does not write if token is empty', () => {
      expect(() => saveBitbucketAuth({ email: 'user@example.com', token: '' })).toThrow(/token.*empty/i)
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('saveBitbucketAuth throws and does not write if token is whitespace only', () => {
      expect(() => saveBitbucketAuth({ email: 'user@example.com', token: '   ' })).toThrow(/token.*empty/i)
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('coerces stored bitbucketAuth with missing fields to null', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ bitbucketAuth: { email: 'x@x.com' } }))
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('coerces stored bitbucketAuth with wrong types to null', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ bitbucketAuth: 42 }))
      expect(getSettings().bitbucketAuth).toBeNull()
    })

    it('round-trips through JSON serialization', () => {
      saveBitbucketAuth({ email: 'test@bb.com', token: 'secret123' })
      // Simulate a page reload by re-reading from localStorage
      const s = getSettings()
      expect(s.bitbucketAuth).toEqual({ email: 'test@bb.com', token: 'secret123' })
    })

    it('getSettings defaults include bitbucketAuth: null', () => {
      const s = getSettings()
      expect(s).toHaveProperty('bitbucketAuth', null)
    })
  })

  describe('AI provider + model settings (Plan F)', () => {
    it('aiProvider defaults to deepseek', () => {
      expect(getSettings().aiProvider).toBe('deepseek')
    })

    it('setAiProvider persists anthropic', () => {
      setAiProvider('anthropic')
      expect(getSettings().aiProvider).toBe('anthropic')
    })

    it('setAiProvider persists gemini', () => {
      setAiProvider('gemini')
      expect(getSettings().aiProvider).toBe('gemini')
    })

    it('setAiProvider persists openai', () => {
      setAiProvider('openai')
      expect(getSettings().aiProvider).toBe('openai')
    })

    it('coerces invalid aiProvider to default (deepseek)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ aiProvider: 'gpt5000' }))
      expect(getSettings().aiProvider).toBe('deepseek')
    })

    it('aiModel defaults to empty string', () => {
      expect(getSettings().aiModel).toBe('')
    })

    it('setAiModel persists the model id', () => {
      setAiModel('claude-sonnet-4-6')
      expect(getSettings().aiModel).toBe('claude-sonnet-4-6')
    })

    it('coerces non-string aiModel to default (empty string)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ aiModel: 42 }))
      expect(getSettings().aiModel).toBe('')
    })
  })

  describe('AI key settings — openaiKey / anthropicKey / geminiKey (Plan F)', () => {
    it('all three AI keys default to null', () => {
      const s = getSettings()
      expect(s.openaiKey).toBeNull()
      expect(s.anthropicKey).toBeNull()
      expect(s.geminiKey).toBeNull()
    })

    it('setOpenaiKey stores and retrieves a key', () => {
      setOpenaiKey('sk-openai-123')
      expect(getSettings().openaiKey).toBe('sk-openai-123')
    })

    it('setOpenaiKey(null) clears the key', () => {
      setOpenaiKey('sk-openai-123')
      setOpenaiKey(null)
      expect(getSettings().openaiKey).toBeNull()
    })

    it('setOpenaiKey trims whitespace', () => {
      setOpenaiKey('  sk-openai-trimmed  ')
      expect(getSettings().openaiKey).toBe('sk-openai-trimmed')
    })

    it('setOpenaiKey rejects empty string', () => {
      expect(() => setOpenaiKey('')).toThrow('empty')
    })

    it('setAnthropicKey stores and retrieves a key', () => {
      setAnthropicKey('sk-ant-abc')
      expect(getSettings().anthropicKey).toBe('sk-ant-abc')
    })

    it('setAnthropicKey(null) clears the key', () => {
      setAnthropicKey('sk-ant-abc')
      setAnthropicKey(null)
      expect(getSettings().anthropicKey).toBeNull()
    })

    it('setAnthropicKey rejects empty string', () => {
      expect(() => setAnthropicKey('')).toThrow('empty')
    })

    it('setGeminiKey stores and retrieves a key', () => {
      setGeminiKey('AIza-gemini-key')
      expect(getSettings().geminiKey).toBe('AIza-gemini-key')
    })

    it('setGeminiKey(null) clears the key', () => {
      setGeminiKey('AIza-gemini-key')
      setGeminiKey(null)
      expect(getSettings().geminiKey).toBeNull()
    })

    it('setGeminiKey rejects empty string', () => {
      expect(() => setGeminiKey('')).toThrow('empty')
    })

    it('saveTokens accepts anthropicKey + geminiKey atomically', () => {
      saveTokens({ anthropicKey: 'sk-ant-x', geminiKey: 'AIza-y' })
      const s = getSettings()
      expect(s.anthropicKey).toBe('sk-ant-x')
      expect(s.geminiKey).toBe('AIza-y')
    })

    it('saveTokens throws and leaves storage unchanged when openaiKey is whitespace', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ openaiKey: 'sk-openai-original' }))
      expect(() => saveTokens({ openaiKey: '  ' })).toThrow()
      expect(getSettings().openaiKey).toBe('sk-openai-original')
    })
  })
})
