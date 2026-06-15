<script lang="ts">
  import {
    getSettings, saveTokens, setAiProvider, setAiModel, setStoryMode,
    setAiTaskMode, setAllTasksDeep, setAllTasksStandard, setOffAllExtras,
    AI_TASK_IDS, taskSupportsDeep,
    type AiProvider, type AiTaskId, type AiTaskMode,
  } from '../../lib/settings/settings'
  import { settingsState } from '../../lib/settings/settingsState.svelte'
  import { PROVIDERS, getModelDef, type LlmProviderId } from '../../lib/llm/providers'
  import { llmTestConnection, LlmError } from '../../lib/llm/llm'
  import { activeProviderHasKey } from '../../lib/llm/config'
  import { track } from '../../lib/analytics/analytics'
  import SecretInput from './SecretInput.svelte'
  import Spinner from '../Spinner.svelte'

  const current = getSettings()

  // Provider selection — saved immediately on change (like Appearance).
  let provider = $state<AiProvider>(current.aiProvider)
  // Key fields — saved via the per-card Save & test button (atomic).
  let keys = $state<Record<LlmProviderId, string>>({
    deepseek: current.deepseekKey ?? '',
    openai: current.openaiKey ?? '',
    anthropic: current.anthropicKey ?? '',
    gemini: current.geminiKey ?? '',
  })
  let error = $state<string | null>(null)

  // Per-task AI modes (Plan J) — applies immediately, like provider/model.
  // Read reactively from settingsState so quick-set rows update every row live.
  const taskModes = $derived<Record<AiTaskId, AiTaskMode>>(settingsState.current.aiTaskModes)

  // Human label per task for the "What runs" list.
  const TASK_LABELS: Record<AiTaskId, string> = {
    summary: 'Summary',
    attention: 'Hotspots',
    diagrams: 'Diagrams',
    tests: 'Test insight',
    alternatives: 'Alternatives',
    verdict: 'Verdict',
    skills: 'My reviewers (skills)',
  }

  const MODE_OPTIONS: { value: AiTaskMode; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'standard', label: 'Standard' },
    { value: 'deep', label: 'Deep' },
  ]

  function onTaskModeChange(task: AiTaskId, mode: AiTaskMode) {
    setAiTaskMode(task, mode)
    track('ai_task_mode_changed', { task, mode })
  }

  // Story mode (Plan H) toggle — applies immediately. Requires an LLM key
  // (it's a classification task); disabled with a hint when no key is set.
  // Reactive to settingsState so adding a key re-enables it live.
  let storyMode = $state<boolean>(current.storyMode)
  // Touch settingsState.current so this re-evaluates when keys/provider change.
  const storyKeyAvailable = $derived((settingsState.current, activeProviderHasKey()))
  function onStoryModeChange(checked: boolean) {
    storyMode = checked
    setStoryMode(checked)
  }

  // Per-provider model selection. Empty string means "use the provider default".
  // Each card owns its provider's choice; only the ACTIVE provider's choice is
  // persisted as aiModel. Selecting a provider radio applies that card's
  // (possibly staged) model immediately.
  let modelSel = $state<Record<LlmProviderId, string>>({
    deepseek: '',
    openai: '',
    anthropic: '',
    gemini: '',
  })
  {
    // Seed the active provider's card from a stored aiModel when it's valid.
    const activeDef = PROVIDERS.find((p) => p.id === current.aiProvider)
    if (current.aiModel && activeDef && getModelDef(activeDef, current.aiModel)) {
      modelSel[activeDef.id] = current.aiModel
    }
  }

  function onProviderChange(id: AiProvider) {
    provider = id
    setAiProvider(id)
    // Apply the card's staged model ('' = the new provider's default).
    setAiModel(modelSel[id])
  }

  function onModelChange(id: LlmProviderId, value: string) {
    modelSel[id] = value
    // Only the active provider's model selection is the app-wide aiModel.
    if (id === provider) setAiModel(value)
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

  // ---- Per-card dirty tracking ----
  // A key field is dirty when it differs from the stored settings.
  // Derived from the reactive settingsState facade so it resets after a save.
  const dirtyKeys = $derived.by(() => {
    const s = settingsState.current
    const result = {} as Record<LlmProviderId, boolean>
    for (const p of PROVIDERS) {
      result[p.id] = keys[p.id].trim() !== (s[KEY_FIELD[p.id]] ?? '')
    }
    return result
  })

  // ---- Per-card transient "Saved ✓" confirmation ----
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
      const modelId = id === provider ? (modelSel[id] || undefined) : undefined
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

  <div class="provider-cards">
    {#each PROVIDERS as p (p.id)}
      <div class="provider-card" data-active={provider === p.id ? 'true' : 'false'}>
        <div class="card-header">
          <label class="provider-radio">
            <input
              type="radio"
              name="aiProvider"
              value={p.id}
              checked={provider === p.id}
              onchange={() => onProviderChange(p.id)}
            />
            <span class="provider-name">{p.displayName}</span>
          </label>
          <span class="use-hint" aria-hidden="true">{provider === p.id ? 'Active provider' : 'Use this provider'}</span>
        </div>

        <label class="model-label">{p.displayName} model
          <select
            value={modelSel[p.id] || p.defaultModel}
            onchange={(e) => onModelChange(p.id, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each p.models as m (m.id)}
              <option value={m.id}>{m.label}</option>
            {/each}
          </select>
        </label>

        <label class="key-label">{p.displayName} API key
          <SecretInput bind:value={keys[p.id]} placeholder={p.keyHint} />
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
            {#if testStates[p.id].status === 'testing'}<Spinner size="0.8em" />{/if}{testStates[p.id].status === 'testing' ? 'Testing…' : 'Save & test'}
          </button>
          {#if dirtyKeys[p.id]}<span class="dirty-hint">Unsaved changes</span>{/if}
          <span class="saved-note" class:visible={savedStates[p.id]} aria-live="polite">{savedStates[p.id] ? 'Saved ✓' : ''}</span>
          {#if testStates[p.id].status === 'ok'}
            <span class="test-ok" role="status">✓ Connected</span>
          {:else if testStates[p.id].status === 'error'}
            <span class="test-error" role="alert">{testStates[p.id].message}</span>
          {/if}
        </div>

        <p class="privacy-line">
          {#if p.id === 'openai'}
            The OpenAI key transits our serverless proxy (OpenAI's API blocks browser requests) —
            it is forwarded per-request and never stored or logged on the server.
          {:else}
            The {p.displayName} key is sent directly from your browser to {p.displayName}'s API.
          {/if}
        </p>
      </div>
    {/each}
  </div>

  <div class="task-modes" aria-label="What runs and how deep">
    <p class="task-modes-label">What runs (and how deep)</p>
    <p class="task-modes-hint">
      Choose per task: <strong>Off</strong> spends no tokens on it, <strong>Standard</strong> is a
      single pass, <strong>Deep</strong> lets the AI read extra files first (slower, more tokens;
      needs a tool-calling model). Saved as you change it.
    </p>

    <div class="quick-set" role="group" aria-label="Quick set deep review">
      <span class="quick-set-label">Deep review:</span>
      <button type="button" class="quick-set-btn" onclick={() => setAllTasksDeep()}>All</button>
      <button type="button" class="quick-set-btn" onclick={() => setAllTasksStandard()}>None</button>
      <button type="button" class="quick-set-btn" onclick={() => setOffAllExtras()}>Off-all-extras</button>
    </div>

    <ul class="task-list">
      {#each AI_TASK_IDS as task (task)}
        <li class="task-row">
          <span class="task-name">{TASK_LABELS[task]}</span>
          <div
            class="mode-segmented"
            role="radiogroup"
            aria-label="{TASK_LABELS[task]} mode"
          >
            {#each MODE_OPTIONS as opt (opt.value)}
              {#if opt.value !== 'deep' || taskSupportsDeep(task)}
                <label class="mode-option" class:selected={taskModes[task] === opt.value}>
                  <input
                    type="radio"
                    name="task-mode-{task}"
                    value={opt.value}
                    checked={taskModes[task] === opt.value}
                    onchange={() => onTaskModeChange(task, opt.value)}
                  />
                  <span>{opt.label}</span>
                  {#if opt.value === 'deep'}<span class="cost-hint" aria-hidden="true">·more tokens</span>{/if}
                </label>
              {/if}
            {/each}
          </div>
        </li>
      {/each}
    </ul>
  </div>

  <div class="deep-review-row">
    <label class="deep-review-toggle" class:disabled={!storyKeyAvailable}>
      <input
        type="checkbox"
        checked={storyMode}
        disabled={!storyKeyAvailable}
        onchange={(e) => onStoryModeChange((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="deep-review-label">Story mode (guided walkthrough)</span>
    </label>
    <p class="deep-review-hint">
      In Inspect (step 2), lead with a guided narrative walkthrough of the change — one coherent
      step at a time, in reading order, with related tests inline. Falls back to the all-files diff
      anytime via the Story / Files switch.
      {#if !storyKeyAvailable}<strong> Add an LLM API key above to enable it.</strong>{/if}
    </p>
  </div>

  <div class="hint privacy-note">
    <p><strong>What's sent where:</strong> keys are stored only in this browser (localStorage) — never on our servers.</p>
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

  .provider-cards {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  /* One context block per provider: radio + model + key + Save & test. */
  .provider-card {
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 0.65rem 0.85rem 0.6rem;
    opacity: 0.72;
  }

  /* The ACTIVE provider's card keeps the accent-border emphasis. */
  .provider-card[data-active='true'] {
    opacity: 1;
    border-color: var(--accent);
    background: var(--surface-raised);
  }

  .card-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
  }

  .provider-radio {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.95em;
    cursor: pointer;
    color: var(--text);
  }

  .provider-name {
    font-weight: 600;
  }

  .use-hint {
    font-size: 0.78em;
    color: var(--text-muted);
  }

  .provider-card[data-active='true'] .use-hint {
    color: var(--accent);
    font-weight: 600;
  }

  .model-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.9em;
  }

  .model-label select {
    display: block;
    margin-top: 0.25rem;
  }

  .key-label {
    display: block;
    margin-bottom: 0.35rem;
    font-size: 0.9em;
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

  /* A dirty key field's button becomes prominent (accent) — saved-vs-not at a glance */
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

  .privacy-line {
    font-size: 0.78em;
    color: var(--text-muted);
    margin: 0.5rem 0 0;
  }

  /* Plan J: "What runs (and how deep)" per-task mode matrix. */
  .task-modes {
    margin: 0.85rem 0 0;
    padding: 0.6rem 0.85rem;
    border: 1px solid var(--hairline);
    border-radius: 8px;
  }

  .task-modes-label {
    font-size: 0.9em;
    font-weight: 600;
    margin: 0 0 0.3rem;
    color: var(--text);
  }

  .task-modes-hint {
    font-size: 0.78em;
    color: var(--text-muted);
    margin: 0 0 0.6rem;
  }

  .quick-set {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.7rem;
  }

  .quick-set-label {
    font-size: 0.82em;
    color: var(--text-muted);
  }

  .quick-set-btn {
    font-size: 0.8em;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }

  .quick-set-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .task-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .task-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .task-name {
    font-size: 0.88em;
    color: var(--text);
  }

  /* Themed segmented control — radios under the hood, consistent with siblings. */
  .mode-segmented {
    display: inline-flex;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    overflow: hidden;
  }

  .mode-option {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.22rem 0.55rem;
    font-size: 0.8em;
    cursor: pointer;
    color: var(--text-muted);
    border-left: 1px solid var(--hairline);
  }

  .mode-option:first-child {
    border-left: none;
  }

  .mode-option.selected {
    background: var(--accent);
    color: var(--on-accent, #fff);
    font-weight: 600;
  }

  /* The native radio is the a11y anchor but visually replaced by the segment. */
  .mode-option input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    margin: -1px;
  }

  .cost-hint {
    font-size: 0.85em;
    opacity: 0.7;
  }

  .deep-review-row {
    margin: 0.85rem 0 0;
    padding: 0.6rem 0.85rem;
    border: 1px solid var(--hairline);
    border-radius: 8px;
  }

  .deep-review-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9em;
    cursor: pointer;
  }

  .deep-review-toggle.disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .deep-review-label {
    font-weight: 600;
  }

  .deep-review-hint {
    font-size: 0.78em;
    color: var(--text-muted);
    margin: 0.3rem 0 0;
  }

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.75rem 0 0;
  }

  .privacy-note p {
    margin: 0 0 0.35rem;
  }
</style>
