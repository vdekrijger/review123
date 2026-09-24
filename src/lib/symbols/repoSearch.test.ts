/**
 * repoSearch tests (Tier 2 symbol navigation).
 *
 * Coverage: the search → fetch-at-head-SHA → index → refs pipeline with a
 * mocked provider; PR-file exclusion; the self-correcting head re-check
 * (deleted files drop out); the 20k-line size cap; per-symbol caching +
 * concurrent-click dedup; failure eviction (retry re-searches); the
 * rate-limit / auth error messages; capability/context detection via
 * currentRepoSearchContext (route + method presence + head SHA); and
 * repoSearchIsFree, the cost question the popover asks before auto-resolving.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  currentRepoSearchContext,
  repoSearchIsFree,
  searchRepoForSymbol,
  _resetRepoSearchCacheForTest,
  REPO_SEARCH_RATE_LIMIT_MESSAGE,
  type RepoSearchContext,
} from './repoSearch'
import { registerSymbolSource, _resetSymbolSourcesForTest } from './symbolSources'
import { _setCaptureForTest } from '../analytics/analytics'
import { GithubApiError } from '../github/types'
import { router } from '../router/router.svelte'
import { groundingIsLocal, noteGroundingFailure, readLocalFiles, searchLocalPaths } from '../bridge/grounding'

// The bridge seam is mocked: these tests own the WIRING (which source answers,
// and what happens when it stops answering), not the transport — grounding.test.ts
// owns that. Default OFF so every pre-existing test keeps its provider path.
vi.mock('../bridge/grounding', () => ({
  groundingIsLocal: vi.fn(() => false),
  noteGroundingFailure: vi.fn(),
  readLocalFiles: vi.fn(),
  searchLocalPaths: vi.fn(),
}))

const REPO = { owner: 'org', repo: 'repo' }
const HEAD = 'headsha123'

const OTHER_TS = [
  "import { computeTotal } from './util'",
  'export function report(xs: number[]) {',
  '  return computeTotal(xs) * 2',
  '}',
].join('\n')

const DEF_TS = [
  'export function computeTotal(values: number[]): number {',
  '  return values.reduce((t, v) => t + v, 0)',
  '}',
].join('\n')

function makeCtx(overrides: {
  paths?: string[]
  files?: Record<string, string | null>
  searchError?: unknown
  excludePaths?: Set<string>
}): RepoSearchContext & { searchMock: ReturnType<typeof vi.fn>; fetchMock: ReturnType<typeof vi.fn> } {
  const searchMock = vi.fn(async () => {
    if (overrides.searchError) throw overrides.searchError
    return overrides.paths ?? []
  })
  const fetchMock = vi.fn(async (_repo: { owner: string; repo: string }, path: string, _ref: string) => {
    const files = overrides.files ?? {}
    return path in files ? files[path] : null
  })
  return {
    provider: { searchCodePaths: searchMock, getFileAtRef: fetchMock },
    repo: REPO,
    headSha: HEAD,
    excludePaths: overrides.excludePaths ?? new Set(),
    searchMock,
    fetchMock,
  }
}

beforeEach(() => {
  _resetRepoSearchCacheForTest()
  _resetSymbolSourcesForTest()
  vi.mocked(groundingIsLocal).mockReturnValue(false)
})

describe('searchRepoForSymbol — pipeline', () => {
  it('search → fetch at head SHA → index → real {path, line, snippet} refs', async () => {
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })
    const out = await searchRepoForSymbol('computeTotal', ctx)

    expect(ctx.searchMock).toHaveBeenCalledWith(REPO, 'computeTotal')
    expect(ctx.fetchMock).toHaveBeenCalledWith(REPO, 'src/other.ts', HEAD)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.filesScanned).toBe(1)
    // Both mention lines (import + call) come back with real line numbers.
    expect(out.references.map((r) => ({ file: r.file, line: r.line }))).toEqual([
      { file: 'src/other.ts', line: 1 },
      { file: 'src/other.ts', line: 3 },
    ])
    expect(out.references[1].snippet).toContain('computeTotal(xs) * 2')
    // These files aren't in the diff view — never jumpable.
    expect(out.references.every((r) => !r.inDiff)).toBe(true)
  })

  it('finds definitions too — upgrading the "not in changed files" state', async () => {
    const ctx = makeCtx({ paths: ['src/def.ts'], files: { 'src/def.ts': DEF_TS } })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.definitions).toHaveLength(1)
    expect(out.definitions[0].file).toBe('src/def.ts')
    expect(out.definitions[0].line).toBe(1)
    expect(out.definitions[0].kind).toBe('function')
  })

  it('excludes paths already in the PR file list', async () => {
    const ctx = makeCtx({
      paths: ['src/in-pr.ts', 'src/other.ts'],
      files: { 'src/in-pr.ts': OTHER_TS, 'src/other.ts': OTHER_TS },
      excludePaths: new Set(['src/in-pr.ts']),
    })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(ctx.fetchMock).not.toHaveBeenCalledWith(REPO, 'src/in-pr.ts', HEAD)
    expect(out.references.every((r) => r.file === 'src/other.ts')).toBe(true)
  })

  it('defaults the exclusion set to the registered symbol sources (PR files)', async () => {
    registerSymbolSource({ filename: 'src/in-pr.ts', patch: '@@ -1,1 +1,1 @@\n+const x = computeTotal()' })
    const ctx = makeCtx({ paths: ['src/in-pr.ts', 'src/other.ts'], files: { 'src/other.ts': OTHER_TS } })
    delete (ctx as Partial<RepoSearchContext>).excludePaths
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out.ok).toBe(true)
    expect(ctx.fetchMock).not.toHaveBeenCalledWith(REPO, 'src/in-pr.ts', HEAD)
  })

  it('drops files missing at the head SHA (the default-branch index self-corrects)', async () => {
    const ctx = makeCtx({
      paths: ['src/deleted.ts', 'src/other.ts'],
      files: { 'src/other.ts': OTHER_TS }, // deleted.ts → null at head
    })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.filesScanned).toBe(1)
    expect(out.filesSkipped).toBe(1)
    expect(out.references.every((r) => r.file === 'src/other.ts')).toBe(true)
  })

  it('skips files over the 20k-line cap (same cap as the Tier 1 index)', async () => {
    const huge = Array.from({ length: 20_001 }, () => 'computeTotal()').join('\n')
    const ctx = makeCtx({ paths: ['src/huge.ts'], files: { 'src/huge.ts': huge } })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.filesScanned).toBe(0)
    expect(out.filesSkipped).toBe(1)
    expect(out.references).toHaveLength(0)
  })

  it('returns empty refs (ok) when the search finds nothing', async () => {
    const ctx = makeCtx({ paths: [] })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out).toEqual({ ok: true, definitions: [], references: [], filesScanned: 0, filesSkipped: 0, contentsByPath: new Map() })
  })

  it('carries each scanned file\'s head-SHA contents for the definition peek', async () => {
    const ctx = makeCtx({ paths: ['src/def.ts'], files: { 'src/def.ts': DEF_TS } })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.contentsByPath?.get('src/def.ts')).toBe(DEF_TS)
  })
})

describe('searchRepoForSymbol — cache', () => {
  it('re-clicks are free: the same symbol+headSha hits the cache', async () => {
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })
    const first = await searchRepoForSymbol('computeTotal', ctx)
    const second = await searchRepoForSymbol('computeTotal', ctx)
    expect(ctx.searchMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('concurrent clicks share ONE in-flight search', async () => {
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })
    const [a, b] = await Promise.all([
      searchRepoForSymbol('computeTotal', ctx),
      searchRepoForSymbol('computeTotal', ctx),
    ])
    expect(ctx.searchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('different symbols are cached separately', async () => {
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })
    await searchRepoForSymbol('computeTotal', ctx)
    await searchRepoForSymbol('report', ctx)
    expect(ctx.searchMock).toHaveBeenCalledTimes(2)
  })

  it('failures are NOT cached — a retry searches again', async () => {
    const err = new GithubApiError({ kind: 'rate-limited', resetAt: new Date() })
    const ctx = makeCtx({ searchError: err })
    const first = await searchRepoForSymbol('computeTotal', ctx)
    expect(first.ok).toBe(false)
    const second = await searchRepoForSymbol('computeTotal', ctx)
    expect(second.ok).toBe(false)
    expect(ctx.searchMock).toHaveBeenCalledTimes(2)
  })
})

describe('searchRepoForSymbol — error surfaces', () => {
  it.each([
    ['rate-limited 403', new GithubApiError({ kind: 'rate-limited', resetAt: new Date() })],
    ['forbidden 403', new GithubApiError({ kind: 'forbidden', message: 'abuse detection' })],
    ['unprocessable 422', new GithubApiError({ kind: 'unprocessable', message: 'Validation Failed' })],
    ['server 429', new GithubApiError({ kind: 'server', status: 429 })],
  ])('maps %s to the user-facing rate-limit message', async (_name, err) => {
    const ctx = makeCtx({ searchError: err })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out).toEqual({ ok: false, message: REPO_SEARCH_RATE_LIMIT_MESSAGE })
  })

  it('maps 401 to a sign-in message', async () => {
    const ctx = makeCtx({ searchError: new GithubApiError({ kind: 'unauthorized' }) })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out).toEqual({ ok: false, message: 'Code search requires a signed-in GitHub token.' })
  })

  it('maps unknown failures to a generic retry message (never throws)', async () => {
    const ctx = makeCtx({ searchError: new Error('boom') })
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out).toEqual({ ok: false, message: 'Repo search failed — try again.' })
  })

  it('surfaces a contents-fetch rate limit the same way', async () => {
    const ctx = makeCtx({ paths: ['src/other.ts'] })
    ctx.fetchMock.mockRejectedValue(new GithubApiError({ kind: 'rate-limited', resetAt: new Date() }))
    const out = await searchRepoForSymbol('computeTotal', ctx)
    expect(out).toEqual({ ok: false, message: REPO_SEARCH_RATE_LIMIT_MESSAGE })
  })
})

describe('searchRepoForSymbol — analytics (symbol_repo_searched)', () => {
  const capture = vi.fn()
  beforeEach(() => {
    capture.mockClear()
    _setCaptureForTest(capture)
  })

  function searchedEvents() {
    return capture.mock.calls.filter(([name]) => name === 'symbol_repo_searched')
  }

  it('a real (cache-miss) search fires ONE event with outcome + counts + duration', async () => {
    const ctx = makeCtx({
      paths: ['src/other.ts', 'src/gone.ts'],
      files: { 'src/other.ts': OTHER_TS }, // gone.ts → null at head → skipped
    })
    await searchRepoForSymbol('computeTotal', ctx)
    const events = searchedEvents()
    expect(events).toHaveLength(1)
    const props = events[0][1] as Record<string, unknown>
    expect(props).toMatchObject({
      outcome: 'success',
      definitions: 0,
      references: 2, // import + call line in OTHER_TS
      files_scanned: 1,
      files_skipped: 1,
    })
    expect(typeof props['duration_ms']).toBe('number')
    // The choke-point allowlist strips everything else, but the call site must
    // not even OFFER content: no symbol, path, or snippet keys.
    expect(props).not.toHaveProperty('symbol')
    expect(props).not.toHaveProperty('path')
  })

  it('cache hits fire NOTHING — the event counts real searches only', async () => {
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })
    await searchRepoForSymbol('computeTotal', ctx)
    await searchRepoForSymbol('computeTotal', ctx) // settled-cache hit
    expect(ctx.searchMock).toHaveBeenCalledTimes(1)
    expect(searchedEvents()).toHaveLength(1)
  })

  it('concurrent clicks share one search AND one event', async () => {
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })
    await Promise.all([searchRepoForSymbol('computeTotal', ctx), searchRepoForSymbol('computeTotal', ctx)])
    expect(ctx.searchMock).toHaveBeenCalledTimes(1)
    expect(searchedEvents()).toHaveLength(1)
  })

  it.each([
    ['rate-limited 403', new GithubApiError({ kind: 'rate-limited', resetAt: new Date() }), 'rate_limited'],
    ['forbidden 403', new GithubApiError({ kind: 'forbidden', message: 'abuse detection' }), 'rate_limited'],
    ['unauthorized 401', new GithubApiError({ kind: 'unauthorized' }), 'unauthorized'],
    ['unknown failure', new Error('boom'), 'error'],
  ])('%s fires outcome %s (no result counts)', async (_name, err, expectedOutcome) => {
    const ctx = makeCtx({ searchError: err })
    await searchRepoForSymbol('computeTotal', ctx)
    const events = searchedEvents()
    expect(events).toHaveLength(1)
    const props = events[0][1] as Record<string, unknown>
    expect(props['outcome']).toBe(expectedOutcome)
    expect(typeof props['duration_ms']).toBe('number')
    expect(props).not.toHaveProperty('references')
  })

  it('a retry after failure is a NEW search and fires again (failure evicted)', async () => {
    const ctx = makeCtx({ searchError: new GithubApiError({ kind: 'rate-limited', resetAt: new Date() }) })
    await searchRepoForSymbol('computeTotal', ctx)
    await searchRepoForSymbol('computeTotal', ctx)
    expect(ctx.searchMock).toHaveBeenCalledTimes(2)
    expect(searchedEvents()).toHaveLength(2)
  })
})

describe('currentRepoSearchContext — capability detection', () => {
  const reviewRoute = { name: 'review', provider: 'github', owner: 'org', repo: 'repo', number: 1, step: 2 } as const

  it('returns provider + repo + headSha on a GitHub review route', () => {
    router.route = { ...reviewRoute }
    const ctx = currentRepoSearchContext('headsha123')
    expect(ctx).not.toBeNull()
    expect(ctx!.repo).toEqual({ owner: 'org', repo: 'repo' })
    expect(ctx!.headSha).toBe('headsha123')
    expect(typeof ctx!.provider.searchCodePaths).toBe('function')
  })

  it('returns null without a head SHA', () => {
    router.route = { ...reviewRoute }
    expect(currentRepoSearchContext(undefined)).toBeNull()
  })

  it('returns null off the review route (e.g. the demo)', () => {
    router.route = { name: 'demo' }
    expect(currentRepoSearchContext('headsha123')).toBeNull()
  })

  it('returns null for providers without code search (GitLab/Bitbucket today)', () => {
    router.route = { ...reviewRoute, provider: 'gitlab' }
    expect(currentRepoSearchContext('headsha123')).toBeNull()
    router.route = { ...reviewRoute, provider: 'bitbucket' }
    expect(currentRepoSearchContext('headsha123')).toBeNull()
  })

  it('OFFERS repo search on a provider without it, when a matching local checkout can answer', () => {
    vi.mocked(groundingIsLocal).mockReturnValue(true)
    router.route = { ...reviewRoute, provider: 'gitlab' }
    // This is the user-visible gain: repo search where there was none.
    expect(currentRepoSearchContext('headsha123')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// repoSearchIsFree — the cost question the popover asks before auto-resolving.
// ---------------------------------------------------------------------------

describe('repoSearchIsFree', () => {
  const reviewRoute = { name: 'review', provider: 'github', owner: 'org', repo: 'repo', number: 1, step: 2 } as const

  it('is false before any context has been resolved', () => {
    expect(repoSearchIsFree()).toBe(false)
  })

  it('is TRUE when a local bridge is grounded at the PR head (no quota to spend)', () => {
    vi.mocked(groundingIsLocal).mockReturnValue(true)
    router.route = { ...reviewRoute }
    currentRepoSearchContext('headsha123')
    expect(repoSearchIsFree()).toBe(true)
  })

  it('is FALSE on the provider path, where a search spends a rate-limited API call', () => {
    vi.mocked(groundingIsLocal).mockReturnValue(false)
    router.route = { ...reviewRoute }
    currentRepoSearchContext('headsha123')
    expect(repoSearchIsFree()).toBe(false)
  })

  it('goes false again the moment local grounding is lost mid-review', () => {
    vi.mocked(groundingIsLocal).mockReturnValue(true)
    router.route = { ...reviewRoute }
    currentRepoSearchContext('headsha123')
    expect(repoSearchIsFree()).toBe(true)
    // The bridge died — grounding.ts latches the head and answers false.
    vi.mocked(groundingIsLocal).mockReturnValue(false)
    expect(repoSearchIsFree()).toBe(false)
  })

  it('does not keep answering for a PR that is no longer in view', () => {
    vi.mocked(groundingIsLocal).mockReturnValue(true)
    router.route = { ...reviewRoute }
    currentRepoSearchContext('headsha123')
    expect(repoSearchIsFree()).toBe(true)
    // Navigated somewhere with no head SHA — the stale context must be dropped.
    currentRepoSearchContext(undefined)
    expect(repoSearchIsFree()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Local (bridge) grounding — the symbol-search half.
//
// Two independent steps can each be answered locally: finding CANDIDATE PATHS,
// and READING them. Both must fall back independently, because a bridge can
// die between them.
// ---------------------------------------------------------------------------

describe('searchRepoForSymbol — local grounding', () => {
  beforeEach(() => {
    vi.mocked(groundingIsLocal).mockReturnValue(true)
    vi.mocked(noteGroundingFailure).mockClear()
    vi.mocked(searchLocalPaths).mockReset()
    vi.mocked(readLocalFiles).mockReset()
  })

  it('searches AND reads locally, touching the provider not once', async () => {
    vi.mocked(searchLocalPaths).mockResolvedValue(['src/other.ts'])
    vi.mocked(readLocalFiles).mockResolvedValue(new Map([['src/other.ts', OTHER_TS]]))
    const ctx = makeCtx({})

    const out = await searchRepoForSymbol('computeTotal', ctx)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.filesScanned).toBe(1)
    expect(out.references.length).toBeGreaterThan(0)
    expect(ctx.searchMock).not.toHaveBeenCalled()
    expect(ctx.fetchMock).not.toHaveBeenCalled()
  })

  it('reads the whole candidate list in ONE call, not one per file', async () => {
    vi.mocked(searchLocalPaths).mockResolvedValue(['a.ts', 'b.ts', 'c.ts'])
    vi.mocked(readLocalFiles).mockResolvedValue(new Map())

    await searchRepoForSymbol('computeTotal', makeCtx({}))

    expect(readLocalFiles).toHaveBeenCalledTimes(1)
    expect(readLocalFiles).toHaveBeenCalledWith(HEAD, ['a.ts', 'b.ts', 'c.ts'])
  })

  it('still excludes the PR’s own files — Tier 1 already lists those call points', async () => {
    vi.mocked(searchLocalPaths).mockResolvedValue(['src/other.ts', 'src/in-pr.ts'])
    vi.mocked(readLocalFiles).mockResolvedValue(new Map([['src/other.ts', OTHER_TS]]))

    await searchRepoForSymbol('computeTotal', makeCtx({ excludePaths: new Set(['src/in-pr.ts']) }))

    expect(readLocalFiles).toHaveBeenCalledWith(HEAD, ['src/other.ts'])
  })

  it('falls back to the PROVIDER search when the local path search fails', async () => {
    vi.mocked(searchLocalPaths).mockRejectedValue(new Error('bridge gone'))
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })

    const out = await searchRepoForSymbol('computeTotal', ctx)

    expect(out.ok).toBe(true)
    expect(ctx.searchMock).toHaveBeenCalledWith(REPO, 'computeTotal')
    expect(noteGroundingFailure).toHaveBeenCalledWith(HEAD)
  })

  it('falls back to PROVIDER reads when the search worked but the read failed', async () => {
    vi.mocked(searchLocalPaths).mockResolvedValue(['src/other.ts'])
    vi.mocked(readLocalFiles).mockRejectedValue(new Error('bridge gone mid-search'))
    const ctx = makeCtx({ files: { 'src/other.ts': OTHER_TS } })

    const out = await searchRepoForSymbol('computeTotal', ctx)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.filesScanned).toBe(1)
    expect(ctx.fetchMock).toHaveBeenCalledWith(REPO, 'src/other.ts', HEAD)
    expect(noteGroundingFailure).toHaveBeenCalledWith(HEAD)
  })

  it('counts a locally-unreadable file as SKIPPED, exactly as a 404 at head is', async () => {
    vi.mocked(searchLocalPaths).mockResolvedValue(['src/other.ts', 'src/binary.png'])
    vi.mocked(readLocalFiles).mockResolvedValue(
      new Map<string, string | null>([
        ['src/other.ts', OTHER_TS],
        ['src/binary.png', null],
      ]),
    )

    const out = await searchRepoForSymbol('computeTotal', makeCtx({}))

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.filesScanned).toBe(1)
    expect(out.filesSkipped).toBe(1)
  })

  it('applies the SAME line cap to local files — it is a parse budget, not a transfer one', async () => {
    vi.mocked(searchLocalPaths).mockResolvedValue(['huge.ts'])
    vi.mocked(readLocalFiles).mockResolvedValue(
      new Map([['huge.ts', 'computeTotal()\n'.repeat(20_001)]]),
    )

    const out = await searchRepoForSymbol('computeTotal', makeCtx({}))

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.filesScanned).toBe(0)
    expect(out.filesSkipped).toBe(1)
  })

  it('uses the PROVIDER when grounding is not local, unchanged', async () => {
    vi.mocked(groundingIsLocal).mockReturnValue(false)
    const ctx = makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } })

    await searchRepoForSymbol('computeTotal', ctx)

    expect(ctx.searchMock).toHaveBeenCalled()
    expect(searchLocalPaths).not.toHaveBeenCalled()
  })

  it('forceSource overrides the seam, for tests that want one source only', async () => {
    vi.mocked(groundingIsLocal).mockReturnValue(true)
    const ctx = { ...makeCtx({ paths: ['src/other.ts'], files: { 'src/other.ts': OTHER_TS } }), forceSource: 'provider' as const }

    await searchRepoForSymbol('computeTotal', ctx)

    expect(ctx.searchMock).toHaveBeenCalled()
    expect(searchLocalPaths).not.toHaveBeenCalled()
  })
})
