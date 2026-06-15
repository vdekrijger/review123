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
 *   find_references(symbol)  — targeted "where is this symbol used/defined"
 *                              search with symbol-boundary matching, deduped
 *                              to files (GitHub-only in v1; capability-gated)
 *
 * Budgets (hard): DEEP_REVIEW_MAX_TOOL_CALLS calls per run (enforced by the
 * loop) and DEEP_REVIEW_MAX_FETCHED_BYTES total fetched bytes (enforced
 * here). Files are capped at DEEP_REVIEW_FILE_CAP_BYTES each, truncated with
 * an explicit marker so the model knows it saw a prefix.
 *
 * Shared cross-task cache (cost): a per-REVIEW DeepReviewCache (created once
 * per createAiRun, i.e. per PR/run) is threaded into every per-task toolkit.
 * Tool fetches (read_file / read_file_at_base / search_code / find_references)
 * are memoized by (kind, path|query[, ref]) so once ANY task in the review
 * reads a file, every other task reuses it with no refetch — cutting real
 * token/$ cost on multi-task deep reviews. The cache is bound by total cached
 * bytes (LRU eviction).
 *
 * BUDGET ACCOUNTING RULE (documented choice): a CACHE HIT does NOT consume the
 * per-task fetch-BYTES budget — no fetch happened, so charging its bytes would
 * be dishonest and would shrink the budget for genuinely new reads. A cache hit
 * DOES still count toward the per-task CALL budget (enforced by the loop), so a
 * task cannot loop forever re-reading cached files. Net effect: real cost
 * (network + tokens) tracks actual fetches, while loop length stays bounded.
 *
 * Failure honesty: executors NEVER throw — every failure (404, rate limit,
 * budget exhaustion) becomes an ok:false tool result the model can react to.
 * Only ok:true results are cached (errors are never memoized).
 */

import type { LlmToolDef, LlmToolResult } from '../llm/llmToolLoop'
import { activeLlmConfig } from '../llm/config'
import { modelSupportsTools } from '../llm/providers'
import { getSettings, type AiTaskId, type AiTaskMode } from '../settings/settings'

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const DEEP_REVIEW_MAX_TOOL_CALLS = 8
export const DEEP_REVIEW_MAX_FETCHED_BYTES = 150_000
export const DEEP_REVIEW_FILE_CAP_BYTES = 50_000
export const DEEP_REVIEW_TRUNCATION_MARKER = '\n…[truncated: deep review reads at most 50 KB per file]'

/**
 * Total bytes the shared per-review cache may hold before LRU eviction. Scaled
 * to a few per-task budgets' worth: the whole point is to let multiple tasks
 * reuse the SAME handful of files, so a couple of fetch budgets is enough to
 * keep every distinct file a single task could fetch (3 × 50 KB) resident for
 * the other tasks, while still bounding browser memory.
 */
export const DEEP_REVIEW_CACHE_MAX_BYTES = 600_000

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
  /**
   * Targeted "find references" for a symbol — where it is used/defined across
   * the repo, deduped to files and ranked. More precise than searchCode (the
   * provider applies symbol-boundary matching, not raw substring). Optional —
   * GitHub-only in v1; when absent, find_references is not offered.
   */
  findReferences?: (symbol: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Shared per-review fetch cache (cost)
// ---------------------------------------------------------------------------

/** What a cache entry holds: the post-truncation tool-result content. */
interface CacheEntry {
  content: string
  bytes: number
}

/**
 * A per-REVIEW shared cache for deep-review tool fetches. Created once per
 * createAiRun (so it is naturally scoped to one PR/run and discarded when the
 * route makes a fresh run for a new PR — see CONSTRAINTS: no cross-PR leak).
 *
 * Keyed by (kind, path|query[, ref]); LRU-bounded by total cached bytes. Only
 * successful (ok:true) tool results are stored — errors are never memoized so a
 * transient 404/rate-limit doesn't poison later tasks.
 */
export interface DeepReviewCache {
  /**
   * Memoize `compute` under `key` (kind:ref:arg). Returns cached on hit. A
   * `compute` returning null means "do not cache" (e.g. a 404) — the null is
   * passed through as the result and never stored, so a transient miss cannot
   * poison later tasks.
   */
  getOrCompute(
    key: string,
    compute: () => Promise<string | null>,
  ): Promise<{ content: string | null; hit: boolean }>
  /** Current resident byte total (for tests / introspection). */
  size(): number
}

export function createDeepReviewCache(
  maxBytes: number = DEEP_REVIEW_CACHE_MAX_BYTES,
): DeepReviewCache {
  // Map preserves insertion order; we re-insert on hit to model LRU recency.
  const entries = new Map<string, CacheEntry>()
  // Coalesce concurrent identical fetches so two tasks racing the same file
  // share ONE underlying request (the whole point: one fetch, many readers).
  const inflight = new Map<string, Promise<string | null>>()
  let totalBytes = 0

  function touch(key: string, entry: CacheEntry): void {
    entries.delete(key)
    entries.set(key, entry)
  }

  function evictToFit(): void {
    // Evict least-recently-used (front of insertion order) until under cap.
    while (totalBytes > maxBytes && entries.size > 0) {
      const oldest = entries.keys().next().value as string
      const e = entries.get(oldest)!
      entries.delete(oldest)
      totalBytes -= e.bytes
    }
  }

  return {
    async getOrCompute(key, compute) {
      const cached = entries.get(key)
      if (cached) {
        touch(key, cached)
        return { content: cached.content, hit: true }
      }
      // A concurrent task is already fetching this exact key — await it and
      // report a hit (no second underlying fetch).
      const pending = inflight.get(key)
      if (pending) return { content: await pending, hit: true }

      const promise = compute()
      inflight.set(key, promise)
      let content: string | null
      try {
        content = await promise
      } finally {
        inflight.delete(key)
      }
      // null = "do not cache" (e.g. a 404) — pass through, never store.
      if (content === null) return { content: null, hit: false }
      const bytes = byteLength(content)
      // Only cache things that fit at all; a single oversized entry that can
      // never coexist with the cap is still stored alone after eviction.
      const entry: CacheEntry = { content, bytes }
      entries.set(key, entry)
      totalBytes += bytes
      evictToFit()
      return { content, hit: false }
    },
    size() {
      return totalBytes
    },
  }
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
 * Whether deep review *could* run given a source + the active model — i.e. the
 * harness-availability part, independent of any per-task mode. Used by
 * resolveTaskMode when a task is set to 'deep'.
 * - No source wired → disabled silently (non-PR contexts).
 * - Active model lacks function calling (e.g. legacy deepseek-reasoner) →
 *   disabled WITH a note so the UI can say so.
 */
function deepHarnessAvailable(source: DeepReviewSource | undefined): DeepReviewAvailability {
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

/**
 * Resolution of a single task's run mode (Plan J) — the per-task replacement
 * for the old global deepReviewAvailability(deepReview) check.
 *
 * Reads aiTaskModes[task] from settings:
 * - 'off'      → { run: false } — the task must NOT run at all (no LLM call,
 *                no context, no cache); the panel goes to 'disabled'.
 * - 'standard' → { run: true, deep: false } — single-pass.
 * - 'deep'     → { run: true, deep: true } when the harness is available
 *                (source present + tool-capable model); otherwise
 *                { run: true, deep: false, note } — standard fallback + note.
 */
export interface TaskModeResolution {
  /** Whether the task runs at all. false → panel becomes 'disabled'. */
  run: boolean
  /** Whether to use the agentic harness (only meaningful when run=true). */
  deep: boolean
  /** Honest UI note (e.g. deep requested but model can't call tools). */
  note?: string
}

export function resolveTaskMode(
  task: AiTaskId,
  source: DeepReviewSource | undefined,
): TaskModeResolution {
  const mode: AiTaskMode = getSettings().aiTaskModes[task] ?? 'standard'
  if (mode === 'off') return { run: false, deep: false }
  if (mode === 'standard') return { run: true, deep: false }
  // mode === 'deep'
  const avail = deepHarnessAvailable(source)
  if (avail.enabled) return { run: true, deep: true }
  return { run: true, deep: false, ...(avail.note ? { note: avail.note } : {}) }
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

const FIND_REFERENCES_DEF: LlmToolDef = {
  name: 'find_references',
  description:
    'Find where a SYMBOL (a function, type, or variable name) is used or defined ' +
    'across the repository, deduped to files and ranked. More precise than ' +
    'search_code: matches the symbol on word boundaries, not as a substring. ' +
    'Use it to trace callers before claiming a change breaks them (e.g. "is this ' +
    'function ever called with null?").',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'A single identifier, e.g. createPrLoad' },
    },
    required: ['symbol'],
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
 * Creates the per-TASK toolkit. The fetch-BYTES budget is per-toolkit instance
 * (one task's loop) — create a fresh toolkit per task run, never share across
 * runs.
 *
 * The optional `cache` is the per-REVIEW shared cache: pass the SAME cache to
 * every task in one review so fetches are reused across tasks. A cache HIT does
 * not consume this toolkit's fetch-bytes budget (no fetch happened); see the
 * module header for the full budget-accounting rule. When `cache` is omitted
 * each toolkit fetches independently (the pre-cache behaviour, kept for tests).
 */
export function createDeepReviewToolkit(
  source: DeepReviewSource,
  cache?: DeepReviewCache,
): DeepReviewToolkit {
  let fetchedBytes = 0

  const tools: LlmToolDef[] = [READ_FILE_DEF, READ_FILE_AT_BASE_DEF]
  if (source.searchCode) tools.push(SEARCH_CODE_DEF)
  if (source.findReferences) tools.push(FIND_REFERENCES_DEF)

  /**
   * Memoize a fetch through the shared cache when present. `compute` is only
   * called on a miss; on a hit the cache content is returned with hit=true so
   * the caller can skip charging the fetch-bytes budget. Without a cache it is
   * a passthrough reporting hit=false.
   */
  async function viaCache(
    key: string,
    compute: () => Promise<string | null>,
  ): Promise<{ content: string | null; hit: boolean }> {
    if (!cache) return { content: await compute(), hit: false }
    return cache.getOrCompute(key, compute)
  }

  async function readFile(
    path: string,
    fetcher: (path: string) => Promise<string | null>,
    refLabel: string,
  ): Promise<LlmToolResult> {
    if (fetchedBytes >= DEEP_REVIEW_MAX_FETCHED_BYTES) {
      return { ok: false, content: 'Fetch budget exhausted (150 KB) — provide your final answer from what you have verified.' }
    }
    // compute returns null on 404 -> the cache passes it through WITHOUT storing
    // it, so a transient miss never poisons later tasks; we surface ok:false.
    let cached: { content: string | null; hit: boolean }
    try {
      cached = await viaCache(`read:${refLabel}:${path}`, async () => {
        const content = await fetcher(path)
        if (content === null) return null
        const { text, truncated } = truncateToBytes(content, DEEP_REVIEW_FILE_CAP_BYTES)
        return truncated ? text + DEEP_REVIEW_TRUNCATION_MARKER : text
      })
    } catch (err) {
      return { ok: false, content: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (cached.content === null) {
      return { ok: false, content: `File not found at ${refLabel} ref: ${path}` }
    }
    // Cache MISS charges real fetched bytes; a HIT is ~free (no fetch occurred).
    if (!cached.hit) fetchedBytes += byteLength(cached.content)
    return { ok: true, content: cached.content }
  }

  /** Shared body for the two text-search tools (search_code, find_references). */
  async function runSearch(
    cacheKind: string,
    query: string,
    fetcher: (query: string) => Promise<string>,
  ): Promise<LlmToolResult> {
    if (fetchedBytes >= DEEP_REVIEW_MAX_FETCHED_BYTES) {
      return { ok: false, content: 'Fetch budget exhausted (150 KB) — provide your final answer from what you have verified.' }
    }
    try {
      const cached = await viaCache(`${cacheKind}:${query}`, async () => {
        const result = await fetcher(query)
        const { text, truncated } = truncateToBytes(result, DEEP_REVIEW_FILE_CAP_BYTES)
        return truncated ? text + DEEP_REVIEW_TRUNCATION_MARKER : text
      })
      // search/refs always return a string (compute never returns null here).
      const content = cached.content ?? ''
      if (!cached.hit) fetchedBytes += byteLength(content)
      return { ok: true, content }
    } catch (err) {
      return { ok: false, content: `Search failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  async function executeTool(name: string, args: Record<string, unknown>): Promise<LlmToolResult> {
    const path = typeof args.path === 'string' ? args.path : ''
    const query = typeof args.query === 'string' ? args.query : ''
    const symbol = typeof args.symbol === 'string' ? args.symbol : ''

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
        return runSearch('search', query, source.searchCode)
      }
      case 'find_references': {
        if (!source.findReferences) return { ok: false, content: 'find_references is not available for this provider.' }
        if (!symbol) return { ok: false, content: 'find_references requires a "symbol" string argument.' }
        return runSearch('refs', symbol, source.findReferences)
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
      case 'find_references':
        return `Finding references to ${typeof args.symbol === 'string' ? args.symbol : '?'}…`
      default:
        return `${name}…`
    }
  }

  return { tools, executeTool, humanize }
}
