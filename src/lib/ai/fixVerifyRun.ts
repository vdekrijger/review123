/**
 * src/lib/ai/fixVerifyRun.ts — wire the fix re-read (fixVerify.ts) to real
 * models, real personas and the real cache.
 *
 * fixVerify.ts is pure: prompts, validation, aggregation and words. This module
 * is the seam where it meets the app — which personas exist, which models the
 * panel resolves to, and where the answer is kept so re-opening the panel does
 * not re-spend.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A METHOD ON THE RUN STORE
 *
 * The panel that needs it (AgentFixPanel) is rendered by InspectStep, which
 * passes it exactly two props. Reaching the run store from there would mean a
 * third prop and a change to InspectStep. This pass needs NONE of the run
 * store's state — not the packed context, not the task modes, not the reviewer
 * entries. It needs the commits, the findings, the personas and the panel, all
 * of which are module-level reads. So it is a module-level function, and the
 * panel calls it directly.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CONSENT
 *
 * This pass sends the agent's diff to the configured providers, so it is
 * covered by the same per-repo consent every other task is gated on. It does
 * not re-ask, and it cannot: `gateAi` needs the repo and its visibility, which
 * live in the run input.
 *
 * It does not need to. This surface is UNREACHABLE without a granted consent:
 * its input is the fix run's output, the fix run's input is eligible FINDINGS,
 * and findings only exist because `runSkillReviews` already passed `gateAi` for
 * this repo (run.svelte.ts:3601). A panel with candidates in it is downstream
 * of a grant. If that ever stops being true — a findings source that does not
 * run through the reviewers — this pass must be re-gated explicitly.
 */

import { resolveEnsemble, verifierProviderConfigs } from '../llm/config'
import { llmJsonWithRepairFor, type LlmCompleteOpts, type ProviderConfig } from '../llm/llm'
import { getProvider } from '../llm/providers'
import { listSkillsForPhase } from '../skills/skills'
import { cacheKey, getCached, setCached } from '../cache/aiCache'
import { djb2 } from '../viewed/viewed.svelte'
import { promptVersionFor } from './tasks'
import {
  buildFixVerifyPrompt,
  runFixVerification,
  validateFixVerifyResponse,
  type FixFindingOutcome,
  type FixVerificationReport,
  type FixVerifyBatch,
  type FixVerifyParticipant,
  type FixVerifySubject,
} from './fixVerify'

/** One commit the agent handed back. */
export interface AgentFixChangeInput {
  findingId: string
  commit: string
  intent: string
  diff: string
  truncated: boolean
}

/** One finding as it was sent, with the reviewer that raised it. */
export interface AgentFixFindingInput {
  key: string
  skillName: string
  path: string
  line: number | null
  body: string
  suggestedFix: string
}

/** Everything injectable, so the wiring is testable without IDB or a network. */
export interface FixVerifyDeps {
  personaContent: (skillName: string) => string | null
  participants: () => FixVerifyParticipant[]
  complete: <T>(
    cfg: ProviderConfig,
    opts: LlmCompleteOpts,
    validate: (x: unknown) => T | null,
  ) => Promise<{ result: T; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>
  readCache: <T>(key: string) => Promise<T | null>
  writeCache: <T>(key: string, value: T) => Promise<void>
}

/**
 * Every persona the app knows, by name, across BOTH reviewer phases.
 *
 * Scope-scoped lists (#275) decide which reviewers RUN in a pass; a finding
 * already raised has to be re-read by its own persona whatever its scope says
 * now, so both phases are searched. A persona the user has since deleted or
 * renamed returns null, and the caller falls back rather than dropping the
 * finding.
 */
function defaultPersonaContent(skillName: string): string | null {
  for (const phase of ['implementation', 'tests'] as const) {
    const hit = listSkillsForPhase(phase).find((s) => s.name === skillName)
    if (hit) return hit.content
  }
  return null
}

/** A ProviderConfig's display name, for "who looked". */
function displayName(cfg: ProviderConfig): string {
  return getProvider(cfg.providerId)?.displayName ?? cfg.providerId
}

/**
 * The models that re-read the fix: the generator PLUS every verifier.
 *
 * Including the verifiers is the whole answer to "who spots problems the fix
 * introduced" — they did not raise the original finding and have no stake in
 * its fix. With a single configured model the poll is one, which every sentence
 * the panel prints says out loud ("1 of 1 model").
 */
function defaultParticipants(): FixVerifyParticipant[] {
  const out: FixVerifyParticipant[] = []
  const seen = new Set<string>()
  const add = (cfg: ProviderConfig): void => {
    const id = `${cfg.providerId}:${cfg.model.id}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({ provider: displayName(cfg), model: cfg.model.id, cfg })
  }

  // `resolveEnsemble` already falls back to the ACTIVE provider when no custom
  // panel is stored (config.ts `defaultResolvedPanel`), so a single-model user
  // is covered here without a second code path — and a user with no key at all
  // resolves to no participants, which reads `not-re-read` rather than silence.
  const gen = resolveEnsemble().generator
  if (gen) {
    add({
      providerId: gen.providerId,
      model: gen.model,
      key: gen.key,
      ...(gen.bridgeModel !== undefined ? { bridgeModel: gen.bridgeModel } : {}),
    })
  }
  for (const v of verifierProviderConfigs()) add(v)
  return out
}

const DEFAULT_DEPS: FixVerifyDeps = {
  personaContent: defaultPersonaContent,
  participants: defaultParticipants,
  complete: (cfg, opts, validate) => llmJsonWithRepairFor(cfg, opts, validate),
  readCache: getCached,
  writeCache: setCached,
}

/**
 * The cache key for one verification.
 *
 * Keyed on the COMMIT SHAS, which are content-addressed over the tree the agent
 * produced: the same commits can only mean the same diffs, so re-opening the
 * panel is free and a second fix run (new commits) is a clean miss. The finding
 * ids are in the hash too, because sending a subset back is a different
 * question with a different answer.
 */
export function fixVerifyCacheKey(
  headSha: string,
  changes: readonly AgentFixChangeInput[],
  models: readonly string[],
): string {
  const commits = [...changes].map((c) => `${c.findingId}@${c.commit}`).sort().join(',')
  const panel = [...models].sort().join(',')
  return cacheKey(`fix:${headSha}`, `fixVerify:${djb2(`${commits}|${panel}`)}`, promptVersionFor('fixVerify'))
}

/**
 * A finished pass, plus the two things about the PASS (not about the code) a
 * caller needs and the report itself cannot carry.
 *
 * `cached` exists because a cache hit and a fresh poll are the same report and
 * very different events: one spent model calls and minutes, the other spent
 * nothing. A metric that cannot tell them apart is a metric that reports the
 * feature getting cheaper every time somebody re-opens the panel.
 */
export interface FixVerifyOutcome {
  report: FixVerificationReport
  /** The answer came from the cache; no model was called. */
  cached: boolean
  /** Wall clock for this call, ms. Near-zero on a hit, by construction. */
  durationMs: number
}

/**
 * Run the verification once for a finished fix run, or return the cached one.
 *
 * Never throws: a failure anywhere returns a report in which the affected
 * findings read `not-re-read`, which the panel states plainly. Silence would be
 * indistinguishable from "checked, and clean", which is the one thing this
 * feature must never imply.
 *
 * The plain form is kept as the panel's original entry point; callers that need
 * to REPORT on the pass (the loop, and the analytics event) use
 * `verifyAgentFixDetailed` instead.
 */
export async function verifyAgentFix(
  headSha: string,
  changes: readonly AgentFixChangeInput[],
  findings: readonly AgentFixFindingInput[],
  overrides: Partial<FixVerifyDeps> = {},
): Promise<FixVerificationReport> {
  return (await verifyAgentFixDetailed(headSha, changes, findings, overrides)).report
}

/** The same pass, with whether it was cached and how long it took. */
export async function verifyAgentFixDetailed(
  headSha: string,
  changes: readonly AgentFixChangeInput[],
  findings: readonly AgentFixFindingInput[],
  overrides: Partial<FixVerifyDeps> = {},
): Promise<FixVerifyOutcome> {
  const started = Date.now()
  const since = (): number => Date.now() - started
  const deps: FixVerifyDeps = { ...DEFAULT_DEPS, ...overrides }
  const byKey = new Map(findings.map((f) => [f.key, f]))

  // Only changes we can attribute to a finding can be re-read: without the
  // original complaint there is nothing to ask "does this still stand?" about.
  const attributable = changes.filter((c) => byKey.has(c.findingId))
  if (attributable.length === 0) {
    return {
      report: { byFinding: [], newProblems: [], witnesses: [], calls: 0, failedCalls: 0 },
      // A pass with nothing to re-read spent nothing and read nothing. It is
      // not a cache hit; calling it one would report a saving that never
      // existed.
      cached: false,
      durationMs: since(),
    }
  }

  const participants = deps.participants()
  const key = fixVerifyCacheKey(headSha, attributable, participants.map((p) => `${p.provider}:${p.model}`))

  const hit = await deps.readCache<FixVerificationReport>(key)
  if (hit !== null) return { report: hit, cached: true, durationMs: since() }

  // One batch per PERSONA: the reviewer that raised a finding is the one asked
  // whether its own complaint still stands.
  const batches = new Map<string, FixVerifyBatch>()
  for (const change of attributable) {
    const finding = byKey.get(change.findingId)!
    const name = finding.skillName || 'The reviewer'
    let batch = batches.get(name)
    if (!batch) {
      batch = {
        persona: {
          name,
          // A persona the user has deleted or renamed since the review still
          // gets its finding re-read — under a plain descriptor rather than
          // someone else's criterion.
          content:
            deps.personaContent(name) ??
            `You are the code reviewer "${name}". Judge by the standard implied by the finding you raised.`,
        },
        subjects: [],
      }
      batches.set(name, batch)
    }
    const subject: FixVerifySubject = {
      id: finding.key,
      path: finding.path,
      line: finding.line,
      body: finding.body,
      suggestedFix: finding.suggestedFix,
      intent: change.intent,
      diff: change.diff,
      truncated: change.truncated,
    }
    batch.subjects.push(subject)
  }

  const report = await runFixVerification([...batches.values()], participants, async (cfg, persona, subjects) => {
    const prompts = buildFixVerifyPrompt(persona, subjects)
    const out = await deps.complete(cfg, prompts, validateFixVerifyResponse)
    return { result: out.result, ...(out.usage ? { usage: out.usage } : {}) }
  })

  // Only a COMPLETED pass is cached — the aiCache contract (EC-17d). A report
  // in which every call failed would otherwise pin "not re-read" forever, and
  // the retry the user obviously wants would never reach a model.
  if (report.calls > 0 && report.failedCalls < report.calls) await deps.writeCache(key, report)
  return { report, cached: false, durationMs: since() }
}

/**
 * The SHAPE of one verification pass, for the analytics event.
 *
 * Counts and enums only, derived here so the call site cannot improvise. Every
 * field is an integer or a boolean; nothing here can carry a finding, a path, a
 * persona's words, a model's output, a diff or a repo name — see the PRIVACY
 * DECISION block on `fix_verify_completed` in lib/analytics/analytics.ts.
 */
export interface FixVerifyShape {
  findings: number
  still_standing: number
  not_raised_again: number
  could_not_tell: number
  not_re_read: number
  new_problems: number
  /** How many DISTINCT models answered, not who they were. */
  models: number
  failed_calls: number
  cached: boolean
  duration_ms: number
}

/**
 * Fold a later round's re-read into what earlier rounds already observed.
 *
 * THE BOUNDED LOOP NEEDS THIS AND IT IS NOT A CONVENIENCE. Each round re-reads
 * only the commits IT produced: a finding that got its commit in round 1 and
 * was left alone afterwards has already been re-read against that exact commit,
 * and asking again would spend model calls to be told the same thing. So the
 * per-finding verdicts accumulate, latest round wins per finding, and the
 * counts add up across the whole loop.
 *
 * New problems accumulate too, deduplicated on the key `mergeNewProblems`
 * already assigns them — a problem raised against round 1's diff does not stop
 * being raised because round 2 touched a different file.
 */
export function mergeFixVerifyReports(
  prior: FixVerificationReport | null,
  next: FixVerificationReport,
): FixVerificationReport {
  if (prior === null) return next

  const byFinding = new Map(prior.byFinding.map((f) => [f.findingId, f]))
  for (const f of next.byFinding) byFinding.set(f.findingId, f)

  const problems = new Map(prior.newProblems.map((p) => [p.key, p]))
  for (const p of next.newProblems) if (!problems.has(p.key)) problems.set(p.key, p)

  const witnesses = [...prior.witnesses]
  for (const w of next.witnesses) if (!witnesses.includes(w)) witnesses.push(w)

  return {
    byFinding: [...byFinding.values()],
    newProblems: [...problems.values()],
    witnesses,
    calls: prior.calls + next.calls,
    failedCalls: prior.failedCalls + next.failedCalls,
  }
}

export function fixVerifyShape(outcome: FixVerifyOutcome): FixVerifyShape {
  const { report } = outcome
  const count = (o: FixFindingOutcome): number => report.byFinding.filter((f) => f.outcome === o).length
  return {
    findings: report.byFinding.length,
    still_standing: count('still-standing'),
    not_raised_again: count('not-raised-again'),
    could_not_tell: count('could-not-tell'),
    not_re_read: count('not-re-read'),
    new_problems: report.newProblems.length,
    // `witnesses` is a list of display names ("Anthropic · claude-…"). Only its
    // LENGTH leaves this function.
    models: report.witnesses.length,
    failed_calls: report.failedCalls,
    cached: outcome.cached,
    duration_ms: Math.round(outcome.durationMs),
  }
}
