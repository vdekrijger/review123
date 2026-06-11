export type Route =
  | { name: 'landing' }
  | { name: 'review'; owner: string; repo: string; number: number }
  | { name: 'auth-callback' }
  | { name: 'not-found' }

export function matchRoute(pathname: string): Route {
  if (pathname === '/') return { name: 'landing' }
  if (pathname === '/auth/callback') return { name: 'auth-callback' }
  const m = pathname.match(/^\/review\/([^/]+)\/([^/]+)\/(\d+)$/)
  if (m) {
    const number = Number(m[3])
    if (Number.isSafeInteger(number) && number >= 1)
      return { name: 'review', owner: m[1], repo: m[2], number }
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
