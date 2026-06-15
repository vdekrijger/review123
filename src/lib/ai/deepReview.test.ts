/**
 * deepReview toolkit tests (Plan G part 2).
 *
 * Coverage: tool list capability gating, file truncation marker, per-run byte
 * budget, 404 / executor error honesty, humanized activity strings, and the
 * availability gate (toggle off / no source / model without tool support).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createDeepReviewToolkit,
  resolveTaskMode,
  DEEP_REVIEW_MAX_TOOL_CALLS,
  DEEP_REVIEW_MAX_FETCHED_BYTES,
  DEEP_REVIEW_FILE_CAP_BYTES,
  DEEP_REVIEW_TRUNCATION_MARKER,
} from './deepReview'
import type { DeepReviewSource } from './deepReview'

beforeEach(() => {
  localStorage.clear()
})

function makeSource(overrides: Partial<DeepReviewSource> = {}): DeepReviewSource {
  return {
    getFileAtHead: vi.fn().mockResolvedValue('head contents'),
    getFileAtBase: vi.fn().mockResolvedValue('base contents'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tool list / capability gating
// ---------------------------------------------------------------------------

describe('createDeepReviewToolkit — tool list', () => {
  it('offers read_file + read_file_at_base; search_code only with provider support', () => {
    const without = createDeepReviewToolkit(makeSource())
    expect(without.tools.map((t) => t.name)).toEqual(['read_file', 'read_file_at_base'])

    const withSearch = createDeepReviewToolkit(
      makeSource({ searchCode: vi.fn().mockResolvedValue('hits') }),
    )
    expect(withSearch.tools.map((t) => t.name)).toEqual(['read_file', 'read_file_at_base', 'search_code'])
  })

  it('every tool def has a JSON-schema object with required params', () => {
    const toolkit = createDeepReviewToolkit(makeSource({ searchCode: vi.fn() }))
    for (const tool of toolkit.tools) {
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(Array.isArray((tool.parameters as { required: string[] }).required)).toBe(true)
      expect(tool.description.length).toBeGreaterThan(10)
    }
  })
})

// ---------------------------------------------------------------------------
// read_file / read_file_at_base
// ---------------------------------------------------------------------------

describe('createDeepReviewToolkit — file reads', () => {
  it('routes read_file to head and read_file_at_base to base', async () => {
    const source = makeSource()
    const toolkit = createDeepReviewToolkit(source)

    const head = await toolkit.executeTool('read_file', { path: 'src/a.ts' })
    expect(head).toEqual({ ok: true, content: 'head contents' })
    expect(source.getFileAtHead).toHaveBeenCalledWith('src/a.ts')

    const base = await toolkit.executeTool('read_file_at_base', { path: 'src/a.ts' })
    expect(base).toEqual({ ok: true, content: 'base contents' })
    expect(source.getFileAtBase).toHaveBeenCalledWith('src/a.ts')
  })

  it('truncates files over the 50KB cap with an explicit marker', async () => {
    const big = 'x'.repeat(DEEP_REVIEW_FILE_CAP_BYTES + 10_000)
    const toolkit = createDeepReviewToolkit(makeSource({ getFileAtHead: vi.fn().mockResolvedValue(big) }))

    const result = await toolkit.executeTool('read_file', { path: 'big.ts' })
    expect(result.ok).toBe(true)
    expect(result.content.endsWith(DEEP_REVIEW_TRUNCATION_MARKER)).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(DEEP_REVIEW_FILE_CAP_BYTES + DEEP_REVIEW_TRUNCATION_MARKER.length)
  })

  it('returns an honest error result for files missing at the ref (404)', async () => {
    const toolkit = createDeepReviewToolkit(makeSource({ getFileAtHead: vi.fn().mockResolvedValue(null) }))
    const result = await toolkit.executeTool('read_file', { path: 'gone.ts' })
    expect(result).toEqual({ ok: false, content: 'File not found at head ref: gone.ts' })
  })

  it('converts fetcher exceptions (e.g. rate limit) into error results — never throws', async () => {
    const toolkit = createDeepReviewToolkit(
      makeSource({ getFileAtBase: vi.fn().mockRejectedValue(new Error('rate limited')) }),
    )
    const result = await toolkit.executeTool('read_file_at_base', { path: 'a.ts' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('rate limited')
  })

  it('rejects calls missing the path argument', async () => {
    const toolkit = createDeepReviewToolkit(makeSource())
    const result = await toolkit.executeTool('read_file', {})
    expect(result.ok).toBe(false)
  })

  it('enforces the 150KB per-run fetch budget across calls', async () => {
    const chunk = 'y'.repeat(DEEP_REVIEW_FILE_CAP_BYTES) // 50KB per read
    const toolkit = createDeepReviewToolkit(makeSource({ getFileAtHead: vi.fn().mockResolvedValue(chunk) }))

    // 3 × 50KB = 150KB — exactly exhausts the budget
    for (let i = 0; i < 3; i++) {
      const r = await toolkit.executeTool('read_file', { path: `f${i}.ts` })
      expect(r.ok).toBe(true)
    }
    const fourth = await toolkit.executeTool('read_file', { path: 'f4.ts' })
    expect(fourth.ok).toBe(false)
    expect(fourth.content).toContain('budget exhausted')
    expect(DEEP_REVIEW_MAX_FETCHED_BYTES).toBe(150_000)
  })
})

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------

describe('createDeepReviewToolkit — search_code', () => {
  it('delegates to the provider search and returns its text', async () => {
    const searchCode = vi.fn().mockResolvedValue('2 match(es):\n## src/a.ts\nconst createPrLoad = …')
    const toolkit = createDeepReviewToolkit(makeSource({ searchCode }))
    const result = await toolkit.executeTool('search_code', { query: 'createPrLoad' })
    expect(result.ok).toBe(true)
    expect(searchCode).toHaveBeenCalledWith('createPrLoad')
  })

  it('returns an error result when the provider has no search support', async () => {
    const toolkit = createDeepReviewToolkit(makeSource())
    const result = await toolkit.executeTool('search_code', { query: 'foo' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('not available')
  })

  it('converts search API failures into error results', async () => {
    const toolkit = createDeepReviewToolkit(
      makeSource({ searchCode: vi.fn().mockRejectedValue(new Error('403 forbidden')) }),
    )
    const result = await toolkit.executeTool('search_code', { query: 'foo' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('403 forbidden')
  })

  it('unknown tool names return an error result', async () => {
    const toolkit = createDeepReviewToolkit(makeSource())
    const result = await toolkit.executeTool('rm_rf', {})
    expect(result).toEqual({ ok: false, content: 'Unknown tool: rm_rf' })
  })
})

// ---------------------------------------------------------------------------
// humanize
// ---------------------------------------------------------------------------

describe('createDeepReviewToolkit — humanize', () => {
  it('produces the run-indicator activity strings', () => {
    const toolkit = createDeepReviewToolkit(makeSource({ searchCode: vi.fn() }))
    expect(toolkit.humanize('read_file', { path: 'src/foo.ts' })).toBe('Reading src/foo.ts…')
    expect(toolkit.humanize('read_file_at_base', { path: 'src/foo.ts' })).toBe('Reading src/foo.ts (before PR)…')
    expect(toolkit.humanize('search_code', { query: 'createPrLoad' })).toBe('Searching: createPrLoad…')
  })
})

// ---------------------------------------------------------------------------
// Availability gate
// ---------------------------------------------------------------------------

describe('resolveTaskMode (Plan J — per-task run resolution)', () => {
  it('standard (the default for an unset task) → run single-pass, not deep', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-x' }))
    expect(resolveTaskMode('verdict', makeSource())).toEqual({ run: true, deep: false })
  })

  it('a task set to off → does not run (no deep)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { diagrams: 'off' } }))
    expect(resolveTaskMode('diagrams', makeSource())).toEqual({ run: false, deep: false })
  })

  it('a task at standard → single-pass run', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { verdict: 'standard' } }))
    expect(resolveTaskMode('verdict', makeSource())).toEqual({ run: true, deep: false })
  })

  it('a deep task with a tool-capable model + source → runs deep', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash',
      aiTaskModes: { verdict: 'deep' },
    }))
    expect(resolveTaskMode('verdict', makeSource())).toEqual({ run: true, deep: true })
  })

  it('a deep task with no source → falls back to single-pass (runs, not deep)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { verdict: 'deep' } }))
    expect(resolveTaskMode('verdict', undefined)).toEqual({ run: true, deep: false })
  })

  it('a deep task on a model without tool support → runs standard WITH an honest note', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      aiProvider: 'deepseek', aiModel: 'deepseek-reasoner',
      aiTaskModes: { verdict: 'deep' },
    }))
    const r = resolveTaskMode('verdict', makeSource())
    expect(r.run).toBe(true)
    expect(r.deep).toBe(false)
    expect(r.note).toContain('does not support tool calling')
  })

  it('budget constants match the plan: 8 calls, 150KB', () => {
    expect(DEEP_REVIEW_MAX_TOOL_CALLS).toBe(8)
    expect(DEEP_REVIEW_MAX_FETCHED_BYTES).toBe(150_000)
  })
})
