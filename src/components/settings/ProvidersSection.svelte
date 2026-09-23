<script lang="ts">
  import { getSettings, saveTokens, setGitlabToken, setGitlabHost, saveBitbucketAuth } from '../../lib/settings/settings'
  import { settingsState } from '../../lib/settings/settingsState.svelte'
  import { track } from '../../lib/analytics/analytics'
  import { authState } from '../../lib/auth/authState.svelte'
  import { signOut } from '../../lib/auth/auth'
  import { signOutGitlab } from '../../lib/auth/gitlabAuth'
  import { beginOAuth } from '../../lib/auth/oauthFlow'
  import GitHubSignInButton from '../GitHubSignInButton.svelte'
  import GitLabSignInButton from '../GitLabSignInButton.svelte'
  import SecretInput from './SecretInput.svelte'

  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let gitlabTokenInput = $state(current.gitlabToken ?? '')
  let gitlabHostInput = $state(current.gitlabHost)
  let bitbucketEmail = $state(current.bitbucketAuth?.email ?? '')
  let bitbucketToken = $state(current.bitbucketAuth?.token ?? '')
  let error = $state<string | null>(null)

  // ---- Dirty tracking ----
  // The section is dirty when any field differs from the stored settings.
  // Compared against the reactive settingsState facade so the flag resets
  // automatically after a save (settings.ts notifies the facade on write).
  const dirty = $derived.by(() => {
    const s = settingsState.current
    return (
      pat.trim() !== (s.githubPat ?? '') ||
      gitlabTokenInput.trim() !== (s.gitlabToken ?? '') ||
      (gitlabHostInput.trim() || 'gitlab.com') !== s.gitlabHost ||
      bitbucketEmail.trim() !== (s.bitbucketAuth?.email ?? '') ||
      bitbucketToken.trim() !== (s.bitbucketAuth?.token ?? '')
    )
  })

  // ---- Transient "Saved ✓" confirmation ----
  let savedVisible = $state(false)
  let savedTimer: ReturnType<typeof setTimeout> | undefined
  function showSaved() {
    savedVisible = true
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      savedVisible = false
    }, 2000)
  }

  // GitHub OAuth connected → compact chip; otherwise a plain status line.
  const githubOauthConnected = $derived(authState.auth?.method === 'oauth')
  const authStatusLine = $derived(authState.auth?.method === 'pat' ? 'Using PAT' : 'Not signed in')

  // Advanced disclosure is open by default only when PAT is the active auth method,
  // so existing PAT users aren't confused by a closed section hiding their token.
  // Owned as $state + bind:open (NOT a $derived one-way attribute): a plain
  // open={...} attribute is re-applied by the fragment's grouped template
  // effect on ANY state change — typing in a field would snap the panel shut.
  // svelte-ignore state_referenced_locally
  let advancedOpen = $state(authState.auth?.method === 'pat')

  // OAuth client ID presence gates each provider's sign-in button.
  const githubClientId =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITHUB_CLIENT_ID) || ''
  const gitlabClientId =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITLAB_CLIENT_ID) || ''

  // GitLab OAuth session state — reactive via the settingsState facade, and
  // fully independent of the GitHub session (authState).
  const gitlabOauthConnected = $derived.by(() => {
    const oauth = settingsState.current.gitlabOAuth
    return !!oauth && Date.now() < oauth.expiresAt
  })

  const gitlabStatusLine = $derived(
    settingsState.current.gitlabToken ? 'GitLab: using PAT' : 'GitLab: not configured',
  )

  // Sign-in goes through the shared beginOAuth helper (same as the navbar and
  // the verdict step): it clears stale pending sessions from earlier abandoned
  // attempts and stores returnTo (= /settings) so AuthCallback navigates back.
  async function handleGithubSignIn() {
    try {
      location.assign(await beginOAuth('github'))
    } catch (e) {
      error = (e as Error).message
    }
  }

  function handleGithubSignOut() {
    signOut()
  }

  async function handleGitlabSignIn() {
    try {
      location.assign(await beginOAuth('gitlab'))
    } catch (e) {
      error = (e as Error).message
    }
  }

  function handleGitlabSignOut() {
    signOutGitlab()
  }

  export function save() {
    try {
      const before = getSettings()
      const hadPat = !!before.githubPat
      const hadGitlab = !!before.gitlabToken
      const hadBitbucket = !!before.bitbucketAuth

      // Belt-and-braces: when signed in via OAuth and PAT field is empty,
      // omit githubPat from the patch so saveTokens does not clear githubAuth.
      const patTrimmed = pat.trim()
      const isOauth = authState.auth?.method === 'oauth'
      const tokensPatch: { githubPat?: string | null; deepseekKey?: string | null } = {}
      if (patTrimmed !== '' || !isOauth) {
        tokensPatch.githubPat = patTrimmed === '' ? null : pat
      }
      saveTokens(tokensPatch)

      setGitlabToken(gitlabTokenInput.trim() === '' ? null : gitlabTokenInput)
      const hostTrimmed = gitlabHostInput.trim()
      setGitlabHost(hostTrimmed === '' ? 'gitlab.com' : hostTrimmed)
      const emailTrimmed = bitbucketEmail.trim()
      const tokenTrimmed = bitbucketToken.trim()
      if (emailTrimmed === '' && tokenTrimmed === '') {
        saveBitbucketAuth(null)
      } else {
        // throws if one is empty — caught below and shown as error
        saveBitbucketAuth({ email: emailTrimmed, token: tokenTrimmed })
      }
      if (!hadPat && patTrimmed) track('settings_key_added', { service: 'github' })
      if (!hadGitlab && gitlabTokenInput.trim()) track('settings_key_added', { service: 'gitlab' })
      if (!hadBitbucket && emailTrimmed && tokenTrimmed) track('settings_key_added', { service: 'bitbucket' })
      error = null
      // Sync local fields from the stored (trimmed/normalized) values so the
      // section reads clean immediately — e.g. a host entered as an origin URL
      // is shown as the normalized hostname that was actually saved.
      const saved = getSettings()
      pat = saved.githubPat ?? ''
      gitlabTokenInput = saved.gitlabToken ?? ''
      gitlabHostInput = saved.gitlabHost
      bitbucketEmail = saved.bitbucketAuth?.email ?? ''
      bitbucketToken = saved.bitbucketAuth?.token ?? ''
      showSaved()
      return true
    } catch (e) {
      error = (e as Error).message
      return false
    }
  }
</script>

<section id="providers" aria-label="Providers and access">
  <h2 class="section-label">Providers &amp; access</h2>

  {#if githubOauthConnected}
    <div class="connected-chip">
      <span class="chip-check" aria-hidden="true">✓</span>
      <span class="chip-text">GitHub · connected</span>
      <button
        class="chip-signout"
        aria-label="Sign out of GitHub"
        title="Sign out of GitHub"
        onclick={handleGithubSignOut}
      >✕</button>
    </div>
  {:else}
    <p class="auth-status">{authStatusLine}</p>
    {#if !authState.auth && githubClientId}
      <div class="oauth-row">
        <GitHubSignInButton onclick={handleGithubSignIn} />
      </div>
    {/if}
  {/if}

  {#if gitlabOauthConnected}
    <div class="connected-chip">
      <span class="chip-check" aria-hidden="true">✓</span>
      <span class="chip-text">GitLab · connected</span>
      <button
        class="chip-signout"
        aria-label="Sign out of GitLab"
        title="Sign out of GitLab"
        onclick={handleGitlabSignOut}
      >✕</button>
    </div>
  {:else}
    <p class="auth-status gitlab-status">{gitlabStatusLine}</p>
    {#if gitlabClientId}
      <div class="oauth-row">
        <GitLabSignInButton onclick={handleGitlabSignIn} />
      </div>
      <p class="hint">Sign in with GitLab OAuth (recommended). Tokens are refreshed automatically. For self-hosted instances, set the GitLab host under Advanced first.</p>
    {/if}
  {/if}

  <details bind:open={advancedOpen}>
    <summary>Advanced: use a personal access token instead</summary>
    <label class="field"><span class="field-label">GitHub token (PAT)</span>
      <SecretInput bind:value={pat} placeholder="github_pat_… (fine-grained, repo-scoped recommended)" />
    </label>
    <div class="hint pat-scope-hint">
      <p><strong>Fine-grained token</strong> (recommended): grant access to the repositories you review, with
        <em>Pull requests: Read &amp; write</em>, <em>Contents: Read</em>, and <em>Checks: Read</em>.</p>
      <p><strong>Classic token:</strong> the <code>public_repo</code> scope (or <code>repo</code> for private
        repositories). In a SAML/SSO organization, click <em>Configure SSO → Authorize</em> on the token afterwards.</p>
    </div>
    <label class="field"><span class="field-label">GitLab host</span>
      <input type="text" bind:value={gitlabHostInput} autocomplete="off" placeholder="gitlab.com" aria-label="GitLab host" />
    </label>
    <div class="hint pat-scope-hint">
      <p>Self-hosted instances supported. Enter a hostname (e.g. <code>gitlab.mycompany.com</code>). Leave as <code>gitlab.com</code> for the default.</p>
    </div>
    <label class="field"><span class="field-label">GitLab token (PAT)</span>
      <SecretInput bind:value={gitlabTokenInput} placeholder="glpat_… (scope: api)" ariaLabel="GitLab personal access token" />
    </label>
    <div class="hint pat-scope-hint">
      <p>Alternative: personal access token. Required scope: <code>api</code>. Create one at <em>GitLab → User Settings → Access Tokens</em>.</p>
    </div>
    <label class="field"><span class="field-label">Bitbucket email</span>
      <input type="password" bind:value={bitbucketEmail} autocomplete="off" placeholder="your@email.com" aria-label="Bitbucket email address" />
    </label>
    <label class="field"><span class="field-label">Bitbucket API token</span>
      <SecretInput bind:value={bitbucketToken} placeholder="App password / API token" ariaLabel="Bitbucket API token" />
    </label>
    <div class="hint pat-scope-hint">
      <p>Required: Bitbucket email address and an API token with <em>Pull requests: Write</em> scope. Create at <em>Bitbucket → Personal settings → App passwords</em>.</p>
    </div>
  </details>

  <p class="hint">Keys are stored only in this browser (localStorage) and sent only to their own services.</p>
  {#if error}<p role="alert">{error}</p>{/if}

  <div class="save-row">
    <button class="btn btn-primary" onclick={save} disabled={!dirty}>Save</button>
    {#if dirty}<span class="dirty-hint">Unsaved changes</span>{/if}
    <span class="saved-note" class:visible={savedVisible} aria-live="polite">{savedVisible ? 'Saved ✓' : ''}</span>
  </div>
</section>

<style>
  /* Bounded section card: the Save button at the bottom visibly belongs to
     THIS section's fields — never floating between sections. */
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
    font-size: 0.9em;
    font-weight: 600;
    letter-spacing: normal;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  /* margin-top: 0 is load-bearing (rubric D2, p.85). As a <p> this carried the
     UA 1em top margin, which collapsed with the heading's 0.4rem bottom margin
     to 13.5px — against 15px above the heading. The section title was floating
     between its section and its content instead of attaching to the content it
     introduces. Now 15px above / 6px below. */
  .auth-status {
    font-size: 0.9em;
    color: var(--text-muted);
    margin-top: 0;
    margin-bottom: 0.75rem;
  }

  /* Compact connected chip: status + sign-out merged into one row */
  .connected-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    padding: 0.2rem 0.3rem 0.2rem 0.65rem;
    margin: 0 0.5rem 0.6rem 0;
    font-size: 0.88em;
    background: var(--surface-raised);
    color: var(--text);
  }

  /* F18. 400: the check is a GREEN glyph — a hue no other text on the page
     carries, which is emphasis enough on its own (p.48-49 warns the other way
     round: don't let a mark outrank the label beside it). */
  .chip-check {
    color: var(--ok, #1a7f37);
    font-weight: 400;
  }

  .chip-signout {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.35rem;
    height: 1.35rem;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9em;
    line-height: 1;
    padding: 0;
  }

  .chip-signout:hover {
    background: var(--hairline);
    color: var(--text);
  }

  .oauth-row {
    margin: 0.25rem 0 0.75rem;
  }

  details {
    margin: 0.5rem 0;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    overflow: hidden;
  }

  details summary {
    text-transform: none;
    letter-spacing: normal;
    font-size: 0.9em;
    color: var(--text-muted);
  }

  /* Stacked-field rhythm (audit F12, p.84). The .field primitive owns what is
     INSIDE a field (label→control, 0.25rem); this owns what is between them.
     Before: every label carried a flat 0.5rem block margin and the control
     opened its own line, so label→control measured 0px while field→field was
     whatever the interleaved hint happened to add. Now the hint is attached to
     the field it explains (0.25rem above it, the same step as label→control)
     and the 1rem below it is the gap to the NEXT field — so the three pieces of
     one field group tighter than the groups do. */
  details .field {
    /* Inline only. A `margin: 0 0.75rem` shorthand here would out-specify the
       primitive's `.field + .field { margin-top: 1rem }` and silently flatten
       two ADJACENT fields (Bitbucket email / API token) back to 0 — which is
       the very defect this item exists to fix. */
    margin-inline: 0.75rem;
  }

  details .field:first-of-type {
    margin-top: 0.75rem;
  }

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.5rem 0;
  }

  .pat-scope-hint {
    margin: 0.25rem 0.75rem 1rem;
    line-height: 1.4;
  }

  .pat-scope-hint p {
    margin: 0 0 0.5rem;
  }

  .pat-scope-hint p:last-child {
    margin-bottom: 0;
  }

  /* The save row is separated from the fields by a hairline but stays inside
     the section card, so its scope is unambiguous. */
  .save-row {
    margin-top: 1rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--hairline);
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }

  .dirty-hint {
    font-size: 0.85em;
    font-style: italic;
    color: var(--text-muted);
  }

  .saved-note {
    font-size: 0.85em;
    color: var(--ok, #1a7f37);
    opacity: 0;
    transition: opacity 0.35s ease;
  }

  .saved-note.visible {
    opacity: 1;
  }
</style>
