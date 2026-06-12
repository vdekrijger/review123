<script lang="ts">
  import { getSettings, saveTokens, setTheme, setUiFont, type Theme, type UiFont } from '../lib/settings/settings'
  import { applyAppearance } from '../lib/settings/appearance.svelte'
  import { track } from '../lib/analytics/analytics'
  import { authState } from '../lib/auth/authState.svelte'
  import {
    listSkills, addSkill, removeSkill, toggleSkill,
    SKILLS_CAP, SKILL_CONTENT_CAP, type ReviewerSkill,
  } from '../lib/skills/skills'

  let { onclose }: { onclose: () => void } = $props()
  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let deepseek = $state(current.deepseekKey ?? '')
  let error = $state<string | null>(null)
  let theme = $state<Theme>(current.theme)
  let uiFont = $state<UiFont>(current.uiFont)

  // ---- Reviewer skills state ----
  let skills = $state<ReviewerSkill[]>(listSkills())
  let addSkillOpen = $state(false)
  let newSkillName = $state('')
  let newSkillContent = $state('')
  let skillError = $state<string | null>(null)

  function refreshSkills() {
    skills = listSkills()
  }

  function handleToggleSkill(id: string) {
    toggleSkill(id)
    refreshSkills()
  }

  function handleRemoveSkill(id: string) {
    removeSkill(id)
    refreshSkills()
  }

  function handleSaveSkill() {
    skillError = null
    try {
      addSkill(newSkillName, newSkillContent)
      newSkillName = ''
      newSkillContent = ''
      addSkillOpen = false
      refreshSkills()
    } catch (e) {
      skillError = (e as Error).message
    }
  }

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

  <!-- Reviewer skills section -->
  <section aria-label="Reviewer skills" class="skills-section">
    <p class="section-label">Reviewer skills</p>

    {#if skills.length > 0}
      <ul class="skill-list">
        {#each skills as skill (skill.id)}
          <li class="skill-item">
            <label class="skill-toggle-label">
              <input
                type="checkbox"
                checked={skill.enabled}
                onchange={() => handleToggleSkill(skill.id)}
              />
              <span class="skill-name">{skill.name}</span>
            </label>
            <button
              class="skill-delete-btn"
              onclick={() => handleRemoveSkill(skill.id)}
              aria-label="Delete {skill.name}"
            >Delete</button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if !addSkillOpen}
      <button
        class="add-skill-btn"
        onclick={() => { addSkillOpen = true; skillError = null }}
        disabled={skills.length >= SKILLS_CAP}
      >Add skill</button>
    {:else}
      <div class="add-skill-form">
        <label>
          Skill name
          <input
            type="text"
            bind:value={newSkillName}
            placeholder="Skill name"
          />
        </label>
        <label>
          Persona (paste markdown checklist or guidelines)
          <textarea
            bind:value={newSkillContent}
            placeholder="Paste your reviewer checklist or persona guidelines here…"
            rows={6}
          ></textarea>
        </label>
        {#if skillError}
          <p role="alert" class="skill-error">{skillError}</p>
        {/if}
        <div class="add-skill-actions">
          <button onclick={handleSaveSkill}>Save skill</button>
          <button onclick={() => { addSkillOpen = false; skillError = null }}>Cancel</button>
        </div>
      </div>
    {/if}
  </section>
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

  /* ---- Reviewer skills ---- */
  .skills-section {
    margin-top: 1.25rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 1rem;
  }

  .skill-list {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .skill-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9em;
  }

  .skill-toggle-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    cursor: pointer;
  }

  .skill-name {
    flex: 1;
  }

  .skill-delete-btn {
    font-size: 0.8em;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }

  .skill-delete-btn:hover {
    opacity: 1;
    background: var(--legend-removed-bg);
    border-color: var(--legend-removed-border);
    color: var(--legend-removed-color);
  }

  .add-skill-btn {
    font-size: 0.9em;
    padding: 0.3rem 0.75rem;
    border: 1px dashed var(--border-subtle);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .add-skill-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .add-skill-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .add-skill-form label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.9em;
  }

  .add-skill-form textarea {
    font-family: var(--font-mono);
    font-size: 0.8em;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.4rem;
    resize: vertical;
    background: var(--surface);
    color: var(--text);
  }

  .skill-error {
    color: var(--legend-removed-color);
    font-size: 0.88em;
    background: var(--legend-removed-bg);
    border: 1px solid var(--legend-removed-border);
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
    margin: 0;
  }

  .add-skill-actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
