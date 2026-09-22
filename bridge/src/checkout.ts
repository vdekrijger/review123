/**
 * checkout.ts — check a pull request out IN THE USER'S OWN WORKING TREE, and
 * put it back afterwards.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROMISE THIS FILE MAKES, AND THE ONE IT DOES NOT
 *
 * `worktree.ts` promises the user's checkout is NEVER touched. That promise
 * belongs to the fix loop and it still holds, exactly as written: the fix loop
 * works in an isolated scratch worktree and nothing in this file is reachable
 * from it.
 *
 * This file makes a DIFFERENT promise, because its entire job is to move the
 * user's tree so the dev stack they already have running serves the pull
 * request they are reading. The promise here is not "nothing moves". It is:
 *
 *   NOTHING IS EVER DESTROYED, AND YOU CAN ALWAYS GET BACK.
 *
 * Which decomposes into four rules this module enforces mechanically:
 *
 *   1. A DIRTY TREE IS REFUSED. Not stashed helpfully, not merged, not
 *      carried over — refused, with the list of files, until the caller comes
 *      back with an explicit, separate confirmation.
 *   2. THE ONLY WAY WORK MOVES IS `git stash push -u`, on that confirmation,
 *      and the entry's SHA is recorded. Restoring uses `git stash apply` and
 *      never `pop`, so the entry survives a failed restore and stays the
 *      user's to drop.
 *   3. THERE IS NO FORCE ANYWHERE. Grep this file: no `--force`, no
 *      `reset --hard`, no `clean`, no `stash drop`, no `checkout -f`, no `-B`.
 *      When git refuses a checkout, that refusal is reported to the user
 *      verbatim — it is git protecting their work, which is the correct
 *      outcome, not an obstacle to route around.
 *   4. WHERE THEY WERE IS RECORDED BEFORE ANYTHING MOVES, and persisted
 *      OUTSIDE the repo so it survives a bridge restart. A user whose terminal
 *      died must never be stranded on a PR ref with no record of home.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * DETACHED HEAD, ON PURPOSE. The checkout lands on a detached HEAD at the
 * fetched commit rather than creating a local branch. It creates no ref, so
 * there is nothing left behind to clean up and nothing that could collide with
 * a branch the user already has — and "delete the branch afterwards" would be
 * a destroying operation this module refuses to own.
 *
 * SUBPROCESS RULES, same as gitState.ts, worktree.ts and infer.ts: `spawn`
 * with an argv ARRAY, never a shell, never `exec`. Every argv element is a
 * hard-coded literal, a pattern-validated ref or remote, or a 40-hex sha this
 * module read from git itself.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CHECKOUT_FETCH_TIMEOUT_MS,
  CHECKOUT_GIT_TIMEOUT_MS,
  CHECKOUT_REF_RE,
  CHECKOUT_REMOTE_RE,
  DEFAULT_CHECKOUT_REMOTE,
  MAX_DIRTY_PATHS,
  type CheckoutRequest,
  type GitState,
  type RestoreRequest,
  type StackPriorState,
  type StackStashOutcome,
} from './protocol.js'
import { SHA_RE, runGit, type GitRun } from './worktree.js'

// ---------------------------------------------------------------------------
// Where the prior state is remembered
// ---------------------------------------------------------------------------

/**
 * The directory holding one record per repo.
 *
 * NOT the OS temp directory, which is where the fix loop's scratch worktrees
 * live. A scratch worktree is disposable by definition; this record is the
 * user's way home, and a temp sweep that ate it would strand them on a PR ref
 * with no note of which branch they had been on. It goes in the home
 * directory, 0700, and survives reboots.
 *
 * NOT inside the repo either: a file in the working tree would make the tree
 * dirty, and this whole module turns on being able to tell clean from dirty.
 */
export function stateParentDir(home: string = homedir()): string {
  return join(home, '.review123-bridge', 'checkouts')
}

/**
 * The record for ONE repo — "keyed by repo", as a filename.
 *
 * The key is a hash of the resolved root rather than its basename: two
 * checkouts of the same project share a basename, and a bridge serving each
 * must not overwrite the other's way home.
 */
export function stateFileFor(realRoot: string, home?: string): string {
  const key = createHash('sha256').update(realRoot).digest('hex').slice(0, 16)
  return join(stateParentDir(home), `${key}.json`)
}

/** Bumped only if the on-disk shape changes incompatibly. */
const STATE_FILE_VERSION = 1

/**
 * A branch name this module is willing to put in a git argv.
 *
 * WHY THIS IS STRICTER THAN IT LOOKS NECESSARY. `runRestore` ends with
 * `git checkout <branch> --`, and git parses FLAGS BEFORE the `--` separator —
 * `--` only divides refs from paths. So a branch literally named `-f` or
 * `--force` would be read as a flag, not as a ref, and the one promise this
 * module makes is that no force ever reaches git.
 *
 * Git itself refuses to create such a branch, so this cannot arise from a
 * normal repository. But the name is read back from a JSON file on disk, and
 * "the file on disk is always what we wrote" is an assumption, not a
 * guarantee. Validating here makes the promise structural instead of
 * inherited: it holds even if the record is corrupted or hand-edited.
 *
 * The pattern also excludes git's own illegal refname characters, so a value
 * that passes here is one `git check-ref-format` would accept.
 */
const SAFE_BRANCH_RE = /^[A-Za-z0-9_.][A-Za-z0-9._\-/]{0,199}$/

interface StoredPriorState extends StackPriorState {
  version: number
  /**
   * The absolute root this record belongs to. Kept so a hash collision or a
   * hand-copied file cannot hand one repo another's restore target — and
   * NEVER sent to the browser, which only ever learns the basename.
   */
  root: string
}

/**
 * Read this repo's recorded prior state, or null.
 *
 * Never throws. A missing file, unreadable JSON, a version from the future and
 * a record whose `root` is not ours all resolve to null, which every caller
 * reads as "there is nothing recorded" — the same honest shape `readGitState`
 * uses. A record we cannot fully trust is not a record.
 */
export async function readPriorState(
  realRoot: string,
  home?: string,
): Promise<StackPriorState | null> {
  let raw: string
  try {
    raw = await readFile(stateFileFor(realRoot, home), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record['version'] !== STATE_FILE_VERSION) return null
  if (record['root'] !== realRoot) return null

  const head = record['head']
  const checkedOutSha = record['checkedOutSha']
  const checkedOutRef = record['checkedOutRef']
  const recordedAt = record['recordedAt']
  const branch = record['branch']
  const stashRef = record['stashRef']
  if (typeof head !== 'string' || !SHA_RE.test(head)) return null
  if (typeof checkedOutSha !== 'string' || !SHA_RE.test(checkedOutSha)) return null
  if (typeof checkedOutRef !== 'string' || !CHECKOUT_REF_RE.test(checkedOutRef)) return null
  if (typeof recordedAt !== 'string') return null

  return {
    // A branch we cannot vouch for is read as "they were detached", NOT as a
    // name to hand git. That degrades to restoring by SHA — which lands them
    // at exactly the same commit — instead of putting an unvalidated string in
    // an argv position where git parses flags. See SAFE_BRANCH_RE.
    branch:
      typeof branch === 'string' && branch !== '' && SAFE_BRANCH_RE.test(branch) ? branch : null,
    head,
    recordedAt,
    checkedOutRef,
    checkedOutSha,
    stashRef: typeof stashRef === 'string' && SHA_RE.test(stashRef) ? stashRef : null,
  }
}

/** Persist this repo's prior state, 0600. Written BEFORE anything moves. */
export async function writePriorState(
  realRoot: string,
  state: StackPriorState,
  home?: string,
): Promise<void> {
  const record: StoredPriorState = { ...state, version: STATE_FILE_VERSION, root: realRoot }
  await mkdir(stateParentDir(home), { recursive: true, mode: 0o700 })
  await writeFile(stateFileFor(realRoot, home), JSON.stringify(record, null, 2), { mode: 0o600 })
}

/**
 * Forget this repo's prior state — called ONLY after a restore has actually
 * put the tree back. Deleting the note is not destroying work: the work is in
 * the stash entry, which this module never drops.
 */
export async function clearPriorState(realRoot: string, home?: string): Promise<void> {
  await rm(stateFileFor(realRoot, home), { force: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

export interface DirtyState {
  dirty: boolean
  /** Repo-relative paths, capped at MAX_DIRTY_PATHS. */
  paths: string[]
  /** The true total. Larger than `paths.length` when the list was capped. */
  count: number
}

/**
 * What is uncommitted right now.
 *
 * `--porcelain -z` and NUL splitting, not line splitting: a path with a
 * newline in it is legal on every filesystem this runs on, and a line-split
 * parser would report it as two files and stash a name that does not exist.
 *
 * A FAILED probe reports DIRTY with an empty list. Unknown must never render
 * as the answer that lets a checkout proceed.
 */
export async function readDirtyState(
  realRoot: string,
  run: GitRun = runGit,
): Promise<DirtyState> {
  const res = await run(['status', '--porcelain', '-z', '--untracked-files=all'], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  if (res.code !== 0) {
    return { dirty: true, paths: [], count: 0 }
  }
  const entries = res.stdout.split('\0').filter((e) => e !== '')
  const paths: string[] = []
  for (const entry of entries) {
    // Each record is `XY <path>`; a rename carries its source as a SEPARATE
    // NUL-terminated field with no status prefix, which this skips naturally
    // because it has no leading status columns.
    if (entry.length < 4) continue
    const path = entry.slice(3)
    if (path !== '') paths.push(path)
  }
  return {
    dirty: paths.length > 0,
    paths: paths.slice(0, MAX_DIRTY_PATHS),
    count: paths.length,
  }
}

/** HEAD's sha and branch, as `/v1/stack` and every action response report them. */
export async function readTreeState(
  realRoot: string,
  run: GitRun = runGit,
): Promise<GitState | null> {
  const head = await run(['rev-parse', '--verify', 'HEAD'], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  if (head.code !== 0) return null
  const sha = head.stdout.trim().toLowerCase()
  if (!SHA_RE.test(sha)) return null

  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  const name = branch.code === 0 ? branch.stdout.trim() : ''
  const dirty = await readDirtyState(realRoot, run)

  return {
    head: sha,
    // `rev-parse --abbrev-ref HEAD` literally prints "HEAD" when detached.
    branch: name === '' || name === 'HEAD' ? null : name,
    dirty: dirty.dirty,
  }
}

/** Does a local branch by this name still exist? The `prior-gone` check. */
export async function branchExists(
  realRoot: string,
  branch: string,
  run: GitRun = runGit,
): Promise<boolean> {
  // `--` is not available to rev-parse here, so the branch is addressed through
  // its full ref path: `refs/heads/<name>` can never be read as a flag, and can
  // never accidentally resolve to a tag or a remote-tracking ref of the same
  // name.
  const res = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  return res.code === 0 && SHA_RE.test(res.stdout.trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Every way a checkout or a restore can refuse. One per thing to tell the user. */
export type CheckoutFailureKind =
  | 'bad-request'
  | 'tree-dirty'
  | 'ref-unknown'
  | 'checkout-failed'
  | 'no-prior-state'
  | 'prior-gone'
  | 'moved-since'
  | 'untrusted-unacknowledged'
  | 'no-repo-state'

export class CheckoutError extends Error {
  readonly kind: CheckoutFailureKind
  /** On `tree-dirty`: what a stash would take. Empty otherwise. */
  readonly dirtyPaths: string[]
  readonly dirtyCount: number

  constructor(kind: CheckoutFailureKind, message: string, dirty?: DirtyState) {
    super(message)
    this.name = 'CheckoutError'
    this.kind = kind
    this.dirtyPaths = dirty?.paths ?? []
    this.dirtyCount = dirty?.count ?? 0
  }
}

/** HTTP status per failure. A refusal the caller can answer is a 409, not a 400. */
export function statusForCheckoutError(kind: CheckoutFailureKind): number {
  switch (kind) {
    case 'bad-request':
      return 400
    case 'untrusted-unacknowledged':
      return 403
    case 'tree-dirty':
    case 'prior-gone':
    case 'moved-since':
      return 409
    case 'no-prior-state':
      return 404
    case 'ref-unknown':
      return 404
    case 'checkout-failed':
    case 'no-repo-state':
      return 500
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Narrow an untrusted `/v1/checkout` body.
 *
 * The ref is the one field that becomes a git argv element, so it is validated
 * twice over: the `refs/` prefix pattern (which makes a leading `-` — and thus
 * a flag — impossible), and then the refname rules git itself would reject.
 */
export function parseCheckoutRequest(
  value: unknown,
): { ref: string; remote: string; stashDirty: boolean; acknowledgeUntrusted: boolean } | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'A JSON object body is required.' }
  const raw = value as Record<string, unknown>

  const ref = raw['ref']
  if (typeof ref !== 'string' || ref === '') return { error: '"ref" is required.' }
  if (!CHECKOUT_REF_RE.test(ref)) {
    return {
      error:
        '"ref" must be a full ref path like refs/pull/42/head. The bridge only fetches refs, so a value that could be read as a git flag is refused.',
    }
  }
  // Refname rules git enforces itself, applied here so the refusal is a clean
  // 400 with an explanation rather than a confusing fetch failure.
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) {
    return { error: `"ref" is not a legal git refname: ${ref}` }
  }

  const remoteRaw = raw['remote']
  let remote = DEFAULT_CHECKOUT_REMOTE
  if (remoteRaw !== undefined) {
    if (typeof remoteRaw !== 'string' || !CHECKOUT_REMOTE_RE.test(remoteRaw)) {
      return { error: '"remote" must be a plain remote name like origin.' }
    }
    remote = remoteRaw
  }

  return {
    ref,
    remote,
    // Anything other than a literal `true` is false. For a flag that authorises
    // moving someone's uncommitted work, "unknown" must never read as consent.
    stashDirty: raw['stashDirty'] === true,
    acknowledgeUntrusted: raw['acknowledgeUntrusted'] === true,
  }
}

/** Narrow an untrusted `/v1/restore` body. Every field is an explicit consent. */
export function parseRestoreRequest(
  value: unknown,
): Required<RestoreRequest> | { error: string } {
  // An absent body is a legitimate plain restore: "put me back, no special
  // cases". Only a non-object that is not null is a malformed request.
  const raw =
    value === null || value === undefined
      ? {}
      : typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null
  if (raw === null) return { error: 'A JSON object body is required.' }

  return {
    stashDirty: raw['stashDirty'] === true,
    detachToSha: raw['detachToSha'] === true,
    acknowledgeMoved: raw['acknowledgeMoved'] === true,
    restoreStash: raw['restoreStash'] === true,
  }
}

// ---------------------------------------------------------------------------
// The stash
// ---------------------------------------------------------------------------

/** What the user runs to remove an entry themselves. The bridge never does. */
export function stashDropCommand(ref: string): string {
  return `git stash drop ${ref.slice(0, 12)}`
}

/**
 * Move every uncommitted change into a stash entry and return its SHA.
 *
 * `-u` includes untracked files, matching the broad definition of "dirty" this
 * module and `readGitState` both use: an untracked file is still work a
 * checkout could refuse over, or clobber.
 *
 * THE SHA, NOT `stash@{0}`. The stash is a stack shared by every worktree of
 * the repo and by any other tool the user is running; an index that means one
 * entry now can mean a different one a minute later. A commit sha means the
 * same entry forever, which is what makes `apply` safe to offer.
 *
 * Returns null when nothing was stashed — treated as a failure by the caller,
 * because a stash that did not happen must never be followed by a checkout
 * that assumed it did.
 */
export async function stashWork(
  realRoot: string,
  label: string,
  run: GitRun = runGit,
): Promise<string | null> {
  const pushed = await run(
    ['stash', 'push', '--include-untracked', '--message', label],
    realRoot,
    { timeoutMs: CHECKOUT_GIT_TIMEOUT_MS },
  )
  if (pushed.code !== 0) return null

  const ref = await run(['rev-parse', '--verify', '--quiet', 'refs/stash'], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  if (ref.code !== 0) return null
  const sha = ref.stdout.trim().toLowerCase()
  return SHA_RE.test(sha) ? sha : null
}

/**
 * Apply a recorded stash entry back onto the tree.
 *
 * `apply`, NEVER `pop`. Two reasons, both load-bearing:
 *   - `pop` DROPS the entry on success, and dropping is destroying. If the
 *     apply half-succeeded, or the user did not want it after all, the work
 *     would be gone.
 *   - `pop` operates on the top of the stack. Another worktree, another tool
 *     or another session may have pushed since, and popping would hand the
 *     user someone else's changes under the name of their own.
 *
 * Addressed by SHA, so it is always the entry we recorded and never whichever
 * one happens to be on top.
 */
export async function applyStash(
  realRoot: string,
  stashRef: string,
  run: GitRun = runGit,
): Promise<boolean> {
  if (!SHA_RE.test(stashRef)) return false
  const res = await run(['stash', 'apply', stashRef], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  return res.code === 0
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface CheckoutDeps {
  run?: GitRun
  /** Injected in tests so the record lands somewhere disposable. */
  home?: string
  /** Injected so a test can pin the timestamp. */
  now?: () => Date

}

export interface CheckoutResult {
  git: GitState
  prior: StackPriorState
  stash: StackStashOutcome | null
}

/**
 * Fetch `ref` and check it out here.
 *
 * ORDER MATTERS AND IS THE SAFETY PROPERTY:
 *   1. read the tree                — is there work at risk?
 *   2. refuse, or stash on consent  — nothing is ever checked out over work
 *   3. fetch                        — network, before anything local moves
 *   4. RECORD where we are          — persisted before the move, so a crash
 *                                     between record and move is recoverable
 *                                     and a crash after the move still has a
 *                                     way home
 *   5. check out                    — no force; git's refusal is the user's
 *
 * Step 4 before step 5 is not an accident. The reverse order has a window in
 * which the tree has moved and nothing remembers where it came from.
 */
export async function runCheckout(
  realRoot: string,
  req: CheckoutRequest & { remote: string; stashDirty: boolean; acknowledgeUntrusted: boolean },
  deps: CheckoutDeps = {},
): Promise<CheckoutResult> {
  const run = deps.run ?? runGit
  const now = deps.now ?? (() => new Date())

  // ---- The untrusted-code gate, before anything at all happens ----
  // The bridge cannot tell a fork's ref from the repo's own, so it refuses to
  // run any of them without the caller saying it understands what a checkout
  // plus an autoreloading dev stack actually is: executing that code.
  if (!req.acknowledgeUntrusted) {
    throw new CheckoutError(
      'untrusted-unacknowledged',
      'Checking this ref out means running its code: your dev server will reload it, install scripts and all. The request must acknowledge that explicitly.',
    )
  }

  const before = await readTreeState(realRoot, run)
  if (before === null) {
    throw new CheckoutError(
      'no-repo-state',
      'This directory is not a git repository with commits, so there is nothing to check out into.',
    )
  }

  // ---- The dirty gate ----
  const dirty = await readDirtyState(realRoot, run)
  let stash: StackStashOutcome | null = null
  if (dirty.dirty && !req.stashDirty) {
    throw new CheckoutError(
      'tree-dirty',
      `Your working tree has ${dirty.count} uncommitted change${dirty.count === 1 ? '' : 's'}. Nothing was touched. Stash them first if you want to switch.`,
      dirty,
    )
  }

  // ---- The fetch, before anything local moves ----
  // `--no-tags` keeps a PR fetch from dragging the remote's tag namespace in.
  // No refspec destination, so no local ref is created or moved: the result is
  // FETCH_HEAD only.
  const fetched = await run(['fetch', '--no-tags', req.remote, req.ref], realRoot, {
    timeoutMs: CHECKOUT_FETCH_TIMEOUT_MS,
  })
  if (fetched.code !== 0) {
    throw new CheckoutError(
      'ref-unknown',
      `Could not fetch ${req.ref} from ${req.remote}: ${firstLine(fetched.stderr) || 'the remote did not have it.'}`,
    )
  }

  const resolved = await run(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  const targetSha = resolved.stdout.trim().toLowerCase()
  if (resolved.code !== 0 || !SHA_RE.test(targetSha)) {
    throw new CheckoutError('ref-unknown', `${req.ref} did not resolve to a commit.`)
  }

  // ---- The stash, on explicit consent, AFTER the fetch succeeded ----
  // Deliberately here and not earlier: stashing and then failing to fetch
  // would leave the user's work in a stash for a checkout that never happened.
  if (dirty.dirty) {
    const label = `review123-bridge: before ${req.ref} (${now().toISOString()})`
    const stashRef = await stashWork(realRoot, label, run)
    if (stashRef === null) {
      throw new CheckoutError(
        'checkout-failed',
        'git stash could not put your uncommitted changes aside, so nothing was checked out. Your work is exactly where it was.',
      )
    }
    stash = { action: 'created', ref: stashRef, dropCommand: stashDropCommand(stashRef) }
  }

  // ---- Record home BEFORE moving ----
  const prior: StackPriorState = {
    branch: before.branch,
    head: before.head,
    recordedAt: now().toISOString(),
    checkedOutRef: req.ref,
    checkedOutSha: targetSha,
    stashRef: stash?.ref ?? null,
  }
  await writePriorState(realRoot, prior, deps.home)

  // ---- The move. `--detach`, and NO force. ----
  // A detached HEAD creates no ref, so there is nothing left behind to delete
  // later. Without `--force`, git refuses rather than clobbering an untracked
  // file the ref wants to add — and that refusal is reported, not worked
  // around.
  const checkedOut = await run(['checkout', '--detach', targetSha], realRoot, {
    timeoutMs: CHECKOUT_GIT_TIMEOUT_MS,
  })
  if (checkedOut.code !== 0) {
    throw new CheckoutError(
      'checkout-failed',
      `git refused to check ${req.ref} out, so your tree is unchanged: ${firstLine(checkedOut.stderr) || 'no reason given.'}${
        stash === null
          ? ''
          : ` Your stashed changes are safe — restore them with \`git stash apply ${stash.ref.slice(0, 12)}\`.`
      }`,
    )
  }

  const after = await readTreeState(realRoot, run)
  if (after === null) {
    throw new CheckoutError('no-repo-state', 'The checkout succeeded but the tree state could not be read.')
  }
  return { git: after, prior, stash }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreResult {
  git: GitState
  stash: StackStashOutcome | null
}

/**
 * Put the tree back exactly where the checkout found it.
 *
 * Three things can have changed underneath us since, and each is a SEPARATE
 * refusal the caller answers explicitly rather than something this function
 * decides on the user's behalf:
 *
 *   - the tree is dirty now      → they have new work here. `stashDirty`.
 *   - the branch is gone         → restoring "to main" is impossible; landing
 *                                  detached instead is a different outcome
 *                                  than they asked for. `detachToSha`.
 *   - HEAD moved                 → they switched by hand or committed; we are
 *                                  no longer restoring what we think we are.
 *                                  `acknowledgeMoved`.
 */
export async function runRestore(
  realRoot: string,
  req: Required<RestoreRequest>,
  deps: CheckoutDeps = {},
): Promise<RestoreResult> {
  const run = deps.run ?? runGit
  const now = deps.now ?? (() => new Date())

  const prior = await readPriorState(realRoot, deps.home)
  if (prior === null) {
    throw new CheckoutError(
      'no-prior-state',
      'This bridge has no record of a branch to restore for this repository. Nothing was changed.',
    )
  }

  const current = await readTreeState(realRoot, run)
  if (current === null) {
    throw new CheckoutError('no-repo-state', 'This directory is not a git repository with commits.')
  }

  // ---- "You moved since" ----
  if (current.head.toLowerCase() !== prior.checkedOutSha.toLowerCase() && !req.acknowledgeMoved) {
    throw new CheckoutError(
      'moved-since',
      `HEAD is at ${current.head.slice(0, 7)}${current.branch === null ? '' : ` on ${current.branch}`}, not at the ${prior.checkedOutSha.slice(0, 7)} this bridge checked out. Something moved it since. Nothing was changed.`,
    )
  }

  // ---- The dirty gate, the same rule as a checkout ----
  const dirty = await readDirtyState(realRoot, run)
  let stash: StackStashOutcome | null = null
  if (dirty.dirty && !req.stashDirty) {
    throw new CheckoutError(
      'tree-dirty',
      `Your working tree has ${dirty.count} uncommitted change${dirty.count === 1 ? '' : 's'} made since the checkout. Nothing was touched.`,
      dirty,
    )
  }
  if (dirty.dirty) {
    const stashRef = await stashWork(
      realRoot,
      `review123-bridge: before restoring ${prior.branch ?? prior.head.slice(0, 12)} (${now().toISOString()})`,
      run,
    )
    if (stashRef === null) {
      throw new CheckoutError(
        'checkout-failed',
        'git stash could not put your uncommitted changes aside, so nothing was restored. Your work is exactly where it was.',
      )
    }
    stash = { action: 'created', ref: stashRef, dropCommand: stashDropCommand(stashRef) }
  }

  // ---- Where are we going back to? ----
  // The SAFE_BRANCH_RE check is repeated here, at the point where the name
  // actually becomes an argv element, so the "no flag can reach git" invariant
  // is local to the line that could break it rather than inherited from a
  // reader three hundred lines away.
  const wantBranch =
    prior.branch !== null && SAFE_BRANCH_RE.test(prior.branch) && !req.detachToSha
  if (wantBranch && !(await branchExists(realRoot, prior.branch as string, run))) {
    throw new CheckoutError(
      'prior-gone',
      `The branch ${prior.branch} no longer exists, so it cannot be restored. Its commit ${prior.head.slice(0, 7)} is still here and can be checked out detached instead. Nothing was changed.`,
    )
  }

  // A branch name is checked out by name so the user lands ON their branch,
  // not on a detached copy of it. `--` separates it from any path with the
  // same name, and there is no force: git refuses rather than clobbering.
  const args = wantBranch
    ? ['checkout', prior.branch as string, '--']
    : ['checkout', '--detach', prior.head]
  const restored = await run(args, realRoot, { timeoutMs: CHECKOUT_GIT_TIMEOUT_MS })
  if (restored.code !== 0) {
    throw new CheckoutError(
      'checkout-failed',
      `git refused to restore ${prior.branch ?? prior.head.slice(0, 7)}, so your tree is unchanged: ${firstLine(restored.stderr) || 'no reason given.'}`,
    )
  }

  // ---- The stash the CHECKOUT created, applied on explicit request ----
  // Applied after the branch move, so the changes land on the tree the user is
  // going back to. `apply` leaves the entry in place: a conflict here costs
  // nothing, and the entry stays theirs to drop.
  if (req.restoreStash && prior.stashRef !== null) {
    const applied = await applyStash(realRoot, prior.stashRef, run)
    stash = {
      action: 'applied',
      ref: prior.stashRef,
      dropCommand: stashDropCommand(prior.stashRef),
    }
    if (!applied) {
      // The branch IS restored; only the stash apply failed (a conflict, most
      // likely). Say so rather than reporting a clean success — but do not
      // undo the restore, and above all do not drop the entry.
      throw new CheckoutError(
        'checkout-failed',
        `You are back on ${prior.branch ?? prior.head.slice(0, 7)}, but your stashed changes did not apply cleanly. They are safe — apply them yourself with \`git stash apply ${prior.stashRef.slice(0, 12)}\`.`,
      )
    }
  }

  // The way home has been walked; the note can go. The stash entry it pointed
  // at is NOT touched — it stays in the stash list for the user to drop.
  await clearPriorState(realRoot, deps.home)

  const after = await readTreeState(realRoot, run)
  if (after === null) {
    throw new CheckoutError('no-repo-state', 'The restore succeeded but the tree state could not be read.')
  }
  return { git: after, stash }
}

/** git's own first line of stderr, trimmed for a UI. Never invented. */
function firstLine(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.trim() !== '')
  return line === undefined ? '' : line.trim().slice(0, 300)
}
