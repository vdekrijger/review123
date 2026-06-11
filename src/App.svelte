<script lang="ts">
  import { router, startRouter } from './lib/router/router.svelte'
  import Landing from './routes/Landing.svelte'
  import Review from './routes/Review.svelte'
  import AuthCallback from './routes/AuthCallback.svelte'
  import SettingsPanel from './components/SettingsPanel.svelte'
  import { beginSignIn, signOut } from './lib/auth/auth'
  import { authState } from './lib/auth/authState.svelte'

  const RETURN_KEY = 'review123:returnTo'

  startRouter()
  let settingsOpen = $state(false)

  async function handleSignIn() {
    sessionStorage.setItem(RETURN_KEY, location.pathname)
    location.assign(await beginSignIn('public_repo'))
  }

  function handleSignOut() {
    signOut()
    // signOut() calls saveGithubAuth(null) → refreshAuthState() → authState.auth
    // updates reactively, so no local state sync needed here.
  }

  const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined
</script>

<header class="topbar">
  <a href="/">Review 1‑2‑3</a>
  <div class="topbar-right">
    {#if authState.auth}
      <span class="auth-badge" aria-label="Authentication method">
        {authState.auth.method === 'oauth' ? 'GitHub ✓' : 'PAT ✓'}
      </span>
      <button onclick={handleSignOut}>Sign out</button>
    {:else if clientId}
      <button onclick={handleSignIn}>Sign in with GitHub</button>
    {/if}
    <button aria-label="Settings" onclick={() => (settingsOpen = true)}>⚙</button>
  </div>
</header>

{#if settingsOpen}<SettingsPanel onclose={() => { settingsOpen = false }} />{/if}

{#if router.route.name === 'landing'}
  <Landing />
{:else if router.route.name === 'review'}
  {@const route = router.route}
  {#key `${route.owner}/${route.repo}/${route.number}`}
    <Review owner={route.owner} repo={route.repo} number={route.number} />
  {/key}
{:else if router.route.name === 'auth-callback'}
  <AuthCallback />
{:else}
  <section><h1>Not found</h1><p>That isn't a valid review link. <a href="/">Go home</a>.</p></section>
{/if}

<style>
  .topbar { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 1rem; border-bottom: 1px solid #8884; }
  .topbar a { font-weight: 700; text-decoration: none; color: inherit; }
  .topbar-right { display: flex; align-items: center; gap: 0.5rem; }
  .auth-badge { font-size: 0.85em; opacity: 0.8; }
</style>
