/**
 * src/lib/ai/deepReview.ts — agentic deep-review toolkit (Plan G part 2).
 *
 * Provides the three verification tools the deep-review loop can call, with
 * hard per-run budgets, plus the availability gate and humanized activity
 * strings for the run indicator.
 *
 * Tools (browser-feasible via the existing provider layer):
 *   read_file(path)          — contents at the PR HEAD ref (provider.getFileAtRef)
 *   read_file_at_base(path)  — contents at the PR BASE ref
 *   search_code(query)       — repo-scoped code search (GitHub-only in v1;
 *                              capability-gated by provider method presence)
 *
 * Budgets (hard): DEEP_REVIEW_MAX_TOOL_CALLS calls per run (enforced by the
 * loop) and DEEP_REVIEW_MAX_FETCHED_BYTES total fetched bytes (enforced
 * here). Files are capped at DEEP_REVIEW_FILE_CAP_BYTES each, truncated with
 * an explicit marker so the model knows it saw a prefix.
 *
 * Failure honesty: executors NEVER throw — every failure (404, rate limit,
 * budget exhaustion) becomes an ok:false tool result the model can react to.
 */

import type { LlmToolDef, LlmToolResult } from '../llm/llmToolLoop'
import { activeLlmConfig } from '../llm/config'
import { modelSupportsTools } from '../llm/providers'
import { getSettings } from '../settings/settings'

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const DEEP_REVIEW_MAX_TOOL_CALLS = 8
export const DEEP_REVIEW_MAX_FETCHED_BYTES = 150_000
export const DEEP_REVIEW_FILE_CAP_BYTES = 50_000
export const DEEP_REVIEW_TRUNCATION_MARKER = '\n…[truncated: deep review reads at most 50 KB per file]'

// ---------------------------------------------------------------------------
// Source — what the host (Review route) wires from the active VCS provider
// ---------------------------------------------------------------------------

export interface DeepReviewSource {
  /** File contents at the PR head ref, or null when absent at that ref. */
  getFileAtHead(path: string): Promise<string | null>
  /** File contents at the PR base ref, or null when absent at that ref. */
  getFileAtBase(path: string): Promise<string | null>
  /**
   * Repo-scoped code search. Optional — only present when the VCS provider
   * supports it (GitHub in v1). When absent, search_code is not offered.
   */
  searchCode?: (query: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Availability gate
// ---------------------------------------------------------------------------

export interface DeepReviewAvailability {
  enabled: boolean
  /** Honest UI note when the toggle is on but deep review cannot run. */
  note?: string
}

/**
 * Whether deep review should run for this AI run.
 * - Toggle off → disabled silently (byte-identical single-pass behavior).
 * - Toggle on but no source wired → disabled silently (non-PR contexts).
 * - Toggle on but the active model lacks function calling (e.g. legacy
 *   deepseek-reasoner) → disabled WITH a note so the UI can say so.
 */
export function deepReviewAvailability(source: DeepReviewSource | undefined): DeepReviewAvailability {
  if (!getSettings().aiDeepReview) return { enabled: false }
  if (!source) return { enabled: false }
  const { model } = activeLlmConfig()
  if (!modelSupportsTools(model)) {
    return {
      enabled: false,
      note: `Deep review unavailable: ${model.label} does not support tool calling — ran standard review.`,
    }
  }
  return { enabled: true }
}

// ---------------------------------------------------------------------------
// Toolkit
// ---------------------------------------------------------------------------

export interface DeepReviewToolkit {
  tools: LlmToolDef[]
  executeTool(name: string, args: Record<string, unknown>): Promise<LlmToolResult>
  /** "Reading src/foo.ts…" / "Searching: createPrLoad…" for the run indicator. */
  humanize(name: string, args: Record<string, unknown>): string
}

const READ_FILE_DEF: LlmToolDef = {
  name: 'read_file',
  description:
    'Read the full contents of a file at the PR head (the state AFTER this PR). ' +
    'Use it to verify suspicions about code outside the diff before flagging them.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative file path, e.g. src/lib/foo.ts' },
    },
    required: ['path'],
  },
}

const READ_FILE_AT_BASE_DEF: LlmToolDef = {
  name: 'read_file_at_base',
  description:
    'Read the full contents of a file at the PR base (the state BEFORE this PR). ' +
    'Use it to compare pre-PR behavior when the diff alone is ambiguous.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative file path, e.g. src/lib/foo.ts' },
    },
    required: ['path'],
  },
}

const SEARCH_CODE_DEF: LlmToolDef = {
  name: 'search_code',
  description:
    'Search the repository for code matching a query (identifiers work best). ' +
    'Use it to find callers/consumers of a changed symbol before claiming breakage.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms, e.g. an identifier like createPrLoad' },
    },
    required: ['query'],
  },
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Truncate a string to at most `cap` bytes (by character backoff). */
function truncateToBytes(s: string, cap: number): { text: string; truncated: boolean } {
  if (byteLength(s) <= cap) return { text: s, truncated: false }
  // Back off characters until under the cap (multibyte-safe, coarse is fine).
  let end = Math.min(s.length, cap)
  while (end > 0 && byteLength(s.slice(0, end)) > cap) {
    end = Math.floor(end * 0.9)
  }
  return { text: s.slice(0, end), truncated: true }
}

/**
 * Creates the per-run toolkit. Byte accounting is per-toolkit instance —
 * create a fresh toolkit per task run, never share across runs.
 */
export function createDeepReviewToolkit(source: DeepReviewSource): DeepReviewToolkit {
  let fetchedBytes = 0

  const tools: LlmToolDef[] = [READ_FILE_DEF, READ_FILE_AT_BASE_DEF]
  if (source.searchCode) tools.push(SEARCH_CODE_DEF)

  async function readFile(
    path: string,
    fetcher: (path: string) => Promise<string | null>,
    refLabel: string,
  ): Promise<LlmToolResult> {
    if (fetchedBytes >= DEEP_REVIEW_MAX_FETCHED_BYTES) {
      return { ok: false, content: 'Fetch budget exhausted (150 KB) — provide your final answer from what you have verified.' }
    }
    let content: string | null
    try {
      content = await fetcher(path)
    } catch (err) {
      return { ok: false, content: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (content === null) {
      return { ok: false, content: `File not found at ${refLabel} ref: ${path}` }
    }
    const { text, truncated } = truncateToBytes(content, DEEP_REVIEW_FILE_CAP_BYTES)
    fetchedBytes += byteLength(text)
    return { ok: true, content: truncated ? text + DEEP_REVIEW_TRUNCATION_MARKER : text }
  }

  async function executeTool(name: string, args: Record<string, unknown>): Promise<LlmToolResult> {
    const path = typeof args.path === 'string' ? args.path : ''
    const query = typeof args.query === 'string' ? args.query : ''

    switch (name) {
      case 'read_file':
        if (!path) return { ok: false, content: 'read_file requires a "path" string argument.' }
        return readFile(path, source.getFileAtHead, 'head')
      case 'read_file_at_base':
        if (!path) return { ok: false, content: 'read_file_at_base requires a "path" string argument.' }
        return readFile(path, source.getFileAtBase, 'base')
      case 'search_code': {
        if (!source.searchCode) return { ok: false, content: 'search_code is not available for this provider.' }
        if (!query) return { ok: false, content: 'search_code requires a "query" string argument.' }
        if (fetchedBytes >= DEEP_REVIEW_MAX_FETCHED_BYTES) {
          return { ok: false, content: 'Fetch budget exhausted (150 KB) — provide your final answer from what you have verified.' }
        }
        try {
          const result = await source.searchCode(query)
          const { text, truncated } = truncateToBytes(result, DEEP_REVIEW_FILE_CAP_BYTES)
          fetchedBytes += byteLength(text)
          return { ok: true, content: truncated ? text + DEEP_REVIEW_TRUNCATION_MARKER : text }
        } catch (err) {
          return { ok: false, content: `Search failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      }
      default:
        return { ok: false, content: `Unknown tool: ${name}` }
    }
  }

  function humanize(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'read_file':
        return `Reading ${typeof args.path === 'string' ? args.path : '?'}…`
      case 'read_file_at_base':
        return `Reading ${typeof args.path === 'string' ? args.path : '?'} (before PR)…`
      case 'search_code':
        return `Searching: ${typeof args.query === 'string' ? args.query : '?'}…`
      default:
        return `${name}…`
    }
  }

  return { tools, executeTool, humanize }
}
