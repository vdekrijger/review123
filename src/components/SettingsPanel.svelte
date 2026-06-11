<script lang="ts">
  import { getSettings, saveTokens } from '../lib/settings/settings'
  import { track } from '../lib/analytics/analytics'
  import { authState } from '../lib/auth/authState.svelte'

  let { onclose }: { onclose: () => void } = $props()
  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let deepseek = $state(current.deepseekKey ?? '')
  let error = $state<string | null>(null)

  // authStatusLine is derived from the reactive authState so it updates live
  // when the user saves a PAT or signs in/out via OAuth.
  const authStatusLine = $derived.by(() => {
    const auth = authState.auth
    if (!auth) return 'Not signed in'
    if (auth.method === 'oauth') {
      const scopeList = auth.scopes.length > 0 ? auth.scopes.join(', ') : 'none'
      return `Signed in via GitHub (scopes: ${scopeList})`
    }
    return 'Using PAT'
  })

  function save() {
    try {
      const hadPat = !!current.githubPat
      const hadKey = !!current.deepseekKey
      saveTokens({
        githubPat: pat.trim() === '' ? null : pat,
        deepseekKey: deepseek.trim() === '' ? null : deepseek,
      })
      if (!hadPat && pat.trim()) track('settings_key_added', { service: 'github' })
      if (!hadKey && deepseek.trim()) track('settings_key_added', { service: 'deepseek' })
      onclose()
    } catch (e) {
      error = (e as Error).message
    }
  }
</script>

<dialog open aria-label="Settings">
  <h2>Settings</h2>
  <p class="auth-status">{authStatusLine}</p>
  <label>GitHub token (PAT)
    <input type="password" bind:value={pat} autocomplete="off" placeholder="github_pat_… (fine-grained, repo-scoped recommended)" />
  </label>
  <label>DeepSeek API key
    <input type="password" bind:value={deepseek} autocomplete="off" placeholder="sk-…" />
  </label>
  <p class="hint">Keys are stored only in this browser (localStorage) and sent only to their own services.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <button onclick={save}>Save</button>
  <button onclick={onclose}>Cancel</button>
</dialog>

<style>
  .auth-status { font-size: 0.9em; opacity: 0.8; margin-bottom: 0.75rem; }
</style>
