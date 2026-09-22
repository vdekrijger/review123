/**
 * BridgeSection.test.ts — the Local bridge settings surface.
 *
 * Covers the states a user can actually be in: never paired (and therefore
 * silent), paired-but-the-bridge-isn't-running, connected, and a failed
 * connect attempt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import BridgeSection from './BridgeSection.svelte'
import { BRIDGE_STORAGE_KEY, _resetBridgeForTest } from '../../lib/bridge/bridge.svelte'
import { PROTOCOL_VERSION } from '../../lib/bridge/protocol'
import { _setCaptureForTest } from '../../lib/analytics/analytics'

const TOKEN = 'pairing-token-0000000000000000000000000000'

function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    root: 'review123',
    capabilities: { inference: ['claude', 'codex'], infer: true, files: true, search: true },
    git: { head: HEAD_SHA, branch: 'main', dirty: false },
    version: '0.1.0',
    ...overrides,
  }
}

/** A plausible 40-hex commit id for the health fixtures. */
const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  _setCaptureForTest(() => {})
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BridgeSection — never paired', () => {
  it('renders as a settings region with the section heading', () => {
    render(BridgeSection)
    expect(screen.getByRole('region', { name: /local bridge/i })).toBeInTheDocument()
  })

  it('shows "Not connected"', () => {
    render(BridgeSection)
    expect(screen.getByTestId('bridge-status')).toHaveTextContent(/not connected/i)
  })

  it('makes NO request on mount', async () => {
    render(BridgeSection)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains plainly what pairing grants', () => {
    render(BridgeSection)
    const section = screen.getByRole('region', { name: /local bridge/i })
    expect(section).toHaveTextContent(/read access to that repo/i)
    expect(section).toHaveTextContent(/127\.0\.0\.1/)
    expect(section).toHaveTextContent(/with no bridge, review123 works exactly as it does today/i)
  })

  it('offers a token field and a Connect button', () => {
    render(BridgeSection)
    expect(screen.getByLabelText(/bridge pairing token/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument()
  })

  it('masks the token field by default', () => {
    render(BridgeSection)
    expect(screen.getByLabelText(/bridge pairing token/i)).toHaveAttribute('type', 'password')
  })

  // The install copy is the whole point of shipping a prebuilt artifact: the
  // primary route must be a command you can paste, not "clone the repo".
  it('leads with the one-line download, not the checkout', () => {
    render(BridgeSection)
    const install = screen.getByTestId('bridge-install')
    expect(install).toHaveTextContent(
      'curl -fsSL https://github.com/vdekrijger/review123/releases/latest/download/bridge.mjs -o ~/review123-bridge.mjs',
    )
    expect(install).toHaveTextContent('node ~/review123-bridge.mjs --root .')
  })

  it('still offers the clone route, and is honest that it is heavy', () => {
    render(BridgeSection)
    const install = screen.getByTestId('bridge-install')
    expect(install).toHaveTextContent(/pnpm bridge/)
    expect(install).toHaveTextContent(/entire dev toolchain/i)
  })

  it('links the bridge docs and the repo on main', () => {
    render(BridgeSection)
    const install = screen.getByTestId('bridge-install')
    expect(within(install).getByRole('link', { name: /bridge\/README\.md/i })).toHaveAttribute(
      'href',
      'https://github.com/vdekrijger/review123/blob/main/bridge/README.md',
    )
    expect(within(install).getByRole('link', { name: /the repo/i })).toHaveAttribute(
      'href',
      'https://github.com/vdekrijger/review123',
    )
  })

  it('keeps saying where the token is stored', () => {
    render(BridgeSection)
    expect(screen.getByTestId('bridge-install')).toHaveTextContent(BRIDGE_STORAGE_KEY)
  })
})

describe('BridgeSection — connecting', () => {
  it('shows the repo and the detected CLIs after a successful connect', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    render(BridgeSection)

    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('bridge-status')).toHaveTextContent(/connected to review123/i)
    })
    expect(screen.getByTestId('bridge-root')).toHaveTextContent('review123')
    expect(screen.getByTestId('bridge-clis')).toHaveTextContent('claude, codex')
  })

  it('swaps the form for a Disconnect button once connected', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    render(BridgeSection)

    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument()
    })
    expect(screen.queryByLabelText(/bridge pairing token/i)).not.toBeInTheDocument()
  })

  /** Pair with a bridge reporting the given health document. */
  async function connectWith(body: Record<string, unknown>): Promise<void> {
    fetchMock.mockResolvedValue(jsonResponse(body))
    render(BridgeSection)
    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => {
      expect(screen.getByTestId('bridge-inference-note')).toBeInTheDocument()
    })
  }

  it('points a ready bridge at the AI models picker', async () => {
    await connectWith(healthBody())
    const note = screen.getByTestId('bridge-inference-note')
    expect(note).toHaveTextContent(/ready to run reviews/i)
    expect(within(note).getByRole('link', { name: /ai models/i })).toHaveAttribute('href', '#ai-models')
  })

  // The section cannot say whether grounding WILL be local — that depends on
  // which PR is open, and none is. So it states the fact (where the checkout
  // is) and the rule (head must match), and lets GroundingIndicator answer the
  // question for a specific PR.
  it('names the checkout the bridge is serving, with the short sha', async () => {
    await connectWith(healthBody())
    const note = screen.getByTestId('bridge-grounding-note')
    expect(note).toHaveTextContent(/checked out at main \(abc1234\)/i)
    expect(note).toHaveTextContent(/whenever a pr's head matches that commit/i)
  })

  // WRITE MODE (#243). `--allow-write` is the entire authorisation model for
  // the fix loop, and it is typed at the terminal — so the settings surface
  // states which mode the user is in and what it permits, rather than leaving
  // them to discover it from a 403 mid-review.
  it('says plainly that the bridge is read-only, and how to change that', async () => {
    await connectWith(healthBody())
    const note = screen.getByTestId('bridge-write-note')
    expect(note).toHaveTextContent(/read-only/i)
    expect(note).toHaveTextContent(/--allow-write/)
    // What it would permit, and what it never touches.
    expect(note).toHaveTextContent(/scratch git worktree/i)
    expect(note).toHaveTextContent(/one commit per finding/i)
    expect(note).toHaveTextContent(/never touched/i)
    expect(note).toHaveTextContent(/nothing is pushed/i)
    // And that no browser affordance can enable it.
    expect(note).toHaveTextContent(/typed at the terminal/i)
  })

  it('says write mode is ON when the bridge reports capabilities.fix', async () => {
    await connectWith(
      healthBody({
        capabilities: { inference: ['claude'], infer: true, files: true, search: true, fix: true },
      }),
    )
    const note = screen.getByTestId('bridge-write-note')
    expect(note).toHaveTextContent(/write mode is on/i)
    expect(note).toHaveTextContent(/--allow-write/)
    expect(note).toHaveTextContent(/scratch git worktree/i)
    expect(note).not.toHaveTextContent(/read-only/i)
  })

  it('says a DIRTY checkout is dirty', async () => {
    await connectWith(healthBody({ git: { head: HEAD_SHA, branch: 'main', dirty: true } }))
    expect(screen.getByTestId('bridge-grounding-note')).toHaveTextContent(/uncommitted changes/i)
  })

  it('names a detached HEAD as such rather than inventing a branch', async () => {
    await connectWith(healthBody({ git: { head: HEAD_SHA, branch: null, dirty: false } }))
    expect(screen.getByTestId('bridge-grounding-note')).toHaveTextContent(/detached head/i)
  })

  it('says plainly when the served directory is not a repo', async () => {
    await connectWith(healthBody({ git: null }))
    expect(screen.getByTestId('bridge-grounding-note')).toHaveTextContent(
      /not a git repository.*read code from github/i,
    )
  })

  it('tells the user to update a bridge with no grounding routes', async () => {
    await connectWith(
      healthBody({ capabilities: { inference: ['claude'], infer: true, files: false, search: false } }),
    )
    expect(screen.getByTestId('bridge-grounding-note')).toHaveTextContent(
      /too old to serve repo files/i,
    )
  })

  it('says a bridge with no CLI on its PATH cannot run reviews yet', async () => {
    await connectWith(healthBody({ capabilities: { inference: [], infer: true, files: false, search: false } }))
    expect(screen.getByTestId('bridge-inference-note')).toHaveTextContent(/no cli was found/i)
  })

  it('tells the user to update a bridge whose infer route is not there', async () => {
    // An OLDER bridge: same protocol version, CLIs detected, but no `infer`
    // readiness flag — so /v1/infer would 501.
    await connectWith(healthBody({ capabilities: { inference: ['claude'], files: false, search: false } }))
    expect(screen.getByTestId('bridge-inference-note')).toHaveTextContent(/too old to run inference/i)
  })

  it('uses the port from the port field', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    render(BridgeSection)

    const portField = screen.getByLabelText(/bridge port/i)
    await userEvent.clear(portField)
    await userEvent.type(portField, '9001')
    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9001/v1/health')
  })

  it('shows an actionable alert when nothing is listening', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(BridgeSection)

    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/start the bridge in your repo/i)
    })
    expect(screen.getByTestId('bridge-status')).toHaveTextContent(/not connected/i)
  })
})

describe('BridgeSection — previously paired', () => {
  it('re-probes on mount and shows connected', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))

    render(BridgeSection)

    await waitFor(() => {
      expect(screen.getByTestId('bridge-status')).toHaveTextContent(/connected to review123/i)
    })
  })

  it('shows a plain not-running status — NOT an error — when the probe fails', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    render(BridgeSection)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.getByTestId('bridge-status')).toHaveTextContent(/the bridge is not running/i)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Disconnect clears the stored pairing', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))

    render(BridgeSection)
    const disconnect = await screen.findByRole('button', { name: /disconnect/i })
    await userEvent.click(disconnect)

    expect(localStorage.getItem(BRIDGE_STORAGE_KEY)).toBeNull()
    expect(screen.getByTestId('bridge-status')).toHaveTextContent(/not connected/i)
  })
})
