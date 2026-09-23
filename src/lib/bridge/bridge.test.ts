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
  localNetworkPermission,
  readStoredBridge,
} from './bridge.svelte'
import {
  DEFAULT_BRIDGE_PORT,
  INFER_STREAM_CONTENT_TYPE,
  INFER_STREAM_PATH,
  PROTOCOL_VERSION,
  bridgeUrl,
  parseGitState,
  parseHealth,
  parseInferResponse,
  parseInferStreamEvent,
} from './protocol'
import { _setCaptureForTest } from '../analytics/analytics'

const TOKEN = 'pairing-token-0000000000000000000000000000'

function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    root: 'review123',
    capabilities: { inference: ['claude'], infer: true, inferStream: true, inferAgentic: true, files: true, search: true, fix: false, checkout: false },
    git: { head: HEAD_SHA, branch: 'main', dirty: false },
    version: '0.1.0',
    ...overrides,
  }
}

/** A plausible 40-hex commit id for the health fixtures. */
const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'

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
    // `fix: false` and `checkout: false` — this fixture's bridge grants
    // neither, which is the default and the only state a browser can observe
    // unless the person at the terminal typed --allow-write or
    // --allow-checkout themselves.
    expect(bridgeState.capabilities).toEqual({
      inference: ['claude'],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      fix: false,
      checkout: false,
    })
    expect(bridgeState.git).toEqual({ head: HEAD_SHA, branch: 'main', dirty: false })
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

  it('names BOTH possibilities when the browser will not say which it was', async () => {
    // No Permissions API (Firefox, Safari, jsdom) and a refused no-cors probe:
    // "nothing there" and "the browser blocked it" are both still live, so the
    // copy must not pick one — the original bug was picking the wrong one.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await connectBridge(TOKEN, 7321)).toBe(false)
    expect(bridgeState.status).toBe('error')
    expect(bridgeState.error).toMatch(/127\.0\.0\.1:7321/)
    expect(bridgeState.error).toMatch(/nothing is listening there/i)
    expect(bridgeState.error).toMatch(/blocked the request to your local network/i)
  })

  it('reports a rejected token, and explains that tokens rotate on restart', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'unauthorized' }, 401))
    expect(await connectBridge(TOKEN, 7321)).toBe(false)
    expect(bridgeState.error).toMatch(/rejected/i)
    expect(bridgeState.error).toMatch(/every time it starts/i)
    // The one thing this failure PROVES: the bridge is up. A user who just
    // restarted it must not be told to start it.
    expect(bridgeState.error).toMatch(/running and reachable/i)
    expect(bridgeState.error).not.toMatch(/start the bridge/i)
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

/**
 * THE REGRESSION SUITE FOR THE BUG THAT MADE THE BRIDGE UNUSABLE.
 *
 * A real user ran the bridge, pasted the token on https://www.review123.dev,
 * and was told "Nothing answered on 127.0.0.1:7321. Start the bridge in your
 * repo, then try again." — while it was running the whole time. Chrome 142+
 * blocks a public-origin page from reaching loopback until the user grants
 * Local Network Access, and the rejected fetch is a bare `TypeError: Failed to
 * fetch`, identical to a refused connection.
 *
 * Every case below is one cause with one fix, and asserts that the message
 * names THAT fix and not another one.
 */
describe('probe failure taxonomy — four causes, four sentences', () => {
  /** Stub the Permissions API the way a Chromium that ships LNA answers. */
  function stubPermission(state: PermissionState | 'throws') {
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      permissions: {
        query: (descriptor: { name: string }) => {
          if (state === 'throws' || descriptor.name.startsWith('local-network') === false) {
            return Promise.reject(new TypeError(`unknown permission ${descriptor.name}`))
          }
          return Promise.resolve({ state } as PermissionStatus)
        },
      },
    })
  }

  it('says the BROWSER blocked it — never "start the bridge" — when permission is denied', async () => {
    stubPermission('denied')
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    expect(await connectBridge(TOKEN, 7321)).toBe(false)

    expect(bridgeState.error).toMatch(/never left it/i)
    expect(bridgeState.error).toMatch(/Local network access/i)
    // The whole point of the fix: the bridge is NOT what the user must change.
    expect(bridgeState.error).not.toMatch(/start the bridge/i)
    expect(bridgeState.error).not.toMatch(/nothing is listening/i)
  })

  it('distinguishes "never asked" from "already refused"', async () => {
    stubPermission('prompt')
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await connectBridge(TOKEN, 7321)
    expect(bridgeState.error).toMatch(/has not yet allowed/i)
    expect(bridgeState.error).not.toMatch(/will not help/i)

    _resetBridgeForTest()
    stubPermission('denied')
    await connectBridge(TOKEN, 7321)
    expect(bridgeState.error).toMatch(/is blocking/i)
    // A retry alone cannot fix a denial, and the copy has to say so.
    expect(bridgeState.error).toMatch(/will not help/i)
  })

  it('says "nothing is listening" ONLY when the browser confirmed it let the request out', async () => {
    stubPermission('granted')
    // Both the real probe and the no-cors liveness probe fail: the connection
    // was genuinely refused.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    expect(await connectBridge(TOKEN, 7321)).toBe(false)

    expect(bridgeState.error).toMatch(/nothing is listening on 127\.0\.0\.1:7321/i)
    expect(bridgeState.error).toMatch(/start the bridge/i)
  })

  it('reports an origin the server refused when something IS listening', async () => {
    stubPermission('granted')
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      // A no-cors request RESOLVES (opaquely) whenever the server answered at
      // all — even with the bridge's headerless 403. That is the one signal
      // separating "refused my origin" from "there is no server".
      init?.mode === 'no-cors'
        ? // An opaque response, as Chrome hands one back: type 'opaque',
          // status 0, unreadable — and that is all the signal we need.
          Promise.resolve({ type: 'opaque', status: 0 } as unknown as Response)
        : Promise.reject(new TypeError('Failed to fetch')),
    )

    expect(await connectBridge(TOKEN, 7321)).toBe(false)

    expect(bridgeState.error).toMatch(/something is listening on 127\.0\.0\.1:7321/i)
    expect(bridgeState.error).toMatch(/older build/i)
    expect(bridgeState.error).not.toMatch(/start the bridge/i)
  })

  it('names a timeout as a timeout, not as a missing bridge', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new DOMException('signal timed out', 'TimeoutError')),
    )
    expect(await connectBridge(TOKEN, 7321)).toBe(false)
    expect(bridgeState.error).toMatch(/did not answer within/i)
    expect(bridgeState.error).not.toMatch(/start the bridge/i)
  })

  it('spends NO diagnostic call on the silent mount probe', async () => {
    stubPermission('granted')
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port: 7321 }))
    _resetBridgeForTest()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await initBridge()

    // One refused connection and nothing else — the module's standing promise.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bridgeState.status).toBe('disconnected')
    expect(bridgeState.error).toBeNull()
  })

  it('reports "unknown" permission honestly rather than guessing', async () => {
    stubPermission('throws')
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await localNetworkPermission()).toBe('unknown')

    await connectBridge(TOKEN, 7321)
    expect(bridgeState.error).toMatch(/either nothing is listening there, or this browser blocked/i)
  })

  it('reads the permission through the shipped alias too', async () => {
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      permissions: {
        query: ({ name }: { name: string }) =>
          name === 'local-network'
            ? Promise.resolve({ state: 'granted' } as PermissionStatus)
            : Promise.reject(new TypeError('unknown permission')),
      },
    })
    expect(await localNetworkPermission()).toBe('granted')
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
      inferStream: false,
      inferAgentic: false,
      files: false,
      search: false,
      fix: false,
      checkout: false,
    })
  })

  // Route readiness, read exactly like `infer` was: an older bridge that has
  // no streaming route is not malformed, it simply cannot stream — and the
  // transport falls back to the one-shot route rather than refusing.
  it('reads a MISSING inferStream flag as false, so a pre-streaming bridge still pairs', () => {
    const older = healthBody({
      capabilities: { inference: ['claude'], infer: true, files: true, search: true },
    })
    expect(parseHealth(older)?.capabilities.inferStream).toBe(false)
    expect(parseHealth(older)?.capabilities.infer).toBe(true)
  })

  // The same additive rule, and the one where reading it wrong is worst: a
  // bridge without the agentic route does not REFUSE an agentic request, it
  // silently answers tool-less. Reading the absent flag as false is what stops
  // that answer being presented as a deep, locally-grounded review.
  it('reads a MISSING inferAgentic flag as false, so a pre-agentic bridge still pairs', () => {
    const older = healthBody({
      capabilities: { inference: ['claude'], infer: true, inferStream: true, files: true, search: true },
    })
    expect(parseHealth(older)?.capabilities.inferAgentic).toBe(false)
    expect(parseHealth(older)?.capabilities.inferStream).toBe(true)
  })

  it('reads a NON-BOOLEAN inferAgentic flag as malformed rather than guessing', () => {
    const lying = healthBody({
      capabilities: { inference: ['claude'], infer: true, inferStream: true, inferAgentic: 'yes', files: true, search: true },
    })
    expect(parseHealth(lying)).toBeNull()
  })

  it('reads a NON-BOOLEAN inferStream flag as malformed rather than guessing', () => {
    const lying = healthBody({
      capabilities: { inference: ['claude'], infer: true, inferStream: 'yes', files: true, search: true },
    })
    expect(parseHealth(lying)).toBeNull()
  })

  // A WRITE capability must never be inferred from silence.
  it('reads a MISSING fix flag as false — an old bridge cannot write', () => {
    const older = healthBody({ capabilities: { inference: ['claude'], infer: true, files: true, search: true } })
    expect(parseHealth(older)?.capabilities.fix).toBe(false)
  })

  // Same rule, same reason, for the grant that moves the user's branch.
  it('reads a MISSING checkout flag as false — an old bridge cannot switch branches', () => {
    const older = healthBody({ capabilities: { inference: ['claude'], infer: true, files: true, search: true } })
    expect(parseHealth(older)?.capabilities.checkout).toBe(false)
  })

  it('reads a NON-BOOLEAN checkout flag as malformed rather than as permission', () => {
    const lying = healthBody({
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, checkout: 'yes' },
    })
    expect(parseHealth(lying)).toBeNull()
  })

  // The two grants are independent on the wire as well as at the terminal.
  it('does not read checkout from fix, in either direction', () => {
    const writeOnly = healthBody({
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, fix: true },
    })
    expect(parseHealth(writeOnly)?.capabilities).toMatchObject({ fix: true, checkout: false })

    const checkoutOnly = healthBody({
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, checkout: true },
    })
    expect(parseHealth(checkoutOnly)?.capabilities).toMatchObject({ fix: false, checkout: true })
  })

  it('reads a NON-BOOLEAN fix flag as malformed rather than as permission', () => {
    const lying = healthBody({
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, fix: 'yes' },
    })
    expect(parseHealth(lying)).toBeNull()
  })

  it('carries a TRUE fix flag through, so a write-enabled bridge is usable', () => {
    const writing = healthBody({
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, fix: true },
    })
    expect(parseHealth(writing)?.capabilities.fix).toBe(true)
  })

  it('reads a MISSING git field as null, so a pre-grounding bridge still pairs', () => {
    const older: Record<string, unknown> = { ...healthBody() }
    delete older['git']
    const parsed = parseHealth(older)
    expect(parsed).not.toBeNull()
    expect(parsed?.git).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The repo state — the field local grounding turns on. Every doubtful input
// must narrow to NULL, because a state we cannot read is a state we cannot
// match, and an unmatched state means the review grounds from the provider.
// ---------------------------------------------------------------------------

describe('parseGitState', () => {
  it('accepts a well-formed state', () => {
    expect(parseGitState({ head: HEAD_SHA, branch: 'main', dirty: false })).toEqual({
      head: HEAD_SHA,
      branch: 'main',
      dirty: false,
    })
  })

  it('lowercases the sha so a comparison is not case-sensitive', () => {
    expect(parseGitState({ head: HEAD_SHA.toUpperCase(), branch: 'm', dirty: false })?.head).toBe(HEAD_SHA)
  })

  it('reads a null branch as a detached HEAD', () => {
    expect(parseGitState({ head: HEAD_SHA, branch: null, dirty: false })?.branch).toBeNull()
  })

  it('treats a MISSING dirty flag as DIRTY — unknown never renders as reassuring', () => {
    expect(parseGitState({ head: HEAD_SHA, branch: 'main' })?.dirty).toBe(true)
    expect(parseGitState({ head: HEAD_SHA, branch: 'main', dirty: 'no' })?.dirty).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'deadbeef'],
    ['no head', { branch: 'main', dirty: false }],
    ['a short sha', { head: 'abc1234', branch: 'main', dirty: false }],
    ['a non-hex sha', { head: 'z'.repeat(40), branch: 'main', dirty: false }],
    ['a non-string head', { head: 12345, branch: 'main', dirty: false }],
  ])('rejects %s as null', (_label, value) => {
    expect(parseGitState(value)).toBeNull()
  })

  it('strips control characters out of a branch name before it can be rendered', () => {
    const BELL = String.fromCharCode(7)
    expect(parseGitState({ head: HEAD_SHA, branch: `fe${BELL}at`, dirty: false })?.branch).toBe('feat')
  })

  it('reads a branch that is nothing BUT control characters as detached, not as empty', () => {
    const NUL = String.fromCharCode(0)
    expect(parseGitState({ head: HEAD_SHA, branch: NUL, dirty: false })?.branch).toBeNull()
  })
})

describe('parseHealth — remaining shape rules', () => {

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

// ===========================================================================
// parseInferStreamEvent — one untrusted NDJSON line at a time.
//
// The contract this narrower has to hold: an unreadable line is SKIPPED, never
// fatal (event types are additive within v1 exactly as error codes are), and
// no field is ever guessed in the permissive direction.
// ===========================================================================

describe('parseInferStreamEvent', () => {
  const line = (event: Record<string, unknown>): string => JSON.stringify(event)

  it('reads the route and framing constants the two protocol mirrors share', () => {
    expect(INFER_STREAM_PATH).toBe('/v1/infer/stream')
    // NDJSON, not text/event-stream — see the protocol header for why.
    expect(INFER_STREAM_CONTENT_TYPE).toBe('application/x-ndjson')
  })

  it('reads a start event, including the streaming fact', () => {
    expect(parseInferStreamEvent(line({ type: 'start', cli: 'claude', streaming: true }))).toEqual({
      type: 'start',
      cli: 'claude',
      streaming: true,
    })
  })

  it('reads a NON-boolean `streaming` as false — claiming a stream is the one lie that matters', () => {
    for (const streaming of ['yes', 1, undefined, null]) {
      expect(parseInferStreamEvent(line({ type: 'start', cli: 'codex', streaming }))).toMatchObject({
        streaming: false,
      })
    }
  })

  it('reads a delta, leaving the text EXACTLY as the model wrote it', () => {
    // Not sanitized: it is model output headed for the JSON ladder and the
    // markdown renderer, both of which already treat it as untrusted.
    const text = 'a\tb\n```json\n{"x":1}\n```'
    expect(parseInferStreamEvent(line({ type: 'delta', text }))).toEqual({ type: 'delta', text })
  })

  it('reads a done event with usage', () => {
    expect(
      parseInferStreamEvent(
        line({
          type: 'done',
          text: 'the answer',
          truncated: false,
          durationMs: 42,
          usage: { inputTokens: 10, outputTokens: 4 },
        }),
      ),
    ).toEqual({
      type: 'done',
      text: 'the answer',
      truncated: false,
      durationMs: 42,
      usage: { inputTokens: 10, outputTokens: 4 },
    })
  })

  it('drops a HALF-reported usage pair rather than inventing the missing half', () => {
    const done = parseInferStreamEvent(
      line({ type: 'done', text: 'x', truncated: false, durationMs: 1, usage: { inputTokens: 10 } }),
    )
    expect(done).not.toHaveProperty('usage')
  })

  // `code` is what a real bridge sends — verified against a live one. `error`
  // is the spelling every OTHER bridge error body uses, so it is accepted as
  // an alias; reading only one of the two would silently unclassify a failure.
  it.each([
    ['`code`, as the bridge actually sends it', 'code'],
    ['`error`, the alias every other bridge error body uses', 'error'],
  ])('reads an error event keyed by %s, and sanitizes the message it will render', (_label, field) => {
    const NUL = String.fromCharCode(0)
    expect(
      parseInferStreamEvent(line({ type: 'error', [field]: 'timeout', message: `too${NUL} slow` })),
    ).toEqual({ type: 'error', code: 'timeout', message: 'too slow' })
  })

  it('reads an UNKNOWN error code as null, so the message still reaches the user', () => {
    expect(parseInferStreamEvent(line({ type: 'error', error: 'quantum-flux', message: 'new' }))).toEqual({
      type: 'error',
      code: null,
      message: 'new',
    })
  })

  it.each([
    ['a blank line', ''],
    ['whitespace', '   '],
    ['a non-JSON line', 'Welcome to Claude Code!'],
    ['a JSON scalar', 'null'],
    ['a JSON array', '[1,2,3]'],
    ['an event type from a NEWER bridge', '{"type":"progress","percent":40}'],
    ['a start with no cli', '{"type":"start","streaming":true}'],
    ['a delta with no text', '{"type":"delta"}'],
    ['a done with no text', '{"type":"done","truncated":false,"durationMs":1}'],
    ['a done with a non-numeric duration', '{"type":"done","text":"x","truncated":false,"durationMs":"1"}'],
  ])('SKIPS %s rather than failing the stream', (_label, raw) => {
    expect(parseInferStreamEvent(raw)).toBeNull()
  })
})

describe('parseInferResponse — the agentic report', () => {
  function body(agentic: unknown): Record<string, unknown> {
    return { ok: true, cli: 'claude', text: 'a', truncated: false, durationMs: 1, agentic }
  }

  it('reads a well-formed report', () => {
    const parsed = parseInferResponse(body({ tools: ['Read', 'Glob'], toolCallsAtLeast: 3, denied: 1 }))
    expect(parsed?.agentic).toEqual({ tools: ['Read', 'Glob'], toolCallsAtLeast: 3, denied: 1 })
  })

  it('accepts codex’s EMPTY tool list — not nameable is not the same as none', () => {
    expect(parseInferResponse(body({ tools: [] }))?.agentic).toEqual({ tools: [] })
  })

  /**
   * The presence of this report is what lets the app tell a user their review
   * read their own working tree. So anything that is not a well-formed report
   * is dropped ENTIRELY rather than half-read: "we could not tell" has to
   * resolve to "not grounded", never to a partial claim.
   */
  it('drops a malformed report rather than half-reading it', () => {
    for (const bad of [null, 'yes', 42, {}, { tools: 'Read' }, { tools: [1, 2] }]) {
      expect(parseInferResponse(body(bad))?.agentic).toBeUndefined()
    }
  })

  it('leaves a malformed COUNT absent rather than coercing it to zero', () => {
    // Absent means "unreported"; 0 is a claim that the CLI used no tools.
    const parsed = parseInferResponse(body({ tools: ['Read'], toolCallsAtLeast: -1, denied: 'lots' }))
    expect(parsed?.agentic).toEqual({ tools: ['Read'] })
  })

  it('is ABSENT for an ordinary tool-less answer, which is how an old bridge reads', () => {
    const plain = { ok: true, cli: 'claude', text: 'a', truncated: false, durationMs: 1 }
    expect(parseInferResponse(plain)?.agentic).toBeUndefined()
  })
})
