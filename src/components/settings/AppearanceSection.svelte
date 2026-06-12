<script lang="ts">
  import { getSettings, setTheme, setUiFont, setShowProgress, setTestFileDisplay, setDiffWidth, type Theme, type UiFont, type TestFileDisplay, type DiffWidth } from '../../lib/settings/settings'
  import { applyAppearance } from '../../lib/settings/appearance.svelte'

  const current = getSettings()
  let theme = $state<Theme>(current.theme)
  let uiFont = $state<UiFont>(current.uiFont)
  let showProgress = $state<boolean>(current.showProgress)
  let testFileDisplay = $state<TestFileDisplay>(current.testFileDisplay)
  let diffWidth = $state<DiffWidth>(current.diffWidth)

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
</style>
