/**
 * src/lib/ai/prepare.svelte.ts — Prepare-ahead: run the full auto AI pipeline
 * for a PR headlessly (from the Landing queue) so that opening the PR later
 * hits warm caches and the first look starts instantly.
 *
 * THE DESIGN: there is NO second orchestration. This module loads the PR data
 * through the SAME provider loaders the Review route uses (getPrMeta /
 * getPrFiles / fetchContents / getCiSummary), builds the SAME AiRunInput
 * (buildAiRunInput — the shared seam), and executes the SAME createAiRun
 * pipeline (start() + runSkillReviews()). Every task result lands in the same
 * IndexedDB cache under the same prKey + task segment + prompt version, so the
 * route's own run — created exactly as before — simply cache-hits.
 *
 * Product rules implemented here:
 *  - Explicit + per-PR: prepare only runs when the user clicks a queue row's
 *    "Prepare" control. No auto-prepare of the whole queue (token cost).
 *  - Single-flight: ONE prepare at a time. While one runs, other rows'
 *    Prepare buttons are disabled (the simpler honest option — no queue).
 *  - Task selection: exactly what the user enabled (aiTaskModes) — off stays
 *    off; the run's own mode gates enforce this. Skill reviewers run when the
 *    skills mode is on and skills are enabled: prepare is an explicit "do the
 *    review work now" action, so it includes them even when auto-run-on-open
 *    is off (documented judgment call).
 *  - Navigation safety (cancel-on-navigate): there is NO in-flight dedup
 *    between two concurrent AiRuns for the same PR — each run checks the cache
 *    only at task start, so a prepare racing the route's run would double-call
 *    the LLM. The cheap honest v1: opening the PR calls cancelPrepare(prId)
 *    (wired in Review.svelte), which flips a cancellation token. LLM calls
 *    that have not dispatched yet throw immediately (zero tokens); calls
 *    already on the wire run to completion and still write their cache. The
 *    route's fresh run takes over, resuming from whatever settled — nothing is
 *    lost thanks to the per-task caches, and the shared per-provider
 *    concurrency gate bounds any brief overlap.
 *  - Failure isolation: a task failing never blocks anything — the run's own
 *    per-task catch semantics apply unchanged. A prepare with failed tasks
 *    reports a calm, retryable error row; re-preparing re-runs only the
 *    missing tasks (errors are never cached).
 *  - Persistence: "prepared" is recorded per PR identity in localStorage
 *    (LRU-bounded) with the head SHA and the queue item's updatedAt. The
 *    Ready ✓ renders only while the queue item's updatedAt still matches —
 *    a new push (or any PR update) drops it back to "Prepare". updatedAt is
 *    deliberately conservative (it also moves on comments): the queue row
 *    cannot see the head SHA without a fetch, and a re-prepare on an unchanged
 *    head is nearly free (every task cache-hits).
 */

import { createAiRun, type AiRun, type PanelState } from './run.svelte'
import { buildAiRunInput, type ContentsMap } from './runInput'
import { fetchContents as defaultFetchContents } from '../context/pack'
import { providerFor } from '../provider/registry'
import { activeProviderHasKey } from '../llm/config'
import { getSettings } from '../settings/settings'
import { listSkills } from '../skills/skills'
import { track as defaultTrack } from '../analytics/analytics'
import {
  llmStream as defaultLlmStream,
  llmStreamWithUsage as defaultLlmStreamWithUsage,
  llmJsonWithRepair as defaultLlmJsonWithRepair,
  llmJsonWithRepairWithUsage as defaultLlmJsonWithRepairWithUsage,
  llmJsonWithRepairFor as defaultLlmJsonWithRepairFor,
} from '../llm/llm'
import { llmToolLoop as defaultLlmToolLoop } from '../llm/llmToolLoop'
import type { LlmUsage } from '../llm/llm'
import type { CiSummary } from '../github/checks'
import type { PrRefX, ReviewProvider } from '../provider/types'

// ---------------------------------------------------------------------------
// Reactive status store (one row per PR identity)
// ---------------------------------------------------------------------------

export type PrepareRowStatus = 'preparing' | 'ready' | 'error'

export interface PrepareRow {
  status: PrepareRowStatus
  /** Calm human lead line for the error state. */
  error?: string
  /** Concrete upstream detail for the hover idiom (title/tooltip). */
  errorDetail?: string
  /** Total captured usage for a settled 'ready' run (showTokenCost display). */
  usage?: LlmUsage
  /** Enabled reviewer count at start — progress denominator before entries exist. */
  expectedSkills: number
}

const rows = $state<Record<string, PrepareRow>>({})
const flight = $state<{ activeId: string | null }>({ activeId: null })

/**
 * Live AiRun per preparing row — kept OUTSIDE the reactive store (the run's
 * own panel states are already `$state`; reading them from a template tracks
 * them directly, no double-proxying).
 */
const liveRuns = new Map<string, AiRun>()

/** The active run's cancellation token (single-flight → at most one). */
let activeToken: { cancelled: boolean } | null = null

export const prepareStore = {
  get rows(): Record<string, PrepareRow> {
    return rows
  },
  /** The PR id of the prepare currently running, or null. */
  get activeId(): string | null {
    return flight.activeId
  },
}

/** Stable PR identity for prepare rows/records: "provider:owner/repo#number". */
export function preparePrId(providerId: string, owner: string, repo: string, number: number): string {
  return `${providerId}:${owner}/${repo}#${number}`
}

// ---------------------------------------------------------------------------
// Persistence — "prepared" records in localStorage, LRU-bounded
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'review123:prepared-reviews'

/** Max records kept — a small map; oldest (by preparedAt) evicted beyond this. */
export const PREPARED_LRU_MAX = 30

export interface PreparedRecord {
  /** Head SHA the pipeline actually ran against. */
  headSha: string
  /** The queue item's updatedAt at prepare time — the row's freshness check. */
  updatedAt: string
  /** Epoch ms when the prepare settled ready (LRU ordering). */
  preparedAt: number
  /** Number of AI tasks that actually executed. */
  tasksRun: number
  /** Total captured token usage, when the transport reported it. */
  usage?: LlmUsage
}

function isPreparedRecord(x: unknown): x is PreparedRecord {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return (
    typeof r['headSha'] === 'string' &&
    typeof r['updatedAt'] === 'string' &&
    typeof r['preparedAt'] === 'number' &&
    typeof r['tasksRun'] === 'number'
  )
}

function loadRecords(): Record<string, PreparedRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, PreparedRecord> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPreparedRecord(v)) out[k] = v
    }
    return out
  } catch {
    return {} // corrupt JSON / storage unavailable → treat as empty
  }
}

function saveRecords(map: Record<string, PreparedRecord>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // storage unavailable/full — persistence is best-effort
  }
}

/** Record a settled prepare; evicts the oldest entries beyond PREPARED_LRU_MAX. */
export function markPrepared(prId: string, record: PreparedRecord): void {
  const map = loadRecords()
  map[prId] = record
  const entries = Object.entries(map)
  if (entries.length > PREPARED_LRU_MAX) {
    entries.sort((a, b) => b[1].preparedAt - a[1].preparedAt)
    saveRecords(Object.fromEntries(entries.slice(0, PREPARED_LRU_MAX)))
    return
  }
  saveRecords(map)
}

/** The persisted record for a PR identity, or null. */
export function preparedRecord(prId: string): PreparedRecord | null {
  return loadRecords()[prId] ?? null
}

/**
 * Whether the Ready ✓ may honestly render for this queue row: a record exists
 * AND the row's current updatedAt still matches the one captured at prepare
 * time. Any PR update (new commits included) moves updatedAt → back to idle.
 */
export function isPreparedFor(prId: string, updatedAt: string): boolean {
  const rec = preparedRecord(prId)
  return rec !== null && rec.updatedAt === updatedAt
}

// ---------------------------------------------------------------------------
// Progress — "task K/N" derived from the live run's reactive panel states
// ---------------------------------------------------------------------------

export interface PrepareProgress {
  done: number
  total: number
}

function autoPanels(run: AiRun): PanelState<unknown>[] {
  return [
    run.summary,
    run.attention,
    run.diagrams,
    run.tests,
    run.alternatives,
    run.verdict,
    run.intent,
    run.outcomes,
    run.story,
    run.riskJudge,
  ]
}

const SETTLED = new Set(['done', 'error', 'skipped', 'no-key', 'declined'])

/**
 * Live progress for a preparing row, or null when it isn't preparing. Reads
 * the run's `$state` panels, so a template calling this re-renders as tasks
 * settle — no polling. Reviewer entries join the count once dispatched;
 * before that the enabled-skill count captured at start keeps N stable.
 */
export function prepareProgress(prId: string): PrepareProgress | null {
  const row = rows[prId]
  const run = liveRuns.get(prId)
  if (!row || row.status !== 'preparing' || !run) return null
  let done = 0
  let total = 0
  for (const p of autoPanels(run)) {
    if (p.status === 'disabled') continue
    total++
    if (SETTLED.has(p.status)) done++
  }
  if (run.skillReviews.length > 0) {
    for (const e of run.skillReviews) {
      total++
      if (SETTLED.has(e.state.status)) done++
    }
  } else {
    total += row.expectedSkills
  }
  return { done, total }
}

// ---------------------------------------------------------------------------
// Outcome tally — honest "is the cache actually warm?" accounting
// ---------------------------------------------------------------------------

interface Tally {
  ran: number
  errors: number
  error?: string
  errorDetail?: string
}

function tallyOutcome(run: AiRun): Tally {
  let ran = 0
  let errors = 0
  let firstError: string | undefined
  let firstDetail: string | undefined
  const fail = (lead: string | undefined, detail: string | undefined): void => {
    errors++
    if (firstError === undefined) {
      firstError = lead
      firstDetail = detail
    }
  }
  for (const p of autoPanels(run)) {
    if (p.status === 'done') {
      ran++
      // A story FALLBACK renders as 'done' but was NOT cached as an AI result
      // (only successful AI orderings are cached) — opening the PR would re-run
      // the story call, so a fallback prepare is not fully warm. Count it.
      if (p.fallback) fail('Story ordering fell back', p.fallbackReason)
    } else if (p.status === 'error') {
      ran++
      fail(p.error, p.errorDetail)
    }
  }
  // Convergence + simplify are sub-passes of the reviewer batch: 'idle' means
  // skipped (nothing to converge/rewrite — fine), 'error' means their result
  // was not cached and the route would re-spend on it.
  for (const s of [run.convergence, run.simplify]) {
    if (s.status === 'done') ran++
    else if (s.status === 'error') {
      ran++
      fail(s.error, s.errorDetail)
    }
  }
  for (const e of run.skillReviews) {
    if (e.state.status === 'done') ran++
    else if (e.state.status === 'error') {
      ran++
      fail(e.state.error, e.state.errorDetail)
    }
  }
  return { ran, errors, error: firstError, errorDetail: firstDetail }
}

// ---------------------------------------------------------------------------
// Cancellation — wrap the run's LLM deps with a pre-dispatch token check
// ---------------------------------------------------------------------------

type AiDeps = NonNullable<Parameters<typeof createAiRun>[1]>

/**
 * Guard an LLM function: once the token is cancelled, every NEW call throws
 * before dispatch (zero tokens). Calls already in flight are untouched — they
 * complete and write their cache (results are never wasted).
 */
function cancelGuard<T extends (...args: never[]) => unknown>(
  token: { cancelled: boolean },
  fn: T,
): T {
  return ((...args: never[]) => {
    if (token.cancelled) throw new Error('prepare cancelled — the opened review takes over')
    return fn(...args)
  }) as T
}

/**
 * Build the run deps for a prepare: the caller's overrides (tests) or the real
 * transports, each behind the cancel guard; the run's analytics are muted the
 * moment the prepare is cancelled (a discarded run's task events would only
 * pollute the failure metrics).
 */
function wrapDeps(token: { cancelled: boolean }, base: AiDeps | undefined): AiDeps {
  const baseTrack = base?.track ?? defaultTrack
  return {
    ...base,
    llmStream: cancelGuard(token, base?.llmStream ?? defaultLlmStream),
    llmStreamWithUsage: cancelGuard(token, base?.llmStreamWithUsage ?? defaultLlmStreamWithUsage),
    // The three generic transports need an explicit cast back to their generic
    // signatures — wrapping instantiates the type parameter, which TS cannot
    // re-generalize on its own. The wrappers only add the pre-dispatch check.
    llmJsonWithRepair: cancelGuard(
      token,
      base?.llmJsonWithRepair ?? defaultLlmJsonWithRepair,
    ) as typeof defaultLlmJsonWithRepair,
    llmJsonWithRepairWithUsage: cancelGuard(
      token,
      base?.llmJsonWithRepairWithUsage ?? defaultLlmJsonWithRepairWithUsage,
    ) as typeof defaultLlmJsonWithRepairWithUsage,
    llmJsonWithRepairFor: cancelGuard(
      token,
      base?.llmJsonWithRepairFor ?? defaultLlmJsonWithRepairFor,
    ) as typeof defaultLlmJsonWithRepairFor,
    llmToolLoop: cancelGuard(token, base?.llmToolLoop ?? defaultLlmToolLoop),
    track: ((event, props) => {
      if (!token.cancelled) baseTrack(event, props)
    }) as typeof defaultTrack,
  }
}

// ---------------------------------------------------------------------------
// preparePr — the headless pipeline
// ---------------------------------------------------------------------------

export interface PrepareTarget {
  providerId: string
  owner: string
  repo: string
  number: number
  /** The queue item's updatedAt — captured into the prepared record. */
  updatedAt: string
}

export type PrepareOutcome = 'ready' | 'error' | 'cancelled' | 'declined' | 'load-failed'

export type PrepareResult =
  | { started: false; reason: 'busy' | 'no-key' }
  | { started: true; outcome: PrepareOutcome }

export interface PrepareDeps {
  /** Provider resolution (tests inject a stub provider). */
  provider?: (providerId: string) => ReviewProvider
  /** File-contents fetch (defaults to the shared pack fetcher). */
  fetchContents?: typeof defaultFetchContents
  /** Deps forwarded into createAiRun (tests stub the LLM transports here). */
  aiDeps?: AiDeps
  now?: () => number
  track?: typeof defaultTrack
}

export async function preparePr(target: PrepareTarget, deps: PrepareDeps = {}): Promise<PrepareResult> {
  const { providerId, owner, repo, number } = target
  const prId = preparePrId(providerId, owner, repo, number)

  // Single-flight: one prepare at a time (rule 2). The UI disables the other
  // rows' buttons; this guard is the backstop.
  if (flight.activeId !== null) return { started: false, reason: 'busy' }
  // BYO-key gate: without a key nothing can run (the UI shows the hint).
  if (!activeProviderHasKey()) return { started: false, reason: 'no-key' }

  const now = deps.now ?? (() => Date.now())
  const trackFn = deps.track ?? defaultTrack
  const token = { cancelled: false }
  activeToken = token
  flight.activeId = prId

  const skillsOn = getSettings().aiTaskModes.skills !== 'off'
  const expectedSkills = skillsOn ? listSkills().filter((s) => s.enabled).length : 0
  rows[prId] = { status: 'preparing', expectedSkills }

  const t0 = now()
  const settle = (outcome: PrepareOutcome, tasksRun: number): PrepareResult => {
    trackFn('review_prepared', {
      outcome,
      tasks_run: tasksRun,
      duration_ms: Math.round(now() - t0),
    })
    return { started: true, outcome }
  }
  const settleCancelled = (): PrepareResult => {
    // cancelPrepare already reset the row/slot; belt-and-braces cleanup here.
    if (rows[prId]?.status === 'preparing') delete rows[prId]
    liveRuns.delete(prId)
    return settle('cancelled', 0)
  }

  try {
    // ---- Load the PR through the SAME provider loaders the route uses ----
    const provider = (deps.provider ?? providerFor)(providerId)
    const ref: PrRefX = { provider: providerId as PrRefX['provider'], owner, repo, number }
    const [meta, files] = await Promise.all([provider.getPrMeta(ref), provider.getPrFiles(ref)])
    if (token.cancelled) return settleCancelled()

    // Memoized shared fetches — the same idiom as the route's getContents/getCi.
    let contentsPromise: Promise<ContentsMap> | null = null
    let contentsNow: ContentsMap | null = null
    const getContents = (): Promise<ContentsMap> => {
      if (!contentsPromise) {
        contentsPromise = (deps.fetchContents ?? defaultFetchContents)({ owner, repo }, files, meta).catch(
          () => new Map(),
        )
        void contentsPromise.then((m) => {
          contentsNow = m
        })
      }
      return contentsPromise
    }
    let ciPromise: Promise<CiSummary | null> | null = null
    const getCi = (): Promise<CiSummary | null> => {
      if (!ciPromise) ciPromise = provider.getCiSummary(ref, meta.headSha).catch(() => null)
      return ciPromise
    }

    const input = buildAiRunInput({
      providerId,
      provider,
      owner,
      repo,
      number,
      meta,
      files,
      getContents,
      contentsNow: () => contentsNow,
      getCi,
      // Headless: never pop a dialog. Public repos pass gateAi without asking;
      // a private repo WITHOUT stored consent declines → surfaced below as the
      // calm "open the PR once" row error. Consent granted on the PR page is
      // persisted, so a previously-opened private repo prepares fine.
      ask: () => Promise.resolve(false),
      // No draft store here: the convergence pass runs draft-less. If the user
      // has drafts, the route's pass recomputes with them (one cheap call) —
      // loss-proof either way.
    })

    const run = createAiRun(input, wrapDeps(token, deps.aiDeps))
    liveRuns.set(prId, run)

    // ---- Phase 1: the auto tasks (identical to the route's run.start()) ----
    await run.start()
    if (token.cancelled) return settleCancelled()

    // Consent declined (private repo never opened) → calm, actionable row.
    if (autoPanels(run).some((p) => p.status === 'declined')) {
      rows[prId] = {
        status: 'error',
        error: 'AI consent needed — open the PR once and allow AI analysis, then prepare.',
        expectedSkills,
      }
      liveRuns.delete(prId)
      return settle('declined', 0)
    }
    if (autoPanels(run).some((p) => p.status === 'no-key')) {
      rows[prId] = {
        status: 'error',
        error: 'No API key configured — add your key in Settings to prepare reviews.',
        expectedSkills,
      }
      liveRuns.delete(prId)
      return settle('error', 0)
    }

    // ---- Phase 2: skill reviewers + convergence + simplify (as the route) ----
    if (skillsOn && !token.cancelled) {
      // Existing PR comments are a dedupe aid for the reviewers — best-effort,
      // same as the route (which passes whatever has loaded).
      let comments: string[] = []
      try {
        comments = (await provider.getComments(ref)).map((c) => c.body)
      } catch {
        comments = []
      }
      if (!token.cancelled) await run.runSkillReviews(undefined, comments, { autoRetry: 3 })
    }
    if (token.cancelled) return settleCancelled()

    // ---- Settle ----
    const tally = tallyOutcome(run)
    liveRuns.delete(prId)
    if (tally.errors > 0) {
      rows[prId] = {
        status: 'error',
        error: `${tally.errors} of ${tally.ran} AI tasks failed`,
        ...(tally.errorDetail ?? tally.error
          ? { errorDetail: tally.errorDetail ?? tally.error }
          : {}),
        expectedSkills,
      }
      return settle('error', tally.ran)
    }
    const usage = run.totalUsage
    markPrepared(prId, {
      headSha: meta.headSha,
      updatedAt: target.updatedAt,
      preparedAt: now(),
      tasksRun: tally.ran,
      ...(usage ? { usage } : {}),
    })
    rows[prId] = { status: 'ready', ...(usage ? { usage } : {}), expectedSkills }
    return settle('ready', tally.ran)
  } catch (err) {
    if (token.cancelled) return settleCancelled()
    liveRuns.delete(prId)
    rows[prId] = {
      status: 'error',
      error: "Couldn't load the PR to prepare it.",
      errorDetail: err instanceof Error ? err.message : String(err),
      expectedSkills,
    }
    return settle('load-failed', 0)
  } finally {
    if (flight.activeId === prId) flight.activeId = null
    if (activeToken === token) activeToken = null
  }
}

/**
 * Cancel the in-flight prepare for a PR (no-op for any other id). Called by
 * the Review route the moment it initializes its own AI run for the PR, so
 * prepare and route never race the same tasks: pending prepare calls throw
 * before dispatch, in-flight ones finish and still warm the cache, and the
 * row returns to idle immediately.
 */
export function cancelPrepare(prId: string): void {
  if (flight.activeId !== prId || activeToken === null) return
  activeToken.cancelled = true
  flight.activeId = null
  activeToken = null
  delete rows[prId]
  liveRuns.delete(prId)
}

/** FOR TESTS ONLY: reset module-level state (not localStorage). */
export function _resetPrepareForTest(): void {
  for (const k of Object.keys(rows)) delete rows[k]
  flight.activeId = null
  if (activeToken) activeToken.cancelled = true
  activeToken = null
  liveRuns.clear()
}
