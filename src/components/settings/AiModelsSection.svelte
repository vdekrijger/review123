<script lang="ts">
  import {
    getSettings, saveTokens, setAiProvider, setAiModel, setStoryMode, setCrossModelVerify,
    setAiTaskMode, setAllTasksDeep, setAllTasksStandard, setOffAllExtras, setAiPanel,
    setPanelOneGenerator, setPanelAllGenerate,
    AI_TASK_IDS, taskSupportsDeep,
    type AiProvider, type AiTaskId, type AiTaskMode,
    type AiPanel, type PanelParticipant, type ParticipantRole,
  } from '../../lib/settings/settings'
  import { settingsState } from '../../lib/settings/settingsState.svelte'
  import { PROVIDERS, getProvider, getModelDef, type ApiProviderId, type LlmProviderId } from '../../lib/llm/providers'
  import { bridgeState, bridgeCanInfer } from '../../lib/bridge/bridge.svelte'
  import { llmTestConnection, LlmError } from '../../lib/llm/llm'
  import { activeProviderHasKey, providerIsUsable, resolvePanel, globalBridgeModel } from '../../lib/llm/config'
  import { isValidModelId } from '../../lib/bridge/protocol'
  import { verifierVotesCanDemote } from '../../lib/ai/crossVerify'
  import { providerSupportsBalance, fetchProviderBalance, formatBalance, type ProviderBalance } from '../../lib/llm/balance'
  import { track } from '../../lib/analytics/analytics'
  import SecretInput from './SecretInput.svelte'
  import Spinner from '../Spinner.svelte'
  import ModelCombobox from './ModelCombobox.svelte'

  // Above this model count a provider's plain <select> becomes the searchable,
  // lab-grouped combobox (OpenRouter's ~300; the small lists keep the select).
  const COMBOBOX_THRESHOLD = 25
  const useCombobox = (count: number): boolean => count > COMBOBOX_THRESHOLD

  const current = getSettings()

  // Provider selection — saved immediately on change (like Appearance).
  let provider = $state<AiProvider>(current.aiProvider)
  // Key fields — saved via the per-card Save & test button (atomic).
  let keys = $state<Record<LlmProviderId, string>>({
    deepseek: current.deepseekKey ?? '',
    openai: current.openaiKey ?? '',
    anthropic: current.anthropicKey ?? '',
    gemini: current.geminiKey ?? '',
    openrouter: current.openrouterKey ?? '',
    // The bridge has no API key; the entry exists so every record stays keyed
    // by LlmProviderId and no lookup needs a special case.
    bridge: '',
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
    intent: 'Intent check (matches diff against the PR description)',
    outcomes: 'Expected outcomes (before → after behavior changes)',
    skills: 'My reviewers (skills)',
    story: 'Story walkthrough',
    riskJudge: 'Risk judge (review effort)',
    simplify: 'Simplify findings (plain English)',
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

  // Cross-model verification (Plan M) toggle — applies immediately. EFFECTIVE
  // only when ≥2 providers have keys; disabled with a hint otherwise. Reactive
  // to settingsState so adding a second key re-enables it live.
  let crossModelVerify = $state<boolean>(current.crossModelVerify)
  function onCrossModelVerifyChange(checked: boolean) {
    crossModelVerify = checked
    setCrossModelVerify(checked)
  }

  // -------------------------------------------------------------------------
  // Unified model panel (Plan P). A single participant list with per-row ROLES
  // (generator | verifier). The verify-vs-generate mode is EMERGENT from the
  // generator count, so there is no separate mode radio. The current panel is the
  // stored aiPanel, or the synthesized default (active provider+model as the sole
  // generator; verifiers = other keyed defaults). Every edit writes aiPanel so it
  // becomes authoritative.
  // -------------------------------------------------------------------------

  /**
   * Whether a provider is USABLE — has a credential — which drives row
   * disabling, the hints, and the cross-verify gate.
   *
   * Delegates to `providerIsUsable` rather than indexing settings itself. This
   * used to be an open-coded five-way key chain that ended `: s.openrouterKey`,
   * so the LOCAL BRIDGE — which has no settings key field, its credential being
   * the pairing token — fell through onto OpenRouter's empty key and read as
   * unkeyed. A paired bridge then counted as ZERO usable models: every panel row
   * said "no key", and `crossVerifyAvailable` stayed false, so cross-model
   * verification (the one feature PR #250 measured as actually cutting noise,
   * 36–45% → 9%) was silently unavailable to bridge users.
   *
   * The two reads below are both REACTIVITY anchors, not data sources:
   * `settingsState.current` for the API keys and `bridgeState.paired` for the
   * bridge token, which lives in its own localStorage record and would
   * otherwise never re-run this.
   */
  function providerKeyed(p: AiProvider): boolean {
    void settingsState.current
    void bridgeState.paired
    return providerIsUsable(p)
  }

  /** Per-provider hint for an unusable row — the bridge is PAIRED, not keyed. */
  function noCredentialHint(p: AiProvider): string {
    return p === 'bridge'
      ? 'Bridge not paired — set one up in Local bridge below'
      : `No ${getProvider(p)?.displayName} key — add it above`
  }

  /**
   * The panel shown in the editor: the stored one, or the synthesized default
   * (so a user who never customized sees today's effective panel and can edit
   * from there). Reactive to settingsState.
   */
  const panelParticipants = $derived.by<PanelParticipant[]>(() => {
    void settingsState.current
    const stored = settingsState.current.aiPanel
    if (stored) return stored.participants
    const resolved = resolvePanel()
    const active = settingsState.current
    const generators: PanelParticipant[] = resolved.generators.length
      ? resolved.generators.map((g) => ({ provider: g.providerId as AiProvider, model: g.model.id, role: 'generator' as ParticipantRole }))
      : [{ provider: active.aiProvider, model: getProvider(active.aiProvider)?.defaultModel ?? '', role: 'generator' as ParticipantRole }]
    const verifiers: PanelParticipant[] = resolved.verifiers.map((v) => ({ provider: v.providerId as AiProvider, model: v.model.id, role: 'verifier' as ParticipantRole }))
    return [...generators, ...verifiers]
  })

  /** Count of rows whose provider has a key (usable models). */
  const usablePanelCount = $derived(panelParticipants.filter((p) => providerKeyed(p.provider)).length)
  /** Cross-verify possible when ≥2 usable models (single-key multi-model counts). */
  const crossVerifyAvailable = $derived(usablePanelCount >= 2)
  /** Count of generator rows (drives the ≥1-generator constraint on the role toggle). */
  const generatorCount = $derived(panelParticipants.filter((p) => p.role === 'generator').length)

  /**
   * Can this panel's verifiers actually OVERTURN anything?
   *
   * The aggregator surfaces a finding when `score >= polled / 2`, counting each
   * raiser as an implicit confirm on BOTH sides of that comparison — so a lone
   * verifier's vote is arithmetically incapable of pulling the score under the
   * bar (1 >= 2/2 always holds). The worst case for any panel is a finding ONE
   * model raised, leaving every other usable model to verify it, which is why
   * this asks `verifierVotesCanDemote(1, usable - 1)` — the same predicate the
   * aggregator itself is documented against, rather than a second copy of the
   * arithmetic that could drift from it.
   *
   * With a unanimous refutation now demoting outright (see crossVerify.ts), a
   * two-model panel is not useless — it just cannot RESOLVE a disagreement,
   * only act on a flat one. The hint below says exactly that instead of letting
   * the user believe a vote is deciding something.
   */
  const panelCanOverturn = $derived(verifierVotesCanDemote(1, Math.max(usablePanelCount - 1, 0)))

  /** Persist a participant list back to aiPanel. */
  function commitPanel(participants: PanelParticipant[]) {
    setAiPanel({ participants })
  }

  function onRowProvider(i: number, providerId: AiProvider) {
    const rows = panelParticipants.map((p) => ({ ...p }))
    const prov = getProvider(providerId)
    rows[i] = { ...rows[i], provider: providerId, model: prov?.defaultModel ?? rows[i].model }
    // A per-row model belongs to the bridge CLI it was chosen for; carrying it
    // onto another provider (or another CLI) would be meaningless.
    delete rows[i].bridgeModel
    delete bridgeModelDrafts[i]
    commitPanel(rows)
  }

  function onRowModel(i: number, modelId: string) {
    const rows = panelParticipants.map((p) => ({ ...p }))
    if (rows[i].provider === 'bridge' && rows[i].model !== modelId) {
      // The CLI changed. `fable` means something to `claude` and nothing to
      // `codex`, so the model chosen for the old CLI does not carry over.
      delete rows[i].bridgeModel
      delete bridgeModelDrafts[i]
    }
    rows[i].model = modelId
    commitPanel(rows)
  }

  /**
   * What the user has TYPED into a bridge row's model box, keyed by row index.
   *
   * The box cannot read straight from the stored panel: a malformed id is not
   * persisted (setAiPanel drops it, so the row falls back to the global), and a
   * field rendered from stored state would therefore erase itself under the
   * cursor the moment an intermediate keystroke was invalid. Same split
   * BridgeSection uses for the global field, one per row.
   */
  let bridgeModelDrafts = $state<Record<number, string>>({})

  /** The text to SHOW in row i's model box: the live draft, else what is stored. */
  function bridgeModelText(i: number, row: PanelParticipant): string {
    return bridgeModelDrafts[i] ?? row.bridgeModel ?? ''
  }

  /** True when row i's typed model would be refused — mirrors BridgeSection. */
  function bridgeModelInvalid(i: number): boolean {
    const draft = bridgeModelDrafts[i]
    return draft !== undefined && draft.trim() !== '' && !isValidModelId(draft.trim())
  }

  /**
   * Commit a bridge row's model. Blank or malformed stores nothing, which means
   * INHERIT the global default — the same "a typo degrades to today's
   * behaviour" rule setBridgeModel follows, rather than persisting a value the
   * bridge would reject on every call.
   */
  function onRowBridgeModel(i: number, value: string) {
    bridgeModelDrafts[i] = value
    const trimmed = value.trim()
    const rows = panelParticipants.map((p) => ({ ...p }))
    if (isValidModelId(trimmed)) rows[i].bridgeModel = trimmed
    else delete rows[i].bridgeModel
    commitPanel(rows)
  }

  /** Placeholder for a bridge row: what it inherits when left blank. */
  const inheritedBridgeModel = $derived.by(() => {
    void settingsState.current
    return globalBridgeModel()
  })
  const bridgeModelPlaceholder = $derived(
    inheritedBridgeModel ? `inherits ${inheritedBridgeModel}` : "the CLI's own default",
  )

  /**
   * How many rows run a CLI through the local bridge. Two or more means one
   * subscription seat is answering several calls per task, which is worth
   * saying once where it is configured (#238 declined to enlist the bridge as
   * an automatic verifier for the same reason).
   */
  const bridgeRowCount = $derived(
    panelParticipants.filter((p) => p.provider === 'bridge' && providerKeyed('bridge')).length,
  )

  /** Toggle a row's role. Refuses to drop the LAST generator (≥1 constraint). */
  function setRowRole(i: number, role: ParticipantRole) {
    if (role === 'verifier' && panelParticipants[i].role === 'generator' && generatorCount <= 1) return
    const rows = panelParticipants.map((p) => ({ ...p }))
    rows[i].role = role
    commitPanel(rows)
  }

  function addParticipant() {
    // Default the new verifier to the active provider's default model.
    const p = settingsState.current.aiProvider
    const prov = getProvider(p)
    const rows: PanelParticipant[] = [
      ...panelParticipants.map((r) => ({ ...r })),
      { provider: p, model: prov?.defaultModel ?? '', role: 'verifier' as ParticipantRole },
    ]
    commitPanel(rows)
  }

  function removeParticipant(i: number) {
    if (panelParticipants.length <= 1) return
    // Drafts are keyed by ROW INDEX, and removing a row shifts every index
    // after it — a stale draft would then be shown against a different row.
    bridgeModelDrafts = {}
    const rows = panelParticipants.filter((_, idx) => idx !== i).map((r) => ({ ...r }))
    // If removal left no generator, promote the first remaining row.
    if (!rows.some((r) => r.role === 'generator') && rows.length > 0) rows[0] = { ...rows[0], role: 'generator' }
    commitPanel(rows)
  }

  /** Reset back to the synthesized default panel (clears the custom one). */
  function resetPanel() {
    setAiPanel(null)
  }

  /** Preset: first model the sole generator, the rest verifiers (old 'verify'). */
  function presetOneGenerator() {
    setPanelOneGenerator(panelParticipants.map((p) => ({ ...p })))
  }
  /** Preset: every model a generator — they cross-confirm (old 'generate'). */
  function presetAllGenerate() {
    setPanelAllGenerate(panelParticipants.map((p) => ({ ...p })))
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
    openrouter: '',
    bridge: '',
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

  const KEY_FIELD: Record<ApiProviderId, 'deepseekKey' | 'openaiKey' | 'anthropicKey' | 'geminiKey' | 'openrouterKey'> = {
    deepseek: 'deepseekKey',
    openai: 'openaiKey',
    anthropic: 'anthropicKey',
    gemini: 'geminiKey',
    openrouter: 'openrouterKey',
  }

  /**
   * The settings field holding a provider's key, or null for the LOCAL BRIDGE,
   * which has none — its credential is the pairing token the Local bridge
   * section owns. Every key-field path goes through here so "the bridge has no
   * key" is stated once instead of being an if-branch in five places.
   */
  function keyField(id: LlmProviderId): (typeof KEY_FIELD)[ApiProviderId] | null {
    return id === 'bridge' ? null : KEY_FIELD[id]
  }

  const isBridge = (id: LlmProviderId): boolean => id === 'bridge'

  /** The bridge can serve a review when it is paired, live, and has that CLI. */
  const bridgeReady = $derived(
    (bridgeState.status, bridgeCanInfer(modelSel.bridge || getProvider('bridge')!.defaultModel)),
  )

  function saveKey(id: LlmProviderId): void {
    const field = keyField(id)
    if (field === null) return
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
      const field = keyField(p.id)
      // A keyless provider is never "dirty" — there is nothing to save.
      result[p.id] = field !== null && keys[p.id].trim() !== (s[field] ?? '')
    }
    return result
  })

  // ---- Per-card transient "Saved ✓" confirmation ----
  let savedStates = $state<Record<LlmProviderId, boolean>>({
    deepseek: false,
    openai: false,
    anthropic: false,
    gemini: false,
    openrouter: false,
    bridge: false,
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
    openrouter: { status: 'idle' },
    bridge: { status: 'idle' },
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
    // Refresh the credits readout after a save (capability-gated; no-op for
    // providers without a balance endpoint, or when the key was cleared).
    void refreshBalance(id)
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

  // -------------------------------------------------------------------------
  // Credits remaining (capability-gated). Shown ONLY for providers that expose
  // a key-level balance endpoint (DeepSeek today) AND have a key configured.
  // Fetched DIRECT from the provider (no proxy — same permissive CORS as the
  // chat endpoint) and degrades to nothing on any failure. Keystroke-safe:
  // fetched on mount and after a save/refresh-click, NEVER on every keypress.
  // -------------------------------------------------------------------------
  type BalanceState = { status: 'idle' | 'loading' | 'ok' | 'empty'; balance?: ProviderBalance }
  let balanceStates = $state<Record<LlmProviderId, BalanceState>>({
    deepseek: { status: 'idle' },
    openai: { status: 'idle' },
    anthropic: { status: 'idle' },
    gemini: { status: 'idle' },
    openrouter: { status: 'idle' },
    bridge: { status: 'idle' },
  })

  /** The provider's saved key (the source of truth for whether to fetch). */
  function savedKey(id: LlmProviderId): string {
    const field = keyField(id)
    return field === null ? '' : getSettings()[field] ?? ''
  }

  /** Re-fetch one provider's balance. No-op for unsupported / key-less providers. */
  async function refreshBalance(id: LlmProviderId): Promise<void> {
    const key = savedKey(id).trim()
    if (!providerSupportsBalance(id) || !key) {
      balanceStates[id] = { status: 'idle' }
      return
    }
    balanceStates[id] = { status: 'loading' }
    const balance = await fetchProviderBalance(id, key)
    balanceStates[id] = balance ? { status: 'ok', balance } : { status: 'empty' }
  }

  // Initial load: fetch the balance once per supported, keyed provider on mount
  // (not reactive to keystrokes — only the saved key matters here).
  $effect(() => {
    for (const p of PROVIDERS) {
      if (providerSupportsBalance(p.id) && savedKey(p.id).trim()) void refreshBalance(p.id)
    }
  })
</script>

<section id="ai-models" aria-label="AI models">
  <h2 class="section-label">AI models</h2>
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

        {#if useCombobox(p.models.length)}
          <div class="field model-label" id="model-field-{p.id}"><span class="field-label">{p.displayName} model</span>
            <ModelCombobox
              id="model-combobox-{p.id}"
              label="{p.displayName} model"
              models={p.models}
              value={modelSel[p.id] || p.defaultModel}
              onselect={(modelId) => onModelChange(p.id, modelId)}
            />
          </div>
        {:else}
          <label class="field model-label"><span class="field-label">{p.displayName} model</span>
            <select
              value={modelSel[p.id] || p.defaultModel}
              onchange={(e) => onModelChange(p.id, (e.currentTarget as HTMLSelectElement).value)}
            >
              {#each p.models as m (m.id)}
                <option value={m.id}>{m.label}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if isBridge(p.id)}
          <p class="bridge-line" data-testid="bridge-source-status">
            {#if bridgeState.status === 'connected'}
              {#if bridgeReady}
                Paired with <strong>{bridgeState.root}</strong>. Reviews run through your own CLI
                on your existing subscription — no API key, no per-token bill.
              {:else}
                Paired with <strong>{bridgeState.root}</strong>, but that CLI was not found on its
                PATH. Detected: {bridgeState.capabilities?.inference.join(', ') || 'none'}.
              {/if}
            {:else if bridgeState.paired}
              Not connected — start the bridge in your repo, then it reconnects automatically.
            {:else}
              No bridge paired yet. Set one up in <a href="#bridge">Local bridge</a> below.
            {/if}
          </p>
        {:else}
          <label class="field key-label"><span class="field-label">{p.displayName} API key</span>
            <SecretInput bind:value={keys[p.id]} placeholder={p.keyHint} />
          </label>
        {/if}
        <div class="test-row">
          <button
            class="btn test-btn"
            data-dirty={dirtyKeys[p.id] ? 'true' : 'false'}
            onclick={() => handleSaveAndTest(p.id)}
            disabled={testStates[p.id].status === 'testing'}
            aria-label={isBridge(p.id)
              ? `Test ${p.displayName} connection`
              : `Save & test ${p.displayName} connection`}
            aria-busy={testStates[p.id].status === 'testing'}
          >
            {#if testStates[p.id].status === 'testing'}<Spinner size="0.8em" />{/if}{testStates[p.id].status === 'testing' ? 'Testing…' : isBridge(p.id) ? 'Test' : 'Save & test'}
          </button>
          {#if dirtyKeys[p.id]}<span class="dirty-hint">Unsaved changes</span>{/if}
          <span class="saved-note" class:visible={savedStates[p.id]} aria-live="polite">{savedStates[p.id] ? 'Saved ✓' : ''}</span>
          {#if testStates[p.id].status === 'ok'}
            <span class="test-ok" role="status">✓ Connected</span>
          {:else if testStates[p.id].status === 'error'}
            <span class="test-error" role="alert">{testStates[p.id].message}</span>
          {/if}
        </div>

        {#if providerSupportsBalance(p.id) && balanceStates[p.id].status !== 'idle'}
          <div class="balance-row" data-testid="balance-{p.id}">
            {#if balanceStates[p.id].status === 'loading'}
              <span class="balance-loading">Credits: loading…</span>
            {:else if balanceStates[p.id].status === 'ok' && balanceStates[p.id].balance}
              <span class="balance-amount">Credits: {formatBalance(balanceStates[p.id].balance!)}</span>
            {:else}
              <span class="balance-empty" title="Couldn't load the balance — your key still works for reviews.">Credits: —</span>
            {/if}
            <button
              type="button"
              class="balance-refresh"
              aria-label="Refresh {p.displayName} credits"
              disabled={balanceStates[p.id].status === 'loading'}
              onclick={() => refreshBalance(p.id)}
            >Refresh</button>
          </div>
        {/if}

        <p class="privacy-line">
          {#if isBridge(p.id)}
            Nothing leaves your machine: the prompt goes to 127.0.0.1, and the bridge runs your
            CLI, which talks to its own vendor as it always does. Deep (agentic) review runs your
            CLI with read-only access to your checkout — it reads the code in front of you, so it
            can check a claim against the real file instead of guessing. It can read and search;
            it cannot write, run commands or change a branch.
          {:else if p.id === 'openai'}
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
    <h3 class="task-modes-label">What runs (and how deep)</h3>
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

  <div class="deep-review-row">
    <label class="deep-review-toggle" class:disabled={!crossVerifyAvailable}>
      <input
        type="checkbox"
        name="crossModelVerify"
        checked={crossModelVerify}
        disabled={!crossVerifyAvailable}
        onchange={(e) => onCrossModelVerifyChange((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="deep-review-label">Cross-check findings with your other AI providers</span>
    </label>
    <p class="deep-review-hint">
      Your other models verify each finding — fewer false positives, more tokens.
      {#if !crossVerifyAvailable}<strong> Add a second model (any provider, or a second model of the same provider) below to enable.</strong>{/if}
    </p>
  </div>

  <!-- Plan P — unified model panel (merges "How models combine" + the ensemble) -->
  <div class="ensemble-editor" class:disabled={!crossModelVerify} data-testid="model-panel">
    <div class="ensemble-head">
      <h3 class="ensemble-title">Model panel</h3>
      <button type="button" class="ensemble-reset" onclick={resetPanel}>Reset to default</button>
    </div>
    <p class="deep-review-hint">
      Add the models you want and give each a role. <strong>Generators</strong> find issues;
      <strong>Verifiers</strong> check them. The mode is automatic: one generator = the others
      verify (precision); two or more generators = every generator finds independently and the
      union is merged + cross-confirmed (recall — catches more, costs more). You can use several
      models of the same provider on one key (e.g. Opus generates, Sonnet + Haiku verify) — and on
      the <strong>local bridge</strong> several models of one CLI on one subscription, by giving each
      bridge row its own model (e.g. Fable generates, Opus verifies).
    </p>

    <div class="panel-presets" role="group" aria-label="Role presets">
      <span class="quick-set-label">Quick set:</span>
      <button type="button" class="quick-set-btn" onclick={presetOneGenerator}>One generator</button>
      <button type="button" class="quick-set-btn" onclick={presetAllGenerate}>All generate</button>
    </div>

    <ul class="ensemble-rows">
      {#each panelParticipants as row, i (i)}
        {@const keyed = providerKeyed(row.provider)}
        {@const lockGenerator = row.role === 'generator' && generatorCount <= 1}
        <li class="ensemble-row" class:row-disabled={!keyed}>
          <div
            class="role-segmented"
            role="radiogroup"
            aria-label="Role for {getProvider(row.provider)?.displayName} {row.model}"
          >
            <label class="role-option" class:selected={row.role === 'generator'}>
              <input
                type="radio"
                name="panel-role-{i}"
                value="generator"
                checked={row.role === 'generator'}
                disabled={!keyed}
                onchange={() => setRowRole(i, 'generator')}
              />
              <span>Generator</span>
            </label>
            <label class="role-option" class:selected={row.role === 'verifier'} class:locked={lockGenerator}>
              <input
                type="radio"
                name="panel-role-{i}"
                value="verifier"
                checked={row.role === 'verifier'}
                disabled={!keyed || lockGenerator}
                onchange={() => setRowRole(i, 'verifier')}
              />
              <span>Verifier</span>
            </label>
          </div>
          <select
            class="ensemble-provider"
            aria-label="Provider"
            value={row.provider}
            onchange={(e) => onRowProvider(i, (e.currentTarget as HTMLSelectElement).value as AiProvider)}
          >
            {#each PROVIDERS as p (p.id)}
              <option value={p.id}>{p.displayName}</option>
            {/each}
          </select>
          {#if useCombobox((getProvider(row.provider)?.models ?? []).length)}
            <div class="ensemble-model ensemble-model-combobox">
              <ModelCombobox
                id="ensemble-model-{i}"
                label="Model"
                models={getProvider(row.provider)?.models ?? []}
                value={row.model}
                onselect={(modelId) => onRowModel(i, modelId)}
              />
            </div>
          {:else}
            <select
              class="ensemble-model"
              aria-label="Model"
              value={row.model}
              onchange={(e) => onRowModel(i, (e.currentTarget as HTMLSelectElement).value)}
            >
              {#each (getProvider(row.provider)?.models ?? []) as m (m.id)}
                <option value={m.id}>{m.label}</option>
              {/each}
            </select>
          {/if}
          {#if row.provider === 'bridge'}
            <!--
              The bridge's "models" are CLI process names, so the select above
              picks the BINARY and this picks the model it runs. Free text, not
              a dropdown: neither CLI publishes a stable list of accepted model
              ids, so a baked-in one would be wrong within weeks (#253). The
              datalist only SUGGESTS — any id is still accepted.
            -->
            <input
              class="ensemble-bridge-model"
              class:model-invalid-input={bridgeModelInvalid(i)}
              type="text"
              list={row.model === 'claude' ? 'bridge-claude-aliases' : undefined}
              value={bridgeModelText(i, row)}
              oninput={(e) => onRowBridgeModel(i, (e.currentTarget as HTMLInputElement).value)}
              aria-label="Model for {getModelDef(getProvider('bridge')!, row.model)?.label ?? row.model}"
              aria-invalid={bridgeModelInvalid(i)}
              placeholder={bridgeModelPlaceholder}
              autocomplete="off"
              spellcheck="false"
              data-testid="panel-bridge-model-{i}"
            />
          {/if}
          {#if panelParticipants.length > 1}
            <button
              type="button"
              class="ensemble-remove"
              aria-label="Remove participant"
              onclick={() => removeParticipant(i)}
            >✕</button>
          {/if}
          {#if !keyed}
            <span class="ensemble-nokey">{noCredentialHint(row.provider)}</span>
          {/if}
          {#if bridgeModelInvalid(i)}
            <span class="ensemble-nokey model-invalid" data-testid="panel-bridge-model-invalid-{i}"
              >That isn't a model id — letters, digits and <code>. _ : / -</code>. Until it is fixed
              this row {inheritedBridgeModel ? `runs ${inheritedBridgeModel}` : "uses the CLI's own default"}.</span
            >
          {/if}
        </li>
      {/each}
    </ul>
    <!--
      SUGGESTIONS, not an allowlist: these three are the aliases `claude --model`
      documents in its own --help ("an alias for the latest model"), so they
      track the CLI rather than a list we would have to maintain. The input
      accepts any id regardless; an unknown one is rejected by the CLI, with the
      CLI's own error. `codex` gets no datalist — its --help publishes no values,
      and guessing some would be exactly the stale list #253 refused to ship.
    -->
    <datalist id="bridge-claude-aliases">
      <option value="fable"></option>
      <option value="opus"></option>
      <option value="sonnet"></option>
    </datalist>
    {#if bridgeRowCount > 1}
      <p class="deep-review-hint" data-testid="panel-bridge-seat-note">
        {bridgeRowCount} rows run through the local bridge, so a task makes at least {bridgeRowCount}
        CLI calls against that one subscription. They count against its own rate limits, not an API bill.
      </p>
    {/if}
    {#if crossVerifyAvailable && !panelCanOverturn}
      <p class="ensemble-thin-poll" data-testid="ensemble-thin-poll">
        <strong>Two models can agree, but they cannot outvote each other.</strong> When one model
        raises a finding and one checks it, a tie goes to the finding — so the check can only
        remove a finding it flatly refutes, and it can never settle a disagreement. Add a third
        model to give the panel a real vote.
      </p>
    {/if}
    {#if panelParticipants.length >= 4}
      <p class="ensemble-scale-note" data-testid="ensemble-scale-note">
        Each model verifies every finding — more models means more tokens and higher
        rate-limit risk, with diminishing returns. Watch the per-model impact to see
        which earn their keep.
      </p>
    {/if}
    <button type="button" class="ensemble-add" onclick={addParticipant}>+ Add a model</button>
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

  /* A real <h2> (F13/rubric D1) styled down to the label it already was.
     letter-spacing is pinned back to normal because the global h2/h3 rules
     tighten it: the outline is the change here, not a single rendered pixel. */
  .section-label {
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: normal;
    margin: 0 0 var(--space-2);
    color: var(--text);
  }

  .apply-note {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: 0 0 var(--space-3);
  }

  .provider-cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* One context block per provider: radio + model + key + Save & test. */
  .provider-card {
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: var(--space-3) var(--space-3) var(--space-2);
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
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .provider-radio {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--text);
  }

  .provider-name {
    font-weight: 600;
  }

  .use-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .provider-card[data-active='true'] .use-hint {
    color: var(--accent);
    font-weight: 600;
  }

  /* Both are .field now (audit F12): the primitive in app.css supplies the
     column, the 0.25rem label→control step and the demoted label ink, so all
     that is left here is the gap to whatever follows the field in the card.
     Before, the label was 13.5px --text — the same size as the select's own
     text and at full strength — over a 3.7px gap, against 7.5px to the next
     row: a 2:1 ratio the audit measured as unreadable as grouping. */
  .model-label {
    margin-bottom: var(--space-4);
  }

  .key-label {
    margin-bottom: var(--space-3);
  }

  .test-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .test-btn {
    font-size: var(--text-sm);
  }

  /* A dirty key field's button becomes prominent (accent) — saved-vs-not at a glance */
  .test-btn[data-dirty='true'] {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  .dirty-hint {
    font-size: var(--text-xs);
    font-style: italic;
    color: var(--text-muted);
  }

  .saved-note {
    font-size: var(--text-xs);
    color: var(--ok, #1a7f37);
    opacity: 0;
    transition: opacity 0.35s ease;
  }

  .saved-note.visible {
    opacity: 1;
  }

  .test-ok {
    font-size: var(--text-xs);
    color: var(--ok, #1a7f37);
  }

  .test-error {
    font-size: var(--text-xs);
    color: #cf222e;
  }

  /* Capability-gated "credits remaining" readout — muted, unobtrusive. */
  .balance-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .balance-amount {
    color: var(--text);
    font-weight: 600;
  }

  .balance-refresh {
    background: none;
    border: none;
    color: var(--accent);
    font-size: var(--text-xs);
    cursor: pointer;
    padding: 0;
  }

  .balance-refresh:disabled {
    color: var(--text-muted);
    cursor: default;
  }

  .bridge-line {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--text-muted);
  }

  .bridge-line strong {
    color: var(--text);
    font-weight: 600;
  }

  /* Without this the in-body link renders in the UA default #0000EE — the one
     colour on the page that is in neither palette, and a saturated blue next to
     a teal accent (audit F14). Inherit the note's own --text-muted and keep the
     underline as the affordance, matching BridgeSection's `.install a` idiom. */
  .bridge-line a {
    color: inherit;
    text-decoration: underline;
  }

  .privacy-line {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: var(--space-2) 0 0;
  }

  /* Plan J: "What runs (and how deep)" per-task mode matrix. */
  /* Asymmetric padding on purpose: it is what gives the <h3> inside 13.5px
     above against its 4.5px below (3:1, rubric D2, p.85) — it was 2:1. */
  .task-modes {
    margin: var(--space-3) 0 0;
    padding: var(--space-4) var(--space-3) var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: 8px;
  }

  .task-modes-label {
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: normal;
    margin: 0 0 var(--space-1);
    color: var(--text);
  }

  .task-modes-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: 0 0 var(--space-2);
  }

  .quick-set {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }

  .quick-set-label {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .quick-set-btn {
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-control);
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
    gap: var(--space-2);
  }

  .task-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .task-name {
    font-size: var(--text-sm);
    color: var(--text);
  }

  /* Themed segmented control — radios under the hood, consistent with siblings. */
  .mode-segmented {
    display: inline-flex;
    border: 1px solid var(--border-control);
    border-radius: 6px;
    overflow: hidden;
  }

  .mode-option {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--text-muted);
    border-left: 1px solid var(--border-control);
  }

  .mode-option:first-child {
    border-left: none;
  }

  .mode-option.selected {
    background: var(--accent);
    color: var(--on-accent);
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
    font-size: var(--text-xs);
    opacity: 0.7;
  }

  .deep-review-row {
    margin: var(--space-3) 0 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: 8px;
  }

  .deep-review-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .deep-review-toggle.disabled {
    cursor: not-allowed;
    opacity: var(--disabled-opacity);
  }

  .deep-review-label {
    font-weight: 600;
  }

  .deep-review-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: var(--space-1) 0 0;
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: var(--space-3) 0 0;
  }

  .privacy-note p {
    margin: 0 0 var(--space-1);
  }

  /* Plan N — ensemble editor */
  .ensemble-editor {
    margin-top: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    background: var(--surface);
  }
  .ensemble-editor.disabled {
    opacity: var(--disabled-opacity);
    pointer-events: none;
  }
  .ensemble-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  /* A real <h3> (F13/D1) styled down to the label it already looked like:
     the UA heading margins would otherwise break the baseline-aligned row. */
  .ensemble-title {
    font-weight: 600;
    font-size: var(--text-sm);
    letter-spacing: normal;
    margin: 0;
    color: var(--text);
  }
  .ensemble-reset {
    background: none;
    border: none;
    color: var(--accent);
    font-size: var(--text-xs);
    cursor: pointer;
    padding: 0;
  }
  .ensemble-rows {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .ensemble-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .ensemble-row.row-disabled {
    opacity: 0.6;
  }
  /* Plan P — per-row role segmented toggle (Generator | Verifier) */
  .panel-presets {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin: var(--space-2) 0 var(--space-1);
  }
  .role-segmented {
    display: inline-flex;
    border: 1px solid var(--border-control);
    border-radius: 6px;
    overflow: hidden;
  }
  .role-option {
    display: inline-flex;
    align-items: center;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    cursor: pointer;
    color: var(--text-muted);
    border-left: 1px solid var(--border-control);
  }
  .role-option:first-child {
    border-left: none;
  }
  .role-option.selected {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .role-option.locked {
    cursor: not-allowed;
    opacity: var(--disabled-opacity);
  }
  .role-option input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    margin: -1px;
  }
  .ensemble-provider,
  .ensemble-model {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-control);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: var(--text-sm);
  }
  /* The combobox brings its own input border/background — don't double it. */
  .ensemble-model-combobox {
    padding: 0;
    border: none;
    background: none;
    min-width: 12rem;
    flex: 1 1 12rem;
  }
  /* A bridge row's model box: a text input, deliberately not a dropdown, since
     neither CLI publishes a stable list of ids. It matches the chrome of the
     CLI picker beside it because (CLI, model) is really one choice. */
  .ensemble-bridge-model {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-control);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: var(--text-sm);
    min-width: 8rem;
    flex: 1 1 8rem;
  }
  .ensemble-bridge-model::placeholder {
    color: var(--text-muted);
    opacity: 0.8;
  }
  .ensemble-bridge-model.model-invalid-input {
    border-color: var(--danger, #b3261e);
  }
  .ensemble-nokey.model-invalid {
    color: var(--danger, #b3261e);
  }
  .ensemble-remove {
    background: none;
    border: 1px solid var(--border-control);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    width: 1.6rem;
    height: 1.6rem;
    line-height: 1;
  }
  .ensemble-nokey {
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex-basis: 100%;
  }
  .ensemble-scale-note {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    font-style: italic;
    color: var(--text-muted);
    opacity: 0.85;
  }
  /* Not styled as an error: a two-model panel is a legitimate, useful setup —
     this corrects what it can be expected to DO, it does not condemn it. */
  .ensemble-thin-poll {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    line-height: 1.45;
    color: var(--text-muted);
  }
  .ensemble-add {
    margin-top: var(--space-2);
    background: none;
    border: 1px dashed var(--border-control);
    border-radius: 6px;
    color: var(--accent);
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    cursor: pointer;
  }
</style>
