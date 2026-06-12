/**
 * src/lib/provider/storeKeys.ts — helpers for provider-qualified storage keys.
 *
 * Storage keys used by visits, viewed, and draft stores are being migrated from
 * the legacy unqualified form ("owner/repo#number") to a provider-qualified form
 * ("github:owner/repo#number"). These helpers handle the transition.
 *
 * Key formats:
 *   Legacy  prId:  "owner/repo#number"
 *   Legacy  prKey: "owner/repo#number@sha"
 *
 *   New     prId:  "github:owner/repo#number"
 *   New     prKey: "github:owner/repo#number@sha"
 */

const PROVIDER_PREFIX_RE = /^(github|gitlab|bitbucket):/
const GITLAB_HOST_PREFIX_RE = /^gitlab@[^:]+:/

/**
 * Return true if the key already has a provider prefix (including gitlab@host: form).
 */
export function isQualified(key: string): boolean {
  return PROVIDER_PREFIX_RE.test(key) || GITLAB_HOST_PREFIX_RE.test(key)
}

/**
 * Qualify a prId ("owner/repo#number") with a provider prefix.
 * If already qualified, returns as-is.
 *
 * @param prId       - e.g. "owner/repo#123" or "github:owner/repo#123"
 * @param providerId - defaults to 'github'
 */
export function qualifyPrId(prId: string, providerId = 'github'): string {
  if (isQualified(prId)) return prId
  return `${providerId}:${prId}`
}

/**
 * Qualify a prKey ("owner/repo#number@sha") with a provider prefix.
 * If already qualified, returns as-is.
 *
 * @param prKey      - e.g. "owner/repo#123@abc1234" or "github:owner/repo#123@abc1234"
 * @param providerId - defaults to 'github'
 */
export function qualifyPrKey(prKey: string, providerId = 'github'): string {
  if (isQualified(prKey)) return prKey
  return `${providerId}:${prKey}`
}

/**
 * Qualify a GitLab prId with host awareness.
 * - Default host (gitlab.com) → "gitlab:owner/repo#N"
 * - Non-default host         → "gitlab@host:owner/repo#N"
 * If already qualified, returns as-is.
 *
 * Migration-safe: existing default-host keys remain "gitlab:..." unchanged.
 */
export function qualifyGitlabId(prId: string, host: string): string {
  if (isQualified(prId)) return prId
  if (host === 'gitlab.com') return `gitlab:${prId}`
  return `gitlab@${host}:${prId}`
}

/**
 * Qualify a GitLab prKey (owner/repo#N@sha) with host awareness.
 * - Default host (gitlab.com) → "gitlab:owner/repo#N@sha"
 * - Non-default host         → "gitlab@host:owner/repo#N@sha"
 * If already qualified, returns as-is.
 */
export function qualifyGitlabKey(prKey: string, host: string): string {
  if (isQualified(prKey)) return prKey
  if (host === 'gitlab.com') return `gitlab:${prKey}`
  return `gitlab@${host}:${prKey}`
}

/**
 * Strip the provider prefix from a key, returning the legacy form.
 * If not qualified, returns as-is.
 */
export function unqualify(key: string): string {
  return key.replace(PROVIDER_PREFIX_RE, '').replace(GITLAB_HOST_PREFIX_RE, '')
}

// ---------------------------------------------------------------------------
// Silent migration helpers
//
// These functions read legacy localStorage keys and, if the qualified key has
// no data but the legacy key does, copy the data to the qualified key.
// They are idempotent and safe to call multiple times.
// ---------------------------------------------------------------------------

const VISITS_KEY = 'review123:visits'
const VIEWED_KEY = 'review123:viewed'

function migrateStoreKeys(storageKey: string): void {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return

    let changed = false
    const migrated: Record<string, unknown> = { ...parsed }

    for (const [key, value] of Object.entries(parsed)) {
      if (isQualified(key)) continue // already qualified
      // Legacy key — write under qualified key if not already present
      const qualified = qualifyPrId(key)
      if (!(qualified in migrated)) {
        migrated[qualified] = value
        changed = true
      }
    }

    if (changed) {
      localStorage.setItem(storageKey, JSON.stringify(migrated))
    }
  } catch {
    // Migration is best-effort — silently ignore any errors
  }
}

/**
 * Migrate legacy visit keys ("owner/repo#number") to provider-qualified keys
 * ("github:owner/repo#number") in localStorage. Safe to call multiple times.
 */
export function migrateLegacyVisits(): void {
  migrateStoreKeys(VISITS_KEY)
}

/**
 * Migrate legacy viewed keys ("owner/repo#number") to provider-qualified keys
 * ("github:owner/repo#number") in localStorage. Safe to call multiple times.
 */
export function migrateLegacyViewed(): void {
  migrateStoreKeys(VIEWED_KEY)
}
