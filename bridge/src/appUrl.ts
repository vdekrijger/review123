/**
 * appUrl.ts — WHERE the user's dev server is, and whether it is up.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE BRIDGE ANSWERS THIS AND NOT THE BROWSER
 *
 * The browser cannot find out. A page on https://review123.dev that fetches
 * http://localhost:8010 gets a CORS failure whether the port is serving a
 * thriving Django app or nothing at all — the error is identical, by design,
 * because letting a web page distinguish the two IS the port-scanning attack
 * the same-origin policy exists to prevent.
 *
 * The bridge is a process the user started on that machine. It can just open a
 * socket. So the detection and the probe live here, and the browser is told
 * the answer.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE DETECTION LADDER, in order, each rung reported as its own `source`:
 *
 *   1. `--app-url`     the user said so. Nothing beats being told.
 *   2. PostHog         a PostHog checkout serves Django + Vite + Celery + the
 *                      plugin-server behind ONE fixed port, 8010. Detected
 *                      from the repo's own marker files, never from its
 *                      directory name (people rename checkouts).
 *   3. package.json    a `dev` or `start` script that NAMES a port.
 *   4. unknown         nothing could be determined, and that is what we say.
 *
 * THE FOURTH RUNG IS NOT A FAILURE, IT IS THE FEATURE. The tempting move is to
 * assume Vite's 5173 when a `dev` script exists but names no port. Then the
 * preview panel confidently frames whatever else is on 5173 — another project,
 * a stale server, a coincidence — and presents it as this PR running. A wrong
 * answer delivered confidently is worse than "I could not tell", so an
 * unnamed port stays unknown and `detail` explains why.
 *
 * NOTHING HERE RUNS A COMMAND. The ladder reads two files and opens one TCP
 * socket; it never executes a dev script to see what it does.
 */

import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { APP_PROBE_TIMEOUT_MS, type AppUrlSource, type StackApp } from './protocol.js'

/**
 * The port every PostHog development stack is fronted at.
 *
 * Not a preference and not a default we picked: PostHog's own dev runner puts
 * Django, the Vite dev server, Celery and the plugin-server behind this single
 * port, and its docs and tooling all address it. A PostHog checkout whose
 * stack is up is reachable here or nowhere.
 */
export const POSTHOG_APP_PORT = 8010

/** Cap on the bytes read from a `package.json`. A manifest is never this big. */
const MAX_MANIFEST_BYTES = 512 * 1024

/**
 * Read and parse a JSON file, or null. Never throws: a missing file, a
 * directory, a syntax error and a permissions failure all mean the same thing
 * to the ladder — this rung has no answer, try the next one.
 */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8')
    if (raw.length > MAX_MANIFEST_BYTES) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Does a path exist and read as a file? Used for the PostHog marker check. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, { encoding: 'utf8', flag: 'r' })
    return true
  } catch {
    return false
  }
}

/**
 * Is this a PostHog checkout?
 *
 * TWO INDEPENDENT MARKERS, either of which is enough:
 *   - `package.json` names the package `posthog`;
 *   - `manage.py` sits beside a `posthog/settings/base.py`.
 *
 * Deliberately NOT the directory basename: a checkout at `~/src/ph` or
 * `~/work/posthog-fork` is still PostHog, and a directory someone happened to
 * call `posthog` holding something else is not.
 */
export async function looksLikePosthog(realRoot: string): Promise<boolean> {
  const manifest = await readJson(join(realRoot, 'package.json'))
  if (manifest !== null && manifest['name'] === 'posthog') return true
  if (!(await fileExists(join(realRoot, 'manage.py')))) return false
  return fileExists(join(realRoot, 'posthog', 'settings', 'base.py'))
}

/**
 * Pull a port out of one npm script's command line.
 *
 * Recognises the three spellings that actually occur in the wild:
 *   `--port 5173`  `--port=5173`  `-p 5173`  and a `PORT=5173` env prefix.
 *
 * Returns null when the script names none — which is the common case (Vite,
 * Next and CRA all default silently) and is reported as `unknown` rather than
 * filled in with the framework's default. See the module header.
 *
 * The script text is never executed, and never even split for execution: this
 * is a regex over a string that stays a string.
 */
export function portFromScript(script: string): number | null {
  const patterns = [
    /(?:^|\s)--port[\s=]+(\d{1,5})(?:\s|$)/,
    /(?:^|\s)-p[\s=]+(\d{1,5})(?:\s|$)/,
    /(?:^|\s)PORT=(\d{1,5})(?:\s|$)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(script)
    if (match === null) continue
    const port = Number(match[1])
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
  }
  return null
}

/** The scripts consulted, in order. `dev` is the modern spelling; `start` the older. */
const CANDIDATE_SCRIPTS = ['dev', 'start'] as const

interface Detected {
  url: string | null
  source: AppUrlSource
  detail: string
}

/**
 * Walk the ladder and report which rung answered. Pure detection — no probe
 * yet, so a caller (and a test) can check the decision without a socket.
 */
export async function detectAppUrl(realRoot: string, flagUrl: string | null): Promise<Detected> {
  if (flagUrl !== null) {
    return { url: flagUrl, source: 'flag', detail: `Set with --app-url ${flagUrl}.` }
  }

  if (await looksLikePosthog(realRoot)) {
    return {
      url: `http://localhost:${POSTHOG_APP_PORT}`,
      source: 'posthog',
      detail: `This is a PostHog checkout, whose dev stack is fronted at port ${POSTHOG_APP_PORT}.`,
    }
  }

  const manifest = await readJson(join(realRoot, 'package.json'))
  if (manifest === null) {
    return {
      url: null,
      source: 'unknown',
      detail:
        'No package.json here and no framework the bridge recognises, so it cannot tell where your dev server listens. Start the bridge with --app-url to say.',
    }
  }

  const scripts = manifest['scripts']
  const scriptMap =
    typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, unknown>) : {}

  const named: string[] = []
  for (const name of CANDIDATE_SCRIPTS) {
    const script = scriptMap[name]
    if (typeof script !== 'string') continue
    named.push(name)
    const port = portFromScript(script)
    if (port !== null) {
      return {
        url: `http://localhost:${port}`,
        source: 'package-json',
        detail: `The "${name}" script names port ${port}.`,
      }
    }
  }

  // A `dev` script that names no port is the ONE case where guessing is
  // tempting and wrong. Say which script was read and what was missing.
  if (named.length > 0) {
    return {
      url: null,
      source: 'unknown',
      detail: `The "${named[0]}" script names no port, so the bridge will not guess one — a wrong port would frame whatever else is listening. Start the bridge with --app-url to say where your dev server is.`,
    }
  }

  return {
    url: null,
    source: 'unknown',
    detail:
      'This package.json has no dev or start script, so the bridge cannot tell where your dev server listens. Start the bridge with --app-url to say.',
  }
}

/**
 * Is something accepting TCP connections at `url`?
 *
 * A bare connect, then an immediate destroy: no bytes are written and no HTTP
 * request is made. The question is "is your stack up", and opening a socket
 * answers it without touching whatever is on the other end — a GET could trip
 * a route, a counter, or a dev server's own reload.
 *
 * Never throws. Every failure mode — refused, unreachable, timed out, a URL
 * that will not parse — is `false`, because they all mean the same thing to
 * the user: your app is not answering there.
 */
export async function probeApp(
  url: string,
  timeoutMs: number = APP_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  // Strip the brackets IPv6 literals carry in a URL — `net` wants the bare address.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')

  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (answer: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(budget)
      socket.destroy()
      resolve(answer)
    }
    const socket = createConnection({ host, port })
    const budget = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

export interface AppStateOptions {
  /** Injected in tests so no socket is opened. */
  probe?: (url: string) => Promise<boolean>
  timeoutMs?: number
}

/**
 * The `app` block of `/v1/stack`: which rung answered, and whether it is up.
 *
 * `reachable` is false whenever `url` is null. An unprobed port cannot be
 * reported as reachable, and "unknown" must never render as the reassuring
 * answer — the same rule `parseGitState` applies to `dirty`.
 */
export async function readAppState(
  realRoot: string,
  flagUrl: string | null,
  opts: AppStateOptions = {},
): Promise<StackApp> {
  const detected = await detectAppUrl(realRoot, flagUrl)
  if (detected.url === null) {
    return { url: null, source: detected.source, reachable: false, detail: detected.detail }
  }
  const probe = opts.probe ?? ((url: string) => probeApp(url, opts.timeoutMs))
  const reachable = await probe(detected.url)
  return { url: detected.url, source: detected.source, reachable, detail: detected.detail }
}
