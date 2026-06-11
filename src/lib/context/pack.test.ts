/**
 * Tests for lib/context/pack.ts
 *
 * Covers: EC-16a, EC-16b, EC-16c, EC-16d, EC-16e, EC-16g, EC-16i, EC-16k
 * Plus concurrency cap test (CH-01).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { packContext, fetchContents, estimateTokens, type CiInput } from './pack'
import type { PrFile, PrMeta } from '../github/types'

// ---------------------------------------------------------------------------
// Top-level module mock — required for fetchContents tests
// vi.mock is hoisted to the top of the file by Vitest; the factory captures
// module scope only, not inner test variables. We use vi.mocked() + mockImplementation
// inside each test to vary the behaviour.
// ---------------------------------------------------------------------------
vi.mock('../github/api', () => ({
  getFileAtRef: vi.fn(),
}))

// We import the mocked module to get access to the mock fn
import { getFileAtRef } from '../github/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(
  filename: string,
  opts: Partial<PrFile> = {},
): PrFile {
  return {
    filename,
    status: 'modified',
    additions: 5,
    deletions: 3,
    patch: `@@ -1,3 +1,3 @@\n-old\n+new`,
    ...opts,
  }
}

function makeContents(
  filename: string,
  before: string | null = 'before content',
  after: string | null = 'after content',
) {
  return new Map([[filename, { before, after }]])
}

/** Build a string of exactly `chars` characters. */
function makeStr(chars: number): string {
  return 'x'.repeat(chars)
}

beforeEach(() => {
  vi.resetAllMocks()
  // Default: return 'content' for any getFileAtRef call
  vi.mocked(getFileAtRef).mockResolvedValue('content')
})

// ---------------------------------------------------------------------------
// EC-16a: zero files → empty result
// ---------------------------------------------------------------------------

describe('packContext', () => {
  describe('EC-16a: zero files', () => {
    it('returns empty text and empty arrays when files is empty and ci is null', () => {
      const result = packContext({ files: [], contents: new Map(), ci: null, budgetTokens: 1000 })
      expect(result.text).toBe('')
      expect(result.notAnalyzed).toEqual([])
      expect(result.includedFiles).toEqual([])
    })

    it('includes CI content when files empty but ci present', () => {
      const ci: CiInput = { failures: [{ name: 'test', annotations: ['fail'] }] }
      const result = packContext({
        files: [],
        contents: new Map(),
        ci,
        budgetTokens: 10_000,
      })
      expect(result.notAnalyzed).toEqual([])
      expect(result.text).toContain('CI Failures')
    })
  })

  // ---------------------------------------------------------------------------
  // EC-16b: basic inclusion — files within budget appear in text
  // ---------------------------------------------------------------------------

  describe('EC-16b: files within budget appear in context', () => {
    it('includes patch for a file within budget', () => {
      const file = makeFile('src/foo.ts', { patch: '-old\n+new' })
      const result = packContext({
        files: [file],
        contents: new Map(),
        ci: null,
        budgetTokens: 10_000,
      })
      expect(result.text).toContain('src/foo.ts')
      expect(result.text).toContain('-old\n+new')
    })

    it('includes before/after content when within budget', () => {
      const file = makeFile('src/foo.ts')
      const contents = makeContents('src/foo.ts', 'const a = 1', 'const a = 2')
      const result = packContext({
        files: [file],
        contents,
        ci: null,
        budgetTokens: 10_000,
      })
      expect(result.text).toContain('const a = 1')
      expect(result.text).toContain('const a = 2')
      expect(result.includedFiles).toContain('src/foo.ts')
    })
  })

  // ---------------------------------------------------------------------------
  // EC-16c: notAnalyzed populated for skipped/trimmed
  // ---------------------------------------------------------------------------

  describe('EC-16c: notAnalyzed tracking', () => {
    it('records file in notAnalyzed when patch exceeds budget', () => {
      const bigPatch = makeStr(100)
      const file = makeFile('src/big.ts', { patch: bigPatch })
      // budget = 1 token (way too small)
      const result = packContext({ files: [file], contents: new Map(), ci: null, budgetTokens: 1 })
      expect(result.notAnalyzed).toContain('src/big.ts')
      expect(result.text).not.toContain('src/big.ts')
    })

    it('records excluded files in notAnalyzed', () => {
      const lockFile = makeFile('pnpm-lock.yaml', { patch: 'some diff' })
      const result = packContext({
        files: [lockFile],
        contents: new Map(),
        ci: null,
        budgetTokens: 10_000,
      })
      expect(result.notAnalyzed).toContain('pnpm-lock.yaml')
      expect(result.text).not.toContain('pnpm-lock.yaml')
    })
  })

  // ---------------------------------------------------------------------------
  // EC-16d: boundary determinism — budget, budget-1, budget+1
  // ---------------------------------------------------------------------------

  describe('EC-16d: boundary determinism', () => {
    // Build a file whose patch section has exactly `actualTokens` tokens
    // according to Math.ceil(chars / 3.5), then test ±1.
    function buildBoundaryCase(filename: string, targetBudget: number) {
      const overhead = `## ${filename} (patch)\n\`\`\`diff\n\n\`\`\``.length
      // We want Math.ceil(totalChars / 3.5) === targetBudget
      // Pick totalChars = floor(targetBudget * 3.5) to stay at or below ceiling
      const totalChars = Math.floor(targetBudget * 3.5)
      const patchLength = Math.max(1, totalChars - overhead)
      const patch = makeStr(patchLength)
      const section = `## ${filename} (patch)\n\`\`\`diff\n${patch}\n\`\`\``
      const actualTokens = estimateTokens(section)
      return { patch, actualTokens }
    }

    it('includes patch at exactly the budget boundary', () => {
      const filename = 'src/boundary.ts'
      const { patch, actualTokens } = buildBoundaryCase(filename, 50)

      const file = makeFile(filename, { patch })
      // Budget = exact token count of section → should include
      const result = packContext({ files: [file], contents: new Map(), ci: null, budgetTokens: actualTokens })
      expect(result.text).toContain(filename)
      expect(result.notAnalyzed).not.toContain(filename)
    })

    it('excludes patch when budget is 1 token below section size', () => {
      const filename = 'src/boundary.ts'
      const { patch, actualTokens } = buildBoundaryCase(filename, 50)

      const file = makeFile(filename, { patch })
      // Budget one less → must NOT include
      const result = packContext({ files: [file], contents: new Map(), ci: null, budgetTokens: actualTokens - 1 })
      expect(result.notAnalyzed).toContain(filename)
    })

    it('includes patch when budget is 1 token above section size', () => {
      const filename = 'src/boundary.ts'
      const { patch, actualTokens } = buildBoundaryCase(filename, 50)

      const file = makeFile(filename, { patch })
      // Budget one more → must include
      const result = packContext({ files: [file], contents: new Map(), ci: null, budgetTokens: actualTokens + 1 })
      expect(result.text).toContain(filename)
      expect(result.notAnalyzed).not.toContain(filename)
    })
  })

  // ---------------------------------------------------------------------------
  // EC-16e: lock/generated files excluded entirely
  // ---------------------------------------------------------------------------

  describe('EC-16e: lock and generated files excluded', () => {
    const excludedFiles = [
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'dist/bundle.js',           // dist/ at root
      'src/dist/bundle.js',       // /dist/ in path
      'src/generated/types.ts',   // /generated/ in path
      'generated/types.ts',       // generated/ at root
      'app.min.js',               // *.min.* pattern
      'source.map',               // *.map extension
      'app.min.css',
    ]

    for (const filename of excludedFiles) {
      it(`excludes ${filename}`, () => {
        const file = makeFile(filename, { patch: 'some diff content' })
        const result = packContext({ files: [file], contents: new Map(), ci: null, budgetTokens: 100_000 })
        expect(result.notAnalyzed).toContain(filename)
        expect(result.text).not.toContain(filename)
        expect(result.includedFiles).not.toContain(filename)
      })
    }

    it('includes normal files alongside excluded ones', () => {
      const lock = makeFile('pnpm-lock.yaml', { patch: 'lock diff' })
      const normal = makeFile('src/app.ts', { patch: '-old\n+new' })
      const result = packContext({ files: [lock, normal], contents: new Map(), ci: null, budgetTokens: 100_000 })
      expect(result.notAnalyzed).toContain('pnpm-lock.yaml')
      expect(result.text).toContain('src/app.ts')
    })
  })

  // ---------------------------------------------------------------------------
  // EC-16g: deleted → before only; added → after only; binary → excluded
  // ---------------------------------------------------------------------------

  describe('EC-16g: content inclusion by status', () => {
    it('includes only after content for added files', () => {
      const file = makeFile('src/new.ts', { status: 'added' })
      const contents = new Map([['src/new.ts', { before: 'old code', after: 'new code' }]])
      const result = packContext({ files: [file], contents, ci: null, budgetTokens: 10_000 })
      expect(result.text).not.toContain('old code')
      expect(result.text).toContain('new code')
    })

    it('includes only before content for removed files', () => {
      const file = makeFile('src/old.ts', { status: 'removed' })
      const contents = new Map([['src/old.ts', { before: 'old code', after: 'new code' }]])
      const result = packContext({ files: [file], contents, ci: null, budgetTokens: 10_000 })
      expect(result.text).toContain('old code')
      expect(result.text).not.toContain('new code')
    })

    it('includes both before and after for modified files', () => {
      const file = makeFile('src/mod.ts', { status: 'modified' })
      const contents = new Map([['src/mod.ts', { before: 'old code', after: 'new code' }]])
      const result = packContext({ files: [file], contents, ci: null, budgetTokens: 10_000 })
      expect(result.text).toContain('old code')
      expect(result.text).toContain('new code')
    })

    it('excludes binary files (no patch, no contents)', () => {
      const binaryFile = makeFile('image.png', { patch: undefined, additions: 0, deletions: 0 })
      const result = packContext({ files: [binaryFile], contents: new Map(), ci: null, budgetTokens: 10_000 })
      expect(result.notAnalyzed).toContain('image.png')
    })

    it('includes file with no patch but has contents', () => {
      // Large file — no patch but content available
      const file = makeFile('src/large.ts', { patch: undefined })
      const contents = new Map([['src/large.ts', { before: 'before', after: 'after' }]])
      const result = packContext({ files: [file], contents, ci: null, budgetTokens: 10_000 })
      expect(result.text).toContain('before')
      expect(result.text).toContain('after')
    })
  })

  // ---------------------------------------------------------------------------
  // EC-16i: CI failures + annotations appended
  // ---------------------------------------------------------------------------

  describe('EC-16i: CI failures included', () => {
    it('appends CI failures to context', () => {
      const ci: CiInput = {
        failures: [
          { name: 'test-suite', annotations: ['line 42: assertion failed', 'line 99: timeout'] },
        ],
      }
      const result = packContext({ files: [], contents: new Map(), ci, budgetTokens: 10_000 })
      expect(result.text).toContain('CI Failures')
      expect(result.text).toContain('test-suite')
      expect(result.text).toContain('line 42: assertion failed')
      expect(result.text).toContain('line 99: timeout')
    })

    it('omits CI section when no failures', () => {
      const ci: CiInput = { failures: [] }
      const result = packContext({ files: [], contents: new Map(), ci, budgetTokens: 10_000 })
      expect(result.text).not.toContain('CI Failures')
    })

    it('omits CI section when ci is null', () => {
      const result = packContext({ files: [], contents: new Map(), ci: null, budgetTokens: 10_000 })
      expect(result.text).not.toContain('CI Failures')
    })

    it('includes multiple CI failures', () => {
      const ci: CiInput = {
        failures: [
          { name: 'unit-tests', annotations: ['fail A'] },
          { name: 'e2e-tests', annotations: ['fail B', 'fail C'] },
        ],
      }
      const result = packContext({ files: [], contents: new Map(), ci, budgetTokens: 10_000 })
      expect(result.text).toContain('unit-tests')
      expect(result.text).toContain('e2e-tests')
      expect(result.text).toContain('fail A')
      expect(result.text).toContain('fail B')
      expect(result.text).toContain('fail C')
    })
  })

  // ---------------------------------------------------------------------------
  // EC-16k: notAnalyzed correct across mixed scenarios
  // ---------------------------------------------------------------------------

  describe('EC-16k: notAnalyzed is comprehensive', () => {
    it('does not double-list a file in both notAnalyzed and includedFiles', () => {
      const file = makeFile('src/foo.ts')
      const contents = makeContents('src/foo.ts', 'before', 'after')
      const result = packContext({ files: [file], contents, ci: null, budgetTokens: 10_000 })
      expect(result.notAnalyzed).not.toContain('src/foo.ts')
      expect(result.includedFiles).toContain('src/foo.ts')
    })

    it('lists all skipped files in notAnalyzed across a mixed file set', () => {
      const files = [
        makeFile('pnpm-lock.yaml', { patch: 'big diff' }),                // excluded
        makeFile('src/tiny.ts', { patch: makeStr(1) }),                    // fits
        makeFile('src/big.ts', { patch: makeStr(100_000) }),               // too big
      ]
      const result = packContext({ files, contents: new Map(), ci: null, budgetTokens: 50 })
      expect(result.notAnalyzed).toContain('pnpm-lock.yaml')
      expect(result.notAnalyzed).toContain('src/big.ts')
      expect(result.notAnalyzed).not.toContain('src/tiny.ts')
    })
  })

  // ---------------------------------------------------------------------------
  // Additional: multiple files, ordering
  // ---------------------------------------------------------------------------

  describe('ordering and multiple files', () => {
    it('emits patch sections before content sections', () => {
      const file = makeFile('src/foo.ts', { patch: '-x\n+y' })
      const contents = makeContents('src/foo.ts', 'before', 'after')
      const result = packContext({ files: [file], contents, ci: null, budgetTokens: 10_000 })
      const patchIdx = result.text.indexOf('(patch)')
      const contentIdx = result.text.indexOf('(content)')
      expect(patchIdx).toBeLessThan(contentIdx)
    })

    it('handles a file with no matching contents gracefully', () => {
      const file = makeFile('src/foo.ts')
      const result = packContext({ files: [file], contents: new Map(), ci: null, budgetTokens: 10_000 })
      expect(result.text).toContain('src/foo.ts')
      // No crash; no content section since no contents provided
      expect(result.text).not.toContain('(content)')
    })
  })
})

// ---------------------------------------------------------------------------
// fetchContents tests
// ---------------------------------------------------------------------------

describe('fetchContents', () => {
  const META: Pick<PrMeta, 'baseSha' | 'headSha'> = { baseSha: 'base123', headSha: 'head456' }
  const REPO = { owner: 'acme', repo: 'app' }

  it('fetches before and after for modified files', async () => {
    vi.mocked(getFileAtRef).mockImplementation(async (_repo, path, ref) => {
      return `content of ${path}@${ref}`
    })

    const files: PrFile[] = [
      makeFile('src/foo.ts', { status: 'modified', additions: 10, deletions: 5 }),
    ]

    const result = await fetchContents(REPO, files, META)

    expect(result.has('src/foo.ts')).toBe(true)
    const entry = result.get('src/foo.ts')!
    expect(entry.before).not.toBeNull()
    expect(entry.after).not.toBeNull()
    // Should have been called twice: once for before, once for after
    expect(vi.mocked(getFileAtRef)).toHaveBeenCalledTimes(2)
  })

  it('skips before fetch for added files and returns null for before', async () => {
    vi.mocked(getFileAtRef).mockResolvedValue('content')

    const files: PrFile[] = [
      makeFile('src/new.ts', { status: 'added', additions: 20, deletions: 0 }),
    ]

    const result = await fetchContents(REPO, files, META)
    const entry = result.get('src/new.ts')!

    // before is null (no fetch), after is 'content'
    expect(entry.before).toBeNull()
    expect(entry.after).toBe('content')
    // Only after fetch, so called once
    expect(vi.mocked(getFileAtRef)).toHaveBeenCalledTimes(1)
  })

  it('skips after fetch for removed files and returns null for after', async () => {
    vi.mocked(getFileAtRef).mockResolvedValue('content')

    const files: PrFile[] = [
      makeFile('src/old.ts', { status: 'removed', additions: 0, deletions: 10 }),
    ]

    const result = await fetchContents(REPO, files, META)
    const entry = result.get('src/old.ts')!

    expect(entry.after).toBeNull()
    expect(entry.before).toBe('content')
    // Only before fetch
    expect(vi.mocked(getFileAtRef)).toHaveBeenCalledTimes(1)
  })

  it('limits fetched files to `limit` parameter (sorted by patch size descending)', async () => {
    vi.mocked(getFileAtRef).mockResolvedValue('content')

    const files: PrFile[] = [
      makeFile('src/small.ts', { additions: 1, deletions: 1 }),
      makeFile('src/medium.ts', { additions: 10, deletions: 5 }),
      makeFile('src/large.ts', { additions: 100, deletions: 50 }),
    ]

    // Limit to 2 — should only fetch top 2 by additions+deletions
    const result = await fetchContents(REPO, files, META, 2)

    expect(result.has('src/large.ts')).toBe(true)
    expect(result.has('src/medium.ts')).toBe(true)
    expect(result.has('src/small.ts')).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Concurrency cap test (CH-01) — asserts max in-flight ≤ 4
  // ---------------------------------------------------------------------------

  it('caps concurrency at 4 simultaneous in-flight requests', async () => {
    let inFlight = 0
    let peakInFlight = 0
    let totalStarted = 0

    // Each call resolves immediately after recording concurrency state.
    // We use a two-tick delay (Promise.resolve twice) to force the runner
    // to interleave — if it were synchronous, only 1 would be "in-flight".
    vi.mocked(getFileAtRef).mockImplementation(async () => {
      totalStarted++
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      // Yield to let other starters run before we "finish"
      await Promise.resolve()
      await Promise.resolve()
      inFlight--
      return 'content'
    })

    // 6 modified files → 12 fetch calls (before + after each).
    // With cap=4, peak must be ≤ 4.
    const files: PrFile[] = Array.from({ length: 6 }, (_, i) =>
      makeFile(`src/file${i}.ts`, { status: 'modified' }),
    )

    await fetchContents(REPO, files, META)

    expect(totalStarted).toBe(12)
    expect(peakInFlight).toBeLessThanOrEqual(4)
    expect(peakInFlight).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------------------
  // Inline concurrency runner unit test (CH-01 — direct logic test)
  // Tests the runner's cap invariant independently of fetchContents wiring
  // ---------------------------------------------------------------------------

  it('concurrency runner: peak in-flight never exceeds cap=4 across 10 items', async () => {
    const CAP = 4
    const ITEMS = 10

    // Re-implement the runner locally to test its invariant
    async function runWithConcurrencyLocal<T>(
      cap: number,
      items: T[],
      fn: (item: T) => Promise<void>,
    ): Promise<void> {
      const queue = [...items]
      let idx = 0
      let active = 0
      let peak = 0

      return new Promise<void>((resolve, reject) => {
        function next(): void {
          while (active < cap && idx < queue.length) {
            const item = queue[idx++]
            active++
            peak = Math.max(peak, active)
            fn(item).then(() => {
              active--
              next()
              if (active === 0 && idx >= queue.length) resolve()
            }, reject)
          }
          if (active === 0 && idx >= queue.length) resolve()
        }
        next()
      })
    }

    let inFlight2 = 0
    let peak2 = 0

    const deferreds: Array<{ resolve: () => void; promise: Promise<void> }> = []
    const makeDeferred = () => {
      let resolve!: () => void
      const promise = new Promise<void>(r => { resolve = r })
      deferreds.push({ resolve, promise })
      return { resolve, promise }
    }

    const itemsToProcess = Array.from({ length: ITEMS }, (_, i) => i)
    const deferredMap = itemsToProcess.map(() => makeDeferred())

    const runPromise = runWithConcurrencyLocal(CAP, itemsToProcess, async (i) => {
      inFlight2++
      peak2 = Math.max(peak2, inFlight2)
      await deferredMap[i].promise
      inFlight2--
    })

    // Allow microtasks to settle so initial batch starts
    await Promise.resolve()
    await Promise.resolve()

    // Resolve all deferred promises
    for (const d of deferredMap) {
      d.resolve()
    }

    await runPromise

    expect(peak2).toBeLessThanOrEqual(CAP)
    expect(peak2).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// estimateTokens unit test
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns Math.ceil(chars / 3.5)', () => {
    expect(estimateTokens('abc')).toBe(Math.ceil(3 / 3.5))         // 1
    expect(estimateTokens('x'.repeat(7))).toBe(Math.ceil(7 / 3.5)) // 2
    expect(estimateTokens('x'.repeat(350))).toBe(100)
    expect(estimateTokens('')).toBe(0)
  })

  it('is consistent with the documented heuristic used in pack', () => {
    // Verify the estimator is Math.ceil(length / 3.5) for a variety of lengths
    for (const len of [1, 3, 7, 10, 100, 350, 1000]) {
      const text = 'x'.repeat(len)
      expect(estimateTokens(text)).toBe(Math.ceil(len / 3.5))
    }
  })
})
