/**
 * push.ts — `/v1/push`: move ONE existing remote branch forward to ONE commit.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS THE FIRST THING THIS PACKAGE DOES THAT LEAVES THE MACHINE.
 *
 * `worktree.ts` writes in a throwaway directory. `checkout.ts` moves the user's
 * own tree and can always put it back. Both of those promises are about
 * reversibility, and both are keepable because nothing has left the laptop.
 *
 * A push has no such promise available. The instant it lands, everyone with
 * read access sees it, CI may start on it, and a colleague may pull it. There
 * is no `--undo`, and offering one would be a lie.
 *
 * So this module does not try to make pushing safe by being careful. It makes
 * pushing safe by REFUSING EVERYTHING IT CANNOT PROVE, and the proofs are:
 *
 *   1. FAST-FORWARD ONLY, proven locally before anything is sent, with
 *      `git merge-base --is-ancestor <remote tip> <sha>`. A fast-forward only
 *      ever ADDS commits; no reachable commit can stop being reachable. That is
 *      a property of the graph, not of anybody's good intentions.
 *   2. NO FORCE. Not "force defaults to off" — there is no field, no argument
 *      and no branch of this code that can emit `--force`, `--force-with-lease`
 *      or a `+`-prefixed refspec. push.test.ts greps this file to keep it true.
 *   3. NOT THE DEFAULT BRANCH. Read from the remote itself, by name, and
 *      refused. If it cannot be read, the push is refused rather than guessed.
 *   4. THE BRANCH MUST ALREADY EXIST THERE. Creating a branch is a separate
 *      act; one confirmation must not stand for two decisions.
 *   5. ONE PUSH, ONE REQUEST. The request carries remote, branch, the sha it
 *      believes the branch is at, and the sha it wants it to be at. All four
 *      come back. Nothing is batched and nothing is retried.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK, and why. "Only branches of pull requests
 * you authored" is the natural thing to want, and the bridge cannot do it. It
 * has no GitHub identity, holds no token, and the branch name arrives from the
 * caller — so an authorship check here would be a guarantee in wording only,
 * resting on the honesty of the thing it claims to guard against. Rather than
 * ship that, this module enforces the properties it can actually prove and says
 * plainly, here and in its refusals, that identity is not one of them.
 *
 * SUBPROCESS RULES, same as gitState.ts, worktree.ts and checkout.ts: `spawn`
 * with an argv ARRAY, never a shell, never `exec`. Every argv element is a
 * hard-coded literal, a pattern-validated remote or branch name, or a 40-hex
 * sha this module read from git itself.
 */

import {
  DEFAULT_PUSH_REMOTE,
  PROTECTED_BRANCH_NAMES,
  PUSH_BRANCH_RE,
  PUSH_GIT_TIMEOUT_MS,
  PUSH_LS_REMOTE_TIMEOUT_MS,
  PUSH_TIMEOUT_MS,
  CHECKOUT_REMOTE_RE,
  type PushRequest,
  type PushResponse,
} from './protocol.js'
import { readDirtyState, type DirtyState } from './checkout.js'
import { SHA_RE, runGit, type GitRun } from './worktree.js'

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Every way a push can refuse. One kind per thing there is to tell the user,
 * and no shared "push failed" bucket: a person who is told "that did not work"
 * learns nothing they can act on, and this is the one operation where acting on
 * the wrong theory is expensive.
 */
export type PushFailureKind =
  | 'bad-request'
  | 'protected-branch'
  | 'default-branch-unknown'
  | 'remote-unknown'
  | 'branch-missing'
  | 'commit-unknown'
  | 'tree-dirty'
  | 'remote-moved'
  | 'not-fast-forward'
  | 'nothing-to-push'
  | 'remote-unreachable'
  | 'push-rejected'
  | 'push-failed'

export class PushError extends Error {
  readonly kind: PushFailureKind
  /** On `tree-dirty`: what is uncommitted. Empty otherwise. */
  readonly dirtyPaths: string[]
  readonly dirtyCount: number

  constructor(kind: PushFailureKind, message: string, dirty?: DirtyState) {
    super(message)
    this.name = 'PushError'
    this.kind = kind
    this.dirtyPaths = dirty?.paths ?? []
    this.dirtyCount = dirty?.count ?? 0
  }
}

/**
 * HTTP status per refusal.
 *
 * A refusal the caller could answer by changing its request is a 409, a missing
 * thing is a 404, a rule that will never bend is a 403, and only a genuine
 * inability to run git is a 5xx. `push-rejected` is a 502 rather than a 500:
 * the bridge worked, the far end said no.
 */
export function statusForPushError(kind: PushFailureKind): number {
  switch (kind) {
    case 'bad-request':
      return 400
    case 'protected-branch':
      return 403
    case 'remote-unknown':
    case 'branch-missing':
    case 'commit-unknown':
      return 404
    case 'tree-dirty':
    case 'remote-moved':
    case 'not-fast-forward':
    case 'nothing-to-push':
    case 'default-branch-unknown':
      return 409
    case 'remote-unreachable':
    case 'push-rejected':
      return 502
    case 'push-failed':
      return 500
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Narrow an untrusted `/v1/push` body.
 *
 * Note the two shas are REQUIRED and validated identically. `expectedRemoteSha`
 * is not an optimisation — it is the field that turns "put my commit there"
 * into "move it from here to there", which is the difference between a push
 * that matches what the user confirmed and one that merely lands.
 *
 * `branch` is a plain name, never a ref path. A caller sending `refs/heads/x`
 * is refused rather than helpfully stripped: the two spellings would then both
 * work, and the one place this module builds a refspec would stop being the one
 * place the ref shape is decided.
 */
export function parsePushRequest(value: unknown): PushRequest | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'A JSON object body is required.' }
  const raw = value as Record<string, unknown>

  const remoteRaw = raw['remote']
  let remote = DEFAULT_PUSH_REMOTE
  if (remoteRaw !== undefined) {
    if (typeof remoteRaw !== 'string' || !CHECKOUT_REMOTE_RE.test(remoteRaw)) {
      return { error: '"remote" must be a plain remote name like origin.' }
    }
    remote = remoteRaw
  }

  const branch = raw['branch']
  if (typeof branch !== 'string' || branch === '') return { error: '"branch" is required.' }
  if (branch.startsWith('refs/')) {
    return {
      error:
        '"branch" is a plain branch name, not a ref path. Send "my-feature", not "refs/heads/my-feature".',
    }
  }
  if (!PUSH_BRANCH_RE.test(branch)) {
    return {
      error: `"branch" is not a branch name this bridge will push to: ${branch}`,
    }
  }
  if (branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')) {
    return { error: `"branch" is not a legal git refname: ${branch}` }
  }

  const expected = raw['expectedRemoteSha']
  if (typeof expected !== 'string' || !SHA_RE.test(expected.toLowerCase())) {
    return {
      error:
        '"expectedRemoteSha" must be the full 40-character sha the remote branch is at now. Without it the bridge cannot tell a push apart from an overwrite.',
    }
  }

  const sha = raw['sha']
  if (typeof sha !== 'string' || !SHA_RE.test(sha.toLowerCase())) {
    return { error: '"sha" must be a full 40-character commit sha.' }
  }

  return { remote, branch, expectedRemoteSha: expected.toLowerCase(), sha: sha.toLowerCase() }
}

// ---------------------------------------------------------------------------
// Reading the remote
// ---------------------------------------------------------------------------

/** What one `git ls-remote --symref <remote> HEAD refs/heads/<branch>` said. */
export interface RemoteView {
  /** The branch the remote's HEAD points at, e.g. `main`. Null if unreadable. */
  defaultBranch: string | null
  /** The requested branch's tip on the remote, or null when there is none. */
  branchSha: string | null
}

/**
 * Parse `ls-remote --symref` output.
 *
 * The symref line comes first and looks like `ref: refs/heads/main\tHEAD`; the
 * sha lines are `<sha>\t<ref>`. Only `refs/heads/<x>` is accepted as a default:
 * a HEAD pointing at a tag or at something else entirely is not a branch name
 * this module is willing to compare against, and reading it as one would be the
 * kind of near-miss that makes a safety check worse than none.
 */
export function parseLsRemote(stdout: string, branch: string): RemoteView {
  let defaultBranch: string | null = null
  let branchSha: string | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(trimmed)
    if (symref) {
      defaultBranch = symref[1]!
      continue
    }
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const sha = parts[0]!.toLowerCase()
    if (!SHA_RE.test(sha)) continue
    if (parts[1] === `refs/heads/${branch}`) branchSha = sha
  }
  return { defaultBranch, branchSha }
}

/**
 * ONE network round-trip that answers both questions this route must ask the
 * remote: what does it consider its default branch, and where is the branch we
 * were asked to move.
 *
 * Asking in one call is not a micro-optimisation. Two calls could disagree —
 * a rename between them, a different mirror answering — and a safety check that
 * can be raced is not a safety check.
 */
export async function readRemote(
  realRoot: string,
  remote: string,
  branch: string,
  run: GitRun,
): Promise<RemoteView | { error: string }> {
  const res = await run(['ls-remote', '--symref', '--', remote, 'HEAD', `refs/heads/${branch}`], realRoot, {
    timeoutMs: PUSH_LS_REMOTE_TIMEOUT_MS,
  })
  if (res.timedOut) {
    return { error: `Listing ${remote}'s branches took too long, so nothing was pushed.` }
  }
  if (res.code !== 0) {
    return {
      error: `The bridge could not read ${remote}. Nothing was pushed. Git said: ${firstLine(res.stderr)}`,
    }
  }
  return parseLsRemote(res.stdout, branch)
}

/** Is `remote` actually configured in this repository? A local question. */
export async function remoteExists(realRoot: string, remote: string, run: GitRun): Promise<boolean> {
  const res = await run(['remote'], realRoot, { timeoutMs: PUSH_GIT_TIMEOUT_MS })
  if (res.code !== 0) return false
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .includes(remote)
}

// ---------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------

export interface RunPushOptions {
  /** Injected in tests. Defaults to the real git runner. */
  git?: GitRun
  now?: () => number
}

/**
 * Do the whole thing, or refuse with a sentence. Throws PushError and nothing
 * else.
 *
 * THE ORDER OF THE CHECKS IS PART OF THE DESIGN. The cheapest and most absolute
 * refusals come first, so a request that was never going to be allowed does not
 * cause a network call, and the user gets the real reason rather than whichever
 * failure happened to surface first:
 *
 *   1. a name on the never list        — no subprocess at all
 *   2. an unconfigured remote          — local
 *   3. a commit we do not have         — local
 *   4. a dirty working tree            — local
 *   5. what the remote actually says   — ONE network call
 *   6. the default branch              — from (5)
 *   7. the branch exists               — from (5)
 *   8. the branch is where we thought  — from (5)
 *   9. there is anything to send       — from (5)
 *  10. it is a fast-forward            — local, and the load-bearing one
 *  11. only then, the push
 */
export async function runPush(
  realRoot: string,
  req: PushRequest,
  opts: RunPushOptions = {},
): Promise<PushResponse> {
  const git = opts.git ?? runGit
  const now = opts.now ?? Date.now
  const started = now()

  // 1. Names this bridge will not push to, whatever anybody says.
  if (PROTECTED_BRANCH_NAMES.includes(req.branch)) {
    throw new PushError(
      'protected-branch',
      `This bridge does not push to a branch named "${req.branch}". Shared branches are changed by opening a pull request, not by a tool running on one person's laptop.`,
    )
  }

  // 2. A remote this repository actually has.
  if (!(await remoteExists(realRoot, req.remote, git))) {
    throw new PushError(
      'remote-unknown',
      `This repository has no remote named "${req.remote}", so there was nothing to push to.`,
    )
  }

  // 3. A commit that is really here. `^{commit}` makes it type-exact, so a
  //    tree or a blob whose id was sent cannot be pushed as if it were history.
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${req.sha}^{commit}`], realRoot, {
    timeoutMs: PUSH_GIT_TIMEOUT_MS,
  })
  if (resolved.code !== 0 || !resolved.stdout.trim().toLowerCase().startsWith(req.sha)) {
    throw new PushError(
      'commit-unknown',
      `Commit ${short(req.sha)} is not in this repository, so there is nothing here to push.`,
    )
  }

  // 4. A clean tree. Not because a dirty tree could corrupt a push — it cannot,
  //    a push sends committed objects and never looks at the working tree — but
  //    because the person confirming is looking at a checkout whose contents do
  //    not match what is about to go out, and this is the one operation where
  //    "I thought that was included" cannot be taken back.
  const dirty = await readDirtyState(realRoot, git)
  if (dirty.dirty) {
    throw new PushError(
      'tree-dirty',
      'This checkout has uncommitted changes. The bridge will not push from a repository whose working tree does not match what would be sent — commit or stash them first, and nothing was pushed.',
      dirty,
    )
  }

  // 5. The one network call. Everything the remote gets a say in comes from it.
  const view = await readRemote(realRoot, req.remote, req.branch, git)
  if ('error' in view) throw new PushError('remote-unreachable', view.error)

  // 6. The remote's OWN default branch, refused by name. Fail closed when it
  //    cannot be read: "probably not the default" is not a thing to push on.
  if (view.defaultBranch === null) {
    throw new PushError(
      'default-branch-unknown',
      `The bridge could not work out which branch ${req.remote} treats as its default, so it cannot prove "${req.branch}" is not it. Nothing was pushed.`,
    )
  }
  if (view.defaultBranch === req.branch) {
    throw new PushError(
      'protected-branch',
      `"${req.branch}" is ${req.remote}'s default branch. This bridge never pushes to it.`,
    )
  }

  // 7. The branch must already be there. Creating one is a different decision.
  if (view.branchSha === null) {
    throw new PushError(
      'branch-missing',
      `${req.remote} has no branch named "${req.branch}". This bridge only moves branches that already exist — creating one is a separate act it does not perform.`,
    )
  }

  // 8. It must be where the request said it was. This is what makes the push
  //    match the plan the user confirmed, rather than merely landing.
  if (view.branchSha !== req.expectedRemoteSha) {
    throw new PushError(
      'remote-moved',
      `${req.remote}/${req.branch} is now at ${short(view.branchSha)}, not ${short(req.expectedRemoteSha)} as the request expected. It moved since this push was planned, so nothing was sent — take another look and decide again.`,
    )
  }

  // 9. Nothing to say.
  if (view.branchSha === req.sha) {
    throw new PushError(
      'nothing-to-push',
      `${req.remote}/${req.branch} is already at ${short(req.sha)}. Nothing was sent.`,
    )
  }

  // 10. THE LOAD-BEARING CHECK. Proven here, locally, on the real graph, before
  //     a single object is uploaded — not delegated to the server's refusal.
  //     (The server would refuse too; git rejects a non-fast-forward by default
  //     and this module has no way to ask it not to. Checking first is what
  //     turns that into a sentence the user can read.)
  const hasRemoteTip = await git(
    ['rev-parse', '--verify', '--quiet', `${view.branchSha}^{commit}`],
    realRoot,
    { timeoutMs: PUSH_GIT_TIMEOUT_MS },
  )
  if (hasRemoteTip.code !== 0) {
    throw new PushError(
      'not-fast-forward',
      `${req.remote}/${req.branch} is at ${short(view.branchSha)}, which is not in this repository — so the bridge cannot prove the push would only add commits. Fetch ${req.remote} and try again. Nothing was pushed.`,
    )
  }
  const isAncestor = await git(
    ['merge-base', '--is-ancestor', view.branchSha, req.sha],
    realRoot,
    { timeoutMs: PUSH_GIT_TIMEOUT_MS },
  )
  if (isAncestor.code !== 0) {
    throw new PushError(
      'not-fast-forward',
      `Pushing ${short(req.sha)} to ${req.remote}/${req.branch} would not be a fast-forward: ${short(view.branchSha)} is not one of its ancestors, so commits on the remote would stop being reachable. This bridge has no way to force a push, so it refused. Nothing was sent.`,
    )
  }

  const commits = await countCommits(realRoot, view.branchSha, req.sha, git)

  // 11. The push. One ref, one direction, explicit on both sides.
  //
  //     `<sha>:refs/heads/<branch>` names the source by commit id and the
  //     destination by full ref path, so neither `push.default` nor a local
  //     branch of the same name nor a tag can change what happens. There is no
  //     leading `+`, and no flag: git's own default refuses a non-fast-forward,
  //     which is the second line of defence behind the check above.
  const pushed = await git(['push', '--', req.remote, `${req.sha}:refs/heads/${req.branch}`], realRoot, {
    timeoutMs: PUSH_TIMEOUT_MS,
  })
  if (pushed.spawnFailed) {
    throw new PushError('push-failed', 'The bridge could not run git, so nothing was pushed.')
  }
  if (pushed.timedOut) {
    throw new PushError(
      'push-failed',
      `The push to ${req.remote}/${req.branch} did not finish within the bridge's budget and was stopped. It may or may not have landed — check the branch on the remote before trying again. The bridge will not retry on its own.`,
    )
  }
  if (pushed.code !== 0) {
    throw new PushError(
      'push-rejected',
      `${req.remote} refused the push to "${req.branch}". Git said: ${firstLine(pushed.stderr)}`,
    )
  }

  return {
    ok: true,
    remote: req.remote,
    branch: req.branch,
    before: view.branchSha,
    after: req.sha,
    commits,
    durationMs: now() - started,
  }
}

/**
 * How many commits the branch moves by. Reported so the confirmation the user
 * already gave can be checked against what actually happened; a mismatch is
 * something they can see. Falls back to 0 rather than guessing — an invented
 * count on a push report would be exactly the wrong thing to invent.
 */
async function countCommits(realRoot: string, from: string, to: string, git: GitRun): Promise<number> {
  const res = await git(['rev-list', '--count', `${from}..${to}`], realRoot, {
    timeoutMs: PUSH_GIT_TIMEOUT_MS,
  })
  if (res.code !== 0) return 0
  const n = Number.parseInt(res.stdout.trim(), 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Twelve hex digits — enough to identify a commit in a sentence. */
function short(sha: string): string {
  return sha.slice(0, 12)
}

/**
 * Git's own first meaningful line of stderr, capped.
 *
 * Git's refusals are worth quoting verbatim — "protected branch hook declined"
 * tells the user something no paraphrase of ours would. But its stderr also
 * carries progress chatter and, on some remotes, URLs; so the remote-hint lines
 * are dropped, control characters go, and the result is capped.
 */
export function firstLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.replace(/[ --]/g, '').trim())
    .filter((l) => l !== '' && !/^(remote:\s*)?(Enumerating|Counting|Compressing|Writing|Total|delta)/i.test(l))
  const picked = lines.find((l) => /!|error|denied|rejected|fatal|declined|protected/i.test(l)) ?? lines[0] ?? ''
  const cleaned = picked.replace(/https?:\/\/\S+/g, '<url>').replace(/\S+@\S+:\S+/g, '<url>')
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned || 'no reason given'
}

