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
  mergeGeneratorFindings,
  fuseConfirm,
  type VerifiableFinding,
  type VerifyFn,
  type ParticipantUsage,
  type VerifierImpact,
  type GeneratorFindings,
} from './crossVerify'
import { getProvider } from '../llm/providers'
import { llmToolLoop as defaultLlmToolLoop } from '../llm/llmToolLoop'
import {
  createDeepReviewToolkit,
  createDeepReviewCache,
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
  /**
   * Per-model cost + impact breakdown (Plan N) — populated for SKILL reviews
   * whose cross-verify pass ran with an ensemble of >1 model. Generator row
   * first, then one row per responding verifier. Empty/absent for single-model
   * runs (the plain aggregate usage footer is shown instead). Display-only.
   */
  models?: VerdictModelBreakdown[]
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
   * active model — summary/hotspots/diagrams/tests/alternatives/story/coach).
   * Each row carries a per-task drilldown (`byTask`). Summing every row's
   * `total` equals `totalUsage` — no task's tokens are dropped or double-counted.
   * Drives the Step-3 expandable cost panel. Display-only.
   */
  readonly modelCostBreakdown: ModelCostRow[]
  start(): Promise<void>
  retry(task: TaskName): Promise<void>
  coach(drafts: Draft[], prComments?: string[], verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): Promise<CoachOutcome | { error: string }>
  ask(question: string, onDelta: (t: string) => void, focus?: AskFocus): Promise<{ ok: true; answer: string } | { ok: false; error: string }>
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

  /** Real per-verifier call: comprehensive adversarial JSON judgement. */
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
    const generatorModelId = activeLlmConfig().model.id
    try {
      // Every verifier runs the SAME comprehensive adversarial prompt; error
      // decorrelation comes from MODEL/PROVIDER diversity, not per-judge framing.
      const outcome = await crossVerify(verifiable, generatorName, verifiers, realVerify, generatorModelId)
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
   * Plan O 'generate' mode for a skill review: run the skill prompt with EVERY
   * ensemble participant as an independent generator, dedup-merge the union,
   * cross-confirm (comprehensive prompt), and rebuild a SkillReviewResult whose findings carry
   * `raisedBy` + `verification`, surfaced-first. Returns null when fewer than 2
   * generators produced findings (caller falls back to single-generator). Never
   * throws — any failure returns null.
   */
  async function fuseSkillReview(
    prompts: { system: string; user: string },
    skillName: string,
    idx: number,
    onUpdate?: () => void,
  ): Promise<{ result: SkillReviewResult; usage: LlmUsage | undefined; models: VerdictModelBreakdown[] } | null> {
    try {
      // Plan P: generators GENERATE; ALL participants (generators + verifiers)
      // verify findings they didn't raise. Multi-gen requires ≥2 generators.
      const participants = fusionParticipants()
      const generators = fusionGenerators()
      if (generators.length < 2) return null
      const note = (line: string): void => {
        const entry = skillReviewsState[idx]
        entry.state = { ...entry.state, activity: [...(entry.state.activity ?? []), line] }
        onUpdate?.()
      }
      note(`Generating with ${generators.length} models (fusion)…`)

      // 1. Each GENERATOR generates independently (parallel, own provider cfg).
      const { perGenerator, usage: genUsage, usageByModel: genUsageByModel } = await generateMultiGen(
        generators,
        async (cfg) => {
          const { result, usage } = await llmJsonWithRepairFor<SkillReviewResult>(
            cfg,
            { system: prompts.system, user: prompts.user },
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

      if (perGenerator.length < 2) return null

      // 2. Merge/dedup the union.
      const merged = mergeGeneratorFindings(perGenerator)
      if (merged.length === 0) {
        return { result: { skillName, findings: [] }, usage: genUsage, models: [] }
      }

      // 3. Cross-confirm (each participant verifies findings it didn't raise).
      const outcome = await fuseConfirm(merged, participants, realVerify)

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
    } catch {
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
   * Returns null when fewer than 2 generators produced a verdict (caller falls
   * back to the single-generator verify path). Never throws.
   */
  async function fuseVerdict(
    prompts: { system: string; user: string },
    ctx: PackedContext,
    onActivity?: (line: string) => void,
  ): Promise<{ result: VerdictResult; usage: LlmUsage | undefined; models: VerdictModelBreakdown[] } | null> {
    try {
      const participants = fusionParticipants()
      const generators = fusionGenerators()
      if (generators.length < 2) return null
      onActivity?.(`Generating verdict with ${generators.length} models (fusion)…`)

      // 1. Each GENERATOR generates a verdict independently (parallel, own cfg).
      //    Evidence bullets become VerifiableFindings (no real line — anchored by
      //    best-effort path token + description, exactly like the verify path).
      const perVerdict = new Map<string, VerdictResult>()
      const { perGenerator, usage: genUsage, usageByModel: genUsageByModel } = await generateMultiGen(
        generators,
        async (cfg) => {
          const { result, usage } = await llmJsonWithRepairFor<VerdictResult>(
            cfg,
            { system: prompts.system, user: prompts.user },
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

      if (perGenerator.length < 2) return null

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
      const outcome = await fuseConfirm(merged, participants, realVerify)

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
    } catch {
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
  ): Promise<{ result: T; usage?: LlmUsage; toolCallsUsed: number }> {
    const toolkit = createDeepReviewToolkit(deepReview!, deepCache)
    const system = withDeepReviewGuidance(prompts.system, toolkit.tools.map((t) => t.name))
    const baseOpts = {
      system,
      tools: toolkit.tools,
      executeTool: toolkit.executeTool,
      humanize: toolkit.humanize,
      maxToolCalls: DEEP_REVIEW_MAX_TOOL_CALLS,
      onToolEvent: (ev: { detail: string }) => onActivity(ev.detail),
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
    const key = cacheKey(prKey, deep.enabled ? 'verdict|deep' : 'verdict', PROMPT_VERSION)
    // Companion entry holding the per-model breakdown (Plan N), keyed off the
    // SAME content hash with a '|models' discriminant so it never collides with
    // the result entry. Persisted alongside the verdict result and restored on a
    // cache hit so the Step-3 cost+performance table survives a re-opened PR.
    const verdictModelsKey = cacheKey(prKey, (deep.enabled ? 'verdict|deep' : 'verdict') + '|models', PROMPT_VERSION)

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
      // generator's. Single-pass per generator — deep stays on the verify path.
      if (fusionGenerateEffective() && !deep.enabled) {
        const fused = await fuseVerdict(prompts, ctx, (line) => {
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
          { system: prompts.system, user: prompts.user },
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
    // Companion entry holding this reviewer's per-model breakdown (Plan N),
    // keyed off the SAME content hash with a '|models' discriminant. Persisted
    // alongside the skill result and restored on a cache hit so the Step-3 cost+
    // performance table is repopulated for a previously-reviewed PR.
    const skillModelsKey = cacheKey(prKey, 'skill:' + djb2(skill.content) + (deep.enabled ? '|deep' : '') + '|models', PROMPT_VERSION)

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

      // Plan O 'generate' mode: every ensemble model generates this skill review
      // independently; the union is dedup-merged and cross-confirmed so a real
      // finding only one model caught can still surface (recall). Single-pass per
      // participant — deep multi-gen stays on the verify path below.
      let fusionHandled = false
      if (fusionGenerateEffective() && !deep.enabled) {
        const fused = await fuseSkillReview(prompts, skill.name, idx, onUpdate)
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
          { system: prompts.system, user: prompts.user },
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

      // Single-pass task: one active-model generator contribution carrying its
      // captured usage. Emitted even with no usage so the task still appears
      // (byTask shows it ran); an undefined usage contributes 0 to the total.
      const addSinglePass = (usage: LlmUsage | undefined, task: string): void => {
        contributions.push({
          providerId: activeProviderId,
          modelId: activeModelId,
          role: 'generator',
          task,
          ...(usage ? { usage } : {}),
        })
      }

      // Verdict: per-model rows if it cross-verified; else attribute its usage to
      // the active model (covers evidence-free / no-ensemble verdicts).
      if (verdictModelsState.length > 0) {
        addModelRows(verdictModelsState, 'Verdict')
      } else if (verdictState.usage) {
        addSinglePass(verdictState.usage, 'Verdict')
      }

      // Single-pass tasks that always run on the active model.
      if (summaryState.usage) addSinglePass(summaryState.usage, 'Summary')
      if (attentionState.usage) addSinglePass(attentionState.usage, 'Hotspots')
      if (diagramsState.usage) addSinglePass(diagramsState.usage, 'Diagrams')
      if (testsState.usage) addSinglePass(testsState.usage, 'Tests')
      if (alternativesState.usage) addSinglePass(alternativesState.usage, 'Alternatives')
      if (storyState.usage) addSinglePass(storyState.usage, 'Story')
      if (coachUsage) addSinglePass(coachUsage, 'Coach')

      // Reviewers: per-model rows when an ensemble ran; else attribute the
      // reviewer's total usage to the active model.
      for (const e of skillReviewsState) {
        const task = `Reviewer: ${e.name}`
        const models = e.state.models ?? []
        if (models.length > 0) {
          addModelRows(models, task)
        } else if (e.state.usage) {
          addSinglePass(e.state.usage, task)
        }
      }

      return buildModelCostBreakdown(contributions)
    },
    start,
    retry,
    coach,
    ask,
    runSkillReviews,
    retrySkill,
  }
}
