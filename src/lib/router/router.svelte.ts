export type Route =
  | { name: 'landing' }
  | { name: 'review'; owner: string; repo: string; number: number }
  | { name: 'not-found' }

export function matchRoute(pathname: string): Route {
  if (pathname === '/') return { name: 'landing' }
  const m = pathname.match(/^\/review\/([^/]+)\/([^/]+)\/(\d+)$/)
  if (m) {
    const number = Number(m[3])
    if (Number.isSafeInteger(number) && number >= 1)
      return { name: 'review', owner: m[1], repo: m[2], number }
  }
  return { name: 'not-found' }
}

function currentRoute(): Route {
  return matchRoute(location.pathname)
}

export const router = $state<{ route: Route }>({ route: { name: 'landing' } })

export function startRouter(): void {
  router.route = currentRoute()
  window.addEventListener('popstate', () => { router.route = currentRoute() })
}

export function navigate(path: string): void {
  history.pushState(null, '', path)
  router.route = currentRoute()
}
