/**
 * bridge/protocol.ts — the browser's view of the local-bridge wire contract.
 *
 * MIRROR of `bridge/src/protocol.ts`. The two are deliberately duplicated: the
 * SPA must not take a build-time dependency on a Node workspace package (it
 * would drag `node:` types and a second tsconfig into the app bundle graph for
 * three interfaces). Change BOTH files together; `bridge/README.md` documents
 * the canonical contract.
 *
 * IMPLEMENTED in v1: GET /v1/health, POST /v1/infer.
 * RESERVED in v1 (answer 501): POST /v1/files, /v1/search.
 */

/** Wire protocol revision this build speaks. A bridge on another major is refused. */
export const PROTOCOL_VERSION = 1

/** The port the bridge binds unless started with --port. */
export const DEFAULT_BRIDGE_PORT = 7321

/**
 * Capability flags from `/v1/health`.
 *
 * TWO DIFFERENT KINDS OF ENTRY, on purpose:
 *
 * - `inference` — DETECTION. Which CLIs exist on the user's PATH.
 * - `infer` / `files` / `search` — route-READINESS booleans, one per route and
 *   named after it. Each flips in the same commit that implements its route.
 *   `infer` is true from the inference PR on; `files`/`search` still 501.
 *
 * Running inference needs BOTH: `infer === true` (the bridge understands the
 * route) AND a CLI listed in `inference` (something to run). `bridgeAvailable`
 * answers the readiness half; `bridgeInferenceClis` answers the detection half.
 * See bridge/README.md.
 */
export interface BridgeCapabilities {
  inference: string[]
  infer: boolean
  files: boolean
  search: boolean
}

/** The CLIs the bridge knows how to drive. Mirrors bridge/src/capabilities.ts. */
export const BRIDGE_CLIS = ['claude', 'codex'] as const

export type BridgeCli = (typeof BRIDGE_CLIS)[number]

/** `POST /v1/infer` request. See bridge/src/protocol.ts for the invariants. */
export interface InferRequest {
  cli: BridgeCli
  prompt: string
  system?: string
  files?: string[]
  maxOutputTokens?: number
  timeoutMs?: number
}

/**
 * Token counts, when the CLI reports them. `claude` does; `codex` does not,
 * and then this is ABSENT — never zeroed, never guessed. Absent means UNKNOWN,
 * and the cost UI must render it as unknown rather than as free.
 */
export interface InferUsage {
  inputTokens: number
  outputTokens: number
}

export interface InferResponse {
  ok: true
  cli: string
  text: string
  truncated: boolean
  durationMs: number
  usage?: InferUsage
}

/**
 * Machine-readable failure codes. ADDITIVE within protocol v1 — an unknown
 * code must fall back on `message`, never crash. `parseBridgeError` does.
 */
export type BridgeErrorCode =
  | 'bad-request'
  | 'unauthorized'
  | 'forbidden-origin'
  | 'forbidden-host'
  | 'forbidden-path'
  | 'not-found'
  | 'method-not-allowed'
  | 'not-implemented'
  | 'payload-too-large'
  | 'timeout'
  | 'cli-unavailable'
  | 'cli-failed'

/** A parsed non-2xx bridge body. `code` is null when it was not one we know. */
export interface BridgeErrorBody {
  code: BridgeErrorCode | null
  message: string
}

const KNOWN_ERROR_CODES: readonly string[] = [
  'bad-request', 'unauthorized', 'forbidden-origin', 'forbidden-host', 'forbidden-path',
  'not-found', 'method-not-allowed', 'not-implemented', 'payload-too-large', 'timeout',
  'cli-unavailable', 'cli-failed',
]

/**
 * Narrow an untrusted error body. Like parseHealth, the bridge is a local
 * process the user started, but the payload still crosses into rendered UI —
 * so `message` is length-capped and stripped of control characters.
 */
export function parseBridgeError(value: unknown): BridgeErrorBody {
  if (typeof value !== 'object' || value === null) return { code: null, message: '' }
  const raw = value as Record<string, unknown>
  const code = raw['error']
  const message = raw['message']
  return {
    code: typeof code === 'string' && KNOWN_ERROR_CODES.includes(code) ? (code as BridgeErrorCode) : null,
    message: typeof message === 'string' ? sanitizeLabel(message, 300) : '',
  }
}

/**
 * Narrow an untrusted `/v1/infer` body. `text` is NOT sanitized: it is model
 * output headed for the JSON-extraction ladder and the markdown renderer, both
 * of which already treat it as untrusted. Stripping control characters here
 * would corrupt legitimate answers.
 */
export function parseInferResponse(value: unknown): InferResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  if (typeof raw['cli'] !== 'string') return null
  if (typeof raw['text'] !== 'string') return null
  if (typeof raw['truncated'] !== 'boolean') return null
  if (typeof raw['durationMs'] !== 'number') return null

  const parsed: InferResponse = {
    ok: true,
    cli: sanitizeLabel(raw['cli'], 40),
    text: raw['text'],
    truncated: raw['truncated'],
    durationMs: raw['durationMs'],
  }

  // Usage is optional and must be ALL-OR-NOTHING: a half-reported pair would
  // be a fabricated number in the cost UI.
  const usage = raw['usage']
  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>
    if (typeof u['inputTokens'] === 'number' && typeof u['outputTokens'] === 'number') {
      parsed.usage = { inputTokens: u['inputTokens'], outputTokens: u['outputTokens'] }
    }
  }
  return parsed
}

export interface BridgeHealth {
  ok: true
  protocol: number
  /** Repo directory BASENAME — the bridge never sends the absolute path. */
  root: string
  capabilities: BridgeCapabilities
  version: string
}

/**
 * The ROUTE-READINESS flags other modules ask `bridgeAvailable()` about.
 *
 * Deliberately excludes `inference`: that is a detection ARRAY, a different
 * question, and a boolean helper answering both would be one letter away from
 * the wrong answer at every call site. Detection has its own accessor,
 * `bridgeInferenceClis()`.
 */
export type BridgeCapability = 'infer' | 'files' | 'search'

/** The loopback URL for a bridge route. Always 127.0.0.1 — never `localhost`. */
export function bridgeUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

/**
 * Narrow an untrusted `/v1/health` body to BridgeHealth.
 *
 * The bridge is a local process the user started, but the response still
 * crosses a network boundary into rendered UI, so it is validated like any
 * other foreign payload: shape-checked, and `root` (which IS displayed) is
 * length-capped and stripped of control characters.
 */
export function parseHealth(value: unknown): BridgeHealth | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  if (typeof raw['protocol'] !== 'number') return null
  if (typeof raw['root'] !== 'string') return null
  if (typeof raw['version'] !== 'string') return null

  const caps = raw['capabilities']
  if (typeof caps !== 'object' || caps === null) return null
  const capsRaw = caps as Record<string, unknown>
  const inference = capsRaw['inference']
  if (!Array.isArray(inference) || inference.some((cli) => typeof cli !== 'string')) return null
  // `infer` arrived with the inference PR. A bridge predating it is on the same
  // protocol version but has no such route, so a MISSING flag reads as false —
  // not as a parse failure, which would break pairing with an older bridge.
  const inferReady = capsRaw['infer']
  if (inferReady !== undefined && typeof inferReady !== 'boolean') return null
  if (typeof capsRaw['files'] !== 'boolean') return null
  if (typeof capsRaw['search'] !== 'boolean') return null

  return {
    ok: true,
    protocol: raw['protocol'],
    root: sanitizeLabel(raw['root'], 80),
    capabilities: {
      inference: (inference as string[]).map((cli) => sanitizeLabel(cli, 40)),
      infer: inferReady === true,
      files: capsRaw['files'],
      search: capsRaw['search'],
    },
    version: sanitizeLabel(raw['version'], 40),
  }
}

/**
 * Strip control characters and cap the length of a string we are going to
 * render. Written as a code-point walk rather than a regex so no escape in
 * this file is itself a control character.
 */
function sanitizeLabel(value: string, maxLength: number): string {
  let out = ''
  for (const ch of value.slice(0, maxLength)) {
    const code = ch.codePointAt(0) ?? 0
    const isControl = code < 0x20 || code === 0x7f
    if (!isControl) out += ch
  }
  return out
}
