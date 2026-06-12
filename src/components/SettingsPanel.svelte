<script lang="ts">
  import { getSettings, saveTokens, setTheme, setUiFont, type Theme, type UiFont } from '../lib/settings/settings'
  import { applyAppearance } from '../lib/settings/appearance.svelte'
  import { track } from '../lib/analytics/analytics'
  import { authState } from '../lib/auth/authState.svelte'

  let { onclose }: { onclose: () => void } = $props()
  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let deepseek = $state(current.deepseekKey ?? '')
  let error = $state<string | null>(null)
  let theme = $state<Theme>(current.theme)
  let uiFont = $state<UiFont>(current.uiFont)

  // authStatusLine is derived from the reactive authState so it updates live
  // when the user saves a PAT or signs in/out via OAuth.
  const authStatusLine = $derived.by(() => {
    const auth = authState.auth
    if (!auth) return 'Not signed in'
    if (auth.method === 'oauth') {
      const scopeList = auth.scopes.length > 0 ? auth.scopes.join(', ') : 'none'
      return `Signed in via GitHub (scopes: ${scopeList})`
    }
    return 'Using PAT'
  })

  // Advanced disclosure is open by default only when PAT is the active auth method,
  // so existing PAT users aren't confused by a closed section hiding their token.
  const advancedOpen = $derived(authState.auth?.method === 'pat')

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

  function save() {
    try {
      const hadPat = !!current.githubPat
      const hadKey = !!current.deepseekKey
      saveTokens({
        githubPat: pat.trim() === '' ? null : pat,
        deepseekKey: deepseek.trim() === '' ? null : deepseek,
      })
      if (!hadPat && pat.trim()) track('settings_key_added', { service: 'github' })
      if (!hadKey && deepseek.trim()) track('settings_key_added', { service: 'deepseek' })
      onclose()
    } catch (e) {
      error = (e as Error).message
    }
  }
</script>

<dialog open aria-label="Settings">
  <h2>Settings</h2>

  <section aria-label="Appearance — applies immediately">
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
  </section>

  <p class="auth-status">{authStatusLine}</p>
  <label>DeepSeek API key
    <input type="password" bind:value={deepseek} autocomplete="off" placeholder="sk-…" />
  </label>
  <details open={advancedOpen}>
    <summary>Advanced: use a personal access token instead</summary>
    <label>GitHub token (PAT)
      <input type="password" bind:value={pat} autocomplete="off" placeholder="github_pat_… (fine-grained, repo-scoped recommended)" />
    </label>
  </details>
  <p class="hint">Keys are stored only in this browser (localStorage) and sent only to their own services.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <button class="btn btn-primary" onclick={save}>Save</button>
  <button class="btn" onclick={onclose}>Cancel</button>
</dialog>

<style>
  /* dialog base from app.css; override only layout-specific things */
  dialog {
    max-width: 520px;
  }

  .auth-status {
    font-size: 0.9em;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  details {
    margin: 0.5rem 0;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    overflow: hidden;
  }

  details summary {
    /* override global uppercase for this context */
    text-transform: none;
    letter-spacing: normal;
    font-size: 0.9em;
    color: var(--text-muted);
  }

  details label {
    display: block;
    margin: 0.5rem 0.75rem;
  }

  section[aria-label^="Appearance"] {
    margin-bottom: 1rem;
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

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.5rem 0;
  }
</style>
