/**
 * worktree.ts — the scratch git worktree the fix loop works in, and the only
 * place in this package that runs a WRITING git command.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROMISE
 *
 * The user's checkout is untouchable. Not "mostly untouched", not "restored
 * afterwards" — never modified in the first place. Their branch, their HEAD,
 * their index and every uncommitted line they have not pushed yet stay exactly
 * as they were, whatever the agent does.
 *
 * The mechanism is git's own: `git worktree add` materialises the PR head in a
 * SEPARATE directory with its own HEAD and its own index, sharing only the
 * object store. Every command the fix loop runs afterwards is `-C <scratch>`.
 *
 * Two commands here DO reset and check out — `discardChanges` and
 * `softResetTo` — and both take the SCRATCH directory, never the repo root.
 * The only commands that ever run in the user's own directory are
 * `rev-parse --verify` and the three `worktree` subcommands. There is
 * deliberately no code path in this file that can stash, merge, rebase, fetch
 * or push anywhere at all.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES WRITE, stated plainly, because "writes nothing" would be a lie:
 *
 *   1. A directory under the OS temp dir, keyed by repo + head sha.
 *   2. Git worktree administrative data inside `$GIT_DIR/worktrees/<name>` —
 *      unavoidable, and not part of any working tree.
 *   3. ONE branch ref, always under `review123/fix/`. Nothing outside that
 *      prefix is created, moved or deleted. The branch is what makes the
 *      returned commits cherry-pickable from the user's own checkout.
 *
 * Nothing is ever pushed. There is no remote-touching command in this file.
 *
 * WHY THE TEMP DIR AND NOT `.git/`: a scratch worktree inside `.git/` looks to
 * a coding agent like git's own configuration territory, and `claude` refuses
 * to edit files there ("sensitive-file approval unavailable"). Verified the
 * hard way — see bridge/README.md § 7.
 *
 * SUBPROCESS RULES, same as gitState.ts and infer.ts: `spawn` with an argv
 * ARRAY, never a shell, never `exec`. Every argv element is either a hard-coded
 * literal or a value this module produced (a validated 40-hex sha, a path it
 * built itself). No request string is ever appended to a git command line.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { FIX_BRANCH_PREFIX } from './protocol.js'

/** Budget for an ordinary git command (status, add, commit, show). */
export const GIT_CMD_TIMEOUT_MS = 30_000

/** Budget for `git worktree add`, which has to materialise a whole tree. */
export const GIT_WORKTREE_TIMEOUT_MS = 120_000

/** Grace between SIGTERM and SIGKILL, mirroring infer.ts. */
const KILL_GRACE_MS = 1_000

/** Cap on the bytes buffered from one git command. */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024

/** A full commit id. Anything else is not a sha and never reaches a git argv. */
export const SHA_RE = /^[0-9a-f]{40}$/

/**
 * The ONE name the bridge creates inside the scratch worktree that is not the
 * repo's own content: a symlink to the main checkout's installed dependencies,
 * so the test command can actually run. It is excluded from every commit.
 *
 * Honest consequence, documented in the README: the test run reads (and a test
 * that writes into `node_modules` would write) the main checkout's
 * `node_modules`. Nothing else in the user's checkout is reachable from the
 * scratch tree. The alternative — never running tests in a JS repo — would
 * make the "the agent ran the tests" promise a lie, which is worse.
 */
export const LINKED_DEPS_DIR = 'node_modules'

export interface GitResult {
  /** null when the process was killed by a signal rather than exiting. */
  code: number | null
  stdout: string
  stderr: string
  /** The per-command budget expired and the child was killed. */
  timedOut: boolean
  /** `git` could not be executed at all. */
  spawnFailed: boolean
}

export interface GitRunOptions {
  timeoutMs?: number
  /**
   * Extra environment for THIS invocation only — the commit identity, and
   * nothing else. Passed per call rather than set on `process.env`, so two
   * requests running at once can never see each other's identity.
   */
  env?: Record<string, string>
}

export type GitRun = (
  args: readonly string[],
  cwd: string,
  opts?: GitRunOptions,
) => Promise<GitResult>

/**
 * Run one `git` invocation and collect capped stdout/stderr under a wall clock.
 * Never throws: a missing binary, a crash and a timeout all come back as a
 * non-zero/null code with the flags set.
 */
export const runGit: GitRun = (args, cwd, opts = {}) =>
  new Promise<GitResult>((resolve_) => {
    const timeoutMs = opts.timeoutMs ?? GIT_CMD_TIMEOUT_MS
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    let timedOut = false
    let spawnFailed = false
    let killTimer: NodeJS.Timeout | null = null

    const child = spawn('git', [...args], {
      cwd,
      env: {
        ...process.env,
        // Never take the index lock out from under a command the user is
        // running in their own terminal.
        GIT_OPTIONAL_LOCKS: '0',
        // A git that asks for credentials on a terminal nobody is watching
        // would hang the request until the budget killed it.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        NO_COLOR: '1',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    let code: number | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(budget)
      if (killTimer) clearTimeout(killTimer)
      resolve_({ code, stdout, stderr, timedOut, spawnFailed })
    }

    const budget = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (bytes >= MAX_GIT_OUTPUT_BYTES) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk
    })
    child.on('error', () => {
      spawnFailed = true
      finish()
    })
    child.on('close', (exit) => {
      code = exit
      finish()
    })
  })

// ---------------------------------------------------------------------------
// Where the scratch worktree lives
// ---------------------------------------------------------------------------

/**
 * The parent directory every scratch worktree of every repo lives under.
 * Keeping them all in one place is what makes "clean up the slots that are not
 * this one" a precise operation rather than a guess.
 */
export function scratchParentDir(): string {
  return join(tmpdir(), 'review123-bridge-fix')
}

/**
 * The slot for one (repo, head) pair: `<basename>-<8 hex of the root>-<12 hex
 * of the sha>`.
 *
 * The root hash is there because two checkouts of the same project share a
 * basename, and two bridges serving them must not fight over one directory.
 */
export function scratchSlotDir(realRoot: string, headSha: string): string {
  const rootHash = createHash('sha256').update(realRoot).digest('hex').slice(0, 8)
  const safeName = basename(realRoot).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'repo'
  return join(scratchParentDir(), `${safeName}-${rootHash}-${headSha.slice(0, 12)}`)
}

/** The scratch branch for one head sha. Always inside FIX_BRANCH_PREFIX. */
export function scratchBranch(headSha: string): string {
  return `${FIX_BRANCH_PREFIX}${headSha.slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface ScratchWorktree {
  /** Absolute path. NEVER sent to the browser — it is a local path. */
  dir: string
  branch: string
  baseSha: string
  /** True when a `node_modules` symlink was created for the test command. */
  linkedDeps: boolean
}

export class WorktreeError extends Error {
  readonly kind: 'head-unknown' | 'worktree-failed'
  constructor(kind: 'head-unknown' | 'worktree-failed', message: string) {
    super(message)
    this.name = 'WorktreeError'
    this.kind = kind
  }
}

export interface PrepareOptions {
  run?: GitRun
  /** Injected in tests so no symlink is created. */
  linkDeps?: boolean
}

/**
 * Is `sha` a commit that exists in THIS repository's object store?
 *
 * `^{commit}` makes the check type-exact: a blob or tree whose id happened to
 * be sent would not resolve, so a worktree can never be created at a non-commit.
 */
export async function commitExists(realRoot: string, sha: string, run: GitRun = runGit): Promise<boolean> {
  if (!SHA_RE.test(sha)) return false
  const res = await run(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], realRoot)
  return res.code === 0 && res.stdout.trim().toLowerCase().startsWith(sha)
}

/**
 * Create (or recreate) the scratch worktree for one head sha, and return it.
 *
 * REUSE IS OF THE SLOT, NOT OF THE STATE. An existing worktree at the same key
 * is removed and rebuilt from `headSha`, so every run starts from the PR head
 * and commits from an earlier run can never leak into a later one's response.
 * The directory path is stable so the slots cannot accumulate one per request.
 */
export async function prepareScratchWorktree(
  realRoot: string,
  headSha: string,
  opts: PrepareOptions = {},
): Promise<ScratchWorktree> {
  const run = opts.run ?? runGit
  if (!SHA_RE.test(headSha)) {
    throw new WorktreeError('head-unknown', 'A full 40-character commit sha is required.')
  }
  if (!(await commitExists(realRoot, headSha, run))) {
    throw new WorktreeError(
      'head-unknown',
      'That commit is not in the local repository. Fetch or check out the pull request first, then try again.',
    )
  }

  const dir = scratchSlotDir(realRoot, headSha)
  const branch = scratchBranch(headSha)

  // Retire every scratch slot of ours EXCEPT the one we are about to build,
  // then retire that one too so the rebuild starts from nothing.
  await removeOtherScratchWorktrees(realRoot, dir, run)
  await detachScratchWorktree(realRoot, dir, run)

  await mkdir(scratchParentDir(), { recursive: true, mode: 0o700 })

  // `-B` force-creates/resets the scratch branch. It is inside the
  // `review123/fix/` namespace, so it can only ever clobber a previous run of
  // this same feature — never a branch the user works on.
  const added = await run(['worktree', 'add', '--force', '-B', branch, dir, headSha], realRoot, {
    timeoutMs: GIT_WORKTREE_TIMEOUT_MS,
  })
  if (added.code !== 0) {
    throw new WorktreeError(
      'worktree-failed',
      'The bridge could not create its scratch worktree, so nothing was run. Your checkout is untouched.',
    )
  }

  const linkedDeps = opts.linkDeps === false ? false : await linkDependencies(realRoot, dir)
  return { dir, branch, baseSha: headSha, linkedDeps }
}

/**
 * Symlink the main checkout's `node_modules` into the scratch worktree so the
 * test command can run. Returns false when there is nothing to link (no deps
 * installed, or the scratch tree already has its own).
 */
export async function linkDependencies(realRoot: string, dir: string): Promise<boolean> {
  const source = join(realRoot, LINKED_DEPS_DIR)
  const target = join(dir, LINKED_DEPS_DIR)
  try {
    const st = await stat(source)
    if (!st.isDirectory()) return false
  } catch {
    return false
  }
  try {
    // Never replace something the checkout itself provides.
    await stat(target)
    return false
  } catch {
    /* absent — link it */
  }
  try {
    await symlink(source, target, 'dir')
    return true
  } catch {
    return false
  }
}

/**
 * Unregister and delete ONE scratch worktree. Safe to call when it does not
 * exist. `--force` is required because the tree deliberately holds
 * uncommitted-then-committed work and an unignored `node_modules` symlink.
 */
export async function detachScratchWorktree(
  realRoot: string,
  dir: string,
  run: GitRun = runGit,
): Promise<void> {
  await run(['worktree', 'remove', '--force', dir], realRoot)
  await run(['worktree', 'prune'], realRoot)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/**
 * Delete every scratch worktree of OURS except `keepDir`.
 *
 * The filter is the safety property: a path only qualifies when it sits inside
 * `scratchParentDir()`. A worktree the user created themselves — wherever it
 * is — can never match, so this can never remove someone's work.
 */
export async function removeOtherScratchWorktrees(
  realRoot: string,
  keepDir: string,
  run: GitRun = runGit,
): Promise<string[]> {
  const listed = await run(['worktree', 'list', '--porcelain'], realRoot)
  if (listed.code !== 0) return []

  // BOTH spellings of the parent. `git worktree list` prints the path git
  // recorded, which is realpath'd — and on macOS the OS temp dir is a symlink
  // (`/var/folders/…` → `/private/var/folders/…`). Comparing only the lexical
  // form would silently match nothing, so slots would pile up forever.
  const lexical = scratchParentDir()
  const real = await realpath(lexical).catch(() => null)
  const parents = [...new Set([lexical, real].filter((p): p is string => p !== null))].map((p) => p + sep)
  const keep = new Set([resolve(keepDir), await realpath(keepDir).catch(() => null)].filter(Boolean))

  const removed: string[] = []
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const path = line.slice('worktree '.length).trim()
    if (path === '' || !isAbsolute(path)) continue
    // THE SAFETY FILTER: only paths inside our own scratch parent qualify, so
    // a worktree the user created — wherever it is — can never be removed.
    if (!parents.some((parent) => path.startsWith(parent))) continue
    if (keep.has(resolve(path))) continue
    await detachScratchWorktree(realRoot, path, run)
    removed.push(path)
  }
  return removed
}

// ---------------------------------------------------------------------------
// Committing, inside the scratch worktree only
// ---------------------------------------------------------------------------

/**
 * The identity every fix commit carries.
 *
 * Deliberately NOT the user's git identity: these commits were written by a
 * machine and the log should say so plainly. It also means a fix run works on
 * a machine where `user.email` was never configured, instead of failing at the
 * commit with git's "please tell me who you are".
 */
export const FIX_AUTHOR_NAME = 'review123 bridge'
export const FIX_AUTHOR_EMAIL = 'bridge@review123.dev'

function commitEnv(cli: string): Record<string, string> {
  const name = `${FIX_AUTHOR_NAME} (${cli})`
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: FIX_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: FIX_AUTHOR_EMAIL,
  }
}

/** True when the scratch worktree has any change at all, staged or not. */
export async function hasChanges(dir: string, run: GitRun = runGit): Promise<boolean> {
  const res = await run(['status', '--porcelain', '--', '.', `:(exclude)${LINKED_DEPS_DIR}`], dir)
  return res.code === 0 && res.stdout.trim() !== ''
}

/** The sha HEAD points at inside the scratch worktree. */
export async function currentHead(dir: string, run: GitRun = runGit): Promise<string | null> {
  const res = await run(['rev-parse', '--verify', 'HEAD'], dir)
  if (res.code !== 0) return null
  const sha = res.stdout.trim().toLowerCase()
  return SHA_RE.test(sha) ? sha : null
}

/** The TREE sha of HEAD — the fingerprint the oscillation check compares. */
export async function currentTree(dir: string, run: GitRun = runGit): Promise<string | null> {
  const res = await run(['rev-parse', '--verify', 'HEAD^{tree}'], dir)
  if (res.code !== 0) return null
  const sha = res.stdout.trim().toLowerCase()
  return SHA_RE.test(sha) ? sha : null
}

/**
 * Stage everything in the scratch worktree (except the linked dependencies)
 * and commit it. Returns the new sha, or null when there was nothing to commit.
 *
 * `--no-verify` is not laziness: the repo's own commit hooks are code the
 * bridge did not choose to run, and a `pre-commit` that reformats or rejects
 * would silently change what the user is about to review. `--no-gpg-sign`
 * stops a signing key prompt from hanging a request nobody is watching.
 */
export async function stageAndCommit(
  dir: string,
  message: string,
  cli: string,
  run: GitRun = runGit,
): Promise<string | null> {
  const added = await run(['add', '-A', '--', '.', `:(exclude)${LINKED_DEPS_DIR}`], dir)
  if (added.code !== 0) return null

  const staged = await run(['diff', '--cached', '--quiet'], dir)
  // Exit 0 means "no difference" — nothing to commit.
  if (staged.code === 0) return null

  const committed = await run(
    ['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', message],
    dir,
    { env: commitEnv(cli) },
  )
  if (committed.code !== 0) return null
  return currentHead(dir, run)
}

/**
 * Undo commits the AGENT made on its own, keeping their content in the working
 * tree, so the bridge's own one-commit-per-finding rule still holds.
 *
 * The agent is told not to commit; `claude` is even started without a shell
 * tool so it cannot. But "it should not happen" is not a guarantee, and a
 * single squashed blob from an agent that ignored the instruction would break
 * the deliverable silently. A soft reset back to where the round started keeps
 * every line it wrote and hands the commit decision back to us.
 */
export async function softResetTo(dir: string, sha: string, run: GitRun = runGit): Promise<boolean> {
  if (!SHA_RE.test(sha)) return false
  const res = await run(['reset', '--soft', sha], dir)
  return res.code === 0
}

/**
 * Put the scratch worktree back to HEAD, discarding everything uncommitted.
 *
 * Used when a turn refuses a finding, times out, or crashes. Without it a
 * refusal that happened to leave half an edit behind would be swept into the
 * NEXT finding's commit — the user would review a diff attributed to a finding
 * that did not produce it, which is the one thing this feature cannot afford.
 *
 * `reset --hard` looks alarming and would be unforgivable in the user's own
 * checkout — which is exactly why `dir` here is ALWAYS the scratch worktree.
 * It is needed rather than `checkout -- .` because the loop STAGES the agent's
 * work to fingerprint it, and `checkout -- .` restores from the index, leaving
 * staged debris behind. Nothing it discards existed before this run.
 *
 * `-e node_modules` protects the dependency symlink the bridge created; it is
 * the only untracked thing here that is not the agent's doing.
 */
export async function discardChanges(dir: string, run: GitRun = runGit): Promise<void> {
  await run(['reset', '-q', '--hard', 'HEAD'], dir)
  await run(['clean', '-fd', '-e', LINKED_DEPS_DIR], dir)
}

export interface CommitPatch {
  subject: string
  files: string[]
  diff: string
  truncated: boolean
}

/**
 * The patch for one commit, capped.
 *
 * `--no-ext-diff` and `--no-textconv` matter: both `diff.external` and a
 * `textconv` filter are repo-configured COMMANDS, and rendering a diff must
 * never become a way for repository configuration to run something.
 */
export async function readCommitPatch(
  dir: string,
  sha: string,
  maxBytes: number,
  run: GitRun = runGit,
): Promise<CommitPatch | null> {
  if (!SHA_RE.test(sha)) return null
  const subjectRes = await run(['log', '-1', '--format=%s', sha], dir)
  if (subjectRes.code !== 0) return null
  const filesRes = await run(['show', '--name-only', '--format=', '--no-renames', sha], dir)
  const diffRes = await run(
    ['show', '--format=', '--patch', '--no-color', '--no-ext-diff', '--no-textconv', sha],
    dir,
  )
  if (diffRes.code !== 0) return null

  const raw = diffRes.stdout
  const truncated = Buffer.byteLength(raw, 'utf8') > maxBytes
  return {
    subject: subjectRes.stdout.trim(),
    files: filesRes.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== ''),
    diff: truncated ? raw.slice(0, maxBytes) : raw,
    truncated,
  }
}
