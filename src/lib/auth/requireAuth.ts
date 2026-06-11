import { getSettings } from '../settings/settings'

/**
 * Returns { ok: true } when any GitHub auth token is present.
 * Callers render a sign-in prompt when ok is false.
 * EC-09c, EC-19b.
 *
 * NOTE: This is a point-in-time check. For reactive UI that must update
 * automatically when auth changes (e.g. topbar), use authState.auth from
 * src/lib/auth/authState.svelte.ts instead.
 */
export function requireAuth(): { ok: boolean } {
  return { ok: getSettings().githubAuth !== null }
}
