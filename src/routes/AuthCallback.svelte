<script lang="ts">
  import { onMount } from 'svelte'
  import { completeSignIn } from '../lib/auth/auth'
  import { track } from '../lib/analytics/analytics'
  import { navigate } from '../lib/router/router.svelte'

  const RETURN_KEY = 'review123:returnTo'

  let status = $state<'pending' | 'success' | 'error'>('pending')
  let errorMessage = $state<string | null>(null)

  const ERROR_MESSAGES: Record<string, string> = {
    'state-mismatch': 'Sign-in session expired or invalid — please try again.',
    'missing-code': 'GitHub sign-in was cancelled.',
    'denied': 'GitHub sign-in was cancelled.',
    'no-verifier': 'Sign-in session lost — please try again.',
    'exchange-failed': 'GitHub sign-in failed during token exchange. Try again or use a PAT in Settings.',
  }

  onMount(async () => {
    const params = new URLSearchParams(location.search)
    const result = await completeSignIn(params)
    if (result.ok) {
      track('signed_in', { method: 'oauth' })
      const returnTo = sessionStorage.getItem(RETURN_KEY) || '/'
      sessionStorage.removeItem(RETURN_KEY)
      navigate(returnTo)
    } else {
      status = 'error'
      errorMessage = ERROR_MESSAGES[result.error] ?? 'GitHub sign-in failed. Please try again.'
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
