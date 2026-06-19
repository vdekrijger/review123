<script lang="ts">
  import { getSettings, setTheme, setUiFont, setShowProgress, setTestFileDisplay, setDiffWidth, setFocusMode, setShowTokenCost, setUnderstandSections, type Theme, type UiFont, type TestFileDisplay, type DiffWidth, type FocusMode } from '../../lib/settings/settings'
  import { applyAppearance } from '../../lib/settings/appearance.svelte'
  import { resolveUnderstandSections } from '../panels/sectionRegistry'

  const current = getSettings()
  let theme = $state<Theme>(current.theme)
  let uiFont = $state<UiFont>(current.uiFont)
  let showProgress = $state<boolean>(current.showProgress)
  let testFileDisplay = $state<TestFileDisplay>(current.testFileDisplay)
  let diffWidth = $state<DiffWidth>(current.diffWidth)
  let focusMode = $state<FocusMode>(current.focusMode)
  let showTokenCost = $state<boolean>(current.showTokenCost)

  // --- Understand-step layout (order + enable/disable of the 8 page panels) ---
  // Seeded from the resolved preference so a fresh (unset) state shows the
  // canonical registry order, all enabled. Each mutation persists immediately
  // via setUnderstandSections, which the Understand step reads reactively.
  let understandRows = $state<{ id: string; title: string; enabled: boolean }[]>(
    resolveUnderstandSections(current.understandSections).map((s) => ({
      id: s.descriptor.id,
      title: s.descriptor.title,
      enabled: s.enabled,
    })),
  )

  /** Persist the current local rows as the ordered preference. */
  function persistUnderstand() {
    setUnderstandSections(understandRows.map((r) => ({ id: r.id, enabled: r.enabled })))
  }

  function toggleUnderstandEnabled(index: number, enabled: boolean) {
    understandRows[index].enabled = enabled
    persistUnderstand()
  }

  function moveUnderstand(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= understandRows.length) return
    const next = [...understandRows]
    const [row] = next.splice(index, 1)
    next.splice(target, 0, row)
    understandRows = next
    persistUnderstand()
  }

  function resetUnderstand() {
    setUnderstandSections(null)
    // Re-seed from the registry default (cleared preference → registry order).
    understandRows = resolveUnderstandSections(getSettings().understandSections).map((s) => ({
      id: s.descriptor.id,
      title: s.descriptor.title,
      enabled: s.enabled,
    }))
  }

  function onThemeChange(value: Theme) {
    theme = value
    setTheme(value)
    applyAppearance()
  }

  function onFontChange(value: UiFont) {
    uiFont = value
    setUiFont(value)
    applyAppearance()
  }

  function onShowProgressChange(value: boolean) {
    showProgress = value
    setShowProgress(value)
  }

  function onTestFileDisplayChange(value: TestFileDisplay) {
    testFileDisplay = value
    setTestFileDisplay(value)
  }

  function onDiffWidthChange(value: DiffWidth) {
    diffWidth = value
    setDiffWidth(value)
    applyAppearance()
  }

  function onFocusModeChange(value: FocusMode) {
    focusMode = value
    setFocusMode(value)
  }

  function onShowTokenCostChange(value: boolean) {
    showTokenCost = value
    setShowTokenCost(value)
  }
</script>

<section id="appearance" aria-label="Appearance — applies immediately">
  <p class="section-label">Appearance <span class="immediate-note">(applies immediately)</span></p>
  <fieldset>
    <legend>Theme</legend>
    <label>
      <input type="radio" name="theme" value="auto" checked={theme === 'auto'} onchange={() => onThemeChange('auto')} />
      Auto
    </label>
    <label>
      <input type="radio" name="theme" value="light" checked={theme === 'light'} onchange={() => onThemeChange('light')} />
      Light
    </label>
    <label>
      <input type="radio" name="theme" value="dark" checked={theme === 'dark'} onchange={() => onThemeChange('dark')} />
      Dark
    </label>
  </fieldset>

  <fieldset>
    <legend>Font</legend>
    <label>
      <input type="radio" name="uiFont" value="plex" checked={uiFont === 'plex'} onchange={() => onFontChange('plex')} />
      Plex
    </label>
    <label>
      <input type="radio" name="uiFont" value="system" checked={uiFont === 'system'} onchange={() => onFontChange('system')} />
      System
    </label>
    <label>
      <input type="radio" name="uiFont" value="serif" checked={uiFont === 'serif'} onchange={() => onFontChange('serif')} />
      Serif
    </label>
  </fieldset>

  <fieldset aria-label="Progress bar">
    <legend>Progress bar</legend>
    <label>
      <input type="radio" name="showProgress" value="show" checked={showProgress} onchange={() => onShowProgressChange(true)} />
      Show
    </label>
    <label>
      <input type="radio" name="showProgress" value="hide" checked={!showProgress} onchange={() => onShowProgressChange(false)} />
      Hide
    </label>
  </fieldset>

  <fieldset aria-label="Test files">
    <legend>Test files</legend>
    <label>
      <input type="radio" name="testFileDisplay" value="normal" checked={testFileDisplay === 'normal'} onchange={() => onTestFileDisplayChange('normal')} />
      Normal
    </label>
    <label>
      <input type="radio" name="testFileDisplay" value="highlight" checked={testFileDisplay === 'highlight'} onchange={() => onTestFileDisplayChange('highlight')} />
      Highlight
    </label>
    <label>
      <input type="radio" name="testFileDisplay" value="dim" checked={testFileDisplay === 'dim'} onchange={() => onTestFileDisplayChange('dim')} />
      De-emphasize
    </label>
  </fieldset>

  <fieldset aria-label="Focus mode">
    <legend>Focus mode</legend>
    <label>
      <input type="radio" name="focusMode" value="off" checked={focusMode === 'off'} onchange={() => onFocusModeChange('off')} />
      Off
    </label>
    <label>
      <input type="radio" name="focusMode" value="imports" checked={focusMode === 'imports'} onchange={() => onFocusModeChange('imports')} />
      Dim imports
    </label>
    <label>
      <input type="radio" name="focusMode" value="imports-comments" checked={focusMode === 'imports-comments'} onchange={() => onFocusModeChange('imports-comments')} />
      Dim imports + comments
    </label>
    <p class="field-note">Fades import and (optionally) comment lines in the diff so real changes stand out. Lines stay visible, selectable, and commentable — never hidden.</p>
  </fieldset>

  <fieldset aria-label="Diff width">
    <legend>Diff width</legend>
    <label>
      <input type="radio" name="diffWidth" value="centered" checked={diffWidth === 'centered'} onchange={() => onDiffWidthChange('centered')} />
      Centered
    </label>
    <label>
      <input type="radio" name="diffWidth" value="full" checked={diffWidth === 'full'} onchange={() => onDiffWidthChange('full')} />
      Full width
    </label>
    <p class="field-note">Full = edge-to-edge diff at any screen size; Centered = comfortable reading column.</p>
  </fieldset>

  <fieldset aria-label="Token usage">
    <legend>Token usage</legend>
    <label>
      <input type="checkbox" name="showTokenCost" checked={showTokenCost} onchange={(e) => onShowTokenCostChange((e.currentTarget as HTMLInputElement).checked)} />
      Show token usage
    </label>
    <p class="field-note">Display approximate tokens/cost per AI section (power users).</p>
  </fieldset>

  <fieldset class="understand-layout" aria-label="Understand step layout">
    <legend>Understand step layout</legend>
    <p class="field-note">Reorder and show/hide the detail panels on the Understand step. Panels can still hide automatically when they have no data (e.g. no CI, no PR description).</p>
    <ul class="understand-list">
      {#each understandRows as row, i (row.id)}
        <li class="understand-row">
          <label class="understand-toggle">
            <input
              type="checkbox"
              checked={row.enabled}
              aria-label="Show {row.title}"
              onchange={(e) => toggleUnderstandEnabled(i, (e.currentTarget as HTMLInputElement).checked)}
            />
            <span class="understand-title">{row.title}</span>
          </label>
          <span class="understand-moves">
            <button
              type="button"
              class="move-btn"
              aria-label="Move {row.title} up"
              disabled={i === 0}
              onclick={() => moveUnderstand(i, -1)}
            >↑</button>
            <button
              type="button"
              class="move-btn"
              aria-label="Move {row.title} down"
              disabled={i === understandRows.length - 1}
              onclick={() => moveUnderstand(i, 1)}
            >↓</button>
          </span>
        </li>
      {/each}
    </ul>
    <button type="button" class="reset-btn" onclick={resetUnderstand}>Reset to default</button>
  </fieldset>
</section>

<style>
  /* Bounded section card — everything here applies immediately, no Save. */
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

  .immediate-note {
    font-weight: normal;
    color: var(--text-muted);
    font-size: 0.85em;
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

  .field-note {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.8em;
    color: var(--text-muted);
  }

  /* ===== Understand step layout ===== */
  .understand-layout {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .understand-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    width: 100%;
  }

  .understand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--hairline);
    border-radius: 5px;
    background: var(--surface);
  }

  .understand-toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.9em;
    cursor: pointer;
    flex: 1;
    min-width: 0;
  }

  .understand-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .understand-moves {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .move-btn {
    border: 1px solid var(--hairline);
    background: var(--surface-raised);
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.85em;
    line-height: 1;
    padding: 0.2rem 0.45rem;
    color: var(--text);
  }

  .move-btn:hover:not(:disabled) {
    background: #8881;
  }

  .move-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .move-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .reset-btn {
    align-self: flex-start;
    border: 1px solid var(--hairline);
    background: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.8em;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.3rem 0.7rem;
  }

  .reset-btn:hover {
    background: #8881;
    color: var(--text);
  }
</style>
