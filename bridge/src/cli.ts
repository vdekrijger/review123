#!/usr/bin/env node
/**
 * cli.ts — the entry point a user runs inside their repo.
 *
 * Its whole job is: parse flags, resolve the repo root, mint the pairing token,
 * bind loopback, and print the one thing the user has to copy.
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { BridgeArgError, USAGE, parseArgs, type BridgeOptions } from './args.js'
import { loadOrCreateToken } from './auth.js'
import { defaultCapabilityDeps, detectInferenceClis } from './capabilities.js'
import { resolveRepoRoot } from './confine.js'
import { REVIEW123_ORIGINS } from './cors.js'
import { PROTOCOL_VERSION } from './protocol.js'
import { createBridgeServer, listenLoopback, LOOPBACK_HOST } from './server.js'

/** Kept in step with package.json; printed in /v1/health. */
export const BRIDGE_VERSION = '0.4.0'

export async function main(argv: readonly string[], cwd: string): Promise<number> {
  let options: BridgeOptions
  try {
    options = parseArgs(argv, cwd)
  } catch (err) {
    if (err instanceof BridgeArgError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`)
      return 2
    }
    throw err
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const realRoot = await resolveRepoRoot(options.root)
  const token = await loadOrCreateToken(options.tokenFile)
  const capabilityDeps = defaultCapabilityDeps()
  const clis = await detectInferenceClis(capabilityDeps)

  const bridge = createBridgeServer({
    token,
    port: options.port,
    realRoot,
    extraOrigins: options.extraOrigins,
    version: BRIDGE_VERSION,
    capabilityDeps,
    allowWrite: options.allowWrite,
    testCommand: options.testCommand,
    noTests: options.noTests,
    allowCheckout: options.allowCheckout,
    allowPush: options.allowPush,
    appUrl: options.appUrl,
  })

  const port = await listenLoopback(bridge, options.port)

  process.stdout.write(
    banner({
      port,
      realRoot,
      token,
      clis,
      extraOrigins: options.extraOrigins,
      persistedToken: options.tokenFile !== null,
      allowWrite: options.allowWrite,
      testCommand: options.testCommand,
      noTests: options.noTests,
      allowCheckout: options.allowCheckout,
      allowPush: options.allowPush,
      appUrl: options.appUrl,
    }),
  )

  const stop = () => {
    bridge.server.close(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  // Resolve only when the server closes, so `main` models the process lifetime.
  await new Promise<void>((resolve) => bridge.server.once('close', () => resolve()))
  return 0
}

interface BannerInput {
  port: number
  realRoot: string
  token: string
  clis: string[]
  extraOrigins: string[]
  persistedToken: boolean
  allowWrite: boolean
  testCommand: string[]
  noTests: boolean
  allowCheckout: boolean
  allowPush: boolean
  appUrl: string | null
}

/**
 * The startup banner. Exported so a test can assert the token is printed
 * exactly once, on its own line, ready to copy.
 */
export function banner(input: BannerInput): string {
  const origins = [...REVIEW123_ORIGINS, 'http://localhost:*', 'http://127.0.0.1:*', ...input.extraOrigins]
  const lines = [
    '',
    `review123 bridge ${BRIDGE_VERSION}  ·  protocol v${PROTOCOL_VERSION}`,
    '',
    `  repo     ${input.realRoot}`,
    `  listen   http://${LOOPBACK_HOST}:${input.port}   (loopback only)`,
    `  CLIs     ${input.clis.length > 0 ? input.clis.join(', ') : 'none detected on PATH'}`,
    `  origins  ${origins.join('  ')}`,
    `  writes   ${input.allowWrite ? 'ENABLED (--allow-write)' : 'disabled — read-only'}`,
    // Reported as its own line, never folded into `writes`: they are separate
    // grants and a banner that implied otherwise would misinform the one
    // person who can actually change them.
    `  checkout ${input.allowCheckout ? 'ENABLED (--allow-checkout) — this bridge may switch your branch' : 'disabled — your working tree is never changed'}`,
    // The third grant gets the third line, for the same reason the second one
    // does — and this is the line that matters most, because it is the only
    // capability whose effects other people can see.
    `  push     ${input.allowPush ? 'ENABLED (--allow-push) — this bridge may write to a remote' : 'disabled — nothing ever leaves this machine'}`,
    ...(input.appUrl !== null ? [`  app      ${input.appUrl} (--app-url)`] : []),
    ...(input.allowWrite
      ? [
          `  tests    ${
            input.noTests
              ? 'never run (--no-tests)'
              : input.testCommand.length > 0
                ? `${input.testCommand.join(' ')} (--test-command)`
                : "detected from the repo's package.json"
          }`,
        ]
      : []),
    '',
    '  Paste this pairing token into review123 → Settings → Local bridge:',
    '',
    `    ${input.token}`,
    '',
    input.persistedToken
      ? '  This token is stored in --token-file and survives restarts.'
      : '  This token is new for this run. Restarting the bridge invalidates it.',
    '',
    '  While this runs, the origins above can read this repo through the bridge.',
    ...(input.allowWrite
      ? [
          '',
          '  --allow-write is ON. review123 can ask your local coding agent to fix',
          '  findings in a SCRATCH WORKTREE under your temp directory, and can run',
          "  this repo's own test command there. Your checkout, branch, index and",
          ...(input.allowPush
            ? ['  uncommitted work are never touched. Pushing is a separate grant, below.']
            : ['  uncommitted work are never touched, and nothing is ever pushed.']),
        ]
      : []),
    ...(input.allowCheckout
      ? [
          '',
          '  --allow-checkout is ON. review123 can check a pull request out HERE, in',
          '  this working tree, so the dev server you already have running serves it.',
          '  That means RUNNING the pull request\'s code. A dirty tree is refused; ',
          '  moving your uncommitted work needs a second confirmation and uses',
          '  `git stash push` — nothing is ever forced, reset or dropped, and the',
          '  branch you were on is recorded so it can always be restored.',
        ]
      : []),
    ...(input.allowPush
      ? [
          '',
          '  --allow-push is ON. THIS IS THE ONLY THING THIS TOOL DOES THAT LEAVES',
          '  YOUR MACHINE, and a push cannot be undone. review123 may ask to move one',
          '  EXISTING remote branch FORWARD to one commit, and each push needs its own',
          '  confirmation naming the remote, the branch and both commit shas.',
          '  Fast-forward only: a push that would make any commit unreachable is',
          "  refused, and there is no force anywhere in the protocol. The remote's",
          '  default branch is never pushed to, and no branch is ever created.',
          '  The bridge cannot check who authored a pull request — it has no account',
          '  and no token — so it does not claim to. Fast-forward-only is the',
          '  guarantee it can actually keep.',
        ]
      : []),
    '  Stop it with Ctrl-C when you are done.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Run only when executed directly (`node dist/cli.js`), never on import — the
 * tests import `main`/`banner` and must not start a server. realpathSync makes
 * this survive being launched through a symlinked bin shim, which is exactly
 * how `npx` and pnpm's `node_modules/.bin` invoke it.
 */
export function isDirectRun(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl
  } catch {
    return false
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2), process.cwd()).then(
    (code) => {
      if (code !== 0) process.exit(code)
    },
    (err: unknown) => {
      process.stderr.write(`review123-bridge failed to start: ${(err as Error).message}\n`)
      process.exit(1)
    },
  )
}
