import { getSettings } from '../settings/settings'

/**
 * Returns { ok: true } when any GitHub auth token is present.
 * Callers render a sign-in prompt when ok is false.
 * EC-09c, EC-19b.
 */
export function requireAuth(): { ok: boolean } {
  return { ok: getSettings().githubAuth !== null }
}
