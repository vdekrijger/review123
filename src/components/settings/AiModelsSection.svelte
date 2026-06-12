<script lang="ts">
  import { getSettings, saveTokens, setAiProvider, setAiModel, type AiProvider } from '../../lib/settings/settings'
  import { PROVIDERS, getModelDef, type LlmProviderId } from '../../lib/llm/providers'
  import { llmTestConnection, LlmError } from '../../lib/llm/llm'
  import { track } from '../../lib/analytics/analytics'

  const current = getSettings()

  // Provider/model selection — saved immediately on change (like Appearance).
  let provider = $state<AiProvider>(current.aiProvider)
  // Key fields — saved via the Save / Save & test buttons (atomic, like other key fields).
  let keys = $state<Record<LlmProviderId, string>>({
    deepseek: current.deepseekKey ?? '',
    openai: current.openaiKey ?? '',
    anthropic: current.anthropicKey ?? '',
    gemini: current.geminiKey ?? '',
  })
  let error = $state<string | null>(null)

  const activeDef = $derived(PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0])

  // Model selection: empty aiModel setting means "use the provider default".
  function resolveSelectedModel(): string {
    const stored = getSettings().aiModel
    return (stored && getModelDef(activeDef, stored)) ? stored : activeDef.defaultModel
  }
  let selectedModel = $state(
    (current.aiModel && PROVIDERS.find((p) => p.id === current.aiProvider && getModelDef(p, current.aiModel)))
      ? current.aiModel
      : ''
  )
  const selectedModelValue = $derived(selectedModel || activeDef.defaultModel)

  function onProviderChange(id: AiProvider) {
    provider = id
    selectedModel = '' // reset to the new provider's default
    setAiProvider(id)
    setAiModel('')
  }

  function onModelChange(value: string) {
    selectedModel = value
    setAiModel(value)
  }

  const KEY_FIELD: Record<LlmProviderId, 'deepseekKey' | 'openaiKey' | 'anthropicKey' | 'geminiKey'> = {
    deepseek: 'deepseekKey',
    openai: 'openaiKey',
    anthropic: 'anthropicKey',
    gemini: 'geminiKey',
  }

  function saveKey(id: LlmProviderId): void {
    const field = KEY_FIELD[id]
    const hadKey = !!getSettings()[field]
    const value = keys[id].trim()
    saveTokens({ [field]: value === '' ? null : keys[id] })
    if (!hadKey && value) track('settings_key_added', { service: id })
  }

  export function save() {
    try {
      // Atomic: saveTokens validates every field before writing anything.
      const settings = getSettings()
      const patch: Partial<Record<(typeof KEY_FIELD)[LlmProviderId], string | null>> = {}
      for (const p of PROVIDERS) {
        patch[KEY_FIELD[p.id]] = keys[p.id].trim() === '' ? null : keys[p.id]
      }
      saveTokens(patch)
      for (const p of PROVIDERS) {
        if (!settings[KEY_FIELD[p.id]] && keys[p.id].trim()) {
          track('settings_key_added', { service: p.id })
        }
      }
      error = null
      return true
    } catch (e) {
      error = (e as Error).message
      return false
    }
  }

  // ---- Per-provider connection test (Save & test) ----
  // Saves the field first, then pings through the real transport adapter.
  // Never cached: llmTestConnection bypasses the AI cache entirely.
  type TestState = { status: 'idle' | 'testing' | 'ok' | 'error'; message?: string }
  let testStates = $state<Record<LlmProviderId, TestState>>({
    deepseek: { status: 'idle' },
    openai: { status: 'idle' },
    anthropic: { status: 'idle' },
    gemini: { status: 'idle' },
  })

  async function handleSaveAndTest(id: LlmProviderId) {
    testStates[id] = { status: 'testing' }
    try {
      saveKey(id) // test what's in the field: save first, then ping (button says so)
      error = null
    } catch (e) {
      testStates[id] = { status: 'error', message: (e as Error).message }
      return
    }
    try {
      // Only pass the selected model when testing the active provider;
      // otherwise the provider's default model is pinged.
      const modelId = id === provider ? (selectedModel || undefined) : undefined
      await llmTestConnection(id, modelId)
      testStates[id] = { status: 'ok' }
    } catch (e) {
      const message = e instanceof LlmError ? e.message : 'Connection test failed'
      testStates[id] = { status: 'error', message }
    }
  }
</script>

<section id="ai-models" aria-label="AI models">
  <p class="section-label">AI models</p>

  <fieldset>
    <legend>Provider</legend>
    {#each PROVIDERS as p (p.id)}
      <label>
        <input
          type="radio"
          name="aiProvider"
          value={p.id}
          checked={provider === p.id}
          onchange={() => onProviderChange(p.id)}
        />
        {p.displayName}
      </label>
    {/each}
  </fieldset>

  <label class="model-label">Model
    <select
      value={selectedModelValue}
      onchange={(e) => onModelChange((e.currentTarget as HTMLSelectElement).value)}
    >
      {#each activeDef.models as m (m.id)}
        <option value={m.id}>{m.label}</option>
      {/each}
    </select>
  </label>

  <div class="key-list">
    {#each PROVIDERS as p (p.id)}
      <div class="key-row" data-active={provider === p.id ? 'true' : 'false'}>
        <label>{p.displayName} API key
          <input type="password" bind:value={keys[p.id]} autocomplete="off" placeholder={p.keyHint} />
        </label>
        <div class="test-row">
          <button
            class="btn test-btn"
            onclick={() => handleSaveAndTest(p.id)}
            disabled={testStates[p.id].status === 'testing'}
            aria-label="Save & test {p.displayName} connection"
            aria-busy={testStates[p.id].status === 'testing'}
          >
            {testStates[p.id].status === 'testing' ? 'Testing…' : 'Save & test'}
          </button>
          {#if testStates[p.id].status === 'ok'}
            <span class="test-ok" role="status">✓ Connected</span>
          {:else if testStates[p.id].status === 'error'}
            <span class="test-error" role="alert">{testStates[p.id].message}</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="hint privacy-note">
    <p><strong>What's sent where:</strong> keys are stored only in this browser (localStorage).
      DeepSeek, Anthropic and Gemini keys are sent directly from your browser to that provider's API.</p>
    <p>The OpenAI key transits our serverless proxy (OpenAI's API blocks browser requests) —
      it is forwarded per-request and never stored or logged on the server.</p>
  </div>
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

  fieldset {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.4rem 0.75rem 0.5rem;
    margin: 0 0 0.5rem;
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
    background: var(--surface-raised);
  }

  fieldset legend {
    font-size: 0.85em;
    color: var(--text-muted);
    padding: 0 0.25rem;
  }

  fieldset label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.9em;
    cursor: pointer;
    color: var(--text);
  }

  .model-label {
    display: block;
    margin-bottom: 0.75rem;
  }

  .model-label select {
    display: block;
    margin-top: 0.25rem;
  }

  .key-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .key-row {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    opacity: 0.65;
  }

  /* The ACTIVE provider's key field is visually emphasized */
  .key-row[data-active='true'] {
    opacity: 1;
    border-color: var(--accent);
    background: var(--surface-raised);
  }

  .key-row label {
    display: block;
    margin-bottom: 0.35rem;
  }

  .test-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .test-btn {
    font-size: 0.85em;
  }

  .test-ok {
    font-size: 0.85em;
    color: var(--ok, #1a7f37);
  }

  .test-error {
    font-size: 0.85em;
    color: #cf222e;
  }

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.5rem 0;
  }

  .privacy-note p {
    margin: 0 0 0.35rem;
  }

  .save-row {
    margin-top: 1rem;
  }
</style>
