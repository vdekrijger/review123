/**
 * LLM transport layer — multi-provider (Plan F: Task F1).
 *
 * Public API (UNCHANGED — zero callers need to be updated):
 *   llmComplete, llmCompleteWithUsage,
 *   llmStream, llmStreamWithUsage,
 *   llmJsonWithRepair, llmJsonWithRepairWithUsage
 *
 * Transport adapters (all internal):
 *   openai-compat — DeepSeek direct + OpenAI via /api/llm/openai proxy.
 *                   Wire format: chat/completions. Key in Authorization: Bearer.
 *   anthropic      — Direct browser (anthropic-dangerous-direct-browser-access: true).
 *                   /v1/messages. SSE: content_block_delta events.
 *                   JSON mode = prompt-enforced (no response_format).
 *   gemini         — Direct browser. :generateContent / :streamGenerateContent?alt=sse.
 *                   JSON via generationConfig.responseMimeType = application/json.
 *                   Key via x-goog-api-key header.
 */

import { getSettings } from '../settings/settings'
import { activeLlmConfig, PROVIDER_KEY_FIELDS } from './config'
import { getProvider, getModelDef } from './providers'
import type { LlmProviderDef, LlmModelDef, LlmProviderId } from './providers'

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
// LlmUsage
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

export interface LlmStreamResult {
  content: string
  usage?: LlmUsage
}

export interface LlmJsonWithRepairResult<T> {
  result: T
  usage?: LlmUsage
}

// ---------------------------------------------------------------------------
// Public opts types (unchanged)
// ---------------------------------------------------------------------------

export interface LlmCompleteOpts {
  system: string
  user: string
  json?: boolean
  signal?: AbortSignal
  /**
   * Optional output-token cap. Used by llmTestConnection's minimal ping.
   * openai-compat → body.max_tokens; anthropic → body.max_tokens (else 4096).
   * Gemini intentionally IGNORES this: 2.5 thinking models can exhaust a
   * 1-token cap before emitting any text part, which would read as an error.
   */
  maxTokens?: number
}

export interface LlmStreamOpts {
  system: string
  user: string
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Friendly message when a SAVED key smuggles a non-ISO-8859-1 character
 * (e.g. an em dash from a styled copy-paste) into header construction.
 * The save path rejects such keys since the same fix landed, but keys
 * saved before it can still be in localStorage — belt and braces.
 */
export const INVALID_KEY_CHAR_MESSAGE =
  'The saved API key contains an invalid character — re-copy it from the provider and save it again.'

/**
 * fetch throws a TypeError when a header value cannot be converted to a
 * ByteString (ISO-8859-1). Message wording differs per engine:
 *   Firefox:  "Window.fetch: Cannot convert value to ByteString because the
 *              character at index 49 has value 8212 which is greater than 255."
 *   Chrome:   "Failed to execute 'fetch' on 'Window': Invalid value"
 *   WebKit/undici: "... is an invalid header value"
 * The generic network failure ("Failed to fetch" / "NetworkError ...")
 * matches none of these patterns.
 */
function isHeaderCharError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /ByteString|ISO-8859-1|invalid header|Invalid value|Cannot convert/i.test(err.message)
  )
}

function mapFetchError(err: unknown): never {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    throw new LlmError('timeout', err.message)
  }
  if (isHeaderCharError(err)) {
    throw new LlmError('auth', INVALID_KEY_CHAR_MESSAGE)
  }
  throw new LlmError('network', err instanceof Error ? err.message : String(err))
}

function mapHttpStatus(status: number): never {
  if (status === 401) throw new LlmError('auth', 'Unauthorized (401)')
  if (status === 429) throw new LlmError('rate-limited', 'Rate limited (429)')
  throw new LlmError('server', `Server error (${status})`)
}

/** Parse an SSE line's data payload into the raw string. Returns null to skip. */
function parseSseLine(line: string): string | null {
  const trimmed = line.trimEnd()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).replace(/^ /, '') // one optional leading space per SSE spec
  return payload
}

// ---------------------------------------------------------------------------
// Key resolution per provider
// ---------------------------------------------------------------------------

function getKeyForProvider(provider: LlmProviderDef): string {
  const keyName = PROVIDER_KEY_FIELDS[provider.id]
  if (!keyName) throw new LlmError('no-key', `No key mapping for provider ${provider.id}`)
  const settings = getSettings()
  const key = settings[keyName] as string | null
  if (!key) throw new LlmError('no-key', `No ${provider.displayName} API key configured`)
  return key
}

// ===========================================================================
// openai-compat transport — covers deepseek direct + openai via proxy
// ===========================================================================

function buildOpenAICompatHeaders(key: string, providerId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  }
  // For OpenAI proxy: forward key in x-user-openai-key so proxy can pass it along
  if (providerId === 'openai') {
    headers['x-user-openai-key'] = key
  }
  return headers
}

async function openaiCompatComplete(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmCompleteOpts,
  includeUsage: boolean,
): Promise<LlmCompleteResult> {
  const key = getKeyForProvider(provider)
  const { system, user, json, signal, maxTokens } = opts

  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  if (json) body.response_format = { type: 'json_object' }
  if (maxTokens !== undefined) body.max_tokens = maxTokens

  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildOpenAICompatHeaders(key, provider.id),
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

  let usage: LlmUsage | undefined
  if (includeUsage) {
    const u = data.usage
    if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number' && typeof u.total_tokens === 'number') {
      usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens }
    }
  }

  return { content, usage }
}

async function openaiCompatStream(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
  includeUsage: boolean,
): Promise<LlmStreamResult> {
  const key = getKeyForProvider(provider)
  const { system, user, signal } = opts

  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: true,
  }
  if (includeUsage) {
    body.stream_options = { include_usage: true }
  }

  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildOpenAICompatHeaders(key, provider.id),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const bodyStream = res!.body
  if (!bodyStream) throw new LlmError('network', 'No response body for streaming request')

  const reader = bodyStream.getReader()
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

        const payload = parseSseLine(line)
        if (payload === null) continue

        if (payload === '[DONE]') {
          done_received = true
          break
        }

        try {
          const event = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null } }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          }

          // Usage chunk (stream_options mode): choices array empty, usage present
          if (includeUsage && event.usage) {
            const u = event.usage
            if (typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number' && typeof u.total_tokens === 'number') {
              usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens }
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

  if (!done_received) throw new LlmError('network', 'Stream ended without [DONE] terminator')

  return { content: accumulated, usage }
}

// ===========================================================================
// anthropic transport
//
// Browser CORS: supported WITH header anthropic-dangerous-direct-browser-access: true
// API: POST /v1/messages, x-api-key, anthropic-version: 2023-06-01
// SSE streaming: event: content_block_delta  data: { delta: { type, text } }
//                event: message_delta         data: { usage: { output_tokens } }
//                Final usage in message_delta: { usage: { output_tokens } }
//                Input usage in message_start: { message: { usage: { input_tokens, output_tokens } } }
// JSON mode: prompt-enforced — no response_format (llmJsonWithRepair handles repair)
// ===========================================================================

function buildAnthropicHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    // Required for direct browser access — acknowledged in header name
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

async function anthropicComplete(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmCompleteOpts,
): Promise<LlmCompleteResult> {
  const key = getKeyForProvider(provider)
  const { system, user, signal, maxTokens } = opts

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: maxTokens ?? 4096,
    system,
    messages: [{ role: 'user', content: user }],
  }

  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const data = (await res!.json()) as {
    content?: { type: string; text?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const textBlock = data?.content?.find((b) => b.type === 'text')
  const content = textBlock?.text
  if (typeof content !== 'string') {
    throw new LlmError('server', 'Missing text content block in Anthropic response')
  }

  let usage: LlmUsage | undefined
  const u = data.usage
  if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
    usage = {
      prompt_tokens: u.input_tokens,
      completion_tokens: u.output_tokens,
      total_tokens: u.input_tokens + u.output_tokens,
    }
  }

  return { content, usage }
}

async function anthropicStream(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<LlmStreamResult> {
  const key = getKeyForProvider(provider)
  const { system, user, signal } = opts

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
    stream: true,
  }

  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const bodyStream = res!.body
  if (!bodyStream) throw new LlmError('network', 'No response body for streaming request')

  const reader = bodyStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let done_received = false
  let inputTokens = 0
  let outputTokens = 0
  let hasUsage = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Anthropic SSE format: lines beginning with "event:" or "data:"
      // We only need data: lines (content_block_delta + message_delta + message_stop)
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)

        const payload = parseSseLine(line)
        if (payload === null) continue

        try {
          const event = JSON.parse(payload) as {
            type?: string
            delta?: { type?: string; text?: string }
            // message_start: { message: { usage: { input_tokens, output_tokens } } }
            message?: { usage?: { input_tokens?: number; output_tokens?: number } }
            // message_delta: { usage: { output_tokens } }
            usage?: { input_tokens?: number; output_tokens?: number }
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text ?? ''
            if (text) {
              accumulated += text
              onDelta(text)
            }
          } else if (event.type === 'message_start' && event.message?.usage) {
            const u = event.message.usage
            if (typeof u.input_tokens === 'number') {
              inputTokens = u.input_tokens
              hasUsage = true
            }
          } else if (event.type === 'message_delta' && event.usage) {
            const u = event.usage
            if (typeof u.output_tokens === 'number') {
              outputTokens = u.output_tokens
              hasUsage = true
            }
          } else if (event.type === 'message_stop') {
            done_received = true
            break
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

  if (!done_received) throw new LlmError('network', 'Anthropic stream ended without message_stop')

  const usage: LlmUsage | undefined = hasUsage
    ? { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
    : undefined

  return { content: accumulated, usage }
}

// ===========================================================================
// gemini transport
//
// Browser CORS: supported natively.
// Endpoint: generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//           or :streamGenerateContent?alt=sse
// Key: x-goog-api-key header.
// JSON: generationConfig.responseMimeType = "application/json"
// Usage: usageMetadata { promptTokenCount, candidatesTokenCount, totalTokenCount }
// ===========================================================================

function buildGeminiHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': key,
  }
}

function buildGeminiBody(
  system: string,
  user: string,
  json: boolean,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: [
      { role: 'user', parts: [{ text: `${system}\n\n${user}` }] },
    ],
  }
  if (json) {
    body.generationConfig = { responseMimeType: 'application/json' }
  }
  return body
}

async function geminiComplete(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmCompleteOpts,
): Promise<LlmCompleteResult> {
  const key = getKeyForProvider(provider)
  const { system, user, json, signal } = opts

  const body = buildGeminiBody(system, user, !!json, false)
  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(
      `${provider.baseUrl}/v1beta/models/${model.id}:generateContent`,
      {
        method: 'POST',
        headers: buildGeminiHeaders(key),
        body: JSON.stringify(body),
        signal: effectiveSignal,
      },
    )
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const data = (await res!.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof text !== 'string') {
    throw new LlmError('server', 'Missing text in Gemini response candidates[0].content.parts[0].text')
  }

  let usage: LlmUsage | undefined
  const u = data.usageMetadata
  if (u && typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number') {
    usage = {
      prompt_tokens: u.promptTokenCount,
      completion_tokens: u.candidatesTokenCount,
      total_tokens: u.totalTokenCount ?? (u.promptTokenCount + u.candidatesTokenCount),
    }
  }

  return { content: text, usage }
}

async function geminiStream(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<LlmStreamResult> {
  const key = getKeyForProvider(provider)
  const { system, user, signal } = opts

  const body = buildGeminiBody(system, user, false, true)
  const effectiveSignal = signal ?? AbortSignal.timeout(60_000)

  let res: Response
  try {
    res = await fetch(
      `${provider.baseUrl}/v1beta/models/${model.id}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: buildGeminiHeaders(key),
        body: JSON.stringify(body),
        signal: effectiveSignal,
      },
    )
  } catch (err) {
    mapFetchError(err)
  }

  if (!res!.ok) mapHttpStatus(res!.status)

  const bodyStream = res!.body
  if (!bodyStream) throw new LlmError('network', 'No response body for Gemini streaming request')

  const reader = bodyStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let done_received = false
  let usage: LlmUsage | undefined

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        done_received = true
        break
      }

      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)

        const payload = parseSseLine(line)
        if (payload === null) continue

        try {
          const chunk = JSON.parse(payload) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[]
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
          }

          const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
          if (text) {
            accumulated += text
            onDelta(text)
          }

          const u = chunk.usageMetadata
          if (u && typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number') {
            usage = {
              prompt_tokens: u.promptTokenCount,
              completion_tokens: u.candidatesTokenCount,
              total_tokens: u.totalTokenCount ?? (u.promptTokenCount + u.candidatesTokenCount),
            }
          }
        } catch {
          // malformed SSE JSON — skip
        }
      }
    }
  } catch (err) {
    if (err instanceof LlmError) throw err
    mapFetchError(err)
  } finally {
    reader.releaseLock()
  }

  // Gemini SSE ends naturally when the stream closes (no [DONE] sentinel)
  if (!done_received) throw new LlmError('network', 'Gemini stream closed unexpectedly')

  return { content: accumulated, usage }
}

// ===========================================================================
// Transport dispatch — routes to the right adapter based on active config
// ===========================================================================

function getActiveConfig(): { provider: LlmProviderDef; model: LlmModelDef } {
  const cfg = activeLlmConfig()
  return { provider: cfg.provider, model: cfg.model }
}

async function dispatchComplete(opts: LlmCompleteOpts, includeUsage: boolean): Promise<LlmCompleteResult> {
  const { provider, model } = getActiveConfig()
  switch (provider.transport) {
    case 'openai-compat':
      return openaiCompatComplete(provider, model, opts, includeUsage)
    case 'anthropic':
      return anthropicComplete(provider, model, opts)
    case 'gemini':
      return geminiComplete(provider, model, opts)
  }
}

async function dispatchStream(
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
  includeUsage: boolean,
): Promise<LlmStreamResult> {
  const { provider, model } = getActiveConfig()
  switch (provider.transport) {
    case 'openai-compat':
      return openaiCompatStream(provider, model, opts, onDelta, includeUsage)
    case 'anthropic':
      return anthropicStream(provider, model, opts, onDelta)
    case 'gemini':
      return geminiStream(provider, model, opts, onDelta)
  }
}

// ===========================================================================
// Public API (signatures unchanged)
// ===========================================================================

// ---------------------------------------------------------------------------
// llmComplete
// ---------------------------------------------------------------------------

export async function llmComplete(opts: LlmCompleteOpts): Promise<string> {
  const { content } = await dispatchComplete(opts, false)
  return content
}

// ---------------------------------------------------------------------------
// llmCompleteWithUsage
// ---------------------------------------------------------------------------

export async function llmCompleteWithUsage(opts: LlmCompleteOpts): Promise<LlmCompleteResult> {
  return dispatchComplete(opts, true)
}

// ---------------------------------------------------------------------------
// llmStream
// ---------------------------------------------------------------------------

export async function llmStream(
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<string> {
  const { content } = await dispatchStream(opts, onDelta, false)
  return content
}

// ---------------------------------------------------------------------------
// llmStreamWithUsage
// ---------------------------------------------------------------------------

export async function llmStreamWithUsage(
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<LlmStreamResult> {
  return dispatchStream(opts, onDelta, true)
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
// llmJsonWithRepairWithUsage
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// llmTestConnection — minimal connection ping for the Settings "Save & test"
// button. Goes through the REAL transport adapters for the GIVEN provider
// (independent of the active aiProvider setting). Never cached: llm.ts has no
// cache layer — caching lives in run.svelte.ts, which this never touches.
// Reads the provider's key from SAVED settings (the UI saves before testing).
// ---------------------------------------------------------------------------

export async function llmTestConnection(
  providerId: LlmProviderId,
  modelId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = getProvider(providerId)
  if (!provider) throw new LlmError('server', `Unknown provider: ${providerId}`)

  const model =
    (modelId ? getModelDef(provider, modelId) : undefined) ??
    getModelDef(provider, provider.defaultModel) ??
    provider.models[0]

  const opts: LlmCompleteOpts = {
    system: 'Connection test.',
    user: 'Reply with the single word: ok',
    // 1-token-style minimal request. Gemini ignores maxTokens by design
    // (see LlmCompleteOpts.maxTokens) — its ping stays tiny via the prompt.
    maxTokens: 1,
    signal: signal ?? AbortSignal.timeout(15_000),
  }

  switch (provider.transport) {
    case 'openai-compat':
      await openaiCompatComplete(provider, model, opts, false)
      return
    case 'anthropic':
      await anthropicComplete(provider, model, opts)
      return
    case 'gemini':
      await geminiComplete(provider, model, opts)
      return
  }
}
