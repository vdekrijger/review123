// @vitest-environment node
/**
 * appUrl.test.ts — the dev-server detection ladder and the probe.
 *
 * The rungs are exercised against REAL temp directories rather than a mocked
 * filesystem: the whole point of the ladder is which files it finds, and a
 * mock that returns whatever the test says would assert nothing about that.
 * The socket probe is exercised against a real listening server for the same
 * reason — "is something on this port" has exactly one honest implementation.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  POSTHOG_APP_PORT,
  detectAppUrl,
  looksLikePosthog,
  portFromScript,
  probeApp,
  readAppState,
} from './appUrl.js'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-appurl-'))
}

async function writeManifest(root: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest), 'utf8')
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  )
})

/** Start a throwaway loopback server and return its port. */
function listen(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('ok'))
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

// ---------------------------------------------------------------------------
// portFromScript — the one piece of parsing, in isolation
// ---------------------------------------------------------------------------

describe('portFromScript', () => {
  it('reads --port in both spellings', () => {
    expect(portFromScript('vite --port 5000')).toBe(5000)
    expect(portFromScript('vite --port=5000')).toBe(5000)
  })

  it('reads the -p short form', () => {
    expect(portFromScript('http-server -p 8080')).toBe(8080)
  })

  it('reads a PORT= environment prefix', () => {
    expect(portFromScript('PORT=4321 node server.js')).toBe(4321)
  })

  it('returns null when the script names NO port — the case we refuse to guess', () => {
    expect(portFromScript('vite')).toBeNull()
    expect(portFromScript('next dev')).toBeNull()
    expect(portFromScript('react-scripts start')).toBeNull()
  })

  it('does not mistake an unrelated number for a port', () => {
    expect(portFromScript('vite --host --strictPort')).toBeNull()
    expect(portFromScript('node --max-old-space-size=4096 server.js')).toBeNull()
  })

  it('refuses an out-of-range port rather than returning a nonsense URL', () => {
    expect(portFromScript('vite --port 0')).toBeNull()
    expect(portFromScript('vite --port 99999')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PostHog detection — by MARKER FILES, never by directory name
// ---------------------------------------------------------------------------

describe('looksLikePosthog', () => {
  it('detects a checkout whose package.json names the package posthog', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'posthog' })
    expect(await looksLikePosthog(root)).toBe(true)
  })

  it('detects a checkout by its Django markers, with no package.json name', async () => {
    const root = await scratch()
    await writeFile(join(root, 'manage.py'), '#!/usr/bin/env python\n', 'utf8')
    await mkdir(join(root, 'posthog', 'settings'), { recursive: true })
    await writeFile(join(root, 'posthog', 'settings', 'base.py'), 'DEBUG = True\n', 'utf8')
    expect(await looksLikePosthog(root)).toBe(true)
  })

  it('is NOT fooled by a directory that merely has a manage.py', async () => {
    const root = await scratch()
    await writeFile(join(root, 'manage.py'), '#!/usr/bin/env python\n', 'utf8')
    expect(await looksLikePosthog(root)).toBe(false)
  })

  it('says no for an ordinary repo', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'something-else', scripts: { dev: 'vite' } })
    expect(await looksLikePosthog(root)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The ladder — each rung, and the rung ORDER
// ---------------------------------------------------------------------------

describe('detectAppUrl', () => {
  it('rung 1: --app-url beats everything, including a PostHog checkout', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'posthog' })
    const detected = await detectAppUrl(root, 'http://localhost:9999')
    expect(detected).toEqual({
      url: 'http://localhost:9999',
      source: 'flag',
      detail: expect.stringContaining('--app-url'),
    })
  })

  it('rung 2: a PostHog checkout resolves to the fixed 8010', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'posthog' })
    const detected = await detectAppUrl(root, null)
    expect(detected.url).toBe(`http://localhost:${POSTHOG_APP_PORT}`)
    expect(detected.source).toBe('posthog')
  })

  it('rung 2 beats rung 3: PostHog wins over its own package.json dev script', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'posthog', scripts: { dev: 'vite --port 5173' } })
    const detected = await detectAppUrl(root, null)
    expect(detected.source).toBe('posthog')
    expect(detected.url).toBe('http://localhost:8010')
  })

  it('rung 3: a dev script that names a port', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'app', scripts: { dev: 'vite --port 4000' } })
    const detected = await detectAppUrl(root, null)
    expect(detected).toEqual({
      url: 'http://localhost:4000',
      source: 'package-json',
      detail: expect.stringContaining('4000'),
    })
  })

  it('rung 3 prefers "dev" over "start" when both name a port', async () => {
    const root = await scratch()
    await writeManifest(root, {
      scripts: { dev: 'vite --port 4000', start: 'node server.js --port 5000' },
    })
    expect((await detectAppUrl(root, null)).url).toBe('http://localhost:4000')
  })

  it('rung 3 falls through to "start" when "dev" names no port', async () => {
    const root = await scratch()
    await writeManifest(root, { scripts: { dev: 'vite', start: 'node server.js --port 5000' } })
    expect((await detectAppUrl(root, null)).url).toBe('http://localhost:5000')
  })

  // THE RUNG THAT MATTERS MOST. A confident wrong answer here would frame
  // whatever else happens to be on 5173 and present it as this pull request.
  it('rung 4: a dev script with NO port is unknown — it does not guess 5173', async () => {
    const root = await scratch()
    await writeManifest(root, { scripts: { dev: 'vite' } })
    const detected = await detectAppUrl(root, null)
    expect(detected.url).toBeNull()
    expect(detected.source).toBe('unknown')
    expect(detected.detail).toMatch(/names no port/)
    expect(detected.detail).toMatch(/--app-url/)
  })

  it('rung 4: no dev or start script at all is unknown, and says which', async () => {
    const root = await scratch()
    await writeManifest(root, { scripts: { build: 'tsc' } })
    const detected = await detectAppUrl(root, null)
    expect(detected.url).toBeNull()
    expect(detected.source).toBe('unknown')
    expect(detected.detail).toMatch(/no dev or start script/)
  })

  it('rung 4: no package.json at all is unknown, not an error', async () => {
    const detected = await detectAppUrl(await scratch(), null)
    expect(detected.url).toBeNull()
    expect(detected.source).toBe('unknown')
  })

  it('a corrupt package.json is unknown, never a crash', async () => {
    const root = await scratch()
    await writeFile(join(root, 'package.json'), '{ not json', 'utf8')
    const detected = await detectAppUrl(root, null)
    expect(detected.source).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

describe('probeApp', () => {
  it('reports a real listening server as reachable', async () => {
    const port = await listen()
    expect(await probeApp(`http://127.0.0.1:${port}`)).toBe(true)
  })

  it('reports a closed port as unreachable rather than throwing', async () => {
    // Bind and immediately release, so the port is real but nothing is on it.
    const port = await listen()
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()))
    expect(await probeApp(`http://127.0.0.1:${port}`)).toBe(false)
  })

  it('reports a URL that will not parse as unreachable, never a crash', async () => {
    expect(await probeApp('not a url')).toBe(false)
  })

  it('gives up inside its budget instead of hanging the health probe', async () => {
    // 198.51.100.0/24 is TEST-NET-2: reserved, routed nowhere, so the connect
    // hangs rather than being refused — exactly what the budget exists for.
    const started = Date.now()
    expect(await probeApp('http://198.51.100.1:9', 150)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

// ---------------------------------------------------------------------------
// readAppState — the assembled answer
// ---------------------------------------------------------------------------

describe('readAppState', () => {
  it('reports a detected, reachable stack', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'posthog' })
    const state = await readAppState(root, null, { probe: async () => true })
    expect(state).toEqual({
      url: 'http://localhost:8010',
      source: 'posthog',
      reachable: true,
      detail: expect.any(String),
    })
  })

  it('reports a detected but UNREACHABLE stack — not an error, just not running', async () => {
    const root = await scratch()
    await writeManifest(root, { name: 'posthog' })
    const state = await readAppState(root, null, { probe: async () => false })
    expect(state.url).toBe('http://localhost:8010')
    expect(state.reachable).toBe(false)
  })

  // "Unknown" must never render as the reassuring answer — the same rule
  // parseGitState applies to `dirty`.
  it('never reports reachable when there is no URL to probe', async () => {
    const root = await scratch()
    await writeManifest(root, { scripts: { dev: 'vite' } })
    const state = await readAppState(root, null, { probe: async () => true })
    expect(state.url).toBeNull()
    expect(state.reachable).toBe(false)
  })

  it('does not probe at all when nothing was detected', async () => {
    const root = await scratch()
    let probes = 0
    await readAppState(root, null, {
      probe: async () => {
        probes += 1
        return true
      },
    })
    expect(probes).toBe(0)
  })
})
