export type Route =
  | { name: 'landing' }
  | { name: 'review'; provider: 'github' | 'gitlab' | 'bitbucket'; owner: string; repo: string; number: number; step: 1 | 2 | 3 }
  | { name: 'auth-callback' }
  | { name: 'not-found' }

const STEP_SLUGS: Record<string, 1 | 2 | 3> = {
  understand: 1,
  inspect: 2,
  verdict: 3,
}

export const STEP_PATHS: Record<1 | 2 | 3, string> = {
  1: 'understand',
  2: 'inspect',
  3: 'verdict',
}

const PROVIDER_NAMES = new Set(['github', 'gitlab', 'bitbucket'])

function isProvider(s: string): s is 'github' | 'gitlab' | 'bitbucket' {
  return PROVIDER_NAMES.has(s)
}

export function matchRoute(pathname: string): Route {
  if (pathname === '/') return { name: 'landing' }
  if (pathname === '/auth/callback') return { name: 'auth-callback' }

  // Provider-qualified form: /review/:provider/:owner/:repo/:number[/:step]
  // where :provider ∈ github|gitlab|bitbucket
  const mProvider = pathname.match(
    /^\/review\/(github|gitlab|bitbucket)\/([^/]+)\/([^/]+)\/(\d+)(?:\/([^/]*))?$/,
  )
  if (mProvider) {
    const provider = mProvider[1] as 'github' | 'gitlab' | 'bitbucket'
    const owner = mProvider[2]
    const repo = mProvider[3]
    const number = Number(mProvider[4])
    if (Number.isSafeInteger(number) && number >= 1) {
      const slug = mProvider[5] // undefined when absent
      if (slug === undefined || slug === '') {
        return { name: 'review', provider, owner, repo, number, step: 1 }
      }
      const step = STEP_SLUGS[slug]
      if (step !== undefined) {
        return { name: 'review', provider, owner, repo, number, step }
      }
      return { name: 'not-found' }
    }
  }

  // Legacy form: /review/:owner/:repo/:number[/:step]
  // Matches when segment[1] is NOT a known provider name (3-segment owner/repo/number).
  const mLegacy = pathname.match(/^\/review\/([^/]+)\/([^/]+)\/(\d+)(?:\/([^/]*))?$/)
  if (mLegacy) {
    // If first segment is a provider name, this would have matched above already.
    // Guard defensively in case of future regex changes.
    if (isProvider(mLegacy[1])) {
      return { name: 'not-found' }
    }
    const number = Number(mLegacy[3])
    if (Number.isSafeInteger(number) && number >= 1) {
      const slug = mLegacy[4] // undefined when absent
      if (slug === undefined || slug === '') {
        return { name: 'review', provider: 'github', owner: mLegacy[1], repo: mLegacy[2], number, step: 1 }
      }
      const step = STEP_SLUGS[slug]
      if (step !== undefined) {
        return { name: 'review', provider: 'github', owner: mLegacy[1], repo: mLegacy[2], number, step }
      }
      // Invalid step segment
      return { name: 'not-found' }
    }
  }

  return { name: 'not-found' }
}

export const router = $state<{ route: Route }>({ route: { name: 'landing' } })

let started = false
export function _resetStartedForTest(): void { started = false }
export function startRouter(): void {
  if (started) return
  started = true
  router.route = matchRoute(location.pathname)
  window.addEventListener('popstate', () => { router.route = matchRoute(location.pathname) })
}

export function navigate(path: string): void {
  history.pushState(null, '', path)
  router.route = matchRoute(path)
}
