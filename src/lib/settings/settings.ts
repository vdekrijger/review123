const KEY = 'review123:settings'

export type DiffMode = 'unified' | 'split'

export interface GithubAuth {
  token: string
  method: 'oauth' | 'pat'
  scopes: string[]
}

export interface Settings {
  githubPat: string | null
  deepseekKey: string | null
  diffMode: DiffMode
  githubAuth: GithubAuth | null
}

const DEFAULTS: Settings = {
  githubPat: null,
  deepseekKey: null,
  diffMode: 'unified',
  githubAuth: null,
}

function coerceGithubAuth(raw: unknown): GithubAuth | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj['token'] !== 'string') return null
  if (obj['method'] !== 'oauth' && obj['method'] !== 'pat') return null
  const scopes = Array.isArray(obj['scopes']) && obj['scopes'].every((s) => typeof s === 'string')
    ? (obj['scopes'] as string[])
    : []
  return { token: obj['token'] as string, method: obj['method'] as 'oauth' | 'pat', scopes }
}

function coerce(raw: unknown): Partial<Settings> {
  if (typeof raw !== 'object' || raw === null) return {}
  const obj = raw as Record<string, unknown>
  const result: Partial<Settings> = {}

  const diffMode = obj['diffMode']
  if (diffMode === 'unified' || diffMode === 'split') result.diffMode = diffMode

  const githubPat = obj['githubPat']
  if (typeof githubPat === 'string') result.githubPat = githubPat
  else if (githubPat === null) result.githubPat = null

  const deepseekKey = obj['deepseekKey']
  if (typeof deepseekKey === 'string' || deepseekKey === null) result.deepseekKey = deepseekKey

  // Prefer explicit githubAuth; fall back to migrating legacy githubPat string
  if ('githubAuth' in obj) {
    result.githubAuth = coerceGithubAuth(obj['githubAuth'])
  } else if (typeof githubPat === 'string' && githubPat) {
    // Migration: legacy bare PAT → unified auth shape
    result.githubAuth = { token: githubPat, method: 'pat', scopes: [] }
  }

  return result
}

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    return { ...DEFAULTS, ...coerce(raw ? JSON.parse(raw) : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(patch: Partial<Settings>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...getSettings(), ...patch }))
}

function validateToken(field: 'githubPat' | 'deepseekKey', value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must not be empty`)
  return trimmed
}

export function saveTokens(patch: { githubPat?: string | null; deepseekKey?: string | null }): void {
  // Validate all first (atomic — throw before writing anything)
  const update: Partial<Settings> = {}
  if ('githubPat' in patch) update.githubPat = validateToken('githubPat', patch.githubPat ?? null)
  if ('deepseekKey' in patch) update.deepseekKey = validateToken('deepseekKey', patch.deepseekKey ?? null)

  // Also maintain githubAuth in sync with githubPat changes
  if ('githubPat' in update) {
    update.githubAuth = update.githubPat
      ? { token: update.githubPat, method: 'pat', scopes: [] }
      : null
  }

  save(update)
}

export function saveGithubAuth(auth: GithubAuth | null): void {
  const update: Partial<Settings> = { githubAuth: auth }
  if (auth && auth.method === 'pat') {
    // Keep githubPat in sync for backward compat
    update.githubPat = auth.token
  } else if (auth && auth.method === 'oauth') {
    // Clear any stale legacy PAT so no plaintext token lingers at rest
    update.githubPat = null
  } else if (auth === null) {
    update.githubPat = null
  }
  save(update)
}

export const setGithubPat = (v: string | null) => saveTokens({ githubPat: v })
export const setDeepseekKey = (v: string | null) => saveTokens({ deepseekKey: v })
export const setDiffMode = (mode: DiffMode) => save({ diffMode: mode })
