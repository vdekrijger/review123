import { getSettings } from './settings'

/**
 * Apply current theme and uiFont settings to document.documentElement.
 *
 * theme: sets/clears data-theme attribute ('dark'/'light', absent for auto).
 * uiFont: sets/clears data-font attribute ('system'/'serif', absent for plex default).
 *
 * Call once at startup (main.ts) and immediately on every change in the UI.
 */
export function applyAppearance(): void {
  const { theme, uiFont } = getSettings()

  // data-theme: explicit value only; absent = auto (CSS handles via color-scheme: light dark)
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }

  // data-font: only set for non-default fonts; absent = plex (IBM Plex Sans, the default)
  if (uiFont === 'system' || uiFont === 'serif') {
    document.documentElement.setAttribute('data-font', uiFont)
  } else {
    // 'plex' is the default — no attribute needed
    document.documentElement.removeAttribute('data-font')
  }
}

/**
 * Return the effective theme, resolving 'auto' via matchMedia.
 * Always returns 'dark' or 'light'.
 */
export function resolvedTheme(): 'dark' | 'light' {
  const { theme } = getSettings()
  if (theme === 'dark' || theme === 'light') return theme
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}
