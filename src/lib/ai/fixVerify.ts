/**
 * src/lib/ai/fixVerify.ts — look ONCE at what the agent changed, and report it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SINGLE PASS AND NOT A LOOP
 *
 * The obvious feature request is "keep fixing until no findings remain". It is
 * refused on purpose. The inner loop in bridge/src/fix.ts already terminates on
 * the TESTS — an oracle with no opinion about the code. Looping on FINDINGS
 * instead would terminate on reviewer judgment, and this repo's own eval
 * measured that judgment returning 1/3, 3/3, 2/3 and 1/3 on the SAME defect in
 * identical code across runs. "No findings" is therefore not a fixed point, and
 * a fixer optimising against its own reviewer family converges on text that
 * satisfies the reviewer rather than on correct code.
 *
 * So: run the check ONCE, show what was observed, and let the human choose what
 * to send back. Sending the still-open findings for another round is one click
 * (the panel), never an automatic loop.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHO RE-EXAMINES, and why
 *
 * Two different questions are asked in ONE call, because they need different
 * kinds of witness and it would be wasteful to pay twice:
 *
 *   1. "Does your complaint still stand?" — asked of the PERSONA THAT RAISED
 *      IT. The criterion belongs to that persona; handing the complaint to a
 *      different reviewer asks a different question and answers neither.
 *
 *   2. "What did this change break?" — the raiser is the WORST witness for its
 *      own fix (it asked for this change and is looking for its own
 *      satisfaction), so this leg needs eyes with no stake. It gets them the
 *      way this repo always gets them: MODEL diversity. The pass runs on the
 *      resolved panel — the generator PLUS every verifier — so the models that
 *      did not raise the finding are in the room for both questions. That is
 *      the repo's own stated decorrelation philosophy ("decorrelation comes
 *      from MODEL/PROVIDER diversity, not from per-judge framing"), reused
 *      rather than re-invented.
 *
 * Re-running all eleven personas over a small diff would be both expensive and
 * off-target; the cost here is (distinct raising personas) × (panel models),
 * which for a real fix batch is a handful of calls, and exactly one when the
 * user has a single model configured.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE HONESTY RULES, which are the whole point
 *
 * a. NOTHING HERE SAYS "FIXED". The outcome vocabulary is observational —
 *    `not-raised-again` is a report about a reviewer, not a claim about code.
 *    Given the measured variance above, a green check saying "fixed" would be a
 *    machine for manufacturing false confidence about unreviewed code.
 *
 * b. TIES AND UNCERTAINTY KEEP A FINDING OPEN. The aggregation mirrors
 *    crossVerify's `score >= polled / 2` threshold, with the asymmetry pointed
 *    the honest way: a finding is STILL STANDING unless the models positively
 *    agree it went quiet. An `unsure` vote weighs 0.5 and therefore, alone,
 *    keeps it open.
 *
 * c. THE LOOP'S OWN VERDICT WINS. `round-cap` means the commit came back with
 *    the tests RED; `no-progress` and `repeat-diff` mean the agent was stuck or
 *    oscillating. No re-read gets to soften any of those — see
 *    `describeVerificationUnder`.
 *
 * d. THIS PASS IS NOT A CODE REVIEW. It runs before a human reads the diff, and
 *    it must never imply it has discharged that job.
 */

import type { LlmUsage, ProviderConfig } from '../llm/llm'
import type { BridgeFixStopReason } from '../bridge/protocol'
import { findingsMatch, type AnchoredFinding } from './findingMatch'

// ---------------------------------------------------------------------------
// Prompt version note: this pass has its OWN PROMPT_VERSIONS entry
// ('fixVerify' in tasks.ts) rather than overloading `skills`. It is a new
// prompt over a new input; bumping an existing task's entry would cold-
// invalidate review caches that no prompt change touched.
// ---------------------------------------------------------------------------

/** How much of one commit's diff is shipped to the re-read. */
export const FIX_VERIFY_MAX_DIFF_CHARS = 12_000

/** Hard ceiling on model calls for one verification, whatever the panel says. */
export const FIX_VERIFY_MAX_CALLS = 12

// ---------------------------------------------------------------------------
// What a model is asked, and what it may answer
// ---------------------------------------------------------------------------

/**
 * One model's read of one original finding against the fix.
 *
 * Deliberately NOT 'fixed' / 'unfixed'. `not-raised-again` is the strongest
 * thing a reviewer can honestly report about its own complaint: it looked and
 * did not raise it. Whether the defect is gone is a different claim, and this
 * pass is not entitled to make it.
 */
export type FixReReadVerdict = 'still-standing' | 'not-raised-again' | 'unsure'

/** A problem the fix ITSELF introduced, as one model describes it. */
export interface FixNewProblem {
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
  suggestedFix: string
}

/** One model's whole answer for one persona's batch. */
export interface FixVerifyResponse {
  reReads: { id: string; verdict: FixReReadVerdict; reason: string }[]
  newProblems: FixNewProblem[]
}

const VERDICT_VALUES: ReadonlySet<string> = new Set([
  'still-standing',
  'not-raised-again',
  'unsure',
])
const SEVERITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low'])

/**
 * Narrow one model's answer. Tolerant in the same direction crossVerify's
 * validator is: a malformed `newProblems` entry is DROPPED rather than
 * rejecting the whole response, because the re-read verdicts stay valuable
 * without it. An unreadable verdict, by contrast, is dropped entirely — and a
 * finding with no verdict aggregates as unexamined, never as resolved.
 */
export function validateFixVerifyResponse(x: unknown): FixVerifyResponse | null {
  if (typeof x !== 'object' || x === null) return null
  const obj = x as Record<string, unknown>
  if (!Array.isArray(obj['reReads'])) return null

  const reReads: FixVerifyResponse['reReads'] = []
  for (const r of obj['reReads']) {
    if (typeof r !== 'object' || r === null) continue
    const ro = r as Record<string, unknown>
    if (typeof ro['id'] !== 'string') continue
    if (typeof ro['verdict'] !== 'string' || !VERDICT_VALUES.has(ro['verdict'])) continue
    reReads.push({
      id: ro['id'],
      verdict: ro['verdict'] as FixReReadVerdict,
      reason: typeof ro['reason'] === 'string' ? ro['reason'] : '',
    })
  }

  const newProblems: FixNewProblem[] = []
  if (Array.isArray(obj['newProblems'])) {
    for (const p of obj['newProblems']) {
      if (typeof p !== 'object' || p === null) continue
      const po = p as Record<string, unknown>
      if (typeof po['path'] !== 'string' || po['path'].trim() === '') continue
      if (typeof po['body'] !== 'string' || po['body'].trim() === '') continue
      const line = typeof po['line'] === 'number' && Number.isFinite(po['line']) ? po['line'] : null
      const severity = typeof po['severity'] === 'string' && SEVERITIES.has(po['severity'])
        ? (po['severity'] as FixNewProblem['severity'])
        : 'medium'
      newProblems.push({
        path: po['path'].trim(),
        line,
        severity,
        body: po['body'].trim(),
        suggestedFix: typeof po['suggestedFix'] === 'string' ? po['suggestedFix'].trim() : '',
      })
    }
  }

  return { reReads, newProblems }
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** One original finding, as the re-read needs to see it. */
export interface FixVerifySubject {
  /** The finding key — the same id the bridge was given. */
  id: string
  path: string
  line: number | null
  body: string
  suggestedFix: string
  /** The commit the agent produced for it, and what it said it did. */
  intent: string
  /** That commit's patch, already capped. */
  diff: string
  /** True when the patch was cut at the bridge's byte cap. */
  truncated: boolean
}

export interface FixVerifyPrompts {
  system: string
  user: string
}

/**
 * Build the re-read prompt for ONE persona's batch of findings.
 *
 * The persona content is included verbatim so the reviewer judges by its OWN
 * criterion — a re-read that drops the persona is a different reviewer
 * answering a question it was never asked.
 */
export function buildFixVerifyPrompt(
  persona: { name: string; content: string },
  subjects: readonly FixVerifySubject[],
): FixVerifyPrompts {
  const system = [
    `You are the code reviewer described below. You previously raised findings on a pull request.`,
    `A coding agent has since tried to fix them, and you are re-reading its actual diff.`,
    '',
    '--- YOUR REVIEWER PERSONA ---',
    persona.content,
    '--- END PERSONA ---',
    '',
    'YOU HAVE TWO JOBS, and they are independent.',
    '',
    'JOB 1 — For each finding you raised, judge ONLY whether YOUR complaint still stands',
    'against the diff shown. Answer with one of:',
    '  "still-standing"    — the diff does not address your complaint, or addresses it wrongly.',
    '  "not-raised-again"  — reading this diff you would not raise this finding.',
    '  "unsure"            — the diff does not show you enough to tell.',
    'Use "unsure" freely. It is an honest answer and it is treated as keeping the finding open.',
    'Do NOT claim the underlying defect is proven gone — you are reporting whether YOU still',
    'raise the complaint, nothing more.',
    '',
    'JOB 2 — Report problems THE FIX ITSELF INTRODUCED. Read the diff as new code written by',
    'someone else. A fix that silences your complaint by breaking something else is the single',
    'most valuable thing you can catch here, and nothing else in this system looks for it.',
    'Only report problems caused by THIS diff. Do NOT repeat your original findings, and do not',
    'list stylistic preferences. An empty list is a fine and common answer.',
    '',
    'Respond with JSON only, matching exactly:',
    '{"reReads":[{"id":"<finding id>","verdict":"still-standing|not-raised-again|unsure","reason":"<one sentence>"}],',
    ' "newProblems":[{"path":"<file>","line":<number|null>,"severity":"high|medium|low","body":"<what is wrong>","suggestedFix":"<concrete fix>"}]}',
  ].join('\n')

  const parts: string[] = []
  for (const s of subjects) {
    parts.push(
      [
        `### FINDING ${s.id}`,
        `Location: ${s.path}${s.line === null ? '' : `:${s.line}`}`,
        `What you said: ${s.body}`,
        s.suggestedFix ? `The fix you asked for: ${s.suggestedFix}` : '',
        `What the agent says it did: ${s.intent}`,
        s.truncated
          ? 'The diff below is TRUNCATED — it was too large to send whole. If the part you need is missing, answer "unsure".'
          : '',
        'The agent\'s diff:',
        '```diff',
        s.diff.slice(0, FIX_VERIFY_MAX_DIFF_CHARS),
        '```',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    )
  }

  return { system, user: parts.join('\n\n') }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** What the panel reports for one finding that was sent. */
export type FixFindingOutcome =
  /** The models positively agree the complaint went quiet. */
  | 'not-raised-again'
  /** At least half the weight says the complaint still stands. */
  | 'still-standing'
  /** Nobody said it stands, nobody said it went quiet. Stays open. */
  | 'could-not-tell'
  /** No usable re-read at all (pass off, every call failed, or nothing to read). */
  | 'not-re-read'

/** One model's recorded vote, kept for "who looked and what they said". */
export interface FixReReadVote {
  /** Provider display name, e.g. "OpenAI". */
  provider: string
  model: string
  verdict: FixReReadVerdict
  reason: string
}

/** The aggregated re-read of one finding. */
export interface FixFindingVerification {
  findingId: string
  /** The persona that raised it, and re-read it. */
  persona: string
  outcome: FixFindingOutcome
  votes: FixReReadVote[]
  /** Models that returned a usable verdict for this finding. */
  polledModels: number
  /** Of those, how many back the reported outcome. */
  agreeing: number
}

/** Weight of one verdict on the STILL-STANDING side. Mirrors `voteWeight`. */
function standingWeight(v: FixReReadVerdict): number {
  if (v === 'still-standing') return 1
  if (v === 'unsure') return 0.5
  return 0
}

/**
 * Decide one finding's outcome from its votes.
 *
 * THE THRESHOLD IS crossVerify's, POINTED THE HONEST WAY. There, `score >=
 * polled / 2` surfaces a finding and ties go to surface so one dissent cannot
 * bury a real defect. Here the same arithmetic decides whether the complaint
 * STAYS OPEN, and ties go to open for the same reason: one model saying "looks
 * fine now" must not close a finding the others are unsure about.
 *
 * With a single model that reduces to exactly what it should: `unsure` (0.5 >=
 * 0.5) keeps the finding open, and only a positive `not-raised-again` closes it.
 */
export function aggregateFixFinding(
  findingId: string,
  persona: string,
  votes: readonly FixReReadVote[],
): FixFindingVerification {
  const polledModels = votes.length
  if (polledModels === 0) {
    return { findingId, persona, outcome: 'not-re-read', votes: [], polledModels: 0, agreeing: 0 }
  }
  let score = 0
  for (const v of votes) score += standingWeight(v.verdict)

  if (score >= polledModels / 2) {
    const standing = votes.filter((v) => v.verdict === 'still-standing').length
    // Open, but on nobody's positive say-so — every model shrugged. That is a
    // different thing to tell the user than "a reviewer still raises this".
    const outcome: FixFindingOutcome = standing === 0 ? 'could-not-tell' : 'still-standing'
    return {
      findingId,
      persona,
      outcome,
      votes: [...votes],
      polledModels,
      agreeing: outcome === 'still-standing' ? standing : votes.filter((v) => v.verdict === 'unsure').length,
    }
  }
  return {
    findingId,
    persona,
    outcome: 'not-raised-again',
    votes: [...votes],
    polledModels,
    agreeing: votes.filter((v) => v.verdict === 'not-raised-again').length,
  }
}

/** A new problem after merging the models that raised it. */
export interface FixNewProblemReport extends FixNewProblem {
  /** Stable key for rendering. */
  key: string
  /** Personas + models that raised it, deduped. */
  raisedBy: string[]
  /** How many model calls were in a position to raise it. */
  polledModels: number
}

function anchorOf(p: FixNewProblem): AnchoredFinding {
  return { file: p.path, line: p.line, description: p.body }
}

const SEVERITY_RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 }

/**
 * Merge the new problems every model reported into one deduped list.
 *
 * Uses `findingsMatch` — the SAME primitive `mergeGeneratorFindings` uses to
 * fuse multi-generator findings — so "two models described the same new
 * problem" means here exactly what it means everywhere else in the ensemble.
 */
export function mergeNewProblems(
  raised: readonly { raisedBy: string; problem: FixNewProblem }[],
  polledModels: number,
): FixNewProblemReport[] {
  const groups: { rep: FixNewProblem; by: string[] }[] = []
  for (const { raisedBy, problem } of raised) {
    const hit = groups.find((g) => findingsMatch(anchorOf(g.rep), anchorOf(problem)))
    if (hit) {
      if (SEVERITY_RANK[problem.severity] > SEVERITY_RANK[hit.rep.severity]) hit.rep = problem
      if (!hit.by.includes(raisedBy)) hit.by.push(raisedBy)
    } else {
      groups.push({ rep: problem, by: [raisedBy] })
    }
  }
  return groups
    .map((g, i) => ({
      ...g.rep,
      key: `${g.rep.path}:${g.rep.line ?? 'x'}:${i}`,
      raisedBy: g.by,
      polledModels,
    }))
    .sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      if (bySeverity !== 0) return bySeverity
      return b.raisedBy.length - a.raisedBy.length
    })
}

/** The whole pass's result, as the panel renders it. */
export interface FixVerificationReport {
  byFinding: FixFindingVerification[]
  newProblems: FixNewProblemReport[]
  /** Distinct "Persona · Model" labels that actually answered. */
  witnesses: string[]
  /** Model calls made. */
  calls: number
  /** Calls that failed or returned nothing usable. */
  failedCalls: number
  usage?: LlmUsage
}

/** The findings this run leaves OPEN — the ones worth another round. */
export function stillOpenFindingIds(report: FixVerificationReport): string[] {
  return report.byFinding
    .filter((f) => f.outcome === 'still-standing' || f.outcome === 'could-not-tell')
    .map((f) => f.findingId)
}

// ---------------------------------------------------------------------------
// Orchestration (pure over an injected call — the crossVerify pattern)
// ---------------------------------------------------------------------------

/** One (persona, model) call. Throws or returns null on failure; never blocks. */
export type FixVerifyFn = (
  cfg: ProviderConfig,
  persona: { name: string; content: string },
  subjects: readonly FixVerifySubject[],
) => Promise<{ result: FixVerifyResponse; usage?: LlmUsage }>

/** One persona's findings, with the commits the agent produced for them. */
export interface FixVerifyBatch {
  persona: { name: string; content: string }
  subjects: FixVerifySubject[]
}

/** A model in the poll, with the name to show for it. */
export interface FixVerifyParticipant {
  provider: string
  model: string
  cfg: ProviderConfig
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
 * Run the pass: every participant re-reads every persona's batch, once.
 *
 * A failing call is SKIPPED, never fatal — the same contract crossVerify gives
 * a failing verifier. When every call fails, each finding aggregates to
 * `not-re-read`, which the panel says plainly instead of implying the fix was
 * checked and passed.
 */
export async function runFixVerification(
  batches: readonly FixVerifyBatch[],
  participants: readonly FixVerifyParticipant[],
  verify: FixVerifyFn,
): Promise<FixVerificationReport> {
  const empty: FixVerificationReport = {
    byFinding: [],
    newProblems: [],
    witnesses: [],
    calls: 0,
    failedCalls: 0,
  }
  if (batches.length === 0 || participants.length === 0) {
    // Still report every subject, as unexamined — silence would read as "clean".
    return {
      ...empty,
      byFinding: batches.flatMap((b) =>
        b.subjects.map((s) => aggregateFixFinding(s.id, b.persona.name, [])),
      ),
    }
  }

  type Job = { batch: FixVerifyBatch; participant: FixVerifyParticipant }
  const jobs: Job[] = []
  for (const batch of batches) {
    for (const participant of participants) jobs.push({ batch, participant })
  }
  // The cap is a cost floor, not a correctness one: dropped jobs simply mean
  // fewer witnesses, and every finding still reports how many models looked.
  const planned = jobs.slice(0, FIX_VERIFY_MAX_CALLS)

  const settled = await Promise.all(
    planned.map(async (job) => {
      try {
        const out = await verify(job.participant.cfg, job.batch.persona, job.batch.subjects)
        return { job, out, ok: true as const }
      } catch {
        return { job, out: null, ok: false as const }
      }
    }),
  )

  const votesByFinding = new Map<string, FixReReadVote[]>()
  const personaByFinding = new Map<string, string>()
  const rawNewProblems: { raisedBy: string; problem: FixNewProblem }[] = []
  const witnesses: string[] = []
  let usage: LlmUsage | undefined
  let failedCalls = 0

  for (const batch of batches) {
    for (const s of batch.subjects) personaByFinding.set(s.id, batch.persona.name)
  }

  for (const s of settled) {
    if (!s.ok || s.out === null) {
      failedCalls++
      continue
    }
    const { provider, model } = s.job.participant
    const label = `${s.job.batch.persona.name} · ${provider}`
    if (!witnesses.includes(label)) witnesses.push(label)
    usage = sumUsage(usage, s.out.usage)

    const known = new Set(s.job.batch.subjects.map((x) => x.id))
    for (const r of s.out.result.reReads) {
      // A verdict for an id we never sent is discarded: a model inventing a
      // finding id must not be able to close one.
      if (!known.has(r.id)) continue
      const list = votesByFinding.get(r.id) ?? []
      list.push({ provider, model, verdict: r.verdict, reason: r.reason })
      votesByFinding.set(r.id, list)
    }
    for (const problem of s.out.result.newProblems) {
      rawNewProblems.push({ raisedBy: label, problem })
    }
  }

  const byFinding: FixFindingVerification[] = []
  for (const batch of batches) {
    for (const s of batch.subjects) {
      byFinding.push(
        aggregateFixFinding(s.id, personaByFinding.get(s.id) ?? batch.persona.name, votesByFinding.get(s.id) ?? []),
      )
    }
  }

  return {
    byFinding,
    newProblems: mergeNewProblems(rawNewProblems, planned.length - failedCalls),
    witnesses,
    calls: planned.length,
    failedCalls,
    ...(usage ? { usage } : {}),
  }
}

// ---------------------------------------------------------------------------
// Words — the part that must not lie
// ---------------------------------------------------------------------------

/**
 * The short chip beside a finding.
 *
 * Every one of these is a report about a REVIEWER, never a claim about the
 * code. There is no "fixed" and there is no green check, by design.
 */
export function fixOutcomeLabel(outcome: FixFindingOutcome): string {
  switch (outcome) {
    case 'not-raised-again':
      return 'not raised again'
    case 'still-standing':
      return 'still raised'
    case 'could-not-tell':
      return 'could not tell'
    case 'not-re-read':
      return 'not re-read'
  }
}

/** Plural-safe "N of M models". */
function ofModels(n: number, m: number): string {
  return `${n} of ${m} ${m === 1 ? 'model' : 'models'}`
}

/**
 * One sentence per finding: WHO looked and WHAT THEY SAID. No conclusion.
 *
 * `not-raised-again` in particular is worded as an observation about the
 * reviewer ("did not raise it again") and never as a fact about the code ("is
 * fixed"), because the second is a claim this pass cannot support. The caveat
 * that makes that difference legible is stated once, by
 * `FIX_VERIFY_EVIDENCE_CAVEAT`, rather than repeated on every row.
 */
export function describeFixFinding(v: FixFindingVerification): string {
  const who = v.persona || 'The reviewer that raised this'
  switch (v.outcome) {
    case 'not-raised-again':
      return `${who} re-read this against the agent's diff and did not raise it again (${ofModels(v.agreeing, v.polledModels)}).`
    case 'still-standing':
      return `${who} re-read this against the agent's diff and still raises it (${ofModels(v.agreeing, v.polledModels)}).`
    case 'could-not-tell':
      return `${who} re-read this against the agent's diff and could not tell from it whether the complaint is answered (${ofModels(v.agreeing, v.polledModels)}). It stays open.`
    case 'not-re-read':
      return `${who} did not re-read this — no model answered for it. Nothing was checked.`
  }
}

/**
 * THE CAVEAT, stated once above the results.
 *
 * It names the measurement rather than hand-waving at "AI can be wrong",
 * because the number is what makes the weakness concrete and this repo has it.
 * The last sentence is the one that matters most in practice: this pass runs
 * BEFORE a human reads the code, and must never read as though it replaced
 * that.
 */
export const FIX_VERIFY_EVIDENCE_CAVEAT =
  'A reviewer re-reading its own complaint is weak evidence. This repo’s own eval scored the same defect 1/3, 3/3, 2/3 and 1/3 across runs on identical code — so “not raised again” means the complaint went quiet, not that the defect is gone. Nothing here has been read by a person yet.'

/** The heading over the new-problem list — observational, like the rest. */
export const FIX_VERIFY_NEW_PROBLEM_HEADING = 'Raised against the fix itself'

/** One sentence introducing the new-problem list. */
export function describeNewProblems(count: number, polledModels: number): string {
  if (count === 0) {
    return polledModels === 0
      ? 'No model looked for problems the fix might have introduced.'
      : `No new problems were reported by the ${polledModels === 1 ? 'model' : `${polledModels} models`} that read the diff. They were asked for them.`
  }
  return `${count === 1 ? 'One problem was' : `${count} problems were`} raised about the agent's own change — not about the original findings.`
}

/**
 * THE LOOP'S VERDICT IS NOT NEGOTIABLE.
 *
 * `round-cap` means the commit came back with the tests RED, and
 * `describeFixStop` already says so bluntly. `no-progress` and `repeat-diff`
 * mean the agent was stuck or oscillating. A re-read that happens to come back
 * quiet must not be allowed to read as though it overturned any of them, so the
 * panel renders this sentence UNDER the verification whenever one applies.
 *
 * Returns null for the stop reasons a verification does not have to argue with.
 */
export function describeVerificationUnder(reason: BridgeFixStopReason): string | null {
  switch (reason) {
    case 'round-cap':
      return 'The tests are still failing on this commit. A reviewer not raising its complaint again does not make them pass.'
    case 'no-progress':
      return 'The agent stopped because a round changed nothing. Whatever the re-read says, this commit is where it gave up.'
    case 'repeat-diff':
      return 'The agent was oscillating between states it had already produced. Whatever the re-read says, this commit is one of them.'
    case 'all-addressed':
    case 'budget-exhausted':
      return null
  }
}

/** Stop reasons whose meaning a verification pass must never soften. */
export function stopReasonOutranksVerification(reason: BridgeFixStopReason): boolean {
  return describeVerificationUnder(reason) !== null
}
