/**
 * args.ts — flag parsing, as a pure function over argv.
 *
 * Kept separate from cli.ts so every flag (and every rejection) is unit-tested
 * without spawning a process.
 */

import { resolve } from 'node:path'
import { DEFAULT_PORT } from './protocol.js'

export interface BridgeOptions {
  port: number
  /** Absolute, but NOT yet realpath'd — confine.resolveRepoRoot does that. */
  root: string
  tokenFile: string | null
  /** `--allow-origin`, repeatable. ADDITIVE to the built-in allowlist. */
  extraOrigins: string[]
  /**
   * `--allow-write` — the ONE switch that lets `/v1/fix` exist.
   *
   * It is a COMMAND-LINE flag and nothing else. There is deliberately no
   * request field, no header, no settings file and no browser affordance that
   * can turn it on: write capability is granted by the person sitting at the
   * terminal, for the lifetime of that process, and it dies with Ctrl-C.
   */
  allowWrite: boolean
  /**
   * `--test-command` — the argv the fix loop runs to check its own work,
   * overriding detection from `package.json`.
   *
   * It lives HERE, next to `--allow-write`, for exactly the same reason: a
   * command supplied by a web origin would be arbitrary command execution, no
   * matter how carefully it were spelled. Empty → detect.
   */
  testCommand: string[]
  /** `--no-tests` — never run a test command at all. */
  noTests: boolean
  help: boolean
}

export class BridgeArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeArgError'
  }
}

const MAX_PORT = 65535

export const USAGE = `review123-bridge — optional local bridge for https://review123.dev

Usage: review123-bridge [options]

Options:
  --port <n>           Port to bind on 127.0.0.1 (default: ${DEFAULT_PORT})
  --root <dir>         Repo to serve (default: the current directory)
  --token-file <path>  Reuse/store the pairing token here instead of minting a
                       fresh one per run. Created with mode 0600.
  --allow-origin <o>   Additional exact origin allowed to call the bridge.
                       Repeatable. Added to https://review123.dev and the
                       http://localhost / http://127.0.0.1 dev origins.
  --allow-write        Enable POST /v1/fix: hand review findings to your local
                       coding agent, which fixes them in a SCRATCH GIT WORKTREE
                       and hands back one commit per finding. Your checkout,
                       branch, index and uncommitted work are never touched and
                       nothing is pushed. Without this flag the route answers
                       403 and capabilities.fix is false.
  --test-command <cmd> What /v1/fix runs to check its own work, e.g.
                       "pnpm test". Split on spaces and run WITHOUT a shell.
                       Default: detected from the repo's package.json.
  --no-tests           Never run a test command during /v1/fix.
  -h, --help           Show this help.

The bridge binds 127.0.0.1 only and requires the printed pairing token on every
request. It grants the allowed web origin READ access to the repo it is started
in, for as long as it runs — and, with --allow-write, the ability to ask your
local coding agent for fixes in an isolated worktree.`

/** Parse argv (WITHOUT the node/script entries). Throws BridgeArgError. */
export function parseArgs(argv: readonly string[], cwd: string): BridgeOptions {
  const options: BridgeOptions = {
    port: DEFAULT_PORT,
    root: cwd,
    tokenFile: null,
    extraOrigins: [],
    allowWrite: false,
    testCommand: [],
    noTests: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--port':
        options.port = parsePort(takeValue(argv, (i += 1), '--port'))
        break
      case '--root':
        options.root = resolve(cwd, takeValue(argv, (i += 1), '--root'))
        break
      case '--token-file':
        options.tokenFile = resolve(cwd, takeValue(argv, (i += 1), '--token-file'))
        break
      case '--allow-origin':
        options.extraOrigins.push(parseOrigin(takeValue(argv, (i += 1), '--allow-origin')))
        break
      case '--allow-write':
        options.allowWrite = true
        break
      case '--test-command':
        options.testCommand = parseTestCommand(takeValue(argv, (i += 1), '--test-command'))
        break
      case '--no-tests':
        options.noTests = true
        break
      default:
        throw new BridgeArgError(`Unknown option: ${arg}`)
    }
  }

  return options
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new BridgeArgError(`${flag} needs a value`)
  }
  return value
}

/**
 * Characters that only mean something to a SHELL. The bridge spawns the test
 * command with an argv array and `shell: false`, so none of them would ever be
 * interpreted — but a user who wrote `--test-command "pnpm test && pnpm lint"`
 * and silently got only the first half would be misled about what ran. Refuse
 * loudly instead.
 */
const SHELL_METACHARACTERS = /[;&|<>$`(){}[\]\\!*?~\n\r"']/

/**
 * Split `--test-command` into argv on whitespace, with no shell anywhere.
 *
 * Deliberately dumb: there is no quoting, no globbing and no substitution,
 * because supporting any of them would mean implementing a shell — and the one
 * promise this whole package makes is that it never runs one.
 */
function parseTestCommand(raw: string): string[] {
  if (SHELL_METACHARACTERS.test(raw)) {
    throw new BridgeArgError(
      `--test-command is run without a shell, so shell syntax cannot work. Use a plain command like "pnpm test", or point it at a script. Got: ${raw}`,
    )
  }
  const parts = raw.trim().split(/\s+/).filter((p) => p !== '')
  if (parts.length === 0) throw new BridgeArgError('--test-command needs a command')
  return parts
}

function parsePort(raw: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw new BridgeArgError(`--port must be a number, got: ${raw}`)
  const port = Number(raw)
  // 0 would ask the OS for an ephemeral port, which nobody can then paste into
  // the browser; refuse it rather than surprise the user.
  if (port < 1 || port > MAX_PORT) throw new BridgeArgError(`--port must be 1-${MAX_PORT}, got: ${raw}`)
  return port
}

/**
 * An extra origin must be a real ORIGIN: scheme + host [+ port], nothing else.
 * A value with a path, a trailing slash, or a wildcard would never match the
 * exact comparison in cors.ts — failing loudly here beats a silent no-op.
 */
function parseOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BridgeArgError(`--allow-origin must be an origin like https://example.test, got: ${raw}`)
  }
  if (url.origin === 'null' || raw !== url.origin) {
    throw new BridgeArgError(
      `--allow-origin must be exactly scheme://host[:port] with no path, got: ${raw}`,
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeArgError(`--allow-origin must be http or https, got: ${raw}`)
  }
  return url.origin
}
