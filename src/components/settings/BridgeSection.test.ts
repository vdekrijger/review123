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
    capabilities: { inference: ['claude', 'codex'], infer: true, files: false, search: false },
    version: '0.1.0',
    ...overrides,
  }
}

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

  it('says how to start the bridge', () => {
    render(BridgeSection)
    expect(screen.getByRole('region', { name: /local bridge/i })).toHaveTextContent(/pnpm bridge/)
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

  it('is still honest that FILE reads are not wired up', async () => {
    await connectWith(healthBody())
    expect(screen.getByTestId('bridge-inference-note')).toHaveTextContent(
      /reading repo files through the bridge is not wired up yet/i,
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
