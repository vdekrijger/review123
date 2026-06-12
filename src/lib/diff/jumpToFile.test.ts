import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { scrollToFileCard, jumpToFileDiff } from './jumpToFile'
import { navigate, router } from '../router/router.svelte'

/**
 * Build the DOM the Inspect step renders for one file:
 *   <div id="file-<slug>"><article class="file-diff [is-collapsed]"><header/></article></div>
 */
function mountCard(path: string, opts: { collapsed?: boolean } = {}): {
  wrapper: HTMLDivElement
  article: HTMLElement
  header: HTMLElement
} {
  const wrapper = document.createElement('div')
  wrapper.id = `file-${path.replace(/[^a-zA-Z0-9]/g, '-')}`
  const article = document.createElement('article')
  article.className = opts.collapsed ? 'file-diff is-collapsed' : 'file-diff'
  const header = document.createElement('header')
  article.appendChild(header)
  wrapper.appendChild(article)
  document.body.appendChild(wrapper)
  return { wrapper, article, header }
}

beforeEach(() => {
  document.body.innerHTML = ''
  // jsdom has no scrollIntoView — install a spyable stub
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('scrollToFileCard', () => {
  it('smooth-scrolls the file card into view', () => {
    const { wrapper } = mountCard('src/hot.ts')

    scrollToFileCard('src/hot.ts')

    expect(wrapper.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('expands a collapsed card by clicking its header', () => {
    const { header } = mountCard('src/hot.ts', { collapsed: true })
    const headerClick = vi.fn()
    header.addEventListener('click', headerClick)

    scrollToFileCard('src/hot.ts')

    expect(headerClick).toHaveBeenCalledTimes(1)
  })

  it('does not click the header when the card is already expanded', () => {
    const { header } = mountCard('src/hot.ts')
    const headerClick = vi.fn()
    header.addEventListener('click', headerClick)

    scrollToFileCard('src/hot.ts')

    expect(headerClick).not.toHaveBeenCalled()
  })

  it('retries across animation frames when the card mounts late (step switch)', async () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    scrollToFileCard('src/late.ts')
    expect(rafCallbacks.length).toBe(1)

    // Card not there yet — first frame schedules another retry
    rafCallbacks[0](0)
    expect(rafCallbacks.length).toBe(2)

    // Card mounts between frames
    const { wrapper } = mountCard('src/late.ts')
    rafCallbacks[1](0)

    expect(wrapper.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    // Found → no further frames scheduled
    expect(rafCallbacks.length).toBe(2)
  })

  it('gives up silently after bounded retries when the card never appears', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    scrollToFileCard('src/never.ts')
    // Drain every scheduled frame — must terminate (bounded) and not throw
    for (let i = 0; i < rafCallbacks.length && i < 100; i++) {
      rafCallbacks[i](0)
    }
    expect(rafCallbacks.length).toBeLessThan(50)
  })
})

describe('jumpToFileDiff (hotspot → inspect navigation)', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/review/github/org/repo/1/understand')
    router.route = { name: 'review', provider: 'github', owner: 'org', repo: 'repo', number: 1, step: 1 }
  })

  it('navigates to inspect via history.pushState (SPA) when not already there', () => {
    const pushStateSpy = vi.spyOn(history, 'pushState')
    mountCard('src/hot.ts')

    jumpToFileDiff('src/hot.ts', {
      isInspectActive: false,
      navigateToInspect: () => navigate('/review/github/org/repo/1/inspect'),
    })

    // SPA navigation: pushState called, URL updated, router on step 2 —
    // jsdom would throw on a real document navigation, so reaching these
    // assertions also proves no full page load was triggered.
    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/review/github/org/repo/1/inspect')
    expect(location.pathname).toBe('/review/github/org/repo/1/inspect')
    expect(router.route).toMatchObject({ name: 'review', step: 2 })
  })

  it('scrolls to the card after navigating', () => {
    const { wrapper } = mountCard('src/hot.ts')

    jumpToFileDiff('src/hot.ts', {
      isInspectActive: false,
      navigateToInspect: () => navigate('/review/github/org/repo/1/inspect'),
    })

    expect(wrapper.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('does not push a duplicate history entry when already on inspect', () => {
    history.replaceState(null, '', '/review/github/org/repo/1/inspect')
    router.route = { name: 'review', provider: 'github', owner: 'org', repo: 'repo', number: 1, step: 2 }
    const pushStateSpy = vi.spyOn(history, 'pushState')
    const navigateToInspect = vi.fn()
    const { wrapper } = mountCard('src/hot.ts')

    jumpToFileDiff('src/hot.ts', { isInspectActive: true, navigateToInspect })

    expect(navigateToInspect).not.toHaveBeenCalled()
    expect(pushStateSpy).not.toHaveBeenCalled()
    expect(wrapper.scrollIntoView).toHaveBeenCalled()
  })
})
