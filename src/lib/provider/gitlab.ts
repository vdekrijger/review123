/**
 * src/lib/provider/gitlab.ts — GitLab ReviewProvider adapter.
 *
 * Implements the ReviewProvider interface against the GitLab REST API v4.
 * Auth: PRIVATE-TOKEN header (PAT). No GraphQL — REST-only.
 *
 * Key mapping decisions:
 *   - project id = URL-encoded "owner/repo" (group path / subgroups supported)
 *   - MR iid  = ref.number (internal project id, not the global id)
 *   - Submission = sequential per-draft positioned discussions + body note + optional approve
 *   - REQUEST_CHANGES: no native equivalent → body note is prefixed with "Changes requested:\n"
 *   - suggestions: GitLab uses ```suggestion:-0+0 ... ``` (adapter surfaces via suggestionFence())
 *   - atomicReview: false (GitLab has no batched review API)
 */

import { glFetch, glFetchPage, glFetchRaw, GitlabApiError } from './gitlabClient'
import { getSettings } from '../settings/settings'
import { resolveGitlabToken } from '../auth/gitlabAuth'
import type { ReviewProvider, PrRefX, ParseResult, ProviderCapabilities, QueueItem } from './types'
import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { PrComment } from '../github/comments'
import type { PrCommit } from '../github/commits'
import type { Verdict, SubmitOutcome } from '../github/review'
import type { Draft } from '../drafts/drafts.svelte'

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a GitLab merge request URL into a PrRefX.
 *
 * Supported forms:
 *   https://gitlab.com/{group}/{project}/-/merge_requests/{iid}
 *   https://gitlab.com/{group}/{sub}/{project}/-/merge_requests/{iid}  (subgroups)
 *
 * Query strings, fragments, and trailing slashes are stripped.
 * The /-/ infix is required (GitLab's canonical MR URL format).
 */
export function parseGitlabUrl(input: string): ParseResult {
  let trimmed = input.trim()
  if (!trimmed) return { ok: false, error: 'Empty input' }

  // Strip fragment and query
  trimmed = trimmed.split('#')[0].split('?')[0].replace(/\/+$/, '')

  let url: URL
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    return { ok: false, error: 'Not a valid URL' }
  }

  const configuredHost = getSettings().gitlabHost
  const allowedHosts = new Set(['gitlab.com', configuredHost])
  if (!allowedHosts.has(url.hostname)) {
    return { ok: false, error: `Not a recognized GitLab URL (got ${url.hostname})` }
  }

  // Path must contain /-/merge_requests/{iid}
  // e.g. /group/sub/project/-/merge_requests/42
  const match = url.pathname.match(/^(\/[^/].+?)\/-\/merge_requests\/(\d+)$/)
  if (!match) {
    return { ok: false, error: 'URL does not match GitLab MR pattern (.../‑/merge_requests/{iid})' }
  }

  const fullPath = match[1].replace(/^\//, '') // e.g. "group/sub/project"
  const iid = Number(match[2])

  if (iid <= 0 || !Number.isInteger(iid)) {
    return { ok: false, error: 'Invalid MR iid' }
  }

  // Split owner (everything except last segment) + repo (last segment)
  const segments = fullPath.split('/')
  if (segments.length < 2) {
    return { ok: false, error: 'GitLab project path must be at least group/project' }
  }

  const repo = segments[segments.length - 1]
  const owner = segments.slice(0, -1).join('/')

  return {
    ok: true,
    value: { provider: 'gitlab', owner, repo, number: iid },
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** URL-encoded project path for use in API endpoints. */
function projectId(ref: PrRefX): string {
  return encodeURIComponent(`${ref.owner}/${ref.repo}`)
}

/** Paginate all items from a GitLab list endpoint (max 50 pages / ~5000 items). */
async function fetchAll<T>(startPath: string): Promise<T[]> {
  const all: T[] = []
  let path: string | null = startPath
  let pages = 0
  while (path !== null && pages < 50) {
    const page: { body: T[]; next: string | null } = await glFetchPage<T[]>(path)
    all.push(...page.body)
    path = page.next
    pages++
  }
  return all
}

/**
 * Count additions and deletions from a unified diff patch string.
 * Lines starting with '+' (not '+++') are additions; '-' (not '---') are deletions.
 */
function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

// ---------------------------------------------------------------------------
// GitLab raw API types
// ---------------------------------------------------------------------------

interface GlMrMeta {
  title: string
  state: 'opened' | 'closed' | 'locked' | 'merged'
  description: string | null
  diff_refs: {
    base_sha: string
    head_sha: string
    start_sha: string
  } | null
  changes_count: string | null
  blocking_discussions_resolved: boolean
}

interface GlDiff {
  old_path: string
  new_path: string
  diff: string
  new_file: boolean
  deleted_file: boolean
  renamed_file: boolean
}

interface GlPipeline {
  id: number
  status: string
  sha: string
}

interface GlJob {
  id: number
  name: string
  status: string
  stage: string
  allow_failure: boolean
}

interface GlDiscussion {
  id: string
  resolved: boolean
  notes: GlNote[]
}

interface GlNote {
  id: number
  author: { username: string; avatar_url: string | null }
  body: string
  created_at: string
  system: boolean
  position?: {
    position_type: string
    new_path?: string
    old_path?: string
    new_line?: number | null
    old_line?: number | null
  }
}

interface GlCommit {
  id: string
  short_id: string
  title: string
  authored_date: string
}

interface GlCompareFile {
  old_path: string
  new_path: string
  diff: string
  new_file: boolean
  deleted_file: boolean
  renamed_file: boolean
}

interface GlCompare {
  diffs: GlCompareFile[]
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapMrState(state: string): 'open' | 'closed' {
  return state === 'opened' ? 'open' : 'closed'
}

function mapDiffStatus(d: GlDiff): PrFile['status'] {
  if (d.new_file) return 'added'
  if (d.deleted_file) return 'removed'
  if (d.renamed_file) return 'renamed'
  return 'modified'
}

function mapDiff(d: GlDiff): PrFile {
  const patch = d.diff || ''
  const { additions, deletions } = countPatchLines(patch)
  const status = mapDiffStatus(d)
  const file: PrFile = {
    filename: d.new_path || d.old_path,
    status,
    additions,
    deletions,
    ...(patch ? { patch } : {}),
  }
  if (status === 'renamed' && d.old_path && d.old_path !== d.new_path) {
    file.previousFilename = d.old_path
  }
  return file
}

function mapCompareDiff(d: GlCompareFile): PrFile {
  const patch = d.diff || ''
  const { additions, deletions } = countPatchLines(patch)
  let status: PrFile['status'] = 'modified'
  if (d.new_file) status = 'added'
  else if (d.deleted_file) status = 'removed'
  else if (d.renamed_file) status = 'renamed'
  const file: PrFile = {
    filename: d.new_path || d.old_path,
    status,
    additions,
    deletions,
    ...(patch ? { patch } : {}),
  }
  if (status === 'renamed' && d.old_path && d.old_path !== d.new_path) {
    file.previousFilename = d.old_path
  }
  return file
}

function mapNote(note: GlNote): PrComment | null {
  // Skip system notes (e.g. "approved this merge request", pipeline events)
  if (note.system) return null

  const pos = note.position
  let path: string | null = null
  let line: number | null = null
  let side: 'LEFT' | 'RIGHT' | null = null

  if (pos && pos.position_type === 'text') {
    path = pos.new_path ?? pos.old_path ?? null
    // Prefer new_line (RIGHT/addition side); fall back to old_line (LEFT/deletion side)
    if (pos.new_line != null) {
      line = pos.new_line
      side = 'RIGHT'
    } else if (pos.old_line != null) {
      line = pos.old_line
      side = 'LEFT'
    }
  }

  return {
    id: note.id,
    author: note.author.username,
    authorAvatar: note.author.avatar_url,
    body: note.body,
    createdAt: note.created_at,
    path,
    line,
    side,
    inReplyTo: null, // GitLab REST doesn't expose reply-to per note
  }
}

// ---------------------------------------------------------------------------
// GitLab ReviewProvider
// ---------------------------------------------------------------------------

export const gitlabProvider: ReviewProvider = {
  id: 'gitlab',
  displayName: 'GitLab',

  capabilities: {
    resolvedThreads: true,
    checks: true,
    suggestions: true,
    atomicReview: false,
    compare: true,
  } satisfies ProviderCapabilities,

  parseUrl(input: string): ParseResult {
    return parseGitlabUrl(input)
  },

  async getPrMeta(ref: PrRefX): Promise<PrMeta> {
    const pid = projectId(ref)
    const mr = await glFetch<GlMrMeta>(
      `/projects/${pid}/merge_requests/${ref.number}`,
    )
    return {
      title: mr.title,
      state: mapMrState(mr.state),
      merged: mr.state === 'merged',
      body: mr.description,
      baseSha: mr.diff_refs?.base_sha ?? '',
      headSha: mr.diff_refs?.head_sha ?? '',
      private: false, // GitLab REST /projects/:id doesn't expose visibility in MR payload; treat as non-private
      changedFiles: mr.changes_count != null ? Number(mr.changes_count) : 0,
    }
  },

  async getPrFiles(ref: PrRefX): Promise<PrFile[]> {
    const pid = projectId(ref)
    const diffs = await fetchAll<GlDiff>(
      `/projects/${pid}/merge_requests/${ref.number}/diffs?per_page=100`,
    )
    return diffs.map(mapDiff)
  },

  async getFileAtRef(
    repo: { owner: string; repo: string },
    path: string,
    ref: string,
  ): Promise<string | null> {
    const pid = encodeURIComponent(`${repo.owner}/${repo.repo}`)
    // Each path segment must be encoded individually
    const encodedPath = path.split('/').map(encodeURIComponent).join('/')
    return glFetchRaw(
      `/projects/${pid}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
    )
  },

  async getCiSummary(ref: PrRefX, _headSha: string): Promise<CiSummary> {
    const pid = projectId(ref)
    // Get pipelines for the MR (most recent first)
    const pipelines = await glFetch<GlPipeline[]>(
      `/projects/${pid}/merge_requests/${ref.number}/pipelines`,
    )

    if (pipelines.length === 0) {
      return { total: 0, passed: 0, failed: 0, pending: 0, failures: [] }
    }

    // Use the most recent pipeline
    const latest = pipelines[0]
    const jobs = await fetchAll<GlJob>(
      `/projects/${pid}/pipelines/${latest.id}/jobs?per_page=100`,
    )

    let passed = 0
    let failed = 0
    let pending = 0
    const failures: { name: string; annotations: string[] }[] = []

    for (const job of jobs) {
      // Skip allow_failure jobs from failure count
      if (job.status === 'success' || job.status === 'skipped' || job.status === 'canceled') {
        passed++
      } else if (
        job.status === 'failed' ||
        job.status === 'blocked'
      ) {
        if (job.allow_failure) {
          // Don't count allow_failure as a real failure
          passed++
        } else {
          failed++
          failures.push({ name: job.name, annotations: [] }) // GitLab annotations: not available via REST
        }
      } else {
        // running, pending, waiting_for_resource, preparing, etc.
        pending++
      }
    }

    return {
      total: jobs.length,
      passed,
      failed,
      pending,
      failures,
    }
  },

  async getComments(ref: PrRefX): Promise<PrComment[]> {
    const pid = projectId(ref)
    const discussions = await fetchAll<GlDiscussion>(
      `/projects/${pid}/merge_requests/${ref.number}/discussions?per_page=100`,
    )

    const comments: PrComment[] = []
    for (const disc of discussions) {
      for (const note of disc.notes) {
        const comment = mapNote(note)
        if (comment) comments.push(comment)
      }
    }

    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return comments
  },

  async getResolvedCommentIds(ref: PrRefX): Promise<Set<number>> {
    const token = getSettings().gitlabToken
    if (!token) return new Set()

    const pid = projectId(ref)
    let discussions: GlDiscussion[]
    try {
      discussions = await fetchAll<GlDiscussion>(
        `/projects/${pid}/merge_requests/${ref.number}/discussions?per_page=100`,
      )
    } catch {
      return new Set()
    }

    const ids = new Set<number>()
    for (const disc of discussions) {
      if (disc.resolved) {
        for (const note of disc.notes) {
          ids.add(note.id)
        }
      }
    }
    return ids
  },

  async getCommits(ref: PrRefX): Promise<PrCommit[]> {
    const pid = projectId(ref)
    const commits = await fetchAll<GlCommit>(
      `/projects/${pid}/merge_requests/${ref.number}/commits?per_page=100`,
    )
    return commits.map((c) => ({
      sha: c.id,
      shortSha: c.short_id,
      message: (c.title ?? '').split('\n')[0],
      authoredAt: c.authored_date ?? '',
    }))
  },

  async compareCommits(
    repo: { owner: string; repo: string },
    base: string,
    head: string,
  ): Promise<PrFile[]> {
    const pid = encodeURIComponent(`${repo.owner}/${repo.repo}`)
    const data = await glFetch<GlCompare>(
      `/projects/${pid}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
    )
    return (data.diffs ?? []).map(mapCompareDiff)
  },

  async submitReview(
    ref: PrRefX,
    verdict: Verdict,
    body: string,
    drafts: Draft[],
    commitId: string,
  ): Promise<SubmitOutcome> {
    const pid = projectId(ref)

    // Get MR diff_refs for positioning discussions
    let diffRefs: { base_sha: string; head_sha: string; start_sha: string } | null = null
    try {
      const mr = await glFetch<GlMrMeta>(`/projects/${pid}/merge_requests/${ref.number}`)
      diffRefs = mr.diff_refs
    } catch (err) {
      return {
        ok: false,
        kind: 'other',
        message: mapGitlabError(err, 'Failed to fetch MR metadata for submission'),
      }
    }

    if (!diffRefs) {
      return {
        ok: false,
        kind: 'other',
        message: 'GitLab MR has no diff_refs — cannot position inline comments.',
      }
    }

    // The commitId parameter is the head SHA for positioning; use the MR's head if not provided.
    const effectiveHeadSha = commitId || diffRefs.head_sha

    // ---------- Submit per-draft positioned discussions ----------
    const failedDrafts: Array<{ path: string; line: number; error: string }> = []

    for (const draft of drafts) {
      try {
        const position: Record<string, unknown> = {
          base_sha: diffRefs.base_sha,
          start_sha: diffRefs.start_sha,
          head_sha: effectiveHeadSha,
          position_type: 'text',
          new_path: draft.path,
          old_path: draft.path,
        }

        // Map side to GitLab's new_line / old_line convention
        if (draft.side === 'RIGHT') {
          position.new_line = draft.line
        } else {
          position.old_line = draft.line
        }

        await glFetch(`/projects/${pid}/merge_requests/${ref.number}/discussions`, {
          method: 'POST',
          body: JSON.stringify({
            body: draft.body,
            position,
          }),
        })
      } catch (err) {
        failedDrafts.push({
          path: draft.path,
          line: draft.line,
          error: mapGitlabError(err, 'unknown error'),
        })
      }
    }

    // ---------- Submit the body note (if any) ----------
    if (body.trim()) {
      const noteBody =
        verdict === 'REQUEST_CHANGES'
          ? `Changes requested:\n\n${body}`
          : body

      try {
        await glFetch(`/projects/${pid}/merge_requests/${ref.number}/notes`, {
          method: 'POST',
          body: JSON.stringify({ body: noteBody }),
        })
      } catch (err) {
        // Body note failure is non-fatal if some drafts succeeded
        const errMsg = mapGitlabError(err, 'Failed to post review body note')
        if (failedDrafts.length > 0) {
          // Already have failures — include this in the message
          return {
            ok: false,
            kind: 'other',
            message: `Partial failure: ${failedDrafts.length} draft(s) failed. Body note also failed: ${errMsg}`,
          }
        }
        return { ok: false, kind: 'other', message: errMsg }
      }
    }

    // ---------- Approve (if verdict is APPROVE) ----------
    if (verdict === 'APPROVE') {
      try {
        await glFetch(`/projects/${pid}/merge_requests/${ref.number}/approve`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
      } catch (err) {
        // Approval failure is surfaced but doesn't block the outcome
        const errMsg = mapGitlabError(err, 'Failed to approve MR')
        if (failedDrafts.length > 0) {
          return {
            ok: false,
            kind: 'other',
            message: `Partial failure: ${failedDrafts.length} draft(s) failed. Approval also failed: ${errMsg}`,
          }
        }
        return { ok: false, kind: 'other', message: errMsg }
      }
    }

    // ---------- Outcome ----------
    if (failedDrafts.length > 0) {
      const details = failedDrafts
        .map((f) => `${f.path}:${f.line} — ${f.error}`)
        .join('; ')
      return {
        ok: false,
        kind: 'other',
        message: `${failedDrafts.length} of ${drafts.length} inline comment(s) failed to post: ${details}`,
      }
    }

    return { ok: true }
  },

  authState(): { configured: boolean; hint: string } {
    const settings = getSettings()
    const oauth = settings.gitlabOAuth
    if (oauth && Date.now() < oauth.expiresAt) {
      return { configured: true, hint: 'GitLab: signed in via OAuth' }
    }
    if (settings.gitlabToken) {
      return { configured: true, hint: 'GitLab: using PAT' }
    }
    return {
      configured: false,
      hint: 'GitLab: not configured. Sign in via OAuth or add a PAT in Settings.',
    }
  },

  /**
   * Return a GitLab-flavoured suggestion fence for the given source lines.
   * GitLab uses ```suggestion:-0+0 (not plain ```suggestion like GitHub).
   */
  suggestionFence(lines: string[]): string {
    return `\`\`\`suggestion:-0+0\n${lines.join('\n')}\n\`\`\``
  },

  async getMyQueue(): Promise<QueueItem[]> {
    const token = resolveGitlabToken()
    if (!token) return []

    interface GlUser { username: string }
    interface GlMrListItem {
      iid: number
      title: string
      updated_at: string
      web_url: string
    }

    function parseMrWebUrl(webUrl: string): { owner: string; repo: string } | null {
      const match = webUrl.match(/https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/)
      if (!match) return null
      const fullPath = match[1]
      const segments = fullPath.split('/')
      if (segments.length < 2) return null
      const repo = segments[segments.length - 1]
      const owner = segments.slice(0, -1).join('/')
      return { owner, repo }
    }

    let me: string
    try {
      const user = await glFetch<GlUser>('/user')
      me = user.username
    } catch {
      return []
    }

    async function listMrs(params: string): Promise<GlMrListItem[]> {
      try {
        const items = await glFetch<GlMrListItem[]>(
          `/merge_requests?state=opened&scope=all&${params}&per_page=20`,
        )
        return Array.isArray(items) ? items : []
      } catch {
        return []
      }
    }

    const [reviewMrs, authorMrs] = await Promise.all([
      listMrs(`reviewer_username=${encodeURIComponent(me)}`),
      listMrs(`author_username=${encodeURIComponent(me)}`),
    ])

    const seen = new Map<string, QueueItem>()

    for (const mr of reviewMrs) {
      const repo = parseMrWebUrl(mr.web_url)
      if (!repo) continue
      const key = `${repo.owner}/${repo.repo}#${mr.iid}`
      seen.set(key, {
        ref: { provider: 'gitlab', owner: repo.owner, repo: repo.repo, number: mr.iid },
        title: mr.title,
        authorIsMe: false,
        updatedAt: mr.updated_at,
      })
    }

    for (const mr of authorMrs) {
      const repo = parseMrWebUrl(mr.web_url)
      if (!repo) continue
      const key = `${repo.owner}/${repo.repo}#${mr.iid}`
      if (!seen.has(key)) {
        seen.set(key, {
          ref: { provider: 'gitlab', owner: repo.owner, repo: repo.repo, number: mr.iid },
          title: mr.title,
          authorIsMe: true,
          updatedAt: mr.updated_at,
        })
      }
    }

    return [...seen.values()]
  },
}

// ---------------------------------------------------------------------------
// Internal error mapping
// ---------------------------------------------------------------------------

function mapGitlabError(err: unknown, fallback: string): string {
  if (err instanceof GitlabApiError) {
    const { detail } = err
    switch (detail.kind) {
      case 'unauthorized':
        return 'Not authenticated. Add a GitLab token in Settings (scope: api).'
      case 'forbidden':
        return detail.message ?? 'You do not have permission to perform this action on this MR.'
      case 'not-found':
        return 'MR not found (404). Check the URL and your token permissions.'
      case 'rate-limited':
        return `GitLab rate limit exceeded. Resets at ${detail.resetAt.toLocaleTimeString()}.`
      case 'unprocessable':
        return detail.message
      case 'network':
        return 'Network error — check your connection and try again.'
      case 'server':
        return `GitLab server error (HTTP ${detail.status}).`
    }
  }
  return err instanceof Error ? err.message : fallback
}
