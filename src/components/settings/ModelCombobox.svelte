<script lang="ts">
  /**
   * ModelCombobox — a searchable, lab-grouped model picker for providers with a
   * large lineup (OpenRouter's ~300 models). Drop-in for the plain <select>:
   * same contract — it reports the chosen model id via `onselect`.
   *
   * Behaviour: type to filter (slug OR label, case-insensitive); results grouped
   * by lab with optgroup-style headers; empty query shows the featured set so the
   * user isn't dumped into 300 options; ArrowUp/Down + Enter + Esc keyboard nav;
   * combobox/listbox ARIA roles with aria-activedescendant.
   */
  import type { LlmModelDef } from '../../lib/llm/providers'
  import { groupByLab, visibleModels, modelHint, type ModelGroup } from '../../lib/llm/modelLabs'

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
  let activeIndex = $state(-1)
  let inputEl = $state<HTMLInputElement | null>(null)

  // The flat, ordered list of currently-visible models (for keyboard nav), and
  // the same list grouped by lab (for rendering). Recomputed as the user types.
  const filtered = $derived<LlmModelDef[]>(visibleModels(models, query))
  const groups = $derived<ModelGroup[]>(groupByLab(filtered))

  /** The label of the currently-selected model (shown when the box is closed). */
  const selectedLabel = $derived(models.find((m) => m.id === value)?.label ?? value)

  const listboxId = $derived(`${id}-listbox`)
  const optionId = (i: number) => `${id}-opt-${i}`

  function openList() {
    if (open) return
    open = true
    // Highlight the selected model (or the first) when opening.
    const idx = filtered.findIndex((m) => m.id === value)
    activeIndex = idx >= 0 ? idx : filtered.length ? 0 : -1
  }

  function closeList() {
    open = false
    activeIndex = -1
    query = ''
  }

  function choose(modelId: string) {
    onselect(modelId)
    closeList()
    inputEl?.blur()
  }

  function onInput(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value
    open = true
    activeIndex = filtered.length ? 0 : -1
  }

  function moveActive(delta: number) {
    if (!filtered.length) return
    const n = filtered.length
    activeIndex = (((activeIndex + delta) % n) + n) % n
  }

  function onKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!open) openList()
        else moveActive(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!open) openList()
        else moveActive(-1)
        break
      case 'Enter':
        if (open && activeIndex >= 0 && filtered[activeIndex]) {
          e.preventDefault()
          choose(filtered[activeIndex].id)
        }
        break
      case 'Escape':
        if (open) {
          e.preventDefault()
          closeList()
        }
        break
      case 'Tab':
        if (open) closeList()
        break
    }
  }

  /** Close when focus leaves the whole widget (not just the input). */
  function onBlur(e: FocusEvent) {
    const next = e.relatedTarget as Node | null
    const root = (e.currentTarget as HTMLElement).closest('.model-combobox')
    if (root && next && root.contains(next)) return
    closeList()
  }

  /** Flat index of a model within `filtered` (for aria-activedescendant). */
  function flatIndex(model: LlmModelDef): number {
    return filtered.indexOf(model)
  }
</script>

<div class="model-combobox" onfocusout={onBlur}>
  <!-- The native input is the a11y anchor; we mirror <select> labelling. -->
  <input
    bind:this={inputEl}
    {id}
    class="combobox-input"
    type="text"
    role="combobox"
    aria-label={label}
    aria-expanded={open}
    aria-controls={listboxId}
    aria-autocomplete="list"
    aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
    autocomplete="off"
    placeholder={selectedLabel}
    value={open ? query : ''}
    oninput={onInput}
    onkeydown={onKeydown}
    onfocus={openList}
    onclick={openList}
  />
  {#if !open}
    <span class="combobox-value" aria-hidden="true">{selectedLabel}</span>
  {/if}
  <span class="combobox-arrow" aria-hidden="true">▾</span>

  {#if open}
    <ul class="combobox-list" role="listbox" id={listboxId} aria-label={label}>
      {#if filtered.length === 0}
        <li class="combobox-empty" role="presentation">No models match “{query}”.</li>
      {:else}
        {#each groups as group (group.lab)}
          <li class="combobox-group" role="presentation">
            <span class="combobox-group-label">{group.lab}</span>
            <ul role="group" aria-label={group.lab} class="combobox-group-list">
              {#each group.models as m (m.id)}
                {@const idx = flatIndex(m)}
                <li
                  id={optionId(idx)}
                  role="option"
                  aria-selected={m.id === value}
                  class="combobox-option"
                  class:active={idx === activeIndex}
                  onmousedown={(e) => {
                    e.preventDefault()
                    choose(m.id)
                  }}
                  onmouseenter={() => (activeIndex = idx)}
                >
                  <span class="combobox-option-label">{m.label}</span>
                  <span class="combobox-option-hint">{modelHint(m)}</span>
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>

<style>
  .model-combobox {
    position: relative;
    display: block;
    margin-top: 0.25rem;
  }

  .combobox-input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.3rem 1.6rem 0.3rem 0.45rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.9em;
  }

  /* The selected model's label, overlaid on the (empty) input when closed. */
  .combobox-value {
    position: absolute;
    left: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--text);
    font-size: 0.9em;
    max-width: calc(100% - 2rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .combobox-arrow {
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--text-muted);
    font-size: 0.8em;
  }

  .combobox-list {
    position: absolute;
    z-index: 20;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    max-height: 18rem;
    overflow-y: auto;
    margin: 0;
    padding: 0.25rem 0;
    list-style: none;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  }

  .combobox-group {
    list-style: none;
  }

  .combobox-group-label {
    display: block;
    padding: 0.3rem 0.6rem 0.15rem;
    font-size: 0.72em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .combobox-group-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .combobox-option {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.28rem 0.6rem;
    cursor: pointer;
    font-size: 0.85em;
  }

  .combobox-option.active,
  .combobox-option[aria-selected='true'] {
    background: var(--accent);
    color: var(--on-accent, #fff);
  }

  .combobox-option.active .combobox-option-hint,
  .combobox-option[aria-selected='true'] .combobox-option-hint {
    color: var(--on-accent, #fff);
    opacity: 0.85;
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
  }

  .combobox-empty {
    padding: 0.4rem 0.6rem;
    font-size: 0.85em;
    color: var(--text-muted);
  }
</style>
