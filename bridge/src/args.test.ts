// @vitest-environment node
/**
 * args.test.ts — flag parsing.
 */
import { describe, it, expect } from 'vitest'
import { BridgeArgError, USAGE, parseArgs } from './args.js'
import { DEFAULT_PORT } from './protocol.js'

const CWD = '/work/repo'

describe('parseArgs defaults', () => {
  it('binds the default port and serves the current directory', () => {
    expect(parseArgs([], CWD)).toEqual({
      port: DEFAULT_PORT,
      root: CWD,
      tokenFile: null,
      extraOrigins: [],
      help: false,
    })
  })

  it('pins the default port at 7321', () => {
    expect(DEFAULT_PORT).toBe(7321)
  })
})

describe('parseArgs flags', () => {
  it('parses --port', () => {
    expect(parseArgs(['--port', '9000'], CWD).port).toBe(9000)
  })

  it('resolves --root against the cwd', () => {
    expect(parseArgs(['--root', '../other'], CWD).root).toBe('/work/other')
    expect(parseArgs(['--root', '/abs/repo'], CWD).root).toBe('/abs/repo')
  })

  it('resolves --token-file against the cwd', () => {
    expect(parseArgs(['--token-file', '.bridge-token'], CWD).tokenFile).toBe('/work/repo/.bridge-token')
  })

  it('accumulates repeatable --allow-origin values', () => {
    const options = parseArgs(
      ['--allow-origin', 'https://a.test', '--allow-origin', 'http://b.test:8080'],
      CWD,
    )
    expect(options.extraOrigins).toEqual(['https://a.test', 'http://b.test:8080'])
  })

  it('accepts -h / --help', () => {
    expect(parseArgs(['-h'], CWD).help).toBe(true)
    expect(parseArgs(['--help'], CWD).help).toBe(true)
  })
})

describe('parseArgs rejections', () => {
  it.each([
    ['an unknown flag', ['--bind', '0.0.0.0']],
    ['a non-numeric port', ['--port', 'abc']],
    ['port 0 (nobody can paste an ephemeral port)', ['--port', '0']],
    ['an out-of-range port', ['--port', '70000']],
    ['--port with no value', ['--port']],
    ['--root with no value', ['--root', '--port']],
    ['--allow-origin with a path', ['--allow-origin', 'https://a.test/x']],
    ['--allow-origin with a trailing slash', ['--allow-origin', 'https://a.test/']],
    ['--allow-origin as a wildcard', ['--allow-origin', '*']],
    ['--allow-origin with a non-web scheme', ['--allow-origin', 'file://']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseArgs(argv as string[], CWD)).toThrow(BridgeArgError)
  })

  it('there is NO flag to change the bind address', () => {
    // Loopback-only is an invariant, not a preference.
    expect(USAGE).not.toMatch(/--host|--bind|0\.0\.0\.0/)
    expect(() => parseArgs(['--host', '0.0.0.0'], CWD)).toThrow(BridgeArgError)
  })
})
