import { getProvider } from '../llm/providers'

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
/**
 * Focus mode — visually DIM (never hide/collapse) low-signal lines in the diff.
 * 'off'             — no dimming.
 * 'imports'         — dim import/use/require lines only (DEFAULT).
 * 'imports-comments'— dim import lines AND comment lines.
 */
export type FocusMode = 'off' | 'imports' | 'imports-comments'

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

/**
 * Emergent fusion mode (Plan P). Derived from the panel's generator count — it
 * is NOT a stored setting any longer. Kept as a type for the analytics label and
 * the migration of the legacy `fusionMode` field.
 * - 'verify'   — exactly 1 generator: it raises, the rest verify (precision).
 * - 'generate' — ≥2 generators: every generator raises, the union is dedup-merged
 *                and cross-confirmed (recall).
 */
export type FusionMode = 'verify' | 'generate'

/** A participant role in the unified model panel (Plan P). */
export type ParticipantRole = 'generator' | 'verifier'

/** One participant in the unified model panel (Plan P). */
export interface PanelParticipant {
  provider: AiProvider
  /** Model id within that provider's lineup (providers.ts). */
  model: string
  /** Whether this participant GENERATES findings or only VERIFIES them. */
  role: ParticipantRole
}

/**
 * The unified model panel (Plan P) — REPLACES both `aiEnsemble` and `fusionMode`.
 * A single list of participants, each tagged generator or verifier. The
 * verify-vs-generate MODE is emergent: exactly 1 generator behaves like the old
 * 'verify', ≥2 generators like the old 'generate', a mix runs both roles.
 * Participants MAY repeat a provider with different models (single-key
 * cross-verify). Invariant: at least one generator (enforced in coercion).
 * null/absent → the default panel is synthesized at resolution time.
 */
export interface AiPanel {
  participants: PanelParticipant[]
}

/** Legacy ensemble participant (Plan N) — read only for migration. */
interface LegacyEnsembleParticipant {
  provider: AiProvider
  model: string
}
/** Legacy ensemble shape (Plan N) — read only for migration into AiPanel. */
interface LegacyAiEnsemble {
  generator: LegacyEnsembleParticipant
  verifiers: LegacyEnsembleParticipant[]
}

/**
 * Per-task AI run mode (Plan J).
 * - 'off'      — task never runs: no LLM call, no context pack/fetch, no cache
 *                read. Spends zero tokens. UI shows a compact "disabled" state.
 * - 'standard' — single-pass run (today's non-deep path).
 * - 'deep'     — agentic harness run (today's deep path); only for tasks that
 *                support tools, and only when the active model can call tools.
 */
export type AiTaskMode = 'off' | 'standard' | 'deep'

/**
 * The user-controllable AI tasks (Plan J). The six AUTO tasks that run on PR
 * open, plus `skills` (manual Run-my-reviewers — deep makes it the most
 * expensive). `coach`, `ask`, and `story` are NOT user-controlled here.
 */
export type AiTaskId =
  | 'summary'
  | 'attention'
  | 'diagrams'
  | 'tests'
  | 'alternatives'
  | 'verdict'
  | 'skills'

/** All controllable task ids, in display order. */
export const AI_TASK_IDS: readonly AiTaskId[] = [
  'summary',
  'attention',
  'diagrams',
  'tests',
  'alternatives',
  'verdict',
  'skills',
] as const

/**
 * Tasks that support the deep (agentic) harness. `summary` is pure description
 * (no harness) so it only supports off/standard — 'deep' is never valid for it.
 */
export const DEEP_CAPABLE_TASKS: readonly AiTaskId[] = [
  'attention',
  'diagrams',
  'tests',
  'alternatives',
  'verdict',
  'skills',
] as const

/** Whether a task supports 'deep'. (Everything except `summary`.) */
export function taskSupportsDeep(task: AiTaskId): boolean {
  return task !== 'summary'
}

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
  /**
   * Deep review (agentic) — lets the AI read extra files / search the repo
   * before flagging findings. Opt-in: slower and uses more tokens (Plan G).
   */
  aiDeepReview: boolean
  /**
   * Per-task AI run modes (Plan J). The source of truth for whether/how-deep
   * each controllable task runs. Defaults to all 'standard' (byte-identical to
   * legacy aiDeepReview=false). Legacy aiDeepReview=true migrates the
   * deep-capable tasks to 'deep' once, on first load — after that this matrix
   * is authoritative and aiDeepReview is no longer read for run decisions.
   */
  aiTaskModes: Record<AiTaskId, AiTaskMode>
  /**
   * Story mode (Plan H): in step 2, lead with the guided NARRATIVE walkthrough
   * instead of the all-files diff. Requires an LLM key (a classification task);
   * unavailable + ignored when no key is configured. Default true so users with
   * a key get the narrative first; flipping to Files in-step persists false.
   */
  storyMode: boolean
  /**
   * Auto-start the skill reviewers early (opt-OUT, default ON). When true, the
   * reviewers kick off as soon as a PR loads — while the user is still on the
   * Understand step — so findings are ready by the Inspect step. Failed
   * reviewers retry automatically (up to 3×). Flipping it off restores the
   * manual "Run my reviewers" button as the only trigger.
   */
  autoRunReviewers: boolean
  /**
   * Cross-model verification (Plan M): after the active model generates review
   * findings, the user's OTHER configured providers independently judge each
   * one; only findings that survive cross-model agreement are surfaced, the rest
   * are demoted into a "lower confidence" group. Default TRUE, but EFFECTIVE only
   * when ≥2 providers have keys (active + ≥1 other) — with 0–1 keys it is a
   * strict no-op (no extra calls, no UI), so single-key users are unaffected.
   */
  crossModelVerify: boolean
  /**
   * Unified model panel (Plan P) — REPLACES aiEnsemble + fusionMode. A single
   * participant list with per-row roles (generator/verifier). When null/absent,
   * the default panel is synthesized from the active provider+model (sole
   * generator) plus the other keyed providers' default models (verifiers) —
   * byte-identical to #128/#130. When set, the user has hand-picked the
   * participants and their roles; the verify-vs-generate mode is emergent from
   * the generator count. Participants MAY repeat a provider with different models
   * (single-key cross-verify). Migrated once from legacy aiEnsemble + fusionMode.
   */
  aiPanel: AiPanel | null
  diffMode: DiffMode
  /** Hide whitespace-only changes in diffs (like GitHub's ?w=1). */
  hideWhitespace: boolean
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
  /** Focus mode: dim imports / imports+comments to reduce diff noise. */
  focusMode: FocusMode
  /**
   * Power-user: show approximate token usage (and a rough $ estimate when
   * per-model pricing is known) per AI section + a per-review total. Display
   * only — derived from usage the LLM layer already captures; sends nothing
   * new. Default OFF: toggling off is byte-identical to the prior UI.
   */
  showTokenCost: boolean
}

/** Default task-mode matrix: every task 'standard' (today's behavior). */
export function defaultTaskModes(): Record<AiTaskId, AiTaskMode> {
  return {
    summary: 'standard',
    attention: 'standard',
    diagrams: 'standard',
    tests: 'standard',
    alternatives: 'standard',
    verdict: 'standard',
    skills: 'standard',
  }
}

/** The all-deep matrix that reproduces legacy aiDeepReview=true. */
export function allDeepTaskModes(): Record<AiTaskId, AiTaskMode> {
  const modes = defaultTaskModes()
  for (const t of DEEP_CAPABLE_TASKS) modes[t] = 'deep'
  return modes
}

const DEFAULTS: Settings = {
  githubPat: null,
  deepseekKey: null,
  aiProvider: 'deepseek',
  aiModel: '',
  openaiKey: null,
  anthropicKey: null,
  geminiKey: null,
  aiDeepReview: false,
  aiTaskModes: defaultTaskModes(),
  storyMode: true,
  autoRunReviewers: true,
  crossModelVerify: true,
  aiPanel: null,
  diffMode: 'unified',
  hideWhitespace: false,
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
  // Non-destructive dimming of imports is our recommendation → on by default.
  focusMode: 'imports',
  showTokenCost: false,
}

const AI_PROVIDER_IDS = new Set<string>(['deepseek', 'openai', 'anthropic', 'gemini'])

/** Coerce a provider+model pair; returns null if either is invalid. */
function coerceProviderModel(raw: unknown): { provider: AiProvider; model: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const provider = obj['provider']
  const model = obj['model']
  if (typeof provider !== 'string' || !AI_PROVIDER_IDS.has(provider)) return null
  const prov = getProvider(provider as AiProvider)
  if (!prov) return null
  if (typeof model !== 'string' || !prov.models.some((m) => m.id === model)) return null
  return { provider: provider as AiProvider, model }
}

/** Coerce one panel participant (provider+model+role); null when invalid. */
function coercePanelParticipant(raw: unknown): PanelParticipant | null {
  const pm = coerceProviderModel(raw)
  if (!pm) return null
  const role = (raw as Record<string, unknown>)['role']
  if (role !== 'generator' && role !== 'verifier') return null
  return { provider: pm.provider, model: pm.model, role }
}

/** Coerce one legacy ensemble participant (provider+model only). */
function coerceLegacyParticipant(raw: unknown): LegacyEnsembleParticipant | null {
  return coerceProviderModel(raw)
}

/**
 * Coerce a stored unified panel (Plan P). Drops invalid participants. Enforces
 * the ≥1-generator invariant: if no participant is a generator, the FIRST one is
 * promoted to generator. Returns null when absent/empty (→ default panel
 * synthesized at resolution time).
 */
function coercePanel(raw: unknown): AiPanel | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const rawList = obj['participants']
  if (!Array.isArray(rawList)) return null
  const participants = rawList
    .map(coercePanelParticipant)
    .filter((p): p is PanelParticipant => p !== null)
  if (participants.length === 0) return null
  // Invariant: at least one generator. Promote the first row if none qualifies.
  if (!participants.some((p) => p.role === 'generator')) {
    participants[0] = { ...participants[0], role: 'generator' }
  }
  return { participants }
}

/**
 * Coerce a stored LEGACY aiEnsemble (Plan N) for one-time migration into a panel.
 * Returns null when absent/invalid; an invalid generator invalidates the whole.
 */
function coerceLegacyEnsemble(raw: unknown): LegacyAiEnsemble | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const generator = coerceLegacyParticipant(obj['generator'])
  if (!generator) return null
  const verifiers = Array.isArray(obj['verifiers'])
    ? obj['verifiers'].map(coerceLegacyParticipant).filter((p): p is LegacyEnsembleParticipant => p !== null)
    : []
  return { generator, verifiers }
}

/**
 * Resolve the unified panel from stored settings, MIGRATING the legacy
 * aiEnsemble + fusionMode once when no aiPanel is stored (Plan P):
 * - explicit aiPanel wins (coerced).
 * - else legacy aiEnsemble present → generator → {role:'generator'}, verifiers →
 *   {role:'verifier'}; if legacy fusionMode==='generate', ALL roles become
 *   'generator' (every model generated).
 * - else (default/unset) → null (default panel synthesized at resolution time).
 */
function coercePanelWithMigration(obj: Record<string, unknown>): AiPanel | null {
  if ('aiPanel' in obj) return coercePanel(obj['aiPanel'])
  // No aiPanel — migrate legacy ensemble + fusionMode if present.
  const legacy = coerceLegacyEnsemble(obj['aiEnsemble'])
  if (!legacy) return null // default/unset → default panel synthesized later
  const generateMode = obj['fusionMode'] === 'generate'
  const participants: PanelParticipant[] = [
    { provider: legacy.generator.provider, model: legacy.generator.model, role: 'generator' },
    ...legacy.verifiers.map((v): PanelParticipant => ({
      provider: v.provider,
      model: v.model,
      role: generateMode ? 'generator' : 'verifier',
    })),
  ]
  return { participants }
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

/** A valid mode string for a given task (summary may not be 'deep'). */
function isValidModeFor(task: AiTaskId, mode: unknown): mode is AiTaskMode {
  if (mode !== 'off' && mode !== 'standard' && mode !== 'deep') return false
  if (mode === 'deep' && !taskSupportsDeep(task)) return false
  return true
}

/**
 * Coerce + migrate the per-task mode matrix (Plan J).
 * - Explicit stored aiTaskModes wins (per-key validated, merged over defaults).
 * - No stored aiTaskModes but legacy aiDeepReview===true → deep-capable tasks
 *   become 'deep' (one-time migration of the old global toggle).
 * - Otherwise → defaults (all 'standard').
 */
function coerceTaskModes(obj: Record<string, unknown>): Record<AiTaskId, AiTaskMode> {
  const raw = obj['aiTaskModes']
  if (typeof raw === 'object' && raw !== null) {
    const src = raw as Record<string, unknown>
    const result = defaultTaskModes()
    for (const task of AI_TASK_IDS) {
      const m = src[task]
      if (isValidModeFor(task, m)) result[task] = m
      // summary='deep' (invalid) falls back to the default 'standard'
    }
    return result
  }
  // No explicit matrix — migrate the legacy global toggle once.
  if (obj['aiDeepReview'] === true) return allDeepTaskModes()
  return defaultTaskModes()
}

function coerce(raw: unknown): Partial<Settings> {
  if (typeof raw !== 'object' || raw === null) return {}
  const obj = raw as Record<string, unknown>
  const result: Partial<Settings> = {}

  const diffMode = obj['diffMode']
  if (diffMode === 'unified' || diffMode === 'split') result.diffMode = diffMode

  const hideWhitespace = obj['hideWhitespace']
  if (typeof hideWhitespace === 'boolean') result.hideWhitespace = hideWhitespace

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

  const aiDeepReview = obj['aiDeepReview']
  if (typeof aiDeepReview === 'boolean') result.aiDeepReview = aiDeepReview

  // Per-task mode matrix (Plan J) — coerced + migrated from legacy toggle.
  result.aiTaskModes = coerceTaskModes(obj)

  const storyMode = obj['storyMode']
  if (typeof storyMode === 'boolean') result.storyMode = storyMode

  const autoRunReviewers = obj['autoRunReviewers']
  if (typeof autoRunReviewers === 'boolean') result.autoRunReviewers = autoRunReviewers

  const crossModelVerify = obj['crossModelVerify']
  if (typeof crossModelVerify === 'boolean') result.crossModelVerify = crossModelVerify

  // Unified model panel (Plan P) — explicit aiPanel, or one-time migration from
  // legacy aiEnsemble + fusionMode. Only assign when there is something to store
  // (a non-null panel); default/unset stays null so the default panel is
  // synthesized at resolution time.
  if ('aiPanel' in obj || 'aiEnsemble' in obj) {
    const panel = coercePanelWithMigration(obj)
    if (panel) result.aiPanel = panel
  }

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

  const focusMode = obj['focusMode']
  if (focusMode === 'off' || focusMode === 'imports' || focusMode === 'imports-comments') {
    result.focusMode = focusMode
  }
  const showTokenCost = obj['showTokenCost']
  if (typeof showTokenCost === 'boolean') result.showTokenCost = showTokenCost

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

// ---------------------------------------------------------------------------
// Key/token character validation (shared by every key/token save path)
//
// Keys end up in HTTP headers (Authorization, x-api-key, …) where fetch
// requires ISO-8859-1; a smuggled character like an EM DASH (U+2014) from a
// styled copy-paste makes fetch throw a raw DOMException/TypeError at request
// time. Reject such keys AT SAVE TIME with a human message instead.
// ---------------------------------------------------------------------------

export interface InvalidKeyChar {
  /** The offending character (full code point). */
  char: string
  codePoint: number
  /** 0-based index within the (trimmed) value. */
  index: number
}

/**
 * Find the first character that cannot travel in an HTTP header value:
 * anything outside ISO-8859-1 (> U+00FF) or a control character.
 * Returns null when the value is clean.
 */
export function findInvalidKeyChar(value: string): InvalidKeyChar | null {
  for (let i = 0; i < value.length; i++) {
    const codePoint = value.codePointAt(i)!
    if (codePoint > 0xff || codePoint < 0x20 || codePoint === 0x7f) {
      return { char: String.fromCodePoint(codePoint), codePoint, index: i }
    }
    if (codePoint > 0xffff) i++ // skip the low surrogate of an astral pair
  }
  return null
}

/** Human message for an invalid key character, naming the char and position. */
export function invalidKeyCharMessage(bad: InvalidKeyChar): string {
  const hex = bad.codePoint.toString(16).toUpperCase().padStart(4, '0')
  // Control characters have no printable form — show only the code point.
  const display =
    bad.codePoint < 0x20 || bad.codePoint === 0x7f ? `U+${hex}` : `"${bad.char}" (U+${hex})`
  return `Key contains an invalid character (${display} at position ${bad.index + 1}) — re-copy it from the provider.`
}

/**
 * Shared validator for every key/token field: trims whitespace, rejects
 * empty strings and characters that cannot be sent in an HTTP header.
 */
function validateKeyValue(value: string, emptyMessage: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(emptyMessage)
  const bad = findInvalidKeyChar(trimmed)
  if (bad) throw new Error(invalidKeyCharMessage(bad))
  return trimmed
}

function validateToken(field: 'githubPat' | 'deepseekKey' | 'openaiKey' | 'anthropicKey' | 'geminiKey', value: string | null): string | null {
  if (value === null) return null
  return validateKeyValue(value, `${field} must not be empty`)
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
export const setAiDeepReview = (v: boolean) => save({ aiDeepReview: v })

/**
 * Set the run mode for one task (Plan J). Invalid combinations (e.g.
 * summary='deep') are coerced to 'standard' before saving. Applies immediately
 * (reactive via settingsState), like the other AI-models controls.
 */
export function setAiTaskMode(task: AiTaskId, mode: AiTaskMode): void {
  const safe: AiTaskMode = isValidModeFor(task, mode) ? mode : 'standard'
  const next = { ...getSettings().aiTaskModes, [task]: safe }
  save({ aiTaskModes: next })
}

/** Replace the whole task-mode matrix at once (quick-set rows). */
export function setAiTaskModes(modes: Record<AiTaskId, AiTaskMode>): void {
  const next = { ...defaultTaskModes() }
  for (const task of AI_TASK_IDS) {
    if (isValidModeFor(task, modes[task])) next[task] = modes[task]
  }
  save({ aiTaskModes: next })
}

/** Quick-set: all deep-capable tasks deep, summary standard (legacy All). */
export const setAllTasksDeep = () => save({ aiTaskModes: allDeepTaskModes() })
/** Quick-set: every task standard (legacy None). */
export const setAllTasksStandard = () => save({ aiTaskModes: defaultTaskModes() })
/**
 * Quick-set: keep summary + verdict on, turn the rest off (minimal tokens).
 */
export function setOffAllExtras(): void {
  const modes = defaultTaskModes()
  for (const task of AI_TASK_IDS) {
    if (task !== 'summary' && task !== 'verdict') modes[task] = 'off'
  }
  save({ aiTaskModes: modes })
}
export const setStoryMode = (v: boolean) => save({ storyMode: v })
export const setAutoRunReviewers = (v: boolean) => save({ autoRunReviewers: v })
export const setCrossModelVerify = (v: boolean) => save({ crossModelVerify: v })

/**
 * Save the unified model panel (Plan P). Pass null to reset to the synthesized
 * default. Enforces the ≥1-generator invariant before writing: if the supplied
 * list has no generator, the first participant is promoted (defensive — the UI
 * also guards this).
 */
export function setAiPanel(panel: AiPanel | null): void {
  if (panel === null) {
    save({ aiPanel: null })
    return
  }
  const participants = panel.participants.map((p) => ({ ...p }))
  if (participants.length > 0 && !participants.some((p) => p.role === 'generator')) {
    participants[0] = { ...participants[0], role: 'generator' }
  }
  save({ aiPanel: { participants } })
}

/**
 * Preset "One generator" (Plan P): the FIRST participant becomes the sole
 * generator, every other participant a verifier (= old 'verify' mode). Operates
 * on the supplied participant list (the editor passes its current/synthesized
 * panel so it works even before the user has stored a custom panel).
 */
export function setPanelOneGenerator(participants: PanelParticipant[]): void {
  if (participants.length === 0) return
  const next = participants.map((p, i) => ({ ...p, role: (i === 0 ? 'generator' : 'verifier') as ParticipantRole }))
  save({ aiPanel: { participants: next } })
}

/**
 * Preset "All generate" (Plan P): every participant becomes a generator — they
 * cross-confirm each other (= old 'generate' mode). Operates on the supplied
 * participant list (see setPanelOneGenerator).
 */
export function setPanelAllGenerate(participants: PanelParticipant[]): void {
  if (participants.length === 0) return
  const next = participants.map((p) => ({ ...p, role: 'generator' as ParticipantRole }))
  save({ aiPanel: { participants: next } })
}
export const setDiffMode = (mode: DiffMode) => save({ diffMode: mode })
export const setHideWhitespace = (hide: boolean) => save({ hideWhitespace: hide })
export const setRailCollapsed = (collapsed: boolean) => save({ railCollapsed: collapsed })
export const setTheme = (theme: Theme) => save({ theme })
export const setUiFont = (font: UiFont) => save({ uiFont: font })
export const setShowProgress = (show: boolean) => save({ showProgress: show })
export const setTreeOpen = (open: boolean) => save({ treeOpen: open })
export const setTestFileDisplay = (v: TestFileDisplay) => save({ testFileDisplay: v })
export const setDiffWidth = (v: DiffWidth) => save({ diffWidth: v })
export const setFocusMode = (v: FocusMode) => save({ focusMode: v })
export const setShowTokenCost = (v: boolean) => save({ showTokenCost: v })

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
  save({ gitlabToken: validateKeyValue(v, 'gitlabToken must not be empty') })
}

/**
 * Atomically validate and save Bitbucket credentials.
 * Both email and token must be non-empty strings, or both must be null (to clear).
 * Throws before writing if either field is invalid.
 */
export function saveBitbucketAuth(auth: BitbucketAuth | null): void {
  if (auth !== null) {
    // Both travel in the Basic auth header (btoa rejects > U+00FF too),
    // so both get the shared character validation.
    const email = validateKeyValue(auth.email, 'bitbucketAuth.email must not be empty')
    const token = validateKeyValue(auth.token, 'bitbucketAuth.token must not be empty')
    save({ bitbucketAuth: { email, token } })
  } else {
    save({ bitbucketAuth: null })
  }
}
