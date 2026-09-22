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
      // Write capability is OFF unless the user typed --allow-write. This
      // assertion is the default half of the whole safety model.
      allowWrite: false,
      testCommand: [],
      noTests: false,
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

// ---------------------------------------------------------------------------
// --allow-write: the whole authorisation model for writing, in one flag.
// ---------------------------------------------------------------------------

describe('--allow-write', () => {
  it('is OFF unless it is typed', () => {
    expect(parseArgs([], CWD).allowWrite).toBe(false)
    expect(parseArgs(['--port', '9000'], CWD).allowWrite).toBe(false)
  })

  it('turns write capability on, and takes no value that could be forged', () => {
    expect(parseArgs(['--allow-write'], CWD).allowWrite).toBe(true)
    // It is a bare switch: there is no `--allow-write=false` half-state and no
    // value a script could pass through from somewhere else.
    expect(() => parseArgs(['--allow-write=true'], CWD)).toThrow(BridgeArgError)
  })

  it('is documented in the usage text, with what it grants', () => {
    expect(USAGE).toMatch(/--allow-write/)
    expect(USAGE).toMatch(/SCRATCH GIT WORKTREE/)
    expect(USAGE).toMatch(/never touched/)
    expect(USAGE).toMatch(/nothing is pushed/i)
  })
})

describe('--test-command / --no-tests', () => {
  it('splits a plain command into argv', () => {
    expect(parseArgs(['--test-command', 'pnpm test'], CWD).testCommand).toEqual(['pnpm', 'test'])
    expect(parseArgs(['--test-command', '  npm   run   ci  '], CWD).testCommand).toEqual(['npm', 'run', 'ci'])
  })

  it('REFUSES shell syntax rather than silently running half of it', () => {
    // The command is spawned with an argv array and no shell, so `&&` would
    // never run the second half. Failing loudly beats misleading the user.
    for (const bad of ['pnpm test && pnpm lint', 'pnpm test | tee out', 'rm -rf $HOME', 'a; b', 'echo `id`']) {
      expect(() => parseArgs(['--test-command', bad], CWD)).toThrow(BridgeArgError)
    }
  })

  it('refuses an empty command', () => {
    expect(() => parseArgs(['--test-command', '   '], CWD)).toThrow(BridgeArgError)
  })

  it('--no-tests is a bare switch, off by default', () => {
    expect(parseArgs([], CWD).noTests).toBe(false)
    expect(parseArgs(['--no-tests'], CWD).noTests).toBe(true)
  })
})
