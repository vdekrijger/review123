/**
 * capabilities.ts — what this machine can do, discovered WITHOUT running
 * anything.
 *
 * Detection is a PATH scan for an executable file, not a `which` subprocess and
 * certainly not a model call:
 *   - spawning nothing keeps the "no arbitrary command execution" invariant
 *     honest at startup as well as at request time;
 *   - a `/v1/health` probe stays a few stat() calls, so the browser can poll it
 *     cheaply;
 *   - probing a CLI by RUNNING it would burn the user's subscription quota just
 *     to render a settings page.
 *
 * AUTHENTICATION STATE IS DELIBERATELY NOT REPORTED. The only cheap signals are
 * "a credentials file exists" or "an API-key env var is set", and both lie
 * routinely (expired sessions, keys for a different account, credential helpers
 * that keep nothing on disk). The protocol would rather say nothing than guess;
 * a real answer costs a CLI invocation and belongs to the inference PR.
 */

import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { BridgeCapabilities } from './protocol.js'

/** The local CLIs the bridge knows how to drive. Hard-coded on purpose. */
export const INFERENCE_CLIS = ['claude', 'codex'] as const

export type InferenceCli = (typeof INFERENCE_CLIS)[number]

/** Injectable environment + filesystem probe, so tests need no real PATH. */
export interface CapabilityDeps {
  env: NodeJS.ProcessEnv
  isExecutable: (path: string) => Promise<boolean>
}

/** Real probe: an existing regular file with the execute bit for this user. */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const st = await stat(path)
    if (!st.isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function defaultCapabilityDeps(env: NodeJS.ProcessEnv = process.env): CapabilityDeps {
  return { env, isExecutable: isExecutableFile }
}

/**
 * Is `bin` an executable on PATH?
 *
 * Empty PATH entries are skipped rather than treated as "." — resolving a bare
 * name against the CWD is the classic PATH-injection footgun.
 */
export async function findOnPath(bin: string, deps: CapabilityDeps): Promise<boolean> {
  const raw = deps.env['PATH'] ?? ''
  for (const dir of raw.split(delimiter)) {
    if (dir === '') continue
    if (await deps.isExecutable(join(dir, bin))) return true
  }
  return false
}

/** Which of the known CLIs are installed, in INFERENCE_CLIS order. */
export async function detectInferenceClis(deps: CapabilityDeps): Promise<string[]> {
  const found: string[] = []
  for (const cli of INFERENCE_CLIS) {
    if (await findOnPath(cli, deps)) found.push(cli)
  }
  return found
}

/**
 * The full capability block for `/v1/health`.
 *
 * `infer`, `files` and `search` are route-READINESS flags. Each flips in the
 * same commit that implements its route, so a client that trusts the flag can
 * never call a route that is not there. All three are true as of the grounding
 * PR — every v1 route is implemented.
 *
 * `search` is true whether or not `ripgrep` is installed: the route always
 * answers, falling back to a bounded JS walk. The flag reports whether the
 * ROUTE exists, never how fast it will be — conflating the two would make a
 * client refuse a search that works.
 *
 * `infer` is TRUE EVEN WHEN NO CLI IS DETECTED, and that is not a bug: the two
 * signals answer different questions. `infer` says "this bridge understands the
 * route"; `inference` says "and here is what it could run". A client needs
 * both, and gets a precise `cli-unavailable` error instead of a confusing 501
 * when it asks for a CLI that is not installed.
 */
export async function detectCapabilities(deps: CapabilityDeps): Promise<BridgeCapabilities> {
  return {
    inference: await detectInferenceClis(deps),
    infer: true,
    files: true,
    search: true,
  }
}
