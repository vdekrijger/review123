const KEY = 'review123:settings'

export type DiffMode = 'unified' | 'split'
export interface Settings {
  githubPat: string | null
  deepseekKey: string | null
  diffMode: DiffMode
}

const DEFAULTS: Settings = { githubPat: null, deepseekKey: null, diffMode: 'unified' }

function coerce(raw: unknown): Partial<Settings> {
  if (typeof raw !== 'object' || raw === null) return {}
  const obj = raw as Record<string, unknown>
  const result: Partial<Settings> = {}
  const diffMode = obj['diffMode']
  if (diffMode === 'unified' || diffMode === 'split') result.diffMode = diffMode
  const githubPat = obj['githubPat']
  if (typeof githubPat === 'string' || githubPat === null) result.githubPat = githubPat
  const deepseekKey = obj['deepseekKey']
  if (typeof deepseekKey === 'string' || deepseekKey === null) result.deepseekKey = deepseekKey
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
  const update: Partial<Settings> = {}
  if ('githubPat' in patch) update.githubPat = validateToken('githubPat', patch.githubPat ?? null)
  if ('deepseekKey' in patch) update.deepseekKey = validateToken('deepseekKey', patch.deepseekKey ?? null)
  save(update)
}

export const setGithubPat = (v: string | null) => saveTokens({ githubPat: v })
export const setDeepseekKey = (v: string | null) => saveTokens({ deepseekKey: v })
export const setDiffMode = (mode: DiffMode) => save({ diffMode: mode })
