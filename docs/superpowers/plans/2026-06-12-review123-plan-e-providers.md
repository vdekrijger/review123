# Review 1-2-3 — Plan E: Multi-Provider Support (GitLab + Bitbucket)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Established patterns are law (typed results, DI seams, TDD, separate PRs per the user's workflow where waves allow). Contracts below are binding.

**Goal:** Review GitLab merge requests and Bitbucket pull requests with the same 1-2-3 flow. The AI layer is already provider-agnostic (operates on PrFile/contents); what's provider-specific is fetching, auth, and submission.

**Scope decisions (v1):**
- **GitLab: full support.** PAT auth first (self-serve); OAuth fast-follow later. Reads: MR meta/changes/file contents/pipelines (CI)/discussions (incl. resolved state — REST, no GraphQL needed). Submission: GitLab has NO atomic batched review — submit = create one discussion per draft (positioned) + optional approve/unapprove; surface this semantic in the UI copy.
- **Bitbucket Cloud: core support.** App-password/API-token auth. Reads: PR meta/diffstat+diff/file contents/statuses/comments (resolved n/a → empty). Submission: inline comments + approve.
- **GitHub: zero behavior change** — all 1635 existing tests stay green throughout.

## Architecture

`src/lib/provider/types.ts` — the interface every provider implements:
```ts
export interface PrRefX { provider: 'github' | 'gitlab' | 'bitbucket'; owner: string; repo: string; number: number }
export interface ReviewProvider {
  id: 'github' | 'gitlab' | 'bitbucket'
  displayName: string
  parseUrl(input: string): ParseResult            // provider-specific hosts/paths
  getPrMeta(ref): Promise<PrMeta>                 // existing shapes REUSED as the canonical model
  getPrFiles(ref): Promise<PrFile[]>
  getFileAtRef(repo, path, ref): Promise<string | null>
  getCiSummary(ref, headSha): Promise<CiSummary>
  getComments(ref): Promise<PrComment[]>
  getResolvedCommentIds(ref): Promise<Set<number>>
  getCommits(ref): Promise<PrCommit[]>
  compareCommits(repo, base, head): Promise<PrFile[]>
  submitReview(ref, verdict, body, drafts, commitId): Promise<SubmitOutcome>
  authState(): { configured: boolean; hint: string }   // per-provider token presence
  capabilities: { resolvedThreads: boolean; checks: boolean; suggestions: boolean; atomicReview: boolean; compare: boolean }
}
```
`src/lib/provider/registry.ts`: `providerFor(refOrUrl)` + `parseAnyUrl(input)` (tries all providers). Route gains a provider segment: `/review/:provider/:owner/:repo/:number/:step?` (legacy `/review/:o/:r/:n` → github, replaceState-canonicalized). All storage keys (drafts/viewed/visits/history/cache/consent) become provider-qualified: `github:owner/repo#1@sha` — with silent migration for legacy github keys.

## Tasks

### Task 1: Interface extraction + GitHub adapter (the refactor — sequential, riskiest)
Create provider/types.ts + registry.ts; `src/lib/provider/github.ts` wraps the EXISTING lib/github functions verbatim (no logic moves — thin adapter). Sweep consumers (Review.svelte, Landing, router, stores' prKey builders) to consume the provider via registry; route gains provider segment + legacy redirect; storage key migration helpers (tested). UI: capability gating helpers (e.g. hide revision picker when !capabilities.compare). EVERY existing test green + new: registry resolution, legacy URL canonicalization, key migration, capability gating.

### Task 2: GitLab adapter (parallel with 3)
`src/lib/provider/gitlab.ts` + `gitlabClient.ts` (base https://gitlab.com/api/v4, `PRIVATE-TOKEN` header or Bearer; settings gains `gitlabToken`). Mapping: project id = URL-encoded `owner/repo`; MR `iid` = number. parseUrl: `gitlab.com/{group}/{project}/-/merge_requests/{iid}` (subgroups: owner = full group path). getPrMeta ← `GET /projects/:id/merge_requests/:iid` (diff_refs.base_sha/head_sha, detailed_merge_status); getPrFiles ← `/merge_requests/:iid/diffs` (per_page=100 paginated; map new_path/old_path/diff→patch, new_file/deleted_file/renamed_file→status, count +/- from the diff text); getFileAtRef ← `/repository/files/:path/raw?ref=`; getCiSummary ← `/merge_requests/:iid/pipelines` latest + `/pipelines/:id/jobs` (failed job names; annotations: empty); getComments/Resolved ← `/merge_requests/:iid/discussions` (notes with position → path/line/side via position.new_line/old_line; discussion.resolved → resolved ids); getCommits ← `/merge_requests/:iid/commits`; compareCommits ← `/repository/compare?from=&to=`; submitReview: per draft `POST /discussions` with position {base_sha, head_sha, start_sha, position_type:'text', new_path, new_line | old_path, old_line}, body comment → `POST /notes`, APPROVE → `POST /approve`, REQUEST_CHANGES → body-prefixed note (no native equivalent; document) — sequential with per-draft error collection (partial-failure outcome listing failed drafts). capabilities: {resolvedThreads:true, checks:true, suggestions:true (```suggestion:-0+0 — adapt the suggestion fence builder per provider via a capability-driven template), atomicReview:false, compare:true}. Exhaustive mapping tests against fixture JSON.

### Task 3: Bitbucket adapter (parallel with 2)
`src/lib/provider/bitbucket.ts` (base https://api.bitbucket.org/2.0, Basic auth email:api-token; settings gains `bitbucketAuth {email, token}`). parseUrl: `bitbucket.org/{ws}/{repo}/pull-requests/{id}`. Meta ← `GET /repositories/:ws/:repo/pullrequests/:id` (source/destination commit hashes); files ← `/pullrequests/:id/diffstat` (paginated, status mapping) + `/diff` (raw unified diff split per file → patch extraction helper, tested); contents ← `/src/:commit/:path`; CI ← `/commit/:sha/statuses` (paginated, map state); comments ← `/pullrequests/:id/comments` (inline.path/to/from lines); resolved: empty set; commits ← `/pullrequests/:id/commits`; compare: capabilities.compare=false v1 (hide picker); submit: per draft `POST /comments` with inline {path, to|from}, verdict APPROVE → `POST /approve`, REQUEST_CHANGES → `POST /request-changes`, body → top-level comment. capabilities: {resolvedThreads:false, checks:true, suggestions:false, atomicReview:false, compare:false}. Mapping tests.

### Task 4: Settings + Landing + e2e + verify
Settings: provider tokens section (GitLab PAT with scope hint `api`; Bitbucket email+API token hint) — same masked/atomic patterns. Landing: placeholder mentions all three; history entries carry provider. VerdictStep: non-atomic submission copy ("posts N comments + approval" for gitlab/bitbucket) + partial-failure rendering. e2e: provider fixture flows — one gitlab MR flow test + one bitbucket PR flow test (route-intercepted), legacy-URL redirect test. `scripts/verify-review123-plan-e.sh` (honest vt mapping). README: provider setup sections.

## Definition of done
All gates + plans A-E verify scripts green; GitHub behavior byte-identical (existing tests untouched in assertions); human checkpoint: real GitLab MR + real Bitbucket PR with user's own tokens.
