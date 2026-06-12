<script lang="ts">
  import { onMount } from 'svelte'
  import { completeSignIn } from '../lib/auth/auth'
  import { completeGitlabSignIn } from '../lib/auth/gitlabAuth'
  import { resolvePendingProvider, clearPendingOAuthSessions } from '../lib/auth/oauthFlow'
  import { OAUTH_RETURN_KEY } from '../lib/auth/oauthKeys'
  import { track } from '../lib/analytics/analytics'
  import { navigate } from '../lib/router/router.svelte'

  let status = $state<'pending' | 'error'>('pending')
  let errorMessage = $state<string | null>(null)

  // Error copy must name the provider that was ACTUALLY attempted — the
  // dispatcher (resolvePendingProvider) decides which one that is.
  const GITHUB_ERROR_MESSAGES: Record<string, string> = {
    'state-mismatch': 'GitHub sign-in session expired or invalid — please try again.',
    // 'missing-code' means GitHub returned no code param at all (distinct from user denial)
    'missing-code': 'GitHub returned no authorization code — please try signing in again.',
    // 'denied' means the user explicitly cancelled the OAuth consent screen
    'denied': 'GitHub sign-in was cancelled.',
    'no-verifier': 'GitHub sign-in session lost — please try again.',
    'exchange-failed': 'GitHub sign-in failed during token exchange. Try again or use a PAT in Settings.',
  }

  const GITLAB_ERROR_MESSAGES: Record<string, string> = {
    'state-mismatch': 'GitLab sign-in session expired or invalid — please try again.',
    'missing-code': 'GitLab returned no authorization code — please try signing in again.',
    'denied': 'GitLab sign-in was cancelled.',
    'no-verifier': 'GitLab sign-in session lost — please try again.',
    'exchange-failed': 'GitLab sign-in failed during token exchange. If this persists, use a PAT in Settings instead.',
    'no-client-id': 'GitLab OAuth is not configured (missing client ID). Use a PAT in Settings.',
  }

  function navigateBack() {
    track('signed_in', { method: 'oauth' })
    const returnTo = sessionStorage.getItem(OAUTH_RETURN_KEY) || '/'
    sessionStorage.removeItem(OAUTH_RETURN_KEY)
    navigate(returnTo)
  }

  onMount(async () => {
    const params = new URLSearchParams(location.search)

    // Dispatch to the completer of the flow that was ACTUALLY started:
    // resolvePendingProvider matches the callback's `state` nonce against each
    // pending session, so a stale pending session from an earlier abandoned
    // attempt (e.g. GitLab rejected the redirect URI and the user backed out)
    // can never hijack a fresh sign-in with the other provider.
    const provider = resolvePendingProvider(params)

    if (provider === 'gitlab') {
      const result = await completeGitlabSignIn(params)
      if (result.ok) {
        navigateBack()
      } else {
        status = 'error'
        errorMessage =
          GITLAB_ERROR_MESSAGES[result.error] ?? 'GitLab sign-in failed. Please try again.'
      }
      return
    }

    if (provider === 'github') {
      // Idempotency against re-consumed codes is handled inside completeSignIn,
      // which removes the session key in a finally block so a second call finds
      // no verifier and returns {ok: false, error: 'no-verifier'}.
      const result = await completeSignIn(params)
      if (result.ok) {
        navigateBack()
      } else {
        status = 'error'
        errorMessage =
          GITHUB_ERROR_MESSAGES[result.error] ?? 'GitHub sign-in failed. Please try again.'
      }
      return
    }

    // No pending session matches this callback (expired tab, replayed URL, …).
    // We cannot know which provider was attempted — never blame one. Clear any
    // leftover pending state so the next sign-in starts clean.
    clearPendingOAuthSessions()
    status = 'error'
    errorMessage = 'Sign-in session expired or invalid — please try again.'
  })
</script>

{#if status === 'pending'}
  <section>
    <p>Completing sign-in…</p>
  </section>
{:else if status === 'error'}
  <section>
    <p role="alert">{errorMessage}</p>
    <a href="/">Go home</a>
  </section>
{/if}
