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

import { getSettings } from '../settings/settings'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import {
  llmStream as defaultLlmStream,
  llmJsonWithRepair as defaultLlmJsonWithRepair,
  LlmError,
} from '../llm/llm'
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
} from './tasks'
import { validateAttention, validateVerdict, validateGraphResult } from './schemas'
import type { AttentionResult, VerdictResult, GraphResult } from './schemas'

// ---------------------------------------------------------------------------
// PanelState union
// ---------------------------------------------------------------------------

export type PanelStatus = 'idle' | 'no-key' | 'declined' | 'loading' | 'streaming' | 'done' | 'error'

export interface PanelState<T> {
  status: PanelStatus
  value?: T | string
  error?: string
}

// ---------------------------------------------------------------------------
// Task names (used as cache key discriminants + analytics)
// ---------------------------------------------------------------------------

type TaskName = 'summary' | 'attention' | 'diagrams' | 'verdict'

// ---------------------------------------------------------------------------
// AiRun public interface
// ---------------------------------------------------------------------------

export interface AiRun {
  readonly summary: PanelState<string>
  readonly attention: PanelState<AttentionResult>
  readonly diagrams: PanelState<GraphResult>
  readonly verdict: PanelState<VerdictResult>
  start(): Promise<void>
  retry(task: TaskName): Promise<void>
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
}

// ---------------------------------------------------------------------------
// DI dependencies (real implementations as defaults)
// ---------------------------------------------------------------------------

interface AiRunDeps {
  llmStream: typeof defaultLlmStream
  llmJsonWithRepair: typeof defaultLlmJsonWithRepair
  getCached: typeof defaultGetCached
  setCached: typeof defaultSetCached
  gateAi: typeof defaultGateAi
  track: typeof defaultTrack
}

// ---------------------------------------------------------------------------
// Human-readable error messages per LlmError kind
// ---------------------------------------------------------------------------

function humanMessage(kind: string): string {
  switch (kind) {
    case 'no-key': return 'No DeepSeek API key configured.'
    case 'auth': return 'API key was rejected. Please check your DeepSeek key in Settings.'
    case 'rate-limited': return 'Rate limited by DeepSeek. Please try again in a moment.'
    case 'server': return 'DeepSeek server error. Please try again later.'
    case 'network': return 'Network error reaching DeepSeek. Check your connection.'
    case 'timeout': return 'Request to DeepSeek timed out. Please try again.'
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
    llmJsonWithRepair,
    getCached,
    setCached,
    gateAi,
    track,
  }: AiRunDeps = {
    llmStream: defaultLlmStream,
    llmJsonWithRepair: defaultLlmJsonWithRepair,
    getCached: defaultGetCached,
    setCached: defaultSetCached,
    gateAi: defaultGateAi,
    track: defaultTrack,
    ...deps,
  }

  const { prKey, repo, isPrivate, pack, ci, ask } = input

  // Reactive panel state holders
  const summaryState = $state<PanelState<string>>({ status: 'idle' })
  const attentionState = $state<PanelState<AttentionResult>>({ status: 'idle' })
  const diagramsState = $state<PanelState<GraphResult>>({ status: 'idle' })
  const verdictState = $state<PanelState<VerdictResult>>({ status: 'idle' })

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
      const result = await llmStream(prompts, (delta: string) => {
        accumulated += delta
        summaryState.status = 'streaming'
        summaryState.value = accumulated
      })
      // Only cache after complete success (EC-17d / EC-12f)
      await setCached<string>(key, result)
      summaryState.status = 'done'
      summaryState.value = result
      track('ai_task_completed', { task: 'summary', duration_ms: Math.round(performance.now() - t1), cached: false })
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
      const result = await llmJsonWithRepair<AttentionResult>(
        { system: prompts.system, user: prompts.user },
        validateAttention,
      )
      await setCached<AttentionResult>(key, result)
      attentionState.status = 'done'
      attentionState.value = result
      track('ai_task_completed', { task: 'attention', duration_ms: Math.round(performance.now() - t1), cached: false })
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
      const result = await llmJsonWithRepair<GraphResult>(
        { system: prompts.system, user: prompts.user },
        validateGraphResult,
      )
      await setCached<GraphResult>(key, result)
      diagramsState.status = 'done'
      diagramsState.value = result
      track('ai_task_completed', { task: 'diagrams', duration_ms: Math.round(performance.now() - t1), cached: false })
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      diagramsState.status = 'error'
      diagramsState.error = humanMessage(kind)
      track('ai_task_failed', { task: 'diagrams', reason: kind })
    }
  }

  async function runVerdictTask(ctx: PackedContext, ciData: CiSummary | null): Promise<void> {
    const key = cacheKey(prKey, 'verdict', PROMPT_VERSION)

    const t0 = performance.now()
    const hit = await getCached<VerdictResult>(key)
    if (hit !== null) {
      verdictState.status = 'done'
      verdictState.value = hit
      track('ai_task_completed', { task: 'verdict', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    verdictState.status = 'loading'
    const t1 = performance.now()
    const prompts = verdictPrompt(ctx, ciData)

    try {
      const result = await llmJsonWithRepair<VerdictResult>(
        { system: prompts.system, user: prompts.user },
        validateVerdict,
      )
      // Merge notAnalyzed: union of packed context's notAnalyzed + model's own list (EC-15c)
      const merged = [...new Set([...ctx.notAnalyzed, ...result.notAnalyzed])]
      const finalResult: VerdictResult = { ...result, notAnalyzed: merged }
      await setCached<VerdictResult>(key, finalResult)
      verdictState.status = 'done'
      verdictState.value = finalResult
      track('ai_task_completed', { task: 'verdict', duration_ms: Math.round(performance.now() - t1), cached: false })
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      verdictState.status = 'error'
      verdictState.error = humanMessage(kind)
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
    if (error !== undefined) {
      summaryState.error = error
      attentionState.error = error
      diagramsState.error = error
      verdictState.error = error
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
    // No-key check: if no DeepSeek key, set all panels to 'no-key' (EC-12a)
    // Do this before consent dialog — no point asking consent if there's no key
    const settings = getSettings()
    if (!settings.deepseekKey) {
      setAllPanels('no-key')
      return
    }

    // Consent gate (EC-11c): declined → all 'declined', no AI calls
    const allowed = await gateAi({ repo, isPrivate, ask })
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

    // Run all four tasks in parallel, each isolated (EC-12c / EC-13g)
    await Promise.all([
      runSummaryTask(ctx),
      runAttentionTask(ctx),
      runDiagramsTask(ctx),
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
  }

  // ---------------------------------------------------------------------------
  // Return reactive state + methods
  // ---------------------------------------------------------------------------

  return {
    get summary() { return summaryState },
    get attention() { return attentionState },
    get diagrams() { return diagramsState },
    get verdict() { return verdictState },
    start,
    retry,
  }
}
