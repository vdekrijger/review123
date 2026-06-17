<script lang="ts">
  /**
   * ModelCombobox — a two-column lab/model picker for providers with a large
   * lineup (OpenRouter's ~300 models). Drop-in for the plain <select>: same
   * contract — it reports the chosen model id via `onselect`.
   *
   * Closed state: a <button> trigger (NOT a text input) showing the selected
   * model's label as plain opaque text + a chevron — no placeholder/overlay
   * duplication (the old garbled doubled text is gone).
   *
   * Open panel: a popover anchored below the trigger, bounded height with its
   * OWN scroll (never a side flyout / never overflows the card). Top = a search
   * field. Empty query → TWO columns: a lab list on the left (a "Featured" entry
   * + every lab, with per-lab counts) and the active lab's models on the right.
   * Non-empty query → a single flat result list of every matching model across
   * all labs, grouped by lab. role=listbox/option with aria-activedescendant on
   * the model column; the lab list is a keyboard-navigable list of buttons.
   */
  import type { LlmModelDef } from '../../lib/llm/providers'
  import {
    groupByLab, visibleModels, modelHint, labName, labOptions, FEATURED_LAB,
    type ModelGroup, type LabOption,
  } from '../../lib/llm/modelLabs'

  let {
    models,
    value,
    onselect,
    label = 'Model',
    id = 'model-combobox',
  }: {
    models: LlmModelDef[]
    value: string
    onselect: (modelId: string) => void
    label?: string
    id?: string
  } = $props()

  let open = $state(false)
  let query = $state('')
  /** Active MODEL index within the currently-shown model list (right col / flat results). */
  let activeIndex = $state(-1)
  /** The active LAB name in the left column (browse mode only). */
  let activeLab = $state<string>(FEATURED_LAB)
  let triggerEl = $state<HTMLButtonElement | null>(null)
  let searchEl = $state<HTMLInputElement | null>(null)

  const searching = $derived(query.trim().length > 0)

  /** The left-column lab entries (Featured + each lab with counts). */
  const labs = $derived<LabOption[]>(labOptions(models))

  /** Flat, ordered list of models the search mode shows (for keyboard nav). */
  const searchResults = $derived<LlmModelDef[]>(searching ? visibleModels(models, query) : [])
  /** The search results grouped by lab (for rendering small lab headers). */
  const searchGroups = $derived<ModelGroup[]>(searching ? groupByLab(searchResults) : [])

  /** The models shown in the right column for the active lab (browse mode). */
  const browseModels = $derived<LlmModelDef[]>(
    labs.find((l) => l.lab === activeLab)?.models ?? labs[0]?.models ?? [],
  )

  /** The list keyboard nav currently drives: flat search results, or the active lab's models. */
  const activeModels = $derived<LlmModelDef[]>(searching ? searchResults : browseModels)

  /** The label of the currently-selected model (shown on the closed trigger). */
  const selectedLabel = $derived(models.find((m) => m.id === value)?.label ?? value)

  const panelId = $derived(`${id}-panel`)
  const listboxId = $derived(`${id}-listbox`)
  const optionId = (m: LlmModelDef) => `${id}-opt-${m.id}`
  const activeOptionId = $derived(
    activeIndex >= 0 && activeModels[activeIndex] ? optionId(activeModels[activeIndex]) : undefined,
  )

  /** The lab the currently-selected value belongs to (for default-active-lab). */
  function defaultLab(): string {
    if (!value) return labs[0]?.lab ?? FEATURED_LAB
    const selected = models.find((m) => m.id === value)
    if (!selected) return labs[0]?.lab ?? FEATURED_LAB
    // Prefer the real lab so the user opens "where they are"; the featured
    // pseudo-lab is only the fallback when the value isn't in any real lab.
    const lab = labName(selected.id)
    if (labs.some((l) => l.lab === lab)) return lab
    return labs[0]?.lab ?? FEATURED_LAB
  }

  function openPanel() {
    if (open) return
    open = true
    query = ''
    activeLab = defaultLab()
    // Highlight the selected model within the active lab (or the first).
    queueMicrotask(() => {
      const idx = browseModels.findIndex((m) => m.id === value)
      activeIndex = idx >= 0 ? idx : browseModels.length ? 0 : -1
      searchEl?.focus()
    })
  }

  function closePanel(returnFocus = true) {
    open = false
    activeIndex = -1
    query = ''
    if (returnFocus) triggerEl?.focus()
  }

  function choose(modelId: string) {
    onselect(modelId)
    open = false
    activeIndex = -1
    query = ''
    triggerEl?.focus()
  }

  function setActiveLab(lab: string) {
    activeLab = lab
    activeIndex = 0
  }

  function onSearchInput(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value
    activeIndex = activeModels.length ? 0 : -1
  }

  function moveActive(delta: number) {
    const n = activeModels.length
    if (!n) return
    activeIndex = activeIndex < 0 ? (delta > 0 ? 0 : n - 1) : (((activeIndex + delta) % n) + n) % n
    // Keep the active option scrolled into view.
    queueMicrotask(() => {
      const m = activeModels[activeIndex]
      const el = m ? document.getElementById(optionId(m)) : null
      el?.scrollIntoView?.({ block: 'nearest' })
    })
  }

  /** Move the active LAB up/down in browse mode (Left/Right transfers focus). */
  function moveLab(delta: number) {
    const n = labs.length
    if (!n) return
    const cur = labs.findIndex((l) => l.lab === activeLab)
    const next = ((((cur < 0 ? 0 : cur) + delta) % n) + n) % n
    setActiveLab(labs[next].lab)
  }

  /** Keyboard on the trigger button. */
  function onTriggerKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openPanel()
    }
  }

  /** Keyboard within the search field (drives the model list). */
  function onSearchKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveActive(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveActive(-1)
        break
      case 'Enter':
        if (activeIndex >= 0 && activeModels[activeIndex]) {
          e.preventDefault()
          choose(activeModels[activeIndex].id)
        }
        break
      case 'Escape':
        e.preventDefault()
        closePanel()
        break
    }
  }

  /** Keyboard within the lab list (left column). */
  function onLabKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveLab(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveLab(-1)
        break
      case 'ArrowRight':
      case 'Enter':
        e.preventDefault()
        // Move focus into the model column.
        document.getElementById(listboxId)?.focus()
        break
      case 'Escape':
        e.preventDefault()
        closePanel()
        break
    }
  }

  /** Keyboard while the model listbox itself holds focus (browse mode). */
  function onListboxKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveActive(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveActive(-1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        document.getElementById(`${id}-labs`)?.focus()
        break
      case 'Enter':
        if (activeIndex >= 0 && activeModels[activeIndex]) {
          e.preventDefault()
          choose(activeModels[activeIndex].id)
        }
        break
      case 'Escape':
        e.preventDefault()
        closePanel()
        break
    }
  }

  /** Close when focus leaves the whole widget (root-contains pattern). */
  function onFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null
    const root = (e.currentTarget as HTMLElement).closest('.model-combobox')
    if (root && next && root.contains(next)) return
    closePanel(false)
  }
</script>

<div class="model-combobox" onfocusout={onFocusOut}>
  <button
    bind:this={triggerEl}
    {id}
    type="button"
    class="combobox-trigger"
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? panelId : undefined}
    onclick={() => (open ? closePanel() : openPanel())}
    onkeydown={onTriggerKeydown}
  >
    <span class="combobox-trigger-label">{selectedLabel}</span>
    <span class="combobox-arrow" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div class="combobox-panel" id={panelId} role="presentation">
      <div class="combobox-search-row">
        <input
          bind:this={searchEl}
          class="combobox-search"
          type="text"
          role="searchbox"
          aria-label="Search all {models.length} models"
          placeholder="Search all {models.length} models…"
          autocomplete="off"
          value={query}
          oninput={onSearchInput}
          onkeydown={onSearchKeydown}
        />
      </div>

      {#if searching}
        <!-- Search mode: a single flat, scrollable result list, grouped by lab. -->
        <div
          class="combobox-results"
          role="listbox"
          id={listboxId}
          aria-label={label}
          aria-activedescendant={activeOptionId}
          tabindex="0"
          onkeydown={onSearchKeydown}
        >
          {#if searchResults.length === 0}
            <p class="combobox-empty">No models match “{query}”.</p>
          {:else}
            {#each searchGroups as group (group.lab)}
              <div class="combobox-result-group" role="group" aria-label={group.lab}>
                <span class="combobox-result-lab">{group.lab}</span>
                {#each group.models as m (m.id)}
                  {@const idx = searchResults.indexOf(m)}
                  <div
                    id={optionId(m)}
                    role="option"
                    aria-selected={m.id === value}
                    tabindex="-1"
                    class="combobox-option"
                    class:active={idx === activeIndex}
                    class:selected={m.id === value}
                    onmousedown={(e) => {
                      e.preventDefault()
                      choose(m.id)
                    }}
                    onmouseenter={() => (activeIndex = idx)}
                  >
                    <span class="combobox-option-label">{m.label}</span>
                    <span class="combobox-option-hint">{modelHint(m)}</span>
                  </div>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      {:else}
        <!-- Browse mode: two columns — labs on the left, models on the right. -->
        <div class="combobox-columns">
          <div
            class="combobox-labs"
            id="{id}-labs"
            role="listbox"
            aria-label="Model labs"
            aria-activedescendant="{id}-lab-{activeLab}"
            tabindex="0"
            onkeydown={onLabKeydown}
          >
            {#each labs as l (l.lab)}
              <button
                type="button"
                id="{id}-lab-{l.lab}"
                role="option"
                aria-selected={l.lab === activeLab}
                class="combobox-lab"
                class:active={l.lab === activeLab}
                class:is-featured={l.featured}
                tabindex="-1"
                onmouseenter={() => setActiveLab(l.lab)}
                onfocus={() => setActiveLab(l.lab)}
                onclick={() => setActiveLab(l.lab)}
              >
                <span class="combobox-lab-name">{l.lab}</span>
                <span class="combobox-lab-count">{l.models.length}</span>
              </button>
            {/each}
          </div>

          <div
            class="combobox-models"
            role="listbox"
            id={listboxId}
            aria-label="{activeLab} models"
            aria-activedescendant={activeOptionId}
            tabindex="0"
            onkeydown={onListboxKeydown}
          >
            {#each browseModels as m (m.id)}
              {@const idx = browseModels.indexOf(m)}
              <div
                id={optionId(m)}
                role="option"
                aria-selected={m.id === value}
                tabindex="-1"
                class="combobox-option"
                class:active={idx === activeIndex}
                class:selected={m.id === value}
                onmousedown={(e) => {
                  e.preventDefault()
                  choose(m.id)
                }}
                onmouseenter={() => (activeIndex = idx)}
              >
                <span class="combobox-option-label">{m.label}</span>
                <span class="combobox-option-hint">{modelHint(m)}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-combobox {
    position: relative;
    display: block;
    margin-top: 0.25rem;
  }

  /* Closed trigger — matches the sibling providers' <select> look. */
  .combobox-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    box-sizing: border-box;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.9em;
    text-align: left;
    cursor: pointer;
  }

  .combobox-trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  .combobox-trigger-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .combobox-arrow {
    flex: none;
    color: var(--text-muted);
    font-size: 0.8em;
    pointer-events: none;
  }

  /* The popover — anchored below the trigger, bounded, with its own scroll. */
  .combobox-panel {
    position: absolute;
    z-index: 30;
    top: calc(100% + 4px);
    left: 0;
    width: 100%;
    min-width: 22rem;
    max-width: min(30rem, 92vw);
    box-sizing: border-box;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }

  .combobox-search-row {
    padding: 0.5rem;
    border-bottom: 1px solid var(--hairline);
  }

  .combobox-search {
    width: 100%;
    box-sizing: border-box;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 0.88em;
  }

  .combobox-search:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  /* Two-column browse layout. */
  .combobox-columns {
    display: grid;
    grid-template-columns: minmax(8rem, 11rem) 1fr;
    max-height: 20rem;
  }

  .combobox-labs {
    overflow-y: auto;
    border-right: 1px solid var(--hairline);
    padding: 0.25rem;
    background: var(--surface);
  }

  .combobox-labs:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .combobox-lab {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    width: 100%;
    box-sizing: border-box;
    padding: 0.3rem 0.45rem;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--text);
    font-size: 0.84em;
    text-align: left;
    cursor: pointer;
  }

  .combobox-lab.is-featured {
    font-weight: 600;
  }

  .combobox-lab.active {
    background: var(--accent);
    color: var(--on-accent, #fff);
  }

  .combobox-lab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .combobox-lab-count {
    flex: none;
    font-size: 0.85em;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .combobox-lab.active .combobox-lab-count {
    color: var(--on-accent, #fff);
    opacity: 0.8;
  }

  .combobox-models {
    overflow-y: auto;
    padding: 0.25rem;
  }

  .combobox-models:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Search-mode flat result list. */
  .combobox-results {
    max-height: 22rem;
    overflow-y: auto;
    padding: 0.25rem;
  }

  .combobox-results:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .combobox-result-group + .combobox-result-group {
    margin-top: 0.2rem;
  }

  .combobox-result-lab {
    display: block;
    padding: 0.3rem 0.5rem 0.15rem;
    font-size: 0.7em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  /* A model row — shared by browse + search columns. */
  .combobox-option {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.32rem 0.5rem;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.85em;
  }

  .combobox-option.active {
    background: var(--accent);
    color: var(--on-accent, #fff);
  }

  .combobox-option.selected:not(.active) {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    font-weight: 600;
  }

  .combobox-option-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .combobox-option-hint {
    flex: none;
    font-size: 0.82em;
    color: var(--text-muted);
    white-space: nowrap;
    text-align: right;
  }

  .combobox-option.active .combobox-option-hint {
    color: var(--on-accent, #fff);
    opacity: 0.85;
  }

  .combobox-empty {
    margin: 0;
    padding: 0.6rem 0.5rem;
    font-size: 0.85em;
    color: var(--text-muted);
  }
</style>
