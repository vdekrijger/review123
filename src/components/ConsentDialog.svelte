<script lang="ts">
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { getProvider } from '../lib/llm/providers'

  let { repo, onresult }: { repo: string; onresult: (accepted: boolean) => void } = $props()

  // Name the ACTIVE provider (Plan F) — reactive via the settingsState facade.
  const activeProviderId = $derived(settingsState.current.aiProvider)
  const providerName = $derived(getProvider(activeProviderId)?.displayName ?? 'the AI provider')
  // OpenAI is the only provider routed through our serverless proxy (api.openai.com
  // has no browser CORS); all others are called directly from the browser.
  const usesProxy = $derived(activeProviderId === 'openai')

  let dialogEl = $state<HTMLDialogElement | null>(null)

  $effect(() => {
    if (!dialogEl) return
    if (!dialogEl.open) {
      dialogEl.showModal()
    }
  })

  function accept() {
    onresult(true)
  }

  function decline() {
    onresult(false)
  }
</script>

<dialog
  bind:this={dialogEl}
  aria-label="Allow AI analysis"
  aria-modal="true"
  oncancel={(e) => { e.preventDefault(); decline() }}
  onclick={(e) => { if (e.target === e.currentTarget) decline() }}
>
  <h2>Allow AI analysis of private repository?</h2>
  <p>
    Code from the private repository <strong>{repo}</strong> will be sent to {providerName} for analysis.
  </p>
  <p>
    {providerName} will receive the file contents and diffs from this pull request.
    {#if usesProxy}
      Your API key and code transit our serverless proxy to reach {providerName} — they are never stored or logged there.
      Your API key is stored locally in your browser.
    {:else}
      Your API key is stored locally in your browser and your code is sent directly from your browser to {providerName}.
    {/if}
  </p>
  <div class="actions">
    <button class="btn btn-primary" onclick={accept}>Send code to {providerName}</button>
    <button class="btn" onclick={decline}>Not now</button>
  </div>
</dialog>

<style>
  /* dialog base styles come from app.css */

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    justify-content: flex-end;
  }
</style>
