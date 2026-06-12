<script lang="ts">
  import { getSettings, saveTokens, setGitlabToken, setGitlabHost, saveBitbucketAuth } from '../../lib/settings/settings'
  import { track } from '../../lib/analytics/analytics'
  import { authState } from '../../lib/auth/authState.svelte'
  import { beginGitlabSignIn, signOutGitlab } from '../../lib/auth/gitlabAuth'
  import GitLabSignInButton from '../GitLabSignInButton.svelte'

  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let gitlabTokenInput = $state(current.gitlabToken ?? '')
  let gitlabHostInput = $state(current.gitlabHost)
  let bitbucketEmail = $state(current.bitbucketAuth?.email ?? '')
  let bitbucketToken = $state(current.bitbucketAuth?.token ?? '')
  let error = $state<string | null>(null)

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

  // GitLab OAuth client ID presence gates the "Sign in with GitLab" button.
  const gitlabClientId =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITLAB_CLIENT_ID) || ''

  // Reactive GitLab auth status line (re-reads settings each render tick).
  const gitlabStatusLine = $derived.by(() => {
    const s = getSettings()
    const oauth = s.gitlabOAuth
    if (oauth && Date.now() < oauth.expiresAt) {
      return 'GitLab: signed in via OAuth'
    }
    if (s.gitlabToken) {
      return 'GitLab: using PAT'
    }
    return 'GitLab: not configured'
  })

  async function handleGitlabSignIn() {
    try {
      const url = await beginGitlabSignIn()
      location.href = url
    } catch (e) {
      error = (e as Error).message
    }
  }

  function handleGitlabSignOut() {
    signOutGitlab()
  }

  export function save() {
    try {
      const hadPat = !!current.githubPat
      const hadGitlab = !!current.gitlabToken
      const hadBitbucket = !!current.bitbucketAuth

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
      return true
    } catch (e) {
      error = (e as Error).message
      return false
    }
  }
</script>

<section id="providers" aria-label="Providers and access">
  <p class="section-label">Providers &amp; access</p>

  <p class="auth-status">{authStatusLine}</p>
  <p class="auth-status gitlab-status">{gitlabStatusLine}
    {#if gitlabClientId && getSettings().gitlabOAuth}
      <button class="sign-out-link" onclick={handleGitlabSignOut}>Sign out</button>
    {/if}
  </p>

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
    <label>GitLab host
      <input type="text" bind:value={gitlabHostInput} autocomplete="off" placeholder="gitlab.com" aria-label="GitLab host" />
    </label>
    <div class="hint pat-scope-hint">
      <p>Self-hosted instances supported. Enter a hostname (e.g. <code>gitlab.mycompany.com</code>). Leave as <code>gitlab.com</code> for the default.</p>
    </div>
    {#if gitlabClientId}
      <div class="gitlab-oauth-row">
        <GitLabSignInButton onclick={handleGitlabSignIn} />
      </div>
      <div class="hint pat-scope-hint">
        <p>Sign in with GitLab OAuth (recommended). Tokens are refreshed automatically. Host setting above is used for self-hosted instances.</p>
      </div>
    {/if}
    <label>GitLab token (PAT)
      <input type="password" bind:value={gitlabTokenInput} autocomplete="off" placeholder="glpat_… (scope: api)" aria-label="GitLab personal access token" />
    </label>
    <div class="hint pat-scope-hint">
      <p>Alternative: personal access token. Required scope: <code>api</code>. Create one at <em>GitLab → User Settings → Access Tokens</em>.</p>
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

  <div class="save-row">
    <button class="btn btn-primary" onclick={save}>Save</button>
  </div>
</section>

<style>
  section {
    margin-bottom: 2rem;
  }

  .section-label {
    font-size: 0.9em;
    font-weight: 600;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .auth-status {
    font-size: 0.9em;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  .gitlab-status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: -0.5rem;
  }

  .sign-out-link {
    font-size: 0.85em;
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  .gitlab-oauth-row {
    margin: 0.5rem 0.75rem;
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

  details label {
    display: block;
    margin: 0.5rem 0.75rem;
  }

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.5rem 0;
  }

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

  .save-row {
    margin-top: 1rem;
  }
</style>
