import { getSettings } from '../settings/settings'
import { LLM_CONFIG } from './config'

// ---------------------------------------------------------------------------
// LlmError
// ---------------------------------------------------------------------------

export type LlmErrorKind =
  | 'no-key'
  | 'auth'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid-output'

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message?: string,
  ) {
    super(message ?? `llm: ${kind}`)
    this.name = 'LlmError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getKey(): string {
  const key = getSettings().deepseekKey
  if (!key) throw new LlmError('no-key', 'No DeepSeek API key configured')
  return key
}

function mapFetchError(err: unknown): never {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    throw new LlmError('timeout', err.message)
  }
  throw new LlmError('network', err instanceof Error ? err.message : String(err))
}

function mapHttpStatus(status: number): never {
  if (status === 401) throw new LlmError('auth', 'Unauthorized (401)')
  if (status === 429) throw new LlmError('rate-limited', 'Rate limited (429)')
  throw new LlmError('server', `Server error (${status})`)
}

function buildHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  }
}

// ---------------------------------------------------------------------------
// llmComplete
// ---------------------------------------------------------------------------

export interface LlmCompleteOpts {
  system: string
  user: string
  json?: boolean
  signal?: AbortSignal
}

export async function llmComplete(opts: LlmCompleteOpts): Promise<string> {
  const key = getKey()

  const { system, user, json, signal } = opts
  const body: Record<string, unknown> = {
    model: LLM_CONFIG.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  if (json) body.response_format = { type: 'json_object' }

  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${LLM_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const data = (await res!.json()) as { choices?: { message?: { content?: string | null } }[] }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new LlmError('server', 'Missing choices[0].message.content in response')
  }
  return content
}

// ---------------------------------------------------------------------------
// LlmUsage — token counts from the API response (no content)
// ---------------------------------------------------------------------------

export interface LlmUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface LlmCompleteResult {
  content: string
  usage?: LlmUsage
}

// llmCompleteWithUsage: same as llmComplete but also returns token usage.
// llmComplete is kept unchanged so all other callers (llmJsonWithRepair, etc.)
// are not affected.
export async function llmCompleteWithUsage(opts: LlmCompleteOpts): Promise<LlmCompleteResult> {
  const key = getKey()
  const { system, user, json, signal } = opts
  const body: Record<string, unknown> = {
    model: LLM_CONFIG.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  if (json) body.response_format = { type: 'json_object' }
  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${LLM_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const data = (await res!.json()) as {
    choices?: { message?: { content?: string | null } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new LlmError('server', 'Missing choices[0].message.content in response')
  }

  const u = data.usage
  const usage: LlmUsage | undefined =
    u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number' && typeof u.total_tokens === 'number'
      ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens }
      : undefined

  return { content, usage }
}

// ---------------------------------------------------------------------------
// llmStream
// ---------------------------------------------------------------------------

export interface LlmStreamOpts {
  system: string
  user: string
  signal?: AbortSignal
}

export async function llmStream(
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<string> {
  const key = getKey()

  const { system, user, signal } = opts
  const body: Record<string, unknown> = {
    model: LLM_CONFIG.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: true,
  }

  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${LLM_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const body_stream = res!.body
  if (!body_stream) {
    throw new LlmError('network', 'No response body for streaming request')
  }

  // Read SSE stream
  const reader = body_stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let done_received = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete lines from buffer
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)

        const trimmed = line.trimEnd()
        // Accept both `data: ` (with space) and `data:` (without space) per SSE spec
        if (!trimmed.startsWith('data:')) continue

        const payload = trimmed.slice(5).replace(/^ /, '') // strip one optional leading space
        if (payload === '[DONE]') {
          done_received = true
          break
        }

        try {
          const event = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null } }[]
          }
          const delta = event?.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            accumulated += delta
            onDelta(delta)
          }
        } catch {
          // malformed SSE JSON — skip
        }
      }

      if (done_received) break
    }
  } catch (err) {
    if (err instanceof LlmError) throw err
    mapFetchError(err)
  } finally {
    reader.releaseLock()
  }

  if (!done_received) {
    throw new LlmError('network', 'Stream ended without [DONE] terminator')
  }

  return accumulated
}

// ---------------------------------------------------------------------------
// llmStreamWithUsage — like llmStream but also returns token usage.
// Adds stream_options:{include_usage:true} so DeepSeek emits a final SSE
// chunk with usage data (choices:[], usage:{…}) before [DONE].
// llmStream is kept unchanged.
// ---------------------------------------------------------------------------

export interface LlmStreamResult {
  content: string
  usage?: LlmUsage
}

export async function llmStreamWithUsage(
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<LlmStreamResult> {
  const key = getKey()
  const { system, user, signal } = opts
  const body: Record<string, unknown> = {
    model: LLM_CONFIG.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: true,
    stream_options: { include_usage: true },
  }

  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${LLM_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const body_stream = res!.body
  if (!body_stream) {
    throw new LlmError('network', 'No response body for streaming request')
  }

  const reader = body_stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let done_received = false
  let usage: LlmUsage | undefined

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)

        const trimmed = line.trimEnd()
        if (!trimmed.startsWith('data:')) continue

        const payload = trimmed.slice(5).replace(/^ /, '')
        if (payload === '[DONE]') {
          done_received = true
          break
        }

        try {
          const event = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null } }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          }

          // Usage chunk: choices array is empty (or absent), usage is present
          if (
            event.usage &&
            typeof event.usage.prompt_tokens === 'number' &&
            typeof event.usage.completion_tokens === 'number' &&
            typeof event.usage.total_tokens === 'number'
          ) {
            usage = {
              prompt_tokens: event.usage.prompt_tokens,
              completion_tokens: event.usage.completion_tokens,
              total_tokens: event.usage.total_tokens,
            }
          }

          const delta = event?.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            accumulated += delta
            onDelta(delta)
          }
        } catch {
          // malformed SSE JSON — skip
        }
      }

      if (done_received) break
    }
  } catch (err) {
    if (err instanceof LlmError) throw err
    mapFetchError(err)
  } finally {
    reader.releaseLock()
  }

  if (!done_received) {
    throw new LlmError('network', 'Stream ended without [DONE] terminator')
  }

  return { content: accumulated, usage }
}

// ---------------------------------------------------------------------------
// llmJsonWithRepair
// ---------------------------------------------------------------------------

export async function llmJsonWithRepair<T>(
  opts: LlmCompleteOpts,
  validate: (x: unknown) => T | null,
): Promise<T> {
  // First attempt
  const output1 = await llmComplete({ ...opts, json: true })

  let parsed1: unknown
  let error1: string | null = null

  try {
    parsed1 = JSON.parse(output1)
  } catch (err) {
    error1 = err instanceof Error ? err.message : String(err)
  }

  if (error1 === null) {
    // JSON parsed — run validator
    const valid1 = validate(parsed1)
    if (valid1 !== null) return valid1
    error1 = 'Output did not match expected schema'
  }

  // One repair retry
  const repairUser =
    `${opts.user}\n\nYour previous output was invalid: ${error1}. Previous output:\n${output1}\nRespond with corrected JSON only.`

  const output2 = await llmComplete({ ...opts, user: repairUser, json: true })

  let parsed2: unknown
  let error2: string | null = null

  try {
    parsed2 = JSON.parse(output2)
  } catch (err) {
    error2 = err instanceof Error ? err.message : String(err)
  }

  if (error2 === null) {
    const valid2 = validate(parsed2)
    if (valid2 !== null) return valid2
  }

  throw new LlmError('invalid-output', 'LLM produced invalid JSON after repair retry')
}

// ---------------------------------------------------------------------------
// llmJsonWithRepairWithUsage — like llmJsonWithRepair but also returns
// token usage from the first attempt. The repair attempt (if needed) does
// not contribute additional usage — we report usage only from attempt 1.
// ---------------------------------------------------------------------------

export interface LlmJsonWithRepairResult<T> {
  result: T
  usage?: LlmUsage
}

export async function llmJsonWithRepairWithUsage<T>(
  opts: LlmCompleteOpts,
  validate: (x: unknown) => T | null,
): Promise<LlmJsonWithRepairResult<T>> {
  // First attempt via llmCompleteWithUsage to capture usage
  const { content: output1, usage } = await llmCompleteWithUsage({ ...opts, json: true })

  let parsed1: unknown
  let error1: string | null = null
  try {
    parsed1 = JSON.parse(output1)
  } catch (err) {
    error1 = err instanceof Error ? err.message : String(err)
  }

  if (error1 === null) {
    const valid1 = validate(parsed1)
    if (valid1 !== null) return { result: valid1, usage }
    error1 = 'Output did not match expected schema'
  }

  // One repair retry — via plain llmComplete (no usage needed for retry)
  const repairUser =
    `${opts.user}\n\nYour previous output was invalid: ${error1}. Previous output:\n${output1}\nRespond with corrected JSON only.`
  const output2 = await llmComplete({ ...opts, user: repairUser, json: true })

  let parsed2: unknown
  let error2: string | null = null
  try {
    parsed2 = JSON.parse(output2)
  } catch (err) {
    error2 = err instanceof Error ? err.message : String(err)
  }

  if (error2 === null) {
    const valid2 = validate(parsed2)
    if (valid2 !== null) return { result: valid2, usage }
  }

  throw new LlmError('invalid-output', 'LLM produced invalid JSON after repair retry')
}
