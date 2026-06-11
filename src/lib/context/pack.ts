/**
 * lib/context/pack.ts — Prompt context packing with token budget (REQ-16)
 *
 * Token estimator: Math.ceil(chars / 3.5)
 * This is a documented heuristic; multibyte characters may use more tokens
 * than estimated (EC-16j is a nice-to-have for exact multibyte handling).
 *
 * CiInput is defined here independently of lib/github/checks.ts (Task 4).
 * The orchestrator (Task 8) is responsible for adapting from CiSummary → CiInput.
 * Definition: `interface CiInput { failures: { name: string; annotations: string[] }[] }`
 */

import type { PrFile, PrMeta } from '../github/types'
import { getFileAtRef } from '../github/api'

// ---------------------------------------------------------------------------
// CiInput — structural type accepted by pack (adapts to full CiSummary in Task 8)
// ---------------------------------------------------------------------------

export interface CiInput {
  failures: { name: string; annotations: string[] }[]
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface PackedContext {
  /** The assembled prompt context text. Empty string when no content. */
  text: string
  /** Files (and CI items) that were trimmed or skipped due to budget/exclusion. */
  notAnalyzed: string[]
  /** Files whose content was included in full. */
  includedFiles: string[]
}

export interface PackContextInput {
  files: PrFile[]
  contents: Map<string, { before: string | null; after: string | null }>
  ci: CiInput | null
  budgetTokens: number
}

// ---------------------------------------------------------------------------
// Token estimator (documented heuristic — EC-16j multibyte exact is nice-to-have)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

// ---------------------------------------------------------------------------
// Exclusion rules (EC-16e)
// ---------------------------------------------------------------------------

const LOCK_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'])

// Matches dist/ or generated/ as a path segment anywhere (including root-level)
const GENERATED_PATH_RE = /(^|\/)dist\/|(^|\/)generated\//

const GENERATED_FILENAME_RE = /\.min\.[^.]+$|\.map$/

function isExcluded(filename: string): boolean {
  const base = filename.split('/').at(-1) ?? filename
  if (LOCK_FILES.has(base)) return true
  if (GENERATED_PATH_RE.test(filename)) return true
  if (GENERATED_FILENAME_RE.test(base)) return true
  return false
}

// ---------------------------------------------------------------------------
// packContext — pure function
// ---------------------------------------------------------------------------

/**
 * Pack PR files and CI failures into a prompt context string within `budgetTokens`.
 *
 * Ordering:
 *   1. Per-file patch sections (cheap — patch only)
 *   2. Before/after full-file contents for files where BOTH fit remaining budget
 *   3. CI failures + annotations (EC-16i)
 *
 * Exclusion (EC-16e): lock files, minified/map files, dist/generated paths.
 * Binary files (no patch, no contents): excluded (EC-16g binary subset).
 * Deleted files: before content only (EC-16g).
 * Added files: after content only (EC-16g).
 *
 * Anything skipped or trimmed is recorded in `notAnalyzed` (EC-16c/k).
 */
export function packContext(input: PackContextInput): PackedContext {
  const { files, contents, ci, budgetTokens } = input

  // EC-16a: zero files is valid
  if (files.length === 0 && !ci) {
    return { text: '', notAnalyzed: [], includedFiles: [] }
  }

  let remainingTokens = budgetTokens
  const parts: string[] = []
  const notAnalyzed: string[] = []
  const includedFiles: string[] = []

  // ---- Phase 1: patches ----
  const eligibleFiles: PrFile[] = []

  for (const file of files) {
    if (isExcluded(file.filename)) {
      notAnalyzed.push(file.filename)
      continue
    }
    // Binary: no patch and no contents → skip (EC-16g)
    if (file.patch === undefined) {
      const fileContents = contents.get(file.filename)
      const hasBefore = fileContents?.before != null
      const hasAfter = fileContents?.after != null
      if (!hasBefore && !hasAfter) {
        notAnalyzed.push(file.filename)
        continue
      }
    }
    eligibleFiles.push(file)
  }

  const patchSections: Array<{ file: PrFile; section: string }> = []
  for (const file of eligibleFiles) {
    if (!file.patch) continue
    const section = `## ${file.filename} (patch)\n\`\`\`diff\n${file.patch}\n\`\`\``
    const tokens = estimateTokens(section)
    if (tokens <= remainingTokens) {
      patchSections.push({ file, section })
      remainingTokens -= tokens
    } else {
      notAnalyzed.push(file.filename)
    }
  }

  for (const { section } of patchSections) {
    parts.push(section)
  }

  // Track which files had their patch included (used to know they're partially included)
  const patchIncludedNames = new Set(patchSections.map(p => p.file.filename))

  // ---- Phase 2: before/after full content ----
  for (const file of eligibleFiles) {
    const fileContents = contents.get(file.filename)
    if (!fileContents) continue

    const isAdded = file.status === 'added'
    const isRemoved = file.status === 'removed'

    // Determine what content to include based on file status (EC-16g)
    const beforeContent = isAdded ? null : fileContents.before
    const afterContent = isRemoved ? null : fileContents.after

    // Build the combined content section
    const contentParts: string[] = []
    if (beforeContent != null) {
      contentParts.push(`### Before\n\`\`\`\n${beforeContent}\n\`\`\``)
    }
    if (afterContent != null) {
      contentParts.push(`### After\n\`\`\`\n${afterContent}\n\`\`\``)
    }
    if (contentParts.length === 0) continue

    const section = `## ${file.filename} (content)\n${contentParts.join('\n')}`
    const tokens = estimateTokens(section)

    if (tokens <= remainingTokens) {
      parts.push(section)
      remainingTokens -= tokens
      if (!includedFiles.includes(file.filename)) {
        includedFiles.push(file.filename)
      }
    } else {
      // Content didn't fit — file is partially/not analyzed unless patch was included
      if (!patchIncludedNames.has(file.filename) && !notAnalyzed.includes(file.filename)) {
        notAnalyzed.push(file.filename)
      }
    }
  }

  // ---- Phase 3: CI failures (EC-16i) ----
  if (ci && ci.failures.length > 0) {
    const ciLines: string[] = ['## CI Failures']
    for (const failure of ci.failures) {
      ciLines.push(`### ${failure.name}`)
      for (const annotation of failure.annotations) {
        ciLines.push(`- ${annotation}`)
      }
    }
    const ciSection = ciLines.join('\n')
    const tokens = estimateTokens(ciSection)
    if (tokens <= remainingTokens) {
      parts.push(ciSection)
      remainingTokens -= tokens
    }
    // CI failures omitted from notAnalyzed — they're infrastructure, not files
  }

  const text = parts.join('\n\n')
  return { text, notAnalyzed, includedFiles }
}

// ---------------------------------------------------------------------------
// fetchContents — async helper with concurrency cap 4 (CH-01)
// ---------------------------------------------------------------------------

/**
 * For the top `limit` files by patch size (descending), fetch before and after
 * content from GitHub with a concurrency cap of 4 concurrent requests.
 *
 * - Added files: skip before fetch
 * - Removed files: skip after fetch
 * - Excluded and binary files: still fetched if the caller wants them (exclusion
 *   is enforced in packContext)
 *
 * @param repo     owner/repo pair
 * @param files    full PR file list
 * @param meta     PrMeta supplying baseSha / headSha
 * @param limit    max files to fetch (default 30)
 */
export async function fetchContents(
  repo: { owner: string; repo: string },
  files: PrFile[],
  meta: Pick<PrMeta, 'baseSha' | 'headSha'>,
  limit = 30,
): Promise<Map<string, { before: string | null; after: string | null }>> {
  // Sort by patch size descending (additions + deletions as proxy)
  const sorted = [...files].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  )

  const chosen = sorted.slice(0, limit)
  const result = new Map<string, { before: string | null; after: string | null }>()

  // Build fetch tasks as [filename, 'before'|'after', ref] triples
  const tasks: Array<{ filename: string; side: 'before' | 'after'; ref: string; path: string }> = []

  for (const file of chosen) {
    const path = file.status === 'renamed' && file.previousFilename
      ? file.previousFilename
      : file.filename

    if (file.status !== 'added') {
      tasks.push({ filename: file.filename, side: 'before', ref: meta.baseSha, path })
    }
    if (file.status !== 'removed') {
      tasks.push({ filename: file.filename, side: 'after', ref: meta.headSha, path: file.filename })
    }
  }

  // Initialize result entries
  for (const file of chosen) {
    result.set(file.filename, { before: null, after: null })
  }

  // Run with concurrency cap of 4
  await runWithConcurrency(4, tasks, async (task) => {
    const content = await getFileAtRef(repo, task.path, task.ref)
    const entry = result.get(task.filename)!
    if (task.side === 'before') {
      entry.before = content
    } else {
      entry.after = content
    }
  })

  return result
}

// ---------------------------------------------------------------------------
// Concurrency runner (cap = max simultaneous in-flight promises)
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(
  cap: number,
  items: T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  let inFlight = 0
  let queueIndex = 0

  return new Promise<void>((resolve, reject) => {
    function next(): void {
      while (inFlight < cap && queueIndex < queue.length) {
        const item = queue[queueIndex++]
        inFlight++
        fn(item).then(() => {
          inFlight--
          next()
          if (inFlight === 0 && queueIndex >= queue.length) {
            resolve()
          }
        }, reject)
      }
      if (inFlight === 0 && queueIndex >= queue.length) {
        resolve()
      }
    }
    next()
  })
}
