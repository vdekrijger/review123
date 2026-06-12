<script lang="ts">
  import {
    listSkills, addSkill, updateSkill, removeSkill, toggleSkill,
    SKILLS_CAP, SKILL_CONTENT_CAP, type ReviewerSkill,
  } from '../../lib/skills/skills'
  import { BUILTIN_SKILLS } from '../../lib/skills/builtinSkills'
  import { mineSkillPipeline } from '../../lib/skills/mineSkill'
  import { llmJsonWithRepair } from '../../lib/llm/llm'
  import { githubProvider } from '../../lib/provider/github'
  import { gitlabProvider } from '../../lib/provider/gitlab'
  import { getHistory } from '../../lib/history/history'
  import { activeLlmConfig, activeProviderHasKey } from '../../lib/llm/config'

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
  // Providers that implement getMyReviewComments (in preferred display order)
  const MINE_CAPABLE_PROVIDERS = [githubProvider, gitlabProvider] as const

  // Default provider selection: first configured mining provider, or 'github' fallback
  let mineProvider = $state<'github' | 'gitlab'>(
    (MINE_CAPABLE_PROVIDERS.find(p => p.authState().configured)?.id ?? 'github') as 'github' | 'gitlab'
  )

  // Prefill repo from most recent history entry matching the selected provider
  const historyEntries = getHistory()
  function defaultMineRepo(providerId: 'github' | 'gitlab'): { owner: string; repo: string } {
    const match = historyEntries.find(e => e.provider === providerId)
    if (match) return { owner: match.owner, repo: match.repo }
    // Fallback to first entry regardless of provider
    return { owner: historyEntries[0]?.owner ?? '', repo: historyEntries[0]?.repo ?? '' }
  }

  let mineOwner = $state(defaultMineRepo(mineProvider).owner)
  let mineRepo = $state(defaultMineRepo(mineProvider).repo)
  let mineRunning = $state(false)
  let mineError = $state<string | null>(null)
  let minedSkillDraft = $state<{ name: string; content: string } | null>(null)

  // When provider selection changes, update repo prefill
  function handleMineProviderChange(providerId: 'github' | 'gitlab') {
    mineProvider = providerId
    const defaults = defaultMineRepo(providerId)
    mineOwner = defaults.owner
    mineRepo = defaults.repo
    mineError = null
  }

  // Mining gates on the ACTIVE AI provider's key (Plan F), not deepseekKey
  const hasAiKey = $derived(activeProviderHasKey())
  const aiProviderName = $derived(activeLlmConfig().provider.displayName)
  // For gating: whether the currently selected mine provider has auth configured
  const hasMineProviderAuth = $derived(
    MINE_CAPABLE_PROVIDERS.find(p => p.id === mineProvider)?.authState().configured ?? false
  )

  async function handleMineComments() {
    if (!hasMineProviderAuth || !hasAiKey) return
    mineRunning = true
    mineError = null
    minedSkillDraft = null
    try {
      const result = await mineSkillPipeline(
        mineProvider,
        { owner: mineOwner.trim(), repo: mineRepo.trim() },
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
        <button onclick={handleSaveSkill}>Save skill</button>
        <button onclick={() => { addSkillOpen = false; skillError = null; minedSkillDraft = null }}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Mine-my-reviews section -->
  <div class="mine-section">
    <p class="section-label mine-label">Generate from my reviews</p>
    <p class="hint mine-hint">Analyzes your past review comments to build a personalized reviewer persona.</p>

    {#if !hasAiKey}
      <p class="mine-gate-hint">Add a {aiProviderName} API key (above) to use this feature.</p>
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
        <p class="hint mine-privacy-note">Your comments are sent to {aiProviderName} for analysis.</p>
      {/if}
    {/if}
  </div>
</section>

<style>
  .skills-section {
    margin-bottom: 2rem;
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

  .mine-provider-select {
    font-size: 0.88em;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
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
</style>
