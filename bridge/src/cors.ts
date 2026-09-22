/**
 * cors.ts — the origin allowlist and the DNS-rebinding host guard.
 *
 * A loopback server that reads files is only as safe as the answer to "who is
 * allowed to talk to it". Two independent checks answer it:
 *
 *  1. ORIGIN allowlist — which web origin the request claims to come from.
 *     Exact matches only. NEVER `*`. An origin that is not on the list gets a
 *     403 and NO `Access-Control-Allow-*` headers at all, so even a buggy
 *     browser cannot let the caller read the response.
 *
 *  2. HOST guard — which name the caller used to reach us. `127.0.0.1` can be
 *     reached from `http://evil.test/` if an attacker rebinds that name's DNS
 *     to loopback (classic DNS rebinding); such a request is SAME-origin to the
 *     browser, so the Origin check above would pass or be absent. But the Host
 *     header still says `evil.test`. Requiring a loopback Host closes that.
 */

/** The deployed app. The only non-loopback origin allowed by default. */
export const REVIEW123_ORIGIN = 'https://review123.dev'

/**
 * Dev origins: `http://localhost[:port]` and `http://127.0.0.1[:port]`.
 *
 * The port is wildcarded on purpose — a dev server picks whatever port is
 * free, and `pnpm dev` / `pnpm preview` / the e2e harness all differ. Scheme
 * and host are still pinned exactly, so `http://localhost.evil.test` and
 * `https://127.0.0.1.evil.test` do NOT match. Browsers serialize origins
 * lowercase with no trailing slash, which is what this anchored pattern
 * requires.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/

/** Highest valid TCP port. A 5-digit match above this is not an origin. */
const MAX_PORT = 65535

/**
 * Is this `Origin` header value allowed?
 *
 * `extra` holds `--allow-origin` values, which are ADDITIVE to the defaults and
 * compared as exact strings (no patterns, no wildcards).
 */
export function isAllowedOrigin(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (!origin) return false
  if (origin === REVIEW123_ORIGIN) return true
  const loopback = LOOPBACK_ORIGIN.exec(origin)
  if (loopback) {
    const port = loopback[1]
    return port === undefined || Number(port) <= MAX_PORT
  }
  return extra.includes(origin)
}

/**
 * CORS headers for an ALREADY-ALLOWED origin. The origin is echoed verbatim —
 * never `*` — and `Vary: Origin` keeps any intermediary from reusing one
 * origin's response for another.
 *
 * `Access-Control-Allow-Credentials` is deliberately ABSENT: the bridge
 * authenticates with a bearer token, so it must never be reachable with
 * ambient cookies.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

/**
 * Is this `Host` header a loopback name (optionally with the port we bound)?
 *
 * Accepts `127.0.0.1`, `localhost`, `[::1]` and the same with `:<port>`.
 * A request that arrived under any other name is refused — it means the caller
 * resolved some other hostname to our loopback address.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  // HTTP/1.0 clients may omit Host. Nothing browser-borne does, and a missing
  // Host cannot be a rebound name, so it is allowed (the bearer token still
  // gates the request).
  if (host === undefined || host === '') return true
  const withoutPort = stripPort(host)
  if (withoutPort === null) return false
  const [name, hostPort] = withoutPort
  if (hostPort !== null && hostPort !== port) return false
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** Split `host[:port]`, tolerating the bracketed IPv6 form. Null when malformed. */
function stripPort(host: string): [string, number | null] | null {
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close === -1) return null
    const name = host.slice(0, close + 1)
    const rest = host.slice(close + 1)
    if (rest === '') return [name, null]
    if (!rest.startsWith(':')) return null
    return parsePort(rest.slice(1), name)
  }
  const colon = host.lastIndexOf(':')
  if (colon === -1) return [host, null]
  return parsePort(host.slice(colon + 1), host.slice(0, colon))
}

function parsePort(raw: string, name: string): [string, number | null] | null {
  if (!/^\d{1,5}$/.test(raw)) return null
  const port = Number(raw)
  if (port > MAX_PORT) return null
  return [name, port]
}
