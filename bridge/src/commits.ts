/**
 * commits.ts — "is this commit in this repository?", and nothing else.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN MODULE
 *
 * `worktree.ts` already knows how to answer the question — `commitExists` is
 * the guard `prepareScratchWorktree` runs before it creates anything — but that
 * file is the one place in this package that WRITES, and its docstring says so.
 * The probe behind `/v1/commits` is a read that the client makes before it
 * offers a button, on a bridge that may never have been granted `--allow-write`
 * at all. Putting it here keeps "the route that reads" and "the module that
 * writes" from being the same import, and makes the grant question obvious to
 * anyone auditing it: THERE IS NO GRANT. Nothing here can write.
 *
 * It reuses `commitExists` rather than reimplementing the check, so the answer
 * the client gets before it offers the button is produced by the SAME code that
 * decides whether the worktree can be created afterwards. Two spellings of one
 * precondition is how a surface ends up offering something that then refuses.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * SUBPROCESS RULES, the same ones gitState.ts and worktree.ts follow: `spawn`
 * with an argv ARRAY, never a shell, never `exec`. The only non-literal that
 * reaches a git command line is a sha this module has already validated against
 * `SHA_RE` — 40 lowercase hex characters, which cannot be read as a flag and
 * cannot contain a separator.
 *
 * READ-ONLY, stated precisely: `rev-parse --verify --quiet <sha>^{commit}`
 * resolves an id that is already in the object store. It creates no ref, no
 * directory and no worktree; it opens no socket. In particular it does NOT
 * fetch — see protocol.ts § `/v1/commits` for why that is a deliberate refusal
 * rather than a missing feature.
 */

import { MAX_COMMIT_PROBE_SHAS } from './protocol.js'
import { SHA_RE, commitExists, runGit, type GitRun } from './worktree.js'

/**
 * Narrow an untrusted `/v1/commits` body.
 *
 * REFUSES rather than coerces. An abbreviated sha is ambiguous by construction
 * and an uppercase one would compare unequal to everything the bridge reports,
 * so both are dropped here instead of being "helpfully" normalised into a value
 * the caller did not send. The one normalisation is case, because the client
 * lowercases every sha it holds and GitHub hands out both spellings.
 *
 * Duplicates collapse: asking twice about one commit is one lookup, and a
 * response that echoed the duplicate would invite a caller to index by position.
 */
export function parseCommitsRequest(body: unknown): { shas: string[] } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Body must be a JSON object.' }
  }
  const raw = (body as Record<string, unknown>)['shas']
  if (!Array.isArray(raw)) return { error: '`shas` must be an array of commit shas.' }
  if (raw.length === 0) return { error: '`shas` must name at least one commit.' }
  if (raw.length > MAX_COMMIT_PROBE_SHAS) {
    return { error: `At most ${MAX_COMMIT_PROBE_SHAS} commits may be probed in one request.` }
  }

  const shas: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string') {
      return { error: 'Every entry in `shas` must be a full 40-character commit sha.' }
    }
    const sha = value.toLowerCase()
    if (!SHA_RE.test(sha)) {
      return { error: 'Every entry in `shas` must be a full 40-character commit sha.' }
    }
    if (seen.has(sha)) continue
    seen.add(sha)
    shas.push(sha)
  }
  return { shas }
}

/**
 * Which of `shas` this repository has as COMMITS.
 *
 * Sequential on purpose. Each lookup is a few milliseconds against a warm
 * object store, the cap is 64, and running them in parallel would put 64 git
 * processes on a machine whose user is trying to work — for a probe that exists
 * to draw a row in a list.
 *
 * A lookup that FAILS (git missing, a hung index, a repository that is not one)
 * leaves that sha out. Absent is the conservative answer: it refuses the fix
 * loop, which is what "we cannot prove the commit is here" has to mean.
 */
export async function presentCommits(
  realRoot: string,
  shas: readonly string[],
  run: GitRun = runGit,
): Promise<string[]> {
  const present: string[] = []
  for (const sha of shas) {
    if (await commitExists(realRoot, sha, run)) present.push(sha)
  }
  return present
}
