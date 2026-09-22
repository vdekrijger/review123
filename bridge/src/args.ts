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
  -h, --help           Show this help.

The bridge binds 127.0.0.1 only and requires the printed pairing token on every
request. It grants the allowed web origin READ access to the repo it is started
in, for as long as it runs.`

/** Parse argv (WITHOUT the node/script entries). Throws BridgeArgError. */
export function parseArgs(argv: readonly string[], cwd: string): BridgeOptions {
  const options: BridgeOptions = {
    port: DEFAULT_PORT,
    root: cwd,
    tokenFile: null,
    extraOrigins: [],
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
