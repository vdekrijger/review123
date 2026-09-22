/**
 * Where a pull request's code lives RELATIVE to the repository being reviewed.
 *
 * - `same-repo` — PROVEN: head and base are the same repository.
 * - `fork`      — PROVEN: head is somewhere else.
 * - `unknown`   — not proven either way. The provider did not say (a deleted
 *                 fork, a payload from an older build, an endpoint that omits
 *                 the field). NEVER a synonym for `same-repo`.
 *
 * `unknown` exists so that "we could not tell" can never be mistaken for the
 * reassuring answer — the same discipline `parseGitState` applies to `dirty`
 * and `decideGrounding` applies to a missing route.
 */
export type PrRepoRelation = 'same-repo' | 'fork' | 'unknown'

/**
 * THE RULE, once, for all three providers.
 *
 * Both identities are provider-scoped opaque strings: they are only ever
 * compared with EACH OTHER, never parsed, split or displayed. Either side
 * missing is not evidence of sameness, so it answers `unknown`.
 */
export function deriveRepoRelation(
  head: string | null | undefined,
  base: string | null | undefined,
): PrRepoRelation {
  const h = typeof head === 'string' ? head.trim() : ''
  const b = typeof base === 'string' ? base.trim() : ''
  if (h === '' || b === '') return 'unknown'
  return h.toLowerCase() === b.toLowerCase() ? 'same-repo' : 'fork'
}

export interface PrMeta {
  title: string
  state: 'open' | 'closed'
  merged: boolean
  body: string | null
  baseSha: string
  headSha: string
  private: boolean
  changedFiles: number
  /**
   * Provider-canonical author identity, used for own-PR detection against
   * ReviewProvider.getViewerLogin(): GitHub login, GitLab username,
   * Bitbucket account UUID (nickname fallback). null when unknown.
   */
  authorLogin: string | null
  /**
   * The repository the PR's HEAD branch lives in, as the provider identifies
   * it. Provider-scoped and opaque — compared only against `baseRepo`:
   *
   *   GitHub    — `head.repo.full_name`, e.g. "octocat/hello"
   *   GitLab    — `source_project_id`, the numeric project id as a string
   *   Bitbucket — `source.repository.full_name`, e.g. "workspace/repo-slug"
   *
   * `null` when the provider answered but could not say — GitHub sends
   * `head.repo: null` once the fork is deleted, and GitLab sends
   * `source_project_id: null` for the same reason (both observed live; see
   * `repoRelation`). OPTIONAL, not merely nullable: a `PrMeta` built by a
   * build from before this field existed has no such key at all, and must
   * degrade to `unknown` rather than crash.
   */
  headRepo?: string | null
  /** The repository the PR merges INTO. Same encoding as `headRepo`. */
  baseRepo?: string | null
  /**
   * The provider-agnostic answer, derived from the pair above by
   * `deriveRepoRelation` at the moment the payload was mapped. Consumers read
   * THIS rather than re-deriving, so the per-provider encoding of
   * `headRepo`/`baseRepo` stays an implementation detail of the adapter.
   *
   * Absent (old payload) is read exactly as `unknown`.
   */
  repoRelation?: PrRepoRelation
}

export interface PrFile {
  filename: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  previousFilename?: string
  patch?: string // absent for binary / very large files (EC-05j)
  additions: number
  deletions: number
}

export type GithubError =
  | { kind: 'not-found' }          // 404 — also masks private w/o auth (EC-05b)
  | { kind: 'unauthorized' }       // 401 — bad/expired token (EC-04c/e)
  | { kind: 'rate-limited'; resetAt: Date } // EC-05c
  | { kind: 'forbidden'; message?: string } // other 403
  // 422 — with parsed body message; `errors` carries GitHub's raw errors[]
  // array when present (it sometimes identifies the offending comment/field —
  // used by submitReview's one-shot re-route retry).
  | { kind: 'unprocessable'; message: string; errors?: unknown[] }
  | { kind: 'server'; status: number }
  // The request exceeded OUR window (afterMs). Distinct from 'network': the
  // connection was fine, GitHub just did not answer in time — so "check your
  // connection" is the wrong advice.
  | { kind: 'timeout'; afterMs: number }
  // The request was CANCELLED (a caller's signal fired), not failed. Nothing is
  // broken and nothing needs fixing.
  | { kind: 'cancelled' }
  | { kind: 'network' }

export class GithubApiError extends Error {
  constructor(public readonly detail: GithubError) {
    super(`github: ${detail.kind}`)
  }
}
