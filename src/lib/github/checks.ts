import { ghFetchPage, ghFetch } from './client'
import type { PrRef } from './parse'

// ---------------------------------------------------------------------------
// CiSummary
// ---------------------------------------------------------------------------

export interface CiSummary {
  total: number
  passed: number
  failed: number
  pending: number
  failures: { name: string; annotations: string[]; url?: string | null }[]
}

// ---------------------------------------------------------------------------
// Conclusion classification
//
// Passed: success | neutral | skipped
//   - success: the obvious pass
//   - neutral: informational / non-blocking — treated as pass so it doesn't
//     inflate the failure count and block the "all-pass" state
//   - skipped: explicitly opted out — not a failure, counts as pass
//
// Failed: failure | timed_out | cancelled | action_required
//
// Pending: status !== "completed" (queued, in_progress, waiting, …)
// ---------------------------------------------------------------------------

const PASS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])
const FAIL_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required'])

interface CheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  // The check's web page on GitHub. `html_url` is the canonical UI link;
  // `details_url` is the integrator-provided fallback (e.g. an external CI). One
  // or both may be absent. Captured so a failed check can deep-link to GitHub
  // (where the user can view logs / re-run it).
  html_url?: string | null
  details_url?: string | null
}

interface CheckRunsPage {
  total_count: number
  check_runs: CheckRun[]
}

interface Annotation {
  message: string | null
}

// ---------------------------------------------------------------------------
// getCiSummary
// ---------------------------------------------------------------------------

export async function getCiSummary(ref: PrRef, headSha: string): Promise<CiSummary> {
  const { owner, repo } = ref

  // Collect all check-runs across pages
  const allRuns: CheckRun[] = []
  let url: string | null =
    `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`

  while (url !== null) {
    const { body, next }: { body: CheckRunsPage; next: string | null } =
      await ghFetchPage<CheckRunsPage>(url)
    // body is an object with check_runs array (not a bare array)
    allRuns.push(...body.check_runs)
    url = next
  }

  if (allRuns.length === 0) {
    return { total: 0, passed: 0, failed: 0, pending: 0, failures: [] }
  }

  let passed = 0
  let failed = 0
  let pending = 0
  const failedRuns: CheckRun[] = []

  for (const run of allRuns) {
    if (run.status !== 'completed') {
      pending++
    } else if (run.conclusion !== null && PASS_CONCLUSIONS.has(run.conclusion)) {
      passed++
    } else if (run.conclusion !== null && FAIL_CONCLUSIONS.has(run.conclusion)) {
      failed++
      failedRuns.push(run)
    } else {
      // Unknown conclusion — treat as failed (conservative)
      failed++
      failedRuns.push(run)
    }
  }

  // Fetch annotations for each failed run (one page, cap 50). Capture the
  // check's web URL too — prefer html_url (GitHub UI), fall back to details_url
  // (integrator-provided), null when neither is present.
  const failures: { name: string; annotations: string[]; url: string | null }[] = []
  for (const run of failedRuns) {
    const annotations = await fetchAnnotations(owner, repo, run.id)
    const url = run.html_url ?? run.details_url ?? null
    failures.push({ name: run.name, annotations, url })
  }

  return {
    total: allRuns.length,
    passed,
    failed,
    pending,
    failures,
  }
}

async function fetchAnnotations(
  owner: string,
  repo: string,
  runId: number,
): Promise<string[]> {
  try {
    const data = await ghFetch<Annotation[]>(
      `/repos/${owner}/${repo}/check-runs/${runId}/annotations?per_page=50`,
    )
    return data
      .slice(0, 50)
      .map((a) => a.message ?? '')
      .filter((m) => m.length > 0)
  } catch {
    // Annotation fetch failures are non-fatal — return empty list
    return []
  }
}
