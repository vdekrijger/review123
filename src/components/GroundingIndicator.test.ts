/**
 * GroundingIndicator tests.
 *
 * The property under test is HONESTY, in both directions: it must never claim
 * local grounding that is not happening, and it must never stay quiet about a
 * fallback a bridge user would otherwise never notice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import GroundingIndicator from './GroundingIndicator.svelte'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetGroundingForTest, noteGroundingFailure } from '../lib/bridge/grounding'
import { BRIDGE_STORAGE_KEY } from '../lib/bridge/storage'
import { PROTOCOL_VERSION } from '../lib/bridge/protocol'

const PR_HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_HEAD = 'def4567890abcdef1234567890abcdef12345678'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const fetchMock = vi.fn()

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function connectWith(git: unknown, capabilities?: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      protocol: PROTOCOL_VERSION,
      root: 'review123',
      capabilities: capabilities ?? { inference: ['claude'], infer: true, files: true, search: true },
      git,
      version: '0.1.0',
    }),
  )
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

describe('GroundingIndicator', () => {
  it('renders NOTHING for a user who has never paired a bridge', () => {
    render(GroundingIndicator, { headSha: PR_HEAD })
    // Telling someone who has never heard of the bridge that they are "falling
    // back" is noise, not honesty.
    expect(screen.queryByTestId('grounding-indicator')).toBeNull()
  })

  it('says LOCAL when the checkout is on this PR', async () => {
    await connectWith({ head: PR_HEAD, branch: 'feat/x', dirty: false })
    render(GroundingIndicator, { headSha: PR_HEAD })

    const el = screen.getByTestId('grounding-indicator')
    expect(el).toHaveAttribute('data-mode', 'local')
    expect(screen.getByTestId('grounding-label')).toHaveTextContent(/local checkout/i)
  })

  it('FLAGS a dirty tree rather than quietly using it', async () => {
    await connectWith({ head: PR_HEAD, branch: 'feat/x', dirty: true })
    render(GroundingIndicator, { headSha: PR_HEAD })

    expect(screen.getByTestId('grounding-indicator')).toHaveAttribute('data-reason', 'local-dirty')
    expect(screen.getByTestId('grounding-label')).toHaveTextContent(/uncommitted changes/i)
    expect(screen.getByTestId('grounding-why')).toHaveTextContent(/in no commit of this PR/i)
  })

  it('names BOTH shas and the branch on a mismatch', async () => {
    await connectWith({ head: OTHER_HEAD, branch: 'main', dirty: false })
    render(GroundingIndicator, { headSha: PR_HEAD })

    const el = screen.getByTestId('grounding-indicator')
    expect(el).toHaveAttribute('data-mode', 'github')
    expect(el).toHaveAttribute('data-reason', 'head-mismatch')
    const why = screen.getByTestId('grounding-why')
    expect(why).toHaveTextContent('main')
    expect(why).toHaveTextContent('def4567')
    expect(why).toHaveTextContent('abc1234')
  })

  it('explains a bridge serving a directory that is not a repo', async () => {
    await connectWith(null)
    render(GroundingIndicator, { headSha: PR_HEAD })

    expect(screen.getByTestId('grounding-indicator')).toHaveAttribute('data-reason', 'no-repo-state')
    expect(screen.getByTestId('grounding-why')).toHaveTextContent(/not serving a git repository/i)
  })

  it('tells a user on an OLD bridge to update it', async () => {
    await connectWith(
      { head: PR_HEAD, branch: 'main', dirty: false },
      { inference: ['claude'], infer: true, files: false, search: false },
    )
    render(GroundingIndicator, { headSha: PR_HEAD })

    expect(screen.getByTestId('grounding-indicator')).toHaveAttribute('data-reason', 'route-missing')
    expect(screen.getByTestId('grounding-why')).toHaveTextContent(/too old to serve files/i)
  })

  it('reports a mid-review fallback instead of still claiming local', async () => {
    await connectWith({ head: PR_HEAD, branch: 'main', dirty: false })
    noteGroundingFailure(PR_HEAD)

    render(GroundingIndicator, { headSha: PR_HEAD })

    const el = screen.getByTestId('grounding-indicator')
    expect(el).toHaveAttribute('data-mode', 'github')
    expect(el).toHaveAttribute('data-reason', 'call-failed')
    expect(screen.getByTestId('grounding-why')).toHaveTextContent(/stopped answering/i)
  })
})
