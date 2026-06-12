/**
 * src/lib/provider/viewer.ts — session-cached viewer identity resolution.
 *
 * Wraps provider.getViewerLogin() with:
 *   - capability check (method presence)
 *   - auth check (no request when unauthenticated)
 *   - per-provider in-memory session cache (never refetch per render)
 *
 * Failures resolve to null (no gating) and are NOT cached, so a transient
 * error does not pin the identity to "unknown" for the whole session.
 */

import type { ReviewProvider } from './types'

// In-memory session cache: provider id → resolved login (or null)
const _cache = new Map<string, string | null>()

/** FOR TESTS ONLY: clear the session cache. */
export function _resetViewerCacheForTest(): void {
  _cache.clear()
}

/**
 * Resolve the authenticated viewer's provider-canonical login.
 * Returns null when the provider has no identity support, is not
 * authenticated, or the lookup fails.
 */
export async function resolveViewerLogin(provider: ReviewProvider): Promise<string | null> {
  if (typeof provider.getViewerLogin !== 'function') return null
  if (!provider.authState().configured) return null
  if (_cache.has(provider.id)) return _cache.get(provider.id)!
  try {
    const login = await provider.getViewerLogin()
    _cache.set(provider.id, login)
    return login
  } catch {
    return null
  }
}
