/**
 * src/lib/preview/preview.ts — deploy-preview detection (deterministic, zero LLM).
 *
 * Reviewers want to SEE what a change looks like. Most web projects already
 * build the answer per-PR: deploy-preview deployments (Vercel / Netlify /
 * Cloudflare Pages) exposed through the GitHub Deployments API, check runs,
 * and commit statuses. This module finds them so the review header can render
 * an "Open preview ↗" affordance and an embedded preview panel.
 *
 * Detection ladder (in order of reliability):
 *   1. Deployments API for the PR head sha:
 *      GET /repos/{o}/{r}/deployments?sha={headSha} → per deployment
 *      GET .../deployments/{id}/statuses → the newest status carries
 *      environment_url + state. This is the path Vercel/Netlify use.
 *   2. Deployments API WITHOUT the sha filter — catches a preview that only
 *      exists for an OLDER commit (surfaced as "1+ commits behind").
 *   3. Check runs + the combined commit status at the head sha — matched by
 *      vercel / netlify / cloudflare naming or by preview URL hosts
 *      (*.vercel.app, *.netlify.app, *.pages.dev). Covers integrations that
 *      link the preview without creating a GitHub deployment.
 *
 * GitHub-only in v1. GitLab (Environments / Review Apps API) and Bitbucket
 * (Deployments API) can slot in ADDITIVELY later via the same optional
 * provider method (getPreviewDeployments); providers without it simply never
 * render the affordance — zero cost, zero settings.
 */
import { ghFetch } from '../github/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreviewState = 'ready' | 'building' | 'failed'

/**
 * The deploy platform behind a preview. A FIXED enum — this value is sent to
 * analytics (preview_opened.provider_name), so it must never carry a raw
 * environment name, URL, or any other free-form string.
 */
export type PreviewProviderName = 'vercel' | 'netlify' | 'cloudflare-pages' | 'deploy'

export interface PreviewDeployment {
  /**
   * The preview's web URL (deployment status environment_url, or a
   * preview-host check/status target URL). Empty string when the source only
   * tells us a preview is building/failed but not yet where it lives.
   */
  url: string
  providerName: PreviewProviderName
  state: PreviewState
  /** ISO timestamp of the deployment's latest status ('' when unknown). */
  updatedAt: string
  /** Commit the deployment was built from ('' when the source doesn't say). */
  sha: string
}

// ---------------------------------------------------------------------------
// Pure state mapping
// ---------------------------------------------------------------------------

/**
 * Map a GitHub DEPLOYMENT STATUS state to a preview state.
 * Returns null for states that should not surface a preview: 'inactive'
 * (deployment superseded by a newer one) and anything unknown.
 */
export function deployStatusToState(state: string): PreviewState | null {
  switch (state) {
    case 'success':
      return 'ready'
    case 'in_progress':
    case 'queued':
    case 'pending':
    case 'waiting':
      return 'building'
    case 'failure':
    case 'error':
      return 'failed'
    default:
      return null
  }
}

/** Map a COMMIT STATUS state ('success' | 'pending' | 'failure' | 'error'). */
export function commitStatusToState(state: string): PreviewState | null {
  switch (state) {
    case 'success':
      return 'ready'
    case 'pending':
      return 'building'
    case 'failure':
    case 'error':
      return 'failed'
    default:
      return null
  }
}

/**
 * Map a CHECK RUN (status + conclusion) to a preview state.
 * neutral / skipped / cancelled / action_required are not preview outcomes →
 * null (a skipped deploy check is not a failed preview).
 */
export function checkRunToState(status: string, conclusion: string | null): PreviewState | null {
  if (status !== 'completed') return 'building'
  if (conclusion === 'success') return 'ready'
  if (conclusion === 'failure' || conclusion === 'timed_out') return 'failed'
  return null
}

// ---------------------------------------------------------------------------
// Provider-name matching (host first — the reliable signal — then label)
// ---------------------------------------------------------------------------

const PREVIEW_HOST_SUFFIXES: ReadonlyArray<readonly [string, PreviewProviderName]> = [
  ['.vercel.app', 'vercel'],
  ['.netlify.app', 'netlify'],
  ['.pages.dev', 'cloudflare-pages'],
]

/**
 * Identify a deploy platform from a URL's HOST. Suffix-matched on known
 * preview domains only (subdomains of vercel.app / netlify.app / pages.dev);
 * returns null for anything else — including the platforms' own dashboards
 * (vercel.com, app.netlify.com), which are NOT previews.
 */
export function previewHostProvider(url: string | null | undefined): PreviewProviderName | null {
  if (!url) return null
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  for (const [suffix, name] of PREVIEW_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return name
  }
  return null
}

/** Loose matcher for check-run names / status contexts / environment names. */
export function previewLabelProvider(label: string | null | undefined): PreviewProviderName | null {
  if (!label) return null
  const l = label.toLowerCase()
  if (l.includes('vercel')) return 'vercel'
  if (l.includes('netlify')) return 'netlify'
  if (l.includes('cloudflare')) return 'cloudflare-pages'
  return null
}

/**
 * Resolve the FIXED provider enum for a candidate: URL host wins (reliable),
 * label match second, generic 'deploy' otherwise. Never returns the raw label.
 */
export function providerNameFor(
  url: string | null | undefined,
  label?: string | null,
): PreviewProviderName {
  return previewHostProvider(url) ?? previewLabelProvider(label) ?? 'deploy'
}

// ---------------------------------------------------------------------------
// Dedupe + pick-best + freshness
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function dedupeKey(p: PreviewDeployment): string {
  // URL is the identity when we have one; URL-less candidates (building /
  // failed indicators) fall back to platform+sha so they don't collapse into
  // each other across commits.
  return p.url !== '' ? normalizeUrl(p.url) : `#${p.providerName}#${p.sha}`
}

/** Dedupe by preview URL (or platform+sha when URL-less), keeping the newest. */
export function dedupePreviews(list: PreviewDeployment[]): PreviewDeployment[] {
  const byKey = new Map<string, PreviewDeployment>()
  for (const p of list) {
    const key = dedupeKey(p)
    const existing = byKey.get(key)
    if (!existing || (Date.parse(p.updatedAt) || 0) > (Date.parse(existing.updatedAt) || 0)) {
      byKey.set(key, p)
    }
  }
  return [...byKey.values()]
}

const STATE_RANK: Record<PreviewState, number> = { ready: 0, building: 1, failed: 2 }

/** Pick the preview to surface: ready > building > failed; newest within a state. */
export function pickBestPreview(list: PreviewDeployment[]): PreviewDeployment | null {
  if (list.length === 0) return null
  return [...list].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  )[0]
}

/**
 * Freshness honesty: true when the preview was built from a different commit
 * than the current PR head. Sha comparison only — we say "1+ commits behind"
 * without pretending to know the exact count.
 */
export function isPreviewBehind(preview: Pick<PreviewDeployment, 'sha'>, headSha: string): boolean {
  return preview.sha !== '' && preview.sha !== headSha
}

// ---------------------------------------------------------------------------
// iframe URL hygiene
// ---------------------------------------------------------------------------

/**
 * The URL the embedded <iframe> may load: https only, credentials stripped,
 * query/hash DROPPED — tokens or signed params from the deployment status are
 * never forwarded into the frame. Returns null when the URL is not safely
 * frameable (non-https / unparseable).
 */
export function iframeSafeUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  return `${u.origin}${u.pathname}`
}

// ---------------------------------------------------------------------------
// Panel-open persistence (per-browser, like diffMode / railCollapsed)
// ---------------------------------------------------------------------------

const PANEL_KEY = 'review123:previewPanelOpen'

export function loadPreviewPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === '1'
  } catch {
    return false
  }
}

export function savePreviewPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_KEY, open ? '1' : '0')
  } catch {
    // storage unavailable — the toggle still works for this page view
  }
}

// ---------------------------------------------------------------------------
// GitHub detection (fetch helpers) — used by the github provider adapter
// ---------------------------------------------------------------------------

interface RawDeployment {
  id?: number
  sha?: string
  environment?: string
  updated_at?: string
  created_at?: string
}

interface RawDeployStatus {
  state?: string
  environment_url?: string | null
  updated_at?: string
  created_at?: string
}

interface RawCheckRunsPage {
  check_runs?: {
    name?: string
    status?: string
    conclusion?: string | null
    details_url?: string | null
    completed_at?: string | null
    started_at?: string | null
  }[]
}

interface RawCombinedStatus {
  statuses?: {
    context?: string
    state?: string
    target_url?: string | null
    updated_at?: string
    created_at?: string
  }[]
}

/** How many recent deployments to inspect per rung (statuses cost 1 req each). */
const DEPLOYMENTS_PAGE = 10

// Results are cached per repo+headSha with a short TTL so step navigation and
// re-renders never re-hit the API; a genuinely new deployment shows up on the
// next review load (or after the TTL).
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; value: PreviewDeployment[] }>()

export function _clearPreviewCacheForTest(): void {
  cache.clear()
}

/**
 * Detect deploy previews for a GitHub PR head. Best-effort: every rung
 * swallows its own API errors and the whole thing never throws — preview
 * surfacing is an enhancement, absence is the quiet default.
 */
export async function getGithubPreviewDeployments(
  repo: { owner: string; repo: string },
  headSha: string,
): Promise<PreviewDeployment[]> {
  const key = `${repo.owner}/${repo.repo}@${headSha}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  // Rung 1: deployments for the head sha (the freshest possible preview).
  let found = await fromDeployments(repo, headSha)
  // Rung 2: any recent deployment — an older commit's preview → "behind".
  if (found.length === 0) found = await fromDeployments(repo, null)
  // Rung 3: check runs + commit statuses at head — external integrations
  // that link a preview without creating a GitHub deployment.
  if (found.length === 0) found = await fromChecksAndStatuses(repo, headSha)

  const deduped = dedupePreviews(found)
  cache.set(key, { at: Date.now(), value: deduped })
  return deduped
}

async function fromDeployments(
  repo: { owner: string; repo: string },
  sha: string | null,
): Promise<PreviewDeployment[]> {
  const shaParam = sha ? `&sha=${encodeURIComponent(sha)}` : ''
  let deployments: RawDeployment[]
  try {
    deployments = await ghFetch<RawDeployment[]>(
      `/repos/${repo.owner}/${repo.repo}/deployments?per_page=${DEPLOYMENTS_PAGE}${shaParam}`,
    )
  } catch {
    return []
  }
  if (!Array.isArray(deployments)) return []

  const out: PreviewDeployment[] = []
  for (const dep of deployments.slice(0, DEPLOYMENTS_PAGE)) {
    if (typeof dep?.id !== 'number') continue
    let statuses: RawDeployStatus[]
    try {
      statuses = await ghFetch<RawDeployStatus[]>(
        `/repos/${repo.owner}/${repo.repo}/deployments/${dep.id}/statuses?per_page=5`,
      )
    } catch {
      continue
    }
    if (!Array.isArray(statuses) || statuses.length === 0) continue
    // Statuses come newest-first; the newest one defines the current state.
    const latest = statuses[0]
    const state = deployStatusToState(latest?.state ?? '')
    if (state === null) continue // inactive (superseded) or unknown state
    const url =
      typeof latest?.environment_url === 'string' && latest.environment_url.length > 0
        ? latest.environment_url
        : ''
    // A "ready" preview we can't open is useless — require the URL. Building /
    // failed may not have one yet; they surface as a state note only.
    if (state === 'ready' && url === '') continue
    out.push({
      url,
      providerName: providerNameFor(url || null, dep.environment ?? null),
      state,
      updatedAt: latest?.updated_at ?? latest?.created_at ?? dep.updated_at ?? dep.created_at ?? '',
      sha: typeof dep.sha === 'string' ? dep.sha : '',
    })
  }
  return out
}

async function fromChecksAndStatuses(
  repo: { owner: string; repo: string },
  headSha: string,
): Promise<PreviewDeployment[]> {
  const [runs, combined] = await Promise.all([
    ghFetch<RawCheckRunsPage>(
      `/repos/${repo.owner}/${repo.repo}/commits/${headSha}/check-runs?per_page=100`,
    ).catch(() => null),
    ghFetch<RawCombinedStatus>(`/repos/${repo.owner}/${repo.repo}/commits/${headSha}/status`).catch(
      () => null,
    ),
  ])

  const out: PreviewDeployment[] = []

  for (const run of runs?.check_runs ?? []) {
    const url = typeof run?.details_url === 'string' ? run.details_url : null
    const hostProvider = previewHostProvider(url)
    const labelProvider = previewLabelProvider(run?.name ?? null)
    if (hostProvider === null && labelProvider === null) continue
    const state = checkRunToState(run?.status ?? '', run?.conclusion ?? null)
    if (state === null) continue
    // 'ready' must point AT a preview host — a name-matched check whose
    // details_url is a dashboard (vercel.com, app.netlify.com) is not a
    // preview we can open or embed.
    if (state === 'ready' && hostProvider === null) continue
    out.push({
      url: hostProvider !== null && url !== null ? url : '',
      providerName: hostProvider ?? labelProvider ?? 'deploy',
      state,
      updatedAt: run?.completed_at ?? run?.started_at ?? '',
      sha: headSha,
    })
  }

  for (const st of combined?.statuses ?? []) {
    const url = typeof st?.target_url === 'string' ? st.target_url : null
    const hostProvider = previewHostProvider(url)
    const labelProvider = previewLabelProvider(st?.context ?? null)
    if (hostProvider === null && labelProvider === null) continue
    const state = commitStatusToState(st?.state ?? '')
    if (state === null) continue
    if (state === 'ready' && hostProvider === null) continue
    out.push({
      url: hostProvider !== null && url !== null ? url : '',
      providerName: hostProvider ?? labelProvider ?? 'deploy',
      state,
      updatedAt: st?.updated_at ?? st?.created_at ?? '',
      sha: headSha,
    })
  }

  return out
}
