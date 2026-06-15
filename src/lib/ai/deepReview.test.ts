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
  createDeepReviewCache,
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

// ---------------------------------------------------------------------------
// find_references tool
// ---------------------------------------------------------------------------

describe('createDeepReviewToolkit — find_references', () => {
  it('offers find_references only when the provider supports it', () => {
    const without = createDeepReviewToolkit(makeSource())
    expect(without.tools.map((t) => t.name)).not.toContain('find_references')

    const withRefs = createDeepReviewToolkit(
      makeSource({ findReferences: vi.fn().mockResolvedValue('refs') }),
    )
    expect(withRefs.tools.map((t) => t.name)).toContain('find_references')
  })

  it('delegates find_references to the provider with the symbol', async () => {
    const findReferences = vi.fn().mockResolvedValue('References to foo in 2 file(s):\n## a.ts (1)\nfoo()')
    const toolkit = createDeepReviewToolkit(makeSource({ findReferences }))
    const result = await toolkit.executeTool('find_references', { symbol: 'foo' })
    expect(result.ok).toBe(true)
    expect(findReferences).toHaveBeenCalledWith('foo')
  })

  it('honestly reports unavailable when the provider lacks symbol search (gitlab/bitbucket)', async () => {
    // A source without findReferences models GitLab/Bitbucket (no symbol search).
    const toolkit = createDeepReviewToolkit(makeSource())
    const result = await toolkit.executeTool('find_references', { symbol: 'foo' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('not available')
  })

  it('rejects a missing symbol argument', async () => {
    const toolkit = createDeepReviewToolkit(makeSource({ findReferences: vi.fn() }))
    const result = await toolkit.executeTool('find_references', {})
    expect(result.ok).toBe(false)
  })

  it('converts find_references API failures into error results', async () => {
    const toolkit = createDeepReviewToolkit(
      makeSource({ findReferences: vi.fn().mockRejectedValue(new Error('403 forbidden')) }),
    )
    const result = await toolkit.executeTool('find_references', { symbol: 'foo' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('403 forbidden')
  })

  it('humanizes find_references for the activity feed', () => {
    const toolkit = createDeepReviewToolkit(makeSource({ findReferences: vi.fn() }))
    expect(toolkit.humanize('find_references', { symbol: 'createPrLoad' })).toBe(
      'Finding references to createPrLoad…',
    )
  })
})

// ---------------------------------------------------------------------------
// Shared per-review cache
// ---------------------------------------------------------------------------

describe('createDeepReviewCache — shared cross-task fetch cache', () => {
  it('two toolkits sharing one cache → file fetched ONCE (cross-task reuse)', async () => {
    const cache = createDeepReviewCache()
    const getFileAtHead = vi.fn().mockResolvedValue('contents of foo')
    const source = makeSource({ getFileAtHead })

    const taskA = createDeepReviewToolkit(source, cache)
    const taskB = createDeepReviewToolkit(source, cache)

    const a = await taskA.executeTool('read_file', { path: 'src/foo.ts' })
    const b = await taskB.executeTool('read_file', { path: 'src/foo.ts' })

    expect(a).toEqual({ ok: true, content: 'contents of foo' })
    expect(b).toEqual({ ok: true, content: 'contents of foo' })
    // The underlying provider fetch happened only once.
    expect(getFileAtHead).toHaveBeenCalledTimes(1)
  })

  it('head and base refs are cached under distinct keys (no cross-ref bleed)', async () => {
    const cache = createDeepReviewCache()
    const getFileAtHead = vi.fn().mockResolvedValue('HEAD')
    const getFileAtBase = vi.fn().mockResolvedValue('BASE')
    const toolkit = createDeepReviewToolkit(makeSource({ getFileAtHead, getFileAtBase }), cache)

    const head = await toolkit.executeTool('read_file', { path: 'a.ts' })
    const base = await toolkit.executeTool('read_file_at_base', { path: 'a.ts' })
    expect(head.content).toBe('HEAD')
    expect(base.content).toBe('BASE')
    expect(getFileAtHead).toHaveBeenCalledTimes(1)
    expect(getFileAtBase).toHaveBeenCalledTimes(1)
  })

  it('search_code and find_references results are cached', async () => {
    const cache = createDeepReviewCache()
    const searchCode = vi.fn().mockResolvedValue('hit')
    const findReferences = vi.fn().mockResolvedValue('ref hit')
    const tA = createDeepReviewToolkit(makeSource({ searchCode, findReferences }), cache)
    const tB = createDeepReviewToolkit(makeSource({ searchCode, findReferences }), cache)

    await tA.executeTool('search_code', { query: 'q' })
    await tB.executeTool('search_code', { query: 'q' })
    expect(searchCode).toHaveBeenCalledTimes(1)

    await tA.executeTool('find_references', { symbol: 's' })
    await tB.executeTool('find_references', { symbol: 's' })
    expect(findReferences).toHaveBeenCalledTimes(1)
  })

  it('a cache HIT does not consume the per-task fetch-bytes budget (call counts, bytes free)', async () => {
    // 50KB file. The fetch budget is 150KB (3 reads). With a shared cache, the
    // FIRST toolkit reads 3 distinct files (exhausts its bytes). A SECOND
    // toolkit re-reading those same cached files must NOT be byte-charged, so
    // it can still read them all (hits are ~free) — proving hits don't double-charge.
    const chunk = 'z'.repeat(DEEP_REVIEW_FILE_CAP_BYTES)
    const cache = createDeepReviewCache()
    const getFileAtHead = vi.fn().mockResolvedValue(chunk)
    const source = makeSource({ getFileAtHead })

    const t1 = createDeepReviewToolkit(source, cache)
    for (const p of ['a.ts', 'b.ts', 'c.ts']) {
      const r = await t1.executeTool('read_file', { path: p })
      expect(r.ok).toBe(true)
    }
    // t1's own budget is now exhausted.
    expect((await t1.executeTool('read_file', { path: 'd.ts' })).ok).toBe(false)

    // A fresh task re-reads the SAME three cached files — all hits, all ok,
    // bytes NOT charged (no provider re-fetch), so its budget is untouched.
    const t2 = createDeepReviewToolkit(source, cache)
    for (const p of ['a.ts', 'b.ts', 'c.ts']) {
      const r = await t2.executeTool('read_file', { path: p })
      expect(r.ok).toBe(true)
    }
    // Three more cached reads still succeed (none charged bytes).
    for (const p of ['a.ts', 'b.ts', 'c.ts']) {
      expect((await t2.executeTool('read_file', { path: p })).ok).toBe(true)
    }
    // The provider fetched each of the 3 files exactly once across both tasks.
    expect(getFileAtHead).toHaveBeenCalledTimes(3)
  })

  it('LRU-evicts the least-recently-used entry when over the byte cap', async () => {
    const chunk = 'q'.repeat(40_000) // 40KB each
    const cache = createDeepReviewCache(100_000) // holds ~2 entries
    const getFileAtHead = vi.fn().mockImplementation((p: string) => Promise.resolve(`${chunk}:${p}`))
    const source = makeSource({ getFileAtHead })
    const toolkit = createDeepReviewToolkit(source, cache)

    await toolkit.executeTool('read_file', { path: 'a.ts' }) // [a]
    await toolkit.executeTool('read_file', { path: 'b.ts' }) // [a,b]
    // Re-touch a so b is now least-recently-used.
    await toolkit.executeTool('read_file', { path: 'a.ts' }) // hit, a now MRU
    await toolkit.executeTool('read_file', { path: 'c.ts' }) // pushes over cap → evict b
    expect(getFileAtHead).toHaveBeenCalledTimes(3) // a, b, c (a's second was a hit)

    // a is still cached (was MRU) — re-reading is a hit (no new fetch).
    await toolkit.executeTool('read_file', { path: 'a.ts' })
    expect(getFileAtHead).toHaveBeenCalledTimes(3)
    // b was evicted — re-reading re-fetches.
    await toolkit.executeTool('read_file', { path: 'b.ts' })
    expect(getFileAtHead).toHaveBeenCalledTimes(4)
  })

  it('does NOT cache error results (404 / rejection never poisons later tasks)', async () => {
    const cache = createDeepReviewCache()
    // First call 404s (null), second call succeeds.
    const getFileAtHead = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('now present')
    const toolkit = createDeepReviewToolkit(makeSource({ getFileAtHead }), cache)

    const first = await toolkit.executeTool('read_file', { path: 'a.ts' })
    expect(first.ok).toBe(false)
    const second = await toolkit.executeTool('read_file', { path: 'a.ts' })
    expect(second.ok).toBe(true)
    expect(getFileAtHead).toHaveBeenCalledTimes(2) // the 404 was not memoized
  })

  it('coalesces concurrent identical fetches into one underlying call', async () => {
    const cache = createDeepReviewCache()
    let resolveFetch!: (v: string) => void
    const getFileAtHead = vi.fn().mockReturnValue(new Promise<string>((r) => { resolveFetch = r }))
    const tA = createDeepReviewToolkit(makeSource({ getFileAtHead }), cache)
    const tB = createDeepReviewToolkit(makeSource({ getFileAtHead }), cache)

    const pA = tA.executeTool('read_file', { path: 'a.ts' })
    const pB = tB.executeTool('read_file', { path: 'a.ts' })
    resolveFetch('shared contents')
    const [a, b] = await Promise.all([pA, pB])

    expect(a.content).toBe('shared contents')
    expect(b.content).toBe('shared contents')
    expect(getFileAtHead).toHaveBeenCalledTimes(1)
  })

  it('without a cache, each toolkit fetches independently (pre-cache behaviour preserved)', async () => {
    const getFileAtHead = vi.fn().mockResolvedValue('x')
    const source = makeSource({ getFileAtHead })
    const tA = createDeepReviewToolkit(source) // no cache
    const tB = createDeepReviewToolkit(source) // no cache
    await tA.executeTool('read_file', { path: 'a.ts' })
    await tB.executeTool('read_file', { path: 'a.ts' })
    expect(getFileAtHead).toHaveBeenCalledTimes(2)
  })
})
