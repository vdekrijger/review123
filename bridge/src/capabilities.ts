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
 * `infer`, `inferStream`, `files` and `search` are route-READINESS flags. Each
 * flips in the same commit that implements its route, so a client that trusts
 * the flag can never call a route that is not there. All four are true as of
 * the streaming PR — every v1 route is implemented.
 *
 * `inferStream` reports that `/v1/infer/stream` EXISTS, not that every CLI
 * streams through it: `claude` emits text as the model produces it, `codex`
 * has no incremental output and the route says so per call in its `start`
 * event. A single flag conflating "the route is here" with "your CLI types
 * out" would let a client promise the user something codex cannot do.
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
 *
 * `inferAgentic` is a READINESS flag of the same kind: it says this build
 * understands `InferRequest.agentic`, the flag that runs the CLI with its own
 * read-only tools. It is NOT a grant and has no `--allow-*` switch, because
 * what it enables is reading — the same reading `/v1/files` and `/v1/search`
 * already do, done by the CLI instead of by us. It is flipped here rather than
 * inferred by a client, because an older bridge silently IGNORES the request
 * field and returns a good tool-less answer that a client would otherwise
 * mistake for a grounded one.
 *
 * `commits` is a READINESS flag of the same kind as `inferAgentic`, and for the
 * same reason: it says this build understands `POST /v1/commits`, the probe
 * that answers "is this commit in the object store?". It has no `--allow-*`
 * switch because what it enables is a `rev-parse` — reading ids that are
 * already on disk. It is reported rather than inferred because an older bridge
 * answers that route with a plain 404, and a client that did not check would
 * read the 404 as "the commit is absent" for every commit in the queue.
 *
 * `fix` IS DIFFERENT FROM ALL FOUR. It is not "true from the release that
 * implements the route" — it is `allowWrite`, i.e. whether the person at the
 * terminal started this process with `--allow-write`. The flag is the entire
 * authorisation model for writing, so the capability has to report the flag
 * and nothing else. A build that hard-coded `fix: true` here would hand every
 * paired web origin a write button the user never granted.
 *
 * `push` IS THE THIRD OF THESE, AND THE ONLY ONE WHOSE SUBJECT IS NOT THIS
 * MACHINE. It reports `--allow-push`. The other two grants authorise changes
 * the person who granted them can undo; this one authorises a change nobody can
 * undo, because it is visible to everyone with read access the moment it lands.
 * So it is read from a THIRD argument, and a process started with both of the
 * others still reports `push: false`. Deriving it from either would hand
 * somebody a remote-write capability as a side effect of wanting a local one.
 *
 * `checkout` IS THE SAME KIND OF FLAG AS `fix`, AND A DIFFERENT ONE FROM IT.
 * It reports `--allow-checkout` — the grant to move the user's OWN working
 * tree — and it is read from a separate argument for a reason that is the
 * whole point of this capability: someone who started the bridge with
 * `--allow-write` to get agent fixes must not discover that they also handed
 * the browser the ability to switch their branch. Two risks, two grants, two
 * booleans. Passing `allowWrite` to both parameters would collapse the
 * distinction the flag exists to make.
 */
export async function detectCapabilities(
  deps: CapabilityDeps,
  allowWrite: boolean,
  allowCheckout: boolean,
  allowPush: boolean,
): Promise<BridgeCapabilities> {
  return {
    inference: await detectInferenceClis(deps),
    infer: true,
    inferStream: true,
    inferAgentic: true,
    files: true,
    search: true,
    commits: true,
    fix: allowWrite,
    checkout: allowCheckout,
    push: allowPush,
  }
}
