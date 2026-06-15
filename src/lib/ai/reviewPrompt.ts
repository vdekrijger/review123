/**
 * src/lib/ai/reviewPrompt.ts — assemble a drafted code review into an
 * agent-ready markdown prompt ("Copy as LLM prompt").
 *
 * DETERMINISTIC + PURE: no network, no LLM call, no Svelte/DOM. Given the PR
 * identity, the chosen verdict, the drafted line comments, and the overall
 * comment, this produces a paste-ready markdown string a reviewer can hand to
 * a coding agent (Claude Code, Cursor, …) that has repo access and will make
 * the requested fixes.
 *
 * Why deterministic: the consumer is itself an agent with the repo checked
 * out — we do NOT pre-fetch extra context beyond the current code at each
 * commented spot. We reuse coachContext's excerpt + fileWindow helpers so the
 * "current code" block shows the code AT that location, language-fenced.
 *
 * Ordering is deterministic: drafts are sorted by file path, then line, then
 * side — so the same drafts always yield the same prompt.
 */

import { excerptAround } from '../diff/excerpt'
import type { Draft } from '../drafts/drafts.svelte'
import type { PrFile } from '../github/types'

/** Hunk-excerpt context lines above/below (matches coachContext / FileDiff). */
export const PROMPT_EXCERPT_CONTEXT = 6
/** Lines of file content above/below the commented line for the window. */
export const PROMPT_WINDOW_LINES = 12
/** Hard cap on window characters (defensive against very long lines). */
export const PROMPT_WINDOW_MAX_CHARS = 4000

/** Identity of the PR being reviewed. */
export interface ReviewPromptPr {
  owner: string
  repo: string
  number: number
  title: string
  /** Provider display name (e.g. "GitHub"). */
  provider: string
  /** Canonical web URL of the PR/MR (provider.prWebUrl). */
  url: string
}

export interface ReviewPromptInput {
  pr: ReviewPromptPr
  /** Chosen verdict, when the reviewer picked one. 'COMMENT' is treated as "no strong verdict". */
  verdict?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
  /** Drafted line comments (same drafts VerdictStep recaps). */
  drafts: Draft[]
  /** Overall review comment, if any. */
  overall?: string
  /** PR files — for patches → current-code excerpts. */
  files?: PrFile[]
  /** Full file contents map (filename → { before, after }), when fetched. */
  contents?: Map<string, { before: string | null; after: string | null }> | null
}

/** Map a file extension to a markdown fence language hint. '' when unknown. */
export function fenceLangForPath(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return ''
  const ext = path.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    svelte: 'svelte', vue: 'vue',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
    hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
    zsh: 'bash', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
    toml: 'toml', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
    xml: 'xml',
  }
  return map[ext] ?? ''
}

const VERDICT_LINE: Record<NonNullable<ReviewPromptInput['verdict']>, string> = {
  COMMENT: '',
  APPROVE: 'Overall verdict: the reviewer **approved** this PR with the notes below.',
  REQUEST_CHANGES: 'Overall verdict: the reviewer **requested changes** — the items below must be addressed.',
}

/** Extract a ```suggestion fenced block body from a comment, if present. */
function extractSuggestion(body: string): string | null {
  // Match a ```suggestion fence (optionally with trailing whitespace on the line).
  const m = /```suggestion[^\n]*\n([\s\S]*?)```/.exec(body)
  if (!m) return null
  // Trim a single trailing newline that precedes the closing fence.
  return m[1].replace(/\n$/, '')
}

/** Slice a ±window of file content around a 1-based line, capped by chars. */
function fileWindowFor(
  contents: string | null | undefined,
  line: number,
): string | undefined {
  if (!contents) return undefined
  const lines = contents.split('\n')
  if (lines.length === 0) return undefined
  const idx = line - 1
  const start = Math.max(0, idx - PROMPT_WINDOW_LINES)
  const end = Math.min(lines.length - 1, idx + PROMPT_WINDOW_LINES)
  if (start > end) return undefined
  let text = lines.slice(start, end + 1).join('\n')
  if (text.length > PROMPT_WINDOW_MAX_CHARS) text = text.slice(0, PROMPT_WINDOW_MAX_CHARS)
  return text || undefined
}

/** Stable ordering: path, then line, then side (LEFT before RIGHT). */
function sortDrafts(drafts: Draft[]): Draft[] {
  return [...drafts].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    if (a.side !== b.side) return a.side === 'LEFT' ? -1 : 1
    return (a.n ?? 0) - (b.n ?? 0)
  })
}

/** Current code at a draft's location — fileWindow when available, else hunk excerpt. */
function currentCodeFor(
  draft: Draft,
  byName: Map<string, PrFile>,
  contents: Map<string, { before: string | null; after: string | null }> | null | undefined,
): string {
  const entry = contents?.get(draft.path)
  const sideContent = entry ? (draft.side === 'LEFT' ? entry.before : entry.after) : null
  const win = fileWindowFor(sideContent, draft.line)
  if (win) return win
  const file = byName.get(draft.path)
  return file?.patch ? excerptAround(file.patch, draft.line, draft.side, PROMPT_EXCERPT_CONTEXT) : ''
}

/**
 * Build a deterministic, paste-ready markdown prompt from a drafted review.
 * Pure — safe to unit-test without Svelte/DOM/network.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { pr, verdict, overall, files = [], contents } = input
  const drafts = sortDrafts(input.drafts)

  const byName = new Map<string, PrFile>()
  for (const f of files) byName.set(f.filename, f)

  const parts: string[] = []

  // ---- Preamble ----
  const preamble =
    `You are addressing code review feedback on ${pr.owner}/${pr.repo} ` +
    `(PR #${pr.number} — ${pr.title}). ${pr.url}. For each item below, make the ` +
    `requested change in the given file at the given line. The current code is ` +
    `shown for context. Preserve existing style and tests.`
  parts.push(preamble)

  if (verdict && VERDICT_LINE[verdict]) {
    parts.push(VERDICT_LINE[verdict])
  }

  // ---- Per-draft sections ----
  drafts.forEach((draft, i) => {
    const lines: string[] = []
    const range = draft.startLine != null && draft.startLine < draft.line
      ? ` (lines ${draft.startLine}–${draft.line}, ${draft.side})`
      : ` (${draft.side})`
    lines.push(`### ${i + 1}. ${draft.path}:${draft.line}${range}`)

    const code = currentCodeFor(draft, byName, contents)
    if (code) {
      lines.push('')
      lines.push('**Current code:**')
      lines.push('')
      lines.push('```' + fenceLangForPath(draft.path))
      lines.push(code)
      lines.push('```')
    }

    const suggestion = extractSuggestion(draft.body)
    // The request is the comment body verbatim (suggestion block included — it's
    // the reviewer's words). When a suggestion is present we also surface it as a
    // dedicated proposed-change block for the agent.
    lines.push('')
    lines.push('**Request:**')
    lines.push('')
    lines.push(draft.body.trim())

    if (suggestion !== null) {
      lines.push('')
      lines.push('**Proposed change:**')
      lines.push('')
      lines.push('```' + fenceLangForPath(draft.path))
      lines.push(suggestion)
      lines.push('```')
    }

    parts.push(lines.join('\n'))
  })

  // ---- Overall comment ----
  if (overall && overall.trim()) {
    parts.push(`## Overall comment\n\n${overall.trim()}`)
  }

  return parts.join('\n\n') + '\n'
}
