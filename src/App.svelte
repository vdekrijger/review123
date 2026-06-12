<script lang="ts">
  import { router, startRouter, navigate } from './lib/router/router.svelte'
  import Landing from './routes/Landing.svelte'
  import Review from './routes/Review.svelte'
  import AuthCallback from './routes/AuthCallback.svelte'
  import SettingsPage from './routes/SettingsPage.svelte'
  import GitHubSignInButton from './components/GitHubSignInButton.svelte'
  import { beginSignIn, signOut } from './lib/auth/auth'
  import { authState } from './lib/auth/authState.svelte'

  const RETURN_KEY = 'review123:returnTo'
  const SETTINGS_RETURN_KEY = 'review123:settingsReturnTo'

  startRouter()

  async function handleSignIn() {
    sessionStorage.setItem(RETURN_KEY, location.pathname)
    location.assign(await beginSignIn('public_repo'))
  }

  function handleSignOut() {
    signOut()
    // signOut() calls saveGithubAuth(null) → refreshAuthState() → authState.auth
    // updates reactively, so no local state sync needed here.
  }

  function handleSettingsClick() {
    // Remember the current path so the settings page can navigate back
    sessionStorage.setItem(SETTINGS_RETURN_KEY, location.pathname)
    navigate('/settings')
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
      <button class="btn" onclick={handleSignOut}>Sign out</button>
    {:else if clientId}
      <GitHubSignInButton onclick={handleSignIn} />
    {/if}
    <button class="btn" aria-label="Settings" onclick={handleSettingsClick}>⚙</button>
  </div>
</header>

{#if router.route.name === 'landing'}
  <Landing />
{:else if router.route.name === 'review'}
  {@const route = router.route}
  {#key `${route.provider}/${route.owner}/${route.repo}/${route.number}`}
    <Review owner={route.owner} repo={route.repo} number={route.number} step={route.step} provider={route.provider} />
  {/key}
{:else if router.route.name === 'auth-callback'}
  <AuthCallback />
{:else if router.route.name === 'settings'}
  {@const route = router.route}
  <SettingsPage section={route.section} />
{:else}
  <section><h1>Not found</h1><p>That isn't a valid review link. <a href="/">Go home</a>.</p></section>
{/if}

<style>
  :global(:root) {
    --topbar-h: 2.75rem;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1rem;
    height: var(--topbar-h);
    box-sizing: border-box;
    background: var(--surface);
    border-bottom: 1px solid var(--hairline);
    position: sticky;
    top: 0;
    z-index: 200;
  }
  .topbar a {
    font-weight: 700;
    text-decoration: none;
    color: var(--text);
    font-size: 1rem;
    letter-spacing: -0.01em;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .auth-badge {
    font-size: 0.85em;
    color: var(--text-muted);
  }
</style>
