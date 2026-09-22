/**
 * bridge.test.ts — the browser half of the local bridge.
 *
 * The properties that matter most are the NEGATIVE ones: a user who has never
 * paired must cause zero requests, and a bridge that is simply not running must
 * never look like a failure. Both are asserted directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BRIDGE_PROBE_TIMEOUT_MS,
  BRIDGE_STORAGE_KEY,
  _resetBridgeForTest,
  bridgeAvailable,
  bridgeCanInfer,
  bridgeCredentials,
  bridgeInferenceClis,
  bridgeState,
  connectBridge,
  disconnectBridge,
  initBridge,
  isValidPort,
  readStoredBridge,
} from './bridge.svelte'
import { DEFAULT_BRIDGE_PORT, PROTOCOL_VERSION, bridgeUrl, parseHealth } from './protocol'
import { _setCaptureForTest } from '../analytics/analytics'

const TOKEN = 'pairing-token-0000000000000000000000000000'

function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    root: 'review123',
    capabilities: { inference: ['claude'], infer: true, files: false, search: false },
    version: '0.1.0',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>
let captured: { event: string; props: Record<string, unknown> }[]

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  captured = []
  _setCaptureForTest((event, props) => captured.push({ event, props }))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('initial state', () => {
  it('starts disconnected with nothing known', () => {
    expect(bridgeState.status).toBe('disconnected')
    expect(bridgeState.capabilities).toBeNull()
    expect(bridgeState.root).toBeNull()
    expect(bridgeState.error).toBeNull()
    expect(bridgeState.port).toBe(DEFAULT_BRIDGE_PORT)
    expect(bridgeState.paired).toBe(false)
  })
})

describe('initBridge — the silent probe', () => {
  it('makes NO request at all when the user has never paired', async () => {
    await initBridge()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(bridgeState.status).toBe('disconnected')
    expect(bridgeState.paired).toBe(false)
  })

  it('probes when a token was stored, and connects', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))

    await initBridge()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(bridgeUrl(7321, '/v1/health'))
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).credentials).toBe('omit')
    expect(bridgeState.status).toBe('connected')
    expect(bridgeState.root).toBe('review123')
  })

  it('sends the stored token as a bearer credential', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))

    await initBridge()

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('falls back to DISCONNECTED (never error) when the bridge is not running', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await initBridge()

    expect(bridgeState.status).toBe('disconnected')
    expect(bridgeState.error).toBeNull()
  })

  it('surfaces NO analytics event for a failed silent probe', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await initBridge()

    expect(captured).toEqual([])
  })

  it('KEEPS the stored token after a failed probe so the next visit retries', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await initBridge()

    expect(readStoredBridge()?.token).toBe(TOKEN)
    expect(bridgeState.paired).toBe(true)
  })

  it('times out rather than hanging, and lands on disconnected', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    // Reject exactly the way an AbortSignal.timeout does.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError')),
          )
        }),
    )

    const pending = initBridge()
    // The probe budget is short by design — assert it, then wait it out.
    expect(BRIDGE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
    await pending

    expect(bridgeState.status).toBe('disconnected')
    expect(bridgeState.error).toBeNull()
  }, 10_000)

  it('ignores a stored entry with no token', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ port: 7321 }))
    _resetBridgeForTest()
    await initBridge()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores unparseable stored JSON instead of throwing', async () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, 'not json')
    _resetBridgeForTest()
    await expect(initBridge()).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('connectBridge — user-initiated pairing', () => {
  it('connects, persists the token, and exposes the capabilities', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))

    const ok = await connectBridge(TOKEN, 7321)

    expect(ok).toBe(true)
    expect(bridgeState.status).toBe('connected')
    expect(bridgeState.capabilities).toEqual({ inference: ['claude'], infer: true, files: false, search: false })
    expect(bridgeState.version).toBe('0.1.0')
    expect(readStoredBridge()).toEqual({ token: TOKEN, port: 7321 })
  })

  it('trims a pasted token before storing and sending it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    await connectBridge(`  ${TOKEN}\n`, 7321)
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect(readStoredBridge()?.token).toBe(TOKEN)
  })

  it('remembers a non-default port', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    await connectBridge(TOKEN, 9001)
    expect(fetchMock.mock.calls[0][0]).toBe(bridgeUrl(9001, '/v1/health'))
    expect(readStoredBridge()?.port).toBe(9001)
  })

  it('fires bridge_connected exactly once, with capabilities only', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(healthBody({ capabilities: { inference: ['claude', 'codex'], infer: true, files: true, search: true } })),
    )

    await connectBridge(TOKEN, 7321)

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe('bridge_connected')
    expect(captured[0].props).toEqual({ inference_clis: ['claude', 'codex'], has_files: true })
  })

  it('never puts the token, the port or the repo name into analytics', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody({ root: 'my-secret-project' })))
    await connectBridge(TOKEN, 7321)
    const serialized = JSON.stringify(captured)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('my-secret-project')
    expect(serialized).not.toContain('7321')
  })

  it('refuses an empty token without touching the network', async () => {
    const ok = await connectBridge('   ', 7321)
    expect(ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(bridgeState.status).toBe('error')
    expect(bridgeState.error).toMatch(/paste the pairing token/i)
  })

  it('reports an unreachable bridge with an actionable message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await connectBridge(TOKEN, 7321)).toBe(false)
    expect(bridgeState.status).toBe('error')
    expect(bridgeState.error).toMatch(/127\.0\.0\.1:7321/)
    expect(bridgeState.error).toMatch(/start the bridge/i)
  })

  it('reports a rejected token, and explains that tokens rotate on restart', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'unauthorized' }, 401))
    expect(await connectBridge(TOKEN, 7321)).toBe(false)
    expect(bridgeState.error).toMatch(/rejected/i)
    expect(bridgeState.error).toMatch(/every time it starts/i)
  })

  it('refuses a bridge speaking a different protocol version', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody({ protocol: 99 })))
    expect(await connectBridge(TOKEN, 7321)).toBe(false)
    expect(bridgeState.status).toBe('error')
    expect(bridgeState.error).toMatch(/protocol v99/)
  })

  it('refuses something that is not a bridge at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hello: 'world' }))
    expect(await connectBridge(TOKEN, 7321)).toBe(false)
    expect(bridgeState.error).toMatch(/not a review123 bridge/i)
  })

  it('does NOT persist a token that failed to pair', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await connectBridge(TOKEN, 7321)
    expect(readStoredBridge()).toBeNull()
  })

  it('fires no analytics event on a failed pairing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false }, 401))
    await connectBridge(TOKEN, 7321)
    expect(captured).toEqual([])
  })
})

describe('disconnectBridge', () => {
  it('forgets the token and returns to a first-run state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    await connectBridge(TOKEN, 9001)

    disconnectBridge()

    expect(bridgeState.status).toBe('disconnected')
    expect(bridgeState.capabilities).toBeNull()
    expect(bridgeState.root).toBeNull()
    expect(bridgeState.paired).toBe(false)
    expect(bridgeState.port).toBe(DEFAULT_BRIDGE_PORT)
    expect(localStorage.getItem(BRIDGE_STORAGE_KEY)).toBeNull()
  })

  it('makes the next initBridge a no-op again', async () => {
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    await connectBridge(TOKEN, 7321)
    disconnectBridge()
    fetchMock.mockClear()

    await initBridge()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('bridgeAvailable — ROUTE readiness only', () => {
  it('is false for every route while disconnected', () => {
    expect(bridgeAvailable('infer')).toBe(false)
    expect(bridgeAvailable('files')).toBe(false)
    expect(bridgeAvailable('search')).toBe(false)
  })

  it('reflects the connected bridge route-readiness flags', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(healthBody({ capabilities: { inference: ['codex'], infer: true, files: true, search: false } })),
    )
    await connectBridge(TOKEN, 7321)

    expect(bridgeAvailable('infer')).toBe(true)
    expect(bridgeAvailable('files')).toBe(true)
    expect(bridgeAvailable('search')).toBe(false)
  })

  it('tracks READINESS, not detection: infer stays true with no CLI installed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(healthBody({ capabilities: { inference: [], infer: true, files: true, search: true } })),
    )
    await connectBridge(TOKEN, 7321)
    expect(bridgeAvailable('infer')).toBe(true)
    expect(bridgeInferenceClis()).toEqual([])
  })

  it('goes false again after a disconnect', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(healthBody({ capabilities: { inference: ['claude'], infer: true, files: true, search: true } })),
    )
    await connectBridge(TOKEN, 7321)
    disconnectBridge()
    expect(bridgeAvailable('files')).toBe(false)
  })
})

describe('bridgeInferenceClis + bridgeCanInfer', () => {
  it('reports no CLIs while disconnected', () => {
    expect(bridgeInferenceClis()).toEqual([])
    expect(bridgeCanInfer('claude')).toBe(false)
  })

  it('reports the detected CLIs from the connected bridge', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(healthBody({ capabilities: { inference: ['claude', 'codex'], infer: true, files: false, search: false } })),
    )
    await connectBridge(TOKEN, 7321)
    expect(bridgeInferenceClis()).toEqual(['claude', 'codex'])
    expect(bridgeCanInfer('claude')).toBe(true)
    expect(bridgeCanInfer('codex')).toBe(true)
  })

  it('needs BOTH halves: a live route AND that CLI detected', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(healthBody({ capabilities: { inference: ['codex'], infer: true, files: false, search: false } })),
    )
    await connectBridge(TOKEN, 7321)
    expect(bridgeCanInfer('claude')).toBe(false)
    expect(bridgeCanInfer('codex')).toBe(true)
  })

  it('is false for every CLI when the bridge predates the infer route', async () => {
    // An OLDER bridge: same protocol version, no `infer` flag, CLIs detected.
    fetchMock.mockResolvedValue(
      jsonResponse(healthBody({ capabilities: { inference: ['claude'], files: false, search: false } })),
    )
    await connectBridge(TOKEN, 7321)
    expect(bridgeAvailable('infer')).toBe(false)
    expect(bridgeCanInfer('claude')).toBe(false)
  })
})

describe('bridgeCredentials', () => {
  it('is null unless a bridge is actually connected', async () => {
    expect(bridgeCredentials()).toBeNull()
    fetchMock.mockResolvedValue(jsonResponse(healthBody()))
    await connectBridge(TOKEN, 7321)
    expect(bridgeCredentials()).toEqual({ token: TOKEN, port: 7321 })
  })
})

describe('storage robustness', () => {
  it('survives a localStorage that throws (private mode, blocked site data)', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      expect(readStoredBridge()).toBeNull()
      await expect(initBridge()).resolves.toBeUndefined()
    } finally {
      getItem.mockRestore()
    }
  })

  it('falls back to the default port when the stored port is nonsense', () => {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: -1 }))
    expect(readStoredBridge()).toEqual({ token: TOKEN, port: DEFAULT_BRIDGE_PORT })
  })

  it('validates ports', () => {
    expect(isValidPort(7321)).toBe(true)
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(1.5)).toBe(false)
  })
})

describe('parseHealth', () => {
  it('accepts a well-formed payload', () => {
    expect(parseHealth(healthBody())).toEqual(healthBody())
  })

  it('reads a MISSING infer flag as false, so an older bridge still pairs', () => {
    const older = healthBody({ capabilities: { inference: ['claude'], files: false, search: false } })
    expect(parseHealth(older)?.capabilities).toEqual({
      inference: ['claude'],
      infer: false,
      files: false,
      search: false,
    })
  })

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['ok: false', healthBody({ ok: false })],
    ['a missing protocol', { ...healthBody(), protocol: undefined }],
    ['a non-string root', healthBody({ root: 42 })],
    ['missing capabilities', { ...healthBody(), capabilities: undefined }],
    ['a non-array inference list', healthBody({ capabilities: { inference: 'claude', infer: true, files: false, search: false } })],
    ['a non-boolean files flag', healthBody({ capabilities: { inference: [], infer: true, files: 'yes', search: false } })],
    ['a non-boolean infer flag', healthBody({ capabilities: { inference: [], infer: 'yes', files: false, search: false } })],
  ])('rejects %s', (_label, value) => {
    expect(parseHealth(value)).toBeNull()
  })

  it('strips control characters from strings it will render', () => {
    // Built from char codes so this source file stays free of literal control
    // bytes (which turn it into a "binary file" for grep).
    const NUL = String.fromCharCode(0)
    const ESC = String.fromCharCode(27)
    const hostile = healthBody({ root: `re${NUL}view${ESC}123` })
    expect(parseHealth(hostile)?.root).toBe('review123')
  })

  it('caps a preposterously long repo name', () => {
    expect(parseHealth(healthBody({ root: 'x'.repeat(5_000) }))?.root.length).toBe(80)
  })
})
