/**
 * sessionStorage keys shared by the OAuth flows.
 *
 * Kept in a leaf module (no imports) so flow modules (auth.ts, gitlabAuth.ts,
 * oauthFlow.ts) and tests can all reference the same constants without
 * circular imports — and so mocking one flow module never hides the keys.
 */

/** GitHub PKCE session: { state, verifier, scope } */
export const GITHUB_OAUTH_SESSION_KEY = 'review123:oauth'

/** GitLab PKCE session: { state, verifier, provider: 'gitlab' } */
export const GITLAB_OAUTH_SESSION_KEY = 'review123:gitlab-oauth'

/** Path to navigate back to after the callback completes. */
export const OAUTH_RETURN_KEY = 'review123:returnTo'
