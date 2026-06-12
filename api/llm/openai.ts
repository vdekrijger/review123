/**
 * Vercel serverless function: POST /api/llm/openai
 *
 * Minimal OpenAI proxy — required because api.openai.com does not support
 * browser CORS. The user's key is forwarded in the x-user-openai-key request
 * header and never stored, logged, or written anywhere server-side (same
 * no-log discipline as api/oauth/exchange.ts).
 *
 * Security:
 *   - Same-origin guard (CSRF hardening): origin header required and must
 *     match the effective host (reused pattern from oauth/exchange.ts).
 *   - x-user-openai-key is forwarded as Authorization: Bearer to OpenAI.
 *   - Response body is streamed verbatim when the client requests streaming.
 *   - No console/log calls anywhere in this file (EC-02l discipline).
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * Pure handler — all logic lives here, testable without HTTP plumbing.
 *
 * body: the parsed request body (already parsed by Vercel's runtime)
 * userKey: the value of the x-user-openai-key request header (never stored)
 * fetchFn: injectable for tests (defaults to global fetch)
 */
export async function openaiProxyHandler(
  body: unknown,
  userKey: string | undefined,
  fetchFn: typeof fetch,
): Promise<{ status: number; headers: Record<string, string>; bodyStream: ReadableStream | null; bodyJson?: Record<string, unknown> }> {
  if (!userKey) {
    return {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      bodyStream: null,
      bodyJson: { error: 'missing-key' },
    }
  }

  if (!body || typeof body !== 'object') {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      bodyStream: null,
      bodyJson: { error: 'invalid-body' },
    }
  }

  const upstreamRes = await fetchFn(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userKey}`,
    },
    body: JSON.stringify(body),
  })

  // Relay status + content-type; stream body verbatim (handles both streaming and non-streaming)
  const contentType = upstreamRes.headers.get('content-type') ?? 'application/json'
  return {
    status: upstreamRes.status,
    headers: { 'Content-Type': contentType },
    bodyStream: upstreamRes.body,
  }
}

/**
 * Vercel Node.js serverless function entrypoint.
 */
export default async function handler(req: any, res: any): Promise<void> {
  // Same-origin guard (CSRF hardening) — reused from oauth/exchange.ts pattern.
  const originHeader: string | undefined = req.headers['origin']
  if (!originHeader) {
    res.status(403).json({ error: 'forbidden' })
    return
  }

  const effectiveHost: string | undefined =
    req.headers['x-forwarded-host'] || req.headers['host']

  let originHost: string
  try {
    originHost = new URL(originHeader).host
  } catch {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  if (originHost !== effectiveHost) {
    res.status(403).json({ error: 'forbidden' })
    return
  }

  const userKey: string | undefined = req.headers['x-user-openai-key']

  const result = await openaiProxyHandler(req.body, userKey, fetch)

  res.status(result.status)
  for (const [k, v] of Object.entries(result.headers)) {
    res.setHeader(k, v)
  }

  if (result.bodyJson) {
    res.json(result.bodyJson)
    return
  }

  if (result.bodyStream) {
    // Stream response body verbatim
    const reader = result.bodyStream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
  }
  res.end()
}
