const KEY = 'review123:settings'

// Lazy refresh hook: authState.svelte.ts registers itself here after it
// initialises (avoiding a circular module-init dependency). settings.ts calls
// this hook after every mutation that touches githubAuth so that the reactive
// store stays in sync without a static import cycle.
let _onAuthMutated: (() => void) | null = null
export function _registerAuthRefresh(fn: () => void): void {
  _onAuthMutated = fn
}
function notifyAuthMutated(): void {
  _onAuthMutated?.()
}

let _onSettingsMutated: (() => void) | null = null
export function _registerSettingsRefresh(fn: () => void): void {
  _onSettingsMutated = fn
}
function notifySettingsMutated(): void {
  _onSettingsMutated?.()
}

export type DiffMode = 'unified' | 'split'
export type Theme = 'auto' | 'dark' | 'light'
export type UiFont = 'plex' | 'system' | 'serif'
export type TestFileDisplay = 'normal' | 'highlight' | 'dim'
export type DiffWidth = 'centered' | 'full'

export interface GithubAuth {
  token: string
  method: 'oauth' | 'pat'
  scopes: string[]
}

export interface BitbucketAuth {
  email: string
  token: string
}

/**
 * GitLab OAuth token bundle (distinct from the PAT gitlabToken).
 * Tokens are short-lived (2 h); refreshToken is used for transparent renewal.
 * expiresAt is a Unix ms timestamp.
 */
export interface GitlabOAuth {
  token: string
  refreshToken: string
  expiresAt: number
}

export type AiProvider = 'deepseek' | 'openai' | 'anthropic' | 'gemini'

export interface Settings {
  githubPat: string | null
  deepseekKey: string | null
  /** Active AI provider selection. Default 'deepseek'. */
  aiProvider: AiProvider
  /** Active model id within the selected provider. Empty string = use provider default. */
  aiModel: string
  /** OpenAI API key (routed via serverless proxy). */
  openaiKey: string | null
  /** Anthropic API key (direct browser access with anthropic-dangerous-direct-browser-access header). */
  anthropicKey: string | null
  /** Google Gemini API key. */
  geminiKey: string | null
  diffMode: DiffMode
  githubAuth: GithubAuth | null
  gitlabToken: string | null
  gitlabHost: string
  /** GitLab OAuth token bundle (separate from gitlabToken PAT). */
  gitlabOAuth: GitlabOAuth | null
  bitbucketAuth: BitbucketAuth | null
  railCollapsed: boolean
  theme: Theme
  uiFont: UiFont
  showProgress: boolean
  treeOpen: boolean
  testFileDisplay: TestFileDisplay
  diffWidth: DiffWidth
}

const DEFAULTS: Settings = {
  githubPat: null,
  deepseekKey: null,
  aiProvider: 'deepseek',
  aiModel: '',
  openaiKey: null,
  anthropicKey: null,
  geminiKey: null,
  diffMode: 'unified',
  githubAuth: null,
  gitlabToken: null,
  gitlabHost: 'gitlab.com',
  gitlabOAuth: null,
  bitbucketAuth: null,
  railCollapsed: false,
  theme: 'auto',
  uiFont: 'plex',
  showProgress: true,
  treeOpen: false,
  testFileDisplay: 'normal',
  diffWidth: 'centered',
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

function coerceGitlabOAuth(raw: unknown): GitlabOAuth | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj['token'] !== 'string' || !obj['token']) return null
  if (typeof obj['refreshToken'] !== 'string' || !obj['refreshToken']) return null
  if (typeof obj['expiresAt'] !== 'number') return null
  return {
    token: obj['token'] as string,
    refreshToken: obj['refreshToken'] as string,
    expiresAt: obj['expiresAt'] as number,
  }
}

function coerceBitbucketAuth(raw: unknown): BitbucketAuth | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj['email'] !== 'string' || !obj['email']) return null
  if (typeof obj['token'] !== 'string' || !obj['token']) return null
  return { email: obj['email'] as string, token: obj['token'] as string }
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

  const aiProvider = obj['aiProvider']
  if (aiProvider === 'deepseek' || aiProvider === 'openai' || aiProvider === 'anthropic' || aiProvider === 'gemini') {
    result.aiProvider = aiProvider
  }

  const aiModel = obj['aiModel']
  if (typeof aiModel === 'string') result.aiModel = aiModel

  const openaiKey = obj['openaiKey']
  if (typeof openaiKey === 'string' || openaiKey === null) result.openaiKey = openaiKey as string | null

  const anthropicKey = obj['anthropicKey']
  if (typeof anthropicKey === 'string' || anthropicKey === null) result.anthropicKey = anthropicKey as string | null

  const geminiKey = obj['geminiKey']
  if (typeof geminiKey === 'string' || geminiKey === null) result.geminiKey = geminiKey as string | null

  const gitlabToken = obj['gitlabToken']
  if (typeof gitlabToken === 'string') result.gitlabToken = gitlabToken
  else if (gitlabToken === null) result.gitlabToken = null

  const gitlabHost = obj['gitlabHost']
  if (typeof gitlabHost === 'string' && gitlabHost.trim()) {
    const normalized = normalizeGitlabHost(gitlabHost)
    if (normalized !== null) result.gitlabHost = normalized
  }

  const railCollapsed = obj['railCollapsed']
  if (typeof railCollapsed === 'boolean') result.railCollapsed = railCollapsed

  const theme = obj['theme']
  if (theme === 'auto' || theme === 'dark' || theme === 'light') result.theme = theme

  const uiFont = obj['uiFont']
  // 'humanist' was the old name for system-font choice — coerce to 'system'
  if (uiFont === 'plex' || uiFont === 'system' || uiFont === 'serif') {
    result.uiFont = uiFont
  } else if (uiFont === 'humanist') {
    result.uiFont = 'system'
  }

  const showProgress = obj['showProgress']
  if (typeof showProgress === 'boolean') result.showProgress = showProgress

  const treeOpen = obj['treeOpen']
  if (typeof treeOpen === 'boolean') result.treeOpen = treeOpen

  const testFileDisplay = obj['testFileDisplay']
  if (testFileDisplay === 'normal' || testFileDisplay === 'highlight' || testFileDisplay === 'dim') {
    result.testFileDisplay = testFileDisplay
  }

  const diffWidth = obj['diffWidth']
  if (diffWidth === 'centered' || diffWidth === 'full') result.diffWidth = diffWidth

  // Prefer explicit githubAuth; fall back to migrating legacy githubPat string
  if ('githubAuth' in obj) {
    result.githubAuth = coerceGithubAuth(obj['githubAuth'])
  } else if (typeof githubPat === 'string' && githubPat) {
    // Migration: legacy bare PAT → unified auth shape
    result.githubAuth = { token: githubPat, method: 'pat', scopes: [] }
  }

  if ('bitbucketAuth' in obj) {
    result.bitbucketAuth = coerceBitbucketAuth(obj['bitbucketAuth'])
  }

  if ('gitlabOAuth' in obj) {
    result.gitlabOAuth = coerceGitlabOAuth(obj['gitlabOAuth'])
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
  notifySettingsMutated()
}

function validateToken(field: 'githubPat' | 'deepseekKey' | 'openaiKey' | 'anthropicKey' | 'geminiKey', value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must not be empty`)
  return trimmed
}

export function saveTokens(patch: {
  githubPat?: string | null
  deepseekKey?: string | null
  openaiKey?: string | null
  anthropicKey?: string | null
  geminiKey?: string | null
}): void {
  // Validate all first (atomic — throw before writing anything)
  const update: Partial<Settings> = {}
  if ('githubPat' in patch) update.githubPat = validateToken('githubPat', patch.githubPat ?? null)
  if ('deepseekKey' in patch) update.deepseekKey = validateToken('deepseekKey', patch.deepseekKey ?? null)
  if ('openaiKey' in patch) update.openaiKey = validateToken('openaiKey', patch.openaiKey ?? null)
  if ('anthropicKey' in patch) update.anthropicKey = validateToken('anthropicKey', patch.anthropicKey ?? null)
  if ('geminiKey' in patch) update.geminiKey = validateToken('geminiKey', patch.geminiKey ?? null)

  // Sync githubAuth with githubPat changes — but preserve OAuth tokens:
  // clearing the PAT field while signed in via OAuth must not wipe the OAuth token.
  if ('githubPat' in update) {
    if (update.githubPat) {
      // Explicit non-empty PAT write → switch to PAT method
      update.githubAuth = { token: update.githubPat, method: 'pat', scopes: [] }
    } else {
      // githubPat cleared — only wipe githubAuth if the current method is 'pat' (or null)
      const currentMethod = getSettings().githubAuth?.method
      if (currentMethod !== 'oauth') {
        update.githubAuth = null
      }
      // If method === 'oauth', githubAuth is intentionally left untouched
    }
  }

  save(update)
  if ('githubPat' in update) notifyAuthMutated()
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
  notifyAuthMutated()
}

export const setGithubPat = (v: string | null) => saveTokens({ githubPat: v })
export const setDeepseekKey = (v: string | null) => saveTokens({ deepseekKey: v })
export const setOpenaiKey = (v: string | null) => saveTokens({ openaiKey: v })
export const setAnthropicKey = (v: string | null) => saveTokens({ anthropicKey: v })
export const setGeminiKey = (v: string | null) => saveTokens({ geminiKey: v })
export const setAiProvider = (v: AiProvider) => save({ aiProvider: v })
export const setAiModel = (v: string) => save({ aiModel: v })
export const setDiffMode = (mode: DiffMode) => save({ diffMode: mode })
export const setRailCollapsed = (collapsed: boolean) => save({ railCollapsed: collapsed })
export const setTheme = (theme: Theme) => save({ theme })
export const setUiFont = (font: UiFont) => save({ uiFont: font })
export const setShowProgress = (show: boolean) => save({ showProgress: show })
export const setTreeOpen = (open: boolean) => save({ treeOpen: open })
export const setTestFileDisplay = (v: TestFileDisplay) => save({ testFileDisplay: v })
export const setDiffWidth = (v: DiffWidth) => save({ diffWidth: v })

/**
 * Normalize a GitLab host input.
 * Accepts a bare hostname (e.g. "gitlab.mycompany.com") or a full origin
 * (e.g. "https://gitlab.mycompany.com") and returns just the hostname.
 * Returns null for invalid inputs.
 */
function normalizeGitlabHost(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // Try as a full URL first (origin form)
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
    const hostname = url.hostname
    // Basic hostname validation: must contain at least one dot or be a valid local name
    if (!hostname || hostname.includes(' ')) return null
    return hostname
  } catch {
    return null
  }
}

/**
 * Save the GitLab host (for self-hosted instances).
 * Accepts a bare hostname ("gitlab.mycompany.com") or an origin ("https://gitlab.mycompany.com").
 * Normalizes to hostname only. Throws on invalid or empty input.
 * Default is 'gitlab.com'.
 */
export function setGitlabHost(v: string): void {
  const normalized = normalizeGitlabHost(v)
  if (!normalized) throw new Error('gitlabHost must be a valid hostname or origin')
  save({ gitlabHost: normalized })
}

/**
 * Save a GitLab OAuth token bundle (distinct from the PAT).
 * Pass null to clear (e.g. after refresh failure).
 * No notifications needed beyond settings mutation — callers re-read settings.
 */
export function saveGitlabOAuth(auth: GitlabOAuth | null): void {
  save({ gitlabOAuth: auth })
}

/**
 * Save the GitLab personal access token (PAT).
 * Pass null to clear. Trims whitespace; throws on empty string.
 * Required scope: api
 */
export function setGitlabToken(v: string | null): void {
  if (v === null) {
    save({ gitlabToken: null })
    return
  }
  const trimmed = v.trim()
  if (!trimmed) throw new Error('gitlabToken must not be empty')
  save({ gitlabToken: trimmed })
}

/**
 * Atomically validate and save Bitbucket credentials.
 * Both email and token must be non-empty strings, or both must be null (to clear).
 * Throws before writing if either field is invalid.
 */
export function saveBitbucketAuth(auth: BitbucketAuth | null): void {
  if (auth !== null) {
    const email = auth.email.trim()
    const token = auth.token.trim()
    if (!email) throw new Error('bitbucketAuth.email must not be empty')
    if (!token) throw new Error('bitbucketAuth.token must not be empty')
    save({ bitbucketAuth: { email, token } })
  } else {
    save({ bitbucketAuth: null })
  }
}
