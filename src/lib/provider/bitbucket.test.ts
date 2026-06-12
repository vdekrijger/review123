/**
 * Tests for bitbucket.ts — Bitbucket Cloud ReviewProvider adapter.
 *
 * Coverage:
 *   - splitUnifiedDiff: single file, multi-file, renames, binary files, empty
 *   - parseUrl: valid URLs, invalid URLs, edge cases
 *   - getPrMeta: state mapping, sha preservation
 *   - getPrFiles: diffstat status mapping, patch extraction
 *   - getFileAtRef: delegates to bbFetchRaw
 *   - getCiSummary: state mapping (SUCCESSFUL/FAILED/INPROGRESS/STOPPED), pagination
 *   - getComments: inline (to/from → RIGHT/LEFT), deleted filtered, sort
 *   - getResolvedCommentIds: always empty Set
 *   - getCommits: sha, shortSha, first message line
 *   - compareCommits: throws (unsupported)
 *   - submitReview: inline drafts, body comment, APPROVE, REQUEST_CHANGES, partial failure
 *   - authState: configured vs not configured
 *   - capabilities: correct shape
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { bitbucketProvider, splitUnifiedDiff } from './bitbucket'
import type { PrRefX } from './types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./bitbucketClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bitbucketClient')>()
  return {
    ...actual,
    bbFetch: vi.fn(),
    bbFetchRaw: vi.fn(),
    bbFetchPage: vi.fn(),
    bbFetchAll: vi.fn(),
  }
})

vi.mock('../settings/settings', () => ({
  getSettings: vi.fn(),
}))

import { bbFetch, bbFetchRaw, bbFetchAll, BitbucketApiError } from './bitbucketClient'
import { getSettings } from '../settings/settings'

const mockBbFetch = vi.mocked(bbFetch)
const mockBbFetchRaw = vi.mocked(bbFetchRaw)
const mockBbFetchAll = vi.mocked(bbFetchAll)
const mockGetSettings = vi.mocked(getSettings)

const REF: PrRefX = { provider: 'bitbucket', owner: 'myws', repo: 'myrepo', number: 42 }

beforeEach(() => {
  vi.resetAllMocks()
  mockGetSettings.mockReturnValue({
    bitbucketAuth: { email: 'user@example.com', token: 'ATBBtoken123' },
  } as ReturnType<typeof getSettings>)
})

// ---------------------------------------------------------------------------
// splitUnifiedDiff
// ---------------------------------------------------------------------------

describe('splitUnifiedDiff', () => {
  it('returns empty map for empty string', () => {
    expect(splitUnifiedDiff('')).toEqual(new Map())
  })

  it('returns empty map for whitespace-only string', () => {
    expect(splitUnifiedDiff('   \n  \n')).toEqual(new Map())
  })

  it('parses a single-file diff', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged line',
      '-removed line',
      '+added line',
      '+new line',
    ].join('\n')

    const result = splitUnifiedDiff(raw)
    expect(result.size).toBe(1)
    expect(result.has('src/foo.ts')).toBe(true)
    const patch = result.get('src/foo.ts')!
    expect(patch).toContain('@@ -1,3 +1,4 @@')
    expect(patch).toContain('-removed line')
    expect(patch).toContain('+added line')
  })

  it('parses a multi-file diff correctly', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old a',
      '+new a',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-old b',
      '+new b',
    ].join('\n')

    const result = splitUnifiedDiff(raw)
    expect(result.size).toBe(2)
    expect(result.has('src/a.ts')).toBe(true)
    expect(result.has('src/b.ts')).toBe(true)
    expect(result.get('src/a.ts')).toContain('+new a')
    expect(result.get('src/b.ts')).toContain('+new b')
  })

  it('handles rename headers using b/ path as the key', () => {
    const raw = [
      'diff --git a/old/name.ts b/new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1 +1 @@',
      ' same content',
    ].join('\n')

    const result = splitUnifiedDiff(raw)
    // Key should be the destination path (new/name.ts), not old path
    expect(result.has('new/name.ts')).toBe(true)
    expect(result.has('old/name.ts')).toBe(false)
  })

  it('skips binary files (no patch entry)', () => {
    const raw = [
      'diff --git a/image.png b/image.png',
      'Binary files a/image.png and b/image.png differ',
      'diff --git a/src/code.ts b/src/code.ts',
      '--- a/src/code.ts',
      '+++ b/src/code.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')

    const result = splitUnifiedDiff(raw)
    expect(result.has('image.png')).toBe(false)
    expect(result.has('src/code.ts')).toBe(true)
  })

  it('handles deleted file (--- /dev/null path)', () => {
    // When a file is added, --- is /dev/null and +++ is the new file
    const raw = [
      'diff --git a/new-file.ts b/new-file.ts',
      '--- /dev/null',
      '+++ b/new-file.ts',
      '@@ -0,0 +1 @@',
      '+new content',
    ].join('\n')

    const result = splitUnifiedDiff(raw)
    expect(result.has('new-file.ts')).toBe(true)
  })

  it('handles three files in one diff blob', () => {
    const files = ['alpha.ts', 'beta.ts', 'gamma.ts']
    const raw = files.map(f =>
      [
        `diff --git a/${f} b/${f}`,
        `--- a/${f}`,
        `+++ b/${f}`,
        `@@ -1 +1 @@`,
        `-old ${f}`,
        `+new ${f}`,
      ].join('\n')
    ).join('\n')

    const result = splitUnifiedDiff(raw)
    expect(result.size).toBe(3)
    for (const f of files) {
      expect(result.has(f)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// parseUrl
// ---------------------------------------------------------------------------

describe('parseUrl', () => {
  it('parses standard bitbucket PR URL', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/myws/myrepo/pull-requests/42')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('should be ok')
    expect(result.value).toEqual({
      provider: 'bitbucket',
      owner: 'myws',
      repo: 'myrepo',
      number: 42,
    })
  })

  it('parses URL with trailing slash', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/myws/myrepo/pull-requests/42/')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('should be ok')
    expect(result.value.number).toBe(42)
  })

  it('parses URL with extra path segments after the ID', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/myws/myrepo/pull-requests/42/overview')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('should be ok')
    expect(result.value.number).toBe(42)
  })

  it('parses URL with query string', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/myws/myrepo/pull-requests/42?foo=bar')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('should be ok')
    expect(result.value.number).toBe(42)
  })

  it('rejects github.com URL', () => {
    const result = bitbucketProvider.parseUrl('https://github.com/owner/repo/pull/42')
    expect(result.ok).toBe(false)
  })

  it('rejects gitlab.com URL', () => {
    const result = bitbucketProvider.parseUrl('https://gitlab.com/owner/repo/-/merge_requests/42')
    expect(result.ok).toBe(false)
  })

  it('rejects bitbucket.org URL without pull-requests segment', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/myws/myrepo/commits')
    expect(result.ok).toBe(false)
  })

  it('rejects non-URL string', () => {
    const result = bitbucketProvider.parseUrl('not a url')
    expect(result.ok).toBe(false)
  })

  it('rejects empty string', () => {
    const result = bitbucketProvider.parseUrl('')
    expect(result.ok).toBe(false)
  })

  it('rejects URL without numeric ID', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/myws/myrepo/pull-requests/abc')
    expect(result.ok).toBe(false)
  })

  it('parses workspace with hyphen', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/my-org/my-repo/pull-requests/1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('should be ok')
    expect(result.value.owner).toBe('my-org')
    expect(result.value.repo).toBe('my-repo')
  })

  it('has provider = bitbucket in parsed result', () => {
    const result = bitbucketProvider.parseUrl('https://bitbucket.org/ws/repo/pull-requests/1')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('should be ok')
    expect(result.value.provider).toBe('bitbucket')
  })
})

// ---------------------------------------------------------------------------
// getPrMeta
// ---------------------------------------------------------------------------

describe('getPrMeta', () => {
  const rawPr = {
    title: 'My PR',
    state: 'OPEN',
    description: 'Some body',
    source: {
      commit: { hash: 'abc123456789' },
      repository: { is_private: true },
    },
    destination: { commit: { hash: 'def456789012' } },
  }

  it('maps OPEN state to open', async () => {
    mockBbFetch.mockResolvedValue(rawPr)
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.state).toBe('open')
    expect(meta.merged).toBe(false)
  })

  it('maps MERGED state to closed + merged=true', async () => {
    mockBbFetch.mockResolvedValue({ ...rawPr, state: 'MERGED' })
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.state).toBe('closed')
    expect(meta.merged).toBe(true)
  })

  it('maps DECLINED state to closed + merged=false', async () => {
    mockBbFetch.mockResolvedValue({ ...rawPr, state: 'DECLINED' })
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.state).toBe('closed')
    expect(meta.merged).toBe(false)
  })

  it('preserves short 12-char commit hashes as-is', async () => {
    mockBbFetch.mockResolvedValue(rawPr)
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.headSha).toBe('abc123456789')
    expect(meta.baseSha).toBe('def456789012')
  })

  it('maps title and body correctly', async () => {
    mockBbFetch.mockResolvedValue(rawPr)
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.title).toBe('My PR')
    expect(meta.body).toBe('Some body')
  })

  it('maps null description to null body', async () => {
    mockBbFetch.mockResolvedValue({ ...rawPr, description: null })
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.body).toBeNull()
  })

  it('maps private repo correctly', async () => {
    mockBbFetch.mockResolvedValue(rawPr)
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.private).toBe(true)
  })

  it('calls the correct endpoint', async () => {
    mockBbFetch.mockResolvedValue(rawPr)
    await bitbucketProvider.getPrMeta(REF)
    expect(mockBbFetch).toHaveBeenCalledWith('/repositories/myws/myrepo/pullrequests/42')
  })

  it('maps author uuid to authorLogin (preferred over nickname)', async () => {
    mockBbFetch.mockResolvedValue({
      ...rawPr,
      author: { uuid: '{1234-5678}', nickname: 'alice' },
    })
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.authorLogin).toBe('{1234-5678}')
  })

  it('falls back to author nickname when uuid is absent', async () => {
    mockBbFetch.mockResolvedValue({ ...rawPr, author: { nickname: 'alice' } })
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.authorLogin).toBe('alice')
  })

  it('maps a missing author to authorLogin null', async () => {
    mockBbFetch.mockResolvedValue(rawPr)
    const meta = await bitbucketProvider.getPrMeta(REF)
    expect(meta.authorLogin).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getViewerLogin
// ---------------------------------------------------------------------------

describe('getViewerLogin', () => {
  it('returns the viewer uuid from /user (same identity space as authorLogin)', async () => {
    mockBbFetch.mockResolvedValue({ uuid: '{1234-5678}', nickname: 'alice' })
    expect(await bitbucketProvider.getViewerLogin!()).toBe('{1234-5678}')
    expect(mockBbFetch).toHaveBeenCalledWith('/user')
  })

  it('falls back to nickname, then username, when uuid is absent', async () => {
    mockBbFetch.mockResolvedValue({ nickname: 'alice' })
    expect(await bitbucketProvider.getViewerLogin!()).toBe('alice')
    mockBbFetch.mockResolvedValue({ username: 'alice-user' })
    expect(await bitbucketProvider.getViewerLogin!()).toBe('alice-user')
  })

  it('returns null when no identity fields are present', async () => {
    mockBbFetch.mockResolvedValue({})
    expect(await bitbucketProvider.getViewerLogin!()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getPrFiles
// ---------------------------------------------------------------------------

describe('getPrFiles', () => {
  const diffstatEntries = [
    {
      status: 'modified',
      old: { path: 'src/foo.ts' },
      new: { path: 'src/foo.ts' },
      lines_added: 5,
      lines_removed: 2,
    },
    {
      status: 'added',
      old: null,
      new: { path: 'src/new.ts' },
      lines_added: 10,
      lines_removed: 0,
    },
    {
      status: 'removed',
      old: { path: 'src/old.ts' },
      new: null,
      lines_added: 0,
      lines_removed: 8,
    },
    {
      status: 'renamed',
      old: { path: 'src/oldname.ts' },
      new: { path: 'src/newname.ts' },
      lines_added: 1,
      lines_removed: 1,
    },
  ]

  const rawDiff = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,6 @@',
    ' line1',
    '-old',
    '+new line1',
    '+new line2',
    'diff --git a/src/new.ts b/src/new.ts',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,10 @@',
    '+content',
  ].join('\n')

  it('returns files with correct status mapping', async () => {
    mockBbFetchAll.mockResolvedValue(diffstatEntries)
    mockBbFetchRaw.mockResolvedValue(rawDiff)

    const files = await bitbucketProvider.getPrFiles(REF)
    expect(files).toHaveLength(4)

    const foo = files.find(f => f.filename === 'src/foo.ts')!
    expect(foo.status).toBe('modified')
    expect(foo.additions).toBe(5)
    expect(foo.deletions).toBe(2)

    const added = files.find(f => f.filename === 'src/new.ts')!
    expect(added.status).toBe('added')

    const removed = files.find(f => f.filename === 'src/old.ts')!
    expect(removed.status).toBe('removed')

    const renamed = files.find(f => f.filename === 'src/newname.ts')!
    expect(renamed.status).toBe('renamed')
    expect(renamed.previousFilename).toBe('src/oldname.ts')
  })

  it('attaches patch from the diff for files that have it', async () => {
    mockBbFetchAll.mockResolvedValue(diffstatEntries)
    mockBbFetchRaw.mockResolvedValue(rawDiff)

    const files = await bitbucketProvider.getPrFiles(REF)
    const foo = files.find(f => f.filename === 'src/foo.ts')!
    expect(foo.patch).toBeDefined()
    expect(foo.patch).toContain('@@ -1,3 +1,6 @@')
  })

  it('files without diff section have no patch property', async () => {
    mockBbFetchAll.mockResolvedValue([{
      status: 'removed',
      old: { path: 'src/gone.ts' },
      new: null,
      lines_added: 0,
      lines_removed: 5,
    }])
    mockBbFetchRaw.mockResolvedValue('')

    const files = await bitbucketProvider.getPrFiles(REF)
    expect(files[0].patch).toBeUndefined()
  })

  it('does not crash when diff fetch fails', async () => {
    mockBbFetchAll.mockResolvedValue(diffstatEntries)
    mockBbFetchRaw.mockRejectedValue(new Error('network error'))

    const files = await bitbucketProvider.getPrFiles(REF)
    // Should still return files, just without patches
    expect(files).toHaveLength(4)
    for (const f of files) {
      expect(f.patch).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// getFileAtRef
// ---------------------------------------------------------------------------

describe('getFileAtRef', () => {
  it('delegates to bbFetchRaw with correct URL', async () => {
    mockBbFetchRaw.mockResolvedValue('file content')
    const content = await bitbucketProvider.getFileAtRef(
      { owner: 'ws', repo: 'repo' },
      'src/main.ts',
      'abc123',
    )
    expect(content).toBe('file content')
    expect(mockBbFetchRaw).toHaveBeenCalledWith('/repositories/ws/repo/src/abc123/src/main.ts')
  })

  it('returns null when file does not exist at ref', async () => {
    mockBbFetchRaw.mockResolvedValue(null)
    const content = await bitbucketProvider.getFileAtRef(
      { owner: 'ws', repo: 'repo' },
      'missing.ts',
      'abc123',
    )
    expect(content).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getCiSummary
// ---------------------------------------------------------------------------

describe('getCiSummary', () => {
  it('maps SUCCESSFUL → passed', async () => {
    mockBbFetchAll.mockResolvedValue([
      { state: 'SUCCESSFUL', name: 'build', key: 'build' },
    ])
    const ci = await bitbucketProvider.getCiSummary(REF, 'abc123')
    expect(ci.passed).toBe(1)
    expect(ci.failed).toBe(0)
    expect(ci.pending).toBe(0)
    expect(ci.total).toBe(1)
  })

  it('maps FAILED → failed with name in failures', async () => {
    mockBbFetchAll.mockResolvedValue([
      { state: 'FAILED', name: 'tests', key: 'tests' },
    ])
    const ci = await bitbucketProvider.getCiSummary(REF, 'abc123')
    expect(ci.failed).toBe(1)
    expect(ci.failures).toHaveLength(1)
    expect(ci.failures[0].name).toBe('tests')
    expect(ci.failures[0].annotations).toEqual([])
  })

  it('maps INPROGRESS → pending', async () => {
    mockBbFetchAll.mockResolvedValue([
      { state: 'INPROGRESS', name: 'ci', key: 'ci' },
    ])
    const ci = await bitbucketProvider.getCiSummary(REF, 'abc123')
    expect(ci.pending).toBe(1)
  })

  it('maps STOPPED → failed', async () => {
    mockBbFetchAll.mockResolvedValue([
      { state: 'STOPPED', name: 'ci', key: 'ci' },
    ])
    const ci = await bitbucketProvider.getCiSummary(REF, 'abc123')
    expect(ci.failed).toBe(1)
  })

  it('handles mixed statuses correctly', async () => {
    mockBbFetchAll.mockResolvedValue([
      { state: 'SUCCESSFUL', name: 'build', key: 'build' },
      { state: 'SUCCESSFUL', name: 'lint', key: 'lint' },
      { state: 'FAILED', name: 'tests', key: 'tests' },
      { state: 'INPROGRESS', name: 'deploy', key: 'deploy' },
    ])
    const ci = await bitbucketProvider.getCiSummary(REF, 'sha')
    expect(ci.total).toBe(4)
    expect(ci.passed).toBe(2)
    expect(ci.failed).toBe(1)
    expect(ci.pending).toBe(1)
  })

  it('returns zero summary when fetch fails', async () => {
    mockBbFetchAll.mockRejectedValue(new Error('not found'))
    const ci = await bitbucketProvider.getCiSummary(REF, 'sha')
    expect(ci).toEqual({ total: 0, passed: 0, failed: 0, pending: 0, failures: [] })
  })

  it('returns zero summary when no statuses', async () => {
    mockBbFetchAll.mockResolvedValue([])
    const ci = await bitbucketProvider.getCiSummary(REF, 'sha')
    expect(ci).toEqual({ total: 0, passed: 0, failed: 0, pending: 0, failures: [] })
  })

  it('calls correct endpoint with headSha', async () => {
    mockBbFetchAll.mockResolvedValue([])
    await bitbucketProvider.getCiSummary(REF, 'mysha12')
    expect(mockBbFetchAll).toHaveBeenCalledWith(
      expect.stringContaining('/commit/mysha12/statuses'),
    )
  })
})

// ---------------------------------------------------------------------------
// getComments
// ---------------------------------------------------------------------------

describe('getComments', () => {
  const rawComments = [
    {
      id: 1,
      content: { raw: 'Inline comment on new file line' },
      created_on: '2024-01-01T10:00:00Z',
      deleted: false,
      inline: { path: 'src/foo.ts', to: 42, from: null },
      user: {
        display_name: 'Alice',
        links: { avatar: { href: 'https://example.com/alice.png' } },
      },
    },
    {
      id: 2,
      content: { raw: 'Inline comment on old file line' },
      created_on: '2024-01-01T11:00:00Z',
      deleted: false,
      inline: { path: 'src/bar.ts', to: null, from: 10 },
      user: { display_name: 'Bob', links: {} },
    },
    {
      id: 3,
      content: { raw: 'General comment (no inline)' },
      created_on: '2024-01-01T09:00:00Z',
      deleted: false,
      user: { display_name: 'Charlie' },
    },
    {
      id: 4,
      content: { raw: 'Deleted comment — should be filtered out' },
      created_on: '2024-01-01T08:00:00Z',
      deleted: true,
      user: { display_name: 'Dave' },
    },
    {
      id: 5,
      content: { raw: 'Reply comment' },
      created_on: '2024-01-01T12:00:00Z',
      deleted: false,
      user: { display_name: 'Eve' },
      parent: { id: 3 },
    },
  ]

  beforeEach(() => {
    mockBbFetchAll.mockResolvedValue(rawComments)
  })

  it('filters out deleted comments', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    expect(comments.find(c => c.id === 4)).toBeUndefined()
  })

  it('maps inline.to → line=to, side=RIGHT', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const c = comments.find(c => c.id === 1)!
    expect(c.path).toBe('src/foo.ts')
    expect(c.line).toBe(42)
    expect(c.side).toBe('RIGHT')
  })

  it('maps inline.from → line=from, side=LEFT', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const c = comments.find(c => c.id === 2)!
    expect(c.path).toBe('src/bar.ts')
    expect(c.line).toBe(10)
    expect(c.side).toBe('LEFT')
  })

  it('maps general comment (no inline) to path/line/side=null', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const c = comments.find(c => c.id === 3)!
    expect(c.path).toBeNull()
    expect(c.line).toBeNull()
    expect(c.side).toBeNull()
  })

  it('maps author display_name and avatar href', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const alice = comments.find(c => c.id === 1)!
    expect(alice.author).toBe('Alice')
    expect(alice.authorAvatar).toBe('https://example.com/alice.png')
  })

  it('maps missing avatar to null', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const bob = comments.find(c => c.id === 2)!
    expect(bob.authorAvatar).toBeNull()
  })

  it('maps parent.id to inReplyTo', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const reply = comments.find(c => c.id === 5)!
    expect(reply.inReplyTo).toBe(3)
  })

  it('maps no parent to inReplyTo=null', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const c = comments.find(c => c.id === 3)!
    expect(c.inReplyTo).toBeNull()
  })

  it('sorts by createdAt ascending', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    const dates = comments.map(c => c.createdAt)
    const sorted = [...dates].sort()
    expect(dates).toEqual(sorted)
  })

  it('returns 4 comments (1 deleted filtered)', async () => {
    const comments = await bitbucketProvider.getComments(REF)
    expect(comments).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// getResolvedCommentIds
// ---------------------------------------------------------------------------

describe('getResolvedCommentIds', () => {
  it('always returns an empty Set', async () => {
    const ids = await bitbucketProvider.getResolvedCommentIds(REF)
    expect(ids).toBeInstanceOf(Set)
    expect(ids.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getCommits
// ---------------------------------------------------------------------------

describe('getCommits', () => {
  it('maps hash, shortSha (7 chars), and first message line', async () => {
    mockBbFetchAll.mockResolvedValue([
      { hash: 'abc1234567890', message: 'fix: something\n\nLonger body', date: '2024-01-01T00:00:00Z' },
      { hash: 'def0987654321', message: 'feat: another thing', date: '2024-01-02T00:00:00Z' },
    ])

    const commits = await bitbucketProvider.getCommits(REF)
    expect(commits).toHaveLength(2)

    expect(commits[0].sha).toBe('abc1234567890')
    expect(commits[0].shortSha).toBe('abc1234')
    expect(commits[0].message).toBe('fix: something')
    expect(commits[0].authoredAt).toBe('2024-01-01T00:00:00Z')

    expect(commits[1].sha).toBe('def0987654321')
    expect(commits[1].shortSha).toBe('def0987')
    expect(commits[1].message).toBe('feat: another thing')
  })

  it('handles empty commit list', async () => {
    mockBbFetchAll.mockResolvedValue([])
    const commits = await bitbucketProvider.getCommits(REF)
    expect(commits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// compareCommits
// ---------------------------------------------------------------------------

describe('compareCommits', () => {
  it('throws because compare is unsupported', async () => {
    await expect(
      bitbucketProvider.compareCommits({ owner: 'ws', repo: 'repo' }, 'base', 'head'),
    ).rejects.toThrow(/compare.*false|unsupported/i)
  })
})

// ---------------------------------------------------------------------------
// submitReview
// ---------------------------------------------------------------------------

describe('submitReview', () => {
  const drafts = [
    {
      prKey: 'myws/myrepo#42',
      path: 'src/foo.ts',
      line: 10,
      side: 'RIGHT' as const,
      body: 'Great code',
      n: 0,
      updatedAt: 1000,
    },
    {
      prKey: 'myws/myrepo#42',
      path: 'src/bar.ts',
      line: 5,
      side: 'LEFT' as const,
      body: 'Old line concern',
      n: 0,
      updatedAt: 2000,
    },
  ]

  it('posts inline draft comments with correct payload (RIGHT → to)', async () => {
    mockBbFetch.mockResolvedValue({})

    await bitbucketProvider.submitReview(REF, 'COMMENT', '', [drafts[0]], 'sha')

    expect(mockBbFetch).toHaveBeenCalledWith(
      '/repositories/myws/myrepo/pullrequests/42/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: { raw: 'Great code' },
          inline: { path: 'src/foo.ts', to: 10 },
        }),
      }),
    )
  })

  it('posts inline draft comments with LEFT → from', async () => {
    mockBbFetch.mockResolvedValue({})

    await bitbucketProvider.submitReview(REF, 'COMMENT', '', [drafts[1]], 'sha')

    expect(mockBbFetch).toHaveBeenCalledWith(
      '/repositories/myws/myrepo/pullrequests/42/comments',
      expect.objectContaining({
        body: JSON.stringify({
          content: { raw: 'Old line concern' },
          inline: { path: 'src/bar.ts', from: 5 },
        }),
      }),
    )
  })

  it('posts general body comment when body is non-empty', async () => {
    mockBbFetch.mockResolvedValue({})

    await bitbucketProvider.submitReview(REF, 'COMMENT', 'Overall looks great!', [], 'sha')

    expect(mockBbFetch).toHaveBeenCalledWith(
      '/repositories/myws/myrepo/pullrequests/42/comments',
      expect.objectContaining({
        body: JSON.stringify({ content: { raw: 'Overall looks great!' } }),
      }),
    )
  })

  it('does NOT post body comment when body is empty/whitespace', async () => {
    mockBbFetch.mockResolvedValue({})

    await bitbucketProvider.submitReview(REF, 'COMMENT', '   ', [], 'sha')

    expect(mockBbFetch).not.toHaveBeenCalled()
  })

  it('calls APPROVE endpoint for APPROVE verdict', async () => {
    mockBbFetch.mockResolvedValue({})

    await bitbucketProvider.submitReview(REF, 'APPROVE', '', [], 'sha')

    expect(mockBbFetch).toHaveBeenCalledWith(
      '/repositories/myws/myrepo/pullrequests/42/approve',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('calls request-changes endpoint for REQUEST_CHANGES verdict', async () => {
    mockBbFetch.mockResolvedValue({})

    await bitbucketProvider.submitReview(REF, 'REQUEST_CHANGES', '', [], 'sha')

    expect(mockBbFetch).toHaveBeenCalledWith(
      '/repositories/myws/myrepo/pullrequests/42/request-changes',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns ok:true on full success', async () => {
    mockBbFetch.mockResolvedValue({})

    const result = await bitbucketProvider.submitReview(REF, 'APPROVE', 'LGTM', drafts, 'sha')
    expect(result.ok).toBe(true)
  })

  it('returns partial failure outcome when one draft fails', async () => {
    let callCount = 0
    mockBbFetch.mockImplementation(async (url: string) => {
      callCount++
      // Fail the first comment post
      if (url.includes('/comments') && callCount === 1) {
        throw new BitbucketApiError({ kind: 'server', status: 500 })
      }
      return {}
    })

    const result = await bitbucketProvider.submitReview(REF, 'APPROVE', '', drafts, 'sha')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.kind).toBe('other')
    expect(result.message).toMatch(/partial.*failure|1 item/i)
  })

  it('returns unauthorized when approve fails with unauthorized', async () => {
    mockBbFetch.mockRejectedValue(new BitbucketApiError({ kind: 'unauthorized' }))

    const result = await bitbucketProvider.submitReview(REF, 'APPROVE', '', [], 'sha')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.kind).toBe('unauthorized')
  })

  it('COMMENT verdict does not call approve or request-changes endpoint', async () => {
    mockBbFetch.mockResolvedValue({})

    await bitbucketProvider.submitReview(REF, 'COMMENT', 'A note', [], 'sha')

    // Should only call comments endpoint (for body), not approve or request-changes
    const calls = mockBbFetch.mock.calls.map(c => c[0] as string)
    expect(calls.every(url => url.includes('/comments'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// authState
// ---------------------------------------------------------------------------

describe('authState', () => {
  it('returns configured=true when bitbucketAuth is set', () => {
    mockGetSettings.mockReturnValue({
      bitbucketAuth: { email: 'user@example.com', token: 'ATBBtoken' },
    } as ReturnType<typeof getSettings>)

    const state = bitbucketProvider.authState()
    expect(state.configured).toBe(true)
    expect(state.hint).toContain('user@example.com')
  })

  it('returns configured=false when bitbucketAuth is null', () => {
    mockGetSettings.mockReturnValue({
      bitbucketAuth: null,
    } as ReturnType<typeof getSettings>)

    const state = bitbucketProvider.authState()
    expect(state.configured).toBe(false)
    expect(state.hint).toMatch(/no.*bitbucket|add.*email|settings/i)
  })
})

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

describe('capabilities', () => {
  it('has correct capability flags', () => {
    expect(bitbucketProvider.capabilities).toEqual({
      resolvedThreads: false,
      checks: true,
      suggestions: false,
      atomicReview: false,
      compare: false,
      selfReviewBlocked: true,
    })
  })

  it('blocks self-review (Bitbucket Cloud rejects approving your own PR)', () => {
    expect(bitbucketProvider.capabilities.selfReviewBlocked).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// id and displayName
// ---------------------------------------------------------------------------

describe('metadata', () => {
  it('id is bitbucket', () => {
    expect(bitbucketProvider.id).toBe('bitbucket')
  })

  it('displayName is Bitbucket', () => {
    expect(bitbucketProvider.displayName).toBe('Bitbucket')
  })
})
