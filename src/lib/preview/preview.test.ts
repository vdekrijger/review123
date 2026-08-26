/**
 * preview.ts unit tests — deploy-preview detection (deterministic, zero LLM).
 *
 * Covers:
 *   - state mapping (deployment statuses, commit statuses, check runs)
 *   - host-pattern matching (*.vercel.app / *.netlify.app / *.pages.dev,
 *     and NOT the platforms' dashboards)
 *   - dedupe + pick-best (ready > building > failed, newest within a state)
 *   - sha-behind detection
 *   - iframe URL hygiene (https only, query/hash/credentials stripped)
 *   - the fetch ladder: deployments path → no-sha fallback → checks/statuses
 *   - non-GitHub providers expose NO detection method (empty affordance)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  deployStatusToState,
  commitStatusToState,
  checkRunToState,
  previewHostProvider,
  previewLabelProvider,
  providerNameFor,
  dedupePreviews,
  pickBestPreview,
  isPreviewBehind,
  iframeSafeUrl,
  loadPreviewPanelOpen,
  savePreviewPanelOpen,
  getGithubPreviewDeployments,
  _clearPreviewCacheForTest,
  type PreviewDeployment,
} from './preview'
import { gitlabProvider } from '../provider/gitlab'
import { bitbucketProvider } from '../provider/bitbucket'
import { githubProvider } from '../provider/github'
import { jsonResponse } from '../../test-helpers'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function preview(overrides: Partial<PreviewDeployment> = {}): PreviewDeployment {
  return {
    url: 'https://app-abc123.vercel.app',
    providerName: 'vercel',
    state: 'ready',
    updatedAt: '2026-01-02T10:00:00Z',
    sha: 'headsha1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

describe('deployStatusToState', () => {
  it('maps success → ready', () => {
    expect(deployStatusToState('success')).toBe('ready')
  })

  it.each(['in_progress', 'queued', 'pending', 'waiting'])('maps %s → building', (s) => {
    expect(deployStatusToState(s)).toBe('building')
  })

  it.each(['failure', 'error'])('maps %s → failed', (s) => {
    expect(deployStatusToState(s)).toBe('failed')
  })

  it('skips inactive (superseded deployment) and unknown states', () => {
    expect(deployStatusToState('inactive')).toBeNull()
    expect(deployStatusToState('destroyed')).toBeNull()
    expect(deployStatusToState('')).toBeNull()
  })
})

describe('commitStatusToState', () => {
  it('maps the four commit-status states', () => {
    expect(commitStatusToState('success')).toBe('ready')
    expect(commitStatusToState('pending')).toBe('building')
    expect(commitStatusToState('failure')).toBe('failed')
    expect(commitStatusToState('error')).toBe('failed')
    expect(commitStatusToState('weird')).toBeNull()
  })
})

describe('checkRunToState', () => {
  it('non-completed status → building regardless of conclusion', () => {
    expect(checkRunToState('in_progress', null)).toBe('building')
    expect(checkRunToState('queued', null)).toBe('building')
  })

  it('completed success → ready; failure/timed_out → failed', () => {
    expect(checkRunToState('completed', 'success')).toBe('ready')
    expect(checkRunToState('completed', 'failure')).toBe('failed')
    expect(checkRunToState('completed', 'timed_out')).toBe('failed')
  })

  it('neutral / skipped / cancelled are NOT preview outcomes', () => {
    expect(checkRunToState('completed', 'neutral')).toBeNull()
    expect(checkRunToState('completed', 'skipped')).toBeNull()
    expect(checkRunToState('completed', 'cancelled')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Host / label matching
// ---------------------------------------------------------------------------

describe('previewHostProvider', () => {
  it('matches the three preview host families (subdomains)', () => {
    expect(previewHostProvider('https://my-app-git-branch-team.vercel.app/x')).toBe('vercel')
    expect(previewHostProvider('https://deploy-preview-12--site.netlify.app')).toBe('netlify')
    expect(previewHostProvider('https://abc123.my-site.pages.dev')).toBe('cloudflare-pages')
  })

  it('does NOT match platform dashboards or lookalike hosts', () => {
    expect(previewHostProvider('https://vercel.com/team/project/deploy')).toBeNull()
    expect(previewHostProvider('https://app.netlify.com/sites/x/deploys/1')).toBeNull()
    expect(previewHostProvider('https://evilvercel.app')).toBeNull() // no dot boundary
    expect(previewHostProvider('https://example.com/vercel.app')).toBeNull() // path, not host
  })

  it('returns null for garbage / empty urls', () => {
    expect(previewHostProvider('not a url')).toBeNull()
    expect(previewHostProvider(null)).toBeNull()
    expect(previewHostProvider('')).toBeNull()
  })
})

describe('previewLabelProvider / providerNameFor', () => {
  it('matches names loosely', () => {
    expect(previewLabelProvider('Vercel')).toBe('vercel')
    expect(previewLabelProvider('netlify/deploy-preview')).toBe('netlify')
    expect(previewLabelProvider('Cloudflare Pages')).toBe('cloudflare-pages')
    expect(previewLabelProvider('ci/unit-tests')).toBeNull()
  })

  it('providerNameFor prefers host over label, falls back to the fixed enum "deploy"', () => {
    // Host wins over a conflicting label
    expect(providerNameFor('https://x.netlify.app', 'Vercel')).toBe('netlify')
    // No host → label
    expect(providerNameFor(null, 'Vercel – my-app')).toBe('vercel')
    // Neither → generic. NEVER the raw label (it feeds analytics).
    expect(providerNameFor('https://previews.internal.example.com', 'staging-env-42')).toBe('deploy')
  })
})

// ---------------------------------------------------------------------------
// Dedupe + pick-best + behind
// ---------------------------------------------------------------------------

describe('dedupePreviews', () => {
  it('dedupes by URL (trailing slash insensitive), keeping the newest', () => {
    const older = preview({ url: 'https://a.vercel.app/', updatedAt: '2026-01-01T00:00:00Z', state: 'building' })
    const newer = preview({ url: 'https://a.vercel.app', updatedAt: '2026-01-02T00:00:00Z', state: 'ready' })
    const other = preview({ url: 'https://b.netlify.app', providerName: 'netlify' })
    const result = dedupePreviews([older, newer, other])
    expect(result).toHaveLength(2)
    expect(result.find((p) => p.url.includes('a.vercel.app'))?.state).toBe('ready')
  })

  it('keeps URL-less candidates for different shas apart', () => {
    const a = preview({ url: '', sha: 'sha-one', state: 'building' })
    const b = preview({ url: '', sha: 'sha-two', state: 'building' })
    expect(dedupePreviews([a, b])).toHaveLength(2)
  })
})

describe('pickBestPreview', () => {
  it('prefers ready over building over failed', () => {
    const failed = preview({ state: 'failed', url: 'https://f.vercel.app' })
    const building = preview({ state: 'building', url: 'https://b.vercel.app' })
    const ready = preview({ state: 'ready', url: 'https://r.vercel.app' })
    expect(pickBestPreview([failed, building, ready])?.url).toBe('https://r.vercel.app')
    expect(pickBestPreview([failed, building])?.url).toBe('https://b.vercel.app')
    expect(pickBestPreview([failed])?.url).toBe('https://f.vercel.app')
  })

  it('prefers the NEWEST within the same state (newest successful wins)', () => {
    const oldReady = preview({ url: 'https://old.vercel.app', updatedAt: '2026-01-01T00:00:00Z' })
    const newReady = preview({ url: 'https://new.vercel.app', updatedAt: '2026-01-03T00:00:00Z' })
    expect(pickBestPreview([oldReady, newReady])?.url).toBe('https://new.vercel.app')
  })

  it('returns null for an empty list', () => {
    expect(pickBestPreview([])).toBeNull()
  })
})

describe('isPreviewBehind', () => {
  it('true when the deployment sha differs from head', () => {
    expect(isPreviewBehind(preview({ sha: 'older' }), 'headsha1')).toBe(true)
  })

  it('false when shas match or the source did not say', () => {
    expect(isPreviewBehind(preview({ sha: 'headsha1' }), 'headsha1')).toBe(false)
    expect(isPreviewBehind(preview({ sha: '' }), 'headsha1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// iframe URL hygiene — no token leakage into the frame
// ---------------------------------------------------------------------------

describe('iframeSafeUrl', () => {
  it('strips query params and hash (tokens never forwarded)', () => {
    expect(iframeSafeUrl('https://a.vercel.app/path?x-vercel-protection-bypass=SECRET#frag')).toBe(
      'https://a.vercel.app/path',
    )
  })

  it('strips embedded credentials', () => {
    expect(iframeSafeUrl('https://user:token@a.vercel.app/p')).toBe('https://a.vercel.app/p')
  })

  it('rejects non-https and unparseable urls', () => {
    expect(iframeSafeUrl('http://a.vercel.app')).toBeNull()
    expect(iframeSafeUrl('javascript:alert(1)')).toBeNull()
    expect(iframeSafeUrl('not a url')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Panel persistence (per-browser localStorage)
// ---------------------------------------------------------------------------

describe('preview panel persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to closed, persists open/closed round-trip', () => {
    expect(loadPreviewPanelOpen()).toBe(false)
    savePreviewPanelOpen(true)
    expect(loadPreviewPanelOpen()).toBe(true)
    savePreviewPanelOpen(false)
    expect(loadPreviewPanelOpen()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fetch ladder — getGithubPreviewDeployments
// ---------------------------------------------------------------------------

const REPO = { owner: 'o', repo: 'r' }
const HEAD = 'headsha1'

function makeDeployment(id: number, sha: string, environment = 'Preview') {
  return { id, sha, environment, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T01:00:00Z' }
}

function makeStatus(state: string, environment_url: string | null, updated_at = '2026-01-01T02:00:00Z') {
  return { state, environment_url, updated_at }
}

/** Route stubbed fetch responses by URL substring; unmatched → 404. */
function stubFetch(routes: Array<[string, unknown]>) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      calls.push(url)
      for (const [needle, body] of routes) {
        if (url.includes(needle)) return Promise.resolve(jsonResponse(body))
      }
      return Promise.resolve(jsonResponse({ message: 'Not Found' }, {}, 404))
    }),
  )
  return calls
}

describe('getGithubPreviewDeployments — ladder', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    _clearPreviewCacheForTest()
  })

  it('rung 1: deployments?sha=head → statuses → ready preview with environment_url', async () => {
    stubFetch([
      [`/deployments?per_page=10&sha=${HEAD}`, [makeDeployment(11, HEAD)]],
      ['/deployments/11/statuses', [makeStatus('success', 'https://app-abc.vercel.app')]],
    ])
    const result = await getGithubPreviewDeployments(REPO, HEAD)
    expect(result).toEqual([
      {
        url: 'https://app-abc.vercel.app',
        providerName: 'vercel',
        state: 'ready',
        updatedAt: '2026-01-01T02:00:00Z',
        sha: HEAD,
      },
    ])
  })

  it('uses the NEWEST status (first in the list) to define the state', async () => {
    stubFetch([
      [`/deployments?per_page=10&sha=${HEAD}`, [makeDeployment(11, HEAD)]],
      [
        '/deployments/11/statuses',
        [
          makeStatus('in_progress', null, '2026-01-01T03:00:00Z'),
          makeStatus('success', 'https://app-abc.vercel.app', '2026-01-01T02:00:00Z'),
        ],
      ],
    ])
    const result = await getGithubPreviewDeployments(REPO, HEAD)
    expect(result).toHaveLength(1)
    expect(result[0].state).toBe('building')
  })

  it('skips deployments whose latest status is inactive (superseded)', async () => {
    stubFetch([
      [`/deployments?per_page=10&sha=${HEAD}`, [makeDeployment(11, HEAD)]],
      ['/deployments/11/statuses', [makeStatus('inactive', 'https://app-abc.vercel.app')]],
    ])
    // Falls through the whole ladder (rungs 2 and 3 are 404s here) → empty
    expect(await getGithubPreviewDeployments(REPO, HEAD)).toEqual([])
  })

  it('rung 2: empty head-sha deployments → unfiltered list yields a BEHIND preview', async () => {
    stubFetch([
      [`/deployments?per_page=10&sha=${HEAD}`, []],
      ['/deployments?per_page=10', [makeDeployment(22, 'oldersha')]],
      ['/deployments/22/statuses', [makeStatus('success', 'https://app-old.vercel.app')]],
    ])
    const result = await getGithubPreviewDeployments(REPO, HEAD)
    expect(result).toHaveLength(1)
    expect(result[0].sha).toBe('oldersha')
    expect(isPreviewBehind(result[0], HEAD)).toBe(true)
  })

  it('rung 3: no deployments at all → check-runs + commit-status fallback (host matched)', async () => {
    stubFetch([
      ['/deployments?', []],
      [
        `/commits/${HEAD}/check-runs`,
        {
          check_runs: [
            // unrelated CI check — must not surface
            { name: 'unit-tests', status: 'completed', conclusion: 'success', details_url: 'https://ci.example.com/1' },
            {
              name: 'Netlify deploy',
              status: 'completed',
              conclusion: 'success',
              details_url: 'https://deploy-preview-7--site.netlify.app',
              completed_at: '2026-01-01T05:00:00Z',
            },
          ],
        },
      ],
      [`/commits/${HEAD}/status`, { statuses: [] }],
    ])
    const result = await getGithubPreviewDeployments(REPO, HEAD)
    expect(result).toEqual([
      {
        url: 'https://deploy-preview-7--site.netlify.app',
        providerName: 'netlify',
        state: 'ready',
        updatedAt: '2026-01-01T05:00:00Z',
        sha: HEAD,
      },
    ])
  })

  it('rung 3: commit STATUSES with a preview-host target_url surface too', async () => {
    stubFetch([
      ['/deployments?', []],
      [`/commits/${HEAD}/check-runs`, { check_runs: [] }],
      [
        `/commits/${HEAD}/status`,
        {
          statuses: [
            { context: 'deploy/cloudflare', state: 'success', target_url: 'https://abc.site.pages.dev', updated_at: '2026-01-01T06:00:00Z' },
          ],
        },
      ],
    ])
    const result = await getGithubPreviewDeployments(REPO, HEAD)
    expect(result).toHaveLength(1)
    expect(result[0].providerName).toBe('cloudflare-pages')
    expect(result[0].url).toBe('https://abc.site.pages.dev')
  })

  it('rung 3: a name-matched check whose URL is a DASHBOARD never surfaces as ready', async () => {
    stubFetch([
      ['/deployments?', []],
      [
        `/commits/${HEAD}/check-runs`,
        {
          check_runs: [
            // "ready" but the link is vercel.com (dashboard) — not a preview
            { name: 'Vercel', status: 'completed', conclusion: 'success', details_url: 'https://vercel.com/team/proj/deploy' },
          ],
        },
      ],
      [`/commits/${HEAD}/status`, { statuses: [] }],
    ])
    expect(await getGithubPreviewDeployments(REPO, HEAD)).toEqual([])
  })

  it('rung 3: a name-matched BUILDING check surfaces as a URL-less state note', async () => {
    stubFetch([
      ['/deployments?', []],
      [
        `/commits/${HEAD}/check-runs`,
        { check_runs: [{ name: 'Vercel', status: 'in_progress', conclusion: null, details_url: 'https://vercel.com/x' }] },
      ],
      [`/commits/${HEAD}/status`, { statuses: [] }],
    ])
    const result = await getGithubPreviewDeployments(REPO, HEAD)
    expect(result).toHaveLength(1)
    expect(result[0].state).toBe('building')
    expect(result[0].url).toBe('')
  })

  it('dedupes across sources by URL', async () => {
    stubFetch([
      [`/deployments?per_page=10&sha=${HEAD}`, [makeDeployment(1, HEAD), makeDeployment(2, HEAD)]],
      ['/deployments/1/statuses', [makeStatus('success', 'https://same.vercel.app', '2026-01-01T02:00:00Z')]],
      ['/deployments/2/statuses', [makeStatus('success', 'https://same.vercel.app/', '2026-01-01T03:00:00Z')]],
    ])
    const result = await getGithubPreviewDeployments(REPO, HEAD)
    expect(result).toHaveLength(1)
    expect(result[0].updatedAt).toBe('2026-01-01T03:00:00Z')
  })

  it('caches per repo+sha (no second network round-trip)', async () => {
    const calls = stubFetch([
      [`/deployments?per_page=10&sha=${HEAD}`, [makeDeployment(11, HEAD)]],
      ['/deployments/11/statuses', [makeStatus('success', 'https://app-abc.vercel.app')]],
    ])
    await getGithubPreviewDeployments(REPO, HEAD)
    const afterFirst = calls.length
    const second = await getGithubPreviewDeployments(REPO, HEAD)
    expect(calls.length).toBe(afterFirst)
    expect(second).toHaveLength(1)
  })

  it('never throws: API errors and malformed bodies yield []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await getGithubPreviewDeployments(REPO, HEAD)).toEqual([])

    _clearPreviewCacheForTest()
    stubFetch([
      ['/deployments?', { message: 'not an array' }],
      [`/commits/${HEAD}/check-runs`, { unexpected: true }],
      [`/commits/${HEAD}/status`, 'garbage'],
    ])
    expect(await getGithubPreviewDeployments(REPO, HEAD)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Provider capability surface — GitHub-only in v1
// ---------------------------------------------------------------------------

describe('provider capability (method presence)', () => {
  it('github implements getPreviewDeployments; gitlab/bitbucket do NOT (affordance stays absent)', () => {
    expect(typeof githubProvider.getPreviewDeployments).toBe('function')
    // Additive future support: when these grow the method, the affordance
    // lights up with zero UI changes. Until then callers get no previews.
    expect(gitlabProvider.getPreviewDeployments).toBeUndefined()
    expect(bitbucketProvider.getPreviewDeployments).toBeUndefined()
  })
})
