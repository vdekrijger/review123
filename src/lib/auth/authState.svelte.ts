import { getSettings, _registerAuthRefresh, type GithubAuth } from '../settings/settings'

/**
 * Reactive auth state backed by a Svelte 5 $state rune.
 * authState.auth always reflects the current value of settings.githubAuth.
 *
 * Wiring: settings.ts exposes _registerAuthRefresh(fn) — a one-shot hook that
 * fires after every mutation touching githubAuth (saveGithubAuth, saveTokens
 * with a PAT change). We register refreshAuthState here so settings.ts never
 * needs to import this module, avoiding a circular module-initialization issue
 * (settings.ts defines DEFAULTS lazily; importing authState.svelte.ts from
 * settings.ts at static-import time causes DEFAULTS to be accessed before it
 * is initialized).
 */
const holder = $state<{ auth: GithubAuth | null }>({ auth: getSettings().githubAuth })

export const authState = {
  get auth() {
    return holder.auth
  },
  /** true when any GitHub auth (OAuth or PAT) is present */
  get ok(): boolean {
    return holder.auth !== null
  },
}

export function refreshAuthState(): void {
  holder.auth = getSettings().githubAuth
}

// Register so settings.ts notifies us after every auth mutation.
_registerAuthRefresh(refreshAuthState)

/**
 * FOR TESTS ONLY: reset module-level state so each test starts clean.
 * Call this in beforeEach alongside localStorage.clear().
 */
export function _resetAuthStateForTest(): void {
  holder.auth = getSettings().githubAuth
}
