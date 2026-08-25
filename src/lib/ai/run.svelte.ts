/**
 * src/lib/ai/run.svelte.ts — AI orchestration layer (Task 8)
 *
 * Coordinates consent → context packing → parallel four-task execution with
 * per-task cache, streaming for summary, error isolation, analytics, and retry.
 *
 * DI pattern mirrors createPrLoad (loadPr.svelte.ts): deps is an optional
 * object of functions with real implementations as defaults, allowing tests to
 * stub any combination without module-level mocking.
 */

import { activeLlmConfig, activeProviderHasKey, crossModelVerifyEffective, verifierProviderConfigs, resolveEnsemble, fusionGenerateEffective, fusionParticipants, fusionGenerators, type FusionParticipant } from '../llm/config'
import { estimateTokens } from '../context/pack'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import {
  llmStream as defaultLlmStream,
  llmStreamWithUsage as defaultLlmStreamWithUsage,
  llmJsonWithRepair as defaultLlmJsonWithRepair,
  llmJsonWithRepairWithUsage as defaultLlmJsonWithRepairWithUsage,
  llmJsonWithRepairFor as defaultLlmJsonWithRepairFor,
  LlmError,
} from '../llm/llm'
import type { LlmUsage, ProviderConfig } from '../llm/llm'
import { isTransientLlmError } from '../llm/transientRetry'
import {
  crossVerify,
  buildVerifyPrompt,
  validateVerifierResponse,
  mergeGeneratorFindings,
  fuseConfirm,
  classifyClaim,
  type VerifiableFinding,
  type VerifyFn,
  type ToolCheckFn,
  type ParticipantUsage,
  type VerifierImpact,
  type GeneratorFindings,
} from './crossVerify'
import { getProvider, modelSupportsTools } from '../llm/providers'
import { llmToolLoop as defaultLlmToolLoop } from '../llm/llmToolLoop'
import {
  createDeepReviewToolkit,
  createDeepReviewCache,
  resolveTaskMode,
  DEEP_REVIEW_MAX_TOOL_CALLS,
} from './deepReview'
import type { DeepReviewSource } from './deepReview'
import { getSettings, type AiTaskId } from '../settings/settings'
import {
  cacheKey,
  getCached as defaultGetCached,
  setCached as defaultSetCached,
} from '../cache/aiCache'
import { gateAi as defaultGateAi } from '../consent/consent'
import { track as defaultTrack } from '../analytics/analytics'
import {
  promptVersionFor,
  summarizePrompt,
  attentionPrompt,
  diagramsPrompt,
  verdictPrompt,
  riskJudgePrompt,
  testInsightPrompt,
  coachPrompt,
  alternativesPrompt,
  storyOrderPrompt,
  intentPrompt,
  hasMeaningfulIntent,
  askPrompt,
  expandCommentPrompt,
  skillReviewPrompt,
  convergencePrompt,
  simplifyPrompt,
  withDeepReviewGuidance,
  type AskFocus,
} from './tasks'
import {
  enumerateFindings,
  enumerateDrafts,
  validateConvergence,
  toAppliedClusters,
  applyConvergence,
  type ConvergenceValue,
  type ReviewerFindings,
} from './convergence'
import {
  enumerateForSimplify,
  validateSimplify,
  type SimplifyValue,
} from './simplify'
export type { ConvergenceValue }
export type { SimplifyValue }
export type { AskFocus }
import { validateAttention, validateVerdict, validateRiskJudge, validateGraphResult, validateTestInsight, validateCoachResult, validateAlternativesResult, salvageAlternativesResult, validateStoryOrder, validateSkillReviewResult, salvageStoryOrder, dedupeStorySteps, sinkGeneratedSteps, STORY_MAX_STEPS, validateIntentCheck, salvageIntentCheck } from './schemas'
import { buildDeterministicStory } from './storyFallback'
import { matchStoryPath } from './schemas'
import type { AttentionResult, VerdictResult, RiskJudgeResult, GraphResult, TestInsight, CoachResult, AlternativesResult, StoryOrderResult, SkillReviewResult, IntentCheckResult } from './schemas'
import type { Draft } from '../drafts/drafts.svelte'
import type { CoachCodeContext } from './coachContext'
import {
  chunk,
  mergeChunkOutcomes,
  mapWithConcurrency,
  COACH_CHUNK_SIZE,
  COACH_CHUNK_CONCURRENCY,
  REVIEWER_CONCURRENCY,
  type ChunkOutcome,
} from './coachBatch'
import { listSkills } from '../skills/skills'
import { djb2 } from '../viewed/viewed.svelte'
import { addUsage } from './tokenCost'
import { aggregateModelPerformance } from './modelPerformance'
import { buildModelCostBreakdown, type CostContribution, type ModelCostRow } from './modelCostBreakdown'

// ---------------------------------------------------------------------------
// PanelState union
// ---------------------------------------------------------------------------

export type PanelStatus =
  | 'idle'
  | 'no-key'
  | 'declined'
  /**
   * Reviewer queue: waiting for a concurrency slot before the LLM call starts.
   * Reviewers are dispatched at most REVIEWER_CONCURRENCY at a time; the rest
   * sit in this state until a slot frees, then flip to 'loading'.
   */
  | 'queued'
  | 'loading'
  | 'streaming'
  | 'done'
  | 'error'
  /**
   * Plan J: the task is turned OFF in AI settings (aiTaskModes[task] === 'off').
   * No LLM call, no context, no cache — zero tokens. The UI renders a compact
   * muted "Disabled — enable in AI settings" state (never a skeleton/spinner).
   */
  | 'disabled'
  /**
   * Intent check only: the task had NOTHING to check — the PR description is
   * null/blank/template-noise-only (no meaningful stated intent), so the task
   * deliberately did not run. Zero tokens, no cache, no error. Distinct from
   * 'disabled' (a user setting) so the panel can render the calm
   * "No stated intent to check — the PR description is empty." state.
   */
  | 'skipped'

export interface PanelState<T> {
  status: PanelStatus
  value?: T | string
  error?: string
  /**
   * The CONCRETE upstream failure detail (provider error body / thrown
   * message) behind the canned `error` sentence — composed by
   * describeTaskError. Surfaced on hover (title/tooltip) wherever an error
   * indicator renders, so "server error" is diagnosable without DevTools.
   * Absent when the raw message added nothing beyond `error`.
   */
  errorDetail?: string
  /** Deep review: humanized tool-activity lines, present while the loop runs. */
  activity?: string[]
  /** Deep review: tool calls used by the run ("verified with N tool calls"). */
  toolCallsUsed?: number
  /** Honest UI note (e.g. deep review fell back to single-pass). */
  note?: string
  /**
   * Token usage for this task, when the transport captured it. Surfaced ONLY
   * by the opt-in showTokenCost footer; absent on cached results that predate
   * usage capture (footer then shows nothing for that task — never fabricated).
   */
  usage?: LlmUsage
  /**
   * Per-model cost + impact breakdown (Plan N) — populated for SKILL reviews
   * whose cross-verify pass ran with an ensemble of >1 model. Generator row
   * first, then one row per responding verifier. Empty/absent for single-model
   * runs (the plain aggregate usage footer is shown instead). Display-only.
   */
  models?: VerdictModelBreakdown[]
  /**
   * Story task only (robust big-PR story): true when `value` is the DETERMINISTIC
   * structural walkthrough built without an LLM — the graceful degrade used when
   * the AI story call failed OR returned an unusable result. The status is still
   * 'done' (the fallback IS a usable story) so Story mode renders rather than
   * showing the old hard-error state. `fallbackReason` carries the concrete cause
   * for the UI's muted note. Absent on a successful AI story result.
   */
  fallback?: boolean
  /** Story fallback only: the specific reason the AI ordering was unavailable. */
  fallbackReason?: string
}

// ---------------------------------------------------------------------------
// Per-model cost + impact for step 3 (Plan N)
// ---------------------------------------------------------------------------

/**
 * One participant's contribution to the current review's verdict cross-verify
 * pass. `usage` drives the per-model COST table (gated on showTokenCost; absent
 * → tokens-only or omitted). `role`/impact fields drive the IMPACT readout
 * (always shown when cross-verify ran).
 */
export interface VerdictModelBreakdown {
  providerId: string
  modelId: string
  role: 'generator' | 'verifier'
  /** Token usage attributed to this model, when captured. */
  usage?: LlmUsage
  /** Generator: count of its findings that SURVIVED verification (surfaced). */
  surfaced?: number
  /**
   * Generator (Plan O 'generate' mode): of its surfaced findings, how many ONLY
   * this model raised (the recall headline — "caught X the others missed").
   */
  uniqueCatch?: number
  /** Verifier impact (confirms/refutes/uncertains/decisive). */
  impact?: { confirms: number; refutes: number; uncertains: number; decisive: number }
}

// ---------------------------------------------------------------------------
// Task names (used as cache key discriminants + analytics)
// ---------------------------------------------------------------------------

type TaskName = 'summary' | 'attention' | 'diagrams' | 'verdict' | 'tests' | 'alternatives' | 'story' | 'riskJudge' | 'intent'

// ---------------------------------------------------------------------------
// SkillReviewEntry — reactive entry per skill in skillReviews array
// ---------------------------------------------------------------------------

export interface SkillReviewEntry {
  skillId: string
  name: string
  state: PanelState<SkillReviewResult>
}

/**
 * Honest note about comments the coach could NOT grade. The coach batches
 * drafts into chunks (one LLM call each); when SOME chunks fail but others
 * succeed we return the succeeded reviews PLUS this note so the UI can show the
 * partial results and a retry affordance — never silently dropping comments.
 */
export interface CoachNotCoached {
  /** Original draft indices that no chunk successfully coached. */
  indices: number[]
  /** Human-readable reason (mapped from the failed chunk's LlmError kind). */
  message: string
  /**
   * The failing chunk's CONCRETE upstream error detail (describeTaskError
   * composition — same rules as PanelState.errorDetail), for tooltips.
   * Absent when the raw failure added nothing beyond the canned message.
   */
  detail?: string
}

/**
 * Coach success result + the token usage the transport captured for the run
 * (when available). usage is display-only — surfaced behind showTokenCost and
 * folded into the per-PR totalUsage. Absent when the transport reported none.
 * `notCoached` is present only on a PARTIAL run (some chunks failed); it lists
 * the comments that were not graded and why.
 */
export type CoachOutcome = CoachResult & { usage?: LlmUsage; notCoached?: CoachNotCoached }

// ---------------------------------------------------------------------------
// AiRun public interface
// ---------------------------------------------------------------------------

export interface AiRun {
  readonly summary: PanelState<string>
  readonly attention: PanelState<AttentionResult>
  readonly diagrams: PanelState<GraphResult>
  readonly verdict: PanelState<VerdictResult>
  /**
   * LLM risk judge: a single-pass 0–3 judgment of the review attention the
   * change deserves, feeding the deterministic "Review effort" score as ONE
   * factor ("AI judgment"). The deterministic score never blocks on it.
   */
  readonly riskJudge: PanelState<RiskJudgeResult>
  readonly tests: PanelState<TestInsight>
  readonly alternatives: PanelState<AlternativesResult>
  /**
   * Intent-vs-implementation check: reads the PR description as the STATED
   * intent and verifies the diff against it — matched intents (with evidence),
   * unrequested changes, unfulfilled promises. Single-pass on the active model
   * (off|standard). 'skipped' = no meaningful PR description → the task never
   * ran (zero tokens; the panel shows the calm "nothing to check" state).
   */
  readonly intent: PanelState<IntentCheckResult>
  readonly story: PanelState<StoryOrderResult>
  readonly skillReviews: SkillReviewEntry[]
  /**
   * Cross-reviewer finding convergence: one cheap single-pass call after ALL
   * reviewers settle that clusters findings describing the same underlying
   * issue (across reviewers + against the user's drafts). The value carries the
   * validated clusters + a fingerprint of the finding set they were computed
   * for; the UI applies the pure merge itself (applyConvergence), so reviewer
   * entries are NEVER mutated — on failure/skip the originals render unmerged.
   * 'idle' = skipped (<2 reviewers with findings / nothing to converge).
   */
  readonly convergence: PanelState<ConvergenceValue>
  /**
   * Post-review SIMPLIFY pass: one batched single-pass call after the
   * reviewers AND the convergence pass settle that rewrites every (merged)
   * finding body into plain English. The value carries the rewrites + a
   * fingerprint of the finding set they were computed for; the UI applies
   * them itself (applySimplify), so reviewer entries are NEVER mutated — on
   * failure/skip/'off' the original bodies render unchanged.
   * 'idle' = skipped (no findings to rewrite); 'disabled' = task mode off.
   */
  readonly simplify: PanelState<SimplifyValue>
  /**
   * Sum of every task's captured token usage for THIS PR run (the core auto
   * tasks incl. story + risk judge, plus any skill reviews). undefined when no
   * task reported usage.
   * Reset implicitly on PR change: a fresh createAiRun() per PR owns its own
   * panel states. Display-only — consumed by the showTokenCost total.
   */
  readonly totalUsage: LlmUsage | undefined
  /**
   * Per-model cost + impact breakdown for the VERDICT cross-verify pass (Plan N).
   * Empty unless cross-verify actually ran for the verdict this review. Generator
   * row first, then one row per responding verifier model. Display-only.
   */
  readonly verdictModels: VerdictModelBreakdown[]
  /**
   * Consolidated per-model cost + performance for the WHOLE review — the verdict
   * task's generator/verifiers AND every skill reviewer's models, aggregated by
   * (provider, model, role). Drives the Step-3 "Review cost & model performance"
   * panel. Empty when no task recorded per-model data. Display-only.
   */
  readonly modelPerformance: VerdictModelBreakdown[]
  /**
   * Per-model cost breakdown that RECONCILES with totalUsage: one row per
   * (model, role) whose `total` sums ALL its task contributions (the ensemble
   * verdict/reviewer cross-verify rows AND the single-pass tasks that ran on the
   * active model — summary/hotspots/diagrams/tests/alternatives/story/risk-judge/coach).
   * Each row carries a per-task drilldown (`byTask`). Summing every row's
   * `total` equals `totalUsage` — no task's tokens are dropped or double-counted.
   * Drives the Step-3 expandable cost panel. Display-only.
   */
  readonly modelCostBreakdown: ModelCostRow[]
  start(): Promise<void>
  retry(task: TaskName): Promise<void>
  coach(drafts: Draft[], prComments?: string[], verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): Promise<CoachOutcome | { error: string; errorDetail?: string }>
  ask(question: string, onDelta: (t: string) => void, focus?: AskFocus): Promise<{ ok: true; answer: string } | { ok: false; error: string }>
  /**
   * Expand a terse inline-composer note into a proper review comment grounded
   * in the code at the comment's anchor (focus). On-demand, never cached
   * (like ask); streams via onDelta. The UI previews the result — the
   * reviewer's note is never replaced without approval. errorDetail carries
   * the concrete upstream failure for the hover idiom.
   */
  expandComment(note: string, onDelta: (t: string) => void, focus: { path: string; line: number; side: 'LEFT' | 'RIGHT' }): Promise<{ ok: true; comment: string } | { ok: false; error: string; errorDetail?: string }>
  /**
   * Run every enabled skill reviewer (batch). `opts.autoRetry` (default 0) adds
   * up to N extra rounds that re-attempt only the reviewers still in 'error'
   * after the initial pass — used by the early auto-start so transient failures
   * settle without a manual retry click. Omitting opts is byte-identical to the
   * prior behaviour.
   */
  runSkillReviews(onUpdate?: () => void, existingComments?: string[], opts?: { autoRetry?: number }): Promise<void>
  /**
   * Re-run exactly one reviewer by skill id (the error-chip retry). Sets only
   * that reviewer's entry to loading and re-invokes its review through the
   * normal cache-miss path; sibling reviews and drafts are untouched.
   */
  retrySkill(skillId: string, onUpdate?: () => void, existingComments?: string[]): Promise<void>
}

// ---------------------------------------------------------------------------
// createAiRun input
// ---------------------------------------------------------------------------

export interface AiRunInput {
  prKey: string
  repo: string
  isPrivate: boolean | undefined
  /**
   * PR title + body — the STATED intent the intent check verifies the diff
   * against. Optional: when absent (older callers / non-PR contexts) the
   * intent task treats the description as empty and SKIPS itself (zero
   * tokens) rather than erroring.
   */
  meta?: { title: string; body: string | null }
  pack: () => Promise<PackedContext>
  ci: () => Promise<CiSummary | null>
  ask: () => Promise<boolean>
  /**
   * Deep-review tool source (Plan G part 2). When present AND the
   * aiDeepReview setting is on AND the active model supports tool calling,
   * the verdict + skill-review tasks run through the agentic tool loop.
   * Absent / toggle off → behavior is byte-identical to single-pass.
   */
  deepReview?: DeepReviewSource
  /**
   * Build per-comment CODE context for the coach (v16). Supplied by the
   * caller, which owns the PR files (patches) and fetched file contents.
   * For each draft it returns the code at that comment's file:line — a hunk
   * excerpt plus an optional wider file window — so the coach can VERIFY
   * accuracy/grounded/specificity against real code instead of defaulting to
   * "cannot verify against the diff". Absent → coach runs without it (prior
   * behaviour). Best-effort: throwing is treated as "no context".
   */
  coachCodeContext?: (drafts: Draft[]) => CoachCodeContext[]
  /**
   * Build per-finding CODE context for cross-model verification (Plan M).
   * Given a list of {path, line, side} anchors it returns the code at each
   * (a hunk excerpt + optional wider file window) so verifier models judge
   * findings against real code. Same source as coachCodeContext (the caller
   * owns PR files + fetched contents). Absent → verification runs with whatever
   * excerpt is derivable from the packed context only. Best-effort.
   */
  verifyCodeContext?: (anchors: { path: string; line: number; side: 'LEFT' | 'RIGHT' }[]) => CoachCodeContext[]
  /**
   * The user's CURRENT draft comments (finding convergence). Read once when the
   * convergence pass runs, so findings that make the same point as an existing
   * draft can be marked "covered by your comment" instead of duplicating it.
   * Absent → the pass runs with no drafts (cross-reviewer clustering only).
   */
  drafts?: () => Draft[]
}

// ---------------------------------------------------------------------------
// DI dependencies (real implementations as defaults)
// ---------------------------------------------------------------------------

interface AiRunDeps {
  llmStream: typeof defaultLlmStream
  llmStreamWithUsage: typeof defaultLlmStreamWithUsage
  llmJsonWithRepair: typeof defaultLlmJsonWithRepair
  llmJsonWithRepairWithUsage: typeof defaultLlmJsonWithRepairWithUsage
  llmJsonWithRepairFor: typeof defaultLlmJsonWithRepairFor
  llmToolLoop: typeof defaultLlmToolLoop
  getCached: typeof defaultGetCached
  setCached: typeof defaultSetCached
  gateAi: typeof defaultGateAi
  track: typeof defaultTrack
}

// ---------------------------------------------------------------------------
// Human-readable error messages per LlmError kind
// ---------------------------------------------------------------------------

function humanMessage(kind: string): string {
  // Name the ACTIVE provider (Plan F) — not hardwired to DeepSeek.
  const provider = activeLlmConfig().provider.displayName
  switch (kind) {
    case 'no-key': return `No ${provider} API key configured.`
    case 'auth': return `API key was rejected. Please check your ${provider} key in Settings.`
    case 'rate-limited': return `Rate limited by ${provider}. Please try again in a moment.`
    case 'server': return `${provider} server error. Please try again later.`
    case 'network': return `Network error reaching ${provider}. Check your connection.`
    case 'timeout': return `Request to ${provider} timed out. Please try again.`
    case 'invalid-output': return 'AI returned an unexpected response format. Please retry.'
    default: return 'An unexpected error occurred. Please retry.'
  }
}

// ---------------------------------------------------------------------------
// describeTaskError — ONE composition of kind + canned sentence + concrete
// detail, used by EVERY task catch (state, tooltips, analytics).
// ---------------------------------------------------------------------------

/** Cap on the detail folded into errorDetail (mirrors mapHttpError's 300-char body cap). */
const ERROR_DETAIL_MAX = 300
/** Cap on the reason_detail analytics property — enough to classify the failure mix. */
const REASON_DETAIL_MAX = 120

export interface TaskErrorInfo {
  /** LlmError kind, or 'unknown' for non-LlmError throws. */
  kind: string
  /** The canned human sentence for the kind (the existing UI lead line). */
  error: string
  /** The concrete upstream detail, when it adds information — see rules below. */
  errorDetail?: string
}

/**
 * Map a task failure into { kind, error, errorDetail } — the single source for
 * PanelState error fields AND the ai_task_failed analytics props.
 *
 * errorDetail composition rules:
 *   1. Raw = LlmError.message (already capped at 300 chars by mapHttpError) or
 *      the thrown Error's message / String(err) for non-LlmError throws,
 *      trimmed and capped at 300 chars.
 *   2. OMITTED when it adds nothing: empty, identical to the canned sentence,
 *      or the LlmError constructor's bare `llm: <kind>` default.
 *   3. `HTTP <status>: ` prefix when the LlmError carries a status the message
 *      doesn't already name (mapHttpError messages embed "(NNN)" themselves).
 *   4. ` — retried automatically before failing` appended for transient-
 *      classified errors (rate-limited / 5xx): withTransientRetry exhausts its
 *      retries before such an error can surface here, so this is knowable from
 *      classification alone — no retry-hook bookkeeping needed.
 */
export function describeTaskError(err: unknown): TaskErrorInfo {
  const kind = err instanceof LlmError ? err.kind : 'unknown'
  const error = humanMessage(kind)
  const rawMessage = err instanceof Error ? err.message : err == null ? '' : String(err)
  let raw = rawMessage.trim().slice(0, ERROR_DETAIL_MAX)
  if (raw === error || raw === `llm: ${kind}`) raw = ''
  const status = err instanceof LlmError ? err.status : undefined
  if (raw && status !== undefined && !raw.includes(`(${status})`)) raw = `HTTP ${status}: ${raw}`
  const retried = err instanceof LlmError && isTransientLlmError(err)
  const errorDetail = retried
    ? (raw ? `${raw} — retried automatically before failing` : 'Retried automatically before failing')
    : raw
  return { kind, error, ...(errorDetail ? { errorDetail } : {}) }
}

/** ai_task_failed props for a described failure — reason + truncated reason_detail. */
function failureProps(task: string, info: TaskErrorInfo): { task: string; reason: string; reason_detail?: string } {
  return {
    task,
    reason: info.kind,
    ...(info.errorDetail ? { reason_detail: info.errorDetail.slice(0, REASON_DETAIL_MAX) } : {}),
  }
}

// ---------------------------------------------------------------------------
// JSON-task call options — output headroom + size-aware timeout
// ---------------------------------------------------------------------------

/**
 * Output-token headroom for every non-streaming JSON task. Without it the
 * Anthropic adapter silently caps output at its 4096 default (a long
 * alternatives/story JSON gets truncated → invalid-output), and DeepSeek's
 * server-side default is similarly small. 8192 is generous for every JSON
 * shape we request while staying within all providers' output ceilings.
 */
export const JSON_TASK_MAX_TOKENS = 8192

/**
 * Prompt size (estimated tokens, prompt = system + user) above which a JSON
 * task gets the extended timeout instead of the transport's 60s default. A
 * full packed context near the pack budget takes providers well over 60s to
 * ingest + answer — the old fixed window turned big-PR tasks into 'timeout'
 * failures.
 */
export const LARGE_PROMPT_TOKEN_THRESHOLD = 30_000

/** Extended per-attempt timeout for large-prompt JSON tasks (default stays 60s). */
export const LARGE_PROMPT_TIMEOUT_MS = 120_000

/**
 * Build the LLM call options for a non-streaming JSON task: the prompts plus
 * explicit output headroom, and — when the prompt itself is large (ships the
 * full packed context near budget) — a scaled timeout. Every transient-retry
 * attempt re-runs the transport adapter, so each attempt gets the full window.
 */
function jsonTaskOpts(prompts: { system: string; user: string }): {
  system: string
  user: string
  maxTokens: number
  timeoutMs?: number
} {
  const promptTokens = estimateTokens(prompts.system) + estimateTokens(prompts.user)
  return {
    system: prompts.system,
    user: prompts.user,
    maxTokens: JSON_TASK_MAX_TOKENS,
    ...(promptTokens > LARGE_PROMPT_TOKEN_THRESHOLD ? { timeoutMs: LARGE_PROMPT_TIMEOUT_MS } : {}),
  }
}

// ---------------------------------------------------------------------------
// Reviewer auto-retry pacing — retry rounds wait before re-dispatching so an
// exhausted rate limit isn't hammered the instant it failed (retry storms).
// ---------------------------------------------------------------------------

/** Fallback per-round delays when no Retry-After was observed (2s/4s/8s). */
export const AUTO_RETRY_ROUND_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000]

/** Hard cap on any single auto-retry round delay (Retry-After included). */
export const AUTO_RETRY_MAX_DELAY_MS = 20_000

/**
 * Delay before auto-retry round `round` (0-based): the max Retry-After
 * observed across the round's failed reviewers when knowable (the provider
 * TOLD us when capacity returns), else the 2s/4s/8s ladder. Capped at 20s.
 */
export function autoRetryDelayMs(round: number, observedRetryAfterMs: number[]): number {
  const fallback =
    AUTO_RETRY_ROUND_DELAYS_MS[Math.min(round, AUTO_RETRY_ROUND_DELAYS_MS.length - 1)]
  const base = observedRetryAfterMs.length > 0 ? Math.max(...observedRetryAfterMs) : fallback
  return Math.min(base, AUTO_RETRY_MAX_DELAY_MS)
}

// ---------------------------------------------------------------------------
// createAiRun
// ---------------------------------------------------------------------------

export function createAiRun(input: AiRunInput, deps?: Partial<AiRunDeps>): AiRun {
  const {
    llmStream,
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    llmJsonWithRepairFor,
    llmToolLoop,
    getCached,
    setCached,
    gateAi,
    track,
  }: AiRunDeps = {
    llmStream: defaultLlmStream,
    llmStreamWithUsage: defaultLlmStreamWithUsage,
    llmJsonWithRepair: defaultLlmJsonWithRepair,
    llmJsonWithRepairWithUsage: defaultLlmJsonWithRepairWithUsage,
    llmJsonWithRepairFor: defaultLlmJsonWithRepairFor,
    llmToolLoop: defaultLlmToolLoop,
    getCached: defaultGetCached,
    setCached: defaultSetCached,
    gateAi: defaultGateAi,
    track: defaultTrack,
    ...deps,
  }

  const { prKey, repo, isPrivate, meta, pack, ci, ask: askConsent, deepReview, coachCodeContext, verifyCodeContext, drafts: getDrafts } = input

  // Shared per-REVIEW deep-review fetch cache (Plan G cost reduction). Created
  // ONCE per createAiRun — and the Review route makes a fresh run per PR — so
  // it is naturally scoped to this PR/run and discarded (along with the whole
  // run) when the user opens a different PR. No cross-PR leak: a sibling PR
  // gets its own createAiRun and thus its own cache. Every deep task in THIS
  // review shares it, so once any task reads a file the others reuse it.
  const deepCache = createDeepReviewCache()

  // Reactive panel state holders
  const summaryState = $state<PanelState<string>>({ status: 'idle' })
  const attentionState = $state<PanelState<AttentionResult>>({ status: 'idle' })
  const diagramsState = $state<PanelState<GraphResult>>({ status: 'idle' })
  const verdictState = $state<PanelState<VerdictResult>>({ status: 'idle' })
  const riskJudgeState = $state<PanelState<RiskJudgeResult>>({ status: 'idle' })
  const testsState = $state<PanelState<TestInsight>>({ status: 'idle' })
  const alternativesState = $state<PanelState<AlternativesResult>>({ status: 'idle' })
  const intentState = $state<PanelState<IntentCheckResult>>({ status: 'idle' })
  const storyState = $state<PanelState<StoryOrderResult>>({ status: 'idle' })

  // Skill review entries — populated on-demand by runSkillReviews()
  let skillReviewsState = $state<SkillReviewEntry[]>([])

  // Cross-reviewer convergence pass state (runs after all reviewers settle).
  // The reviewer entries above are NEVER mutated by the pass — loss-proof.
  const convergenceState = $state<PanelState<ConvergenceValue>>({ status: 'idle' })

  // Post-review SIMPLIFY pass state (runs after the convergence pass settles —
  // including when convergence skipped or failed). Same loss-proof contract:
  // reviewer entries are never mutated; the UI applies rewrites itself.
  const simplifyState = $state<PanelState<SimplifyValue>>({ status: 'idle' })

  // Token usage from the most recent coach() run (on-demand, never cached).
  // Folded into totalUsage so the per-PR total includes coaching cost.
  let coachUsage = $state<LlmUsage | undefined>(undefined)

  // Per-model cost + impact for the verdict's cross-verify pass (Plan N).
  // Populated when cross-verify runs for the verdict; empty otherwise.
  let verdictModelsState = $state<VerdictModelBreakdown[]>([])

  // Packed context — kept in closure so retry can reuse it without re-packing
  // (unless the initial pack failed, in which case retry re-packs)
  let packedCtx: PackedContext | null = null

  /**
   * THE task-failure funnel: every task catch lands here. Sets the panel's
   * error state (canned lead + concrete errorDetail for tooltips), clears any
   * deep-mode activity lines, and emits ai_task_failed with reason AND
   * reason_detail so the failure mix is measurable — not just a 7-value enum.
   */
  function failTask(state: PanelState<unknown>, task: string, err: unknown): void {
    const info = describeTaskError(err)
    state.status = 'error'
    state.error = info.error
    state.errorDetail = info.errorDetail
    state.activity = undefined
    track('ai_task_failed', failureProps(task, info))
  }

  // ---------------------------------------------------------------------------
  // Cross-model verification (Plan M)
  // ---------------------------------------------------------------------------

  /** A finding to verify, with its UI key so we can write verification back. */
  interface FindingToVerify {
    id: string
    path: string
    line: number | null
    severity: 'high' | 'medium' | 'low'
    body: string
    side: 'LEFT' | 'RIGHT'
  }

  /** Real per-verifier call: comprehensive adversarial JSON judgement. */
  const realVerify: VerifyFn = async (cfg: ProviderConfig, findings: VerifiableFinding[]) => {
    const prompts = buildVerifyPrompt(findings)
    const { result, usage } = await llmJsonWithRepairFor(
      cfg,
      jsonTaskOpts(prompts),
      validateVerifierResponse,
    )
    return { result, usage }
  }

  // ---------------------------------------------------------------------------
  // Tool-backed absence verification (Part B)
  //
  // When the active config CAN use tools (deep-capable provider + key + a wired
  // deepReview source), an absence/external-evidence finding ("no test verifies
  // X", "not called", "missing handler") is CHECKED before it can surface: the
  // verifier searches the repo for the referenced symbol/test and CONFIRMS the
  // absence only if it genuinely finds nothing. The check shares the per-review
  // deep cache and runs under its own per-task tool toolkit (so its calls/bytes
  // respect the deep budgets). A hard cap on the NUMBER of absence checks per run
  // keeps the extra cost bounded; once exhausted, later absence findings fall
  // back to the Part A prompt floor (demoted unless positively confirmed).
  // ---------------------------------------------------------------------------

  /** Hard cap on tool-backed absence checks per review (cost bound). */
  const MAX_ABSENCE_TOOL_CHECKS = 6
  let absenceToolChecksUsed = 0

  /** Whether tool-backed verification can run: deep source + tool-capable model. */
  function toolBackedVerifyAvailable(): boolean {
    return deepReview !== undefined && modelSupportsTools(activeLlmConfig().model)
  }

  /**
   * Build the tool-backed absence check (Part B), or undefined when tools are
   * unavailable (no-key / non-deep model / no source). Each call runs a small
   * tool loop on the ACTIVE model asking it to SEARCH for the test/caller/handler
   * the finding claims is missing and answer confirm (absence holds) / refute
   * (found it) / uncertain. Reuses the shared deep cache + budgets; never throws.
   */
  function buildAbsenceToolCheck(onActivity?: (line: string) => void): ToolCheckFn | undefined {
    if (!toolBackedVerifyAvailable()) return undefined
    return async (finding: VerifiableFinding): Promise<'confirm' | 'refute' | 'uncertain'> => {
      if (absenceToolChecksUsed >= MAX_ABSENCE_TOOL_CHECKS) return 'uncertain'
      absenceToolChecksUsed += 1
      onActivity?.(`Verifying claim against the repo: ${finding.body.slice(0, 60)}…`)
      const toolkit = createDeepReviewToolkit(deepReview!, deepCache)
      const system =
        'You are verifying ONE claim that something is ABSENT from the codebase (e.g. "no test ' +
        'covers X", "X is not called anywhere", "no handler for Y"). The claim is about code ' +
        'OUTSIDE the provided diff. USE THE SEARCH TOOLS (search_code / find_references / ' +
        'read_file) to look for the referenced test, caller, handler, or symbol across the repo. ' +
        'Then answer with JSON ONLY: {"verdict":"confirm"|"refute"|"uncertain"}.\n' +
        '- "refute": you FOUND the test/caller/handler the claim says is missing (the absence is ' +
        'FALSE).\n' +
        '- "confirm": you searched and genuinely found NOTHING — the absence holds.\n' +
        '- "uncertain": you could not search effectively (no tool, budget gone) — do not guess.\n' +
        'Default to "uncertain" or "refute"; only "confirm" an absence you actually verified. ' +
        'Respond with the JSON object only.'
      const user = `Finding: ${finding.body}\nFile: ${finding.path}${finding.line !== null ? `:${finding.line}` : ''}`
      try {
        const loop = await llmToolLoop({
          system: withDeepReviewGuidance(system, toolkit.tools.map((t) => t.name)),
          user,
          tools: toolkit.tools,
          executeTool: toolkit.executeTool,
          humanize: toolkit.humanize,
          maxToolCalls: DEEP_REVIEW_MAX_TOOL_CALLS,
          onToolEvent: (ev) => onActivity?.(ev.detail),
        })
        const parsed = JSON.parse(loop.content) as { verdict?: unknown }
        const v = parsed?.verdict
        if (v === 'confirm' || v === 'refute' || v === 'uncertain') return v
        return 'uncertain'
      } catch {
        // A failed/unparseable check is treated as "could not verify" → the
        // absence is NOT positively confirmed, so the finding is demoted.
        return 'uncertain'
      }
    }
  }

  /** Best-effort path token from a verdict evidence bullet (for context lookup). */
  const EVIDENCE_PATH_RE = /[\w@.\-/]+\.[A-Za-z0-9]+/
  function extractEvidencePath(text: string): string | null {
    const m = EVIDENCE_PATH_RE.exec(text)
    if (!m) return null
    const token = m[0]
    if (token.includes('/')) return token
    if (/\.(ts|tsx|js|jsx|svelte|py|go|rs|java|rb|json|css)$/i.test(token)) return token
    return null
  }

  /** Humanized "Cross-checking with X, Y…" line for the activity channel. */
  function crossCheckLabel(verifiers: ProviderConfig[]): string {
    const names = verifiers.map((v) => getProvider(v.providerId)?.displayName ?? v.providerId)
    return `Cross-checking with ${names.join(', ')}…`
  }

  /**
   * Verify a finding set against the configured verifier providers, attaching an
   * aggregated `verification` to each. No-op (returns the inputs unchanged, no
   * usage) when cross-model verification is not effective (single-key / off).
   * Graceful: any failure leaves findings unverified (never drops them).
   */
  async function verifyFindingSet(
    findings: FindingToVerify[],
    onActivity?: (line: string) => void,
  ): Promise<{
    byId: Map<string, import('./schemas').FindingVerification>
    usage: LlmUsage | undefined
    perModelUsage: ParticipantUsage[]
    verifierImpact: VerifierImpact[]
  }> {
    const empty = { byId: new Map(), usage: undefined, perModelUsage: [], verifierImpact: [] }
    if (findings.length === 0 || !crossModelVerifyEffective()) return empty
    const verifiers = verifierProviderConfigs()
    if (verifiers.length === 0) return empty

    onActivity?.(crossCheckLabel(verifiers))

    // Build per-finding code context (best-effort) and assemble VerifiableFindings.
    let ctxByKey = new Map<string, CoachCodeContext>()
    try {
      if (verifyCodeContext) {
        const anchors = findings
          .filter((f) => f.line !== null)
          .map((f) => ({ path: f.path, line: f.line as number, side: f.side }))
        const ctxs = verifyCodeContext(anchors)
        // verifyCodeContext returns entries in input order; key by path:line.
        let i = 0
        for (const f of findings) {
          if (f.line === null) continue
          const cc = ctxs[i++]
          if (cc) ctxByKey.set(f.id, cc)
        }
      }
    } catch {
      ctxByKey = new Map() // best-effort: no context on failure
    }

    const verifiable: VerifiableFinding[] = findings.map((f) => {
      const cc = ctxByKey.get(f.id)
      return {
        id: f.id,
        path: f.path,
        line: f.line,
        severity: f.severity,
        body: f.body,
        // Classify in the verify step (Part B): an absence/external-evidence
        // claim is demoted unless its absence is positively (tool-)confirmed.
        claimType: classifyClaim(f.body),
        ...(cc?.excerpt ? { excerpt: cc.excerpt } : {}),
        ...(cc?.fileWindow ? { fileWindow: cc.fileWindow } : {}),
      }
    })

    const generatorName = activeLlmConfig().provider.displayName
    const generatorModelId = activeLlmConfig().model.id
    // Tool-backed absence check (Part B) — undefined when tools are unavailable
    // (no-key / non-deep model / no source), so the no-tools path is unchanged:
    // crossVerify then leaves needs-external findings to the Part A floor (demoted
    // unless positively confirmed, which without a tool they cannot be).
    const toolCheck = buildAbsenceToolCheck(onActivity)
    try {
      // Every verifier runs the SAME comprehensive adversarial prompt; error
      // decorrelation comes from MODEL/PROVIDER diversity, not per-judge framing.
      const outcome = await crossVerify(verifiable, generatorName, verifiers, realVerify, generatorModelId, toolCheck)
      return {
        byId: outcome.byId,
        usage: outcome.usage,
        perModelUsage: outcome.perModelUsage,
        verifierImpact: outcome.verifierImpact,
      }
    } catch {
      // Verification itself failing must never drop findings.
      return empty
    }
  }

  /**
   * Build the per-model cost + impact breakdown for step 3 (Plan N). Generator
   * row first (its generation usage + surfaced-finding count), then one row per
   * responding verifier model (its usage + confirms/refutes/decisive impact).
   * The generator identity is the ensemble generator (or active config default).
   */
  function buildVerdictModels(
    generatorUsage: LlmUsage | undefined,
    surfaced: number,
    perModelUsage: ParticipantUsage[],
    verifierImpact: VerifierImpact[],
  ): VerdictModelBreakdown[] {
    const gen = resolveEnsemble().generator
    const genProviderId = gen?.providerId ?? activeLlmConfig().provider.id
    const genModelId = gen?.model.id ?? activeLlmConfig().model.id
    const usageByModel = new Map(perModelUsage.map((p) => [`${p.providerId}:${p.modelId}`, p.usage]))

    const rows: VerdictModelBreakdown[] = [
      {
        providerId: genProviderId,
        modelId: genModelId,
        role: 'generator',
        ...(generatorUsage ? { usage: generatorUsage } : {}),
        surfaced,
      },
    ]
    for (const imp of verifierImpact) {
      const usage = usageByModel.get(`${imp.providerId}:${imp.modelId}`)
      rows.push({
        providerId: imp.providerId,
        modelId: imp.modelId,
        role: 'verifier',
        ...(usage ? { usage } : {}),
        impact: {
          confirms: imp.confirms,
          refutes: imp.refutes,
          uncertains: imp.uncertains,
          decisive: imp.decisive,
        },
      })
    }
    return rows
  }

  // ---------------------------------------------------------------------------
  // Multi-generator fusion (Plan O Part A) — RECALL
  // ---------------------------------------------------------------------------

  /**
   * Generate a finding set with EACH ensemble participant independently (in
   * parallel, via the participant's own provider config). `gen` maps a
   * participant config → that participant's VerifiableFindings (or throws,
   * which is swallowed so one slow/broken generator can't sink the fusion).
   * Returns the per-generator finding sets + summed generation usage.
   */
  async function generateMultiGen(
    participants: FusionParticipant[],
    gen: (cfg: ProviderConfig) => Promise<{ findings: VerifiableFinding[]; usage?: LlmUsage }>,
  ): Promise<{ perGenerator: GeneratorFindings[]; usage: LlmUsage | undefined; usageByModel: Map<string, LlmUsage> }> {
    const results = await Promise.allSettled(participants.map((p) => gen(p.cfg)))
    const perGenerator: GeneratorFindings[] = []
    const usageByModel = new Map<string, LlmUsage>()
    let usage: LlmUsage | undefined
    results.forEach((res, i) => {
      if (res.status !== 'fulfilled') return
      const p = participants[i]
      perGenerator.push({ generator: p.generator, cfg: p.cfg, findings: res.value.findings })
      usage = addUsage(usage, res.value.usage)
      if (res.value.usage) {
        const key = `${p.cfg.providerId}:${p.cfg.model.id}`
        usageByModel.set(key, addUsage(usageByModel.get(key), res.value.usage) as LlmUsage)
      }
    })
    // Rate-limit fail-fast: when EVERY generator failed and at least one hit a
    // rate limit, surface the rate-limit error instead of pretending the fusion
    // produced an (empty) result — the caller fails the task with the REAL
    // error (which the reviewer auto-retry then paces), rather than burning a
    // second full single-pass+verify spend against an exhausted limit. Partial
    // failures are unchanged: any surviving generator keeps the fusion going.
    if (perGenerator.length === 0 && results.length > 0) {
      const rateLimited = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason)
        .filter((e): e is LlmError => e instanceof LlmError && e.kind === 'rate-limited')
      if (rateLimited.length > 0) {
        // Throw the one carrying the LARGEST Retry-After (best pacing signal).
        rateLimited.sort((a, b) => (b.retryAfterMs ?? -1) - (a.retryAfterMs ?? -1))
        throw rateLimited[0]
      }
    }
    return { perGenerator, usage, usageByModel }
  }

  /**
   * Build the per-model breakdown for a fusion run (Plan P): one row per
   * participant. The first `generatorCount` rows are GENERATORS (their generation
   * usage + surfaced + uniqueCatch); the rest are VERIFIERS (verify usage only).
   * Every participant verifies findings it didn't raise via the comprehensive
   * adversarial prompt.
   */
  function buildFusionModels(
    participants: FusionParticipant[],
    generatorCount: number,
    genUsageByModel: Map<string, LlmUsage>,
    fusionPerModelUsage: ParticipantUsage[],
    generatorImpact: import('./crossVerify').GeneratorImpact[],
  ): VerdictModelBreakdown[] {
    const verifyUsage = new Map(fusionPerModelUsage.map((p) => [`${p.providerId}:${p.modelId}`, p.usage]))
    const impactByGen = new Map(generatorImpact.map((g) => [g.generator, g]))
    return participants.map((p, i) => {
      const key = `${p.cfg.providerId}:${p.cfg.model.id}`
      const isGenerator = i < generatorCount
      const usage = isGenerator
        ? addUsage(genUsageByModel.get(key), verifyUsage.get(key))
        : verifyUsage.get(key)
      const imp = impactByGen.get(p.generator)
      return {
        providerId: p.cfg.providerId,
        modelId: p.cfg.model.id,
        role: (isGenerator ? 'generator' : 'verifier') as 'generator' | 'verifier',
        ...(usage ? { usage } : {}),
        ...(isGenerator
          ? { surfaced: imp?.surfaced ?? 0, uniqueCatch: imp?.uniqueCatch ?? 0 }
          : {}),
      }
    })
  }

  /**
   * Plan O/P 'generate' mode for a skill review: run the skill prompt with EVERY
   * configured GENERATOR independently, dedup-merge the union, cross-confirm
   * (comprehensive prompt), and rebuild a SkillReviewResult whose findings carry
   * `raisedBy` + `verification`, surfaced-first.
   *
   * Honoring configured roles (no silent demotion): this runs whenever there are
   * ≥2 usable GENERATORS (keys present) — checked by the caller's
   * `fusionGenerateEffective()`. It NEVER bails based on how many generators
   * actually PRODUCED findings: a generator that finds nothing (or whose call
   * fails) still gets a GENERATOR row (0 findings is a valid generated result),
   * so a model the user marked Generator is never demoted to a verifier. Only the
   * caller's <2-generator gate falls back to the single-generator path.
   *
   * Errors: RATE-LIMIT-classified failures (kind==='rate-limited') are
   * RETHROWN — the caller's task catch fails the reviewer entry with the real
   * error (paced auto-retry handles it) instead of burning a second full
   * single-pass+verify spend against an exhausted limit. Any OTHER failure
   * returns null (caller falls back to the single-generator path, unchanged).
   *
   * When `deep` is true each generator GENERATES through its own DEEP pass
   * (runDeepJson with the generator's provider override), sharing the per-review
   * deep cache so file reads are reused across generators. Otherwise each
   * generator runs a single-pass llmJsonWithRepairFor (unchanged).
   */
  async function fuseSkillReview(
    prompts: { system: string; user: string },
    skillName: string,
    idx: number,
    deep: boolean,
    onUpdate?: () => void,
  ): Promise<{ result: SkillReviewResult; usage: LlmUsage | undefined; models: VerdictModelBreakdown[] } | null> {
    try {
      // Plan P: generators GENERATE; ALL participants (generators + verifiers)
      // verify findings they didn't raise. Multi-gen requires ≥2 generators
      // (the caller already gated on fusionGenerateEffective()).
      const participants = fusionParticipants()
      const generators = fusionGenerators()
      if (generators.length < 2) return null
      const note = (line: string): void => {
        const entry = skillReviewsState[idx]
        entry.state = { ...entry.state, activity: [...(entry.state.activity ?? []), line] }
        onUpdate?.()
      }
      note(deep
        ? `Deep-generating with ${generators.length} models (fusion)…`
        : `Generating with ${generators.length} models (fusion)…`)

      // 1. Each GENERATOR generates independently (parallel, own provider cfg).
      //    Deep: its own runDeepJson tool loop (shared cache); else single-pass.
      const { perGenerator, usage: genUsage, usageByModel: genUsageByModel } = await generateMultiGen(
        generators,
        async (cfg) => {
          const { result, usage } = deep
            ? await runDeepJson<SkillReviewResult>(
                { system: prompts.system, user: prompts.user },
                validateSkillReviewResult,
                note,
                {
                  nonTrivial: false,
                  outputClaimsCode: (r) => r.findings.length > 0,
                },
                cfg,
              )
            : await llmJsonWithRepairFor<SkillReviewResult>(
                cfg,
                jsonTaskOpts(prompts),
                validateSkillReviewResult,
              )
          const findings: VerifiableFinding[] = result.findings.map((f, i) => ({
            id: `${cfg.providerId}:${cfg.model.id}:${i}:${djb2(f.body)}`,
            path: f.path,
            line: f.line,
            severity: f.severity,
            body: f.body,
          }))
          return { findings, usage }
        },
      )

      // NO silent demotion: we do NOT bail when fewer than 2 generators PRODUCED
      // findings. Every configured generator stays a generator row (built from
      // `participants` in buildFusionModels), even when the union is empty.

      // 2. Merge/dedup the union.
      const merged = mergeGeneratorFindings(perGenerator)
      if (merged.length === 0) {
        // 0 findings is a VALID generated result — still emit generator rows so
        // the panel matches the configured roles (no demotion to verifier).
        return {
          result: { skillName, findings: [] },
          usage: genUsage,
          models: buildFusionModels(participants, generators.length, genUsageByModel, [], []),
        }
      }

      // 3. Cross-confirm (each participant verifies findings it didn't raise).
      //    Tool-backed absence verification (Part B) gates needs-external findings.
      const outcome = await fuseConfirm(merged, participants, realVerify, buildAbsenceToolCheck(note))

      // 4. Rebuild findings, surfaced-first, carrying raisedBy + verification.
      const findings = outcome.merged.map((m) => ({
        path: m.merged.finding.path,
        line: m.merged.finding.line,
        severity: m.merged.finding.severity,
        body: m.merged.finding.body,
        verification: m.verification,
        raisedBy: m.merged.raisedBy,
      }))
      const totalUsage = addUsage(genUsage, outcome.usage)
      const models = buildFusionModels(
        participants,
        generators.length,
        genUsageByModel,
        outcome.perModelUsage,
        outcome.generatorImpact,
      )
      return { result: { skillName, findings }, usage: totalUsage, models }
    } catch (err) {
      // Rate-limit fail-fast: rethrow so the reviewer entry fails with the real
      // error (paced auto-retry) instead of double-spending on the fallback.
      if (err instanceof LlmError && err.kind === 'rate-limited') throw err
      return null
    }
  }

  /**
   * Plan P 'generate' mode for the VERDICT: run the verdict prompt with EVERY
   * ensemble generator independently, then UNION their evidence (treating each
   * evidence bullet like a finding — same dedup/cross-confirm as reviewer fusion)
   * so a real claim only one generator raised can still surface, carrying
   * raisedBy. The verdict's SINGLE HOLISTIC judgment (`level`) is NOT merged —
   * holistic calls can't be union-fused — so we take the PRIMARY generator's
   * `level` (and primary `notAnalyzed`, unioned with packed context). The user's
   * 'generate' intent is the EVIDENCE recall, with one recommendation.
   *
   * Honoring configured roles (no silent demotion): runs whenever there are ≥2
   * usable GENERATORS (the caller gates on fusionGenerateEffective()). It NEVER
   * bails based on how many generators actually produced evidence — every
   * configured generator stays a GENERATOR row even when the union is empty, so a
   * verdict that finds no evidence does not silently demote a configured
   * generator to a verifier. Returns null only when there are <2 usable
   * generators (caller's gate) or no primary verdict was produced.
   *
   * Errors: RATE-LIMIT-classified failures (kind==='rate-limited') are
   * RETHROWN — the caller's task catch fails the verdict with the real error
   * instead of burning a second full single-pass+verify spend against an
   * exhausted limit. Any OTHER failure returns null (fallback unchanged).
   *
   * When `deep` is true each generator generates its verdict through its own DEEP
   * pass (runDeepJson with the generator's provider override), sharing the
   * per-review deep cache. Otherwise each generator runs a single-pass call.
   */
  async function fuseVerdict(
    prompts: { system: string; user: string },
    ctx: PackedContext,
    deep: boolean,
    onActivity?: (line: string) => void,
  ): Promise<{ result: VerdictResult; usage: LlmUsage | undefined; models: VerdictModelBreakdown[] } | null> {
    try {
      const participants = fusionParticipants()
      const generators = fusionGenerators()
      if (generators.length < 2) return null
      onActivity?.(deep
        ? `Deep-generating verdict with ${generators.length} models (fusion)…`
        : `Generating verdict with ${generators.length} models (fusion)…`)

      // 1. Each GENERATOR generates a verdict independently (parallel, own cfg).
      //    Evidence bullets become VerifiableFindings (no real line — anchored by
      //    best-effort path token + description, exactly like the verify path).
      //    Deep: each generator runs its own runDeepJson tool loop (shared cache).
      const perVerdict = new Map<string, VerdictResult>()
      const { perGenerator, usage: genUsage, usageByModel: genUsageByModel } = await generateMultiGen(
        generators,
        async (cfg) => {
          const { result, usage } = deep
            ? await runDeepJson<VerdictResult>(
                { system: prompts.system, user: prompts.user },
                validateVerdict,
                (line) => onActivity?.(line),
                {
                  nonTrivial: ctx.includedFiles.length > 1,
                  outputClaimsCode: (r) => r.evidence.length > 0,
                },
                cfg,
              )
            : await llmJsonWithRepairFor<VerdictResult>(
                cfg,
                jsonTaskOpts(prompts),
                validateVerdict,
              )
          perVerdict.set(`${cfg.providerId}:${cfg.model.id}`, result)
          const findings: VerifiableFinding[] = result.evidence.map((bullet, i) => ({
            id: `${cfg.providerId}:${cfg.model.id}:${i}:${djb2(bullet)}`,
            path: extractEvidencePath(bullet) ?? '(no file)',
            line: null,
            severity: 'medium' as const,
            body: bullet,
          }))
          return { findings, usage }
        },
      )

      // NO silent demotion: do NOT bail on how many generators produced evidence.

      // The PRIMARY generator's holistic verdict supplies `level` + `notAnalyzed`.
      const gen = resolveEnsemble().generator
      const primaryKey = gen ? `${gen.providerId}:${gen.model.id}` : undefined
      const primary =
        (primaryKey ? perVerdict.get(primaryKey) : undefined) ??
        perVerdict.get(`${perGenerator[0].cfg.providerId}:${perGenerator[0].cfg.model.id}`)
      if (!primary) return null

      // notAnalyzed: union of packed context + the primary generator's own list.
      const mergedNotAnalyzed = [...new Set([...ctx.notAnalyzed, ...primary.notAnalyzed])]

      // 2. Merge/dedup the union of evidence bullets across generators.
      const merged = mergeGeneratorFindings(perGenerator)
      if (merged.length === 0) {
        const result: VerdictResult = { level: primary.level, evidence: [], notAnalyzed: mergedNotAnalyzed }
        return { result, usage: genUsage, models: buildFusionModels(participants, generators.length, genUsageByModel, [], []) }
      }

      // 3. Cross-confirm (each participant verifies evidence it didn't raise).
      //    Tool-backed absence verification (Part B) gates needs-external evidence.
      const outcome = await fuseConfirm(merged, participants, realVerify, buildAbsenceToolCheck(onActivity))

      // 4. Rebuild the verdict: surfaced-first evidence + per-row verification +
      //    raisedBy provenance. Primary `level` + unioned notAnalyzed.
      const evidence: string[] = []
      const evidenceVerification: Record<number, import('./schemas').FindingVerification> = {}
      const evidenceRaisedBy: Record<number, string[]> = {}
      outcome.merged.forEach((m, i) => {
        evidence.push(m.merged.finding.body)
        evidenceVerification[i] = m.verification
        evidenceRaisedBy[i] = m.merged.raisedBy
      })
      const result: VerdictResult = {
        level: primary.level,
        evidence,
        notAnalyzed: mergedNotAnalyzed,
        evidenceVerification,
        evidenceRaisedBy,
      }
      const totalUsage = addUsage(genUsage, outcome.usage)
      const models = buildFusionModels(
        participants,
        generators.length,
        genUsageByModel,
        outcome.perModelUsage,
        outcome.generatorImpact,
      )
      return { result, usage: totalUsage, models }
    } catch (err) {
      // Rate-limit fail-fast: rethrow so the verdict fails with the real error
      // instead of double-spending on the fallback single-pass+verify.
      if (err instanceof LlmError && err.kind === 'rate-limited') throw err
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: run a single task (summary streams; others use llmJsonWithRepair)
  // ---------------------------------------------------------------------------

  async function runSummaryTask(ctx: PackedContext): Promise<void> {
    // Plan J: summary supports off/standard only. Off → never run, no cache.
    if (!resolveTaskMode('summary', deepReview).run) {
      summaryState.status = 'disabled'
      return
    }
    const key = cacheKey(prKey, 'summary', promptVersionFor('summary'))

    // Cache check
    const t0 = performance.now()
    const hit = await getCached<string>(key)
    if (hit !== null) {
      summaryState.status = 'done'
      summaryState.value = hit
      track('ai_task_completed', { task: 'summary', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    summaryState.status = 'loading'
    const t1 = performance.now()

    const prompts = summarizePrompt(ctx)
    let accumulated = ''

    try {
      const streamResult = await llmStreamWithUsage(prompts, (delta: string) => {
        accumulated += delta
        summaryState.status = 'streaming'
        summaryState.value = accumulated
      })
      // Only cache after complete success (EC-17d / EC-12f)
      await setCached<string>(key, streamResult.content)
      summaryState.status = 'done'
      summaryState.value = streamResult.content
      summaryState.usage = streamResult.usage
      const summaryTokens = streamResult.usage?.total_tokens
      track('ai_task_completed', {
        task: 'summary',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(summaryTokens !== undefined ? { tokens: summaryTokens } : {}),
      })
    } catch (err) {
      // Partial stream NEVER cached — do not call setCached here
      failTask(summaryState, 'summary', err)
    }
  }

  async function runAttentionTask(ctx: PackedContext): Promise<void> {
    // Deep attention (PROMPT_VERSION 13): when the agentic toggle is on, the
    // attention/hotspot task runs through the same harness as the other deep
    // tasks so it can VERIFY each candidate hotspot (read the changed file and
    // its callers/dependencies) before reporting it — assume-best-intent: drop
    // hotspots it can't substantiate. Toggle off → byte-identical single-pass.
    const mode = resolveTaskMode('attention', deepReview)
    if (!mode.run) {
      attentionState.status = 'disabled'
      return
    }
    const deep = { enabled: mode.deep, note: mode.note }
    if (deep.note) attentionState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'attention|deep' : 'attention', promptVersionFor('attention'))

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<AttentionResult>>(key)
      if (hit !== null) {
        attentionState.status = 'done'
        attentionState.value = hit.result
        attentionState.toolCallsUsed = hit.toolCallsUsed
        attentionState.usage = hit.usage
        track('ai_task_completed', { task: 'attention', duration_ms: Math.round(performance.now() - t0), cached: true, deep: true })
        return
      }
    } else {
      const hit = await getCached<AttentionResult>(key)
      if (hit !== null) {
        attentionState.status = 'done'
        attentionState.value = hit
        track('ai_task_completed', { task: 'attention', duration_ms: Math.round(performance.now() - t0), cached: true })
        return
      }
    }

    attentionState.status = 'loading'
    if (deep.enabled) attentionState.activity = []
    const t1 = performance.now()
    const prompts = attentionPrompt(ctx, { deep: deep.enabled })

    try {
      let attentionResult: AttentionResult
      let attentionUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined

      if (deep.enabled) {
        const deepOutcome = await runDeepJson<AttentionResult>(prompts, validateAttention, (line) => {
          attentionState.activity = [...(attentionState.activity ?? []), line]
        })
        attentionResult = deepOutcome.result
        attentionUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
        await setCached<DeepCached<AttentionResult>>(key, { deep: true, result: attentionResult, toolCallsUsed, usage: attentionUsage })
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<AttentionResult>(
          jsonTaskOpts(prompts),
          validateAttention,
        )
        attentionResult = singlePass.result
        attentionUsage = singlePass.usage
        await setCached<AttentionResult>(key, attentionResult)
      }
      attentionState.status = 'done'
      attentionState.value = attentionResult
      attentionState.activity = undefined
      attentionState.usage = attentionUsage
      if (toolCallsUsed !== undefined) attentionState.toolCallsUsed = toolCallsUsed
      track('ai_task_completed', {
        task: 'attention',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(attentionUsage?.total_tokens !== undefined ? { tokens: attentionUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      failTask(attentionState, 'attention', err)
    }
  }

  async function runDiagramsTask(ctx: PackedContext): Promise<void> {
    // Deep diagrams (PROMPT_VERSION 12): when the agentic toggle is on, the
    // diagram task runs through the same harness as verdict/tests/alternatives
    // so it can walk one hop out (importers/callers + dependencies) and add
    // de-emphasized "context" nodes around the changed files. Toggle off →
    // byte-identical single-pass, diff-scoped behavior.
    const mode = resolveTaskMode('diagrams', deepReview)
    if (!mode.run) {
      diagramsState.status = 'disabled'
      return
    }
    const deep = { enabled: mode.deep, note: mode.note }
    if (deep.note) diagramsState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'diagrams|deep' : 'diagrams', promptVersionFor('diagrams'))

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<GraphResult>>(key)
      if (hit !== null) {
        diagramsState.status = 'done'
        diagramsState.value = hit.result
        diagramsState.toolCallsUsed = hit.toolCallsUsed
        diagramsState.usage = hit.usage
        track('ai_task_completed', { task: 'diagrams', duration_ms: Math.round(performance.now() - t0), cached: true, deep: true })
        return
      }
    } else {
      const hit = await getCached<GraphResult>(key)
      if (hit !== null) {
        diagramsState.status = 'done'
        diagramsState.value = hit
        track('ai_task_completed', { task: 'diagrams', duration_ms: Math.round(performance.now() - t0), cached: true })
        return
      }
    }

    diagramsState.status = 'loading'
    if (deep.enabled) diagramsState.activity = []
    const t1 = performance.now()
    const prompts = diagramsPrompt(ctx, { deep: deep.enabled })

    try {
      let diagramsResult: GraphResult
      let diagramsUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined

      if (deep.enabled) {
        const deepOutcome = await runDeepJson<GraphResult>(prompts, validateGraphResult, (line) => {
          diagramsState.activity = [...(diagramsState.activity ?? []), line]
        })
        diagramsResult = deepOutcome.result
        diagramsUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
        await setCached<DeepCached<GraphResult>>(key, { deep: true, result: diagramsResult, toolCallsUsed, usage: diagramsUsage })
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<GraphResult>(
          jsonTaskOpts(prompts),
          validateGraphResult,
        )
        diagramsResult = singlePass.result
        diagramsUsage = singlePass.usage
        await setCached<GraphResult>(key, diagramsResult)
      }
      diagramsState.status = 'done'
      diagramsState.value = diagramsResult
      diagramsState.activity = undefined
      diagramsState.usage = diagramsUsage
      if (toolCallsUsed !== undefined) diagramsState.toolCallsUsed = toolCallsUsed
      track('ai_task_completed', {
        task: 'diagrams',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(diagramsUsage?.total_tokens !== undefined ? { tokens: diagramsUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      failTask(diagramsState, 'diagrams', err)
    }
  }

  async function runTestsTask(ctx: PackedContext): Promise<void> {
    const mode = resolveTaskMode('tests', deepReview)
    if (!mode.run) {
      testsState.status = 'disabled'
      return
    }
    const deep = { enabled: mode.deep, note: mode.note }
    if (deep.note) testsState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'tests|deep' : 'tests', promptVersionFor('tests'))

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<TestInsight>>(key)
      if (hit !== null) {
        testsState.status = 'done'
        testsState.value = hit.result
        testsState.toolCallsUsed = hit.toolCallsUsed
        testsState.usage = hit.usage
        track('ai_task_completed', { task: 'tests', duration_ms: Math.round(performance.now() - t0), cached: true, deep: true })
        return
      }
    } else {
      const hit = await getCached<TestInsight>(key)
      if (hit !== null) {
        testsState.status = 'done'
        testsState.value = hit
        track('ai_task_completed', { task: 'tests', duration_ms: Math.round(performance.now() - t0), cached: true })
        return
      }
    }

    testsState.status = 'loading'
    if (deep.enabled) testsState.activity = []
    const t1 = performance.now()
    const prompts = testInsightPrompt(ctx)

    try {
      let testsResult: TestInsight
      let testsUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined

      if (deep.enabled) {
        const deepOutcome = await runDeepJson<TestInsight>(prompts, validateTestInsight, (line) => {
          testsState.activity = [...(testsState.activity ?? []), line]
        })
        testsResult = deepOutcome.result
        testsUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
        await setCached<DeepCached<TestInsight>>(key, { deep: true, result: testsResult, toolCallsUsed, usage: testsUsage })
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<TestInsight>(
          jsonTaskOpts(prompts),
          validateTestInsight,
        )
        testsResult = singlePass.result
        testsUsage = singlePass.usage
        await setCached<TestInsight>(key, testsResult)
      }
      testsState.status = 'done'
      testsState.value = testsResult
      testsState.activity = undefined
      testsState.usage = testsUsage
      if (toolCallsUsed !== undefined) testsState.toolCallsUsed = toolCallsUsed
      track('ai_task_completed', {
        task: 'tests',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(testsUsage?.total_tokens !== undefined ? { tokens: testsUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      failTask(testsState, 'tests', err)
    }
  }

  // Alternatives post-process: strict-validate → salvage partial JSON (drop
  // malformed elements, keep valid ones; tolerate a missing assessment by
  // omitting the field). Returns null only when NOTHING usable survives —
  // the caller then takes the error path. Mirrors story's shapeStoryOrder:
  // passed as the validator to the transport so the salvage applies on every
  // parse, including the repair pass. Prompt text is untouched.
  function shapeAlternatives(x: unknown): AlternativesResult | null {
    return validateAlternativesResult(x) ?? salvageAlternativesResult(x)
  }

  async function runAlternativesTask(ctx: PackedContext): Promise<void> {
    const mode = resolveTaskMode('alternatives', deepReview)
    if (!mode.run) {
      alternativesState.status = 'disabled'
      return
    }
    const deep = { enabled: mode.deep, note: mode.note }
    if (deep.note) alternativesState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'alternatives|deep' : 'alternatives', promptVersionFor('alternatives'))

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<AlternativesResult>>(key)
      if (hit !== null) {
        alternativesState.status = 'done'
        alternativesState.value = hit.result
        alternativesState.toolCallsUsed = hit.toolCallsUsed
        alternativesState.usage = hit.usage
        track('ai_task_completed', { task: 'alternatives', duration_ms: Math.round(performance.now() - t0), cached: true, deep: true })
        return
      }
    } else {
      const hit = await getCached<AlternativesResult>(key)
      if (hit !== null) {
        alternativesState.status = 'done'
        alternativesState.value = hit
        track('ai_task_completed', { task: 'alternatives', duration_ms: Math.round(performance.now() - t0), cached: true })
        return
      }
    }

    alternativesState.status = 'loading'
    if (deep.enabled) alternativesState.activity = []
    const t1 = performance.now()
    const prompts = alternativesPrompt(ctx)

    try {
      let alternativesResult: AlternativesResult
      let alternativesUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined

      if (deep.enabled) {
        const deepOutcome = await runDeepJson<AlternativesResult>(prompts, shapeAlternatives, (line) => {
          alternativesState.activity = [...(alternativesState.activity ?? []), line]
        })
        alternativesResult = deepOutcome.result
        alternativesUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
        await setCached<DeepCached<AlternativesResult>>(key, { deep: true, result: alternativesResult, toolCallsUsed, usage: alternativesUsage })
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<AlternativesResult>(
          jsonTaskOpts(prompts),
          shapeAlternatives,
        )
        alternativesResult = singlePass.result
        alternativesUsage = singlePass.usage
        await setCached<AlternativesResult>(key, alternativesResult)
      }
      alternativesState.status = 'done'
      alternativesState.value = alternativesResult
      alternativesState.activity = undefined
      alternativesState.usage = alternativesUsage
      if (toolCallsUsed !== undefined) alternativesState.toolCallsUsed = toolCallsUsed
      track('ai_task_completed', {
        task: 'alternatives',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(alternativesUsage?.total_tokens !== undefined ? { tokens: alternativesUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      failTask(alternativesState, 'alternatives', err)
    }
  }

  // Story post-process: strict-validate → salvage partial JSON → dedupe/no-overlap
  // → cap to STORY_MAX_STEPS. Returns null only when NOTHING usable survives
  // (caller then takes the error path). Used as the validator passed to the LLM
  // transport so the salvage + dedupe guards apply on every parse, including the
  // repair pass.
  function shapeStoryOrder(x: unknown): StoryOrderResult | null {
    const validated = validateStoryOrder(x) ?? salvageStoryOrder(x)
    if (validated === null) return null
    // Dedupe → sink generated-file steps to the end (lowest reading priority).
    const deduped = sinkGeneratedSteps(dedupeStorySteps(validated))
    if (deduped.steps.length === 0) return null
    const capped = deduped.steps.length > STORY_MAX_STEPS
      ? { steps: deduped.steps.slice(0, STORY_MAX_STEPS).map((s, i) => ({ ...s, index: i })) }
      : deduped
    return capped
  }

  // True when at least one step maps to a real PR file — mirrors InspectStep's
  // `storyHasUsableSteps` gate. A shaped story whose paths the model hallucinated
  // (none resolve to PR files) is NOT usable and triggers the structural fallback
  // exactly as an outright failure does. When prFilenames is empty (older pack
  // without storyFiles) we can't check mapping, so any shaped story counts.
  function storyHasUsableSteps(story: StoryOrderResult, prFilenames: readonly string[]): boolean {
    if (story.steps.length === 0) return false
    if (prFilenames.length === 0) return true
    return story.steps.some((s) => s.files.some((p) => matchStoryPath(p, prFilenames) !== null))
  }

  // PR filenames for the story task — the changed-file list from the compact
  // story summaries (all changed files, independent of the prompt budget).
  function storyPrFilenames(ctx: PackedContext): string[] {
    return (ctx.storyFiles ?? []).map((f) => f.path)
  }

  /**
   * Switch the story panel to the deterministic structural walkthrough (the
   * graceful degrade). Status becomes 'done' with a usable story + the fallback
   * flag/reason so the UI labels it. NEVER cached as an AI result (the cache only
   * stores successful AI ordering). No-op-safe: an empty PR yields empty steps,
   * which the consumer renders as "no walkthrough" rather than the hard error.
   */
  function applyStoryFallback(ctx: PackedContext, reason: string, trackReason: string): void {
    const prFilenames = storyPrFilenames(ctx)
    const story = buildDeterministicStory(prFilenames)
    storyState.status = 'done'
    storyState.value = story
    storyState.error = undefined
    storyState.errorDetail = undefined
    storyState.activity = undefined
    storyState.fallback = true
    storyState.fallbackReason = reason
    // Track only the coarse kind (not the full upstream detail) for privacy.
    track('ai_task_fallback', { task: 'story', reason: trackReason })
  }

  async function runStoryOrderTask(ctx: PackedContext): Promise<void> {
    // Story mode (Plan H): classify changed files into layers and emit an
    // ORDERED narrative sequence. Runs through the deep harness when set to
    // deep (verify ordering/test-pairing by reading deps), single-pass
    // otherwise — same branch shape as the other deep tasks.
    // Story is in the user-facing task matrix (Plan J follow-up): off →
    // 'disabled', zero tokens, no pack use, no cache read. Historically its
    // deep depth piggybacked on the VERDICT task's mode; the settings
    // migration carries that over for matrices stored before the story key
    // existed, so behavior is unchanged until the user opts out.
    const mode = resolveTaskMode('story', deepReview)
    if (!mode.run) {
      storyState.status = 'disabled'
      return
    }
    const deep = { enabled: mode.deep, note: mode.note }
    if (deep.note) storyState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'story|deep' : 'story', promptVersionFor('story'))

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<StoryOrderResult>>(key)
      if (hit !== null) {
        storyState.status = 'done'
        storyState.value = hit.result
        storyState.toolCallsUsed = hit.toolCallsUsed
        storyState.usage = hit.usage
        track('ai_task_completed', { task: 'story', duration_ms: Math.round(performance.now() - t0), cached: true, deep: true })
        return
      }
    } else {
      const hit = await getCached<StoryOrderResult>(key)
      if (hit !== null) {
        storyState.status = 'done'
        storyState.value = hit
        track('ai_task_completed', { task: 'story', duration_ms: Math.round(performance.now() - t0), cached: true })
        return
      }
    }

    storyState.status = 'loading'
    if (deep.enabled) storyState.activity = []
    const t1 = performance.now()
    const prompts = storyOrderPrompt(ctx, { deep: deep.enabled })

    try {
      let storyResult: StoryOrderResult
      let storyUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined

      if (deep.enabled) {
        const deepOutcome = await runDeepJson<StoryOrderResult>(prompts, shapeStoryOrder, (line) => {
          storyState.activity = [...(storyState.activity ?? []), line]
        })
        storyResult = deepOutcome.result
        storyUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<StoryOrderResult>(
          jsonTaskOpts(prompts),
          shapeStoryOrder,
        )
        storyResult = singlePass.result
        storyUsage = singlePass.usage
      }

      // "Unusable result" path: the AI returned a shaped story, but none of its
      // steps map to a real PR file (hallucinated paths). Degrade to the
      // deterministic structural walkthrough rather than rendering an empty
      // story — and do NOT cache it as an AI result.
      if (!storyHasUsableSteps(storyResult, storyPrFilenames(ctx))) {
        applyStoryFallback(ctx, 'AI ordering produced no usable steps', 'unusable-result')
        return
      }

      // Cache ONLY a usable AI result (never the deterministic fallback).
      if (deep.enabled) {
        await setCached<DeepCached<StoryOrderResult>>(key, { deep: true, result: storyResult, toolCallsUsed: toolCallsUsed ?? 0, usage: storyUsage })
      } else {
        await setCached<StoryOrderResult>(key, storyResult)
      }
      storyState.status = 'done'
      storyState.value = storyResult
      storyState.activity = undefined
      storyState.usage = storyUsage
      // Clear any stale fallback flag from a prior failed run (retry success).
      storyState.fallback = undefined
      storyState.fallbackReason = undefined
      storyState.error = undefined
      storyState.errorDetail = undefined
      if (toolCallsUsed !== undefined) storyState.toolCallsUsed = toolCallsUsed
      track('ai_task_completed', {
        task: 'story',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(storyUsage?.total_tokens !== undefined ? { tokens: storyUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      // Surface the SPECIFIC reason (mirrors #148): the friendly kind message as
      // the lead, plus the concrete detail (e.g. "maximum context length
      // exceeded …", "LLM produced invalid JSON after repair retry") when it
      // adds information — composed by describeTaskError, same as every task.
      // This reason is shown by the fallback note.
      const info = describeTaskError(err)
      const reason = info.errorDetail ? `${info.error} — ${info.errorDetail}` : info.error
      track('ai_task_failed', failureProps('story', info))
      // Robustness win: instead of the generic 'error' state, ALWAYS degrade to
      // the deterministic structural walkthrough so Story mode renders. The
      // specific reason rides along as fallbackReason for the muted UI note.
      applyStoryFallback(ctx, reason, info.kind)
    }
  }

  async function runRiskJudgeTask(ctx: PackedContext): Promise<void> {
    // LLM risk judge (PROMPT_VERSION 25): a single-pass task judging how much
    // REVIEWER ATTENTION the change deserves (0–3 + one-line rationale + up to
    // 5 risky snippets). Feeds the deterministic "Review effort" score as ONE
    // factor ("AI judgment") — the deterministic score NEVER blocks on it:
    // while this runs the factor renders pending; on error, unavailable.
    // In the user-facing task matrix (Plan J follow-up) with off/standard only:
    // off → 'disabled', zero tokens, no cache read. When it runs it is always
    // single-pass on the active model (never the multi-generator ensemble,
    // never the deep harness) — it is a cheap triage read, not a review task.
    if (!resolveTaskMode('riskJudge', deepReview).run) {
      riskJudgeState.status = 'disabled'
      return
    }
    const key = cacheKey(prKey, 'risk-judge', promptVersionFor('riskJudge'))

    const t0 = performance.now()
    const hit = await getCached<RiskJudgeResult>(key)
    if (hit !== null) {
      riskJudgeState.status = 'done'
      riskJudgeState.value = hit
      track('ai_task_completed', { task: 'risk-judge', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    riskJudgeState.status = 'loading'
    const t1 = performance.now()
    const prompts = riskJudgePrompt(ctx)

    try {
      const singlePass = await llmJsonWithRepairWithUsage<RiskJudgeResult>(
        jsonTaskOpts(prompts),
        validateRiskJudge,
      )
      await setCached<RiskJudgeResult>(key, singlePass.result)
      riskJudgeState.status = 'done'
      riskJudgeState.value = singlePass.result
      riskJudgeState.usage = singlePass.usage
      track('ai_task_completed', {
        task: 'risk-judge',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(singlePass.usage?.total_tokens !== undefined ? { tokens: singlePass.usage.total_tokens } : {}),
      })
    } catch (err) {
      failTask(riskJudgeState, 'risk-judge', err)
    }
  }

  // Intent post-process: strict-validate → per-collection salvage (drop
  // malformed elements, keep the rest; unknown intentId refs dropped; a bad
  // significance degrades to 'minor'). Returns null only when NOTHING usable
  // survives — the caller then takes the error path. Mirrors shapeAlternatives:
  // passed as the validator to the transport so the salvage applies on every
  // parse, including the repair pass.
  function shapeIntentCheck(x: unknown): IntentCheckResult | null {
    return validateIntentCheck(x) ?? salvageIntentCheck(x)
  }

  async function runIntentTask(ctx: PackedContext): Promise<void> {
    // Intent-vs-implementation check: reads the PR description as the STATED
    // intent and verifies the diff against it. In the user-facing task matrix
    // with off|standard only — always single-pass on the active model (a
    // tool-verified deep mode is a future candidate, not built). Mode-gated
    // (#113/#219 idiom): off → 'disabled', zero tokens, no cache read.
    if (!resolveTaskMode('intent', deepReview).run) {
      intentState.status = 'disabled'
      return
    }

    // Skip-when-empty: a null/blank/template-noise-only description states no
    // checkable intent — deliberately DO NOT call the LLM (zero tokens). The
    // distinct 'skipped' status renders the calm "No stated intent to check —
    // the PR description is empty." panel state (never an error).
    const title = meta?.title ?? ''
    const body = meta?.body ?? null
    if (!hasMeaningfulIntent(body)) {
      intentState.status = 'skipped'
      return
    }

    // Cache key folds a hash of the STATED intent (title + full raw body —
    // pre-truncation, so ANY description edit invalidates) into the task
    // segment, like the convergence/skill content hashes. The diff side is
    // covered by prKey (it carries the head SHA): "<pr>|intent:<djb2>|v<N>".
    const key = cacheKey(prKey, 'intent:' + djb2(`${title}\n${body}`), promptVersionFor('intent'))

    const t0 = performance.now()
    const hit = await getCached<IntentCheckResult>(key)
    if (hit !== null) {
      intentState.status = 'done'
      intentState.value = hit
      track('ai_task_completed', { task: 'intent', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    intentState.status = 'loading'
    const t1 = performance.now()
    const prompts = intentPrompt(ctx, { title, body: body as string })

    try {
      const singlePass = await llmJsonWithRepairWithUsage<IntentCheckResult>(
        jsonTaskOpts(prompts),
        shapeIntentCheck,
      )
      await setCached<IntentCheckResult>(key, singlePass.result)
      intentState.status = 'done'
      intentState.value = singlePass.result
      intentState.usage = singlePass.usage
      track('ai_task_completed', {
        task: 'intent',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(singlePass.usage?.total_tokens !== undefined ? { tokens: singlePass.usage.total_tokens } : {}),
      })
    } catch (err) {
      failTask(intentState, 'intent', err)
    }
  }

  // ---------------------------------------------------------------------------
  // Deep review helpers (Plan G part 2)
  //
  // Deep results cache under a key whose task segment carries a '|deep'
  // marker (+ the task's prompt version as usual) so deep and single-pass outputs never
  // collide. The cached value wraps the result with toolCallsUsed so the
  // "verified with N tool calls" footer survives cache hits. Partial loops
  // are NEVER cached: setCached only runs after successful validation.
  // ---------------------------------------------------------------------------

  interface DeepCached<T> {
    deep: true
    result: T
    toolCallsUsed: number
    /**
     * Usage captured for the deep run, stored so the opt-in token footer
     * survives cache hits. Optional: entries cached before usage was stored
     * simply omit it (footer shows nothing for that task — never fabricated).
     */
    usage?: LlmUsage
  }

  function sumUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
    if (!a) return b
    if (!b) return a
    return {
      prompt_tokens: a.prompt_tokens + b.prompt_tokens,
      completion_tokens: a.completion_tokens + b.completion_tokens,
      total_tokens: a.total_tokens + b.total_tokens,
    }
  }

  /**
   * Completeness guard (Plan G anti-lazy-loop). A deep task can declare "done"
   * having explored nothing — emitting code-dependent claims it never verified.
   * When `completeness` is supplied, runDeepJson checks the loop's FIRST answer:
   * if it used ZERO tool calls on a NON-TRIVIAL change AND the output makes a
   * claim that depends on code (per the task's predicate), it nudges the loop
   * ONCE to read the relevant file(s) or state confidence, then re-runs the
   * loop. The re-run shares the SAME toolkit, so its tool calls keep counting
   * against the same per-task budget (the nudge cannot blow the budget) and its
   * fetches reuse the shared cache.
   *
   * Heuristic (deliberately conservative — never forces tools on trivial work):
   *  - ZERO tool calls only (any verification already breaks the lazy pattern).
   *  - `nonTrivial` gates out tiny changes (e.g. ≤1 changed file) where reading
   *    isn't warranted.
   *  - `outputClaimsCode(result)` must be true: the answer asserts something
   *    about code (e.g. a verdict with evidence, a finding) rather than the
   *    silent "no issues" outcome. A clean "nothing to flag" answer is NOT
   *    nudged.
   * At most ONE nudge per task.
   */
  interface CompletenessGuard<T> {
    nonTrivial: boolean
    outputClaimsCode: (result: T) => boolean
  }

  const COMPLETENESS_NUDGE =
    'You finalized WITHOUT using any verification tools, yet your answer makes ' +
    'claims that depend on code not shown in the diff. Before finalizing, read ' +
    'the relevant file(s) with the tools to confirm those claims — or, if you ' +
    'are confident without reading them, drop any claim you cannot stand behind ' +
    'and restate your answer. Respond with the JSON only.'

  /**
   * Run one deep (agentic) JSON task: tool loop → validate → at most one
   * single-pass repair grounded in the loop's tool-verified output.
   */
  async function runDeepJson<T>(
    prompts: { system: string; user: string },
    validate: (x: unknown) => T | null,
    onActivity: (line: string) => void,
    completeness?: CompletenessGuard<T>,
    cfg?: ProviderConfig,
  ): Promise<{ result: T; usage?: LlmUsage; toolCallsUsed: number }> {
    // The toolkit shares the per-review deepCache, so file reads/searches are
    // reused across tasks AND across deep-multigen generators (each generator
    // creates its own toolkit but they hit the same cache — a file read once is
    // not refetched per generator).
    const toolkit = createDeepReviewToolkit(deepReview!, deepCache)
    const system = withDeepReviewGuidance(prompts.system, toolkit.tools.map((t) => t.name))
    // Deep multi-gen: route each generator's deep loop to its OWN provider/model
    // via the override. Omitted (undefined) → the loop runs on the active config
    // (byte-identical to every existing single-generator deep task).
    const override = cfg
      ? (() => {
          const provider = getProvider(cfg.providerId)
          return provider ? { provider, model: cfg.model } : undefined
        })()
      : undefined
    const baseOpts = {
      system,
      tools: toolkit.tools,
      executeTool: toolkit.executeTool,
      humanize: toolkit.humanize,
      maxToolCalls: DEEP_REVIEW_MAX_TOOL_CALLS,
      onToolEvent: (ev: { detail: string }) => onActivity(ev.detail),
      ...(override ? { override } : {}),
    }

    let loop = await llmToolLoop({ ...baseOpts, user: prompts.user })
    let usage = loop.usage
    let toolCallsUsed = loop.toolCallsUsed

    // Completeness nudge (at most once): a zero-tool finalize that still claims
    // code → re-run with a nudge. Only when the first answer parses to a valid
    // code-claiming result (a broken answer goes to the repair pass below).
    if (completeness && completeness.nonTrivial && loop.toolCallsUsed === 0) {
      let firstValid: T | null = null
      try {
        firstValid = validate(JSON.parse(loop.content) as unknown)
      } catch {
        firstValid = null
      }
      if (firstValid !== null && completeness.outputClaimsCode(firstValid)) {
        onActivity('Double-checking — no files were read for a code-dependent claim…')
        const nudged = await llmToolLoop({
          ...baseOpts,
          user: `${prompts.user}\n\n${COMPLETENESS_NUDGE}`,
        })
        loop = nudged
        usage = sumUsage(usage, nudged.usage)
        // Total tool calls across both passes (toolkit budget is shared, so the
        // re-run cannot exceed the per-task cap — accounting stays honest).
        toolCallsUsed += nudged.toolCallsUsed
      }
    }

    try {
      const valid = validate(JSON.parse(loop.content) as unknown)
      if (valid !== null) return { result: valid, usage, toolCallsUsed }
    } catch {
      // fall through to the repair pass
    }

    // Repair: reformat the already-verified answer — no tools needed. When a
    // provider override is in play (deep multi-gen) the repair runs on THAT
    // generator's provider so the reformat tokens are attributed to it; the
    // active-config path keeps using llmJsonWithRepairWithUsage (unchanged).
    const repairPrompts = {
      system: prompts.system,
      user:
        `${prompts.user}\n\nYou already analyzed this PR (with verification tools) and answered:\n` +
        `${loop.content}\n` +
        'Reformat that answer as valid JSON exactly matching the required shape. ' +
        'Do not change the verified content. Respond with the JSON only.',
    }
    const repaired = cfg
      ? await llmJsonWithRepairFor<T>(cfg, repairPrompts, validate)
      : await llmJsonWithRepairWithUsage<T>(repairPrompts, validate)
    return {
      result: repaired.result,
      usage: sumUsage(usage, repaired.usage),
      toolCallsUsed,
    }
  }

  async function runVerdictTask(ctx: PackedContext, ciData: CiSummary | null): Promise<void> {
    const mode = resolveTaskMode('verdict', deepReview)
    if (!mode.run) {
      verdictState.status = 'disabled'
      return
    }
    const deep = { enabled: mode.deep, note: mode.note }
    if (deep.note) verdictState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'verdict|deep' : 'verdict', promptVersionFor('verdict'))
    // Companion entry holding the per-model breakdown (Plan N), keyed off the
    // SAME content hash with a '|models' discriminant so it never collides with
    // the result entry. Persisted alongside the verdict result and restored on a
    // cache hit so the Step-3 cost+performance table survives a re-opened PR.
    const verdictModelsKey = cacheKey(prKey, (deep.enabled ? 'verdict|deep' : 'verdict') + '|models', promptVersionFor('verdict'))

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<VerdictResult>>(key)
      if (hit !== null) {
        verdictState.status = 'done'
        verdictState.value = hit.result
        verdictState.toolCallsUsed = hit.toolCallsUsed
        verdictState.usage = hit.usage
        verdictModelsState = (await getCached<VerdictModelBreakdown[]>(verdictModelsKey)) ?? []
        track('ai_task_completed', { task: 'verdict', duration_ms: Math.round(performance.now() - t0), cached: true, deep: true })
        return
      }
    } else {
      const hit = await getCached<VerdictResult>(key)
      if (hit !== null) {
        verdictState.status = 'done'
        verdictState.value = hit
        verdictModelsState = (await getCached<VerdictModelBreakdown[]>(verdictModelsKey)) ?? []
        track('ai_task_completed', { task: 'verdict', duration_ms: Math.round(performance.now() - t0), cached: true })
        return
      }
    }

    verdictState.status = 'loading'
    if (deep.enabled) verdictState.activity = []
    const t1 = performance.now()
    const prompts = verdictPrompt(ctx, ciData)

    try {
      let verdictResult: VerdictResult
      let verdictUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined
      // Assigned in EITHER the fusion branch OR the !fusionHandled block below
      // (the two are mutually exclusive and exhaustive); the definite-assignment
      // assertion tells TS that, since it can't prove it across the two blocks.
      let finalResult!: VerdictResult
      let fusionHandled = false

      // Plan P 'generate' mode: every configured generator produces a verdict
      // independently; their EVIDENCE is unioned + cross-confirmed (recall) and
      // each generator gets a generator row. The holistic `level` is the primary
      // generator's. Runs in BOTH shallow and DEEP mode (each generator deep-
      // generates through its own tool loop) so a configured generator is NEVER
      // silently demoted to a verifier — honoring the user's configured roles.
      if (fusionGenerateEffective()) {
        const fused = await fuseVerdict(prompts, ctx, deep.enabled, (line) => {
          verdictState.activity = [...(verdictState.activity ?? []), line]
        })
        if (fused) {
          finalResult = fused.result
          verdictUsage = fused.usage
          verdictModelsState = fused.models
          fusionHandled = true
        }
      }

      if (!fusionHandled) {
      if (deep.enabled) {
        const deepOutcome = await runDeepJson<VerdictResult>(prompts, validateVerdict, (line) => {
          verdictState.activity = [...(verdictState.activity ?? []), line]
        }, {
          // Non-trivial = the PR touches more than one file (a single tiny file
          // doesn't warrant forcing a read). A verdict that lists evidence is
          // making code-dependent claims.
          nonTrivial: ctx.includedFiles.length > 1,
          outputClaimsCode: (r) => r.evidence.length > 0,
        })
        verdictResult = deepOutcome.result
        verdictUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<VerdictResult>(
          jsonTaskOpts(prompts),
          validateVerdict,
        )
        verdictResult = singlePass.result
        verdictUsage = singlePass.usage
      }

      // Merge notAnalyzed: union of packed context's notAnalyzed + model's own list (EC-15c)
      const merged = [...new Set([...ctx.notAnalyzed, ...verdictResult.notAnalyzed])]
      finalResult = { ...verdictResult, notAnalyzed: merged }

      // Generator usage captured BEFORE folding in verifier usage (Plan N
      // per-model cost attributes generation tokens to the generator model).
      // Hoisted out of the cross-verify block so the verdict's generator row is
      // ALWAYS recorded (consolidated cost panel), even on an evidence-free or
      // single-model verdict. The fuller breakdown below REPLACES this baseline
      // with generator + verifier rows when evidence got cross-verified.
      const generatorUsage = verdictUsage
      verdictModelsState = buildVerdictModels(generatorUsage, 0, [], [])

      // Cross-model verification (Plan M): judge each evidence row adversarially.
      // Short-circuit (byte-identical) when not effective. Evidence rows carry a
      // path token where possible; rows without one are still judged on text.
      if (crossModelVerifyEffective()) {
      const evidenceFindings: FindingToVerify[] = finalResult.evidence.map((bullet, i) => ({
        id: `ev:${i}`,
        path: extractEvidencePath(bullet) ?? '(no file)',
        line: null,
        severity: 'medium' as const,
        body: bullet,
        side: 'RIGHT' as const,
      }))
      const verdictVerify = await verifyFindingSet(evidenceFindings, (line) => {
        verdictState.activity = [...(verdictState.activity ?? []), line]
      })
      if (verdictVerify.byId.size > 0) {
        const evidenceVerification: Record<number, import('./schemas').FindingVerification> = {}
        let surfacedCount = 0
        finalResult.evidence.forEach((_, i) => {
          const v = verdictVerify.byId.get(`ev:${i}`)
          if (v) {
            evidenceVerification[i] = v
            if (v.surfaced) surfacedCount += 1
          }
        })
        finalResult = { ...finalResult, evidenceVerification }
        verdictUsage = addUsage(verdictUsage, verdictVerify.usage)

        // Per-model cost + impact breakdown for step 3 (Plan N).
        verdictModelsState = buildVerdictModels(generatorUsage, surfacedCount, verdictVerify.perModelUsage, verdictVerify.verifierImpact)
      }
      }
      } // end if (!fusionHandled)

      if (deep.enabled) {
        await setCached<DeepCached<VerdictResult>>(key, { deep: true, result: finalResult, toolCallsUsed: toolCallsUsed ?? 0, usage: verdictUsage })
      } else {
        await setCached<VerdictResult>(key, finalResult)
      }
      // Persist the per-model breakdown so a future cache hit can repopulate the
      // Step-3 cost+performance table (verdictModelsState is already built above).
      await setCached<VerdictModelBreakdown[]>(verdictModelsKey, verdictModelsState)
      verdictState.status = 'done'
      verdictState.value = finalResult
      verdictState.activity = undefined
      verdictState.usage = verdictUsage
      if (toolCallsUsed !== undefined) verdictState.toolCallsUsed = toolCallsUsed
      track('ai_task_completed', {
        task: 'verdict',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(verdictUsage?.total_tokens !== undefined ? { tokens: verdictUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      failTask(verdictState, 'verdict', err)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: set all panels to the same status (no-key / declined / error)
  // ---------------------------------------------------------------------------

  function setAllPanels(status: 'no-key' | 'declined' | 'error', error?: string): void {
    // Plan J: an OFF task wins — it shows 'disabled' (no tokens were ever going
    // to be spent on it) even when the whole run is no-key/declined/error.
    // Story and the risk judge are in the task matrix too, so they get the
    // same off-wins treatment.
    const apply = (task: AiTaskId, state: PanelState<unknown>): void => {
      if (getSettings().aiTaskModes[task] === 'off') {
        state.status = 'disabled'
        return
      }
      state.status = status
      if (error !== undefined) state.error = error
    }
    apply('summary', summaryState)
    apply('attention', attentionState)
    apply('diagrams', diagramsState)
    apply('verdict', verdictState)
    apply('tests', testsState)
    apply('alternatives', alternativesState)
    apply('intent', intentState)
    apply('story', storyState)
    apply('riskJudge', riskJudgeState)
  }

  // ---------------------------------------------------------------------------
  // Internal: get or obtain packed context
  // ---------------------------------------------------------------------------

  async function getPackedContext(): Promise<PackedContext | null> {
    if (packedCtx !== null) return packedCtx
    try {
      const ctx = await pack()
      packedCtx = ctx
      return ctx
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setAllPanels('error', `Couldn't prepare PR context: ${msg}`)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // start()
  // ---------------------------------------------------------------------------

  async function start(): Promise<void> {
    // No-key check: if the ACTIVE provider has no key, set all panels to
    // 'no-key' (EC-12a). Do this before consent dialog — no point asking
    // consent if there's no key.
    if (!activeProviderHasKey()) {
      setAllPanels('no-key')
      return
    }

    // Consent gate (EC-11c): declined → all 'declined', no AI calls
    const allowed = await gateAi({ repo, isPrivate, ask: askConsent })
    if (!allowed) {
      setAllPanels('declined')
      return
    }

    // Plan J: if EVERY auto task (incl. story + the risk judge, which are in
    // the matrix too) is turned off, there is nothing to pack or run. Avoid
    // the pack()/ci() work entirely (cheap token/time win) and mark each
    // panel disabled.
    const modes = getSettings().aiTaskModes
    const allAutoOff =
      modes.summary === 'off' &&
      modes.attention === 'off' &&
      modes.diagrams === 'off' &&
      modes.tests === 'off' &&
      modes.alternatives === 'off' &&
      modes.verdict === 'off' &&
      modes.intent === 'off' &&
      modes.story === 'off' &&
      modes.riskJudge === 'off'
    if (allAutoOff) {
      summaryState.status = 'disabled'
      attentionState.status = 'disabled'
      diagramsState.status = 'disabled'
      testsState.status = 'disabled'
      alternativesState.status = 'disabled'
      verdictState.status = 'disabled'
      intentState.status = 'disabled'
      storyState.status = 'disabled'
      riskJudgeState.status = 'disabled'
      return
    }

    // Pack context + fetch CI in parallel
    // Pack failure → all 'error' (handled inside getPackedContext)
    const [ctx, ciData] = await Promise.all([
      getPackedContext(),
      ci().catch(() => null), // CI failure is non-fatal — verdict just gets null
    ])

    if (ctx === null) {
      // Pack failed — error state already set in getPackedContext
      return
    }

    // Run all six tasks in parallel, each isolated (EC-12c / EC-13g)
    await Promise.all([
      runSummaryTask(ctx),
      runAttentionTask(ctx),
      runDiagramsTask(ctx),
      runTestsTask(ctx),
      runAlternativesTask(ctx),
      runIntentTask(ctx),
      runStoryOrderTask(ctx),
      runRiskJudgeTask(ctx),
      runVerdictTask(ctx, ciData),
    ])
  }

  // ---------------------------------------------------------------------------
  // retry(task) — re-runs exactly one task
  // ---------------------------------------------------------------------------

  async function retry(task: TaskName): Promise<void> {
    // Re-use the already-packed context if available; re-pack if pack failed
    const ctx = await getPackedContext()
    if (ctx === null) return // pack failed again — error state set inside

    // For verdict, we need CI data. Fetch it fresh on retry.
    if (task === 'verdict') {
      const ciData = await ci().catch(() => null)
      return runVerdictTask(ctx, ciData)
    }
    if (task === 'summary') return runSummaryTask(ctx)
    if (task === 'attention') return runAttentionTask(ctx)
    if (task === 'diagrams') return runDiagramsTask(ctx)
    if (task === 'tests') return runTestsTask(ctx)
    if (task === 'alternatives') return runAlternativesTask(ctx)
    if (task === 'intent') return runIntentTask(ctx)
    if (task === 'story') return runStoryOrderTask(ctx)
    if (task === 'riskJudge') return runRiskJudgeTask(ctx)
  }

  // ---------------------------------------------------------------------------
  // coach(drafts) — on-demand, never cached, never run in start()
  // ---------------------------------------------------------------------------

  async function coach(
    drafts: Draft[],
    prComments?: string[],
    verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  ): Promise<CoachOutcome | { error: string; errorDetail?: string }> {
    // No-key check: same early-exit as start()
    if (!activeProviderHasKey()) {
      return { error: humanMessage('no-key') }
    }

    // Consent gate: private repos may quote code in comments (same gateAi / shared ask)
    const allowed = await gateAi({ repo, isPrivate, ask: askConsent })
    if (!allowed) {
      return { error: 'AI analysis was declined. Enable AI analysis in the consent dialog to use the comment coach.' }
    }

    // Map drafts to the coachPrompt input shape. index = ORIGINAL array
    // position — preserved across chunk boundaries so the merged result maps
    // back to drafts by index regardless of how the chunks split.
    const draftInputs = drafts.map((d, i) => ({
      index: i,
      path: d.path,
      line: d.line,
      body: d.body,
    }))

    // Per-comment code context (v16): the actual code at each comment's
    // file:line so the coach can verify rather than default to "cannot verify".
    // Best-effort — never block coaching if context building throws. This is the
    // grounding now; we no longer pack/send the full prContext (it was largely
    // redundant with the per-comment excerpt + file window and bloated the
    // prompt — dropping it is what keeps each chunk comfortably within limits).
    let codeContexts: CoachCodeContext[] | undefined
    if (coachCodeContext) {
      try {
        codeContexts = coachCodeContext(drafts)
      } catch {
        codeContexts = undefined
      }
    }
    const codeByIndex = new Map<number, CoachCodeContext>()
    for (const cc of codeContexts ?? []) codeByIndex.set(cc.index, cc)

    // Split into bounded chunks — each chunk is its own LLM call carrying ONLY
    // that chunk's drafts + their code context. A ~30-comment review that used
    // to blow a single prompt is now several small prompts.
    const chunks = chunk(draftInputs, COACH_CHUNK_SIZE)
    const t1 = performance.now()

    // Coach ONE chunk. Returns its CoachResult, or an error kind + the original
    // draft indices it covered (so failures are accounted for, never dropped).
    // verdict coherence is a run-level signal: only the first chunk is asked for
    // it (asking every chunk would yield N conflicting answers).
    async function coachChunk(
      chunkDrafts: typeof draftInputs,
      chunkIndex: number,
    ): Promise<ChunkOutcome & { usage?: LlmUsage }> {
      const chunkContexts = chunkDrafts
        .map((d) => codeByIndex.get(d.index))
        .filter((cc): cc is CoachCodeContext => cc !== undefined)
      const prompts = coachPrompt(chunkDrafts, prComments, {
        ...(verdict !== undefined && chunkIndex === 0 ? { verdict } : {}),
        ...(chunkContexts.length > 0 ? { codeContexts: chunkContexts } : {}),
      })
      try {
        const { result, usage } = await llmJsonWithRepairWithUsage<CoachResult>(
          jsonTaskOpts(prompts),
          validateCoachResult,
        )
        return { ok: true, result, usage }
      } catch (err) {
        // describeTaskError composes kind + concrete detail with the SAME rules
        // as every task catch (status prefix, retried-automatically suffix).
        const info = describeTaskError(err)
        return {
          ok: false,
          kind: info.kind,
          indices: chunkDrafts.map((d) => d.index),
          ...(info.errorDetail ? { detail: info.errorDetail } : {}),
        }
      }
    }

    // Bounded concurrency: a few chunks at a time, not all at once, so a big
    // review doesn't trip provider rate limits.
    const chunkResults = await mapWithConcurrency(
      chunks,
      COACH_CHUNK_CONCURRENCY,
      (chunkDrafts, i) => coachChunk(chunkDrafts, i),
    )

    // Sum usage across every chunk that reported it.
    let usage: LlmUsage | undefined
    for (const r of chunkResults) usage = sumUsage(usage, r.usage)
    coachUsage = usage

    const merged = mergeChunkOutcomes(chunkResults)

    // Every chunk failed → no partial result to show; surface the error so the
    // UI takes the error path (with retry), same as the old single-call coach.
    // The failing chunk's concrete detail rides along for tooltips/analytics.
    if (merged.reviews.length === 0 && merged.failedIndices.length > 0) {
      const kind = merged.failureKind ?? 'unknown'
      const info: TaskErrorInfo = {
        kind,
        error: humanMessage(kind),
        ...(merged.failureDetail ? { errorDetail: merged.failureDetail } : {}),
      }
      track('ai_task_failed', failureProps('coach', info))
      return { error: info.error, ...(info.errorDetail ? { errorDetail: info.errorDetail } : {}) }
    }

    track('ai_task_completed', {
      task: 'coach',
      duration_ms: Math.round(performance.now() - t1),
      cached: false,
      chunks: chunks.length,
      ...(merged.failedIndices.length > 0 ? { partial: true } : {}),
      ...(usage?.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
    })

    const result: CoachOutcome = {
      reviews: merged.reviews,
      ...(merged.verdictCoherence !== undefined ? { verdictCoherence: merged.verdictCoherence } : {}),
      ...(usage ? { usage } : {}),
    }
    // Partial run: account for the comments we couldn't coach with an honest note.
    if (merged.failedIndices.length > 0) {
      const reason = humanMessage(merged.failureKind ?? 'unknown')
      const n = merged.failedIndices.length
      track('ai_task_failed', {
        ...failureProps('coach', {
          kind: merged.failureKind ?? 'unknown',
          error: reason,
          ...(merged.failureDetail ? { errorDetail: merged.failureDetail } : {}),
        }),
        partial: true,
      })
      result.notCoached = {
        indices: merged.failedIndices,
        message: `Couldn't coach ${n} comment${n === 1 ? '' : 's'} (${reason}) — retry to grade ${n === 1 ? 'it' : 'them'}.`,
        ...(merged.failureDetail ? { detail: merged.failureDetail } : {}),
      }
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // ask(question, onDelta) — on-demand free-form Q&A, never cached
  // Maintains internal history of last 3 exchanges in the run instance.
  // ---------------------------------------------------------------------------

  // Internal conversation history for this run instance
  const askHistory: { q: string; a: string }[] = []

  async function ask(
    question: string,
    onDelta: (t: string) => void,
    focus?: AskFocus,
  ): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
    // No-key check: same early-exit as start() and coach()
    if (!activeProviderHasKey()) {
      return { ok: false, error: humanMessage('no-key') }
    }

    // Consent gate: same gateAi / shared ask
    const allowed = await gateAi({ repo, isPrivate, ask: askConsent })
    if (!allowed) {
      return { ok: false, error: 'AI analysis was declined. Enable AI analysis to use Ask AI.' }
    }

    // Pack context if not already packed (best-effort — if pack fails, carry on without it)
    if (packedCtx === null) {
      try {
        packedCtx = await pack()
      } catch {
        // Continue without packed context — use empty context
        packedCtx = { text: '', notAnalyzed: [], includedFiles: [], importGraph: '' }
      }
    }

    // Pass previous exchanges to askPrompt (last ≤3 Q/A pairs).
    // Run stores up to 3 completed exchanges; passing them gives the LLM context.
    const prompts = askPrompt(packedCtx, askHistory, question, focus)
    const t1 = performance.now()

    try {
      const askStreamResult = await llmStreamWithUsage(prompts, onDelta)
      // Store exchange in history; shift oldest out so we keep at most 3
      askHistory.push({ q: question, a: askStreamResult.content })
      while (askHistory.length > 3) askHistory.shift()
      track('ai_task_completed', {
        task: 'ask',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(askStreamResult.usage?.total_tokens !== undefined ? { tokens: askStreamResult.usage.total_tokens } : {}),
      })
      return { ok: true, answer: askStreamResult.content }
    } catch (err) {
      const info = describeTaskError(err)
      track('ai_task_failed', failureProps('ask', info))
      return { ok: false, error: info.error }
    }
  }

  // ---------------------------------------------------------------------------
  // expandComment(note, onDelta, focus) — terse note → full review comment
  //
  // On-demand and never cached, like ask(). Streams via onDelta (same
  // transport). Grounded in the REAL code at the comment's anchor through the
  // verifyCodeContext input (buildCoachCodeContext — the same source the coach
  // and cross-model verification use). The UI previews the result; the
  // reviewer's note is never silently replaced.
  // ---------------------------------------------------------------------------

  /**
   * Accumulated token usage across every expansion in this run. Folded into
   * totalUsage (and the cost breakdown as 'Expand') so the per-PR total
   * includes expansion cost — same idiom as coachUsage. Accumulates (not
   * overwrites): each expansion is an independent paid call.
   */
  let expandUsage = $state<LlmUsage | undefined>(undefined)

  async function expandComment(
    note: string,
    onDelta: (t: string) => void,
    focus: { path: string; line: number; side: 'LEFT' | 'RIGHT' },
  ): Promise<{ ok: true; comment: string } | { ok: false; error: string; errorDetail?: string }> {
    // No-key check: same early-exit as ask()
    if (!activeProviderHasKey()) {
      return { ok: false, error: humanMessage('no-key') }
    }

    // Consent gate: same gateAi / shared ask
    const allowed = await gateAi({ repo, isPrivate, ask: askConsent })
    if (!allowed) {
      return { ok: false, error: 'AI analysis was declined. Enable AI analysis to expand notes.' }
    }

    // Code at the comment's anchor — best-effort (a throwing/absent provider
    // just means the expansion grounds on the note alone).
    let codeCtx: CoachCodeContext | undefined
    try {
      codeCtx = verifyCodeContext?.([focus])?.[0]
    } catch {
      codeCtx = undefined
    }

    const prompts = expandCommentPrompt(note, {
      path: focus.path,
      line: focus.line,
      side: focus.side,
      excerpt: codeCtx?.excerpt ?? '',
      ...(codeCtx?.fileWindow ? { fileWindow: codeCtx.fileWindow } : {}),
    })
    const t1 = performance.now()

    try {
      const streamResult = await llmStreamWithUsage(prompts, onDelta)
      if (streamResult.usage) expandUsage = addUsage(expandUsage, streamResult.usage)
      track('ai_task_completed', {
        task: 'expand',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(streamResult.usage?.total_tokens !== undefined ? { tokens: streamResult.usage.total_tokens } : {}),
      })
      return { ok: true, comment: streamResult.content.trim() }
    } catch (err) {
      const info = describeTaskError(err)
      track('ai_task_failed', failureProps('expand', info))
      return { ok: false, error: info.error, ...(info.errorDetail ? { errorDetail: info.errorDetail } : {}) }
    }
  }

  // ---------------------------------------------------------------------------
  // runSkillReviews() — on-demand, NOT called in start()
  //
  // For each enabled skill: isolated parallel run with content-hash cache key.
  // Gated once: no-key + consent check (shared gateAi/ask pattern).
  // ---------------------------------------------------------------------------

  /**
   * Execute ONE skill review and write its outcome into skillReviewsState[idx].
   * Shared by the batch runSkillReviews() and the per-skill retrySkill() so a
   * retry goes through the EXACT same cache-miss path (errors are never cached,
   * so a re-run re-hits the LLM). Mutates only entry [idx] — sibling reviews and
   * drafts are untouched. Assumes the entry at [idx] is already in loading state.
   */
  /**
   * Retry-After observed for each reviewer entry's LAST failed attempt (by
   * entry index). Written by executeSkillReview's catch when the failure was a
   * rate limit carrying Retry-After; cleared at the start of every attempt.
   * Read by the auto-retry loop to pace the next round (autoRetryDelayMs).
   */
  const reviewerRetryAfterMs = new Map<number, number>()

  async function executeSkillReview(
    ctx: PackedContext,
    skill: { id: string; name: string; content: string },
    idx: number,
    deep: { enabled: boolean; note?: string },
    onUpdate?: () => void,
    existingComments?: string[],
  ): Promise<void> {
    // Fresh attempt: any Retry-After from a PRIOR attempt is stale.
    reviewerRetryAfterMs.delete(idx)
    // Content-addressed cache key: includes djb2(skill.content).
    // Deep runs carry a '|deep' marker so they never collide with
    // single-pass results for the same skill content.
    const key = cacheKey(prKey, 'skill:' + djb2(skill.content) + (deep.enabled ? '|deep' : ''), promptVersionFor('skills'))
    // Companion entry holding this reviewer's per-model breakdown (Plan N),
    // keyed off the SAME content hash with a '|models' discriminant. Persisted
    // alongside the skill result and restored on a cache hit so the Step-3 cost+
    // performance table is repopulated for a previously-reviewed PR.
    const skillModelsKey = cacheKey(prKey, 'skill:' + djb2(skill.content) + (deep.enabled ? '|deep' : '') + '|models', promptVersionFor('skills'))

    const t0 = performance.now()

    // Cache check
    if (deep.enabled) {
      const hit = await getCached<DeepCached<SkillReviewResult>>(key)
      if (hit !== null) {
        const models = await getCached<VerdictModelBreakdown[]>(skillModelsKey)
        skillReviewsState[idx] = {
          skillId: skill.id,
          name: skill.name,
          state: { status: 'done', value: hit.result, toolCallsUsed: hit.toolCallsUsed, ...(hit.usage ? { usage: hit.usage } : {}), ...(models && models.length ? { models } : {}) },
        }
        track('ai_task_completed', {
          task: 'skill-review',
          duration_ms: Math.round(performance.now() - t0),
          cached: true,
          deep: true,
        })
        onUpdate?.()
        return
      }
    } else {
      const hit = await getCached<SkillReviewResult>(key)
      if (hit !== null) {
        const models = await getCached<VerdictModelBreakdown[]>(skillModelsKey)
        skillReviewsState[idx] = {
          skillId: skill.id,
          name: skill.name,
          state: { status: 'done', value: hit, ...(deep.note ? { note: deep.note } : {}), ...(models && models.length ? { models } : {}) },
        }
        track('ai_task_completed', {
          task: 'skill-review',
          duration_ms: Math.round(performance.now() - t0),
          cached: true,
        })
        onUpdate?.()
        return
      }
    }

    const prompts = skillReviewPrompt(ctx, { name: skill.name, content: skill.content }, existingComments)

    try {
      let skillResult: SkillReviewResult = { skillName: skill.name, findings: [] }
      let skillUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined
      let skillModels: VerdictModelBreakdown[] | undefined

      // Plan O/P 'generate' mode: every configured GENERATOR generates this skill
      // review independently; the union is dedup-merged and cross-confirmed so a
      // real finding only one model caught can still surface (recall). Runs in
      // BOTH shallow and DEEP mode (each generator deep-generates through its own
      // tool loop) so a configured generator is NEVER silently demoted to a
      // verifier — honoring the user's configured roles.
      let fusionHandled = false
      if (fusionGenerateEffective()) {
        const fused = await fuseSkillReview(prompts, skill.name, idx, deep.enabled, onUpdate)
        if (fused) {
          skillResult = fused.result
          skillUsage = fused.usage
          skillModels = fused.models
          fusionHandled = true
        }
      }

      if (!fusionHandled) {
      if (deep.enabled) {
        const deepOutcome = await runDeepJson<SkillReviewResult>(prompts, validateSkillReviewResult, (line) => {
          const entry = skillReviewsState[idx]
          entry.state = { ...entry.state, activity: [...(entry.state.activity ?? []), line] }
          onUpdate?.()
        }, {
          // A skill review that surfaces findings is making code-dependent
          // claims; non-trivial when the PR touches more than one file.
          nonTrivial: ctx.includedFiles.length > 1,
          outputClaimsCode: (r) => r.findings.length > 0,
        })
        skillResult = deepOutcome.result
        skillUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<SkillReviewResult>(
          jsonTaskOpts(prompts),
          validateSkillReviewResult,
        )
        skillResult = singlePass.result
        skillUsage = singlePass.usage
      }

      // Cross-model verification (Plan M): adversarially judge each finding with
      // the user's OTHER providers. Short-circuit (byte-identical) when not
      // effective — no array build, no verifier call.
      // Per-model cost+impact breakdown (Plan N) — populated only when an
      // ensemble of >1 model actually verified this reviewer's findings.
      if (crossModelVerifyEffective()) {
      // Generator usage captured BEFORE folding in verifier usage so the
      // per-model cost attributes generation tokens to the generator model.
      const generatorUsage = skillUsage
      const verifyOutcome = await verifyFindingSet(
        skillResult.findings.map((f) => ({
          id: `${f.path}:${f.line}:${djb2(f.body)}`,
          path: f.path,
          line: f.line,
          severity: f.severity,
          body: f.body,
          side: 'RIGHT' as const,
        })),
        (line) => {
          const entry = skillReviewsState[idx]
          entry.state = { ...entry.state, activity: [...(entry.state.activity ?? []), line] }
          onUpdate?.()
        },
      )
      if (verifyOutcome.byId.size > 0) {
        let surfacedCount = 0
        skillResult = {
          ...skillResult,
          findings: skillResult.findings.map((f) => {
            const v = verifyOutcome.byId.get(`${f.path}:${f.line}:${djb2(f.body)}`)
            if (v?.surfaced) surfacedCount += 1
            return v ? { ...f, verification: v } : f
          }),
        }
        skillUsage = addUsage(skillUsage, verifyOutcome.usage)

        // Build the per-model cost + impact breakdown — only meaningful when an
        // ensemble of >1 model ran (a verifier responded). Reuses the SAME
        // buildVerdictModels() the verdict step uses, so the table layout and the
        // crossVerify per-model data are shared, not duplicated.
        if (verifyOutcome.verifierImpact.length > 0) {
          skillModels = buildVerdictModels(
            generatorUsage,
            surfacedCount,
            verifyOutcome.perModelUsage,
            verifyOutcome.verifierImpact,
          )
        }
      }
      }
      } // end if (!fusionHandled)

      // Cache the (possibly verified) result. Skill deep-cache shape preserved.
      if (deep.enabled) {
        await setCached<DeepCached<SkillReviewResult>>(key, { deep: true, result: skillResult, toolCallsUsed: toolCallsUsed ?? 0, usage: skillUsage })
      } else {
        await setCached<SkillReviewResult>(key, skillResult)
      }
      // Persist this reviewer's per-model breakdown so a future cache hit can
      // repopulate the Step-3 cost+performance table.
      await setCached<VerdictModelBreakdown[]>(skillModelsKey, skillModels ?? [])
      skillReviewsState[idx] = {
        skillId: skill.id,
        name: skill.name,
        state: {
          status: 'done',
          value: skillResult,
          ...(toolCallsUsed !== undefined ? { toolCallsUsed } : {}),
          ...(skillUsage ? { usage: skillUsage } : {}),
          ...(skillModels ? { models: skillModels } : {}),
          ...(deep.note ? { note: deep.note } : {}),
        },
      }
      track('ai_task_completed', {
        task: 'skill-review',
        duration_ms: Math.round(performance.now() - t0),
        cached: false,
        ...(skillUsage?.total_tokens !== undefined ? { tokens: skillUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      const info = describeTaskError(err)
      // Record the provider's Retry-After (rate limits only) so the auto-retry
      // loop can pace the next round instead of re-dispatching immediately.
      if (err instanceof LlmError && err.kind === 'rate-limited' && typeof err.retryAfterMs === 'number') {
        reviewerRetryAfterMs.set(idx, err.retryAfterMs)
      }
      skillReviewsState[idx] = {
        skillId: skill.id,
        name: skill.name,
        state: {
          status: 'error',
          error: info.error,
          ...(info.errorDetail ? { errorDetail: info.errorDetail } : {}),
        },
      }
      track('ai_task_failed', failureProps('skill-review', info))
    }
    onUpdate?.()
  }

  // ---------------------------------------------------------------------------
  // Convergence pass — cross-REVIEWER analogue of fuseSkillReview, run ONCE
  // after ALL reviewers settle. One cheap single-pass call on the ACTIVE
  // (narrator) model — never the ensemble. Loss-proof: this function only ever
  // writes convergenceState; the reviewer entries are untouched, so any
  // failure/decline/garbage leaves the original findings rendering unmerged.
  // ---------------------------------------------------------------------------

  async function runConvergencePass(onUpdate?: () => void): Promise<void> {
    // Reviewers that settled 'done' with a real result object. Defensive on the
    // findings array — a malformed cached value must degrade to "no findings",
    // never throw (loss-proof includes surviving weird cache content).
    const reviewers: ReviewerFindings[] = skillReviewsState
      .filter((e) => e.state.status === 'done' && typeof e.state.value === 'object' && e.state.value !== null)
      .map((e) => {
        const value = e.state.value as SkillReviewResult
        return { skillId: e.skillId, name: e.name, findings: Array.isArray(value.findings) ? value.findings : [] }
      })

    // Skip (stay 'idle') when fewer than 2 reviewers produced findings — a
    // single reviewer has nobody to converge with; no call, no tokens.
    if (reviewers.filter((r) => r.findings.length > 0).length < 2) {
      convergenceState.status = 'idle'
      return
    }

    const { inputs, fingerprint } = enumerateFindings(reviewers)
    // ALL draft comments feed the pass — every n at a line is an independent
    // root-level comment (multiple drafts coexist per line; n>0 is NOT a
    // thread reply). Best-effort.
    let draftList: Draft[] = []
    try {
      draftList = getDrafts?.() ?? []
    } catch {
      draftList = []
    }
    const draftEnum = enumerateDrafts(draftList.map((d) => ({ path: d.path, line: d.line, body: d.body })))

    // Cache key folds the convergence prompt version + a hash of the finding AND draft content,
    // so a changed finding set (or draft set) re-runs the pass.
    const key = cacheKey(prKey, 'convergence:' + djb2(fingerprint + '||' + draftEnum.fingerprint), promptVersionFor('convergence'))
    const t0 = performance.now()

    const hit = await getCached<ConvergenceValue>(key)
    if (hit !== null) {
      convergenceState.status = 'done'
      convergenceState.value = hit
      track('ai_task_completed', { task: 'convergence', duration_ms: Math.round(performance.now() - t0), cached: true, clusters: hit.clusters.length })
      onUpdate?.()
      return
    }

    convergenceState.status = 'loading'
    convergenceState.error = undefined
    convergenceState.errorDetail = undefined
    onUpdate?.()

    const prompts = convergencePrompt(inputs, draftEnum.inputs)
    const findingIds = new Set(inputs.map((i) => i.id))
    const draftIds = new Set(draftEnum.inputs.map((i) => i.id))
    const draftById = new Map(draftEnum.inputs.map((i) => [i.id, { path: i.path, line: i.line }]))

    try {
      const { result, usage } = await llmJsonWithRepairWithUsage(
        jsonTaskOpts(prompts),
        (x) => validateConvergence(x, findingIds, draftIds),
      )
      // Defense in depth: re-validate the returned value (a stubbed/bypassing
      // transport must never push garbage into the merge).
      const checked = validateConvergence(result, findingIds, draftIds)
      if (checked === null) throw new LlmError('invalid-output', 'convergence: invalid clusters')

      const value: ConvergenceValue = { fingerprint, clusters: toAppliedClusters(checked, draftById) }
      await setCached<ConvergenceValue>(key, value)
      convergenceState.status = 'done'
      convergenceState.value = value
      convergenceState.usage = usage
      track('ai_task_completed', {
        task: 'convergence',
        duration_ms: Math.round(performance.now() - t0),
        cached: false,
        clusters: value.clusters.length,
        ...(usage?.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
      })
    } catch (err) {
      // Loss-proof degrade: log to run state; the UI renders the original
      // findings unmerged exactly as before the pass.
      failTask(convergenceState, 'convergence', err)
    }
    onUpdate?.()
  }

  // ---------------------------------------------------------------------------
  // Simplify pass — one batched single-pass call AFTER the convergence pass
  // settles (also when convergence skipped/failed — it then rewrites the raw
  // findings) that turns every finding body the user will see into plain
  // English. Runs on the ACTIVE (narrator) model — never the ensemble.
  // Loss-proof: this function only ever writes simplifyState; the reviewer
  // entries are untouched, so any failure/decline/garbage leaves the original
  // bodies rendering unchanged. Mode-gated ('simplify' in the Plan J matrix,
  // off|standard): 'off' → 'disabled', no LLM call, no cache, zero tokens.
  // ---------------------------------------------------------------------------

  async function runSimplifyPass(onUpdate?: () => void): Promise<void> {
    // Plan J mode gate (#113/#219 idiom): 'off' → no call, no status noise.
    if (!resolveTaskMode('simplify', deepReview).run) {
      simplifyState.status = 'disabled'
      onUpdate?.()
      return
    }

    // Reviewers that settled 'done' with a real result object — same defensive
    // collection as the convergence pass (weird cache content must never throw).
    const rawReviewers: ReviewerFindings[] = skillReviewsState
      .filter((e) => e.state.status === 'done' && typeof e.state.value === 'object' && e.state.value !== null)
      .map((e) => {
        const value = e.state.value as SkillReviewResult
        return { skillId: e.skillId, name: e.name, findings: Array.isArray(value.findings) ? value.findings : [] }
      })

    // Simplify the bodies users actually SEE: apply the convergence merge first
    // (fingerprint-guarded; a stale/absent value leaves the raw lists intact).
    const cv =
      convergenceState.status === 'done' && convergenceState.value && typeof convergenceState.value === 'object'
        ? (convergenceState.value as ConvergenceValue)
        : null
    const reviewers = cv ? applyConvergence(rawReviewers, cv) : rawReviewers

    const { inputs, fingerprint } = enumerateForSimplify(reviewers)
    // Nothing to rewrite → skip silently (no call, no tokens, no status noise).
    if (inputs.length === 0) {
      simplifyState.status = 'idle'
      return
    }

    // Cache key: the simplify prompt version + a hash of the (post-merge)
    // finding content → "<pr>|simplify:<djb2>|v<N>". A changed finding set
    // (retry, edited skill, different merge) re-runs the pass.
    const key = cacheKey(prKey, 'simplify:' + djb2(fingerprint), promptVersionFor('simplify'))
    const t0 = performance.now()

    const hit = await getCached<SimplifyValue>(key)
    // Defensive shape guard on cached values (mirrors the run's other guards):
    // a non-standard cached value is treated as a miss, never applied.
    if (hit !== null && typeof hit === 'object' && typeof hit.fingerprint === 'string' && Array.isArray(hit.rewrites)) {
      simplifyState.status = 'done'
      simplifyState.value = hit
      track('ai_task_completed', { task: 'simplify', duration_ms: Math.round(performance.now() - t0), cached: true, rewrites: hit.rewrites.length })
      onUpdate?.()
      return
    }

    simplifyState.status = 'loading'
    simplifyState.error = undefined
    simplifyState.errorDetail = undefined
    onUpdate?.()

    const prompts = simplifyPrompt(inputs)
    const findingIds = new Set(inputs.map((i) => i.id))

    try {
      const { result, usage } = await llmJsonWithRepairWithUsage(
        jsonTaskOpts(prompts),
        (x) => validateSimplify(x, findingIds),
      )
      // Defense in depth: re-validate the returned value (a stubbed/bypassing
      // transport must never push garbage into the apply step).
      const checked = validateSimplify(result, findingIds)
      if (checked === null) throw new LlmError('invalid-output', 'simplify: invalid rewrites')

      const value: SimplifyValue = { fingerprint, rewrites: checked.rewrites }
      await setCached<SimplifyValue>(key, value)
      simplifyState.status = 'done'
      simplifyState.value = value
      simplifyState.usage = usage
      track('ai_task_completed', {
        task: 'simplify',
        duration_ms: Math.round(performance.now() - t0),
        cached: false,
        rewrites: value.rewrites.length,
        ...(usage?.total_tokens !== undefined ? { tokens: usage.total_tokens } : {}),
      })
    } catch (err) {
      // Loss-proof degrade: log to run state; the UI renders the original
      // finding bodies exactly as before the pass — never blocks rendering.
      failTask(simplifyState, 'simplify', err)
    }
    onUpdate?.()
  }

  async function runSkillReviews(onUpdate?: () => void, existingComments?: string[], opts?: { autoRetry?: number }): Promise<void> {
    // Plan J: skills 'off' → never offer/run reviewers (no entries, no tokens).
    const skillsMode = resolveTaskMode('skills', deepReview)
    if (!skillsMode.run) return

    // No-key gate: same early-exit as start() and coach()
    if (!activeProviderHasKey()) return

    // Consent gate: shared gateAi / shared ask
    const allowed = await gateAi({ repo, isPrivate, ask: askConsent })
    if (!allowed) return

    // Get context (best-effort — reuse if already packed)
    if (packedCtx === null) {
      const ctx = await getPackedContext()
      if (ctx === null) return
    }

    const ctx = packedCtx!

    // Load enabled skills at call time
    const skills = listSkills().filter((s) => s.enabled)
    if (skills.length === 0) return

    // Deep review (Plan G/J): one mode resolution for the whole batch, driven
    // by the 'skills' task mode (deep / standard) resolved above.
    const deep = { enabled: skillsMode.deep, note: skillsMode.note }

    // A fresh batch invalidates any previous convergence value (the finding set
    // is about to change; applyConvergence is fingerprint-guarded anyway).
    convergenceState.status = 'idle'
    convergenceState.value = undefined
    convergenceState.error = undefined
    convergenceState.errorDetail = undefined

    // Same for the simplify pass (applySimplify is fingerprint-guarded too).
    simplifyState.status = 'idle'
    simplifyState.value = undefined
    simplifyState.error = undefined
    simplifyState.errorDetail = undefined

    // Initialize every entry as 'queued' — none has a slot yet. Six concurrent
    // LLM calls trip provider rate limits, so we cap in-flight reviewers at
    // REVIEWER_CONCURRENCY and let the rest wait visibly in the queue.
    skillReviewsState = skills.map((skill) => ({
      skillId: skill.id,
      name: skill.name,
      state: { status: 'queued' as const, ...(deep.note ? { note: deep.note } : {}) },
    }))
    onUpdate?.()

    // Dispatch through a bounded concurrency gate. The worker flips its entry
    // from 'queued' → 'loading' (firing onUpdate) the moment a slot frees, so
    // the chip moves from "waiting" to "running" exactly when its call starts.
    // executeSkillReview then overwrites the entry to done/error as before.
    await mapWithConcurrency(skills, REVIEWER_CONCURRENCY, async (skill, idx) => {
      skillReviewsState[idx] = {
        skillId: skill.id,
        name: skill.name,
        state: { status: 'loading', ...(deep.note ? { note: deep.note } : {}) },
      }
      onUpdate?.()
      await executeSkillReview(ctx, skill, idx, deep, onUpdate, existingComments)
    })

    // Auto-retry (opt-in): re-attempt ONLY the reviewers still in 'error', for up
    // to `autoRetry` extra rounds. Errors are never cached, so each retry genuinely
    // re-hits the LLM; an entry that already settled 'done' is never reset/re-run.
    // Bounded by `autoRetry` AND by an early exit once no entry is errored — a
    // reviewer that always fails ends 'error' after the budget is spent (no loop).
    //
    // PACED: each round WAITS before re-dispatching — an errored reviewer has
    // already exhausted the transport-level retries (withTransientRetry), so
    // firing the round immediately just re-hits the same exhausted rate limit
    // (retry storm). Delay = the max Retry-After the failed round observed when
    // the provider told us (rate limits carry it since the transport-retry PR),
    // else a 2s/4s/8s ladder; capped at 20s. Total rounds unchanged.
    const autoRetry = Math.max(0, Math.floor(opts?.autoRetry ?? 0))
    for (let round = 0; round < autoRetry; round++) {
      // Collect the still-errored reviewers paired with their array index so the
      // worker writes the right entry. Map back to the live skill (content may
      // have changed) — skip any reviewer that no longer exists.
      const errored = skillReviewsState
        .map((entry, idx) => ({ entry, idx }))
        .filter(({ entry }) => entry.state.status === 'error')
        .map(({ entry, idx }) => ({ idx, skill: skills.find((s) => s.id === entry.skillId) }))
        .filter((x): x is { idx: number; skill: (typeof skills)[number] } => x.skill !== undefined)
      if (errored.length === 0) break

      const observed = errored
        .map(({ idx }) => reviewerRetryAfterMs.get(idx))
        .filter((v): v is number => typeof v === 'number')
      const delayMs = autoRetryDelayMs(round, observed)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))

      await mapWithConcurrency(errored, REVIEWER_CONCURRENCY, async ({ idx, skill }) => {
        skillReviewsState[idx] = {
          skillId: skill.id,
          name: skill.name,
          state: { status: 'loading', ...(deep.note ? { note: deep.note } : {}) },
        }
        onUpdate?.()
        await executeSkillReview(ctx, skill, idx, deep, onUpdate, existingComments)
      })
    }

    // Convergence pass — once, after every reviewer (incl. auto-retries) has
    // settled. Skips itself when <2 reviewers produced findings.
    await runConvergencePass(onUpdate)

    // Simplify pass — once, after convergence settles (it consumes the MERGED
    // bodies). Also runs when convergence skipped/failed: raw findings deserve
    // plain English too. Skips itself when there are no findings.
    await runSimplifyPass(onUpdate)
  }

  // ---------------------------------------------------------------------------
  // retrySkill(skillId) — re-run exactly ONE reviewer (the error-chip retry).
  //
  // Mirrors retry(task) for the panels: re-uses the packed context, sets just
  // that reviewer's entry to loading, and re-invokes its review through the same
  // cache-miss path (errors are never cached, so it re-hits the LLM). Only the
  // targeted entry is touched — sibling reviews and drafts are never disturbed.
  // ---------------------------------------------------------------------------

  async function retrySkill(skillId: string, onUpdate?: () => void, existingComments?: string[]): Promise<void> {
    // Plan J: skills 'off' → reviewers are not offered; nothing to retry.
    const skillsMode = resolveTaskMode('skills', deepReview)
    if (!skillsMode.run) return

    // No-key / consent gates: identical to the batch path.
    if (!activeProviderHasKey()) return
    const allowed = await gateAi({ repo, isPrivate, ask: askConsent })
    if (!allowed) return

    // Locate the existing entry. If runSkillReviews never ran, there's nothing
    // to retry — the error chip only renders after a batch run.
    const idx = skillReviewsState.findIndex((e) => e.skillId === skillId)
    if (idx === -1) return

    // Re-use the already-packed context (re-pack if the initial pack failed).
    if (packedCtx === null) {
      const ctx = await getPackedContext()
      if (ctx === null) return
    }
    const ctx = packedCtx!

    // Resolve the skill content fresh (the user may have edited it since the run).
    const skill = listSkills().find((s) => s.id === skillId)
    if (!skill) return

    const deep = { enabled: skillsMode.deep, note: skillsMode.note }

    // Set just this entry to loading — clears the prior error/activity.
    skillReviewsState[idx] = {
      skillId: skill.id,
      name: skill.name,
      state: { status: 'loading', ...(deep.note ? { note: deep.note } : {}) },
    }
    onUpdate?.()

    await executeSkillReview(ctx, skill, idx, deep, onUpdate, existingComments)

    // The finding set changed → recompute the convergence pass. Any previous
    // value is fingerprint-guarded, so until this settles the UI simply renders
    // the fresh findings unmerged (never a stale merge).
    await runConvergencePass(onUpdate)

    // ...and the simplify pass follows it (same fingerprint guard: until it
    // settles the fresh findings render their original bodies, never a stale
    // rewrite).
    await runSimplifyPass(onUpdate)
  }

  // ---------------------------------------------------------------------------
  // Return reactive state + methods
  // ---------------------------------------------------------------------------

  return {
    get summary() { return summaryState },
    get attention() { return attentionState },
    get diagrams() { return diagramsState },
    get verdict() { return verdictState },
    get riskJudge() { return riskJudgeState },
    get tests() { return testsState },
    get alternatives() { return alternativesState },
    get intent() { return intentState },
    get story() { return storyState },
    get skillReviews() { return skillReviewsState },
    get convergence() { return convergenceState },
    get simplify() { return simplifyState },
    get totalUsage(): LlmUsage | undefined {
      // Sum every task's captured usage for this PR run. Tasks with no usage
      // (cached pre-usage results / errors) contribute nothing.
      let total: LlmUsage | undefined
      const states = [summaryState, attentionState, diagramsState, verdictState, testsState, alternativesState, intentState, storyState, riskJudgeState, convergenceState, simplifyState]
      for (const s of states) total = addUsage(total, s.usage)
      for (const e of skillReviewsState) total = addUsage(total, e.state.usage)
      // Coach and expand are on-demand (never among the core tasks); fold in
      // their usage so the per-PR total reflects their cost too.
      total = addUsage(total, coachUsage)
      total = addUsage(total, expandUsage)
      return total
    },
    get verdictModels() { return verdictModelsState },
    get modelPerformance(): VerdictModelBreakdown[] {
      // Aggregate the verdict's per-model rows together with every reviewer's,
      // so Step 3 is the single place showing the whole review's cost +
      // per-model performance (verdict + all reviewers).
      return aggregateModelPerformance([
        verdictModelsState,
        ...skillReviewsState.map((e) => e.state.models ?? []),
      ])
    },
    get modelCostBreakdown(): ModelCostRow[] {
      // Assemble one CostContribution per (model, role, task) so that EVERY
      // task's usage is accounted for exactly once — then summing all the rows'
      // totals reconciles with totalUsage. Two contribution shapes:
      //   (a) ENSEMBLE tasks with per-model rows (verdict / each reviewer):
      //       emit one contribution per row, carrying that row's usage/role/
      //       impact — the rows already sum to the task's aggregate usage, so we
      //       do NOT also add the task's own .usage.
      //   (b) any task with NO per-model rows (every single-pass task, plus a
      //       single-model reviewer or an evidence-free / no-ensemble verdict):
      //       emit ONE generator contribution on the ACTIVE model with that
      //       task's .usage. This is what makes the single-pass spend visible
      //       and keeps the reconciliation invariant.
      const active = activeLlmConfig()
      const activeProviderId = active.provider.id
      const activeModelId = active.model.id
      const contributions: CostContribution[] = []

      const addModelRows = (rows: VerdictModelBreakdown[], task: string): void => {
        for (const r of rows) {
          contributions.push({
            providerId: r.providerId,
            modelId: r.modelId,
            role: r.role,
            task,
            ...(r.usage ? { usage: r.usage } : {}),
            ...(r.surfaced !== undefined ? { surfaced: r.surfaced } : {}),
            ...(r.uniqueCatch !== undefined ? { uniqueCatch: r.uniqueCatch } : {}),
            ...(r.impact ? { impact: r.impact } : {}),
          })
        }
      }

      // Single-pass task: one active-model NARRATION contribution carrying its
      // captured usage. The active model ran the DESCRIPTIVE tasks (summary/
      // hotspots/diagrams/tests/alternatives/story/risk-judge/coach) — it did NOT generate
      // review findings, so it's tagged 'narrator' (rendered "active · narration"),
      // distinct from a finding-generating 'generator'. If this same model is ALSO
      // a configured ensemble generator, buildModelCostBreakdown folds these
      // narration tasks into its generator row (it stays a Generator). Emitted
      // even with no usage so the task still appears (byTask shows it ran).
      const addSinglePass = (usage: LlmUsage | undefined, task: string): void => {
        contributions.push({
          providerId: activeProviderId,
          modelId: activeModelId,
          role: 'narrator',
          task,
          ...(usage ? { usage } : {}),
        })
      }

      // Finding-GENERATION fallback on the active model (verdict / reviewer in the
      // single-generator path): the active model GENERATED findings/evidence, so
      // it's a 'generator' contribution (NOT narration). This is the default-panel
      // path and stays byte-identical: one active-model generator row, unchanged.
      const addActiveGenerator = (usage: LlmUsage | undefined, task: string): void => {
        contributions.push({
          providerId: activeProviderId,
          modelId: activeModelId,
          role: 'generator',
          task,
          ...(usage ? { usage } : {}),
        })
      }

      // Verdict: per-model rows if it cross-verified; else attribute its usage to
      // the active model as a GENERATOR (it produced the verdict/evidence).
      if (verdictModelsState.length > 0) {
        addModelRows(verdictModelsState, 'Verdict')
      } else if (verdictState.usage) {
        addActiveGenerator(verdictState.usage, 'Verdict')
      }

      // Single-pass tasks that always run on the active model.
      if (summaryState.usage) addSinglePass(summaryState.usage, 'Summary')
      if (attentionState.usage) addSinglePass(attentionState.usage, 'Hotspots')
      if (diagramsState.usage) addSinglePass(diagramsState.usage, 'Diagrams')
      if (testsState.usage) addSinglePass(testsState.usage, 'Tests')
      if (alternativesState.usage) addSinglePass(alternativesState.usage, 'Alternatives')
      if (intentState.usage) addSinglePass(intentState.usage, 'Intent check')
      if (storyState.usage) addSinglePass(storyState.usage, 'Story')
      if (riskJudgeState.usage) addSinglePass(riskJudgeState.usage, 'Risk judge')
      if (coachUsage) addSinglePass(coachUsage, 'Coach')
      if (expandUsage) addSinglePass(expandUsage, 'Expand')
      if (convergenceState.usage) addSinglePass(convergenceState.usage, 'Convergence')
      if (simplifyState.usage) addSinglePass(simplifyState.usage, 'Simplify')

      // Reviewers: per-model rows when an ensemble ran; else attribute the
      // reviewer's total usage to the active model as a GENERATOR (it produced
      // the findings — a reviewer is finding-generation, not narration).
      for (const e of skillReviewsState) {
        const task = `Reviewer: ${e.name}`
        const models = e.state.models ?? []
        if (models.length > 0) {
          addModelRows(models, task)
        } else if (e.state.usage) {
          addActiveGenerator(e.state.usage, task)
        }
      }

      return buildModelCostBreakdown(contributions)
    },
    start,
    retry,
    coach,
    ask,
    expandComment,
    runSkillReviews,
    retrySkill,
  }
}
