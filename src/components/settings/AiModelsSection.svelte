<script lang="ts">
  import { getSettings, saveTokens, setAiProvider, setAiModel, type AiProvider } from '../../lib/settings/settings'
  import { settingsState } from '../../lib/settings/settingsState.svelte'
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
    // Sync the field to the stored (trimmed) value so the row reads clean.
    keys[id] = getSettings()[field] ?? ''
    if (!hadKey && value) track('settings_key_added', { service: id })
  }

  // ---- Per-row dirty tracking ----
  // A key row is dirty when its field differs from the stored settings.
  // Derived from the reactive settingsState facade so it resets after a save.
  const dirtyKeys = $derived.by(() => {
    const s = settingsState.current
    const result = {} as Record<LlmProviderId, boolean>
    for (const p of PROVIDERS) {
      result[p.id] = keys[p.id].trim() !== (s[KEY_FIELD[p.id]] ?? '')
    }
    return result
  })

  // ---- Per-row transient "Saved ✓" confirmation ----
  let savedStates = $state<Record<LlmProviderId, boolean>>({
    deepseek: false,
    openai: false,
    anthropic: false,
    gemini: false,
  })
  const savedTimers: Partial<Record<LlmProviderId, ReturnType<typeof setTimeout>>> = {}
  function showSaved(id: LlmProviderId) {
    savedStates[id] = true
    clearTimeout(savedTimers[id])
    savedTimers[id] = setTimeout(() => {
      savedStates[id] = false
    }, 2000)
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
    const wasDirty = dirtyKeys[id]
    try {
      saveKey(id) // test what's in the field: save first, then ping (button says so)
      error = null
      // Only confirm "Saved" when something actually changed — a re-test of an
      // unchanged key is not a save.
      if (wasDirty) showSaved(id)
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
  <p class="apply-note">Provider and model selection applies immediately. API keys are saved per provider with <em>Save &amp; test</em>.</p>

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
            data-dirty={dirtyKeys[p.id] ? 'true' : 'false'}
            onclick={() => handleSaveAndTest(p.id)}
            disabled={testStates[p.id].status === 'testing'}
            aria-label="Save & test {p.displayName} connection"
            aria-busy={testStates[p.id].status === 'testing'}
          >
            {testStates[p.id].status === 'testing' ? 'Testing…' : 'Save & test'}
          </button>
          {#if dirtyKeys[p.id]}<span class="dirty-hint">Unsaved changes</span>{/if}
          <span class="saved-note" class:visible={savedStates[p.id]} aria-live="polite">{savedStates[p.id] ? 'Saved ✓' : ''}</span>
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
</section>

<style>
  /* Bounded section card — saving here is per-key (Save & test); provider and
     model apply immediately, so there is no section-level Save button. */
  section {
    margin-bottom: 1.5rem;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 1rem 1.25rem;
  }

  .section-label {
    font-size: 0.9em;
    font-weight: 600;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .apply-note {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
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

  /* A dirty key row's button becomes prominent (accent) — saved-vs-not at a glance */
  .test-btn[data-dirty='true'] {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  .dirty-hint {
    font-size: 0.85em;
    font-style: italic;
    color: var(--text-muted);
  }

  .saved-note {
    font-size: 0.85em;
    color: var(--ok, #1a7f37);
    opacity: 0;
    transition: opacity 0.35s ease;
  }

  .saved-note.visible {
    opacity: 1;
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
</style>
