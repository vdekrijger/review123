<script lang="ts">
  import { getSettings, saveTokens } from '../../lib/settings/settings'
  import { track } from '../../lib/analytics/analytics'

  const current = getSettings()
  let deepseek = $state(current.deepseekKey ?? '')
  let error = $state<string | null>(null)

  export function save() {
    try {
      const hadKey = !!current.deepseekKey
      saveTokens({ deepseekKey: deepseek.trim() === '' ? null : deepseek })
      if (!hadKey && deepseek.trim()) track('settings_key_added', { service: 'deepseek' })
      error = null
      return true
    } catch (e) {
      error = (e as Error).message
      return false
    }
  }
</script>

<section id="ai-models" aria-label="AI models">
  <p class="section-label">AI models</p>

  <label>DeepSeek API key
    <input type="password" bind:value={deepseek} autocomplete="off" placeholder="sk-…" />
  </label>

  <p class="hint">Your API key is stored only in this browser (localStorage) and sent directly to DeepSeek's API.</p>
  {#if error}<p role="alert">{error}</p>{/if}

  <div class="save-row">
    <button class="btn btn-primary" onclick={save}>Save</button>
  </div>
</section>

<style>
  section {
    margin-bottom: 2rem;
  }

  .section-label {
    font-size: 0.9em;
    font-weight: 600;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.5rem 0;
  }

  .save-row {
    margin-top: 1rem;
  }

  label {
    display: block;
    margin-bottom: 0.5rem;
  }
</style>
