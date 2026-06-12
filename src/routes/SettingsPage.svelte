<script lang="ts">
  import { navigate } from '../lib/router/router.svelte'
  import AppearanceSection from '../components/settings/AppearanceSection.svelte'
  import ProvidersSection from '../components/settings/ProvidersSection.svelte'
  import AiModelsSection from '../components/settings/AiModelsSection.svelte'
  import SkillsSection from '../components/settings/SkillsSection.svelte'

  let { section }: { section?: string } = $props()

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

  // Scroll to anchor section on mount if provided
  $effect(() => {
    if (section) {
      const el = document.getElementById(section)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  })

  const NAV_ITEMS = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'providers', label: 'Providers & access' },
    { id: 'ai-models', label: 'AI models' },
    { id: 'skills', label: 'Reviewer skills' },
  ] as const
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
            <a href="#{item.id}" class="nav-link">{item.label}</a>
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
    display: block;
    font-size: 0.88em;
    color: var(--text-muted);
    text-decoration: none;
    padding: 0.3rem 0.5rem;
    border-radius: 5px;
  }

  .nav-link:hover {
    background: var(--surface-raised);
    color: var(--text);
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
