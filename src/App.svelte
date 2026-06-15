<script lang="ts">
  import { router, startRouter, navigate } from './lib/router/router.svelte'
  import Landing from './routes/Landing.svelte'
  import AuthCallback from './routes/AuthCallback.svelte'
  import SettingsPage from './routes/SettingsPage.svelte'
  import GitHubSignInButton from './components/GitHubSignInButton.svelte'
  import GitLabSignInButton from './components/GitLabSignInButton.svelte'
  import BuildIndicator from './components/BuildIndicator.svelte'
  import { signOut } from './lib/auth/auth'
  import { signOutGitlab } from './lib/auth/gitlabAuth'
  import { beginOAuth } from './lib/auth/oauthFlow'
  import { authState } from './lib/auth/authState.svelte'
  import { settingsState } from './lib/settings/settingsState.svelte'

  const SETTINGS_RETURN_KEY = 'review123:settingsReturnTo'

  startRouter()

  // Lazy-load the Review route (the diff viewer and its vendor-diff-view chunk,
  // which bundles the lowlight/highlight.js syntax-highlight engine, plus the
  // markdown pipeline). Keeping it out of the entry's static import graph means
  // none of that is fetched until a review is actually opened — bundle
  // discipline for the highlighter engine.
  let Review = $state<typeof import('./routes/Review.svelte').default | null>(null)
  $effect(() => {
    if (router.route.name === 'review' && !Review) {
      void import('./routes/Review.svelte').then((m) => {
        Review = m.default
      })
    }
  })

  // Both handlers go through the shared beginOAuth helper: it clears stale
  // pending sessions (from abandoned attempts) and stores returnTo, so all
  // entry points behave identically and the callback dispatch stays correct.
  async function handleSignIn() {
    location.assign(await beginOAuth('github'))
  }

  function handleSignOut() {
    signOut()
    // signOut() calls saveGithubAuth(null) → refreshAuthState() → authState.auth
    // updates reactively, so no local state sync needed here.
  }

  async function handleGitlabSignIn() {
    location.assign(await beginOAuth('gitlab'))
  }

  function handleGitlabSignOut() {
    // Independent sessions: clears ONLY gitlabOAuth, never githubAuth.
    signOutGitlab()
  }

  function handleSettingsClick() {
    // Remember the current path so the settings page can navigate back
    sessionStorage.setItem(SETTINGS_RETURN_KEY, location.pathname)
    navigate('/settings')
  }

  const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined
  // Env-gated like everywhere else: no VITE_GITLAB_CLIENT_ID → nothing
  // GitLab-related is rendered in the navbar.
  const gitlabClientId = import.meta.env.VITE_GITLAB_CLIENT_ID as string | undefined

  // GitLab OAuth connection state — reactive via the settingsState facade and
  // fully independent of the GitHub session (authState).
  const gitlabConnected = $derived.by(() => {
    const oauth = settingsState.current.gitlabOAuth
    return !!oauth && Date.now() < oauth.expiresAt
  })
</script>

<header class="topbar">
  <a href="/">Review 1‑2‑3</a>
  <div class="topbar-right">
    {#if authState.auth}
      <span class="auth-badge" aria-label="Authentication method">
        {authState.auth.method === 'oauth' ? 'GitHub ✓' : 'PAT ✓'}
      </span>
      <button
        class="btn signout-btn"
        aria-label="Sign out of GitHub"
        title="Sign out of GitHub"
        onclick={handleSignOut}
      ><span class="signout-full">Sign out</span><span class="signout-short" aria-hidden="true">✕</span></button>
    {:else if clientId}
      <GitHubSignInButton compact onclick={handleSignIn} />
    {/if}
    {#if gitlabClientId}
      {#if gitlabConnected}
        <span class="auth-badge" aria-label="GitLab authentication">GitLab ✓</span>
        <button
          class="btn signout-btn"
          aria-label="Sign out of GitLab"
          title="Sign out of GitLab"
          onclick={handleGitlabSignOut}
        ><span class="signout-full">Sign out</span><span class="signout-short" aria-hidden="true">✕</span></button>
      {:else}
        <GitLabSignInButton compact onclick={handleGitlabSignIn} />
      {/if}
    {/if}
    <button class="btn" aria-label="Settings" onclick={handleSettingsClick}>⚙</button>
  </div>
</header>

<!-- The growing middle of the sticky-footer column. flex:1 makes it fill the
     viewport on SHORT routes so the footer below pins to the page bottom; on
     tall routes (the review/inspect flow) it sizes to its content and the
     footer sits naturally below. No overflow here — the document/body stays the
     scroll container, so the inspect flow's position:sticky descendants (file
     tree drawer, toggle tab, sticky file headers) keep following window scroll. -->
<main class="route-main">
  {#if router.route.name === 'landing'}
    <Landing />
  {:else if router.route.name === 'review'}
    {@const route = router.route}
    {#if Review}
      {#key `${route.provider}/${route.owner}/${route.repo}/${route.number}`}
        <Review owner={route.owner} repo={route.repo} number={route.number} step={route.step} provider={route.provider} />
      {/key}
    {:else}
      <section class="route-loading" aria-busy="true"><p>Loading review…</p></section>
    {/if}
  {:else if router.route.name === 'auth-callback'}
    <AuthCallback />
  {:else if router.route.name === 'settings'}
    {@const route = router.route}
    <SettingsPage section={route.section} />
  {:else}
    <section><h1>Not found</h1><p>That isn't a valid review link. <a href="/">Go home</a>.</p></section>
  {/if}
</main>

<!-- Global, every-route build provenance: which commit + when the running
     bundle was built — so a lagging Vercel deploy is obvious at a glance.
     As the LAST child of the flex column it pins to the page bottom. -->
<BuildIndicator />

<style>
  :global(:root) {
    --topbar-h: 2.75rem;
  }

  /* ── Sticky-footer page layout ──
     The app root (#app, the mount target in index.html) becomes a flex COLUMN
     at least as tall as the viewport: topbar → growing route region → footer.
     min-height uses 100dvh (correct against mobile browser chrome) with a 100vh
     fallback for engines without dvh.
     IMPORTANT: no `overflow` is set here — #app is NOT a scroll container, so
     the document/body keeps scrolling and every `position: sticky` descendant
     in the inspect flow (file-tree drawer, toggle tab, sticky file headers) and
     the `position: fixed` draft bar keep behaving exactly as before. */
  :global(#app) {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
  }

  /* The route region grows to absorb leftover column height. On a SHORT page
     this fills the gap so the footer pins to the viewport bottom; on a TALL
     page it just wraps its content and the footer follows below it. */
  .route-main {
    flex: 1 0 auto;
    /* min-height:0 would let a flex item shrink below content; we want it to
       grow only, never clip — sticky descendants must see full document height. */
    display: block;
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
    white-space: nowrap;
  }
  .signout-short {
    display: none;
  }
  /* Compact navbar below 700px: two providers + gear must not crowd small
     screens — sign-out buttons collapse to an ✕ chip (accessible names are
     preserved via aria-label) and the sign-in buttons go icon-only. */
  @media (max-width: 700px) {
    .topbar {
      padding: 0.5rem 0.6rem;
    }
    .topbar-right {
      gap: 0.35rem;
    }
    .auth-badge {
      font-size: 0.78em;
    }
    .signout-full {
      display: none;
    }
    .signout-short {
      display: inline;
    }
  }
  .route-loading {
    padding: 2rem 1rem;
    color: var(--text-muted);
  }
</style>
