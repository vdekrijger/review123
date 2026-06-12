import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setShowProgress, setTestFileDisplay } from './settings'
import { settingsState, _resetSettingsStateForTest } from './settingsState.svelte'

describe('settingsState — reactive facade', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetSettingsStateForTest()
  })

  it('settingsState.current reflects default settings on init', () => {
    expect(settingsState.current.showProgress).toBe(true)
    expect(settingsState.current.testFileDisplay).toBe('normal')
  })

  it('settingsState.current updates after setShowProgress(false) without remount', () => {
    expect(settingsState.current.showProgress).toBe(true)
    setShowProgress(false)
    expect(settingsState.current.showProgress).toBe(false)
  })

  it('settingsState.current updates after setTestFileDisplay("highlight") without remount', () => {
    expect(settingsState.current.testFileDisplay).toBe('normal')
    setTestFileDisplay('highlight')
    expect(settingsState.current.testFileDisplay).toBe('highlight')
  })

  it('settingsState.current remains consistent with getSettings()', () => {
    setShowProgress(false)
    setTestFileDisplay('dim')
    const direct = getSettings()
    expect(settingsState.current.showProgress).toBe(direct.showProgress)
    expect(settingsState.current.testFileDisplay).toBe(direct.testFileDisplay)
  })
})
