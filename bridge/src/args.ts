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
  /**
   * `--allow-checkout` — the switch that lets `/v1/checkout` and `/v1/restore`
   * exist, i.e. the ONLY way the bridge may move the user's own working tree.
   *
   * DELIBERATELY NOT `--allow-write`. That flag grants the fix loop, which
   * works exclusively in an isolated scratch worktree and never goes near the
   * user's checkout. This one switches the branch under a running dev stack.
   * Someone who wanted agent fixes must not silently also get branch
   * switching, so the grants are separate and neither implies the other.
   *
   * Like `--allow-write` it is a COMMAND-LINE flag and nothing else: no request
   * field, no header, no settings file, no browser affordance can turn it on.
   * It lives for the process and dies with Ctrl-C.
   */
  allowCheckout: boolean
  /**
   * `--allow-push` — the switch that lets `/v1/push` exist, i.e. the ONLY way
   * anything this package does can leave the machine.
   *
   * A THIRD GRANT, implied by neither of the other two and implying neither.
   * That is not symmetry for its own sake. `--allow-write` and
   * `--allow-checkout` both authorise LOCAL changes the person who granted them
   * can undo: delete a scratch worktree, restore a branch. A push cannot be
   * undone by anyone — the moment it lands, everybody who can see the
   * repository can see it. Someone who wanted agent fixes, or wanted a pull
   * request checked out under their dev server, must not discover that they
   * also handed a web origin the ability to write to their team's remote.
   *
   * Like its siblings it is a COMMAND-LINE flag and nothing else: no request
   * field, no header, no settings file, no browser affordance can turn it on.
   * It lives for the process and dies with Ctrl-C.
   */
  allowPush: boolean
  /**
   * `--app-url` — where the user's dev server is, when they know and the
   * bridge could not work it out.
   *
   * Restricted to a LOOPBACK http(s) origin at parse time. The bridge opens a
   * TCP connection to this address to report whether the stack is up, and a
   * bridge that could be pointed at an arbitrary host would be a probe for
   * whatever else the machine can reach. Empty → detect (see appUrl.ts).
   */
  appUrl: string | null
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
  --allow-checkout     Enable POST /v1/checkout and /v1/restore: let review123
                       check a pull request out IN THIS CHECKOUT, so the dev
                       stack you already have running serves it. SEPARATE from
                       --allow-write, which does NOT enable this. A dirty tree
                       is refused outright; moving your uncommitted work needs
                       a second, explicit confirmation and uses git stash push
                       (never a force, a reset or a drop). The branch you were
                       on is recorded first, so it can always be restored.
  --allow-push         Enable POST /v1/push: let review123 move ONE existing
                       remote branch FORWARD to one commit, after you confirm
                       the exact move. THE ONLY THING THIS TOOL DOES THAT
                       LEAVES YOUR MACHINE, and it cannot be undone. Separate
                       from --allow-write and --allow-checkout; neither enables
                       it. Fast-forward only — a push that would drop commits
                       is refused, and there is no force anywhere in the
                       protocol. Never the remote's default branch. The branch
                       must already exist on the remote. Without this flag the
                       route answers 403 and capabilities.push is false.
  --app-url <url>      Where your dev server listens, e.g. http://localhost:8010.
                       Must be a loopback address. Default: detected from the
                       repo (PostHog → 8010; else a dev/start script's port).
  -h, --help           Show this help.

The bridge binds 127.0.0.1 only and requires the printed pairing token on every
request. It grants the allowed web origin READ access to the repo it is started
in, for as long as it runs — and, with --allow-write, the ability to ask your
local coding agent for fixes in an isolated worktree. With --allow-push it may
additionally move one existing remote branch forward, fast-forward only, once
per explicit confirmation.`

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
    allowCheckout: false,
    allowPush: false,
    appUrl: null,
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
      case '--allow-checkout':
        options.allowCheckout = true
        break
      case '--allow-push':
        options.allowPush = true
        break
      case '--app-url':
        options.appUrl = parseAppUrl(takeValue(argv, (i += 1), '--app-url'))
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

/**
 * Loopback hostnames `--app-url` may name.
 *
 * The bridge OPENS A TCP CONNECTION to this address to report whether the dev
 * stack is up. Allowing an arbitrary host would turn a local convenience into
 * a port scanner for whatever else the machine can reach — the user's router,
 * a cloud metadata endpoint, an internal service. Loopback only, and no DNS
 * name that could resolve anywhere else.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Parse `--app-url` into a bare origin.
 *
 * Path, query and hash are DROPPED rather than refused: a user pasting
 * `http://localhost:8010/project/1` means "my app is on 8010", and silently
 * keeping the path would make the preview panel open one deep link forever.
 */
function parseAppUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BridgeArgError(`--app-url must be a URL like http://localhost:8010, got: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeArgError(`--app-url must be http or https, got: ${raw}`)
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new BridgeArgError(
      `--app-url must point at this machine (localhost or 127.0.0.1) — the bridge connects to it to check whether your dev server is up. Got: ${url.hostname}`,
    )
  }
  return url.origin
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
