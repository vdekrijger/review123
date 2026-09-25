/**
 * bridge/ciFailures.ts — getting the FAILURE OUTPUT, not just the red dot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * An agent handed "CI is red" and nothing else will invent a fix. It has to:
 * it is being asked about something it cannot see. So before any agent is
 * asked anything, this module gathers what CI actually printed.
 *
 * TWO SOURCES, DELIBERATELY, BECAUSE ONE OF THEM IS UNRELIABLE IN A BROWSER.
 *
 *   1. CHECK ANNOTATIONS, via the provider's own `getCiSummary`. Already proven
 *      in this app, works for GitHub, GitLab and Bitbucket, and for a test
 *      runner that emits them it is the most precise thing available: file,
 *      line, message.
 *
 *   2. GITHUB ACTIONS JOB LOGS, best effort. `/actions/jobs/{id}/logs` answers
 *      a redirect to a signed blob on another host, and that host does not
 *      reliably send CORS headers — so from a browser this call may simply be
 *      unavailable, with no way to tell in advance. It is attempted, and every
 *      failure is swallowed into `logUnavailable` rather than failing the flow.
 *
 * AND WHY THE FRAGILITY OF (2) DOES NOT MATTER MUCH. The log is CONTEXT. It is
 * not the signal the agent works against — that is the local test run the
 * bridge does before starting it (see bridge/src/ciFix.ts, round zero). A
 * missing log makes the agent's job harder; it does not make its work
 * unverifiable, because the verification is local and happens either way.
 *
 * NOTHING HERE IS EDITED IN src/lib/github: this module is a caller of the
 * existing helpers, never a change to them.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { ghFetch } from '../github/client'
import { GithubApiError } from '../github/types'
import { getSettings } from '../settings/settings'
import { requestSignals } from '../net/signals'
import { MAX_CI_FAILURES, MAX_CI_LOG_CHARS, type BridgeCiFailure } from './protocol'
import type { CiSummary } from '../github/checks'
import type { PrRefX } from '../provider/types'

/** How much of a job log to keep. The TAIL: a failure reports itself at the end. */
const LOG_TAIL_CHARS = 6_000

/** How many jobs to fetch logs for. Each is a separate round-trip. */
const MAX_LOG_FETCHES = 3

/** Per-log budget. A log that is slow to arrive is not worth blocking on. */
const LOG_TIMEOUT_MS = 15_000

/**
 * Where a push would go, read from the pull request itself.
 *
 * `PrMeta` does not carry the head branch name — nothing in this app has ever
 * needed it, because nothing has ever written to a remote. It is read here, in
 * this module, rather than by widening the shared PR model: the branch name is
 * only meaningful to the one feature that pushes.
 */
export interface PushTarget {
  /** The head branch name, e.g. `feat/thing`. */
  branch: string
  /** The head commit the pull request is at, as GitHub reports it right now. */
  headSha: string
  /** True when the head lives on a fork. A push target this app will not guess. */
  isFork: boolean
}

interface RawPullRequest {
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null }
  base?: { repo?: { full_name?: unknown } | null }
}

/**
 * Read the head branch and fork status for a pull request.
 *
 * Returns null on any failure. A push target this app could not establish is
 * one it must not guess at: the whole point of `expectedRemoteSha` is that the
 * plan is exact, and a guessed branch name would make it exact about the wrong
 * branch.
 */
export async function getPushTarget(
  ref: PrRefX,
  signal?: AbortSignal,
): Promise<PushTarget | null> {
  if (ref.provider !== 'github') return null
  let raw: RawPullRequest
  try {
    raw = await ghFetch<RawPullRequest>(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
      signal ? { signal } : {},
    )
  } catch {
    return null
  }
  const branch = raw.head?.ref
  const headSha = raw.head?.sha
  if (typeof branch !== 'string' || branch === '') return null
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) return null

  const headRepo = raw.head?.repo?.full_name
  const baseRepo = raw.base?.repo?.full_name
  // UNKNOWN IS NOT SAME-REPO. A head repo we could not read is one we cannot
  // prove is the repo the local `origin` points at, and this is the one feature
  // where "probably" is not good enough.
  const isFork =
    typeof headRepo !== 'string' || typeof baseRepo !== 'string' || headRepo !== baseRepo

  return { branch, headSha, isFork }
}

// ---------------------------------------------------------------------------
// The failures themselves
// ---------------------------------------------------------------------------

/** One failing job, plus whether its log could actually be read. */
export interface CiFailureEvidence extends BridgeCiFailure {
  /** True when the Actions log could not be fetched. Reported, never hidden. */
  logUnavailable: boolean
  /** Where a person can read the whole thing themselves. */
  url: string | null
}

interface RawJob {
  id?: unknown
  name?: unknown
  conclusion?: unknown
  html_url?: unknown
}

interface RawRun {
  id?: unknown
  conclusion?: unknown
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required'])

/**
 * The Actions jobs that failed for this commit, newest run first.
 *
 * GitHub's check-run ids and Actions job ids are not the same namespace, so the
 * run listing is walked rather than assuming one can be used as the other. Any
 * failure returns an empty list: this is enrichment, and enrichment that throws
 * would take the whole flow down with it.
 */
export async function listFailingActionsJobs(
  ref: PrRefX,
  headSha: string,
  signal?: AbortSignal,
): Promise<{ id: number; name: string; url: string | null }[]> {
  if (ref.provider !== 'github') return []
  const base = `/repos/${ref.owner}/${ref.repo}`
  let runs: { workflow_runs?: RawRun[] }
  try {
    runs = await ghFetch<{ workflow_runs?: RawRun[] }>(
      `${base}/actions/runs?head_sha=${headSha}&per_page=20`,
      signal ? { signal } : {},
    )
  } catch {
    return []
  }

  const failingRuns = (runs.workflow_runs ?? []).filter(
    (r) => typeof r.conclusion === 'string' && FAILED_CONCLUSIONS.has(r.conclusion),
  )

  const jobs: { id: number; name: string; url: string | null }[] = []
  for (const run of failingRuns) {
    if (typeof run.id !== 'number') continue
    if (jobs.length >= MAX_CI_FAILURES) break
    let page: { jobs?: RawJob[] }
    try {
      page = await ghFetch<{ jobs?: RawJob[] }>(
        `${base}/actions/runs/${run.id}/jobs?per_page=50&filter=latest`,
        signal ? { signal } : {},
      )
    } catch {
      continue
    }
    for (const job of page.jobs ?? []) {
      if (typeof job.id !== 'number' || typeof job.name !== 'string') continue
      if (typeof job.conclusion !== 'string' || !FAILED_CONCLUSIONS.has(job.conclusion)) continue
      jobs.push({
        id: job.id,
        name: job.name,
        url: typeof job.html_url === 'string' ? job.html_url : null,
      })
      if (jobs.length >= MAX_CI_FAILURES) break
    }
  }
  return jobs
}

/**
 * One job's log, as plain text — or null.
 *
 * `/actions/jobs/{id}/logs` answers a 302 to a signed blob URL on a host that
 * does not reliably allow cross-origin reads. `fetch` follows the redirect and
 * drops the Authorization header on the way (which is correct — the signed URL
 * carries its own credentials), but the browser may still refuse the response
 * for CORS reasons this code cannot detect in advance.
 *
 * So every failure mode is one answer: null. The caller reports that honestly
 * as `logUnavailable` rather than pretending the job printed nothing.
 */
export async function fetchJobLog(
  ref: PrRefX,
  jobId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (ref.provider !== 'github') return null
  const auth = getSettings().githubAuth
  if (auth === null) return null

  const { effectiveSignal } = requestSignals(signal ?? null, LOG_TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        credentials: 'omit',
        cache: 'no-store',
        signal: effectiveSignal,
      },
    )
    if (!res.ok) return null
    const text = await res.text()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * The tail of a log, with the timestamps GitHub prefixes to every line removed.
 *
 * The timestamps are half the bytes and none of the information, and every one
 * of those bytes is budget that could have been another line of the actual
 * failure.
 */
export function tailLog(raw: string, maxChars: number = LOG_TAIL_CHARS): string {
  const stripped = raw
    .split('\n')
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
    .join('\n')
    .trimEnd()
  if (stripped.length <= maxChars) return stripped
  return `…\n${stripped.slice(-maxChars)}`
}

/**
 * Build the evidence for one CI failure out of whatever could be read.
 *
 * Annotations come first because they are the precise part; the log tail
 * follows as context. When neither exists, the text says so rather than being
 * empty — an agent reading "(no output could be read)" knows it is working
 * blind, which is exactly what it should know.
 */
export function composeEvidence(
  annotations: readonly string[],
  log: string | null,
): { text: string; logUnavailable: boolean } {
  const parts: string[] = []
  if (annotations.length > 0) {
    parts.push(['annotations:', ...annotations.slice(0, 30).map((a) => `  ${a}`)].join('\n'))
  }
  if (log !== null && log.trim() !== '') {
    parts.push(['job log (tail):', log].join('\n'))
  }
  const text = parts.length > 0 ? parts.join('\n\n') : '(no output could be read for this job)'
  return {
    text: text.slice(0, MAX_CI_LOG_CHARS),
    logUnavailable: log === null || log.trim() === '',
  }
}

/**
 * Everything the agent gets about why CI is red.
 *
 * `ci` is the provider's own summary, already fetched by whoever is rendering
 * the pull request — passed in rather than re-fetched so this does not become
 * a second, disagreeing source of "is CI red".
 */
export async function gatherCiFailures(
  ref: PrRefX,
  headSha: string,
  ci: CiSummary,
  signal?: AbortSignal,
): Promise<CiFailureEvidence[]> {
  const jobs = await listFailingActionsJobs(ref, headSha, signal)
  const byName = new Map(jobs.map((j) => [j.name, j]))

  const out: CiFailureEvidence[] = []
  for (const failure of ci.failures.slice(0, MAX_CI_FAILURES)) {
    const job = byName.get(failure.name) ?? null
    const log =
      job !== null && out.length < MAX_LOG_FETCHES ? await fetchJobLog(ref, job.id, signal) : null
    const { text, logUnavailable } = composeEvidence(failure.annotations, log === null ? null : tailLog(log))
    out.push({
      id: job === null ? `check:${failure.name}` : `job:${job.id}`,
      name: failure.name,
      log: text,
      logUnavailable,
      url: job?.url ?? failure.url ?? null,
    })
  }
  return out
}

/**
 * What to tell the user when no log could be read for any failing job.
 *
 * Said rather than hidden, because it changes what the run means: the agent is
 * working from a local reproduction alone, without CI's own account of what
 * went wrong. That is still a real signal — it is the signal the bridge
 * verifies against — but the user should know which of the two they got.
 */
export const CI_LOGS_UNAVAILABLE =
  'GitHub would not hand this browser the job logs, so the agent only gets the check annotations and whatever your own test command prints. Everything it does is still verified against a real local failure.'

/** True when a GitHub error means "you cannot read Actions here", not "it broke". */
export function isActionsForbidden(err: unknown): boolean {
  return err instanceof GithubApiError && (err.detail.kind === 'forbidden' || err.detail.kind === 'unauthorized')
}
