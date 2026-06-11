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
  failures: { name: string; annotations: string[] }[]
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

  // Fetch annotations for each failed run (one page, cap 50)
  const failures: { name: string; annotations: string[] }[] = []
  for (const run of failedRuns) {
    const annotations = await fetchAnnotations(owner, repo, run.id)
    failures.push({ name: run.name, annotations })
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
