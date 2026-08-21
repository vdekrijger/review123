import { describe, it, expect, beforeEach } from 'vitest'
import {
  getSettings, setGithubPat, setDeepseekKey, setDiffMode, setHideWhitespace, saveTokens, saveGithubAuth,
  setTheme, setUiFont, setShowProgress, setTreeOpen, setTestFileDisplay, setGitlabToken,
  saveBitbucketAuth, setGitlabHost,
  setOpenaiKey, setAnthropicKey, setGeminiKey, setOpenrouterKey, setAiProvider, setAiModel,
  setAiDeepReview, setStoryMode, setAutoRunReviewers, setFocusMode, setShowTokenCost,
  findInvalidKeyChar, invalidKeyCharMessage, setUnderstandSections,
  setAiTaskMode, setAiTaskModes, setAllTasksDeep, setAllTasksStandard, setOffAllExtras,
  defaultTaskModes, allDeepTaskModes, taskSupportsDeep, setAiPanel, setPanelOneGenerator, setPanelAllGenerate,
  type PanelParticipant,
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
      openrouterKey: null,
      aiDeepReview: false,
      aiTaskModes: {
        summary: 'standard',
        attention: 'standard',
        diagrams: 'standard',
        tests: 'standard',
        alternatives: 'standard',
        verdict: 'standard',
        skills: 'standard',
        story: 'standard',
        riskJudge: 'standard',
        simplify: 'standard',
      },
      storyMode: true,
      autoRunReviewers: true,
      crossModelVerify: true,
      aiPanel: null,
      diffMode: 'unified',
      hideWhitespace: false,
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
      focusMode: 'imports',
      showTokenCost: false,
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

  it('persists hide-whitespace preference', () => {
    setHideWhitespace(true)
    expect(getSettings().hideWhitespace).toBe(true)
    setHideWhitespace(false)
    expect(getSettings().hideWhitespace).toBe(false)
  })

  it('coerces non-boolean hideWhitespace back to default', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ hideWhitespace: 'yes' }))
    expect(getSettings().hideWhitespace).toBe(false)
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
      openrouterKey: null,
      aiDeepReview: false,
      aiTaskModes: {
        summary: 'standard',
        attention: 'standard',
        diagrams: 'standard',
        tests: 'standard',
        alternatives: 'standard',
        verdict: 'standard',
        skills: 'standard',
        story: 'standard',
        riskJudge: 'standard',
        simplify: 'standard',
      },
      storyMode: true,
      autoRunReviewers: true,
      crossModelVerify: true,
      aiPanel: null,
      diffMode: 'unified',
      hideWhitespace: false,
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
      focusMode: 'imports',
      showTokenCost: false,
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

  describe('focusMode', () => {
    it('defaults to imports (non-destructive dimming recommendation)', () => {
      expect(getSettings().focusMode).toBe('imports')
    })

    it('setFocusMode persists off', () => {
      setFocusMode('off')
      expect(getSettings().focusMode).toBe('off')
    })

    it('setFocusMode persists imports-comments', () => {
      setFocusMode('imports-comments')
      expect(getSettings().focusMode).toBe('imports-comments')
    })

    it('setFocusMode round-trips back to imports', () => {
      setFocusMode('off')
      setFocusMode('imports')
      expect(getSettings().focusMode).toBe('imports')
    })

    it('coerces invalid focusMode back to default (imports)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ focusMode: 'blur' }))
      expect(getSettings().focusMode).toBe('imports')
    })

    it('coerces non-string focusMode back to default (imports)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ focusMode: 3 }))
      expect(getSettings().focusMode).toBe('imports')
    })
  })

  describe('showTokenCost (power-user token usage display)', () => {
    it('defaults to false', () => {
      expect(getSettings().showTokenCost).toBe(false)
    })

    it('setShowTokenCost persists true and back to false', () => {
      setShowTokenCost(true)
      expect(getSettings().showTokenCost).toBe(true)
      setShowTokenCost(false)
      expect(getSettings().showTokenCost).toBe(false)
    })

    it('coerces a non-boolean stored value back to default (false)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ showTokenCost: 'yes' }))
      expect(getSettings().showTokenCost).toBe(false)
    })

    it('persists a stored true', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ showTokenCost: true }))
      expect(getSettings().showTokenCost).toBe(true)
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

    it('openrouterKey defaults to null', () => {
      expect(getSettings().openrouterKey).toBeNull()
    })

    it('setOpenrouterKey stores, trims, clears, rejects empty, and persists', () => {
      setOpenrouterKey('  sk-or-abc  ')
      expect(getSettings().openrouterKey).toBe('sk-or-abc')
      // Survives a re-read from storage (persistence).
      expect(JSON.parse(localStorage.getItem('review123:settings')!).openrouterKey).toBe('sk-or-abc')
      setOpenrouterKey(null)
      expect(getSettings().openrouterKey).toBeNull()
      expect(() => setOpenrouterKey('')).toThrow('empty')
    })

    it('openrouter is a valid stored aiProvider', () => {
      setAiProvider('openrouter')
      expect(getSettings().aiProvider).toBe('openrouter')
    })

    it('saveTokens throws and leaves storage unchanged when openaiKey is whitespace', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ openaiKey: 'sk-openai-original' }))
      expect(() => saveTokens({ openaiKey: '  ' })).toThrow()
      expect(getSettings().openaiKey).toBe('sk-openai-original')
    })
  })
})

// ---------------------------------------------------------------------------
// aiDeepReview (Plan G part 2 — agentic deep review, opt-in)
// ---------------------------------------------------------------------------

describe('aiDeepReview setting', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to false (deep review is opt-in)', () => {
    expect(getSettings().aiDeepReview).toBe(false)
  })

  it('setAiDeepReview(true) persists and round-trips', () => {
    setAiDeepReview(true)
    expect(getSettings().aiDeepReview).toBe(true)
    setAiDeepReview(false)
    expect(getSettings().aiDeepReview).toBe(false)
  })

  it('coerces non-boolean stored values back to the default', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiDeepReview: 'yes' }))
    expect(getSettings().aiDeepReview).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// storyMode (Plan H — guided narrative walkthrough, defaults on)
// ---------------------------------------------------------------------------

describe('storyMode setting', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to true (lead with the narrative when a key exists)', () => {
    expect(getSettings().storyMode).toBe(true)
  })

  it('persists a false choice (user flipped to Files)', () => {
    setStoryMode(false)
    expect(getSettings().storyMode).toBe(false)
    setStoryMode(true)
    expect(getSettings().storyMode).toBe(true)
  })

  it('ignores a non-boolean stored value', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ storyMode: 'yes' }))
    expect(getSettings().storyMode).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// autoRunReviewers (auto-start reviewers early — opt-out, defaults on)
// ---------------------------------------------------------------------------

describe('autoRunReviewers setting', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to true (auto-start reviewers on PR load)', () => {
    expect(getSettings().autoRunReviewers).toBe(true)
  })

  it('persists a false choice (user opted out) and back to true', () => {
    setAutoRunReviewers(false)
    expect(getSettings().autoRunReviewers).toBe(false)
    setAutoRunReviewers(true)
    expect(getSettings().autoRunReviewers).toBe(true)
  })

  it('ignores a non-boolean stored value (coerces to default true)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ autoRunReviewers: 'yes' }))
    expect(getSettings().autoRunReviewers).toBe(true)
  })

  it('reads a stored boolean false', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ autoRunReviewers: false }))
    expect(getSettings().autoRunReviewers).toBe(false)
  })
})

describe('aiPanel setting (Plan P — unified model panel)', () => {
  beforeEach(() => localStorage.clear())

  const gen = (provider: string, model: string): PanelParticipant =>
    ({ provider: provider as PanelParticipant['provider'], model, role: 'generator' })
  const ver = (provider: string, model: string): PanelParticipant =>
    ({ provider: provider as PanelParticipant['provider'], model, role: 'verifier' })

  it('defaults to null (synthesize the default panel)', () => {
    expect(getSettings().aiPanel).toBeNull()
  })

  it('persists a valid panel (multi-model, same provider, per-row roles)', () => {
    const participants: PanelParticipant[] = [
      gen('anthropic', 'claude-opus-4-8'),
      ver('anthropic', 'claude-sonnet-4-6'),
      ver('anthropic', 'claude-haiku-4-5'),
    ]
    setAiPanel({ participants })
    expect(getSettings().aiPanel).toEqual({ participants })
  })

  it('drops participants with unknown provider or model', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      aiPanel: {
        participants: [
          gen('anthropic', 'claude-opus-4-8'),
          { provider: 'nope', model: 'x', role: 'verifier' },
          { provider: 'anthropic', model: 'not-a-model', role: 'verifier' },
          ver('openai', 'gpt-5.4'),
        ],
      },
    }))
    expect(getSettings().aiPanel).toEqual({
      participants: [gen('anthropic', 'claude-opus-4-8'), ver('openai', 'gpt-5.4')],
    })
  })

  it('drops a participant with an invalid role', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      aiPanel: {
        participants: [
          gen('anthropic', 'claude-opus-4-8'),
          { provider: 'openai', model: 'gpt-5.4', role: 'judge' },
        ],
      },
    }))
    expect(getSettings().aiPanel).toEqual({
      participants: [gen('anthropic', 'claude-opus-4-8')],
    })
  })

  it('enforces ≥1 generator — promotes the first row when all are verifiers', () => {
    setAiPanel({ participants: [ver('openai', 'gpt-5.4'), ver('anthropic', 'claude-opus-4-8')] })
    const panel = getSettings().aiPanel!
    expect(panel.participants[0].role).toBe('generator')
    expect(panel.participants[1].role).toBe('verifier')
  })

  it('returns null when no valid participant survives coercion', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      aiPanel: { participants: [{ provider: 'bogus', model: 'x', role: 'generator' }] },
    }))
    expect(getSettings().aiPanel).toBeNull()
  })

  it('clears back to null', () => {
    setAiPanel({ participants: [gen('openai', 'gpt-5.4')] })
    setAiPanel(null)
    expect(getSettings().aiPanel).toBeNull()
  })

  it('preset "One generator": first sole generator, rest verifiers', () => {
    setPanelOneGenerator([
      gen('anthropic', 'claude-opus-4-8'),
      gen('openai', 'gpt-5.4'),
      gen('deepseek', 'deepseek-chat'),
    ])
    const roles = getSettings().aiPanel!.participants.map((p) => p.role)
    expect(roles).toEqual(['generator', 'verifier', 'verifier'])
  })

  it('preset "All generate": every participant a generator', () => {
    setPanelAllGenerate([
      gen('anthropic', 'claude-opus-4-8'),
      ver('openai', 'gpt-5.4'),
      ver('deepseek', 'deepseek-chat'),
    ])
    const roles = getSettings().aiPanel!.participants.map((p) => p.role)
    expect(roles).toEqual(['generator', 'generator', 'generator'])
  })
})

describe('aiPanel migration (Plan P — from legacy aiEnsemble + fusionMode)', () => {
  beforeEach(() => localStorage.clear())

  it('migrates legacy verify: generator → generator, verifiers → verifiers', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      fusionMode: 'verify',
      aiEnsemble: {
        generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
        verifiers: [
          { provider: 'openai', model: 'gpt-5.4' },
          { provider: 'deepseek', model: 'deepseek-chat' },
        ],
      },
    }))
    expect(getSettings().aiPanel).toEqual({
      participants: [
        { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
        { provider: 'openai', model: 'gpt-5.4', role: 'verifier' },
        { provider: 'deepseek', model: 'deepseek-chat', role: 'verifier' },
      ],
    })
  })

  it('migrates legacy generate: ALL participants become generators', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      fusionMode: 'generate',
      aiEnsemble: {
        generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
        verifiers: [{ provider: 'openai', model: 'gpt-5.4' }],
      },
    }))
    expect(getSettings().aiPanel).toEqual({
      participants: [
        { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
        { provider: 'openai', model: 'gpt-5.4', role: 'generator' },
      ],
    })
  })

  it('default/unset legacy ensemble → null (default panel synthesized later)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ fusionMode: 'verify' }))
    expect(getSettings().aiPanel).toBeNull()
  })

  it('preserves crossModelVerify across migration', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      crossModelVerify: false,
      aiEnsemble: { generator: { provider: 'openai', model: 'gpt-5.4' }, verifiers: [] },
    }))
    expect(getSettings().crossModelVerify).toBe(false)
    expect(getSettings().aiPanel?.participants[0].role).toBe('generator')
  })

  it('explicit aiPanel wins over legacy fields', () => {
    const onlyGen: PanelParticipant = { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' }
    localStorage.setItem('review123:settings', JSON.stringify({
      fusionMode: 'generate',
      aiEnsemble: { generator: { provider: 'openai', model: 'gpt-5.4' }, verifiers: [] },
      aiPanel: { participants: [onlyGen] },
    }))
    expect(getSettings().aiPanel).toEqual({ participants: [onlyGen] })
  })
})

// ---------------------------------------------------------------------------
// Key character sanitization (user report: an EM DASH copy-paste artifact in
// a DeepSeek key blew up fetch header construction with a raw DOMException).
// All key/token save paths share one validator: trim, then reject characters
// that cannot travel in an HTTP header (non-ISO-8859-1 or control chars) with
// a human message naming the character and its position.
// ---------------------------------------------------------------------------

describe('key character sanitization', () => {
  beforeEach(() => localStorage.clear())

  describe('findInvalidKeyChar', () => {
    it('returns null for a clean ASCII key', () => {
      expect(findInvalidKeyChar('sk-abc_123.XYZ~')).toBeNull()
    })

    it('accepts ISO-8859-1 printable characters (e.g. é, ÿ)', () => {
      expect(findInvalidKeyChar('sk-café-ÿ')).toBeNull()
    })

    it('finds an EM DASH (U+2014) with its index', () => {
      expect(findInvalidKeyChar('sk-ab—cd')).toEqual({ char: '—', codePoint: 0x2014, index: 5 })
    })

    it('finds an inner newline control character', () => {
      expect(findInvalidKeyChar('sk-ab\ncd')).toEqual({ char: '\n', codePoint: 0x0a, index: 5 })
    })

    it('finds an astral character (emoji) as one code point', () => {
      const found = findInvalidKeyChar('sk-💥x')
      expect(found?.index).toBe(3)
      expect(found?.char).toBe('💥')
    })
  })

  describe('invalidKeyCharMessage', () => {
    it('names the printable character, its code point and 1-based position, and says re-copy', () => {
      const msg = invalidKeyCharMessage({ char: '—', codePoint: 0x2014, index: 49 })
      expect(msg).toContain('invalid character')
      expect(msg).toContain('"—" (U+2014)')
      expect(msg).toContain('position 50')
      expect(msg).toContain('re-copy it from the provider')
    })

    it('shows only the code point for control characters', () => {
      const msg = invalidKeyCharMessage({ char: '\n', codePoint: 0x0a, index: 3 })
      expect(msg).toContain('U+000A')
      expect(msg).not.toContain('"\n"')
    })
  })

  describe('save paths reject invalid characters with the friendly message', () => {
    const EM_DASH_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789a—b'

    it('saveTokens(deepseekKey) with an em dash throws the friendly message and saves nothing', () => {
      expect(() => saveTokens({ deepseekKey: EM_DASH_KEY })).toThrow(/invalid character/)
      expect(() => saveTokens({ deepseekKey: EM_DASH_KEY })).toThrow(/re-copy it from the provider/)
      expect(getSettings().deepseekKey).toBeNull()
    })

    it('the message points at the offending character and position', () => {
      expect(() => saveTokens({ deepseekKey: 'sk-ab—cd' })).toThrow('"—" (U+2014) at position 6')
    })

    it('applies to every AI provider key field via saveTokens', () => {
      for (const field of ['githubPat', 'deepseekKey', 'openaiKey', 'anthropicKey', 'geminiKey'] as const) {
        expect(() => saveTokens({ [field]: 'x—y' })).toThrow(/invalid character/)
        expect(getSettings()[field]).toBeNull()
      }
    })

    it('rejects an inner newline (multi-line paste) but trims surrounding whitespace', () => {
      expect(() => setDeepseekKey('sk-a\nb')).toThrow(/invalid character/)
      setDeepseekKey('  sk-clean\n')
      expect(getSettings().deepseekKey).toBe('sk-clean')
    })

    it('setGitlabToken rejects an em dash with the friendly message', () => {
      expect(() => setGitlabToken('glpat—oops')).toThrow(/invalid character/)
      expect(getSettings().gitlabToken).toBeNull()
    })

    it('saveBitbucketAuth rejects an invalid character in token or email (Basic auth header)', () => {
      expect(() => saveBitbucketAuth({ email: 'a@b.c', token: 'tok—en' })).toThrow(/invalid character/)
      expect(() => saveBitbucketAuth({ email: 'a—b@c.d', token: 'token' })).toThrow(/invalid character/)
      expect(getSettings().bitbucketAuth).toBeNull()
    })
  })

  describe('aiTaskModes (Plan J — per-task modes)', () => {
    it('defaults to every task standard', () => {
      expect(getSettings().aiTaskModes).toEqual({
        summary: 'standard', attention: 'standard', diagrams: 'standard',
        tests: 'standard', alternatives: 'standard', verdict: 'standard', skills: 'standard',
        story: 'standard', riskJudge: 'standard', simplify: 'standard',
      })
      expect(defaultTaskModes()).toEqual(getSettings().aiTaskModes)
    })

    it('migration: legacy aiDeepReview=true (no matrix) → deep-capable tasks deep, summary/riskJudge standard', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ aiDeepReview: true }))
      const m = getSettings().aiTaskModes
      expect(m).toEqual(allDeepTaskModes())
      expect(m.summary).toBe('standard')
      // riskJudge is single-pass by design — never migrated to deep.
      expect(m.riskJudge).toBe('standard')
      for (const t of ['attention', 'diagrams', 'tests', 'alternatives', 'verdict', 'skills', 'story'] as const) {
        expect(m[t]).toBe('deep')
      }
    })

    it('migration: legacy aiDeepReview=false → all standard', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ aiDeepReview: false }))
      expect(getSettings().aiTaskModes).toEqual(defaultTaskModes())
    })

    it('explicit aiTaskModes wins over legacy aiDeepReview=true', () => {
      localStorage.setItem('review123:settings', JSON.stringify({
        aiDeepReview: true,
        aiTaskModes: { verdict: 'off', diagrams: 'standard' },
      }))
      const m = getSettings().aiTaskModes
      expect(m.verdict).toBe('off')
      expect(m.diagrams).toBe('standard')
      // unspecified keys fall back to the default, NOT to the deep migration
      expect(m.attention).toBe('standard')
    })

    it('coerces summary="deep" (invalid) back to standard', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { summary: 'deep' } }))
      expect(getSettings().aiTaskModes.summary).toBe('standard')
    })

    it('coerces an invalid mode string back to the default standard', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { tests: 'wat' } }))
      expect(getSettings().aiTaskModes.tests).toBe('standard')
    })

    it('setAiTaskMode persists one task', () => {
      setAiTaskMode('diagrams', 'off')
      expect(getSettings().aiTaskModes.diagrams).toBe('off')
      setAiTaskMode('verdict', 'deep')
      expect(getSettings().aiTaskModes.verdict).toBe('deep')
    })

    it('setAiTaskMode coerces summary deep → standard', () => {
      setAiTaskMode('summary', 'deep')
      expect(getSettings().aiTaskModes.summary).toBe('standard')
    })

    it('setAiTaskModes replaces the whole matrix', () => {
      setAiTaskModes({ ...defaultTaskModes(), tests: 'off', verdict: 'deep' })
      expect(getSettings().aiTaskModes.tests).toBe('off')
      expect(getSettings().aiTaskModes.verdict).toBe('deep')
    })

    it('setAllTasksDeep reproduces legacy all-deep', () => {
      setAllTasksDeep()
      expect(getSettings().aiTaskModes).toEqual(allDeepTaskModes())
    })

    it('setAllTasksStandard reproduces legacy all-standard', () => {
      setAllTasksDeep()
      setAllTasksStandard()
      expect(getSettings().aiTaskModes).toEqual(defaultTaskModes())
    })

    it('setOffAllExtras keeps summary + verdict, turns the rest (incl. story + riskJudge + simplify) off', () => {
      setOffAllExtras()
      const m = getSettings().aiTaskModes
      expect(m.summary).toBe('standard')
      expect(m.verdict).toBe('standard')
      for (const t of ['attention', 'diagrams', 'tests', 'alternatives', 'skills', 'story', 'riskJudge', 'simplify'] as const) {
        expect(m[t]).toBe('off')
      }
    })

    describe('story + riskJudge joining the matrix (stored-matrix migration)', () => {
      it('a pre-existing matrix without story/riskJudge keys gains both as standard (behavior unchanged)', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: { summary: 'off', verdict: 'standard' },
        }))
        const m = getSettings().aiTaskModes
        expect(m.story).toBe('standard')
        expect(m.riskJudge).toBe('standard')
      })

      it('a stored verdict=deep carries story to deep (the old verdict piggyback)', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: { verdict: 'deep' },
        }))
        const m = getSettings().aiTaskModes
        expect(m.story).toBe('deep')
        expect(m.riskJudge).toBe('standard')
      })

      it('ALL six original auto tasks off carries story + riskJudge to off (the old start() short-circuit)', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: {
            summary: 'off', attention: 'off', diagrams: 'off',
            tests: 'off', alternatives: 'off', verdict: 'off',
          },
        }))
        const m = getSettings().aiTaskModes
        expect(m.story).toBe('off')
        expect(m.riskJudge).toBe('off')
      })

      it('explicit stored story/riskJudge values win over the derivation', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: {
            summary: 'off', attention: 'off', diagrams: 'off',
            tests: 'off', alternatives: 'off', verdict: 'off',
            story: 'standard', riskJudge: 'standard',
          },
        }))
        const m = getSettings().aiTaskModes
        expect(m.story).toBe('standard')
        expect(m.riskJudge).toBe('standard')
      })

      it('riskJudge="deep" (invalid — single-pass by design) coerces via the derivation to standard', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: { riskJudge: 'deep' },
        }))
        expect(getSettings().aiTaskModes.riskJudge).toBe('standard')
      })

      it('setAiTaskMode coerces riskJudge deep → standard, but persists story deep (deep-capable)', () => {
        setAiTaskMode('riskJudge', 'deep')
        expect(getSettings().aiTaskModes.riskJudge).toBe('standard')
        setAiTaskMode('story', 'deep')
        expect(getSettings().aiTaskModes.story).toBe('deep')
        setAiTaskMode('riskJudge', 'off')
        expect(getSettings().aiTaskModes.riskJudge).toBe('off')
      })
    })

    describe('simplify joining the matrix (stored-matrix migration)', () => {
      it('a pre-existing matrix without a simplify key derives standard (the pass is always-on)', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: { summary: 'off', verdict: 'deep' },
        }))
        expect(getSettings().aiTaskModes.simplify).toBe('standard')
      })

      it('ALL six original auto tasks off carries simplify to off (minimal-token posture preserved)', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: {
            summary: 'off', attention: 'off', diagrams: 'off',
            tests: 'off', alternatives: 'off', verdict: 'off',
          },
        }))
        expect(getSettings().aiTaskModes.simplify).toBe('off')
      })

      it('an explicit stored simplify value wins over the derivation', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: {
            summary: 'off', attention: 'off', diagrams: 'off',
            tests: 'off', alternatives: 'off', verdict: 'off',
            simplify: 'standard',
          },
        }))
        expect(getSettings().aiTaskModes.simplify).toBe('standard')
      })

      it('simplify="deep" (invalid — a pure text rewrite, no tools) coerces to standard', () => {
        localStorage.setItem('review123:settings', JSON.stringify({
          aiTaskModes: { simplify: 'deep' },
        }))
        expect(getSettings().aiTaskModes.simplify).toBe('standard')
        expect(taskSupportsDeep('simplify')).toBe(false)
      })

      it('setAiTaskMode coerces simplify deep → standard, persists off', () => {
        setAiTaskMode('simplify', 'deep')
        expect(getSettings().aiTaskModes.simplify).toBe('standard')
        setAiTaskMode('simplify', 'off')
        expect(getSettings().aiTaskModes.simplify).toBe('off')
      })

      it('legacy aiDeepReview=true migration leaves simplify standard (never deep)', () => {
        localStorage.setItem('review123:settings', JSON.stringify({ aiDeepReview: true }))
        expect(getSettings().aiTaskModes.simplify).toBe('standard')
      })
    })
  })

  describe('understandSections (Understand-step layout)', () => {
    it('defaults to undefined when nothing stored', () => {
      expect(getSettings().understandSections).toBeUndefined()
    })

    it('setter persists an ordered list', () => {
      setUnderstandSections([
        { id: 'pr-description', enabled: true },
        { id: 'summary', enabled: false },
      ])
      expect(getSettings().understandSections).toEqual([
        { id: 'pr-description', enabled: true },
        { id: 'summary', enabled: false },
      ])
    })

    it('setter survives a round-trip through storage', () => {
      setUnderstandSections([{ id: 'summary', enabled: true }])
      const reloaded = getSettings().understandSections
      expect(reloaded).toEqual([{ id: 'summary', enabled: true }])
    })

    it('setUnderstandSections(null) clears the preference', () => {
      setUnderstandSections([{ id: 'summary', enabled: false }])
      setUnderstandSections(null)
      expect(getSettings().understandSections).toBeUndefined()
    })

    it('coercion coerces enabled to a boolean (missing → true; only explicit false disables)', () => {
      localStorage.setItem(
        'review123:settings',
        JSON.stringify({
          understandSections: [
            { id: 'summary' }, // missing enabled → true
            { id: 'diagrams', enabled: false },
            { id: 'ci-details', enabled: 'yes' }, // non-boolean truthy → true
          ],
        }),
      )
      expect(getSettings().understandSections).toEqual([
        { id: 'summary', enabled: true },
        { id: 'diagrams', enabled: false },
        { id: 'ci-details', enabled: true },
      ])
    })

    it('coercion drops entries without a string id and de-dupes', () => {
      localStorage.setItem(
        'review123:settings',
        JSON.stringify({
          understandSections: [
            { id: 'summary', enabled: true },
            { enabled: true }, // no id → dropped
            { id: 42, enabled: true }, // non-string id → dropped
            'garbage', // not an object → dropped
            { id: 'summary', enabled: false }, // duplicate id → dropped (first wins)
          ],
        }),
      )
      expect(getSettings().understandSections).toEqual([{ id: 'summary', enabled: true }])
    })

    it('coercion is tolerant: a non-array value yields undefined (registry default)', () => {
      localStorage.setItem(
        'review123:settings',
        JSON.stringify({ understandSections: 'not-an-array' }),
      )
      expect(getSettings().understandSections).toBeUndefined()
    })

    it('does not add the key to default settings when absent', () => {
      expect('understandSections' in getSettings()).toBe(false)
    })
  })
})
