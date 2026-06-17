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
import { isGeneratedPath } from '../diff/generated'

// ---------------------------------------------------------------------------
// CiInput — structural type accepted by pack (adapts to full CiSummary in Task 8)
// ---------------------------------------------------------------------------

export interface CiInput {
  failures: { name: string; annotations: string[] }[]
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Compact per-file structural summary used by the Story task (and its
 * deterministic fallback). Carries ONLY paths + change stats + hunk HEADERS —
 * never the line-level diff body — so the story prompt fits even huge PRs and
 * the fallback can classify every changed file by path. Covers ALL changed,
 * non-binary files (independent of the prompt token budget that trims `text`).
 */
export interface StoryFileSummary {
  /** Changed file path (as reported by the provider). */
  path: string
  /** Lines added in this file. */
  additions: number
  /** Lines removed in this file. */
  deletions: number
  /** The `@@ … @@` hunk header context lines (naming enclosing symbols). */
  hunkHeaders: string[]
}

export interface PackedContext {
  /** The assembled prompt context text. Empty string when no content. */
  text: string
  /** Files (and CI items) that were trimmed or skipped due to budget/exclusion. */
  notAnalyzed: string[]
  /** Files whose content was included in full. */
  includedFiles: string[]
  /** Compact import-graph text extracted from file contents. Empty string when unavailable. */
  importGraph?: string
  /**
   * Compact per-file structural summary for ALL changed non-binary files —
   * paths + stats + hunk headers, no diff bodies. Drives the Story task's
   * compact prompt and its deterministic structural fallback. Present whenever
   * there are changed files (empty array when none).
   */
  storyFiles?: StoryFileSummary[]
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

// Exclusion reuses the single source of truth for generated-PATH detection
// (lib/diff/generated.ts). That module subsumes the old lockfile / dist /
// generated / *.min / *.map rules and adds more (protobuf, snapshots, …), so
// the packer now excludes everything the generated-file feature labels.
function isExcluded(filename: string): boolean {
  return isGeneratedPath(filename)
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
    return { text: '', notAnalyzed: [], includedFiles: [], importGraph: '', storyFiles: [] }
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
  const importGraph = extractImportGraph(
    eligibleFiles.map(f => f.filename),
    contents,
  )
  // Story-file summaries: ALL changed files (including generated — the story
  // fallback sinks them; excluding them here would drop coverage), paths +
  // stats + hunk headers only. Independent of the prompt token budget.
  const storyFiles: StoryFileSummary[] = files.map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    hunkHeaders: extractHunkHeaders(f.patch),
  }))
  return { text, notAnalyzed, includedFiles, importGraph, storyFiles }
}

// ---------------------------------------------------------------------------
// extractHunkHeaders — pull `@@ … @@` context lines from a unified patch.
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@[^@]*@@(.*)$/
// Cap per file so a pathological patch can't blow the compact prompt budget.
const MAX_HUNK_HEADERS_PER_FILE = 20

/**
 * Extract the hunk header lines (`@@ -a,b +c,d @@ <enclosing symbol>`) from a
 * unified-diff patch. The trailing text after the second `@@` names the
 * enclosing function/class on most diffs — exactly the symbol-level signal the
 * Story ordering needs without the line-level body. Returns [] when no patch.
 */
export function extractHunkHeaders(patch: string | undefined): string[] {
  if (!patch) return []
  const headers: string[] = []
  for (const line of patch.split('\n')) {
    if (!line.startsWith('@@')) continue
    const m = HUNK_HEADER_RE.exec(line)
    if (!m) continue
    headers.push(line.trim())
    if (headers.length >= MAX_HUNK_HEADERS_PER_FILE) break
  }
  return headers
}

// ---------------------------------------------------------------------------
// extractImportGraph — pure function (ai-quality-round2)
// ---------------------------------------------------------------------------

/**
 * Extract a compact import-graph text block from the given files and their
 * contents.  For each file whose after-content (or before-content for deleted)
 * is available, regex-extract import/require/from statements, resolve relative
 * paths against the set of changed files, and emit:
 *
 *   path -> resolved-changed-path          (one line per resolved intra-PR dep)
 *   path -> (external) pkg x<n>            (aggregated external packages, one line per file)
 *
 * Language detection is by file extension:
 *   .ts/.tsx/.js/.jsx/.mjs/.cjs — ES import / require
 *   .py                          — from .x import y (relative) or import x
 *   .rs                          — use x::y (best-effort, treated as external)
 *
 * Caps output at 80 lines.
 */
export function extractImportGraph(
  files: string[],
  contents: Map<string, { before: string | null; after: string | null }>,
): string {
  const fileSet = new Set(files)
  const lines: string[] = []

  const CAP = 80

  for (const filePath of files) {
    if (lines.length >= CAP) break

    const entry = contents.get(filePath)
    if (!entry) continue

    // Use after if available, else before (deleted files)
    const src = entry.after ?? entry.before
    if (!src) continue

    const ext = filePath.split('.').at(-1) ?? ''
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.'

    const resolvedDeps: string[] = []
    const externalPkgs: string[] = []

    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
      // ES import: import ... from '...'
      const importRe = /from\s+['"]([^'"]+)['"]/g
      // require: require('...')
      const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

      const extractModules = (re: RegExp): string[] => {
        const mods: string[] = []
        let m: RegExpExecArray | null
        while ((m = re.exec(src)) !== null) {
          mods.push(m[1])
        }
        return mods
      }

      const mods = [...extractModules(importRe), ...extractModules(requireRe)]

      for (const mod of mods) {
        if (mod.startsWith('.')) {
          // Relative import — resolve against dir
          const resolved = resolveRelativePath(dir, mod, fileSet)
          if (resolved) {
            resolvedDeps.push(resolved)
          }
          // else: relative but not in PR — skip
        } else {
          // External package — extract package name (handle scoped packages)
          const pkgName = mod.startsWith('@')
            ? mod.split('/').slice(0, 2).join('/')
            : mod.split('/')[0]
          externalPkgs.push(pkgName)
        }
      }
    } else if (ext === 'py') {
      // Python: from .x import y  OR  from x import y  OR  import x
      const fromRelRe = /^from\s+(\.+[\w.]*)\s+import/gm
      const fromAbsRe = /^from\s+([\w][\w.]*)\s+import/gm

      let m: RegExpExecArray | null
      while ((m = fromRelRe.exec(src)) !== null) {
        const dotModule = m[1]
        const resolved = resolvePythonRelative(dir, dotModule, fileSet)
        if (resolved) {
          resolvedDeps.push(resolved)
        }
      }
      while ((m = fromAbsRe.exec(src)) !== null) {
        externalPkgs.push(m[1].split('.')[0])
      }
    }

    // Deduplicate
    const uniqueDeps = [...new Set(resolvedDeps)]
    const externalCount = new Map<string, number>()
    for (const pkg of externalPkgs) {
      externalCount.set(pkg, (externalCount.get(pkg) ?? 0) + 1)
    }

    for (const dep of uniqueDeps) {
      if (lines.length >= CAP) break
      lines.push(`${filePath} -> ${dep}`)
    }

    if (externalCount.size > 0 && lines.length < CAP) {
      const extLine = [...externalCount.entries()]
        .map(([pkg, n]) => `${pkg} x${n}`)
        .join(', ')
      lines.push(`${filePath} -> (external) ${extLine}`)
    }
  }

  return lines.join('\n')
}

/**
 * Resolve a relative JS/TS import path to a file in the PR file set.
 * Tries: exact, .ts, .tsx, .js, .jsx, /index.ts, /index.js extensions.
 */
function resolveRelativePath(dir: string, mod: string, fileSet: Set<string>): string | null {
  const base = dir === '.' ? mod.replace(/^\.\//, '') : joinPath(dir, mod)

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ]

  for (const c of candidates) {
    if (fileSet.has(c)) return c
  }
  return null
}

/**
 * Resolve a Python relative dotted import (e.g. ".bar", "..utils.foo") to a file.
 * Dots mean "current package" levels up; remainder is the submodule.
 */
function resolvePythonRelative(dir: string, dotModule: string, fileSet: Set<string>): string | null {
  // Count leading dots
  let dots = 0
  while (dots < dotModule.length && dotModule[dots] === '.') dots++
  const rest = dotModule.slice(dots).replace(/\./g, '/')

  // Navigate up (dots - 1) directories from dir
  let parts = dir.split('/').filter(Boolean)
  for (let i = 0; i < dots - 1; i++) parts = parts.slice(0, -1)
  const base = rest ? [...parts, rest].join('/') : parts.join('/')

  const candidates = [`${base}.py`, `${base}/__init__.py`]
  for (const c of candidates) {
    if (fileSet.has(c)) return c
  }
  return null
}

/**
 * Simple path join: join dir + relative path, normalizing ".." and ".".
 */
function joinPath(dir: string, rel: string): string {
  const parts = [...dir.split('/'), ...rel.split('/')]
  const resolved: string[] = []
  for (const p of parts) {
    if (p === '..') {
      resolved.pop()
    } else if (p !== '.' && p !== '') {
      resolved.push(p)
    }
  }
  return resolved.join('/')
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

// NOTE: first rejection from fn() rejects the whole batch immediately; any
// already in-flight GETs continue to completion (read-only, no cancellation needed).
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
