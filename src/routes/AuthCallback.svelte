<script lang="ts">
  import { onMount } from 'svelte'
  import { completeSignIn } from '../lib/auth/auth'
  import { completeGitlabSignIn, getPendingProvider } from '../lib/auth/gitlabAuth'
  import { track } from '../lib/analytics/analytics'
  import { navigate } from '../lib/router/router.svelte'

  const RETURN_KEY = 'review123:returnTo'

  let status = $state<'pending' | 'error'>('pending')
  let errorMessage = $state<string | null>(null)

  const GITHUB_ERROR_MESSAGES: Record<string, string> = {
    'state-mismatch': 'Sign-in session expired or invalid — please try again.',
    // 'missing-code' means GitHub returned no code param at all (distinct from user denial)
    'missing-code': 'GitHub returned no authorization code — please try signing in again.',
    // 'denied' means the user explicitly cancelled the OAuth consent screen
    'denied': 'GitHub sign-in was cancelled.',
    'no-verifier': 'Sign-in session lost — please try again.',
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

  onMount(async () => {
    const params = new URLSearchParams(location.search)

    // Dispatch to the correct completer based on which provider has a pending session.
    // GitLab uses a separate sessionStorage key ('review123:gitlab-oauth') so the two
    // flows cannot interfere with each other. We check for GitLab first; if no GitLab
    // session is pending, we fall through to the GitHub completer.
    const pendingProvider = getPendingProvider()

    if (pendingProvider === 'gitlab') {
      const result = await completeGitlabSignIn(params)
      if (result.ok) {
        track('signed_in', { method: 'oauth' })
        const returnTo = sessionStorage.getItem(RETURN_KEY) || '/'
        sessionStorage.removeItem(RETURN_KEY)
        navigate(returnTo)
      } else {
        status = 'error'
        errorMessage =
          GITLAB_ERROR_MESSAGES[result.error] ?? 'GitLab sign-in failed. Please try again.'
      }
      return
    }

    // Default: GitHub OAuth flow.
    // Idempotency against re-consumed codes is handled inside completeSignIn,
    // which removes the session key in a finally block so a second call finds
    // no verifier and returns {ok: false, error: 'no-verifier'}.
    const result = await completeSignIn(params)
    if (result.ok) {
      track('signed_in', { method: 'oauth' })
      const returnTo = sessionStorage.getItem(RETURN_KEY) || '/'
      sessionStorage.removeItem(RETURN_KEY)
      navigate(returnTo)
    } else {
      status = 'error'
      errorMessage = GITHUB_ERROR_MESSAGES[result.error] ?? 'GitHub sign-in failed. Please try again.'
    }
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
