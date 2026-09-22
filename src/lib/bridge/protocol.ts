/**
 * bridge/protocol.ts — the browser's view of the local-bridge wire contract.
 *
 * MIRROR of `bridge/src/protocol.ts`. The two are deliberately duplicated: the
 * SPA must not take a build-time dependency on a Node workspace package (it
 * would drag `node:` types and a second tsconfig into the app bundle graph for
 * three interfaces). Change BOTH files together; `bridge/README.md` documents
 * the canonical contract.
 *
 * IMPLEMENTED in v1: GET /v1/health.
 * RESERVED in v1 (answer 501): POST /v1/infer, /v1/files, /v1/search.
 */

/** Wire protocol revision this build speaks. A bridge on another major is refused. */
export const PROTOCOL_VERSION = 1

/** The port the bridge binds unless started with --port. */
export const DEFAULT_BRIDGE_PORT = 7321

/**
 * Capability flags from `/v1/health`.
 *
 * `inference` is a DETECTION signal (which CLIs exist on the user's PATH);
 * `files` and `search` are route-READINESS booleans, false while those routes
 * answer 501. See bridge/README.md.
 */
export interface BridgeCapabilities {
  inference: string[]
  files: boolean
  search: boolean
}

export interface BridgeHealth {
  ok: true
  protocol: number
  /** Repo directory BASENAME — the bridge never sends the absolute path. */
  root: string
  capabilities: BridgeCapabilities
  version: string
}

/** The capabilities other modules ask `bridgeAvailable()` about. */
export type BridgeCapability = 'inference' | 'files' | 'search'

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
  if (typeof capsRaw['files'] !== 'boolean') return null
  if (typeof capsRaw['search'] !== 'boolean') return null

  return {
    ok: true,
    protocol: raw['protocol'],
    root: sanitizeLabel(raw['root'], 80),
    capabilities: {
      inference: (inference as string[]).map((cli) => sanitizeLabel(cli, 40)),
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
