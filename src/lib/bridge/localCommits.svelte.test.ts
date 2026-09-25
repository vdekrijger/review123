/**
 * localCommits.svelte.test.ts — the containment cache, and the three states it
 * must never collapse.
 *
 * The one that matters: `null` is NOT `false`. An older bridge, a probe still
 * in flight and a refused request all leave the answer unknown, and a caller
 * that read unknown as "you do not have that commit" would turn the fix loop
 * off for everybody on an older bridge instead of leaving it exactly as it was.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _resetLocalCommitsForTest,
  canProbeCommits,
  commitPresence,
  ensureLocalCommits,
  forgetAbsentCommits,
  refreshLocalCommits,
} from './localCommits.svelte'
import { _resetBridgeForTest, connectBridge } from './bridge.svelte'
import { BRIDGE_STORAGE_KEY } from './storage'
import { MAX_COMMIT_PROBE_SHAS, PROTOCOL_VERSION, type BridgeCapabilities } from './protocol'
import { currentFixReadiness } from './fixLoop'

const PR_HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_HEAD = 'def4567890abcdef1234567890abcdef12345678'
const THIRD_HEAD = '1111111111111111111111111111111111111111'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const CAPS: BridgeCapabilities = {
  inference: ['claude'],
  infer: true,
  inferStream: true,
  inferAgentic: true,
  files: true,
  search: true,
  commits: true,
  fix: true,
  checkout: false,
  push: false,
}

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function healthBody(
  capabilities: BridgeCapabilities = CAPS,
  git: unknown = { head: OTHER_HEAD, branch: 'main', dirty: false },
  root = 'review123',
) {
  return { ok: true, protocol: PROTOCOL_VERSION, root, capabilities, git, version: '0.5.0' }
}

/** Pair a bridge whose checkout is deliberately NOT on the PR head. */
async function connect(
  capabilities: BridgeCapabilities = CAPS,
  git: unknown = { head: OTHER_HEAD, branch: 'main', dirty: false },
  root = 'review123',
) {
  fetchMock.mockResolvedValueOnce(jsonResponse(healthBody(capabilities, git, root)))
  await connectBridge(TOKEN, 7321)
}

/** The body of the last `/v1/commits` POST, parsed. */
function lastProbeBody(): { shas: string[] } {
  const calls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/v1/commits'))
  const init = calls[calls.length - 1]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body ?? '{}')) as { shas: string[] }
}

function probeCount(): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/v1/commits')).length
}

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  _resetLocalCommitsForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
})

describe('commitPresence', () => {
  it('is null before anything has been asked', async () => {
    await connect()
    expect(commitPresence(PR_HEAD)).toBeNull()
  })

  it('is true for a commit the bridge says it has, on a checkout sitting elsewhere', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD] }))
    await ensureLocalCommits([PR_HEAD])
    expect(commitPresence(PR_HEAD)).toBe(true)
  })

  it('is FALSE — not null — for a commit the bridge answered about and does not have', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [] }))
    await ensureLocalCommits([PR_HEAD])
    expect(commitPresence(PR_HEAD)).toBe(false)
  })

  it('is case-insensitive, because GitHub hands out both spellings', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD] }))
    await ensureLocalCommits([PR_HEAD.toUpperCase()])
    expect(commitPresence(PR_HEAD.toUpperCase())).toBe(true)
    expect(commitPresence(PR_HEAD)).toBe(true)
  })
})

describe('what is NOT an answer', () => {
  it('stays null with nothing paired, and sends nothing', async () => {
    await ensureLocalCommits([PR_HEAD])
    expect(probeCount()).toBe(0)
    expect(commitPresence(PR_HEAD)).toBeNull()
  })

  it('stays null on a bridge that predates the route, and never calls it', async () => {
    await connect({ ...CAPS, commits: false })
    expect(canProbeCommits()).toBe(false)
    await ensureLocalCommits([PR_HEAD])
    expect(probeCount()).toBe(0)
    expect(commitPresence(PR_HEAD)).toBeNull()
  })

  it('stays null when the route 404s — an older bridge that lied about the flag', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'not-found' }, 404))
    await ensureLocalCommits([PR_HEAD])
    expect(commitPresence(PR_HEAD)).toBeNull()
  })

  it('stays null when the bridge is unreachable', async () => {
    await connect()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await ensureLocalCommits([PR_HEAD])
    expect(commitPresence(PR_HEAD)).toBeNull()
  })

  it('stays null on a body this build cannot read', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: 'all of them' }))
    await ensureLocalCommits([PR_HEAD])
    expect(commitPresence(PR_HEAD)).toBeNull()
  })
})

describe('what it sends', () => {
  it('asks about every sha in one request, not one request per row', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD, THIRD_HEAD] }))
    await ensureLocalCommits([PR_HEAD, OTHER_HEAD, THIRD_HEAD])
    expect(probeCount()).toBe(1)
    expect(lastProbeBody().shas).toEqual([PR_HEAD, OTHER_HEAD, THIRD_HEAD])
    expect(commitPresence(PR_HEAD)).toBe(true)
    expect(commitPresence(OTHER_HEAD)).toBe(false)
    expect(commitPresence(THIRD_HEAD)).toBe(true)
  })

  it('does not ask twice about the same commit', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD] }))
    await ensureLocalCommits([PR_HEAD])
    await ensureLocalCommits([PR_HEAD])
    expect(probeCount()).toBe(1)
  })

  it('drops anything that is not a full sha, rather than sending it to git', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [] }))
    await ensureLocalCommits(['', 'abc1234', 'refs/heads/main', PR_HEAD])
    expect(lastProbeBody().shas).toEqual([PR_HEAD])
  })

  it('sends nothing at all when every sha is malformed', async () => {
    await connect()
    await ensureLocalCommits(['abc1234'])
    expect(probeCount()).toBe(0)
  })

  it(`never sends more than ${MAX_COMMIT_PROBE_SHAS} at once`, async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [] }))
    const many = Array.from({ length: MAX_COMMIT_PROBE_SHAS + 10 }, (_, i) =>
      i.toString(16).padStart(40, '0'),
    )
    await ensureLocalCommits(many)
    expect(lastProbeBody().shas).toHaveLength(MAX_COMMIT_PROBE_SHAS)
  })

  it('refreshLocalCommits asks again, so a fetch in the user’s terminal is noticed', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [] }))
    await ensureLocalCommits([PR_HEAD])
    expect(commitPresence(PR_HEAD)).toBe(false)

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD] }))
    await refreshLocalCommits([PR_HEAD])
    expect(probeCount()).toBe(2)
    expect(commitPresence(PR_HEAD)).toBe(true)
  })

  it('forgetAbsentCommits drops the noes and keeps the yeses', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD] }))
    await ensureLocalCommits([PR_HEAD, THIRD_HEAD])
    expect(commitPresence(PR_HEAD)).toBe(true)
    expect(commitPresence(THIRD_HEAD)).toBe(false)

    forgetAbsentCommits()
    expect(commitPresence(PR_HEAD)).toBe(true)
    expect(commitPresence(THIRD_HEAD)).toBeNull()
  })
})

describe('the cache belongs to ONE repository', () => {
  it('forgets everything when a different checkout is paired', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD] }))
    await ensureLocalCommits([PR_HEAD])
    expect(commitPresence(PR_HEAD)).toBe(true)

    // A second bridge, a different repo. A cached "yes" from the first one
    // would be a confident wrong answer about the second.
    await connect(CAPS, { head: OTHER_HEAD, branch: 'main', dirty: false }, 'some-other-repo')
    expect(commitPresence(PR_HEAD)).toBeNull()
  })
})

describe('what the readiness rule does with it', () => {
  it('goes from head-mismatch to READY once the probe answers, with HEAD unmoved', async () => {
    // The checkout is on OTHER_HEAD throughout — nothing about it moves.
    await connect()
    expect(currentFixReadiness(PR_HEAD).reason).toBe('head-mismatch')

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [PR_HEAD] }))
    await ensureLocalCommits([PR_HEAD])

    expect(currentFixReadiness(PR_HEAD)).toMatchObject({ ready: true, reason: 'ready' })
  })

  it('turns an answered absence into head-unfetched, not head-mismatch', async () => {
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: [] }))
    await ensureLocalCommits([PR_HEAD])
    expect(currentFixReadiness(PR_HEAD).reason).toBe('head-unfetched')
  })

  it('offers EVERY row of a queue whose commits are all here — not just one', async () => {
    const heads = [PR_HEAD, THIRD_HEAD, '2'.repeat(40), '3'.repeat(40)]
    await connect()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, present: heads }))
    await ensureLocalCommits(heads)
    // The old rule could say yes to at most one of these, because a checkout
    // sits on one commit at a time — and it is on none of them here.
    expect(heads.map((h) => currentFixReadiness(h).ready)).toEqual([true, true, true, true])
  })
})
