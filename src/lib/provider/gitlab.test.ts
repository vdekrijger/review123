/**
 * Tests for the GitLab provider adapter.
 *
 * Tests cover:
 *  - parseUrl matrix (subgroups, /-/ infix, query/fragments, rejects)
 *  - mapping: diffs → PrFile (rename/new/deleted/modified + patch +/- counting)
 *  - mapping: discussions → comments + resolved ids
 *  - mapping: pipelines+jobs → CiSummary
 *  - mapping: compare
 *  - submission position payloads (new_line vs old_line by side)
 *  - submission partial failure
 *  - token gating (authState + getResolvedCommentIds)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseGitlabUrl, gitlabProvider } from './gitlab'
import { setGitlabToken, setGitlabHost, saveGitlabOAuth } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'
import type { PrRefX } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REF: PrRefX = { provider: 'gitlab', owner: 'mygroup', repo: 'myproject', number: 42 }
const SUBGROUP_REF: PrRefX = { provider: 'gitlab', owner: 'myorg/sub', repo: 'myproject', number: 7 }

// Encoded project IDs as they appear in API paths
const PID = encodeURIComponent('mygroup/myproject')
const SUB_PID = encodeURIComponent('myorg/sub/myproject')

function mockFetch(body: unknown, options: { status?: number; headers?: Record<string, string> } = {}) {
  return vi.fn().mockResolvedValue(jsonResponse(body, options.headers ?? {}, options.status ?? 200))
}

function mockFetchSequence(...calls: Array<{ body: unknown; status?: number; headers?: Record<string, string> }>) {
  let callIndex = 0
  return vi.fn().mockImplementation(() => {
    const call = calls[callIndex] ?? calls[calls.length - 1]
    callIndex++
    return Promise.resolve(jsonResponse(call.body, call.headers ?? {}, call.status ?? 200))
  })
}

// ---------------------------------------------------------------------------
// parseUrl tests
// ---------------------------------------------------------------------------

describe('parseGitlabUrl', () => {
  beforeEach(() => localStorage.clear())

  describe('self-hosted host support', () => {
    it('accepts a URL on the configured self-hosted host', () => {
      setGitlabHost('gitlab.mycompany.com')
      const r = parseGitlabUrl('https://gitlab.mycompany.com/mygroup/myproject/-/merge_requests/42')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'mygroup', repo: 'myproject', number: 42 },
      })
    })

    it('rejects a URL on a different host when custom host is configured', () => {
      setGitlabHost('gitlab.mycompany.com')
      const r = parseGitlabUrl('https://other.host.com/g/p/-/merge_requests/1')
      expect(r.ok).toBe(false)
    })

    it('still accepts gitlab.com URLs when custom host is configured (also accepts configured host)', () => {
      setGitlabHost('gitlab.mycompany.com')
      const r = parseGitlabUrl('https://gitlab.com/g/p/-/merge_requests/1')
      // gitlab.com should still work regardless of custom host
      expect(r.ok).toBe(true)
    })

    it('accepts subgroup paths on the configured self-hosted host', () => {
      setGitlabHost('internal.gitlab.corp')
      const r = parseGitlabUrl('https://internal.gitlab.corp/org/sub/project/-/merge_requests/7')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'org/sub', repo: 'project', number: 7 },
      })
    })

    it('rejects a non-MR URL on the configured host', () => {
      setGitlabHost('gitlab.mycompany.com')
      const r = parseGitlabUrl('https://gitlab.mycompany.com/group/project')
      expect(r.ok).toBe(false)
    })
  })

  describe('valid URLs', () => {
    it('parses a simple group/project MR URL', () => {
      const r = parseGitlabUrl('https://gitlab.com/mygroup/myproject/-/merge_requests/42')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'mygroup', repo: 'myproject', number: 42 },
      })
    })

    it('parses subgroup URL (one level deep)', () => {
      const r = parseGitlabUrl('https://gitlab.com/myorg/sub/myproject/-/merge_requests/7')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'myorg/sub', repo: 'myproject', number: 7 },
      })
    })

    it('parses deeply nested subgroup (3 levels)', () => {
      const r = parseGitlabUrl('https://gitlab.com/a/b/c/proj/-/merge_requests/1')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'a/b/c', repo: 'proj', number: 1 },
      })
    })

    it('strips trailing slash', () => {
      const r = parseGitlabUrl('https://gitlab.com/g/p/-/merge_requests/3/')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'g', repo: 'p', number: 3 },
      })
    })

    it('strips query string', () => {
      const r = parseGitlabUrl('https://gitlab.com/g/p/-/merge_requests/5?foo=bar')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'g', repo: 'p', number: 5 },
      })
    })

    it('strips fragment (#)', () => {
      const r = parseGitlabUrl('https://gitlab.com/g/p/-/merge_requests/5#note_123')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'g', repo: 'p', number: 5 },
      })
    })

    it('strips both query and fragment', () => {
      const r = parseGitlabUrl('https://gitlab.com/g/p/-/merge_requests/5?tab=diffs#note_1')
      expect(r).toEqual({
        ok: true,
        value: { provider: 'gitlab', owner: 'g', repo: 'p', number: 5 },
      })
    })
  })

  describe('rejected URLs', () => {
    it('rejects empty string', () => {
      const r = parseGitlabUrl('')
      expect(r.ok).toBe(false)
    })

    it('rejects a GitHub PR URL', () => {
      const r = parseGitlabUrl('https://github.com/o/r/pull/1')
      expect(r.ok).toBe(false)
    })

    it('rejects a GitLab URL without /-/ infix', () => {
      const r = parseGitlabUrl('https://gitlab.com/g/p/merge_requests/1')
      expect(r.ok).toBe(false)
    })

    it('rejects a GitLab project page (no MR)', () => {
      const r = parseGitlabUrl('https://gitlab.com/g/p')
      expect(r.ok).toBe(false)
    })

    it('rejects a non-URL string', () => {
      const r = parseGitlabUrl('just some text')
      expect(r.ok).toBe(false)
    })

    it('rejects MR iid of 0', () => {
      const r = parseGitlabUrl('https://gitlab.com/g/p/-/merge_requests/0')
      expect(r.ok).toBe(false)
    })

    it('rejects a single-segment path (no group/project split)', () => {
      const r = parseGitlabUrl('https://gitlab.com/p/-/merge_requests/1')
      expect(r.ok).toBe(false)
    })

    it('rejects a Bitbucket PR URL', () => {
      const r = parseGitlabUrl('https://bitbucket.org/ws/repo/pull-requests/1')
      expect(r.ok).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// getPrMeta
// ---------------------------------------------------------------------------

describe('getPrMeta', () => {
  beforeEach(() => localStorage.clear())

  it('maps an open MR to PrMeta', async () => {
    vi.stubGlobal('fetch', mockFetch({
      title: 'My MR',
      state: 'opened',
      description: 'Some description',
      diff_refs: { base_sha: 'base111', head_sha: 'head222', start_sha: 'start333' },
      changes_count: '3',
      author: { username: 'alice' },
    }))
    const meta = await gitlabProvider.getPrMeta(REF)
    expect(meta).toMatchObject({
      title: 'My MR',
      state: 'open',
      merged: false,
      body: 'Some description',
      baseSha: 'base111',
      headSha: 'head222',
      changedFiles: 3,
      authorLogin: 'alice',
    })
  })

  it('maps a missing author to authorLogin null', async () => {
    vi.stubGlobal('fetch', mockFetch({
      title: 'My MR',
      state: 'opened',
      description: null,
      diff_refs: null,
      changes_count: null,
    }))
    const meta = await gitlabProvider.getPrMeta(REF)
    expect(meta.authorLogin).toBeNull()
  })

  it('maps a merged MR correctly', async () => {
    vi.stubGlobal('fetch', mockFetch({
      title: 'Merged MR',
      state: 'merged',
      description: null,
      diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' },
      changes_count: '1',
    }))
    const meta = await gitlabProvider.getPrMeta(REF)
    expect(meta.state).toBe('closed')
    expect(meta.merged).toBe(true)
  })

  it('handles null diff_refs (draft MR not yet diffed)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      title: 'Draft',
      state: 'opened',
      description: null,
      diff_refs: null,
      changes_count: null,
    }))
    const meta = await gitlabProvider.getPrMeta(REF)
    expect(meta.baseSha).toBe('')
    expect(meta.headSha).toBe('')
    expect(meta.changedFiles).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getPrFiles — diff mapping
// ---------------------------------------------------------------------------

describe('getPrFiles', () => {
  beforeEach(() => localStorage.clear())

  const makeDiff = (overrides: Record<string, unknown>) => ({
    old_path: 'src/old.ts',
    new_path: 'src/new.ts',
    diff: '',
    new_file: false,
    deleted_file: false,
    renamed_file: false,
    ...overrides,
  })

  it('maps a modified file', async () => {
    const diff = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,2 +1,3 @@\n context\n-old line\n+new line\n+added line`
    vi.stubGlobal('fetch', mockFetch([makeDiff({
      old_path: 'src/foo.ts',
      new_path: 'src/foo.ts',
      diff,
    })]))
    const files = await gitlabProvider.getPrFiles(REF)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      filename: 'src/foo.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: diff,
    })
    expect(files[0].previousFilename).toBeUndefined()
  })

  it('maps a new file (added)', async () => {
    vi.stubGlobal('fetch', mockFetch([makeDiff({
      old_path: '',
      new_path: 'src/new.ts',
      diff: '+new content\n',
      new_file: true,
    })]))
    const files = await gitlabProvider.getPrFiles(REF)
    expect(files[0].status).toBe('added')
    expect(files[0].filename).toBe('src/new.ts')
    expect(files[0].additions).toBe(1)
    expect(files[0].deletions).toBe(0)
  })

  it('maps a deleted file', async () => {
    vi.stubGlobal('fetch', mockFetch([makeDiff({
      old_path: 'src/gone.ts',
      new_path: 'src/gone.ts',
      diff: '-deleted line\n',
      deleted_file: true,
    })]))
    const files = await gitlabProvider.getPrFiles(REF)
    expect(files[0].status).toBe('removed')
    expect(files[0].deletions).toBe(1)
    expect(files[0].additions).toBe(0)
  })

  it('maps a renamed file with previousFilename', async () => {
    vi.stubGlobal('fetch', mockFetch([makeDiff({
      old_path: 'src/old.ts',
      new_path: 'src/renamed.ts',
      diff: '',
      renamed_file: true,
    })]))
    const files = await gitlabProvider.getPrFiles(REF)
    expect(files[0].status).toBe('renamed')
    expect(files[0].filename).toBe('src/renamed.ts')
    expect(files[0].previousFilename).toBe('src/old.ts')
  })

  it('omits patch when diff is empty (binary/large)', async () => {
    vi.stubGlobal('fetch', mockFetch([makeDiff({
      old_path: 'assets/img.png',
      new_path: 'assets/img.png',
      diff: '',
    })]))
    const files = await gitlabProvider.getPrFiles(REF)
    expect(files[0].patch).toBeUndefined()
  })

  it('correctly counts mixed +/- lines, ignoring diff header lines', async () => {
    const diff = `--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,4 +1,4 @@\n context\n-removed1\n-removed2\n+added1\n+added2\n+added3`
    vi.stubGlobal('fetch', mockFetch([makeDiff({
      old_path: 'src/x.ts',
      new_path: 'src/x.ts',
      diff,
    })]))
    const files = await gitlabProvider.getPrFiles(REF)
    expect(files[0].additions).toBe(3) // 3 lines starting with +
    expect(files[0].deletions).toBe(2) // 2 lines starting with -
  })

  it('paginates across multiple pages', async () => {
    // Page 1: 2 diffs, X-Next-Page: 2
    // Page 2: 1 diff, no next
    const page1 = [
      makeDiff({ new_path: 'a.ts', old_path: 'a.ts' }),
      makeDiff({ new_path: 'b.ts', old_path: 'b.ts' }),
    ]
    const page2 = [makeDiff({ new_path: 'c.ts', old_path: 'c.ts' })]

    vi.stubGlobal('fetch', mockFetchSequence(
      { body: page1, headers: { 'X-Next-Page': '2' } },
      { body: page2, headers: { 'X-Next-Page': '' } },
    ))

    const files = await gitlabProvider.getPrFiles(REF)
    expect(files).toHaveLength(3)
    expect(files.map(f => f.filename)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })
})

// ---------------------------------------------------------------------------
// getCiSummary
// ---------------------------------------------------------------------------

describe('getCiSummary', () => {
  beforeEach(() => localStorage.clear())

  it('returns empty summary when no pipelines', async () => {
    vi.stubGlobal('fetch', mockFetchSequence({ body: [] }))
    const ci = await gitlabProvider.getCiSummary(REF, 'sha')
    expect(ci).toEqual({ total: 0, passed: 0, failed: 0, pending: 0, failures: [] })
  })

  it('maps passed/failed/pending jobs from the latest pipeline', async () => {
    const jobs = [
      { id: 1, name: 'test:unit', status: 'success', stage: 'test', allow_failure: false },
      { id: 2, name: 'test:e2e', status: 'failed', stage: 'test', allow_failure: false },
      { id: 3, name: 'lint', status: 'running', stage: 'test', allow_failure: false },
      { id: 4, name: 'bench', status: 'failed', stage: 'test', allow_failure: true }, // allow_failure → counts as passed
    ]
    vi.stubGlobal('fetch', mockFetchSequence(
      { body: [{ id: 10, status: 'running', sha: 'abc' }] }, // pipelines
      { body: jobs }, // jobs (no pagination)
    ))
    const ci = await gitlabProvider.getCiSummary(REF, 'abc')
    expect(ci.total).toBe(4)
    expect(ci.passed).toBe(2) // test:unit + bench (allow_failure)
    expect(ci.failed).toBe(1) // test:e2e
    expect(ci.pending).toBe(1) // lint
    expect(ci.failures).toHaveLength(1)
    expect(ci.failures[0].name).toBe('test:e2e')
    expect(ci.failures[0].annotations).toEqual([]) // GitLab: always empty
  })

  it('skipped jobs count as passed', async () => {
    const jobs = [
      { id: 1, name: 'optional', status: 'skipped', stage: 'test', allow_failure: false },
    ]
    vi.stubGlobal('fetch', mockFetchSequence(
      { body: [{ id: 10, status: 'success', sha: 'abc' }] },
      { body: jobs },
    ))
    const ci = await gitlabProvider.getCiSummary(REF, 'abc')
    expect(ci.passed).toBe(1)
    expect(ci.failed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getComments + getResolvedCommentIds
// ---------------------------------------------------------------------------

describe('getComments', () => {
  beforeEach(() => localStorage.clear())

  const makeDiscussion = (overrides: Record<string, unknown>) => ({
    id: 'disc1',
    resolved: false,
    notes: [],
    ...overrides,
  })

  const makeNote = (overrides: Record<string, unknown>) => ({
    id: 101,
    author: { username: 'alice', avatar_url: 'https://gitlab.com/avatar/alice.png' },
    body: 'Nice work!',
    created_at: '2025-01-01T10:00:00Z',
    system: false,
    position: null,
    ...overrides,
  })

  it('maps a non-positioned (body-level) note', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeDiscussion({
        notes: [makeNote({ id: 1, position: undefined })],
      }),
    ]))
    const comments = await gitlabProvider.getComments(REF)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      id: 1,
      author: 'alice',
      body: 'Nice work!',
      path: null,
      line: null,
      side: null,
    })
  })

  it('maps an inline note on the RIGHT side (new_line)', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeDiscussion({
        notes: [makeNote({
          id: 2,
          position: {
            position_type: 'text',
            new_path: 'src/foo.ts',
            old_path: 'src/foo.ts',
            new_line: 15,
            old_line: null,
          },
        })],
      }),
    ]))
    const comments = await gitlabProvider.getComments(REF)
    expect(comments[0]).toMatchObject({
      id: 2,
      path: 'src/foo.ts',
      line: 15,
      side: 'RIGHT',
    })
  })

  it('maps an inline note on the LEFT side (old_line)', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeDiscussion({
        notes: [makeNote({
          id: 3,
          position: {
            position_type: 'text',
            new_path: 'src/foo.ts',
            old_path: 'src/foo.ts',
            new_line: null,
            old_line: 8,
          },
        })],
      }),
    ]))
    const comments = await gitlabProvider.getComments(REF)
    expect(comments[0]).toMatchObject({
      id: 3,
      path: 'src/foo.ts',
      line: 8,
      side: 'LEFT',
    })
  })

  it('filters out system notes', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeDiscussion({
        notes: [
          makeNote({ id: 10, system: true, body: 'approved this merge request' }),
          makeNote({ id: 11, system: false, body: 'real comment' }),
        ],
      }),
    ]))
    const comments = await gitlabProvider.getComments(REF)
    expect(comments).toHaveLength(1)
    expect(comments[0].id).toBe(11)
  })

  it('sorts comments by createdAt', async () => {
    vi.stubGlobal('fetch', mockFetch([
      makeDiscussion({
        notes: [
          makeNote({ id: 20, created_at: '2025-01-02T10:00:00Z' }),
          makeNote({ id: 19, created_at: '2025-01-01T10:00:00Z' }),
        ],
      }),
    ]))
    const comments = await gitlabProvider.getComments(REF)
    expect(comments[0].id).toBe(19)
    expect(comments[1].id).toBe(20)
  })
})

describe('getResolvedCommentIds', () => {
  beforeEach(() => localStorage.clear())

  it('returns empty set when no gitlabToken', async () => {
    const ids = await gitlabProvider.getResolvedCommentIds(REF)
    expect(ids.size).toBe(0)
  })

  it('returns ids from resolved discussions when token is present', async () => {
    setGitlabToken('glpat_test123')
    vi.stubGlobal('fetch', mockFetch([
      { id: 'disc1', resolved: true, notes: [{ id: 1 }, { id: 2 }] },
      { id: 'disc2', resolved: false, notes: [{ id: 3 }] },
    ]))
    const ids = await gitlabProvider.getResolvedCommentIds(REF)
    expect(ids.has(1)).toBe(true)
    expect(ids.has(2)).toBe(true)
    expect(ids.has(3)).toBe(false)
  })

  it('returns empty set when fetch fails (non-fatal)', async () => {
    setGitlabToken('glpat_test123')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')))
    const ids = await gitlabProvider.getResolvedCommentIds(REF)
    expect(ids.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getCommits
// ---------------------------------------------------------------------------

describe('getCommits', () => {
  beforeEach(() => localStorage.clear())

  it('maps GitLab commits to PrCommit shape', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { id: 'abc123full', short_id: 'abc123', title: 'feat: add feature\nLong description', authored_date: '2025-06-01T12:00:00Z' },
      { id: 'def456full', short_id: 'def456', title: 'fix: bug fix', authored_date: '2025-06-02T12:00:00Z' },
    ]))
    const commits = await gitlabProvider.getCommits(REF)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({
      sha: 'abc123full',
      shortSha: 'abc123',
      message: 'feat: add feature',
      authoredAt: '2025-06-01T12:00:00Z',
    })
  })
})

// ---------------------------------------------------------------------------
// compareCommits
// ---------------------------------------------------------------------------

describe('compareCommits', () => {
  beforeEach(() => localStorage.clear())

  it('maps compare diffs to PrFile', async () => {
    vi.stubGlobal('fetch', mockFetch({
      diffs: [
        { old_path: 'a.ts', new_path: 'a.ts', diff: '+new\n-old\n', new_file: false, deleted_file: false, renamed_file: false },
        { old_path: '', new_path: 'b.ts', diff: '+added\n', new_file: true, deleted_file: false, renamed_file: false },
      ],
    }))
    const files = await gitlabProvider.compareCommits(
      { owner: 'mygroup', repo: 'myproject' },
      'base-sha',
      'head-sha',
    )
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1 })
    expect(files[1]).toMatchObject({ filename: 'b.ts', status: 'added', additions: 1, deletions: 0 })
  })

  it('handles empty diffs array', async () => {
    vi.stubGlobal('fetch', mockFetch({ diffs: [] }))
    const files = await gitlabProvider.compareCommits({ owner: 'g', repo: 'p' }, 'a', 'b')
    expect(files).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// submitReview — position payloads and partial failure
// ---------------------------------------------------------------------------

describe('submitReview', () => {
  beforeEach(() => localStorage.clear())

  const MR_WITH_DIFF_REFS = {
    title: 'MR',
    state: 'opened',
    description: null,
    diff_refs: { base_sha: 'base111', head_sha: 'head222', start_sha: 'start333' },
    changes_count: '2',
  }

  const makeDraft = (overrides: Partial<{
    path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; startLine?: number
  }> = {}) => ({
    prKey: 'gitlab:mygroup/myproject#42',
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT' as const,
    body: 'Nice work',
    updatedAt: Date.now(),
    ...overrides,
  })

  it('submits a RIGHT-side (new_line) positioned discussion', async () => {
    const calls: Array<[string, RequestInit]> = []
    const f = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push([url as string, init as RequestInit])
      // First call: GET MR meta (needs diff_refs); subsequent: any POST returns { id: 1 }
      if (!init?.method || init.method === 'GET') {
        return Promise.resolve(jsonResponse(MR_WITH_DIFF_REFS))
      }
      return Promise.resolve(jsonResponse({ id: 1 }))
    })
    vi.stubGlobal('fetch', f)

    const result = await gitlabProvider.submitReview(
      REF,
      'COMMENT',
      '',
      [makeDraft({ side: 'RIGHT', line: 10 })],
      'head222',
    )

    expect(result.ok).toBe(true)
    // Second call is the discussion POST
    const discCall = calls.find(([url]) => url.includes('/discussions'))
    expect(discCall).toBeDefined()
    const reqBody = JSON.parse(discCall![1]?.body as string)
    expect(reqBody.position.new_line).toBe(10)
    expect(reqBody.position.old_line).toBeUndefined()
    expect(reqBody.position.new_path).toBe('src/foo.ts')
    expect(reqBody.position.position_type).toBe('text')
  })

  it('submits a LEFT-side (old_line) positioned discussion', async () => {
    const calls: Array<[string, RequestInit]> = []
    const f = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push([url as string, init as RequestInit])
      if (!init?.method || init.method === 'GET') {
        return Promise.resolve(jsonResponse(MR_WITH_DIFF_REFS))
      }
      return Promise.resolve(jsonResponse({ id: 1 }))
    })
    vi.stubGlobal('fetch', f)

    await gitlabProvider.submitReview(
      REF,
      'COMMENT',
      '',
      [makeDraft({ side: 'LEFT', line: 5 })],
      'head222',
    )

    const discCall = calls.find(([url]) => url.includes('/discussions'))
    expect(discCall).toBeDefined()
    const reqBody = JSON.parse(discCall![1]?.body as string)
    expect(reqBody.position.old_line).toBe(5)
    expect(reqBody.position.new_line).toBeUndefined()
  })

  it('posts body as a note (not as a discussion)', async () => {
    const calls: Array<[string, RequestInit]> = []
    const f = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push([url as string, init as RequestInit])
      if (!init?.method || init.method === 'GET') {
        return Promise.resolve(jsonResponse(MR_WITH_DIFF_REFS))
      }
      return Promise.resolve(jsonResponse({ id: 1 }))
    })
    vi.stubGlobal('fetch', f)

    await gitlabProvider.submitReview(REF, 'COMMENT', 'Overall LGTM', [], 'head222')

    const noteCall = calls.find(([url]) => url.includes('/notes'))
    expect(noteCall).toBeDefined()
    const body = JSON.parse(noteCall![1]?.body as string)
    expect(body.body).toBe('Overall LGTM')
  })

  it('prefixes body with "Changes requested:" when verdict is REQUEST_CHANGES', async () => {
    const calls: Array<[string, RequestInit]> = []
    const f = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push([url as string, init as RequestInit])
      if (!init?.method || init.method === 'GET') {
        return Promise.resolve(jsonResponse(MR_WITH_DIFF_REFS))
      }
      return Promise.resolve(jsonResponse({ id: 1 }))
    })
    vi.stubGlobal('fetch', f)

    await gitlabProvider.submitReview(REF, 'REQUEST_CHANGES', 'Please fix this', [], 'head222')

    const noteCall = calls.find(([url]) => url.includes('/notes'))
    expect(noteCall).toBeDefined()
    const body = JSON.parse(noteCall![1]?.body as string)
    expect(body.body).toContain('Changes requested:')
    expect(body.body).toContain('Please fix this')
  })

  it('calls /approve when verdict is APPROVE', async () => {
    const calls: Array<[string, RequestInit]> = []
    const f = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push([url as string, init as RequestInit])
      if (!init?.method || init.method === 'GET') {
        return Promise.resolve(jsonResponse(MR_WITH_DIFF_REFS))
      }
      return Promise.resolve(jsonResponse({ id: 1 }))
    })
    vi.stubGlobal('fetch', f)

    await gitlabProvider.submitReview(REF, 'APPROVE', '', [], 'head222')

    const approveCall = calls.find(([url]) => url.includes('/approve'))
    expect(approveCall).toBeDefined()
    expect(approveCall![1]?.method).toBe('POST')
  })

  it('surfaces a self-approval rejection (401 on /approve) cleanly, not as "Not authenticated"', async () => {
    const f = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return Promise.resolve(jsonResponse(MR_WITH_DIFF_REFS))
      }
      if ((url as string).includes('/approve')) {
        // GitLab answers 401 when the user MAY NOT approve (e.g. own MR)
        return Promise.resolve(jsonResponse({ message: '401 Unauthorized' }, {}, 401))
      }
      return Promise.resolve(jsonResponse({ id: 1 }))
    })
    vi.stubGlobal('fetch', f)

    const result = await gitlabProvider.submitReview(REF, 'APPROVE', 'LGTM', [], 'head222')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/not allowed to approve/i)
      expect(result.message).not.toMatch(/add a gitlab token/i)
    }
  })

  it('returns partial failure outcome enumerating failed drafts', async () => {
    let callCount = 0
    const f = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++
      if (callCount === 1) {
        // MR meta fetch — success
        return Promise.resolve(jsonResponse(MR_WITH_DIFF_REFS))
      }
      // Discussion POSTs — second one fails
      if (callCount === 3) {
        return Promise.resolve(jsonResponse({ message: 'invalid position' }, {}, 422))
      }
      return Promise.resolve(jsonResponse({ id: callCount }))
    })
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/a.ts', line: 1 }),
      makeDraft({ path: 'src/b.ts', line: 2 }),
    ]
    const result = await gitlabProvider.submitReview(REF, 'COMMENT', '', drafts, 'head222')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('1 of 2')
      expect(result.message).toContain('src/b.ts:2')
    }
  })

  it('returns error when MR meta fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, {}, 404)))
    const result = await gitlabProvider.submitReview(REF, 'COMMENT', '', [], '')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/failed to fetch|not found/i)
    }
  })

  it('returns error when diff_refs is null', async () => {
    vi.stubGlobal('fetch', mockFetch({
      title: 'Draft MR',
      state: 'opened',
      description: null,
      diff_refs: null,
      changes_count: null,
    }))
    const result = await gitlabProvider.submitReview(REF, 'COMMENT', '', [], '')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('diff_refs')
    }
  })
})

// ---------------------------------------------------------------------------
// authState + token gating
// ---------------------------------------------------------------------------

describe('authState', () => {
  beforeEach(() => localStorage.clear())

  it('returns configured:false when no token or OAuth', () => {
    const state = gitlabProvider.authState()
    expect(state.configured).toBe(false)
    expect(state.hint).toMatch(/not configured/i)
  })

  it('returns configured:true with PAT hint when PAT token is set', () => {
    setGitlabToken('glpat_secrettoken')
    const state = gitlabProvider.authState()
    expect(state.configured).toBe(true)
    expect(state.hint).toMatch(/PAT/i)
  })

  it('returns configured:true with OAuth hint when valid OAuth is active', () => {
    saveGitlabOAuth({
      token: 'glOAT-active',
      refreshToken: 'glORT',
      expiresAt: Date.now() + 3_600_000,
    })
    const state = gitlabProvider.authState()
    expect(state.configured).toBe(true)
    expect(state.hint).toMatch(/OAuth/i)
  })
})

// ---------------------------------------------------------------------------
// capabilities + suggestionFence
// ---------------------------------------------------------------------------

describe('capabilities', () => {
  it('has the expected capability flags', () => {
    expect(gitlabProvider.capabilities).toEqual({
      resolvedThreads: true,
      checks: true,
      suggestions: true,
      atomicReview: false,
      compare: true,
      commentReplies: true,
      selfReviewBlocked: false,
    })
  })

  it('does NOT block self-review (governed by project settings on GitLab)', () => {
    expect(gitlabProvider.capabilities.selfReviewBlocked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getViewerLogin
// ---------------------------------------------------------------------------

describe('getViewerLogin', () => {
  beforeEach(() => localStorage.clear())

  it('returns the authenticated username from /user', async () => {
    setGitlabToken('glpat-test')
    vi.stubGlobal('fetch', mockFetch({ username: 'alice' }))
    expect(await gitlabProvider.getViewerLogin!()).toBe('alice')
  })

  it('returns null when /user has no username', async () => {
    setGitlabToken('glpat-test')
    vi.stubGlobal('fetch', mockFetch({}))
    expect(await gitlabProvider.getViewerLogin!()).toBeNull()
  })
})

describe('suggestionFence', () => {
  it('produces GitLab-flavoured suggestion fence with :-0+0 modifier', () => {
    const fence = gitlabProvider.suggestionFence!(['const x = 1', 'const y = 2'])
    expect(fence).toContain('```suggestion:-0+0')
    expect(fence).toContain('const x = 1')
    expect(fence).toContain('const y = 2')
    expect(fence).toMatch(/```$/)
  })

  it('works with a single line', () => {
    const fence = gitlabProvider.suggestionFence!(['return true'])
    expect(fence).toBe('```suggestion:-0+0\nreturn true\n```')
  })
})

// ---------------------------------------------------------------------------
// getMyReviewComments
// ---------------------------------------------------------------------------

describe('gitlabProvider.getMyReviewComments', () => {
  beforeEach(() => {
    localStorage.clear()
    setGitlabToken('test-token')
    vi.resetAllMocks()
  })

  it('method exists on gitlab provider', () => {
    expect(typeof gitlabProvider.getMyReviewComments).toBe('function')
  })

  it('fetches /user then MRs then notes, returns own non-system comment bodies', async () => {
    vi.stubGlobal('fetch', mockFetchSequence(
      { body: { username: 'alice' } },
      { body: [{ iid: 1 }] },
      { body: [
          { author: { username: 'alice' }, body: 'Great refactor', system: false },
          { author: { username: 'bob' },   body: 'Looks good', system: false },
          { author: { username: 'alice' }, body: '', system: true },
        ]
      },
    ))

    const result = await gitlabProvider.getMyReviewComments!(
      { owner: 'mygroup', repo: 'myproject' },
      150,
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toBe('Great refactor')
  })

  it('skips system notes', async () => {
    vi.stubGlobal('fetch', mockFetchSequence(
      { body: { username: 'alice' } },
      { body: [{ iid: 1 }] },
      { body: [
          { author: { username: 'alice' }, body: 'System event', system: true },
          { author: { username: 'alice' }, body: 'Real comment', system: false },
        ]
      },
    ))

    const result = await gitlabProvider.getMyReviewComments!(
      { owner: 'mygroup', repo: 'myproject' },
      150,
    )
    expect(result).toEqual(['Real comment'])
  })

  it('strips code fences longer than 10 lines', async () => {
    const longFence = '```ts\n' + Array.from({length: 12}, (_, i) => `line${i}`).join('\n') + '\n```'
    const noteBody = `Before\n${longFence}\nAfter`

    vi.stubGlobal('fetch', mockFetchSequence(
      { body: { username: 'alice' } },
      { body: [{ iid: 1 }] },
      { body: [{ author: { username: 'alice' }, body: noteBody, system: false }] },
    ))

    const result = await gitlabProvider.getMyReviewComments!(
      { owner: 'mygroup', repo: 'myproject' },
      150,
    )
    expect(result[0]).toContain('Before')
    expect(result[0]).toContain('After')
    expect(result[0]).not.toContain('line11')
  })

  it('caps total comments at the cap parameter', async () => {
    const manyNotes = Array.from({ length: 200 }, (_, i) => ({
      author: { username: 'alice' }, body: `comment ${i}`, system: false
    }))

    vi.stubGlobal('fetch', mockFetchSequence(
      { body: { username: 'alice' } },
      { body: [{ iid: 1 }] },
      { body: manyNotes },
    ))

    const result = await gitlabProvider.getMyReviewComments!(
      { owner: 'mygroup', repo: 'myproject' },
      150,
    )
    expect(result.length).toBeLessThanOrEqual(150)
  })

  it('processes multiple MRs (cap 15 MRs)', async () => {
    vi.stubGlobal('fetch', mockFetchSequence(
      { body: { username: 'alice' } },
      { body: [{ iid: 1 }, { iid: 2 }] },
      { body: [{ author: { username: 'alice' }, body: 'comment on MR1', system: false }] },
      { body: [{ author: { username: 'alice' }, body: 'comment on MR2', system: false }] },
    ))

    const result = await gitlabProvider.getMyReviewComments!(
      { owner: 'mygroup', repo: 'myproject' },
      150,
    )
    expect(result).toContain('comment on MR1')
    expect(result).toContain('comment on MR2')
  })
})

// ---------------------------------------------------------------------------
// Registry: GitLab is now registered and parseAnyUrl works
// ---------------------------------------------------------------------------

describe('registry integration', () => {
  beforeEach(() => localStorage.clear())

  it('parseAnyUrl recognizes a gitlab.com MR URL after registration', async () => {
    const { parseAnyUrl } = await import('./registry')
    const result = parseAnyUrl('https://gitlab.com/myorg/myproject/-/merge_requests/5')
    expect(result).not.toBeNull()
    expect(result!.provider.id).toBe('gitlab')
    expect(result!.ref).toMatchObject({
      provider: 'gitlab',
      owner: 'myorg',
      repo: 'myproject',
      number: 5,
    })
  })

  it('parseAnyUrl still recognizes GitHub PRs', async () => {
    const { parseAnyUrl } = await import('./registry')
    const result = parseAnyUrl('https://github.com/owner/repo/pull/123')
    expect(result).not.toBeNull()
    expect(result!.provider.id).toBe('github')
  })

  it('providerFor("gitlab") returns the gitlab provider', async () => {
    const { providerFor } = await import('./registry')
    expect(providerFor('gitlab').id).toBe('gitlab')
  })

  it('parseAnyUrl recognizes a self-hosted GitLab MR URL when host is configured', async () => {
    setGitlabHost('gitlab.mycompany.com')
    const { parseAnyUrl } = await import('./registry')
    const result = parseAnyUrl('https://gitlab.mycompany.com/myorg/myproject/-/merge_requests/99')
    expect(result).not.toBeNull()
    expect(result!.provider.id).toBe('gitlab')
    expect(result!.ref).toMatchObject({
      provider: 'gitlab',
      owner: 'myorg',
      repo: 'myproject',
      number: 99,
    })
  })
})

// ---------------------------------------------------------------------------
// Discussion → thread mapping (commentReplies support)
// ---------------------------------------------------------------------------

describe('getComments — discussion thread mapping', () => {
  beforeEach(() => localStorage.clear())

  const note = (overrides: Record<string, unknown>) => ({
    id: 1,
    author: { username: 'alice', avatar_url: null },
    body: 'note',
    created_at: '2025-01-01T10:00:00Z',
    system: false,
    position: null,
    ...overrides,
  })

  // Fixture mirrors a real GitLab discussions payload: one threaded
  // discussion (root + 2 replies) and one single-note discussion.
  const discussionsFixture = [
    {
      id: 'disc-abc',
      resolved: false,
      notes: [
        note({ id: 100, body: 'root note', created_at: '2025-01-01T10:00:00Z' }),
        note({ id: 101, body: 'first reply', created_at: '2025-01-01T11:00:00Z' }),
        note({ id: 102, body: 'second reply', created_at: '2025-01-01T12:00:00Z' }),
      ],
    },
    {
      id: 'disc-def',
      resolved: false,
      notes: [note({ id: 200, body: 'lone note', created_at: '2025-01-02T10:00:00Z' })],
    },
  ]

  it('first note of a discussion is the root (inReplyTo null); later notes reply to it', async () => {
    vi.stubGlobal('fetch', mockFetch(discussionsFixture))
    const comments = await gitlabProvider.getComments(REF)
    const byId = new Map(comments.map((c) => [c.id, c]))
    expect(byId.get(100)!.inReplyTo).toBeNull()
    expect(byId.get(101)!.inReplyTo).toBe(100)
    expect(byId.get(102)!.inReplyTo).toBe(100)
    expect(byId.get(200)!.inReplyTo).toBeNull()
  })

  it('every note carries the discussion id as threadId (needed for replies)', async () => {
    vi.stubGlobal('fetch', mockFetch(discussionsFixture))
    const comments = await gitlabProvider.getComments(REF)
    const byId = new Map(comments.map((c) => [c.id, c]))
    expect(byId.get(100)!.threadId).toBe('disc-abc')
    expect(byId.get(102)!.threadId).toBe('disc-abc')
    expect(byId.get(200)!.threadId).toBe('disc-def')
  })

  it('system note first in a discussion: root falls to the first NON-system note', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        id: 'disc-sys',
        resolved: false,
        notes: [
          note({ id: 300, system: true, body: 'changed the description' }),
          note({ id: 301, body: 'actual root' }),
          note({ id: 302, body: 'reply', created_at: '2025-01-01T11:00:00Z' }),
        ],
      },
    ]))
    const comments = await gitlabProvider.getComments(REF)
    expect(comments.map((c) => c.id).sort()).toEqual([301, 302])
    const byId = new Map(comments.map((c) => [c.id, c]))
    expect(byId.get(301)!.inReplyTo).toBeNull()
    expect(byId.get(302)!.inReplyTo).toBe(301)
  })
})

// ---------------------------------------------------------------------------
// replyToThread — immediate reply post to a discussion
// ---------------------------------------------------------------------------

describe('replyToThread', () => {
  beforeEach(() => {
    localStorage.clear()
    setGitlabToken('glpat-test')
  })

  const rootComment = {
    id: 100,
    author: 'alice',
    authorAvatar: null,
    body: 'root note',
    createdAt: '2025-01-01T10:00:00Z',
    path: 'src/foo.ts',
    line: 15,
    side: 'RIGHT' as const,
    inReplyTo: null,
    threadId: 'disc-abc',
  }

  it('POSTs to the discussion notes endpoint and returns the mapped comment', async () => {
    const createdNote = {
      id: 999,
      author: { username: 'me', avatar_url: null },
      body: 'my reply',
      created_at: '2025-01-03T10:00:00Z',
      system: false,
      position: null,
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(createdNote))
    vi.stubGlobal('fetch', fetchMock)

    const result = await gitlabProvider.replyToThread!(REF, rootComment, 'my reply')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/projects/${PID}/merge_requests/42/discussions/disc-abc/notes`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ body: 'my reply' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.comment).toMatchObject({
        id: 999,
        author: 'me',
        body: 'my reply',
        inReplyTo: 100,
        threadId: 'disc-abc',
      })
    }
  })

  it('missing threadId → typed error result, no network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await gitlabProvider.replyToThread!(REF, { ...rootComment, threadId: undefined }, 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/discussion id/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('API failure → typed error result, does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'unauthorized' }, {}, 401)))
    const result = await gitlabProvider.replyToThread!(REF, rootComment, 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/not authenticated/i)
  })

  it('capability flag commentReplies is true and the method exists', () => {
    expect(gitlabProvider.capabilities.commentReplies).toBe(true)
    expect(typeof gitlabProvider.replyToThread).toBe('function')
  })
})
