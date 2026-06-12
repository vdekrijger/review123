<script lang="ts">
  import { navigate } from '../lib/router/router.svelte'
  import { pickActiveSection, isAtBottom, observeSections } from '../lib/settings/scrollspy'
  import AppearanceSection from '../components/settings/AppearanceSection.svelte'
  import ProvidersSection from '../components/settings/ProvidersSection.svelte'
  import AiModelsSection from '../components/settings/AiModelsSection.svelte'
  import SkillsSection from '../components/settings/SkillsSection.svelte'

  let { section }: { section?: string } = $props()

  const NAV_ITEMS = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'providers', label: 'Providers & access' },
    { id: 'ai-models', label: 'AI models' },
    { id: 'skills', label: 'Reviewer skills' },
  ] as const

  // returnTo: the path to navigate back to when the user clicks Back.
  // Stored in sessionStorage so it survives direct navigation to /settings.
  const RETURN_KEY = 'review123:settingsReturnTo'

  function getReturnPath(): string {
    return sessionStorage.getItem(RETURN_KEY) ?? '/'
  }

  function handleBack() {
    const returnPath = getReturnPath()
    sessionStorage.removeItem(RETURN_KEY)
    navigate(returnPath)
  }

  // --- Scrollspy ---------------------------------------------------------
  // The nav item whose section is most prominently in view gets an active
  // state. Selection logic lives in lib/settings/scrollspy (pure, unit
  // tested); the IntersectionObserver seam degrades to a no-op in jsdom.

  // While a programmatic scroll (nav click or section-prop deep link) is in
  // flight, observer updates are suppressed so the active item doesn't
  // flicker through intermediate sections during smooth scrolling.
  const SCROLL_SUPPRESS_MS = 1000

  function isNavId(id: string | undefined): id is (typeof NAV_ITEMS)[number]['id'] {
    return NAV_ITEMS.some((item) => item.id === id)
  }

  // Initial value only by design: deep-link section sets the starting
  // active item; afterwards the scrollspy/clicks own the state.
  // svelte-ignore state_referenced_locally
  let activeId = $state<string>(isNavId(section) ? section : NAV_ITEMS[0].id)
  let suppressObserverUntil = 0

  function computeActiveFromDom(): string | null {
    const positions = NAV_ITEMS.flatMap((item) => {
      const el = document.getElementById(item.id)
      return el ? [{ id: item.id, top: el.getBoundingClientRect().top }] : []
    })
    return pickActiveSection(
      positions,
      window.innerHeight,
      isAtBottom(window.scrollY, window.innerHeight, document.documentElement.scrollHeight),
    )
  }

  function handleSectionsChanged() {
    if (Date.now() < suppressObserverUntil) return
    const next = computeActiveFromDom()
    if (next) activeId = next
  }

  function handleNavClick(id: string) {
    activeId = id
    suppressObserverUntil = Date.now() + SCROLL_SUPPRESS_MS
  }

  $effect(() => {
    const elements = NAV_ITEMS.map((item) => document.getElementById(item.id)).filter(
      (el): el is HTMLElement => el !== null,
    )
    return observeSections(elements, handleSectionsChanged)
  })

  // Belt-and-braces for the viewport edges: IntersectionObserver only fires
  // on threshold crossings, so the last few pixels toward the very top (or
  // bottom) may not produce a callback and the active item would go stale.
  // A passive scroll listener re-evaluates the cheap pure rule every frame.
  $effect(() => {
    window.addEventListener('scroll', handleSectionsChanged, { passive: true })
    return () => window.removeEventListener('scroll', handleSectionsChanged)
  })

  // Scroll to anchor section on mount if provided
  $effect(() => {
    if (section) {
      const el = document.getElementById(section)
      if (el) {
        suppressObserverUntil = Date.now() + SCROLL_SUPPRESS_MS
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  })
</script>

<div class="settings-page">
  <div class="settings-header">
    <button class="back-btn" onclick={handleBack} aria-label="Back">← Back</button>
    <h1 class="settings-title">Settings</h1>
  </div>

  <div class="settings-layout">
    <!-- Sticky section nav -->
    <nav class="section-nav" aria-label="Settings sections">
      <ul>
        {#each NAV_ITEMS as item (item.id)}
          <li>
            <a
              href="#{item.id}"
              class="nav-link"
              class:active={activeId === item.id}
              aria-current={activeId === item.id ? 'true' : undefined}
              onclick={() => handleNavClick(item.id)}
            >
              {item.label}
            </a>
          </li>
        {/each}
      </ul>
    </nav>

    <!-- Settings content -->
    <main class="settings-content">
      <AppearanceSection />
      <ProvidersSection />
      <AiModelsSection />
      <SkillsSection />
    </main>
  </div>
</div>

<style>
  .settings-page {
    max-width: 860px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }

  .settings-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .back-btn {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.88em;
    padding: 0.25rem 0.65rem;
  }

  .back-btn:hover {
    background: var(--surface-raised);
    color: var(--text);
  }

  .settings-title {
    font-size: 1.4rem;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.02em;
  }

  .settings-layout {
    display: flex;
    gap: 2.5rem;
    align-items: flex-start;
  }

  /* Sticky sidebar nav */
  .section-nav {
    flex-shrink: 0;
    width: 160px;
    position: sticky;
    top: calc(var(--topbar-h, 2.75rem) + 1rem);
  }

  .section-nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .nav-link {
    position: relative;
    display: block;
    font-size: 0.88em;
    color: var(--text-muted);
    text-decoration: none;
    padding: 0.3rem 0.5rem 0.3rem 0.65rem;
    border-radius: 5px;
  }

  .nav-link:hover {
    background: var(--surface-raised);
    color: var(--text);
  }

  /* Small left indicator bar for the active section */
  .nav-link::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 2px;
    height: 0;
    border-radius: 1px;
    background: var(--accent);
    transition: height 120ms ease;
  }

  .nav-link.active {
    color: var(--accent);
    background: var(--accent-subtle);
  }

  .nav-link.active::before {
    height: 65%;
  }

  .settings-content {
    flex: 1;
    min-width: 0;
  }

  /* Responsive: collapse nav on narrow viewports */
  @media (max-width: 600px) {
    .settings-layout {
      flex-direction: column;
      gap: 1rem;
    }

    .section-nav {
      width: 100%;
      position: static;
    }

    .section-nav ul {
      flex-direction: row;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
  }
</style>
