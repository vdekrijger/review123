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
  llmStreamWithUsage as defaultLlmStreamWithUsage,
  llmJsonWithRepair as defaultLlmJsonWithRepair,
  llmJsonWithRepairWithUsage as defaultLlmJsonWithRepairWithUsage,
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
  testInsightPrompt,
  coachPrompt,
  alternativesPrompt,
  askPrompt,
  skillReviewPrompt,
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
  coach(drafts: Draft[], prComments?: string[]): Promise<CoachResult | { error: string }>
  ask(question: string, onDelta: (t: string) => void, focus?: AskFocus): Promise<{ ok: true; answer: string } | { ok: false; error: string }>
  runSkillReviews(onUpdate?: () => void): Promise<void>
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
  llmStreamWithUsage: typeof defaultLlmStreamWithUsage
  llmJsonWithRepair: typeof defaultLlmJsonWithRepair
  llmJsonWithRepairWithUsage: typeof defaultLlmJsonWithRepairWithUsage
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
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    getCached,
    setCached,
    gateAi,
    track,
  }: AiRunDeps = {
    llmStream: defaultLlmStream,
    llmStreamWithUsage: defaultLlmStreamWithUsage,
    llmJsonWithRepair: defaultLlmJsonWithRepair,
    llmJsonWithRepairWithUsage: defaultLlmJsonWithRepairWithUsage,
    getCached: defaultGetCached,
    setCached: defaultSetCached,
    gateAi: defaultGateAi,
    track: defaultTrack,
    ...deps,
  }

  const { prKey, repo, isPrivate, pack, ci, ask: askConsent } = input

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
    const key = cacheKey(prKey, 'tests', PROMPT_VERSION)

    const t0 = performance.now()
    const hit = await getCached<TestInsight>(key)
    if (hit !== null) {
      testsState.status = 'done'
      testsState.value = hit
      track('ai_task_completed', { task: 'tests', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    testsState.status = 'loading'
    const t1 = performance.now()
    const prompts = testInsightPrompt(ctx)

    try {
      const { result: testsResult, usage: testsUsage } = await llmJsonWithRepairWithUsage<TestInsight>(
        { system: prompts.system, user: prompts.user },
        validateTestInsight,
      )
      await setCached<TestInsight>(key, testsResult)
      testsState.status = 'done'
      testsState.value = testsResult
      track('ai_task_completed', {
        task: 'tests',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(testsUsage?.total_tokens !== undefined ? { tokens: testsUsage.total_tokens } : {}),
      })
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      testsState.status = 'error'
      testsState.error = humanMessage(kind)
      track('ai_task_failed', { task: 'tests', reason: kind })
    }
  }

  async function runAlternativesTask(ctx: PackedContext): Promise<void> {
    const key = cacheKey(prKey, 'alternatives', PROMPT_VERSION)

    const t0 = performance.now()
    const hit = await getCached<AlternativesResult>(key)
    if (hit !== null) {
      alternativesState.status = 'done'
      alternativesState.value = hit
      track('ai_task_completed', { task: 'alternatives', duration_ms: Math.round(performance.now() - t0), cached: true })
      return
    }

    alternativesState.status = 'loading'
    const t1 = performance.now()
    const prompts = alternativesPrompt(ctx)

    try {
      const { result: alternativesResult, usage: alternativesUsage } = await llmJsonWithRepairWithUsage<AlternativesResult>(
        { system: prompts.system, user: prompts.user },
        validateAlternativesResult,
      )
      await setCached<AlternativesResult>(key, alternativesResult)
      alternativesState.status = 'done'
      alternativesState.value = alternativesResult
      track('ai_task_completed', {
        task: 'alternatives',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(alternativesUsage?.total_tokens !== undefined ? { tokens: alternativesUsage.total_tokens } : {}),
      })
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unknown'
      alternativesState.status = 'error'
      alternativesState.error = humanMessage(kind)
      track('ai_task_failed', { task: 'alternatives', reason: kind })
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
      const { result: verdictResult, usage: verdictUsage } = await llmJsonWithRepairWithUsage<VerdictResult>(
        { system: prompts.system, user: prompts.user },
        validateVerdict,
      )
      // Merge notAnalyzed: union of packed context's notAnalyzed + model's own list (EC-15c)
      const merged = [...new Set([...ctx.notAnalyzed, ...verdictResult.notAnalyzed])]
      const finalResult: VerdictResult = { ...verdictResult, notAnalyzed: merged }
      await setCached<VerdictResult>(key, finalResult)
      verdictState.status = 'done'
      verdictState.value = finalResult
      track('ai_task_completed', {
        task: 'verdict',
        duration_ms: Math.round(performance.now() - t1),
        cached: false,
        ...(verdictUsage?.total_tokens !== undefined ? { tokens: verdictUsage.total_tokens } : {}),
      })
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
    // No-key check: if no DeepSeek key, set all panels to 'no-key' (EC-12a)
    // Do this before consent dialog — no point asking consent if there's no key
    const settings = getSettings()
    if (!settings.deepseekKey) {
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

  async function coach(drafts: Draft[], prComments?: string[]): Promise<CoachResult | { error: string }> {
    // No-key check: same early-exit as start()
    const settings = getSettings()
    if (!settings.deepseekKey) {
      return { error: 'No DeepSeek API key configured.' }
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

    const prompts = coachPrompt(draftInputs, prComments)
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
    const settings = getSettings()
    if (!settings.deepseekKey) {
      return { ok: false, error: 'No DeepSeek API key configured.' }
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

  async function runSkillReviews(onUpdate?: () => void): Promise<void> {
    // No-key gate: same early-exit as start() and coach()
    const settings = getSettings()
    if (!settings.deepseekKey) return

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

    // Initialize entries (loading state)
    skillReviewsState = skills.map((skill) => ({
      skillId: skill.id,
      name: skill.name,
      state: { status: 'loading' as const },
    }))
    onUpdate?.()

    // Run each skill in parallel, isolated
    await Promise.all(
      skills.map(async (skill, idx) => {
        // Content-addressed cache key: includes djb2(skill.content)
        const key = cacheKey(prKey, 'skill:' + djb2(skill.content), PROMPT_VERSION)

        const t0 = performance.now()

        // Cache check
        const hit = await getCached<SkillReviewResult>(key)
        if (hit !== null) {
          skillReviewsState[idx] = {
            skillId: skill.id,
            name: skill.name,
            state: { status: 'done', value: hit },
          }
          track('ai_task_completed', {
            task: 'skill-review',
            duration_ms: Math.round(performance.now() - t0),
            cached: true,
          })
          onUpdate?.()
          return
        }

        const prompts = skillReviewPrompt(ctx, { name: skill.name, content: skill.content })

        try {
          const { result: skillResult, usage: skillUsage } = await llmJsonWithRepairWithUsage<SkillReviewResult>(
            { system: prompts.system, user: prompts.user },
            validateSkillReviewResult,
          )
          await setCached<SkillReviewResult>(key, skillResult)
          skillReviewsState[idx] = {
            skillId: skill.id,
            name: skill.name,
            state: { status: 'done', value: skillResult },
          }
          track('ai_task_completed', {
            task: 'skill-review',
            duration_ms: Math.round(performance.now() - t0),
            cached: false,
            ...(skillUsage?.total_tokens !== undefined ? { tokens: skillUsage.total_tokens } : {}),
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
