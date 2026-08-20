/**
 * src/lib/provider/bitbucket.ts — Bitbucket Cloud ReviewProvider adapter.
 *
 * Auth: Basic auth (base64 email:api-token) via bitbucketClient.ts.
 * API base: https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}
 *
 * Key design notes:
 * - Bitbucket commit hashes are SHORT (12 chars) — kept as-is from the API.
 * - compareCommits is unsupported (capabilities.compare = false).
 * - resolvedThreads is unsupported (returns empty Set).
 * - /src/:commit/:path returns raw text (NOT JSON) — bbFetchRaw handles this.
 * - Pagination uses absolute `next` URLs in the response body (not Link headers).
 * - submitReview is per-item: each draft posted individually; partial failures collected.
 */

import { bbFetch, bbFetchRaw, bbFetchAll, BitbucketApiError } from './bitbucketClient'
import { getSettings } from '../settings/settings'
import type { ReviewProvider, PrRefX, ParseResult, ProviderCapabilities } from './types'
import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { PrComment } from '../github/comments'
import type { PrCommit } from '../github/commits'
import type { Verdict, SubmitOutcome } from '../github/review'
import type { Draft } from '../drafts/drafts.svelte'
import { splitDraftsByAnchor, offDiffCommentBody } from '../github/anchorSplit'

// ---------------------------------------------------------------------------
// splitUnifiedDiff — split a raw unified diff into per-file patches
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff (as returned by Bitbucket's /diff endpoint) and split
 * it into a Map keyed by the destination file path.
 *
 * Handles:
 *   - Standard `--- a/path` / `+++ b/path` headers
 *   - Rename headers: `--- a/old` / `+++ b/new` (we use the `b/` path as the key)
 *   - Binary file markers (skipped — no patch for binary files)
 *   - Multiple files in one diff blob
 *
 * Returns Map<destPath, patchText> where patchText is the hunk text for that file.
 */
export function splitUnifiedDiff(raw: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!raw.trim()) return result

  // Split on lines, keeping newlines so we can rejoin faithfully
  const lines = raw.split('\n')
  let currentPath: string | null = null
  let currentLines: string[] = []
  let isBinary = false

  function flush() {
    if (currentPath !== null && !isBinary && currentLines.length > 0) {
      result.set(currentPath, currentLines.join('\n'))
    }
    currentPath = null
    currentLines = []
    isBinary = false
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Detect diff --git header line (start of a new file section)
    if (line.startsWith('diff --git ')) {
      flush()
      i++
      continue
    }

    // Binary file marker
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      isBinary = true
      i++
      continue
    }

    // --- line: extract old path (we don't use it as key, but consume it)
    if (line.startsWith('--- ')) {
      // +++ line should follow immediately
      const plusLine = lines[i + 1] ?? ''
      if (plusLine.startsWith('+++ ')) {
        let destPath = plusLine.slice(4)
        // Strip 'b/' prefix (unified diff convention)
        if (destPath.startsWith('b/')) destPath = destPath.slice(2)
        // /dev/null means deleted file — use the old path from ---
        if (destPath === '/dev/null') {
          let oldPath = line.slice(4)
          if (oldPath.startsWith('a/')) oldPath = oldPath.slice(2)
          destPath = oldPath
        }
        currentPath = destPath
        i += 2 // skip both --- and +++ lines
        continue
      }
    }

    // Hunk header and body: collect into current file's lines
    if (currentPath !== null && !isBinary) {
      currentLines.push(line)
    }

    i++
  }

  flush()
  return result
}

// ---------------------------------------------------------------------------
// Bitbucket API shapes (subset used here)
// ---------------------------------------------------------------------------

interface BbPrMeta {
  title: string
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'
  description: string | null
  source: { commit: { hash: string }; repository: { is_private: boolean } }
  destination: { commit: { hash: string } }
  author?: { uuid?: string | null; nickname?: string | null } | null
}

/** GET /2.0/user — authenticated viewer identity */
interface BbUser {
  uuid?: string | null
  nickname?: string | null
  username?: string | null
}

interface BbDiffstatEntry {
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'merge conflict'
  old: { path: string } | null
  new: { path: string } | null
  lines_added: number
  lines_removed: number
}

interface BbStatus {
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED'
  name: string
  key: string
}

interface BbComment {
  id: number
  content: { raw: string }
  created_on: string
  deleted: boolean
  inline?: {
    path: string
    to: number | null
    from: number | null
  }
  user: { display_name: string; links?: { avatar?: { href: string } } }
  parent?: { id: number }
  links?: { html?: { href?: string } }
}

interface BbCommit {
  hash: string
  message: string
  date: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bbStateToStatus(state: BbPrMeta['state']): 'open' | 'closed' {
  return state === 'OPEN' ? 'open' : 'closed'
}

function bbCiStateToClassification(state: BbStatus['state']): 'passed' | 'failed' | 'pending' {
  if (state === 'SUCCESSFUL') return 'passed'
  if (state === 'INPROGRESS') return 'pending'
  // FAILED or STOPPED → failed
  return 'failed'
}

function bbDiffstatStatusToFileStatus(
  s: BbDiffstatEntry['status'],
): PrFile['status'] {
  switch (s) {
    case 'added': return 'added'
    case 'removed': return 'removed'
    case 'renamed': return 'renamed'
    case 'modified': return 'modified'
    default: return 'modified'
  }
}

function repoPath(ref: PrRefX): string {
  return `/repositories/${ref.owner}/${ref.repo}`
}

// ---------------------------------------------------------------------------
// bitbucketProvider
// ---------------------------------------------------------------------------

export const bitbucketProvider: ReviewProvider = {
  id: 'bitbucket',
  displayName: 'Bitbucket',

  capabilities: {
    resolvedThreads: false,
    checks: true,
    suggestions: false,
    atomicReview: false,
    compare: false,
    // Reply-to-thread not wired for Bitbucket (no UI affordance shown)
    commentReplies: false,
    selfReviewBlocked: true, // Bitbucket Cloud rejects approving your own PR
  } satisfies ProviderCapabilities,

  // -------------------------------------------------------------------------
  // parseUrl
  // -------------------------------------------------------------------------
  parseUrl(input: string): ParseResult {
    // Accept:
    //   https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}
    //   https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}/anything
    let url: URL
    try {
      url = new URL(input.trim())
    } catch {
      return { ok: false, error: 'Not a valid URL' }
    }

    if (url.hostname !== 'bitbucket.org') {
      return { ok: false, error: 'Not a bitbucket.org URL' }
    }

    // pathname: /{workspace}/{repo}/pull-requests/{id}[/...]
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(\/|$)/)
    if (!m) {
      return { ok: false, error: 'URL does not match /{workspace}/{repo}/pull-requests/{id}' }
    }

    return {
      ok: true,
      value: {
        provider: 'bitbucket',
        owner: m[1],
        repo: m[2],
        number: parseInt(m[3], 10),
      },
    }
  },

  // -------------------------------------------------------------------------
  // prWebUrl — canonical Bitbucket Cloud PR web URL
  // -------------------------------------------------------------------------
  prWebUrl(ref: PrRefX): string {
    return `https://bitbucket.org/${ref.owner}/${ref.repo}/pull-requests/${ref.number}`
  },

  // -------------------------------------------------------------------------
  // getPrMeta
  // -------------------------------------------------------------------------
  async getPrMeta(ref: PrRefX): Promise<PrMeta> {
    const data = await bbFetch<BbPrMeta>(
      `${repoPath(ref)}/pullrequests/${ref.number}`,
    )
    return {
      title: data.title,
      state: bbStateToStatus(data.state),
      merged: data.state === 'MERGED',
      body: data.description ?? null,
      headSha: data.source.commit.hash,
      baseSha: data.destination.commit.hash,
      private: data.source.repository?.is_private ?? false,
      changedFiles: 0, // filled in later from diffstat if needed; Bitbucket meta doesn't include it
      // UUID is the stable identity post-GDPR; nickname is a display fallback.
      // Must stay in the same identity space as getViewerLogin().
      authorLogin: data.author?.uuid ?? data.author?.nickname ?? null,
    }
  },

  // -------------------------------------------------------------------------
  // getPrFiles
  // -------------------------------------------------------------------------
  async getPrFiles(ref: PrRefX): Promise<PrFile[]> {
    // Step 1: get diffstat for status/additions/deletions per file
    const entries = await bbFetchAll<BbDiffstatEntry>(
      `${repoPath(ref)}/pullrequests/${ref.number}/diffstat?pagelen=100`,
    )

    // Step 2: get the raw unified diff and split it per file
    let patchMap = new Map<string, string>()
    try {
      const rawDiff = await bbFetchRaw(
        `${repoPath(ref)}/pullrequests/${ref.number}/diff`,
      )
      if (rawDiff) {
        patchMap = splitUnifiedDiff(rawDiff)
      }
    } catch {
      // Non-fatal — we'll have metadata without patches
    }

    return entries.map((entry): PrFile => {
      const destPath = entry.new?.path ?? entry.old?.path ?? ''
      const oldPath = entry.old?.path
      const status = bbDiffstatStatusToFileStatus(entry.status)

      const file: PrFile = {
        filename: destPath,
        status,
        additions: entry.lines_added,
        deletions: entry.lines_removed,
      }

      if (status === 'renamed' && oldPath && oldPath !== destPath) {
        file.previousFilename = oldPath
      }

      // Look up patch — try the destination path, then the old path for renames
      const patch = patchMap.get(destPath) ?? (oldPath ? patchMap.get(oldPath) : undefined)
      if (patch) file.patch = patch

      return file
    })
  },

  // -------------------------------------------------------------------------
  // getFileAtRef
  // -------------------------------------------------------------------------
  async getFileAtRef(
    repo: { owner: string; repo: string },
    path: string,
    ref: string,
  ): Promise<string | null> {
    return bbFetchRaw(`/repositories/${repo.owner}/${repo.repo}/src/${ref}/${path}`)
  },

  // -------------------------------------------------------------------------
  // getCiSummary
  // -------------------------------------------------------------------------
  async getCiSummary(ref: PrRefX, headSha: string): Promise<CiSummary> {
    let statuses: BbStatus[]
    try {
      statuses = await bbFetchAll<BbStatus>(
        `/repositories/${ref.owner}/${ref.repo}/commit/${headSha}/statuses?pagelen=100`,
      )
    } catch {
      return { total: 0, passed: 0, failed: 0, pending: 0, failures: [] }
    }

    let passed = 0
    let failed = 0
    let pending = 0
    const failures: { name: string; annotations: string[] }[] = []

    for (const s of statuses) {
      const classification = bbCiStateToClassification(s.state)
      if (classification === 'passed') passed++
      else if (classification === 'pending') pending++
      else {
        failed++
        failures.push({ name: s.name || s.key, annotations: [] })
      }
    }

    return { total: statuses.length, passed, failed, pending, failures }
  },

  // -------------------------------------------------------------------------
  // getComments
  // -------------------------------------------------------------------------
  async getComments(ref: PrRefX): Promise<PrComment[]> {
    const raw = await bbFetchAll<BbComment>(
      `${repoPath(ref)}/pullrequests/${ref.number}/comments?pagelen=100`,
    )

    return raw
      .filter((c) => !c.deleted)
      .map((c): PrComment => {
        const inline = c.inline
        let path: string | null = null
        let line: number | null = null
        let side: 'LEFT' | 'RIGHT' | null = null

        if (inline) {
          path = inline.path
          // Bitbucket uses `to` for RIGHT (new file) lines, `from` for LEFT (old file)
          if (inline.to != null) {
            line = inline.to
            side = 'RIGHT'
          } else if (inline.from != null) {
            line = inline.from
            side = 'LEFT'
          }
        }

        return {
          id: c.id,
          author: c.user?.display_name ?? 'unknown',
          authorAvatar: c.user?.links?.avatar?.href ?? null,
          body: c.content.raw,
          createdAt: c.created_on,
          path,
          line,
          side,
          inReplyTo: c.parent?.id ?? null,
          // Bitbucket gives a direct comment permalink under links.html.href.
          ...(c.links?.html?.href ? { url: c.links.html.href } : {}),
        }
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },

  // -------------------------------------------------------------------------
  // getResolvedCommentIds — Bitbucket Cloud does not support resolved threads
  // -------------------------------------------------------------------------
  async getResolvedCommentIds(_ref: PrRefX): Promise<Set<number>> {
    return new Set()
  },

  // -------------------------------------------------------------------------
  // getCommits
  // -------------------------------------------------------------------------
  async getCommits(ref: PrRefX): Promise<PrCommit[]> {
    const raw = await bbFetchAll<BbCommit>(
      `${repoPath(ref)}/pullrequests/${ref.number}/commits?pagelen=100`,
    )

    return raw.map((c): PrCommit => ({
      sha: c.hash,
      shortSha: c.hash.slice(0, 7),
      message: (c.message ?? '').split('\n')[0],
      authoredAt: c.date ?? '',
    }))
  },

  // -------------------------------------------------------------------------
  // compareCommits — not supported
  // -------------------------------------------------------------------------
  async compareCommits(
    _repo: { owner: string; repo: string },
    _base: string,
    _head: string,
  ): Promise<PrFile[]> {
    throw new Error('Bitbucket provider does not support commit comparison (capabilities.compare = false)')
  },

  // -------------------------------------------------------------------------
  // submitReview
  //
  // Per-item submission (not atomic):
  //   - Anchorable drafts → POST /pullrequests/:id/comments with inline {path, to|from}
  //   - Off-diff drafts (line not in the patch hunks) → non-inline comment with
  //     a "**Re: path:line**" prefix; an inline post the server rejects retries
  //     ONCE the same way — user text is never dropped
  //   - APPROVE   → POST /pullrequests/:id/approve
  //   - REQUEST_CHANGES → POST /pullrequests/:id/request-changes
  //   - Body text → POST /pullrequests/:id/comments (top-level general comment)
  //   - Partial failures collected; returns ok:false with message listing them.
  // -------------------------------------------------------------------------
  async submitReview(
    ref: PrRefX,
    verdict: Verdict,
    body: string,
    drafts: Draft[],
    _commitId: string,
    files: readonly Pick<PrFile, 'filename' | 'patch'>[] = [],
  ): Promise<SubmitOutcome> {
    const base = repoPath(ref)
    const failures: string[] = []

    // Split by anchorability: Bitbucket rejects inline comments whose line is
    // not in the diff. Off-diff drafts post as NON-inline (top-level) comments
    // with a "**Re: path:line** _(line not in the current diff)_" prefix so
    // the intended anchor survives. Never drop user text.
    const { inline: inlineDrafts, offDiff: offDiffDrafts } = splitDraftsByAnchor(drafts, files)
    let inlinePosted = 0
    let nonInlinePosted = 0

    /** Post one draft as a non-inline (top-level) PR comment. */
    function postNonInline(draft: Draft): Promise<unknown> {
      return bbFetch(`${base}/pullrequests/${ref.number}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { raw: offDiffCommentBody(draft, draft.body, { includePath: true }) },
        }),
      })
    }

    // 1. Post inline comment drafts
    for (const draft of inlineDrafts) {
      try {
        const inlinePayload: Record<string, unknown> = {
          path: draft.path,
        }
        if (draft.side === 'RIGHT') {
          inlinePayload.to = draft.line
        } else {
          inlinePayload.from = draft.line
        }

        await bbFetch(`${base}/pullrequests/${ref.number}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: { raw: draft.body },
            inline: inlinePayload,
          }),
        })
        inlinePosted++
      } catch (err) {
        // Resilience net: the split said this line anchors, but the server
        // disagreed. Retry ONCE as a non-inline comment — text preserved.
        try {
          await postNonInline(draft)
          nonInlinePosted++
        } catch {
          const msg = err instanceof Error ? err.message : String(err)
          failures.push(`inline comment on ${draft.path}:${draft.line} — ${msg}`)
        }
      }
    }

    // 1b. Off-diff drafts → non-inline comments
    for (const draft of offDiffDrafts) {
      try {
        await postNonInline(draft)
        nonInlinePosted++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`comment on ${draft.path}:${draft.line} (line not in diff) — ${msg}`)
      }
    }

    // 2. Post general body comment (if non-empty)
    if (body.trim()) {
      try {
        await bbFetch(`${base}/pullrequests/${ref.number}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { raw: body } }),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`general comment — ${msg}`)
      }
    }

    // 3. Verdict: APPROVE or REQUEST_CHANGES
    if (verdict === 'APPROVE') {
      try {
        await bbFetch(`${base}/pullrequests/${ref.number}/approve`, {
          method: 'POST',
        })
      } catch (err) {
        if (err instanceof BitbucketApiError && err.detail.kind === 'unauthorized') {
          return { ok: false, kind: 'unauthorized', message: 'Not authenticated. Add Bitbucket credentials in Settings.' }
        }
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`approve — ${msg}`)
      }
    } else if (verdict === 'REQUEST_CHANGES') {
      try {
        await bbFetch(`${base}/pullrequests/${ref.number}/request-changes`, {
          method: 'POST',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`request-changes — ${msg}`)
      }
    }

    if (failures.length > 0) {
      return {
        ok: false,
        kind: 'other',
        message: `Partial submission failure (${failures.length} item(s)):\n${failures.join('\n')}`,
      }
    }

    return { ok: true, posted: { inline: inlinePosted, fileLevel: nonInlinePosted, bodyFolded: 0 } }
  },

  // -------------------------------------------------------------------------
  // authState
  // -------------------------------------------------------------------------
  authState(): { configured: boolean; hint: string } {
    const auth = getSettings().bitbucketAuth
    if (auth) {
      return { configured: true, hint: `Bitbucket credentials configured (${auth.email})` }
    }
    return {
      configured: false,
      hint: 'No Bitbucket credentials configured. Add your email and API token in Settings.',
    }
  },

  // -------------------------------------------------------------------------
  // getViewerLogin — same identity space as PrMeta.authorLogin (uuid first)
  // -------------------------------------------------------------------------
  async getViewerLogin(): Promise<string | null> {
    const user = await bbFetch<BbUser>('/user')
    return user.uuid ?? user.nickname ?? user.username ?? null
  },
}
