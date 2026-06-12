export type Route =
  | { name: 'landing' }
  | { name: 'review'; owner: string; repo: string; number: number; step: 1 | 2 | 3 }
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

export function matchRoute(pathname: string): Route {
  if (pathname === '/') return { name: 'landing' }
  if (pathname === '/auth/callback') return { name: 'auth-callback' }
  const m = pathname.match(/^\/review\/([^/]+)\/([^/]+)\/(\d+)(?:\/([^/]*))?$/)
  if (m) {
    const number = Number(m[3])
    if (Number.isSafeInteger(number) && number >= 1) {
      const slug = m[4] // undefined when absent
      if (slug === undefined || slug === '') {
        return { name: 'review', owner: m[1], repo: m[2], number, step: 1 }
      }
      const step = STEP_SLUGS[slug]
      if (step !== undefined) {
        return { name: 'review', owner: m[1], repo: m[2], number, step }
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
