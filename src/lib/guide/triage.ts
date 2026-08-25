/**
 * src/lib/guide/triage.ts — deterministic mechanical-vs-novel file triage for
 * the risk-guided Inspect flow.
 *
 * Pure and framework-free — NO LLM calls, no new AI task. Classifies each PR
 * file from signals the app already computes deterministically:
 *
 *   MECHANICAL (low review attention — grouped into the collapsed tail):
 *     - generated files      (src/lib/diff/generated.ts — single source of truth)
 *     - lockfiles            (a generated subset; labeled "lockfile" for clarity)
 *     - snapshot artifacts   (a generated subset; labeled "snapshot")
 *     - tests-only files     (src/lib/testFile.ts isTestFile)
 *     - rename-without-changes (status renamed, zero added/removed lines)
 *     - manifest version-bump-only changes (the 8-manifest family heuristics.ts
 *       watches for new dependencies: package.json, requirements.txt,
 *       pyproject.toml, go.mod, Cargo.toml, Gemfile, pom.xml, build.gradle[.kts])
 *
 *   OVERRIDE — findings/risk ALWAYS win: a file carrying ANY reviewer finding,
 *   or whose deterministic file-risk is HIGH, is NEVER mechanical. A flagged
 *   file must never be buried in the low-attention tail, no matter how
 *   mechanical its shape looks.
 *
 * `reasons` carries every mechanical signal that matched (chip labels like
 * "generated", "tests only", "lockfile"). Reasons are reported even when the
 * findings/risk override forces `attention: 'novel'` — they are truthful data
 * about the file's shape; `attention` alone decides tail membership.
 *
 * Framing contract (mirrors src/lib/risk): this estimates review ATTENTION —
 * where a human should spend their initial read — never "this file is safe".
 */

import type { PrFile } from '../github/types'
import type { RiskLevel } from '../risk/risk'
import type { RiskFinding } from '../risk/risk'
import { isGeneratedFile } from '../diff/generated'
import { isTestFile } from '../testFile'
import { addedLines, removedLines } from '../risk/heuristics'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileAttention = 'novel' | 'mechanical'

export interface FileTriage {
  attention: FileAttention
  /** Every mechanical signal that matched, as short chip labels. */
  reasons: string[]
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/**
 * Lockfile basenames — mirrors LOCK_FILES in src/lib/diff/generated.ts (not
 * exported there). Duplicated ONLY to label the chip "lockfile" instead of the
 * generic "generated"; the mechanical DECISION still comes from
 * isGeneratedFile, so a drift here can only soften a label, never mis-triage.
 */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
])

/**
 * Manifest basenames (lowercased) — the same family heuristics.ts watches for
 * new dependencies. A change to one of these counts mechanical ONLY when it is
 * a pure version bump (see isVersionBumpOnly).
 */
const MANIFEST_NAMES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'cargo.toml',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
])

function basenameOf(path: string): string {
  const segments = path.split('/')
  return segments[segments.length - 1] ?? ''
}

function isLockfile(path: string): boolean {
  return LOCKFILE_NAMES.has(basenameOf(path))
}

function isSnapshotArtifact(path: string): boolean {
  const segments = path.split('/')
  return /\.snap$/.test(basenameOf(path)) || segments.some((s) => s === '__snapshots__')
}

/** A rename that changed NO content: status renamed, zero churn. */
function isRenameWithoutChanges(file: PrFile): boolean {
  return file.status === 'renamed' && file.additions === 0 && file.deletions === 0
}

/**
 * Version-like tokens ("1.2.3", "5", "2.0.0-beta.1") masked to '#' so a bumped
 * line normalizes to the same shape as the line it replaced.
 */
const VERSION_TOKEN_RE = /\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.]+)?/g

function normalizeVersionLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ').replace(VERSION_TOKEN_RE, '#')
}

/**
 * True when EVERY added line of the patch pairs with a removed line that is
 * identical after masking version tokens — i.e. the change only bumped
 * versions. Conservative by construction:
 *   - a genuinely NEW line (new dependency, new script, new config) has no
 *     removed counterpart → false;
 *   - no added lines at all (pure removal / no patch) → false (removals are a
 *     real change worth a look, and an absent patch can't be verified);
 *   - leftover removed lines are fine (a bump may also drop a line).
 * Multiset matching, so two identical bumped lines need two removed twins.
 */
export function isVersionBumpOnly(patch: string | undefined): boolean {
  const added = addedLines(patch)
    .map(normalizeVersionLine)
    .filter((l) => l !== '')
  if (added.length === 0) return false
  const pool = new Map<string, number>()
  for (const r of removedLines(patch)) {
    const n = normalizeVersionLine(r)
    if (n === '') continue
    pool.set(n, (pool.get(n) ?? 0) + 1)
  }
  for (const a of added) {
    const available = pool.get(a) ?? 0
    if (available === 0) return false
    pool.set(a, available - 1)
  }
  return true
}

// ---------------------------------------------------------------------------
// classifyFile
// ---------------------------------------------------------------------------

/**
 * Classify one PR file as 'novel' (deserves initial-read attention) or
 * 'mechanical' (skimmable — grouped into the low-attention tail).
 *
 * @param file      the PR file (status, churn, patch)
 * @param fileRisk  the file's deterministic review-effort level
 *                  (src/lib/risk computeFileRisk — computed by the caller,
 *                  NEVER reimplemented here)
 * @param findings  reviewer findings ON THIS FILE (any finding → novel)
 * @param contents  optional loaded contents, so generated-content markers
 *                  (`@generated` / DO NOT EDIT banners) are honored like the
 *                  Files-list sink does
 */
export function classifyFile(
  file: PrFile,
  fileRisk: RiskLevel,
  findings: readonly RiskFinding[],
  contents?: { before: string | null; after: string | null } | null,
): FileTriage {
  const reasons: string[] = []

  // Mechanical-shape signals (labels ordered most-specific first).
  if (isLockfile(file.filename)) {
    reasons.push('lockfile')
  } else if (isSnapshotArtifact(file.filename)) {
    reasons.push('snapshot')
  } else if (isGeneratedFile(file.filename, contents)) {
    reasons.push('generated')
  }
  if (isTestFile(file.filename)) reasons.push('tests only')
  if (isRenameWithoutChanges(file)) reasons.push('rename only')
  if (MANIFEST_NAMES.has(basenameOf(file.filename).toLowerCase()) && isVersionBumpOnly(file.patch)) {
    reasons.push('version bumps')
  }

  // Findings/risk override: NEVER bury a flagged or high-risk file in the
  // tail. Reasons stay reported (truthful shape data); attention wins.
  const flagged = findings.length > 0 || fileRisk === 'high'
  const attention: FileAttention = !flagged && reasons.length > 0 ? 'mechanical' : 'novel'
  return { attention, reasons }
}

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

/** Plain code-unit string compare — locale-independent, fully deterministic. */
export function pathCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const RISK_RANK: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 }

/**
 * "Risk first" ordering: highest review-attention need first. Sorts by the
 * per-file risk level (high → medium → low) with a deterministic path
 * tie-break inside each band. Returns a NEW array; never mutates.
 */
export function sortRiskFirst(files: readonly PrFile[], riskOf: (f: PrFile) => RiskLevel): PrFile[] {
  return [...files].sort(
    (a, b) => RISK_RANK[riskOf(a)] - RISK_RANK[riskOf(b)] || pathCompare(a.filename, b.filename),
  )
}
