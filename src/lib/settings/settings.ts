const KEY = 'review123:settings'

export type DiffMode = 'unified' | 'split'
export interface Settings {
  githubPat: string | null
  deepseekKey: string | null
  diffMode: DiffMode
}

const DEFAULTS: Settings = { githubPat: null, deepseekKey: null, diffMode: 'unified' }

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(patch: Partial<Settings>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...getSettings(), ...patch }))
}

function setToken(field: 'githubPat' | 'deepseekKey', value: string | null): void {
  if (value === null) return save({ [field]: null })
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must not be empty`)
  save({ [field]: trimmed })
}

export const setGithubPat = (v: string | null) => setToken('githubPat', v)
export const setDeepseekKey = (v: string | null) => setToken('deepseekKey', v)
export const setDiffMode = (mode: DiffMode) => save({ diffMode: mode })
