/**
 * main.test.ts — the app-start wiring.
 *
 * `main.ts` has no exports and runs its side effects on import, so this suite
 * imports it with every side effect mocked and asserts WHICH ones fire. It
 * exists for one reason: the local bridge's silent probe moved from the
 * Settings section to app start when inference began routing through it, and
 * a review can start long before Settings is ever opened.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mount = vi.fn()
const initAnalytics = vi.fn()
const applyAppearance = vi.fn()
const initBridge = vi.fn(async () => {})

vi.mock('svelte', () => ({ mount }))
vi.mock('./App.svelte', () => ({ default: {} }))
vi.mock('./app.css', () => ({}))
vi.mock('./lib/analytics/analytics', () => ({ initAnalytics }))
vi.mock('./lib/settings/appearance.svelte', () => ({ applyAppearance }))
vi.mock('./lib/bridge/bridge.svelte', () => ({ initBridge }))

// The font packages are pure CSS side-effect imports with nothing to assert.
// Listed one per line because vi.mock is hoisted and cannot take a variable.
vi.mock('@fontsource/ibm-plex-sans/400.css', () => ({}))
vi.mock('@fontsource/ibm-plex-sans/500.css', () => ({}))
vi.mock('@fontsource/ibm-plex-sans/600.css', () => ({}))
vi.mock('@fontsource/ibm-plex-mono/400.css', () => ({}))
vi.mock('@fontsource/ibm-plex-mono/500.css', () => ({}))
vi.mock('@fontsource/newsreader/400.css', () => ({}))
vi.mock('@fontsource/newsreader/400-italic.css', () => ({}))
vi.mock('@fontsource/newsreader/500.css', () => ({}))

beforeEach(() => {
  vi.resetModules()
  mount.mockClear()
  initAnalytics.mockClear()
  applyAppearance.mockClear()
  initBridge.mockClear()
  document.body.innerHTML = '<div id="app"></div>'
})

describe('main.ts — app start', () => {
  it('probes the local bridge at app start, not only when Settings is opened', async () => {
    await import('./main')
    expect(initBridge).toHaveBeenCalledTimes(1)
  })

  it('does not block the mount on the probe', async () => {
    // initBridge returns a promise that main must NOT await: a bridge that is
    // slow to refuse a connection would otherwise delay first paint for
    // everyone who ever paired one.
    let resolveProbe: () => void = () => {}
    initBridge.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveProbe = resolve }),
    )

    await import('./main')

    expect(mount).toHaveBeenCalledTimes(1)
    resolveProbe()
  })

  it('still initialises analytics and appearance', async () => {
    await import('./main')
    expect(initAnalytics).toHaveBeenCalledTimes(1)
    expect(applyAppearance).toHaveBeenCalledTimes(1)
  })

  it('mounts the app into #app', async () => {
    await import('./main')
    expect(mount.mock.calls[0]![1]).toEqual({ target: document.getElementById('app') })
  })
})
