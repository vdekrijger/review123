import { getSettings, _registerSettingsRefresh, type Settings } from './settings'

/**
 * Reactive settings state backed by a Svelte 5 $state rune.
 * settingsState.current always reflects the most recently saved Settings.
 *
 * Wiring: settings.ts exposes _registerSettingsRefresh(fn) — fired after every
 * write to localStorage. We register refreshSettingsState here so components
 * that derive from settingsState.current re-render automatically when any
 * setting changes, without a static import cycle.
 */
const holder = $state<{ current: Settings }>({ current: getSettings() })

export const settingsState = {
  get current(): Settings {
    return holder.current
  },
}

export function refreshSettingsState(): void {
  holder.current = getSettings()
}

// Register so settings.ts notifies us after every mutation.
_registerSettingsRefresh(refreshSettingsState)

/**
 * FOR TESTS ONLY: reset module-level state so each test starts clean.
 * Call this in beforeEach alongside localStorage.clear().
 */
export function _resetSettingsStateForTest(): void {
  holder.current = getSettings()
}
