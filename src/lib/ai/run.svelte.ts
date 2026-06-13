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

import { activeLlmConfig, activeProviderHasKey } from '../llm/config'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import {
  llmStream as defaultLlmStream,
  llmStreamWithUsage as defaultLlmStreamWithUsage,
  llmJsonWithRepair as defaultLlmJsonWithRepair,
  llmJsonWithRepairWithUsage as defaultLlmJsonWithRepairWithUsage,
  LlmError,
} from '../llm/llm'
import type { LlmUsage } from '../llm/llm'
import { llmToolLoop as defaultLlmToolLoop } from '../llm/llmToolLoop'
import {
  createDeepReviewToolkit,
  deepReviewAvailability,
  DEEP_REVIEW_MAX_TOOL_CALLS,
} from './deepReview'
import type { DeepReviewSource } from './deepReview'
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
  askPrompt,
  skillReviewPrompt,
  withDeepReviewGuidance,
  type AskFocus,
} from './tasks'
export type { AskFocus }
import { validateAttention, validateVerdict, validateGraphResult, validateTestInsight, validateCoachResult, validateAlternativesResult, validateSkillReviewResult } from './schemas'
import type { AttentionResult, VerdictResult, GraphResult, TestInsight, CoachResult, AlternativesResult, SkillReviewResult } from './schemas'
import type { Draft } from '../drafts/drafts.svelte'
import { listSkills } from '../skills/skills'
import { djb2 } from '../viewed/viewed.svelte'

// ---------------------------------------------------------------------------
// PanelState union
// ---------------------------------------------------------------------------

export type PanelStatus = 'idle' | 'no-key' | 'declined' | 'loading' | 'streaming' | 'done' | 'error'

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
}

// ---------------------------------------------------------------------------
// Task names (used as cache key discriminants + analytics)
// ---------------------------------------------------------------------------

type TaskName = 'summary' | 'attention' | 'diagrams' | 'verdict' | 'tests' | 'alternatives'

// ---------------------------------------------------------------------------
// SkillReviewEntry — reactive entry per skill in skillReviews array
// ---------------------------------------------------------------------------

export interface SkillReviewEntry {
  skillId: string
  name: string
  state: PanelState<SkillReviewResult>
}

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
  readonly skillReviews: SkillReviewEntry[]
  start(): Promise<void>
  retry(task: TaskName): Promise<void>
  coach(drafts: Draft[], prComments?: string[], verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): Promise<CoachResult | { error: string }>
  ask(question: string, onDelta: (t: string) => void, focus?: AskFocus): Promise<{ ok: true; answer: string } | { ok: false; error: string }>
  runSkillReviews(onUpdate?: () => void, existingComments?: string[]): Promise<void>
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
}

// ---------------------------------------------------------------------------
// DI dependencies (real implementations as defaults)
// ---------------------------------------------------------------------------

interface AiRunDeps {
  llmStream: typeof defaultLlmStream
  llmStreamWithUsage: typeof defaultLlmStreamWithUsage
  llmJsonWithRepair: typeof defaultLlmJsonWithRepair
  llmJsonWithRepairWithUsage: typeof defaultLlmJsonWithRepairWithUsage
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
    llmToolLoop: defaultLlmToolLoop,
    getCached: defaultGetCached,
    setCached: defaultSetCached,
    gateAi: defaultGateAi,
    track: defaultTrack,
    ...deps,
  }

  const { prKey, repo, isPrivate, pack, ci, ask: askConsent, deepReview } = input

  // Reactive panel state holders
  const summaryState = $state<PanelState<string>>({ status: 'idle' })
  const attentionState = $state<PanelState<AttentionResult>>({ status: 'idle' })
  const diagramsState = $state<PanelState<GraphResult>>({ status: 'idle' })
  const verdictState = $state<PanelState<VerdictResult>>({ status: 'idle' })
  const testsState = $state<PanelState<TestInsight>>({ status: 'idle' })
  const alternativesState = $state<PanelState<AlternativesResult>>({ status: 'idle' })

  // Skill review entries — populated on-demand by runSkillReviews()
  let skillReviewsState = $state<SkillReviewEntry[]>([])

  // Packed context — kept in closure so retry can reuse it without re-packing
  // (unless the initial pack failed, in which case retry re-packs)
  let packedCtx: PackedContext | null = null

  // ---------------------------------------------------------------------------
  // Internal: run a single task (summary streams; others use llmJsonWithRepair)
  // ---------------------------------------------------------------------------

  async function runSummaryTask(ctx: PackedContext): Promise<void> {
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
    const key = cacheKey(prKey, 'attention', PROMPT_VERSION)

    const t0 = performance.now()
    const hit = await getCached<AttentionResult>(key)
    if (hit !== null) {
      attentionState.status = 'done'
      attentionState.value = hit
      track('ai_task_completed', { task: 'attention', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    attentionState.status = 'loading'
    const t1 = performance.now()
    const prompts = attentionPrompt(ctx)

    try {
      const { result: attentionResult, usage: attentionUsage } = await llmJsonWithRepairWithUsage<AttentionResult>(
        { system: prompts.system, user: prompts.user },
        validateAttention,
      )
      await setCached<AttentionResult>(key, attentionResult)
      attentionState.status = 'done'
      attentionState.value = attentionResult
      track('ai_task_completed', {
        task: 'attention',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(attentionUsage?.total_tokens !== undefined ? { tokens: attentionUsage.total_tokens } : {}),
      })
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      attentionState.status = 'error'
      attentionState.error = humanMessage(kind)
      track('ai_task_failed', { task: 'attention', reason: kind })
    }
  }

  async function runDiagramsTask(ctx: PackedContext): Promise<void> {
    const key = cacheKey(prKey, 'diagrams', PROMPT_VERSION)

    const t0 = performance.now()
    const hit = await getCached<GraphResult>(key)
    if (hit !== null) {
      diagramsState.status = 'done'
      diagramsState.value = hit
      track('ai_task_completed', { task: 'diagrams', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    diagramsState.status = 'loading'
    const t1 = performance.now()
    const prompts = diagramsPrompt(ctx)

    try {
      const { result: diagramsResult, usage: diagramsUsage } = await llmJsonWithRepairWithUsage<GraphResult>(
        { system: prompts.system, user: prompts.user },
        validateGraphResult,
      )
      await setCached<GraphResult>(key, diagramsResult)
      diagramsState.status = 'done'
      diagramsState.value = diagramsResult
      track('ai_task_completed', {
        task: 'diagrams',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(diagramsUsage?.total_tokens !== undefined ? { tokens: diagramsUsage.total_tokens } : {}),
      })
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      diagramsState.status = 'error'
      diagramsState.error = humanMessage(kind)
      track('ai_task_failed', { task: 'diagrams', reason: kind })
    }
  }

  async function runTestsTask(ctx: PackedContext): Promise<void> {
    const deep = deepReviewAvailability(deepReview)
    if (deep.note) testsState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'tests|deep' : 'tests', PROMPT_VERSION)

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<TestInsight>>(key)
      if (hit !== null) {
        testsState.status = 'done'
        testsState.value = hit.result
        testsState.toolCallsUsed = hit.toolCallsUsed
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
        await setCached<DeepCached<TestInsight>>(key, { deep: true, result: testsResult, toolCallsUsed })
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
    const deep = deepReviewAvailability(deepReview)
    if (deep.note) alternativesState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'alternatives|deep' : 'alternatives', PROMPT_VERSION)

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<AlternativesResult>>(key)
      if (hit !== null) {
        alternativesState.status = 'done'
        alternativesState.value = hit.result
        alternativesState.toolCallsUsed = hit.toolCallsUsed
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
        await setCached<DeepCached<AlternativesResult>>(key, { deep: true, result: alternativesResult, toolCallsUsed })
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
    const deep = deepReviewAvailability(deepReview)
    if (deep.note) verdictState.note = deep.note
    const key = cacheKey(prKey, deep.enabled ? 'verdict|deep' : 'verdict', PROMPT_VERSION)

    const t0 = performance.now()
    if (deep.enabled) {
      const hit = await getCached<DeepCached<VerdictResult>>(key)
      if (hit !== null) {
        verdictState.status = 'done'
        verdictState.value = hit.result
        verdictState.toolCallsUsed = hit.toolCallsUsed
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
      const finalResult: VerdictResult = { ...verdictResult, notAnalyzed: merged }
      if (deep.enabled) {
        await setCached<DeepCached<VerdictResult>>(key, { deep: true, result: finalResult, toolCallsUsed: toolCallsUsed ?? 0 })
      } else {
        await setCached<VerdictResult>(key, finalResult)
      }
      verdictState.status = 'done'
      verdictState.value = finalResult
      verdictState.activity = undefined
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
    summaryState.status = status
    attentionState.status = status
    diagramsState.status = status
    verdictState.status = status
    testsState.status = status
    alternativesState.status = status
    if (error !== undefined) {
      summaryState.error = error
      attentionState.error = error
      diagramsState.error = error
      verdictState.error = error
      testsState.error = error
      alternativesState.error = error
    }
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
  }

  // ---------------------------------------------------------------------------
  // coach(drafts) — on-demand, never cached, never run in start()
  // ---------------------------------------------------------------------------

  async function coach(
    drafts: Draft[],
    prComments?: string[],
    verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  ): Promise<CoachResult | { error: string }> {
    // No-key check: same early-exit as start()
    if (!activeProviderHasKey()) {
      return { error: humanMessage('no-key') }
    }

    // Consent gate: private repos may quote code in comments (same gateAi / shared ask)
    const allowed = await gateAi({ repo, isPrivate, ask: askConsent })
    if (!allowed) {
      return { error: 'AI analysis was declined. Enable AI analysis in the consent dialog to use the comment coach.' }
    }

    // Map drafts to the coachPrompt input shape (index = array position)
    const draftInputs = drafts.map((d, i) => ({
      index: i,
      path: d.path,
      line: d.line,
      body: d.body,
    }))

    // Pack context if not already packed (best-effort, mirrors ask()) — the
    // diff context grounds the accuracy and grounded dimensions.
    if (packedCtx === null) {
      try {
        packedCtx = await pack()
      } catch {
        // Continue without packed context — coach still grades the rest
        packedCtx = { text: '', notAnalyzed: [], includedFiles: [], importGraph: '' }
      }
    }

    const prompts = coachPrompt(draftInputs, prComments, {
      ...(verdict !== undefined ? { verdict } : {}),
      ...(packedCtx.text ? { contextText: packedCtx.text } : {}),
    })
    const t1 = performance.now()

    try {
      const { result: coachResult, usage: coachUsage } = await llmJsonWithRepairWithUsage<CoachResult>(
        { system: prompts.system, user: prompts.user },
        validateCoachResult,
      )
      track('ai_task_completed', {
        task: 'coach',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(coachUsage?.total_tokens !== undefined ? { tokens: coachUsage.total_tokens } : {}),
      })
      return coachResult
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      track('ai_task_failed', { task: 'coach', reason: kind })
      return { error: humanMessage(kind) }
    }
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

  async function runSkillReviews(onUpdate?: () => void, existingComments?: string[]): Promise<void> {
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

    // Deep review (Plan G): one availability check for the whole batch.
    const deep = deepReviewAvailability(deepReview)

    // Initialize entries (loading state)
    skillReviewsState = skills.map((skill) => ({
      skillId: skill.id,
      name: skill.name,
      state: { status: 'loading' as const, ...(deep.note ? { note: deep.note } : {}) },
    }))
    onUpdate?.()

    // Run each skill in parallel, isolated
    await Promise.all(
      skills.map(async (skill, idx) => {
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
              state: { status: 'done', value: hit.result, toolCallsUsed: hit.toolCallsUsed },
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
            await setCached<DeepCached<SkillReviewResult>>(key, { deep: true, result: skillResult, toolCallsUsed })
          } else {
            const singlePass = await llmJsonWithRepairWithUsage<SkillReviewResult>(
              { system: prompts.system, user: prompts.user },
              validateSkillReviewResult,
            )
            skillResult = singlePass.result
            skillUsage = singlePass.usage
            await setCached<SkillReviewResult>(key, skillResult)
          }
          skillReviewsState[idx] = {
            skillId: skill.id,
            name: skill.name,
            state: {
              status: 'done',
              value: skillResult,
              ...(toolCallsUsed !== undefined ? { toolCallsUsed } : {}),
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
      }),
    )
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
    get skillReviews() { return skillReviewsState },
    start,
    retry,
    coach,
    ask,
    runSkillReviews,
  }
}
