/**
 * AgentFixPanel — the fix loop's analytics.
 *
 * The fix loop is the most expensive action in the product: it spends a slice
 * of the user's CLI subscription and runs for minutes. #243 shipped it with no
 * telemetry at all (the event union was outside that PR's fence), so nobody
 * could tell whether it was used, whether it worked, or why it stopped.
 *
 * What these tests pin is the SHAPE of that telemetry, and the fact that it is
 * only a shape: counts and fixed enums, never a finding, a path, a commit, an
 * intent sentence, a diff, or a test command's output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AgentFixPanel, { type FixCandidateEntry } from './AgentFixPanel.svelte'
import { track, _setCaptureForTest } from '../lib/analytics/analytics'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetStackForTest } from '../lib/bridge/runPr.svelte'
import { BRIDGE_STORAGE_KEY } from '../lib/bridge/storage'
import { PROTOCOL_VERSION } from '../lib/bridge/protocol'

const HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const fetchMock = vi.fn()
const captured: { event: string; props: Record<string, unknown> }[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Pair a write-enabled bridge sitting on this PR's head — the ready case. */
async function connectReadyBridge(): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    json({
      ok: true,
      protocol: PROTOCOL_VERSION,
      root: 'review123',
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, fix: true },
      git: { head: HEAD, branch: 'feat/x', dirty: false },
      version: '0.1.0',
    }),
  )
  await connectBridge(TOKEN, 7321)
}

function candidate(key: string): FixCandidateEntry {
  return {
    key,
    skillName: 'Security Reviewer',
    path: 'src/secret.ts',
    line: 12,
    severity: 'high',
    body: 'Unescaped user input reaches the DOM',
    suggestedFix: 'Escape it with textContent.',
  }
}

/** A `/v1/fix` answer with one green commit and one skipped finding. */
function fixResponse(): unknown {
  return {
    ok: true,
    cli: 'claude',
    baseSha: HEAD,
    branch: 'review123/fix/abc',
    changes: [
      {
        findingId: 'f1',
        commit: '1'.repeat(40),
        subject: 'escape user input',
        intent: 'Agent intent 1',
        files: ['src/secret.ts'],
        diff: '--- a\n+++ b\n+new 0',
        truncated: false,
        rounds: 1,
        stopReason: 'all-addressed',
        tests: { status: 'passed', command: 'pnpm test', durationMs: 900, output: '1 passing' },
      },
    ],
    skipped: [{ findingId: 'f2', reason: 'refused', detail: 'the agent disagreed' }],
    rounds: 2,
    stopReason: 'round-cap',
    tests: { status: 'passed', command: 'pnpm test', durationMs: 900, output: '1 passing' },
    durationMs: 4200,
  }
}

function eventsNamed(name: string): Record<string, unknown>[] {
  return captured.filter((c) => c.event === name).map((c) => c.props)
}

/** The `/v1/stack` answer the panel probes for on mount. */
function stackBody(): unknown {
  return {
    ok: true,
    git: { head: HEAD, branch: 'feat/x', dirty: false },
    dirtyPaths: [],
    dirtyCount: 0,
    prior: null,
    app: { url: null, source: 'unknown', reachable: false, detail: '' },
    checkoutEnabled: false,
  }
}

/**
 * Answers for `/v1/fix`, in order.
 *
 * The panel probes `/v1/stack` on mount (the head its refusal rests on must be
 * fresh, not from page load), so a bare `mockResolvedValueOnce` queue would
 * hand the probe the answer meant for the fix run. Routing by URL keeps each
 * test's intent where it belongs: this queue is only ever the fix route's.
 */
const fixQueue: ((url: string, init: RequestInit) => Promise<Response>)[] = []

function queueFix(fn: (url: string, init: RequestInit) => Promise<Response> | Response): void {
  fixQueue.push(async (url, init) => fn(url, init))
}

beforeEach(async () => {
  localStorage.clear()
  captured.length = 0
  fixQueue.length = 0
  _resetBridgeForTest()
  _resetStackForTest()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    const target = String(url)
    if (target.endsWith('/v1/stack')) return Promise.resolve(json(stackBody()))
    const next = fixQueue.shift()
    if (next !== undefined) return next(target, init)
    return Promise.reject(new TypeError('Failed to fetch'))
  })
  vi.stubGlobal('fetch', fetchMock)
  _setCaptureForTest((event, props) => captured.push({ event, props }))
  await connectReadyBridge()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
})

describe('AgentFixPanel analytics', () => {
  it('reports a dispatched batch as a COUNT and a CLI, and nothing else', async () => {
    queueFix(() => json(fixResponse()))
    render(AgentFixPanel, { headSha: HEAD, candidates: [candidate('f1'), candidate('f2')] })

    await userEvent.click(screen.getByTestId('agent-fix-send'))

    const dispatched = eventsNamed('bridge_fix_dispatched')
    expect(dispatched).toHaveLength(1)
    // `round` joined the payload with the bounded loop: an integer counter over
    // an app-owned loop, so that a loop's cost is distinguishable from somebody
    // clicking send five times. Still counts and enums, still nothing else.
    // `notes` joined the payload with the reviewer's own drafted comments: how
    // many of the batch were the user's own words rather than a model's. It is
    // present at 0 rather than omitted, so "nobody sends their own notes" and
    // "this build does not report it" stay distinguishable.
    expect(dispatched[0]).toEqual({ findings: 2, cli: 'claude', round: 1, notes: 0 })
  })

  it('reports the outcome as counts + enums — no commit, intent, path or diff', async () => {
    queueFix(() => json(fixResponse()))
    render(AgentFixPanel, { headSha: HEAD, candidates: [candidate('f1'), candidate('f2')] })

    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    const settled = eventsNamed('bridge_fix_settled')
    expect(settled).toHaveLength(1)
    const props = settled[0]!
    expect(props).toMatchObject({
      outcome: 'done',
      changes: 1,
      skipped: 1,
      stop_reason: 'round-cap',
      tests_passed: 1,
      tests_failed: 0,
    })
    expect(typeof props['duration_ms']).toBe('number')
    // The whole payload, stringified, must not carry a single thing the agent
    // or the reviewer actually said.
    const blob = JSON.stringify(props)
    for (const leak of ['Agent intent', 'src/secret.ts', '111111', 'pnpm test', 'Unescaped']) {
      expect(blob).not.toContain(leak)
    }
  })

  it('reports a FAILED run with its classified kind, never the bridge’s own words', async () => {
    queueFix(() =>
      json({ ok: false, error: 'write-disabled', message: 'start me with --allow-write, /Users/someone/repo' }, 403),
    )
    render(AgentFixPanel, { headSha: HEAD, candidates: [candidate('f1')] })

    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-error')

    const settled = eventsNamed('bridge_fix_settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ outcome: 'failed', failure: 'write-disabled' })
    expect(JSON.stringify(settled[0])).not.toContain('/Users/someone')
  })

  it('does not report a user cancellation as a failure', async () => {
    queueFix(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    render(AgentFixPanel, { headSha: HEAD, candidates: [candidate('f1')] })

    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await userEvent.click(await screen.findByTestId('agent-fix-cancel'))

    const settled = eventsNamed('bridge_fix_settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ outcome: 'cancelled' })
    expect(settled[0]).not.toHaveProperty('failure')
  })

  // Defense in depth: the guarantee is the choke-point, not the call site.
  it('strips anything that is not on the allowlist, however it got there', () => {
    track('bridge_fix_dispatched', {
      findings: 3,
      cli: 'codex',
      path: 'src/secret.ts',
      body: 'Unescaped user input reaches the DOM',
      suggestedFix: 'Escape it with textContent.',
    } as never)
    track('bridge_fix_settled', {
      outcome: 'done',
      changes: 1,
      diff: '--- a\n+++ b',
      commit: '1'.repeat(40),
      intent: 'Agent intent 1',
    } as never)

    expect(eventsNamed('bridge_fix_dispatched')[0]).toEqual({ findings: 3, cli: 'codex' })
    expect(eventsNamed('bridge_fix_settled')[0]).toEqual({ outcome: 'done', changes: 1 })
  })
})
