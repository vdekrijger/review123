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

import { activeLlmConfig, activeProviderHasKey, crossModelVerifyEffective, verifierProviderConfigs, resolveEnsemble } from '../llm/config'
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
import {
  crossVerify,
  buildVerifyPrompt,
  validateVerifierResponse,
  type VerifiableFinding,
  type VerifyFn,
  type ParticipantUsage,
  type VerifierImpact,
} from './crossVerify'
import { getProvider } from '../llm/providers'
import { llmToolLoop as defaultLlmToolLoop } from '../llm/llmToolLoop'
import {
  createDeepReviewToolkit,
  resolveTaskMode,
  DEEP_REVIEW_MAX_TOOL_CALLS,
} from './deepReview'
import type { DeepReviewSource } from './deepReview'
import { getSettings } from '../settings/settings'
import {
  cacheKey,
  getCached as defaultGetCached,
  setCached as defaultSetCached,
} from '../cache/aiCache'
import { gateAi as defaultGateAi } from '../consent/consent'
import { track as defaultTrack } from '../analytics/analytics'
import {
  PROMPT_VERSION,
  summarizePrompt,
  attentionPrompt,
  diagramsPrompt,
  verdictPrompt,
  testInsightPrompt,
  coachPrompt,
  alternativesPrompt,
  storyOrderPrompt,
  askPrompt,
  skillReviewPrompt,
  withDeepReviewGuidance,
  type AskFocus,
} from './tasks'
export type { AskFocus }
import { validateAttention, validateVerdict, validateGraphResult, validateTestInsight, validateCoachResult, validateAlternativesResult, validateStoryOrder, validateSkillReviewResult, salvageStoryOrder, dedupeStorySteps, sinkGeneratedSteps, STORY_MAX_STEPS } from './schemas'
import type { AttentionResult, VerdictResult, GraphResult, TestInsight, CoachResult, AlternativesResult, StoryOrderResult, SkillReviewResult } from './schemas'
import type { Draft } from '../drafts/drafts.svelte'
import type { CoachCodeContext } from './coachContext'
import {
  chunk,
  mergeChunkOutcomes,
  mapWithConcurrency,
  COACH_CHUNK_SIZE,
  COACH_CHUNK_CONCURRENCY,
  type ChunkOutcome,
} from './coachBatch'
import { listSkills } from '../skills/skills'
import { djb2 } from '../viewed/viewed.svelte'
import { addUsage } from './tokenCost'

// ---------------------------------------------------------------------------
// PanelState union
// ---------------------------------------------------------------------------

export type PanelStatus =
  | 'idle'
  | 'no-key'
  | 'declined'
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

export interface PanelState<T> {
  status: PanelStatus
  value?: T | string
  error?: string
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
  /** Verifier impact (confirms/refutes/uncertains/decisive). */
  impact?: { confirms: number; refutes: number; uncertains: number; decisive: number }
}

// ---------------------------------------------------------------------------
// Task names (used as cache key discriminants + analytics)
// ---------------------------------------------------------------------------

type TaskName = 'summary' | 'attention' | 'diagrams' | 'verdict' | 'tests' | 'alternatives' | 'story'

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
  readonly tests: PanelState<TestInsight>
  readonly alternatives: PanelState<AlternativesResult>
  readonly story: PanelState<StoryOrderResult>
  readonly skillReviews: SkillReviewEntry[]
  /**
   * Sum of every task's captured token usage for THIS PR run (the six core
   * tasks + any skill reviews). undefined when no task reported usage.
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
  start(): Promise<void>
  retry(task: TaskName): Promise<void>
  coach(drafts: Draft[], prComments?: string[], verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): Promise<CoachOutcome | { error: string }>
  ask(question: string, onDelta: (t: string) => void, focus?: AskFocus): Promise<{ ok: true; answer: string } | { ok: false; error: string }>
  runSkillReviews(onUpdate?: () => void, existingComments?: string[]): Promise<void>
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

  const { prKey, repo, isPrivate, pack, ci, ask: askConsent, deepReview, coachCodeContext, verifyCodeContext } = input

  // Reactive panel state holders
  const summaryState = $state<PanelState<string>>({ status: 'idle' })
  const attentionState = $state<PanelState<AttentionResult>>({ status: 'idle' })
  const diagramsState = $state<PanelState<GraphResult>>({ status: 'idle' })
  const verdictState = $state<PanelState<VerdictResult>>({ status: 'idle' })
  const testsState = $state<PanelState<TestInsight>>({ status: 'idle' })
  const alternativesState = $state<PanelState<AlternativesResult>>({ status: 'idle' })
  const storyState = $state<PanelState<StoryOrderResult>>({ status: 'idle' })

  // Skill review entries — populated on-demand by runSkillReviews()
  let skillReviewsState = $state<SkillReviewEntry[]>([])

  // Token usage from the most recent coach() run (on-demand, never cached).
  // Folded into totalUsage so the per-PR total includes coaching cost.
  let coachUsage = $state<LlmUsage | undefined>(undefined)

  // Per-model cost + impact for the verdict's cross-verify pass (Plan N).
  // Populated when cross-verify runs for the verdict; empty otherwise.
  let verdictModelsState = $state<VerdictModelBreakdown[]>([])

  // Packed context — kept in closure so retry can reuse it without re-packing
  // (unless the initial pack failed, in which case retry re-packs)
  let packedCtx: PackedContext | null = null

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

  /** Real per-verifier call: adversarial JSON judgement against one provider. */
  const realVerify: VerifyFn = async (cfg: ProviderConfig, findings: VerifiableFinding[]) => {
    const prompts = buildVerifyPrompt(findings)
    const { result, usage } = await llmJsonWithRepairFor(
      cfg,
      { system: prompts.system, user: prompts.user },
      validateVerifierResponse,
    )
    return { result, usage }
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
        ...(cc?.excerpt ? { excerpt: cc.excerpt } : {}),
        ...(cc?.fileWindow ? { fileWindow: cc.fileWindow } : {}),
      }
    })

    const generatorName = activeLlmConfig().provider.displayName
    try {
      const outcome = await crossVerify(verifiable, generatorName, verifiers, realVerify)
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
  // Internal: run a single task (summary streams; others use llmJsonWithRepair)
  // ---------------------------------------------------------------------------

  async function runSummaryTask(ctx: PackedContext): Promise<void> {
    // Plan J: summary supports off/standard only. Off → never run, no cache.
    if (!resolveTaskMode('summary', deepReview).run) {
      summaryState.status = 'disabled'
      return
    }
    const key = cacheKey(prKey, 'summary', PROMPT_VERSION)

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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      summaryState.status = 'error'
      summaryState.error = humanMessage(kind)
      track('ai_task_failed', { task: 'summary', reason: kind })
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
    const key = cacheKey(prKey, deep.enabled ? 'attention|deep' : 'attention', PROMPT_VERSION)

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
          { system: prompts.system, user: prompts.user },
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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      attentionState.status = 'error'
      attentionState.error = humanMessage(kind)
      attentionState.activity = undefined
      track('ai_task_failed', { task: 'attention', reason: kind })
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
    const key = cacheKey(prKey, deep.enabled ? 'diagrams|deep' : 'diagrams', PROMPT_VERSION)

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
          { system: prompts.system, user: prompts.user },
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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      diagramsState.status = 'error'
      diagramsState.error = humanMessage(kind)
      diagramsState.activity = undefined
      track('ai_task_failed', { task: 'diagrams', reason: kind })
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
    const key = cacheKey(prKey, deep.enabled ? 'tests|deep' : 'tests', PROMPT_VERSION)

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
          { system: prompts.system, user: prompts.user },
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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      testsState.status = 'error'
      testsState.error = humanMessage(kind)
      testsState.activity = undefined
      track('ai_task_failed', { task: 'tests', reason: kind })
    }
  }

  async function runAlternativesTask(ctx: PackedContext): Promise<void> {
    const mode = resolveTaskMode('alternatives', deepReview)
    if (!mode.run) {
      alternativesState.status = 'disabled'
      return
    }
    const deep = { enabled: mode.deep, note: mode.note }
    if (deep.note) alternativesState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'alternatives|deep' : 'alternatives', PROMPT_VERSION)

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
        const deepOutcome = await runDeepJson<AlternativesResult>(prompts, validateAlternativesResult, (line) => {
          alternativesState.activity = [...(alternativesState.activity ?? []), line]
        })
        alternativesResult = deepOutcome.result
        alternativesUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
        await setCached<DeepCached<AlternativesResult>>(key, { deep: true, result: alternativesResult, toolCallsUsed, usage: alternativesUsage })
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<AlternativesResult>(
          { system: prompts.system, user: prompts.user },
          validateAlternativesResult,
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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      alternativesState.status = 'error'
      alternativesState.error = humanMessage(kind)
      alternativesState.activity = undefined
      track('ai_task_failed', { task: 'alternatives', reason: kind })
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

  async function runStoryOrderTask(ctx: PackedContext): Promise<void> {
    // Story mode (Plan H): classify changed files into layers and emit an
    // ORDERED narrative sequence. Runs through the deep harness when the
    // agentic toggle is on (verify ordering/test-pairing by reading deps),
    // single-pass otherwise — same branch shape as the other deep tasks.
    // Story is not in the user-facing task matrix (Plan J). It has its own
    // storyMode toggle and never goes 'off' here. Its deep depth piggybacks on
    // the verdict task's mode resolution — the canonical "deep review" anchor —
    // so the All/None quick-sets still reproduce story's old deep/standard
    // behavior without exposing a separate story control.
    const verdictMode = resolveTaskMode('verdict', deepReview)
    const deep = { enabled: verdictMode.run && verdictMode.deep, note: verdictMode.note }
    if (deep.note) storyState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'story|deep' : 'story', PROMPT_VERSION)

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
        await setCached<DeepCached<StoryOrderResult>>(key, { deep: true, result: storyResult, toolCallsUsed, usage: storyUsage })
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<StoryOrderResult>(
          { system: prompts.system, user: prompts.user },
          shapeStoryOrder,
        )
        storyResult = singlePass.result
        storyUsage = singlePass.usage
        await setCached<StoryOrderResult>(key, storyResult)
      }
      storyState.status = 'done'
      storyState.value = storyResult
      storyState.activity = undefined
      storyState.usage = storyUsage
      if (toolCallsUsed !== undefined) storyState.toolCallsUsed = toolCallsUsed
      track('ai_task_completed', {
        task: 'story',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(storyUsage?.total_tokens !== undefined ? { tokens: storyUsage.total_tokens } : {}),
        ...(deep.enabled ? { deep: true, tool_calls: toolCallsUsed ?? 0 } : {}),
      })
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      storyState.status = 'error'
      storyState.error = humanMessage(kind)
      storyState.activity = undefined
      track('ai_task_failed', { task: 'story', reason: kind })
    }
  }

  // ---------------------------------------------------------------------------
  // Deep review helpers (Plan G part 2)
  //
  // Deep results cache under a key whose task segment carries a '|deep'
  // marker (+ PROMPT_VERSION as usual) so deep and single-pass outputs never
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
   * Run one deep (agentic) JSON task: tool loop → validate → at most one
   * single-pass repair grounded in the loop's tool-verified output.
   */
  async function runDeepJson<T>(
    prompts: { system: string; user: string },
    validate: (x: unknown) => T | null,
    onActivity: (line: string) => void,
  ): Promise<{ result: T; usage?: LlmUsage; toolCallsUsed: number }> {
    const toolkit = createDeepReviewToolkit(deepReview!)
    const loop = await llmToolLoop({
      system: withDeepReviewGuidance(prompts.system, toolkit.tools.map((t) => t.name)),
      user: prompts.user,
      tools: toolkit.tools,
      executeTool: toolkit.executeTool,
      humanize: toolkit.humanize,
      maxToolCalls: DEEP_REVIEW_MAX_TOOL_CALLS,
      onToolEvent: (ev) => onActivity(ev.detail),
    })

    try {
      const valid = validate(JSON.parse(loop.content) as unknown)
      if (valid !== null) return { result: valid, usage: loop.usage, toolCallsUsed: loop.toolCallsUsed }
    } catch {
      // fall through to the repair pass
    }

    // Repair: reformat the already-verified answer — no tools needed.
    const repaired = await llmJsonWithRepairWithUsage<T>(
      {
        system: prompts.system,
        user:
          `${prompts.user}\n\nYou already analyzed this PR (with verification tools) and answered:\n` +
          `${loop.content}\n` +
          'Reformat that answer as valid JSON exactly matching the required shape. ' +
          'Do not change the verified content. Respond with the JSON only.',
      },
      validate,
    )
    return {
      result: repaired.result,
      usage: sumUsage(loop.usage, repaired.usage),
      toolCallsUsed: loop.toolCallsUsed,
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
    const key = cacheKey(prKey, deep.enabled ? 'verdict|deep' : 'verdict', PROMPT_VERSION)

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<VerdictResult>>(key)
      if (hit !== null) {
        verdictState.status = 'done'
        verdictState.value = hit.result
        verdictState.toolCallsUsed = hit.toolCallsUsed
        verdictState.usage = hit.usage
        track('ai_task_completed', { task: 'verdict', duration_ms: Math.round(performance.now() - t0), cached: true, deep: true })
        return
      }
    } else {
      const hit = await getCached<VerdictResult>(key)
      if (hit !== null) {
        verdictState.status = 'done'
        verdictState.value = hit
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

      if (deep.enabled) {
        const deepOutcome = await runDeepJson<VerdictResult>(prompts, validateVerdict, (line) => {
          verdictState.activity = [...(verdictState.activity ?? []), line]
        })
        verdictResult = deepOutcome.result
        verdictUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<VerdictResult>(
          { system: prompts.system, user: prompts.user },
          validateVerdict,
        )
        verdictResult = singlePass.result
        verdictUsage = singlePass.usage
      }

      // Merge notAnalyzed: union of packed context's notAnalyzed + model's own list (EC-15c)
      const merged = [...new Set([...ctx.notAnalyzed, ...verdictResult.notAnalyzed])]
      let finalResult: VerdictResult = { ...verdictResult, notAnalyzed: merged }

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
      // Generator usage captured BEFORE folding in verifier usage (Plan N
      // per-model cost attributes generation tokens to the generator model).
      const generatorUsage = verdictUsage
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

      if (deep.enabled) {
        await setCached<DeepCached<VerdictResult>>(key, { deep: true, result: finalResult, toolCallsUsed: toolCallsUsed ?? 0, usage: verdictUsage })
      } else {
        await setCached<VerdictResult>(key, finalResult)
      }
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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      verdictState.status = 'error'
      verdictState.error = humanMessage(kind)
      verdictState.activity = undefined
      track('ai_task_failed', { task: 'verdict', reason: kind })
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: set all panels to the same status (no-key / declined / error)
  // ---------------------------------------------------------------------------

  function setAllPanels(status: 'no-key' | 'declined' | 'error', error?: string): void {
    // Plan J: an OFF task wins — it shows 'disabled' (no tokens were ever going
    // to be spent on it) even when the whole run is no-key/declined/error. Only
    // the story panel has no user mode (it's gated by storyMode), so it always
    // takes the sweep status.
    const apply = (
      task: 'summary' | 'attention' | 'diagrams' | 'verdict' | 'tests' | 'alternatives',
      state: PanelState<unknown>,
    ): void => {
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
    storyState.status = status
    if (error !== undefined) storyState.error = error
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

    // Plan J: if EVERY auto task is turned off, there is nothing to pack or run.
    // Avoid the pack()/ci() work entirely (cheap token/time win) and mark each
    // panel disabled. Story shares the diff context, so it only short-circuits
    // here when the matrix tasks are all off too.
    const modes = getSettings().aiTaskModes
    const allAutoOff =
      modes.summary === 'off' &&
      modes.attention === 'off' &&
      modes.diagrams === 'off' &&
      modes.tests === 'off' &&
      modes.alternatives === 'off' &&
      modes.verdict === 'off'
    if (allAutoOff) {
      summaryState.status = 'disabled'
      attentionState.status = 'disabled'
      diagramsState.status = 'disabled'
      testsState.status = 'disabled'
      alternativesState.status = 'disabled'
      verdictState.status = 'disabled'
      storyState.status = 'disabled'
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
      runStoryOrderTask(ctx),
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
    if (task === 'story') return runStoryOrderTask(ctx)
  }

  // ---------------------------------------------------------------------------
  // coach(drafts) — on-demand, never cached, never run in start()
  // ---------------------------------------------------------------------------

  async function coach(
    drafts: Draft[],
    prComments?: string[],
    verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  ): Promise<CoachOutcome | { error: string }> {
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
          { system: prompts.system, user: prompts.user },
          validateCoachResult,
        )
        return { ok: true, result, usage }
      } catch (err) {
        const kind = err instanceof LlmError ? err.kind : 'unknown'
        return { ok: false, kind, indices: chunkDrafts.map((d) => d.index) }
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
    if (merged.reviews.length === 0 && merged.failedIndices.length > 0) {
      const kind = merged.failureKind ?? 'unknown'
      track('ai_task_failed', { task: 'coach', reason: kind })
      return { error: humanMessage(kind) }
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
      track('ai_task_failed', { task: 'coach', reason: merged.failureKind ?? 'unknown', partial: true })
      result.notCoached = {
        indices: merged.failedIndices,
        message: `Couldn't coach ${n} comment${n === 1 ? '' : 's'} (${reason}) — retry to grade ${n === 1 ? 'it' : 'them'}.`,
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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      track('ai_task_failed', { task: 'ask', reason: kind })
      return { ok: false, error: humanMessage(kind) }
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
  async function executeSkillReview(
    ctx: PackedContext,
    skill: { id: string; name: string; content: string },
    idx: number,
    deep: { enabled: boolean; note?: string },
    onUpdate?: () => void,
    existingComments?: string[],
  ): Promise<void> {
    // Content-addressed cache key: includes djb2(skill.content).
    // Deep runs carry a '|deep' marker so they never collide with
    // single-pass results for the same skill content.
    const key = cacheKey(prKey, 'skill:' + djb2(skill.content) + (deep.enabled ? '|deep' : ''), PROMPT_VERSION)

    const t0 = performance.now()

    // Cache check
    if (deep.enabled) {
      const hit = await getCached<DeepCached<SkillReviewResult>>(key)
      if (hit !== null) {
        skillReviewsState[idx] = {
          skillId: skill.id,
          name: skill.name,
          state: { status: 'done', value: hit.result, toolCallsUsed: hit.toolCallsUsed, ...(hit.usage ? { usage: hit.usage } : {}) },
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
        skillReviewsState[idx] = {
          skillId: skill.id,
          name: skill.name,
          state: { status: 'done', value: hit, ...(deep.note ? { note: deep.note } : {}) },
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
      let skillResult: SkillReviewResult
      let skillUsage: LlmUsage | undefined
      let toolCallsUsed: number | undefined

      if (deep.enabled) {
        const deepOutcome = await runDeepJson<SkillReviewResult>(prompts, validateSkillReviewResult, (line) => {
          const entry = skillReviewsState[idx]
          entry.state = { ...entry.state, activity: [...(entry.state.activity ?? []), line] }
          onUpdate?.()
        })
        skillResult = deepOutcome.result
        skillUsage = deepOutcome.usage
        toolCallsUsed = deepOutcome.toolCallsUsed
      } else {
        const singlePass = await llmJsonWithRepairWithUsage<SkillReviewResult>(
          { system: prompts.system, user: prompts.user },
          validateSkillReviewResult,
        )
        skillResult = singlePass.result
        skillUsage = singlePass.usage
      }

      // Cross-model verification (Plan M): adversarially judge each finding with
      // the user's OTHER providers. Short-circuit (byte-identical) when not
      // effective — no array build, no verifier call.
      if (crossModelVerifyEffective()) {
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
        skillResult = {
          ...skillResult,
          findings: skillResult.findings.map((f) => {
            const v = verifyOutcome.byId.get(`${f.path}:${f.line}:${djb2(f.body)}`)
            return v ? { ...f, verification: v } : f
          }),
        }
        skillUsage = addUsage(skillUsage, verifyOutcome.usage)
      }
      }

      // Cache the (possibly verified) result. Skill deep-cache shape preserved.
      if (deep.enabled) {
        await setCached<DeepCached<SkillReviewResult>>(key, { deep: true, result: skillResult, toolCallsUsed: toolCallsUsed ?? 0, usage: skillUsage })
      } else {
        await setCached<SkillReviewResult>(key, skillResult)
      }
      skillReviewsState[idx] = {
        skillId: skill.id,
        name: skill.name,
        state: {
          status: 'done',
          value: skillResult,
          ...(toolCallsUsed !== undefined ? { toolCallsUsed } : {}),
          ...(skillUsage ? { usage: skillUsage } : {}),
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
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      skillReviewsState[idx] = {
        skillId: skill.id,
        name: skill.name,
        state: { status: 'error', error: humanMessage(kind) },
      }
      track('ai_task_failed', { task: 'skill-review', reason: kind })
    }
    onUpdate?.()
  }

  async function runSkillReviews(onUpdate?: () => void, existingComments?: string[]): Promise<void> {
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

    // Initialize entries (loading state)
    skillReviewsState = skills.map((skill) => ({
      skillId: skill.id,
      name: skill.name,
      state: { status: 'loading' as const, ...(deep.note ? { note: deep.note } : {}) },
    }))
    onUpdate?.()

    // Run each skill in parallel, isolated
    await Promise.all(
      skills.map((skill, idx) => executeSkillReview(ctx, skill, idx, deep, onUpdate, existingComments)),
    )
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
  }

  // ---------------------------------------------------------------------------
  // Return reactive state + methods
  // ---------------------------------------------------------------------------

  return {
    get summary() { return summaryState },
    get attention() { return attentionState },
    get diagrams() { return diagramsState },
    get verdict() { return verdictState },
    get tests() { return testsState },
    get alternatives() { return alternativesState },
    get story() { return storyState },
    get skillReviews() { return skillReviewsState },
    get totalUsage(): LlmUsage | undefined {
      // Sum every task's captured usage for this PR run. Tasks with no usage
      // (cached pre-usage results / errors) contribute nothing.
      let total: LlmUsage | undefined
      const states = [summaryState, attentionState, diagramsState, verdictState, testsState, alternativesState, storyState]
      for (const s of states) total = addUsage(total, s.usage)
      for (const e of skillReviewsState) total = addUsage(total, e.state.usage)
      // Coach is on-demand (never one of the six core tasks); fold in its usage
      // so the per-PR total reflects coaching cost too.
      total = addUsage(total, coachUsage)
      return total
    },
    get verdictModels() { return verdictModelsState },
    start,
    retry,
    coach,
    ask,
    runSkillReviews,
    retrySkill,
  }
}
