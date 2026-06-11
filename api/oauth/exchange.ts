/**
 * Vercel serverless function: POST /api/oauth/exchange
 *
 * Exchanges a GitHub OAuth authorization code for an access token.
 * Keeps the client secret server-side only.
 *
 * EC-02l: No logging of tokens (no console calls anywhere in this file).
 * EC-02k: GitHub error bodies are passed through with 400.
 */

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

interface Env {
  GITHUB_OAUTH_CLIENT_ID?: string
  GITHUB_OAUTH_CLIENT_SECRET?: string
}

/**
 * Pure handler — all logic lives here, testable without HTTP plumbing.
 */
export async function exchangeHandler(
  body: unknown,
  env: Env,
  fetchFn: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Missing env vars
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    return { status: 500, body: { error: 'oauth-not-configured' } }
  }

  // Validate body
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as Record<string, unknown>)['code'] !== 'string' ||
    !(body as Record<string, unknown>)['code']
  ) {
    return { status: 400, body: { error: 'missing-code' } }
  }

  const { code, code_verifier } = body as Record<string, unknown>

  // Exchange with GitHub
  const ghRes = await fetchFn(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      code_verifier,
    }),
  })

  const ghBody = (await ghRes.json()) as Record<string, unknown>

  // EC-02k: GitHub returned an error
  if (ghBody['error']) {
    return { status: 400, body: { error: ghBody['error'] } }
  }

  // Success — return ONLY access_token and scope (never echo the secret)
  return {
    status: 200,
    body: {
      access_token: ghBody['access_token'],
      scope: ghBody['scope'] ?? '',
    },
  }
}

/**
 * Vercel Node.js serverless function entrypoint.
 */
export default async function handler(req: any, res: any): Promise<void> {
  // Same-origin guard (CSRF hardening)
  const originHeader: string | undefined = req.headers['origin']
  const hostHeader: string | undefined = req.headers['host']
  if (originHeader) {
    let originHost: string
    try {
      originHost = new URL(originHeader).host
    } catch {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (originHost !== hostHeader) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
  }

  // process.env is available in Vercel Node runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeEnv: Record<string, string | undefined> = (globalThis as any).process?.env ?? {}
  const env: Env = {
    GITHUB_OAUTH_CLIENT_ID: nodeEnv['GITHUB_OAUTH_CLIENT_ID'],
    GITHUB_OAUTH_CLIENT_SECRET: nodeEnv['GITHUB_OAUTH_CLIENT_SECRET'],
  }

  const result = await exchangeHandler(req.body, env, fetch)
  res.status(result.status).json(result.body)
}
