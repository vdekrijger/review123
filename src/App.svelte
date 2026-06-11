<script lang="ts">
  import { router, startRouter } from './lib/router/router.svelte'
  import Landing from './routes/Landing.svelte'
  import Review from './routes/Review.svelte'
  import SettingsPanel from './components/SettingsPanel.svelte'

  startRouter()
  let settingsOpen = $state(false)
</script>

<header class="topbar">
  <a href="/">Review 1‑2‑3</a>
  <button aria-label="Settings" onclick={() => (settingsOpen = true)}>⚙</button>
</header>

{#if settingsOpen}<SettingsPanel onclose={() => (settingsOpen = false)} />{/if}

{#if router.route.name === 'landing'}
  <Landing />
{:else if router.route.name === 'review'}
  {@const route = router.route}
  {#key `${route.owner}/${route.repo}/${route.number}`}
    <Review owner={route.owner} repo={route.repo} number={route.number} />
  {/key}

{:else}
  <section><h1>Not found</h1><p>That isn't a valid review link. <a href="/">Go home</a>.</p></section>
{/if}

<style>
  .topbar { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 1rem; border-bottom: 1px solid #8884; }
  .topbar a { font-weight: 700; text-decoration: none; color: inherit; }
</style>
