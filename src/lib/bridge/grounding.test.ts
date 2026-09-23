/**
 * grounding.test.ts — the rule that keeps local grounding honest.
 *
 * The decision function gets the most attention here, and deliberately so: it
 * is the one piece of code standing between "reviews read your working tree"
 * and "reviews confidently cite line numbers from a file the PR never
 * touched". Every branch of it is pinned, including the ones that look
 * obviously safe.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  _resetGroundingForTest,
  currentGrounding,
  decideGrounding,
  describeGrounding,
  findLocalReferences,
  groundingIsLocal,
  noteGroundingFailure,
  readLocalFile,
  readLocalFiles,
  searchLocal,
  searchLocalCode,
  searchLocalPaths,
  short,
  type BridgeSnapshot,
} from './grounding'
import { _resetBridgeForTest, connectBridge } from './bridge.svelte'
import { BRIDGE_STORAGE_KEY } from './storage'
import { PROTOCOL_VERSION, type BridgeCapabilities } from './protocol'

const PR_HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_HEAD = 'def4567890abcdef1234567890abcdef12345678'
const TOKEN = 'pairing-token-0000000000000000000000000000'

// `fix: false` and `checkout: false` — grounding is a READ feature and needs
// neither write grant. Pinning both false here is the assertion that it never
// started to: a grounding decision must never depend on the user having handed
// the bridge permission to write or to move their branch.
const ALL_READY: BridgeCapabilities = {
  inference: ['claude'],
  infer: true,
  inferStream: true,
  inferAgentic: true,
  files: true,
  search: true,
  fix: false,
  checkout: false,
}

function snapshot(overrides: Partial<BridgeSnapshot> = {}): BridgeSnapshot {
  return {
    connected: true,
    capabilities: ALL_READY,
    git: { head: PR_HEAD, branch: 'main', dirty: false },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe('decideGrounding', () => {
  it('uses LOCAL when the head matches and the tree is clean', () => {
    const status = decideGrounding(snapshot(), PR_HEAD)
    expect(status.mode).toBe('local')
    expect(status.reason).toBe('local-clean')
    expect(status.dirty).toBe(false)
  })

  it('uses LOCAL when the head matches and the tree is DIRTY, and says so', () => {
    const status = decideGrounding(
      snapshot({ git: { head: PR_HEAD, branch: 'feat/x', dirty: true } }),
      PR_HEAD,
    )
    expect(status.mode).toBe('local')
    expect(status.reason).toBe('local-dirty')
    expect(status.dirty).toBe(true)
  })

  it('REFUSES local when the head does not match — the whole point', () => {
    const status = decideGrounding(
      snapshot({ git: { head: OTHER_HEAD, branch: 'main', dirty: false } }),
      PR_HEAD,
    )
    expect(status.mode).toBe('github')
    expect(status.reason).toBe('head-mismatch')
  })

  it('refuses a PREFIX match — a short sha is not the same commit', () => {
    const status = decideGrounding(
      snapshot({ git: { head: PR_HEAD, branch: 'main', dirty: false } }),
      PR_HEAD.slice(0, 7),
    )
    expect(status.mode).toBe('github')
    expect(status.reason).toBe('head-mismatch')
  })

  it('matches case-insensitively — a sha is hex, not a password', () => {
    const status = decideGrounding(snapshot(), PR_HEAD.toUpperCase())
    expect(status.mode).toBe('local')
  })

  it('refuses local with no bridge connected', () => {
    const status = decideGrounding(snapshot({ connected: false }), PR_HEAD)
    expect(status.mode).toBe('github')
    expect(status.reason).toBe('no-bridge')
  })

  it('refuses local when capabilities are unknown', () => {
    const status = decideGrounding(snapshot({ capabilities: null }), PR_HEAD)
    expect(status.reason).toBe('no-bridge')
  })

  it.each([
    ['files', { ...ALL_READY, files: false }],
    ['search', { ...ALL_READY, search: false }],
    ['both', { ...ALL_READY, files: false, search: false }],
  ])('refuses local when the %s route is not ready', (_label, capabilities) => {
    const status = decideGrounding(snapshot({ capabilities }), PR_HEAD)
    expect(status.mode).toBe('github')
    expect(status.reason).toBe('route-missing')
  })

  it('refuses local when the bridge has NO repo state — null is not a match', () => {
    const status = decideGrounding(snapshot({ git: null }), PR_HEAD)
    expect(status.mode).toBe('github')
    expect(status.reason).toBe('no-repo-state')
  })

  it('still uses local on a DETACHED head when the sha matches', () => {
    const status = decideGrounding(
      snapshot({ git: { head: PR_HEAD, branch: null, dirty: false } }),
      PR_HEAD,
    )
    expect(status.mode).toBe('local')
    expect(status.branch).toBeNull()
  })

  it('never reports dirty on a github decision — there is no tree in use to be dirty', () => {
    const status = decideGrounding(
      snapshot({ git: { head: OTHER_HEAD, branch: 'main', dirty: true } }),
      PR_HEAD,
    )
    expect(status.dirty).toBe(false)
  })

  it('carries both shas so the UI can name them without re-deriving anything', () => {
    const status = decideGrounding(
      snapshot({ git: { head: OTHER_HEAD, branch: 'main', dirty: false } }),
      PR_HEAD,
    )
    expect(status.bridgeHead).toBe(OTHER_HEAD)
    expect(status.prHead).toBe(PR_HEAD)
  })
})

describe('describeGrounding', () => {
  it('names BOTH shas and the branch on a mismatch', () => {
    const text = describeGrounding(
      decideGrounding(snapshot({ git: { head: OTHER_HEAD, branch: 'main', dirty: false } }), PR_HEAD),
    )
    expect(text).toContain('main')
    expect(text).toContain(short(OTHER_HEAD))
    expect(text).toContain(short(PR_HEAD))
  })

  it('omits the branch, not the shas, on a detached mismatch', () => {
    const text = describeGrounding(
      decideGrounding(snapshot({ git: { head: OTHER_HEAD, branch: null, dirty: false } }), PR_HEAD),
    )
    expect(text).toContain(short(OTHER_HEAD))
    expect(text).toContain(short(PR_HEAD))
  })

  it('warns about uncommitted code on a dirty local tree', () => {
    const text = describeGrounding(
      decideGrounding(snapshot({ git: { head: PR_HEAD, branch: 'm', dirty: true } }), PR_HEAD),
    )
    expect(text).toMatch(/uncommitted/i)
  })

  it('has a distinct sentence for every reason — no generic fallthrough', () => {
    const reasons = [
      decideGrounding(snapshot(), PR_HEAD),
      decideGrounding(snapshot({ git: { head: PR_HEAD, branch: 'm', dirty: true } }), PR_HEAD),
      decideGrounding(snapshot({ connected: false }), PR_HEAD),
      decideGrounding(snapshot({ capabilities: { ...ALL_READY, files: false } }), PR_HEAD),
      decideGrounding(snapshot({ git: null }), PR_HEAD),
      decideGrounding(snapshot({ git: { head: OTHER_HEAD, branch: 'm', dirty: false } }), PR_HEAD),
    ].map(describeGrounding)
    expect(new Set(reasons).size).toBe(reasons.length)
    for (const text of reasons) expect(text.length).toBeGreaterThan(20)
  })

  it('short() says "unknown" rather than crashing on a null sha', () => {
    expect(short(null)).toBe('unknown')
    expect(short(PR_HEAD)).toBe('abc1234')
  })
})

// ---------------------------------------------------------------------------
// The live decision, the failure latch, and the calls
// ---------------------------------------------------------------------------

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function healthBody(git: unknown = { head: PR_HEAD, branch: 'main', dirty: false }) {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    root: 'review123',
    capabilities: ALL_READY,
    git,
    version: '0.1.0',
  }
}

/** Pair a bridge whose health says whatever `git` says. */
async function connectWith(git: unknown = { head: PR_HEAD, branch: 'main', dirty: false }) {
  fetchMock.mockResolvedValueOnce(jsonResponse(healthBody(git)))
  await connectBridge(TOKEN, 7321)
}

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  _resetGroundingForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
})

describe('currentGrounding — against the live store', () => {
  it('is github with nothing paired', () => {
    expect(currentGrounding(PR_HEAD).reason).toBe('no-bridge')
    expect(groundingIsLocal(PR_HEAD)).toBe(false)
  })

  it('is local once a matching bridge is connected', async () => {
    await connectWith()
    expect(groundingIsLocal(PR_HEAD)).toBe(true)
  })

  it('is github for a DIFFERENT PR on the same connected bridge', async () => {
    await connectWith()
    expect(groundingIsLocal(OTHER_HEAD)).toBe(false)
    expect(currentGrounding(OTHER_HEAD).reason).toBe('head-mismatch')
  })
})

describe('the mid-review failure latch', () => {
  it('flips a matching head to github once a call has failed', async () => {
    await connectWith()
    expect(groundingIsLocal(PR_HEAD)).toBe(true)

    noteGroundingFailure(PR_HEAD)

    const status = currentGrounding(PR_HEAD)
    expect(status.mode).toBe('github')
    expect(status.reason).toBe('call-failed')
    expect(describeGrounding(status)).toMatch(/stopped answering/i)
  })

  it('is idempotent', async () => {
    await connectWith()
    noteGroundingFailure(PR_HEAD)
    noteGroundingFailure(PR_HEAD)
    expect(currentGrounding(PR_HEAD).reason).toBe('call-failed')
  })

  it('is keyed by HEAD, so one PR failing does not disable the bridge for another', async () => {
    await connectWith({ head: PR_HEAD, branch: 'main', dirty: false })
    noteGroundingFailure(OTHER_HEAD)
    // The failure was recorded against a head this bridge is not on; the
    // matching PR is untouched.
    expect(groundingIsLocal(PR_HEAD)).toBe(true)
  })

  it('does not manufacture a local claim for a head that never matched', () => {
    noteGroundingFailure(PR_HEAD)
    expect(currentGrounding(PR_HEAD).reason).toBe('no-bridge')
  })
})

describe('readLocalFiles', () => {
  beforeEach(async () => {
    await connectWith()
  })

  function filesResponse(body: unknown) {
    fetchMock.mockResolvedValueOnce(jsonResponse(body))
  }

  it('sends the paths and returns their content', async () => {
    filesResponse({
      ok: true,
      files: [{ path: 'a.ts', bytes: 3, truncated: false, content: 'abc', encoding: 'utf-8' }],
      missing: [],
      skipped: [],
    })
    const map = await readLocalFiles(PR_HEAD, ['a.ts'])
    expect(map.get('a.ts')).toBe('abc')

    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(String(url)).toContain('/v1/files')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ paths: ['a.ts'] })
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
  })

  it('maps a MISSING path to null, not to an error', async () => {
    filesResponse({ ok: true, files: [], missing: ['gone.ts'], skipped: [] })
    expect((await readLocalFiles(PR_HEAD, ['gone.ts'])).get('gone.ts')).toBeNull()
  })

  it('maps a SKIPPED (binary) path to null', async () => {
    filesResponse({ ok: true, files: [], missing: [], skipped: [{ path: 'x.png', reason: 'binary' }] })
    expect((await readLocalFiles(PR_HEAD, ['x.png'])).get('x.png')).toBeNull()
  })

  it('returns an entry for EVERY requested path, even one the bridge ignored', async () => {
    filesResponse({ ok: true, files: [], missing: [], skipped: [] })
    const map = await readLocalFiles(PR_HEAD, ['a.ts', 'b.ts'])
    expect(map.has('a.ts')).toBe(true)
    expect(map.has('b.ts')).toBe(true)
  })

  it('caches, so a second read of the same file makes no second call', async () => {
    filesResponse({
      ok: true,
      files: [{ path: 'a.ts', bytes: 3, truncated: false, content: 'abc', encoding: 'utf-8' }],
      missing: [],
      skipped: [],
    })
    await readLocalFiles(PR_HEAD, ['a.ts'])
    const after = fetchMock.mock.calls.length
    expect(await readLocalFile(PR_HEAD, 'a.ts')).toBe('abc')
    expect(fetchMock.mock.calls.length).toBe(after)
  })

  it('caches a MISS too, so a deleted file is not re-requested per task', async () => {
    filesResponse({ ok: true, files: [], missing: ['gone.ts'], skipped: [] })
    await readLocalFiles(PR_HEAD, ['gone.ts'])
    const after = fetchMock.mock.calls.length
    await readLocalFiles(PR_HEAD, ['gone.ts'])
    expect(fetchMock.mock.calls.length).toBe(after)
  })

  it('shares ONE in-flight call between two concurrent readers', async () => {
    filesResponse({
      ok: true,
      files: [{ path: 'a.ts', bytes: 1, truncated: false, content: 'x', encoding: 'utf-8' }],
      missing: [],
      skipped: [],
    })
    const [one, two] = await Promise.all([
      readLocalFiles(PR_HEAD, ['a.ts']),
      readLocalFiles(PR_HEAD, ['a.ts']),
    ])
    expect(one.get('a.ts')).toBe('x')
    expect(two.get('a.ts')).toBe('x')
    // One health call (from connectWith) plus exactly one /v1/files call.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/v1/files'))).toHaveLength(1)
  })

  it('keys the cache by HEAD, so a second PR never reads the first one’s contents', async () => {
    filesResponse({
      ok: true,
      files: [{ path: 'a.ts', bytes: 3, truncated: false, content: 'old', encoding: 'utf-8' }],
      missing: [],
      skipped: [],
    })
    await readLocalFiles(PR_HEAD, ['a.ts'])
    filesResponse({
      ok: true,
      files: [{ path: 'a.ts', bytes: 3, truncated: false, content: 'new', encoding: 'utf-8' }],
      missing: [],
      skipped: [],
    })
    expect((await readLocalFiles(OTHER_HEAD, ['a.ts'])).get('a.ts')).toBe('new')
  })

  it('THROWS when the bridge does not answer, so the caller can fall back', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(readLocalFiles(PR_HEAD, ['a.ts'])).rejects.toThrow(/did not answer/i)
  })

  it('THROWS on a non-2xx rather than reporting the files as missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'forbidden-path', message: 'no' }, 403))
    await expect(readLocalFiles(PR_HEAD, ['../x'])).rejects.toThrow(/403/)
  })

  it('THROWS on a malformed body rather than inventing an empty answer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, files: 'not an array' }))
    await expect(readLocalFiles(PR_HEAD, ['a.ts'])).rejects.toThrow(/malformed/i)
  })
})

describe('search', () => {
  beforeEach(async () => {
    await connectWith()
  })

  const MATCHES = [
    { path: 'src/a.ts', line: 1, column: 5, preview: 'const target = 1' },
    { path: 'src/a.ts', line: 9, column: 3, preview: 'target()' },
    { path: 'src/b.ts', line: 4, column: 1, preview: 'import { target }' },
  ]

  function searchResponse(matches = MATCHES, truncated = false) {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, matches, truncated }))
  }

  it('posts the query and returns the matches', async () => {
    searchResponse()
    const result = await searchLocal('target')
    expect(result.matches).toHaveLength(3)
    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(String(url)).toContain('/v1/search')
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ query: 'target' })
  })

  it('searchLocalPaths dedupes to files and ranks by match count', async () => {
    searchResponse()
    expect(await searchLocalPaths('target')).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('searchLocalCode groups by file and cites path:line on every quoted hit', async () => {
    searchResponse()
    const text = await searchLocalCode('target')
    expect(text).toContain('## src/a.ts')
    expect(text).toContain('src/a.ts:1:')
    expect(text).toContain('src/a.ts:9:')
    expect(text).toMatch(/local checkout/i)
  })

  it('searchLocalCode says so plainly when nothing matched', async () => {
    searchResponse([])
    expect(await searchLocalCode('nope')).toBe('No matches found.')
  })

  it('marks a truncated result set so the model knows there may be more', async () => {
    searchResponse(MATCHES, true)
    expect(await searchLocalCode('target')).toContain('3+ match')
  })

  it('findLocalReferences asks for a WORD-BOUNDARY regex, not a substring', async () => {
    searchResponse()
    await findLocalReferences('config')
    const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body))
    expect(body.regex).toBe(true)
    expect(body.query).toContain('config')
    // The pattern must not match `configure` — prove it, rather than trusting
    // the string looks right.
    const re = new RegExp(body.query)
    expect(re.test('a config b')).toBe(true)
    expect(re.test('configure()')).toBe(false)
  })

  it('findLocalReferences escapes regex metacharacters in the symbol', async () => {
    searchResponse()
    await findLocalReferences('a.b')
    const body = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body))
    const re = new RegExp(body.query)
    expect(re.test(' a.b ')).toBe(true)
    expect(re.test(' axb ')).toBe(false)
  })

  it('findLocalReferences names the symbol when there is nothing to find', async () => {
    searchResponse([])
    expect(await findLocalReferences('ghost')).toMatch(/no references to "ghost"/i)
  })

  it('THROWS when the bridge stops answering, so the caller can fall back', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(searchLocal('target')).rejects.toThrow(/did not answer/i)
  })
})
