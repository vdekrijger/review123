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
import { getSettings } from '../../lib/settings/settings'

const TOKEN = 'pairing-token-0000000000000000000000000000'

function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    root: 'review123',
    capabilities: { inference: ['claude', 'codex'], infer: true, inferStream: true, files: true, search: true },
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

  // The documented command carries both grants. The code defaults stay OFF —
  // this is documentation, not a default — but omitting them from the line
  // people paste only means the two headline features silently do not work.
  it('documents the command with BOTH grants, not a crippled one', () => {
    render(BridgeSection)
    expect(screen.getByTestId('bridge-install')).toHaveTextContent(
      'node ~/review123-bridge.mjs --root . --allow-write --allow-checkout --allow-push',
    )
  })

  it('says what each flag unlocks, and why they live on the command line', () => {
    render(BridgeSection)
    const note = screen.getByTestId('bridge-flags-note')
    // Which flag unlocks what — they are independent grants.
    expect(note).toHaveTextContent(/--allow-write/)
    expect(note).toHaveTextContent(/scratch git worktree/i)
    expect(note).toHaveTextContent(/--allow-checkout/)
    expect(note).toHaveTextContent(/check\s+a pull request out/i)
    expect(note).toHaveTextContent(/--allow-push/)
    expect(note).toHaveTextContent(/independent/i)
    // And the reason they exist: they defend the user against THIS WEBSITE,
    // not against themselves. Without this, someone "hardens" the documented
    // command back out and only turns the features off.
    expect(note).toHaveTextContent(/off/i)
    expect(note).toHaveTextContent(/compromised/i)
  })

  // --allow-push is NOT like the other two and the copy must not pretend it is.
  // A scratch worktree and a checkout change the user's own machine reversibly;
  // a push is seen by their team and cannot be withdrawn. So the "leaving them
  // out hardens nothing" argument, which is true and load-bearing for the first
  // two, is FALSE for the third — and saying it anyway would be the app talking
  // someone into a grant by an argument that does not apply to it.
  it('does not extend the "hardens nothing" argument to --allow-push', () => {
    render(BridgeSection)
    const push = screen.getByTestId('bridge-push-note')
    expect(push).toHaveTextContent(/cannot be taken back|undo/i)
    expect(push).toHaveTextContent(/harden/i)
    // And the guarantees that make it survivable are stated where it is asked for.
    expect(push).toHaveTextContent(/fast-forward/i)
    expect(push).toHaveTextContent(/default branch/i)
    expect(push).toHaveTextContent(/asks before/i)
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

  // -------------------------------------------------------------------------
  // Model selection. The "Local bridge model" dropdown under AI models picks
  // the CLI (`claude`/`codex`) — a process name. This picks the MODEL that
  // process runs, which nothing could express before: no `--model` was ever
  // sent, so users silently got their CLI's configured default.
  // -------------------------------------------------------------------------
  async function connect(): Promise<void> {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    render(BridgeSection)
    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(screen.getByTestId('bridge-status')).toBeInTheDocument())
  }

  it('offers a model field once connected, blank by default', async () => {
    await connect()
    const field = await screen.findByLabelText(/bridge cli model/i)
    expect((field as HTMLInputElement).value).toBe('')
    expect(getSettings().bridgeModel).toBe('')
  })

  it('stores a typed model id', async () => {
    await connect()
    await userEvent.type(await screen.findByLabelText(/bridge cli model/i), 'opus')
    expect(getSettings().bridgeModel).toBe('opus')
  })

  it('clearing it goes back to the CLI default rather than sending an empty model', async () => {
    await connect()
    const field = await screen.findByLabelText(/bridge cli model/i)
    await userEvent.type(field, 'opus')
    await userEvent.clear(field)
    expect(getSettings().bridgeModel).toBe('')
  })

  it('flags an id that could never be sent, and stores nothing', async () => {
    await connect()
    await userEvent.type(await screen.findByLabelText(/bridge cli model/i), '-opus')
    expect(screen.getByText(/isn't a model id/i)).toBeInTheDocument()
    expect(getSettings().bridgeModel).toBe('')
  })

  it('explains the flag rather than listing models it cannot know', async () => {
    await connect()
    const note = await screen.findByTestId('bridge-model-note')
    expect(note).toHaveTextContent(/--model/)
    expect(note).toHaveTextContent(/Blank sends no flag/i)
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

  // "Never silently claiming to stream": the absence of the streaming route is
  // VISIBLE to the user — answers stop typing out — so the section says why
  // rather than leaving them to wonder.
  it('says nothing about streaming when the bridge streams and claude is present', async () => {
    await connectWith(healthBody())
    expect(screen.getByTestId('bridge-inference-note')).not.toHaveTextContent(/all at once/i)
  })

  it('tells the user an OLDER bridge cannot stream, and what to do about it', async () => {
    await connectWith(
      healthBody({ capabilities: { inference: ['claude'], infer: true, files: true, search: true } }),
    )
    const note = screen.getByTestId('bridge-inference-note')
    expect(note).toHaveTextContent(/all at once rather than typing out/i)
    expect(note).toHaveTextContent(/no streaming route/i)
  })

  // A DIFFERENT reason for the same symptom, so the fix the user is told about
  // is the one that would actually work.
  it('tells a codex-only user that the CLI, not the bridge, is why nothing types out', async () => {
    await connectWith(
      healthBody({
        capabilities: { inference: ['codex'], infer: true, inferStream: true, files: true, search: true },
      }),
    )
    const note = screen.getByTestId('bridge-inference-note')
    expect(note).toHaveTextContent(/no partial-output mode/i)
    expect(note).not.toHaveTextContent(/no streaming route/i)
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

  it('names both possibilities when the browser will not say which it was', async () => {
    // jsdom exposes no Permissions API, so the probe cannot rule the browser
    // in or out and must not pretend otherwise.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(BridgeSection)

    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/nothing is listening there/i)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/blocked the request to your local network/i)
    expect(screen.getByTestId('bridge-status')).toHaveTextContent(/not connected/i)
  })

  /**
   * THE BUG THIS PR EXISTS FOR, at the surface the user actually read: a
   * running bridge, a browser that blocked the request, and an alert that used
   * to say "Start the bridge in your repo".
   */
  it('tells the user to grant local network access, not to start a bridge that is already running', async () => {
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      permissions: { query: async () => ({ state: 'denied' }) as PermissionStatus },
    })
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(BridgeSection)

    await userEvent.type(screen.getByLabelText(/bridge pairing token/i), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/local network access/i)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/never left it/i)
    expect(screen.getByRole('alert')).not.toHaveTextContent(/start the bridge in your repo/i)
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
