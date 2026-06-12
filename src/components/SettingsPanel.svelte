<script lang="ts">
  import { getSettings, saveTokens, setGitlabToken, saveBitbucketAuth, setTheme, setUiFont, setShowProgress, setTestFileDisplay, setDiffWidth, type Theme, type UiFont, type TestFileDisplay, type DiffWidth } from '../lib/settings/settings'
  import { applyAppearance } from '../lib/settings/appearance.svelte'
  import { track } from '../lib/analytics/analytics'
  import { authState } from '../lib/auth/authState.svelte'
  import {
    listSkills, addSkill, updateSkill, removeSkill, toggleSkill,
    SKILLS_CAP, SKILL_CONTENT_CAP, type ReviewerSkill,
  } from '../lib/skills/skills'
  import { SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT } from '../lib/skills/sampleSkill'
  import { mineSkillPipeline } from '../lib/skills/mineSkill'
  import { llmJsonWithRepair } from '../lib/llm/llm'
  import { ghFetch } from '../lib/github/client'
  import { getHistory } from '../lib/history/history'

  let { onclose }: { onclose: () => void } = $props()

  let dialogEl = $state<HTMLDialogElement | null>(null)

  $effect(() => {
    if (!dialogEl) return
    if (!dialogEl.open) {
      dialogEl.showModal()
    }
  })
  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let deepseek = $state(current.deepseekKey ?? '')
  let gitlabTokenInput = $state(current.gitlabToken ?? '')
  let bitbucketEmail = $state(current.bitbucketAuth?.email ?? '')
  let bitbucketToken = $state(current.bitbucketAuth?.token ?? '')
  let error = $state<string | null>(null)
  let theme = $state<Theme>(current.theme)
  let uiFont = $state<UiFont>(current.uiFont)
  let showProgress = $state<boolean>(current.showProgress)
  let testFileDisplay = $state<TestFileDisplay>(current.testFileDisplay)
  let diffWidth = $state<DiffWidth>(current.diffWidth)

  // ---- Reviewer skills state ----
  let skills = $state<ReviewerSkill[]>(listSkills())
  let addSkillOpen = $state(false)
  let newSkillName = $state('')
  let newSkillContent = $state('')
  let skillError = $state<string | null>(null)

  // ---- Inline edit state (per-skill editing) ----
  // editingId is the id of the skill currently being edited (null = none)
  let editingId = $state<string | null>(null)
  let editName = $state('')
  let editContent = $state('')
  let editError = $state<string | null>(null)

  function openEdit(skill: ReviewerSkill) {
    editingId = skill.id
    editName = skill.name
    editContent = skill.content
    editError = null
  }

  function cancelEdit() {
    editingId = null
    editError = null
  }

  function handleSaveEdit() {
    if (!editingId) return
    editError = null
    try {
      updateSkill(editingId, { name: editName, content: editContent })
      editingId = null
      refreshSkills()
    } catch (e) {
      editError = (e as Error).message
    }
  }

  // ---- Mine-my-reviews state ----
  // Default repo from most recent history entry
  const historyEntries = getHistory()
  const defaultMineOwner = historyEntries[0]?.owner ?? ''
  const defaultMineRepo = historyEntries[0]?.repo ?? ''

  let mineOwner = $state(defaultMineOwner)
  let mineRepo = $state(defaultMineRepo)
  let mineRunning = $state(false)
  let mineError = $state<string | null>(null)
  // When mining completes, open the inline edit form pre-filled with the mined skill
  let minedSkillDraft = $state<{ name: string; content: string } | null>(null)

  const hasGithubAuth = $derived(!!authState.auth)
  const hasDeepseekKey = $derived(!!getSettings().deepseekKey)

  async function handleMineComments() {
    if (!hasGithubAuth || !hasDeepseekKey) return
    mineRunning = true
    mineError = null
    minedSkillDraft = null
    try {
      const result = await mineSkillPipeline(
        { owner: mineOwner.trim(), repo: mineRepo.trim() },
        {
          getToken: () => getSettings().githubAuth?.token ?? null,
          ghFetch: (path, _token) => ghFetch(path),
          llmJsonWithRepair,
        },
      )
      if (result.ok) {
        // Pre-fill the add-skill form with the mined skill for user review
        minedSkillDraft = result.skill
        newSkillName = result.skill.name
        newSkillContent = result.skill.content
        addSkillOpen = true
        skillError = null
      } else {
        mineError = result.error
      }
    } catch (e) {
      mineError = (e as Error).message
    } finally {
      mineRunning = false
    }
  }

  function refreshSkills() {
    skills = listSkills()
  }

  const hasSampleSkill = $derived(skills.some(s => s.name === SAMPLE_SKILL_NAME))

  function handleAddSampleSkill() {
    addSkill(SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT)
    refreshSkills()
  }

  function handleToggleSkill(id: string) {
    toggleSkill(id)
    refreshSkills()
  }

  function handleRemoveSkill(id: string) {
    if (editingId === id) editingId = null
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
      minedSkillDraft = null
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

  function save() {
    try {
      const hadPat = !!current.githubPat
      const hadKey = !!current.deepseekKey
      const hadGitlab = !!current.gitlabToken
      const hadBitbucket = !!current.bitbucketAuth

      // Belt-and-braces: when signed in via OAuth and PAT field is empty,
      // omit githubPat from the patch so saveTokens does not clear githubAuth.
      const patTrimmed = pat.trim()
      const isOauth = authState.auth?.method === 'oauth'
      const tokensPatch: { githubPat?: string | null; deepseekKey?: string | null } = {
        deepseekKey: deepseek.trim() === '' ? null : deepseek,
      }
      if (patTrimmed !== '' || !isOauth) {
        tokensPatch.githubPat = patTrimmed === '' ? null : pat
      }
      saveTokens(tokensPatch)

      setGitlabToken(gitlabTokenInput.trim() === '' ? null : gitlabTokenInput)
      const emailTrimmed = bitbucketEmail.trim()
      const tokenTrimmed = bitbucketToken.trim()
      if (emailTrimmed === '' && tokenTrimmed === '') {
        saveBitbucketAuth(null)
      } else {
        // throws if one is empty — caught below and shown as error
        saveBitbucketAuth({ email: emailTrimmed, token: tokenTrimmed })
      }
      if (!hadPat && patTrimmed) track('settings_key_added', { service: 'github' })
      if (!hadKey && deepseek.trim()) track('settings_key_added', { service: 'deepseek' })
      if (!hadGitlab && gitlabTokenInput.trim()) track('settings_key_added', { service: 'gitlab' })
      if (!hadBitbucket && emailTrimmed && tokenTrimmed) track('settings_key_added', { service: 'bitbucket' })
      onclose()
    } catch (e) {
      error = (e as Error).message
    }
  }
</script>

<dialog
  bind:this={dialogEl}
  aria-label="Settings"
  oncancel={(e) => { e.preventDefault(); onclose() }}
  onclick={(e) => { if (e.target === e.currentTarget) onclose() }}
>
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

    <label class="progress-toggle">
      <input
        type="checkbox"
        checked={showProgress}
        onchange={(e) => onShowProgressChange((e.currentTarget as HTMLInputElement).checked)}
        aria-label="Show review progress bar"
      />
      Show review progress bar
    </label>

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

  <p class="auth-status">{authStatusLine}</p>
  <label>DeepSeek API key
    <input type="password" bind:value={deepseek} autocomplete="off" placeholder="sk-…" />
  </label>
  <details open={advancedOpen}>
    <summary>Advanced: use a personal access token instead</summary>
    <label>GitHub token (PAT)
      <input type="password" bind:value={pat} autocomplete="off" placeholder="github_pat_… (fine-grained, repo-scoped recommended)" />
    </label>
    <div class="hint pat-scope-hint">
      <p><strong>Fine-grained token</strong> (recommended): grant access to the repositories you review, with
        <em>Pull requests: Read &amp; write</em>, <em>Contents: Read</em>, and <em>Checks: Read</em>.</p>
      <p><strong>Classic token:</strong> the <code>public_repo</code> scope (or <code>repo</code> for private
        repositories). In a SAML/SSO organization, click <em>Configure SSO → Authorize</em> on the token afterwards.</p>
    </div>
    <label>GitLab token (PAT)
      <input type="password" bind:value={gitlabTokenInput} autocomplete="off" placeholder="glpat_… (scope: api)" aria-label="GitLab personal access token" />
    </label>
    <div class="hint pat-scope-hint">
      <p>Required scope: <code>api</code>. Create one at <em>GitLab → User Settings → Access Tokens</em>.</p>
    </div>
    <label>Bitbucket email
      <input type="password" bind:value={bitbucketEmail} autocomplete="off" placeholder="your@email.com" aria-label="Bitbucket email address" />
    </label>
    <label>Bitbucket API token
      <input type="password" bind:value={bitbucketToken} autocomplete="off" placeholder="App password / API token" aria-label="Bitbucket API token" />
    </label>
    <div class="hint pat-scope-hint">
      <p>Required: Bitbucket email address and an API token with <em>Pull requests: Write</em> scope. Create at <em>Bitbucket → Personal settings → App passwords</em>.</p>
    </div>
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
          <li class="skill-item-wrapper">
            <div class="skill-item">
              <label class="skill-toggle-label">
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onchange={() => handleToggleSkill(skill.id)}
                />
                <span class="skill-name">{skill.name}</span>
              </label>
              <button
                class="skill-edit-btn"
                onclick={() => editingId === skill.id ? cancelEdit() : openEdit(skill)}
                aria-label="Edit {skill.name}"
                aria-expanded={editingId === skill.id}
              >{editingId === skill.id ? 'Cancel' : 'Edit'}</button>
              <button
                class="skill-delete-btn"
                onclick={() => handleRemoveSkill(skill.id)}
                aria-label="Delete {skill.name}"
              >Delete</button>
            </div>

            {#if editingId === skill.id}
              <div class="skill-edit-form" role="region" aria-label="Edit {skill.name}">
                <label>
                  Name
                  <input
                    type="text"
                    bind:value={editName}
                    placeholder="Skill name"
                  />
                </label>
                <label>
                  Persona
                  <textarea
                    bind:value={editContent}
                    placeholder="Reviewer persona guidelines…"
                    rows={8}
                  ></textarea>
                </label>
                {#if editError}
                  <p role="alert" class="skill-error">{editError}</p>
                {/if}
                <div class="skill-edit-actions">
                  <button class="btn btn-primary-sm" onclick={handleSaveEdit}>Save</button>
                  <button class="btn-sm" onclick={cancelEdit}>Cancel</button>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if !hasSampleSkill}
      <div class="sample-skill-row">
        <button
          class="add-skill-btn sample-skill-btn"
          onclick={handleAddSampleSkill}
          disabled={skills.length >= SKILLS_CAP}
        >Add sample reviewer</button>
        <p class="sample-skill-caption">A general best-practices persona — duplicate and edit it to make your own.</p>
      </div>
    {/if}

    {#if !addSkillOpen}
      <button
        class="add-skill-btn"
        onclick={() => { addSkillOpen = true; skillError = null; minedSkillDraft = null }}
        disabled={skills.length >= SKILLS_CAP}
      >Add skill</button>
    {:else}
      <div class="add-skill-form">
        {#if minedSkillDraft}
          <p class="mined-skill-notice">Review your generated skill below, then save or edit it.</p>
        {/if}
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
          <button onclick={() => { addSkillOpen = false; skillError = null; minedSkillDraft = null }}>Cancel</button>
        </div>
      </div>
    {/if}

    <!-- Mine-my-reviews section -->
    <div class="mine-section">
      <p class="section-label mine-label">Generate from my GitHub reviews</p>
      <p class="hint mine-hint">Analyzes your past review comments to build a personalized reviewer persona.</p>

      {#if !hasGithubAuth}
        <p class="mine-gate-hint">Sign in with GitHub (above) to use this feature.</p>
      {:else if !hasDeepseekKey}
        <p class="mine-gate-hint">Add a DeepSeek API key (above) to use this feature.</p>
      {:else}
        <div class="mine-repo-row">
          <input
            type="text"
            class="mine-repo-input"
            bind:value={mineOwner}
            placeholder="owner"
            aria-label="Repository owner"
          />
          <span class="mine-repo-sep">/</span>
          <input
            type="text"
            class="mine-repo-input"
            bind:value={mineRepo}
            placeholder="repo"
            aria-label="Repository name"
          />
          <button
            class="mine-btn"
            onclick={handleMineComments}
            disabled={mineRunning || !mineOwner.trim() || !mineRepo.trim() || skills.length >= SKILLS_CAP}
            aria-busy={mineRunning}
          >
            {#if mineRunning}
              <span class="mine-spinner" aria-hidden="true"></span>Analyzing…
            {:else}
              Analyze my comments
            {/if}
          </button>
        </div>
        {#if mineError}
          <p role="alert" class="skill-error">{mineError}</p>
        {/if}
        <p class="hint mine-privacy-note">Your comments are sent to DeepSeek for analysis.</p>
      {/if}
    </div>
  </section>
</dialog>

<style>
  /* dialog base from app.css; override only layout-specific things */
  dialog {
    max-width: 520px;
  }

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
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

  .progress-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9em;
    cursor: pointer;
    color: var(--text);
    margin-top: 0.25rem;
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

  /* PAT scope hint sits inside <details> — align its left edge with the label/input above it
     and give each paragraph comfortable vertical breathing room. */
  .pat-scope-hint {
    margin: 0.25rem 0.75rem 0.75rem;
    line-height: 1.4;
  }

  .pat-scope-hint p {
    margin: 0 0 0.5rem;
  }

  .pat-scope-hint p:last-child {
    margin-bottom: 0;
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

  .sample-skill-row {
    margin-bottom: 0.5rem;
  }

  .sample-skill-caption {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.2rem 0 0;
  }

  /* ---- Skill edit button ---- */
  .skill-item-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .skill-edit-btn {
    font-size: 0.8em;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }

  .skill-edit-btn:hover {
    opacity: 1;
    background: var(--surface-raised);
  }

  /* ---- Inline edit form ---- */
  .skill-edit-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.4rem 0 0.4rem 1.5rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--surface-raised);
  }

  .skill-edit-form label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.9em;
  }

  .skill-edit-form textarea {
    font-family: var(--font-mono);
    font-size: 0.8em;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.4rem;
    resize: vertical;
    background: var(--surface);
    color: var(--text);
  }

  .skill-edit-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-primary-sm {
    font-size: 0.82em;
    padding: 0.25rem 0.65rem;
    border-radius: 4px;
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
  }

  .btn-sm {
    font-size: 0.82em;
    padding: 0.25rem 0.65rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  /* ---- Mine-my-reviews section ---- */
  .mine-section {
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-subtle);
  }

  .mine-label {
    margin-bottom: 0.15rem;
  }

  .mine-hint {
    margin-top: 0;
    margin-bottom: 0.6rem;
  }

  .mine-gate-hint {
    font-size: 0.85em;
    color: var(--text-muted);
    margin: 0.25rem 0;
  }

  .mine-repo-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .mine-repo-input {
    font-size: 0.88em;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    width: 120px;
  }

  .mine-repo-sep {
    color: var(--text-muted);
    font-size: 1.1em;
    line-height: 1;
  }

  .mine-btn {
    font-size: 0.88em;
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .mine-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .mine-btn:not(:disabled):hover {
    background: var(--surface-raised);
  }

  .mine-spinner {
    display: inline-block;
    width: 0.8em;
    height: 0.8em;
    border: 2px solid var(--text-muted);
    border-top-color: var(--text);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .mine-privacy-note {
    margin-top: 0.3rem;
    font-size: 0.75em;
    color: var(--text-muted);
  }

  .mined-skill-notice {
    font-size: 0.85em;
    color: var(--text-muted);
    background: var(--legend-added-bg, #e6ffed);
    border: 1px solid var(--legend-added-border, #acf2bd);
    border-radius: 4px;
    padding: 0.35rem 0.6rem;
    margin: 0;
  }
</style>
