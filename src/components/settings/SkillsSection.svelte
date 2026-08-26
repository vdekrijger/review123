<script lang="ts">
  import {
    listSkills, addSkill, updateSkill, removeSkill, toggleSkill,
    SKILLS_CAP, SKILL_CONTENT_CAP, type ReviewerSkill,
  } from '../../lib/skills/skills'
  import { BUILTIN_SKILLS } from '../../lib/skills/builtinSkills'
  import {
    listAllCalibration, clearCalibration, removeCalibrationEntry,
    type CalibrationEntry,
  } from '../../lib/skills/calibration'
  import { mineSkillPipeline } from '../../lib/skills/mineSkill'
  import { llmJsonWithRepair } from '../../lib/llm/llm'
  import { githubProvider } from '../../lib/provider/github'
  import { gitlabProvider } from '../../lib/provider/gitlab'
  import { PROVIDER_KEY_FIELDS } from '../../lib/llm/config'
  import { getProvider } from '../../lib/llm/providers'
  import { settingsState } from '../../lib/settings/settingsState.svelte'
  import { setAutoRunReviewers } from '../../lib/settings/settings'
  import Spinner from '../Spinner.svelte'
  import AiProgress from '../AiProgress.svelte'

  // Auto-start reviewers (opt-out, default ON) — reactive via settingsState so
  // the checkbox reflects the live setting and the toggle persists immediately.
  const autoRunReviewers = $derived(settingsState.current.autoRunReviewers)

  // ---- Reviewer skills state ----
  let skills = $state<ReviewerSkill[]>(listSkills())
  let addSkillOpen = $state(false)
  let newSkillName = $state('')
  let newSkillContent = $state('')
  let skillError = $state<string | null>(null)

  // ---- Inline edit state (per-skill editing) ----
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
  // Providers that implement getMyAccountReviewComments (in preferred display order).
  // Bitbucket is honestly absent — it has no account-scoped mining yet.
  const MINE_CAPABLE_PROVIDERS = [githubProvider, gitlabProvider] as const

  // Default provider selection: first configured mining provider, or 'github' fallback
  let mineProvider = $state<'github' | 'gitlab'>(
    (MINE_CAPABLE_PROVIDERS.find(p => p.authState().configured)?.id ?? 'github') as 'github' | 'gitlab'
  )

  // Optional repo filter — empty by default: mining runs account-wide across repos.
  let mineOwner = $state('')
  let mineRepo = $state('')
  let mineRunning = $state(false)
  let mineError = $state<string | null>(null)
  let minedSkillDraft = $state<{ name: string; content: string } | null>(null)

  function handleMineProviderChange(providerId: 'github' | 'gitlab') {
    mineProvider = providerId
    mineError = null
  }

  // Mining gates on the ACTIVE AI provider's key (Plan F), not deepseekKey.
  // Derived from the reactive settingsState facade — NOT from getSettings()
  // (plain localStorage read, no reactive deps) — so switching the provider
  // or saving a key in the AI models section above updates the gate and the
  // provider name live instead of staying frozen at the mount-time value
  // (which defaulted to DeepSeek).
  const hasAiKey = $derived(
    !!settingsState.current[PROVIDER_KEY_FIELDS[settingsState.current.aiProvider]],
  )
  const aiProviderName = $derived(
    getProvider(settingsState.current.aiProvider)?.displayName ?? 'your AI provider',
  )
  // For gating: whether the currently selected mine provider has auth configured
  const hasMineProviderAuth = $derived(
    MINE_CAPABLE_PROVIDERS.find(p => p.id === mineProvider)?.authState().configured ?? false
  )
  // The repo filter is optional, but a half-filled filter is ambiguous → block.
  const mineFilterIncomplete = $derived(
    (mineOwner.trim() !== '') !== (mineRepo.trim() !== '')
  )

  async function handleMineComments() {
    if (!hasMineProviderAuth || !hasAiKey || mineFilterIncomplete) return
    mineRunning = true
    mineError = null
    minedSkillDraft = null
    try {
      const owner = mineOwner.trim()
      const repo = mineRepo.trim()
      const repoFilter = owner && repo ? { owner, repo } : null
      const result = await mineSkillPipeline(
        mineProvider,
        repoFilter,
        { llmJsonWithRepair },
      )
      if (result.ok) {
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

  // ---- Dismissal-calibration ledger (per-skill visibility surface) ----
  // What the user's reasoned Dismiss clicks have taught each reviewer. Local
  // snapshot refreshed after every mutation (localStorage is not reactive).
  let calibration = $state<Record<string, CalibrationEntry[]>>(listAllCalibration())
  let calibrationOpenId = $state<string | null>(null)

  function refreshCalibration() {
    calibration = listAllCalibration()
  }

  function calibrationEntries(skillId: string): CalibrationEntry[] {
    return calibration[skillId] ?? []
  }

  function handleClearCalibration(skillId: string) {
    clearCalibration(skillId)
    if (calibrationOpenId === skillId) calibrationOpenId = null
    refreshCalibration()
  }

  function handleRemoveCalibrationEntry(skillId: string, digest: string) {
    removeCalibrationEntry(skillId, digest)
    refreshCalibration()
  }

  // Set of installed skill names for O(1) lookup
  const installedSkillNames = $derived(new Set(skills.map(s => s.name)))

  function handleAddBuiltinSkill(name: string, content: string) {
    addSkill(name, content)
    refreshSkills()
  }

  function handleToggleSkill(id: string) {
    toggleSkill(id)
    refreshSkills()
  }

  function handleRemoveSkill(id: string) {
    if (editingId === id) editingId = null
    removeSkill(id)
    // A deleted skill's calibration ledger would be orphaned (re-adding — even
    // the same builtin — mints a NEW id via djb2(name + addedAt)), so clear it.
    handleClearCalibration(id)
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
</script>

<section id="skills" aria-label="Reviewer skills" class="skills-section">
  <p class="section-label">Reviewer skills</p>

  <label class="auto-run-label">
    <input
      type="checkbox"
      name="autoRunReviewers"
      checked={autoRunReviewers}
      onchange={(e) => setAutoRunReviewers((e.currentTarget as HTMLInputElement).checked)}
    />
    <span>Start reviewers automatically</span>
  </label>
  <p class="hint auto-run-hint">Runs your reviewers as soon as a PR loads — while you're still on Understand — so findings are ready by the Inspect step. Failed reviewers retry automatically.</p>

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

          {#if calibrationEntries(skill.id).length > 0}
            {@const entries = calibrationEntries(skill.id)}
            <!-- Dismissal-calibration surface: what reasoned Dismiss clicks
                 have taught this reviewer. Quiet one-liner; view discloses
                 the entries with per-entry delete. -->
            <div class="calibration-line" data-testid="calibration-line">
              <span class="calibration-count">{entries.length} calibration entr{entries.length === 1 ? 'y' : 'ies'}</span>
              <button
                type="button"
                class="calibration-action"
                aria-expanded={calibrationOpenId === skill.id}
                aria-label="View calibration entries for {skill.name}"
                onclick={() => (calibrationOpenId = calibrationOpenId === skill.id ? null : skill.id)}
              >view</button>
              <button
                type="button"
                class="calibration-action"
                aria-label="Clear calibration entries for {skill.name}"
                onclick={() => handleClearCalibration(skill.id)}
              >clear</button>
            </div>
            {#if calibrationOpenId === skill.id}
              <ul class="calibration-list" aria-label="Calibration entries for {skill.name}">
                {#each entries as entry (entry.findingDigest)}
                  <li class="calibration-entry">
                    <span class="calibration-reason">{entry.reason === 'not-real' ? 'not real' : 'not worth flagging'}</span>
                    <span class="calibration-pattern">{entry.pattern}</span>
                    <button
                      type="button"
                      class="calibration-delete"
                      aria-label="Delete calibration entry"
                      onclick={() => handleRemoveCalibrationEntry(skill.id, entry.findingDigest)}
                    >✕</button>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Built-in reviewers library -->
  <div class="builtin-section">
    <p class="section-label builtin-label">Built-in reviewers</p>
    <ul class="builtin-list">
      {#each BUILTIN_SKILLS as builtin (builtin.id)}
        <li class="builtin-entry" data-builtin-id={builtin.id}>
          <div class="builtin-info">
            <span class="builtin-name">{builtin.name}</span>
            <span class="builtin-tagline">{builtin.tagline}</span>
          </div>
          {#if !installedSkillNames.has(builtin.name)}
            <button
              class="builtin-add-btn"
              onclick={() => handleAddBuiltinSkill(builtin.name, builtin.content)}
              disabled={skills.length >= SKILLS_CAP}
              aria-label="Add {builtin.name}"
              title={skills.length >= SKILLS_CAP ? `Cannot add more than ${SKILLS_CAP} reviewer skills` : undefined}
            >Add</button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>

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
        <button class="btn btn-primary" onclick={handleSaveSkill}>Save skill</button>
        <button class="btn" onclick={() => { addSkillOpen = false; skillError = null; minedSkillDraft = null }}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Mine-my-reviews section -->
  <div class="mine-section">
    <p class="section-label mine-label">Generate from my reviews</p>
    <p class="hint mine-hint">Analyzes your recent review comments across your repositories to build a personalized reviewer persona.</p>

    {#if !hasAiKey}
      <p class="mine-gate-hint">Add an API key for {aiProviderName} (see AI models above) to use this feature.</p>
    {:else}
      <!-- Provider select -->
      <div class="mine-provider-row">
        <label class="mine-provider-label" for="mine-provider-select">Provider</label>
        <select
          id="mine-provider-select"
          class="mine-provider-select"
          value={mineProvider}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value
            if (v === 'github' || v === 'gitlab') handleMineProviderChange(v)
          }}
        >
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
          <option value="bitbucket" disabled>Bitbucket (not available yet)</option>
        </select>
      </div>

      {#if !hasMineProviderAuth}
        {#if mineProvider === 'github'}
          <p class="mine-gate-hint">Sign in with GitHub from the top bar to use this feature.</p>
        {:else if mineProvider === 'gitlab'}
          <p class="mine-gate-hint">Add a GitLab token or sign in via OAuth (in Advanced above) to use this feature.</p>
        {/if}
      {:else}
        <p class="hint mine-filter-hint">Optional: limit to a single repository.</p>
        <div class="mine-repo-row">
          <input
            type="text"
            class="mine-repo-input"
            bind:value={mineOwner}
            placeholder="owner (optional)"
            aria-label="Repository owner (optional filter)"
          />
          <span class="mine-repo-sep">/</span>
          <input
            type="text"
            class="mine-repo-input"
            bind:value={mineRepo}
            placeholder="repo (optional)"
            aria-label="Repository name (optional filter)"
          />
          <button
            class="mine-btn"
            onclick={handleMineComments}
            disabled={mineRunning || mineFilterIncomplete || skills.length >= SKILLS_CAP}
            aria-busy={mineRunning}
            title={mineFilterIncomplete ? 'Fill both owner and repo to filter, or leave both empty to mine your whole account' : undefined}
          >
            {#if mineRunning}
              <Spinner size="0.8em" />Analyzing…
            {:else}
              Analyze my comments
            {/if}
          </button>
        </div>
        {#if mineRunning}
          <!-- Unified AI progress: honest status line for the mining task. -->
          <AiProgress task="mining" state={{ status: 'loading' }} skeleton={false} />
        {/if}
        {#if mineError}
          <p role="alert" class="skill-error">{mineError}</p>
        {/if}
        <p class="hint mine-privacy-note">Your comments are sent to {aiProviderName} for analysis.</p>
      {/if}
    {/if}
  </div>
</section>

<style>
  /* Bounded section card — skills persist on toggle/add, no Save button. */
  .skills-section {
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

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.5rem 0;
  }

  .auto-run-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9em;
    cursor: pointer;
    margin-bottom: 0.15rem;
  }

  .auto-run-hint {
    margin-top: 0;
    margin-bottom: 0.75rem;
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

  .mine-filter-hint {
    margin: 0.2rem 0 0.3rem;
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

  .mine-privacy-note {
    margin-top: 0.3rem;
    font-size: 0.75em;
    color: var(--text-muted);
  }

  .mine-provider-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .mine-provider-label {
    font-size: 0.88em;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* Chrome comes from the global select primitive in app.css. */
  .mine-provider-select {
    font-size: 0.88em;
    padding-block: 0.2rem;
    padding-left: 0.4rem;
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

  /* ---- Built-in reviewers library ---- */
  .builtin-section {
    margin-bottom: 0.75rem;
  }

  .builtin-label {
    margin-bottom: 0.4rem;
  }

  .builtin-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .builtin-entry {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.88em;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--hairline);
    border-radius: 5px;
    background: var(--surface-raised);
  }

  .builtin-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .builtin-name {
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .builtin-tagline {
    font-size: 0.85em;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .builtin-add-btn {
    font-size: 0.8em;
    padding: 0.15rem 0.55rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .builtin-add-btn:not(:disabled):hover {
    background: var(--surface);
    border-color: var(--accent);
    color: var(--accent);
  }

  .builtin-add-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ---- Dismissal-calibration surface (quiet per-skill line + list) ---- */
  .calibration-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.1rem 0 0.1rem 1.5rem;
    font-size: 0.78em;
    color: var(--text-muted);
  }

  .calibration-action {
    border: none;
    background: transparent;
    padding: 0;
    font-size: 1em;
    color: var(--text-muted);
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }

  .calibration-action:hover,
  .calibration-action:focus-visible {
    color: var(--text);
  }

  .calibration-list {
    list-style: none;
    margin: 0.2rem 0 0.4rem 1.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--surface-raised);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .calibration-entry {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.8em;
    line-height: 1.35;
  }

  .calibration-reason {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.04em;
  }

  .calibration-pattern {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .calibration-delete {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.9em;
    line-height: 1;
    padding: 0 0.15rem;
    cursor: pointer;
    opacity: 0.7;
    flex-shrink: 0;
  }

  .calibration-delete:hover {
    opacity: 1;
    color: var(--legend-removed-color);
  }
</style>
