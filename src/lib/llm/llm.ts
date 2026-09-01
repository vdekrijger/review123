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
 *                   JSON mode = FORCED TOOL USE (tools + tool_choice:{type:'tool'}),
 *                   Anthropic's native structured-output mechanism — it has no
 *                   response_format field.
 *   gemini         — Direct browser. :generateContent / :streamGenerateContent?alt=sse.
 *                   JSON via generationConfig.responseMimeType = application/json.
 *                   Key via x-goog-api-key header.
 *
 * Every non-streaming adapter also reports whether the provider TRUNCATED the
 * reply at the output cap (openai `finish_reason:'length'`, anthropic
 * `stop_reason:'max_tokens'`, gemini `finishReason:'MAX_TOKENS'`), so the JSON
 * repair loop can raise the cap instead of echoing a cut-off body back into a
 * prompt that already overflowed.
 */

import { getSettings } from '../settings/settings'
import { gateFor } from './concurrencyGate'
import { withTransientRetry } from './transientRetry'
import { activeLlmConfig, PROVIDER_KEY_FIELDS } from './config'
import { getProvider, getModelDef } from './providers'
import { parseJsonLoose } from './jsonExtract'
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
  /**
   * The request was CANCELLED, not failed: an AbortSignal fired that was not
   * our own per-request timeout (a caller cancelling deliberately, a page/
   * extension tearing the request down). Never a red error in the UI and never
   * an ai_task_failed event — see run.svelte.ts's 'cancelled' PanelStatus.
   *
   * Deliberately NOT 'network': the browser's abort DOMException carries text
   * like "The user aborted a request.", which used to be shown verbatim under
   * a "check your connection" lead — blaming the user for something they never
   * did. A cancellation carries CANCELLED_MESSAGE instead, never engine text.
   */
  | 'aborted'

export class LlmError extends Error {
  /** HTTP status of the failed response, when the failure was HTTP-level. */
  public readonly status?: number
  /** Parsed Retry-After header in ms (429s), when the provider sent one. */
  public readonly retryAfterMs?: number
  /**
   * The provider CUT THE REPLY OFF at the output-token cap ('invalid-output'
   * only). A different user-facing story from "the model wrote nonsense":
   * the task is too big for the model's output budget, not malformed.
   */
  public readonly truncated?: boolean
  /**
   * A short, sanitized excerpt of what the model actually returned
   * ('invalid-output' only). UI/tooltip ONLY — it is model output, i.e. it can
   * paraphrase the user's own code, so it is deliberately kept OUT of
   * `message` (which is what feeds the analytics `reason_detail` property).
   */
  public readonly outputExcerpt?: string

  constructor(
    public readonly kind: LlmErrorKind,
    message?: string,
    detail?: { status?: number; retryAfterMs?: number; truncated?: boolean; outputExcerpt?: string },
  ) {
    super(message ?? `llm: ${kind}`)
    this.name = 'LlmError'
    this.status = detail?.status
    this.retryAfterMs = detail?.retryAfterMs
    this.truncated = detail?.truncated
    this.outputExcerpt = detail?.outputExcerpt
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
  /**
   * The provider stopped because the output-token cap was reached, so `content`
   * is a PREFIX of the intended answer. Additive: every adapter sets it, no
   * existing caller has to read it.
   */
  truncated?: boolean
}

export interface LlmStreamResult {
  content: string
  usage?: LlmUsage
}

export interface LlmJsonWithRepairResult<T> {
  result: T
  usage?: LlmUsage
}

/**
 * An explicitly-specified provider config (Plan M cross-model verification).
 * Lets a completion run against a provider OTHER than the active one — the
 * verifier providers. The key is carried explicitly (read by the caller from
 * settings) so the transport never falls back to the active provider's key.
 */
export interface ProviderConfig {
  providerId: LlmProviderId
  model: LlmModelDef
  key: string
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
   * Optional output-token cap. Used by llmTestConnection's ping and the JSON
   * tasks' output headroom. Routed to the provider's field: openai-compat →
   * `provider.maxTokensParam` (OpenAI's GPT-5 family needs
   * `max_completion_tokens`; DeepSeek uses `max_tokens`); anthropic →
   * `max_tokens` (else 4096); gemini → `generationConfig.maxOutputTokens`
   * (unset → provider default, unchanged). Keep it GENEROUS: reasoning
   * models spend hidden reasoning tokens, so too-small a cap fails the request
   * ("could not finish … reached max_tokens") rather than truncating.
   */
  maxTokens?: number
  /**
   * Per-request timeout for the adapter-built AbortSignal (default 60s).
   * Large-prompt tasks pass a scaled value so a big packed context isn't
   * killed at the default window. ALWAYS applies: a caller-supplied `signal`
   * is COMPOSED with the timeout (AbortSignal.any), never substituted for it —
   * passing a signal used to silently disable the timeout, leaving those calls
   * able to hang indefinitely. Each transient-retry attempt re-runs the
   * adapter, so every attempt gets a fresh, full window.
   */
  timeoutMs?: number
}

export interface LlmStreamOpts {
  system: string
  user: string
  signal?: AbortSignal
  /** Same contract as LlmCompleteOpts.timeoutMs (default 60s; composed with `signal`). */
  timeoutMs?: number
}

/** Default per-request timeout used when neither `signal` nor `timeoutMs` is given. */
const DEFAULT_TIMEOUT_MS = 60_000

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

/**
 * The message every 'aborted' LlmError carries. Fixed and neutral ON PURPOSE:
 * the engine's own abort text ("The user aborted a request." in Blink, "Fetch
 * is aborted" in WebKit) is a lie from the user's point of view — they did not
 * abort anything — and it used to be rendered verbatim in the panel.
 */
export const CANCELLED_MESSAGE = 'The request was cancelled.'

/**
 * The message for a timeout we detected via the timeout SIGNAL rather than a
 * spec'd TimeoutError DOMException (see mapFetchError).
 */
export const TIMED_OUT_MESSAGE = 'The request timed out.'

/** True for the DOMException an aborted fetch / body-stream read rejects with. */
function isAbortException(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError'
  // Not every environment routes abort rejections through a real DOMException
  // (test doubles, some polyfills) — the `name` discriminant is the contract.
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

/** True for the DOMException an `AbortSignal.timeout` firing rejects with, per spec. */
function isTimeoutException(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'TimeoutError'
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError'
}

/**
 * Map a thrown fetch/stream-read failure onto an LlmError.
 *
 * `timeoutSignal` is OUR per-request timeout signal for the call that threw.
 * It matters because engines are inconsistent here: the spec says a fetch
 * aborted by an `AbortSignal.timeout` rejects with the signal's reason (a
 * TimeoutError DOMException), but Blink reports several of those paths — most
 * importantly `reader.read()` on a signal-aborted response body, i.e. every
 * mid-stream timeout — as a plain AbortError. Reading `err.name` alone would
 * therefore classify a genuine timeout as a cancellation and silently drop the
 * panel to a calm state when the honest answer is "the model took too long".
 * So when an AbortError arrives and our own timeout signal has fired, the
 * timeout wins; any other abort is a cancellation.
 *
 * Exported for llmToolLoop.ts (Plan G) — shared transport plumbing, not public API.
 */
export function mapFetchError(err: unknown, timeoutSignal?: AbortSignal): never {
  if (isTimeoutException(err)) {
    throw new LlmError('timeout', err instanceof Error ? err.message : TIMED_OUT_MESSAGE)
  }
  if (isAbortException(err)) {
    if (timeoutSignal?.aborted) throw new LlmError('timeout', TIMED_OUT_MESSAGE)
    throw new LlmError('aborted', CANCELLED_MESSAGE)
  }
  if (isHeaderCharError(err)) {
    throw new LlmError('auth', INVALID_KEY_CHAR_MESSAGE)
  }
  throw new LlmError('network', err instanceof Error ? err.message : String(err))
}

// ---------------------------------------------------------------------------
// Signal composition
// ---------------------------------------------------------------------------

/**
 * Combine abort signals WITHOUT `AbortSignal.any` — the feature-detect fallback.
 * Propagates the winning signal's `reason` so a timeout stays a TimeoutError
 * (which is what lets mapFetchError tell a timeout from a cancellation).
 * Exported for its own unit tests; prefer anySignal().
 */
export function manualAnySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const already = signals.find((s) => s.aborted)
  if (already) {
    controller.abort(already.reason)
    return controller.signal
  }
  for (const s of signals) {
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

/**
 * One signal that fires when ANY of `signals` fires. Uses the native
 * `AbortSignal.any` where available (widely supported) and falls back to
 * manualAnySignal otherwise.
 *
 * This exists because the adapters used to write `signal ?? timeoutSignal`: a
 * caller-supplied signal REPLACED the per-request timeout, so any call that
 * passed one had no timeout at all and could hang indefinitely.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]!
  const native = (AbortSignal as { any?: (list: AbortSignal[]) => AbortSignal }).any
  if (typeof native === 'function') return native.call(AbortSignal, signals)
  return manualAnySignal(signals)
}

/**
 * The per-request cancellation pair every adapter builds: our timeout signal
 * (kept separately so mapFetchError can ask whether IT fired) and the signal
 * actually handed to fetch — the caller's signal composed WITH the timeout,
 * never one instead of the other.
 */
function requestSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { timeoutSignal: AbortSignal; effectiveSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return {
    timeoutSignal,
    effectiveSignal: callerSignal ? anySignal([callerSignal, timeoutSignal]) : timeoutSignal,
  }
}

/**
 * Rethrow a transport failure as a CANCELLATION when the caller's own signal
 * has fired. Covers the paths where the real error is not the abort itself —
 * most notably withTransientRetry surfacing the last 429/5xx after the caller
 * aborted mid-backoff (transientRetry.ts:164-166), which would otherwise show
 * a server error for a request the caller deliberately gave up on.
 */
function rethrowAsCancellation(err: unknown, callerSignal: AbortSignal | undefined): never {
  if (callerSignal?.aborted) throw new LlmError('aborted', CANCELLED_MESSAGE)
  throw err
}

/**
 * withTransientRetry + caller-cancellation mapping. Exported for llmToolLoop.ts
 * so the deep-mode tool loop classifies aborts exactly like the dispatchers.
 */
export async function retryWithCancellation<T>(
  fn: () => Promise<T>,
  info: { providerId?: string; signal?: AbortSignal },
): Promise<T> {
  try {
    return await withTransientRetry(fn, info)
  } catch (err) {
    rethrowAsCancellation(err, info.signal)
  }
}

// Exported for llmToolLoop.ts (Plan G) — shared transport plumbing, not public API.
export function mapHttpStatus(status: number): never {
  if (status === 401) throw new LlmError('auth', 'Unauthorized (401)', { status })
  if (status === 429) throw new LlmError('rate-limited', 'Rate limited (429)', { status })
  throw new LlmError('server', `Server error (${status})`, { status })
}

/**
 * Parse an HTTP Retry-After header into milliseconds. Both RFC 9110 forms:
 *   delta-seconds — "30"                          → 30_000
 *   http-date     — "Wed, 21 Oct 2026 07:28:00 GMT" → date minus now (min 0)
 * Absent / unparseable → undefined. `nowMs` is injectable for tests.
 */
export function parseRetryAfterMs(header: string | null, nowMs = Date.now()): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  return Math.max(0, dateMs - nowMs)
}

/**
 * Like mapHttpStatus, but reads the upstream error BODY and surfaces its
 * message, so the user sees the REAL reason (e.g. an OpenAI
 * invalid_request_error explaining a rejected parameter) instead of a bare
 * "Server error (NNN)". Best-effort: provider error envelopes are
 * `{ error: { message } }` or `{ error: "<string>" }` (our OpenAI proxy uses
 * the string form); non-JSON bodies are included verbatim (capped). The detail
 * never carries the API key — neither provider error bodies nor the proxy's
 * `{ error }` envelope include it (OpenAI redacts keys in its 401 text itself).
 */
export async function mapHttpError(res: Response): Promise<never> {
  let detail = ''
  try {
    const text = await res.text()
    if (text) {
      try {
        const j = JSON.parse(text) as { error?: unknown; message?: unknown }
        const e = j.error
        if (typeof e === 'string') detail = e
        else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
          detail = (e as { message: string }).message
        } else if (typeof j.message === 'string') detail = j.message
      } catch {
        detail = text // non-JSON (e.g. an HTML error page) — show it verbatim
      }
    }
  } catch {
    // Body unreadable — fall through to the status-only message.
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300)
  const suffix = detail ? `: ${detail}` : ''
  const errDetail = {
    status: res.status,
    retryAfterMs: parseRetryAfterMs(res.headers.get('Retry-After')),
  }
  if (res.status === 401) throw new LlmError('auth', `Unauthorized (401)${suffix}`, errDetail)
  if (res.status === 429) throw new LlmError('rate-limited', `Rate limited (429)${suffix}`, errDetail)
  throw new LlmError('server', `Server error (${res.status})${suffix}`, errDetail)
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

// Exported for llmToolLoop.ts (Plan G) — shared transport plumbing, not public API.
export function getKeyForProvider(provider: LlmProviderDef): string {
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

// Exported for llmToolLoop.ts (Plan G) — shared transport plumbing, not public API.
export function buildOpenAICompatHeaders(key: string, providerId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  }
  // For OpenAI proxy: forward key in x-user-openai-key so proxy can pass it along
  if (providerId === 'openai') {
    headers['x-user-openai-key'] = key
  }
  // OpenRouter's recommended attribution headers — harmless, improve their
  // dashboard attribution. Both are ASCII so they never break header encoding.
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://review123.dev'
    headers['X-Title'] = 'Review 1-2-3'
  }
  return headers
}

async function openaiCompatComplete(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmCompleteOpts,
  includeUsage: boolean,
  keyOverride?: string,
): Promise<LlmCompleteResult> {
  const key = keyOverride ?? getKeyForProvider(provider)
  const { system, user, json, signal, maxTokens, timeoutMs } = opts

  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  if (json) body.response_format = { type: 'json_object' }
  // OpenAI's GPT-5 family rejects `max_tokens` (400) — use the provider's
  // declared field (max_completion_tokens for OpenAI, max_tokens elsewhere).
  if (maxTokens !== undefined) body[provider.maxTokensParam ?? 'max_tokens'] = maxTokens

  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildOpenAICompatHeaders(key, provider.id),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err, timeoutSignal)
  }

  if (!res!.ok) await mapHttpError(res!)

  const data = (await res!.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]
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

  // OpenAI wire format: finish_reason 'length' == cut off at the token cap.
  return { content, usage, truncated: data?.choices?.[0]?.finish_reason === 'length' }
}

async function openaiCompatStream(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
  includeUsage: boolean,
): Promise<LlmStreamResult> {
  const key = getKeyForProvider(provider)
  const { system, user, signal, timeoutMs } = opts

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

  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildOpenAICompatHeaders(key, provider.id),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err, timeoutSignal)
  }

  if (!res!.ok) await mapHttpError(res!)

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
    // Mid-stream failures land here. A timeout that fires while the body is
    // being read is reported as an AbortError by Blink, so the timeout signal
    // is what tells "the model stalled" apart from "someone cancelled us".
    mapFetchError(err, timeoutSignal)
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
// JSON mode: FORCED TOOL USE. Anthropic has no response_format; its native
//            structured-output mechanism is `tool_choice: {type:'tool', name}`
//            with a matching entry in `tools` (verified against
//            platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools,
//            2026-08). The model then answers ONLY with a tool_use block whose
//            `input` is a JSON object — no prose, no fences, nothing to strip.
// ===========================================================================

/**
 * The single tool the anthropic adapter forces in JSON mode. The schema is
 * deliberately PERMISSIVE (`{type:'object'}`): the real shape-checking is done
 * by the per-task validators in ai/schemas.ts, and every one of them expects a
 * top-level object. A strict per-task input_schema would be a much larger
 * change (each prompt's shape would have to be expressed twice) for no
 * additional robustness here.
 */
export const ANTHROPIC_JSON_TOOL_NAME = 'respond_with_result'

const ANTHROPIC_JSON_TOOL_DESCRIPTION =
  'Return the requested result. Put the complete result object in this tool input — ' +
  'calling this tool is the only way to answer.'

/**
 * Forced-tool JSON mode for the anthropic Messages API.
 *
 * NOT used by llmToolLoop.ts: that module builds its own anthropic request with
 * the caller's REAL tools, and never routes through this adapter — so deep
 * review / grounded verification can never collide with this forcing.
 */
function anthropicJsonModeFields(): Record<string, unknown> {
  return {
    tools: [
      {
        name: ANTHROPIC_JSON_TOOL_NAME,
        description: ANTHROPIC_JSON_TOOL_DESCRIPTION,
        input_schema: { type: 'object' },
      },
    ],
    tool_choice: { type: 'tool', name: ANTHROPIC_JSON_TOOL_NAME },
  }
}

// Exported for llmToolLoop.ts (Plan G) — shared transport plumbing, not public API.
export function buildAnthropicHeaders(key: string): Record<string, string> {
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
  keyOverride?: string,
): Promise<LlmCompleteResult> {
  const key = keyOverride ?? getKeyForProvider(provider)
  const { system, user, json, signal, maxTokens, timeoutMs } = opts

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: maxTokens ?? 4096,
    system,
    messages: [{ role: 'user', content: user }],
    // Additive: a non-JSON completion (including llmTestConnection's ping) is
    // byte-identical to before — no tools, no tool_choice.
    ...(json ? anthropicJsonModeFields() : {}),
  }

  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err, timeoutSignal)
  }

  if (!res!.ok) await mapHttpError(res!)

  const data = (await res!.json()) as {
    content?: { type: string; text?: string; name?: string; input?: unknown }[]
    stop_reason?: string | null
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const blocks = data?.content ?? []
  // Forced-tool JSON mode answers with a tool_use block and NO text block.
  const toolBlock = blocks.find((b) => b.type === 'tool_use' && b.name === ANTHROPIC_JSON_TOOL_NAME)
  const textBlock = blocks.find((b) => b.type === 'text')

  let content: string | undefined
  if (toolBlock && toolBlock.input !== undefined && toolBlock.input !== null) {
    content = JSON.stringify(toolBlock.input)
  } else if (typeof textBlock?.text === 'string') {
    // Fallback for any response that carries text instead — a gateway that
    // drops `tools`, or a plain non-JSON completion. Keeps the old contract.
    content = textBlock.text
  }
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

  // Anthropic marks a cap-hit with stop_reason 'max_tokens'; a reply that fills
  // the whole context window reports 'model_context_window_exceeded'. Both mean
  // "this content is a prefix".
  const truncated =
    data?.stop_reason === 'max_tokens' || data?.stop_reason === 'model_context_window_exceeded'

  return { content, usage, truncated }
}

async function anthropicStream(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<LlmStreamResult> {
  const key = getKeyForProvider(provider)
  const { system, user, signal, timeoutMs } = opts

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
    stream: true,
  }

  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

  let res: Response
  try {
    res = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(key),
      body: JSON.stringify(body),
      signal: effectiveSignal,
    })
  } catch (err) {
    mapFetchError(err, timeoutSignal)
  }

  if (!res!.ok) await mapHttpError(res!)

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
    mapFetchError(err, timeoutSignal)
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

// Exported for llmToolLoop.ts (Plan G) — shared transport plumbing, not public API.
export function buildGeminiHeaders(key: string): Record<string, string> {
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
  maxTokens?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: [
      { role: 'user', parts: [{ text: `${system}\n\n${user}` }] },
    ],
  }
  // Additive: generationConfig only appears when something sets it, so the
  // no-json / no-maxTokens request body is byte-identical to before.
  const generationConfig: Record<string, unknown> = {}
  if (json) generationConfig.responseMimeType = 'application/json'
  if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig
  return body
}

async function geminiComplete(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmCompleteOpts,
  keyOverride?: string,
): Promise<LlmCompleteResult> {
  const key = keyOverride ?? getKeyForProvider(provider)
  const { system, user, json, signal, maxTokens, timeoutMs } = opts

  const body = buildGeminiBody(system, user, !!json, false, maxTokens)
  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

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
    mapFetchError(err, timeoutSignal)
  }

  if (!res!.ok) await mapHttpError(res!)

  const data = (await res!.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
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

  // Gemini marks a cap-hit with finishReason MAX_TOKENS.
  return { content: text, usage, truncated: data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' }
}

async function geminiStream(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
): Promise<LlmStreamResult> {
  const key = getKeyForProvider(provider)
  const { system, user, signal, timeoutMs } = opts

  const body = buildGeminiBody(system, user, false, true)
  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

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
    mapFetchError(err, timeoutSignal)
  }

  if (!res!.ok) await mapHttpError(res!)

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
    mapFetchError(err, timeoutSignal)
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
  // Per-provider backpressure: every real (non-cached) completion holds one of
  // the provider's MAX_INFLIGHT_LLM_CALLS slots for the duration of the
  // request, released on success or error. Cache HITs never reach here, so
  // they never consume a slot. Transient failures (429 / 5xx) are retried by
  // withTransientRetry OUTSIDE the gate — the slot is released before each
  // backoff sleep, so a sleeping call never starves other traffic; every
  // attempt re-runs the adapter, which builds a fresh timeout signal for the
  // full window (60s default, or the caller's timeoutMs).
  const { provider, model } = getActiveConfig()
  return retryWithCancellation(
    () =>
      gateFor(provider.id).run(() => {
        switch (provider.transport) {
          case 'openai-compat':
            return openaiCompatComplete(provider, model, opts, includeUsage)
          case 'anthropic':
            return anthropicComplete(provider, model, opts)
          case 'gemini':
            return geminiComplete(provider, model, opts)
        }
      }),
    { providerId: provider.id, signal: opts.signal },
  )
}

/**
 * Dispatch a completion against an EXPLICITLY specified provider config (Plan M).
 * Routes through the same transport adapters as the active path, but uses the
 * passed-in key (so a verifier provider's key is used, not the active one) and
 * the passed-in model. OpenAI still goes via its proxy baseUrl. The key is
 * passed through `keyOverride` so settings are never consulted for verifiers.
 */
async function dispatchCompleteFor(
  cfg: ProviderConfig,
  opts: LlmCompleteOpts,
  includeUsage: boolean,
): Promise<LlmCompleteResult> {
  const provider = getProvider(cfg.providerId)
  if (!provider) throw new LlmError('server', `Unknown provider: ${cfg.providerId}`)
  if (!cfg.key) throw new LlmError('no-key', `No key for provider ${cfg.providerId}`)
  // Cross-model verifier calls share the SAME per-provider gate as the active
  // path — verifier fan-out is exactly what trips rate limits at scale — but a
  // verifier's provider being saturated never blocks the OTHER providers.
  // Retry wraps the gate (slot released during backoff), same as dispatchComplete.
  return retryWithCancellation(
    () =>
      gateFor(provider.id).run(() => {
        switch (provider.transport) {
          case 'openai-compat':
            return openaiCompatComplete(provider, cfg.model, opts, includeUsage, cfg.key)
          case 'anthropic':
            return anthropicComplete(provider, cfg.model, opts, cfg.key)
          case 'gemini':
            return geminiComplete(provider, cfg.model, opts, cfg.key)
        }
      }),
    { providerId: provider.id, signal: opts.signal },
  )
}

async function dispatchStream(
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
  includeUsage: boolean,
): Promise<LlmStreamResult> {
  // Streaming holds its slot for the WHOLE stream lifetime: the transport
  // functions await the full read loop (and throw on upstream error / abort /
  // missing terminator) BEFORE their promise settles, so gate.run() acquires
  // before the first chunk and releases (in its finally) exactly when the
  // stream finishes, errors, or is aborted — never leaking a slot.
  //
  // Retry safety: a transient 429/5xx surfaces via mapHttpError BEFORE any
  // delta is emitted (the body is only read after res.ok), so a retried
  // stream never double-emits. Mid-stream failures map to 'network' (no
  // status) and are NOT retried.
  const { provider, model } = getActiveConfig()
  return retryWithCancellation(
    () =>
      gateFor(provider.id).run(() => {
        switch (provider.transport) {
          case 'openai-compat':
            return openaiCompatStream(provider, model, opts, onDelta, includeUsage)
          case 'anthropic':
            return anthropicStream(provider, model, opts, onDelta)
          case 'gemini':
            return geminiStream(provider, model, opts, onDelta)
        }
      }),
    { providerId: provider.id, signal: opts.signal },
  )
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

// ===========================================================================
// JSON-with-repair — ONE implementation behind the three public entry points
//
// The three exported variants used to be near-identical copies; they differ
// ONLY in which transport they call and how they report usage, so that is all
// their wrappers still do.
//
// Per attempt:
//   1. TOLERANT parse — extractJsonCandidate unwraps ```json fences, prose
//      preambles/suffixes, a stray trailing fence and trailing commas before
//      declaring a parse failure. A model that returned perfectly good JSON
//      inside a fence used to fail here instantly.
//   2. validate() — a null return is a SCHEMA failure, deliberately kept
//      distinguishable from a parse failure in the error we finally throw.
//
// Between attempts, the retry depends on WHY the first one failed:
//   - TRUNCATED (the provider cut the reply at the output cap): do NOT echo the
//     body back — that is what turned one overflow into two. Retry with a
//     raised output cap and an instruction to be concise.
//   - anything else: the original repair prompt, with the echoed previous
//     output capped and honestly marked.
// ===========================================================================

/** How much of a previous output is echoed into a (non-truncation) repair prompt. */
export const REPAIR_ECHO_MAX_CHARS = 2_000

/** Cap on the sanitized model-output excerpt carried on an invalid-output error. */
export const OUTPUT_EXCERPT_MAX_CHARS = 200

/**
 * Ceiling for the raised output cap on a truncation retry. 16k is comfortably
 * inside every model in the catalog's output limit (Anthropic 4.6+/Opus 128k,
 * OpenAI GPT-5.x 128k, Gemini 3.x 64k, DeepSeek V4 384k, OpenRouter normalizes
 * per upstream), so the retry can never 400 on an over-large cap — which would
 * turn a recoverable truncation into a hard failure.
 */
export const TRUNCATION_RETRY_TOKEN_CEILING = 16_384

/** The raised cap for a truncation retry, or undefined to leave it unset. */
export function raisedTokenCap(current: number | undefined): number | undefined {
  if (current === undefined) return TRUNCATION_RETRY_TOKEN_CEILING
  // Never LOWER a cap the caller deliberately set above the ceiling.
  if (current >= TRUNCATION_RETRY_TOKEN_CEILING) return current
  return Math.min(current * 2, TRUNCATION_RETRY_TOKEN_CEILING)
}

/** One-line, control-character-free excerpt of a model reply, capped. */
function outputExcerpt(text: string): string | undefined {
  // Strip C0/C1 control characters first (a raw reply can carry them), then
  // collapse all whitespace so the excerpt is a single tooltip-safe line.
  const clean = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean === '') return undefined
  return clean.length > OUTPUT_EXCERPT_MAX_CHARS
    ? `${clean.slice(0, OUTPUT_EXCERPT_MAX_CHARS)}…`
    : clean
}

/** Previous output for the repair prompt — capped, with the cut declared. */
function echoForRepair(text: string): string {
  if (text.length <= REPAIR_ECHO_MAX_CHARS) return text
  const dropped = text.length - REPAIR_ECHO_MAX_CHARS
  return `${text.slice(0, REPAIR_ECHO_MAX_CHARS)}\n…[first ${REPAIR_ECHO_MAX_CHARS} characters only; ${dropped} more omitted]`
}

type JsonFailure = 'parse' | 'schema'

interface JsonAttempt<T> {
  /** The validated value, or null when this attempt failed. */
  value: T | null
  /** Why it failed (null when it succeeded). */
  failure: JsonFailure | null
  /** The raw model reply. */
  content: string
  /** The provider cut the reply off at the output cap. */
  truncated: boolean
  usage?: LlmUsage
}

/** A completion bound to a transport — the only thing the three variants differ in. */
type JsonCall = (opts: LlmCompleteOpts) => Promise<LlmCompleteResult>

async function jsonAttempt<T>(
  call: JsonCall,
  opts: LlmCompleteOpts,
  validate: (x: unknown) => T | null,
): Promise<JsonAttempt<T>> {
  const { content, usage, truncated } = await call({ ...opts, json: true })
  const parsed = parseJsonLoose(content)
  if (!parsed.ok) {
    return { value: null, failure: 'parse', content, truncated: truncated === true, usage }
  }
  const value = validate(parsed.value)
  return {
    value,
    failure: value === null ? 'schema' : null,
    content,
    truncated: truncated === true,
    usage,
  }
}

function repairPrompt(user: string, attempt: JsonAttempt<unknown>): string {
  const reason =
    attempt.failure === 'schema'
      ? 'Output did not match expected schema'
      : 'No valid JSON could be parsed from the reply'
  return `${user}\n\nYour previous output was invalid: ${reason}. Previous output:\n${echoForRepair(attempt.content)}\nRespond with corrected JSON only.`
}

function concisionPrompt(user: string): string {
  return (
    `${user}\n\nYour previous reply was CUT OFF before it finished — it ran past the output limit. ` +
    'Answer again from scratch with complete, valid JSON only, keeping every string field as short as ' +
    'it can be while staying accurate. Do not restate or continue the previous reply.'
  )
}

/** The final, honest invalid-output error for a failed repair loop. */
function invalidOutputError(last: JsonAttempt<unknown>): LlmError {
  const cause =
    last.failure === 'schema'
      ? 'the JSON did not match the expected shape'
      : 'no valid JSON could be parsed from the reply'
  // Truncation is claimed from the LAST attempt only: a complete-but-wrong
  // shape is a schema problem even when an EARLIER attempt was cut off.
  const cut = last.truncated ? ' (the model’s reply was cut off at the output limit)' : ''
  return new LlmError('invalid-output', `LLM produced invalid JSON after repair retry — ${cause}${cut}`, {
    truncated: last.truncated,
    outputExcerpt: outputExcerpt(last.content),
  })
}

/** Usage from both attempts; the wrappers decide what to report. */
interface JsonRepairOutcome<T> {
  result: T
  usage1?: LlmUsage
  usage2?: LlmUsage
}

async function jsonWithRepair<T>(
  call: JsonCall,
  opts: LlmCompleteOpts,
  validate: (x: unknown) => T | null,
): Promise<JsonRepairOutcome<T>> {
  const first = await jsonAttempt(call, opts, validate)
  if (first.value !== null) return { result: first.value, usage1: first.usage }

  const retryOpts: LlmCompleteOpts = first.truncated
    ? { ...opts, user: concisionPrompt(opts.user), maxTokens: raisedTokenCap(opts.maxTokens) }
    : { ...opts, user: repairPrompt(opts.user, first) }

  const second = await jsonAttempt(call, retryOpts, validate)
  if (second.value !== null) {
    return { result: second.value, usage1: first.usage, usage2: second.usage }
  }

  throw invalidOutputError(second)
}

// ---------------------------------------------------------------------------
// llmJsonWithRepair
// ---------------------------------------------------------------------------

export async function llmJsonWithRepair<T>(
  opts: LlmCompleteOpts,
  validate: (x: unknown) => T | null,
): Promise<T> {
  const { result } = await jsonWithRepair((o) => dispatchComplete(o, false), opts, validate)
  return result
}

// ---------------------------------------------------------------------------
// llmJsonWithRepairWithUsage — reports the FIRST attempt's usage (unchanged:
// the repair pass has never been billed into a task's token total here).
// ---------------------------------------------------------------------------

export async function llmJsonWithRepairWithUsage<T>(
  opts: LlmCompleteOpts,
  validate: (x: unknown) => T | null,
): Promise<LlmJsonWithRepairResult<T>> {
  const { result, usage1 } = await jsonWithRepair((o) => dispatchComplete(o, true), opts, validate)
  return { result, usage: usage1 }
}

// ---------------------------------------------------------------------------
// llmJsonWithRepairFor — JSON-with-repair against an EXPLICIT provider (Plan M)
//
// Same two-attempt repair loop as llmJsonWithRepair, but every call routes
// through the SPECIFIED provider config's transport (with its own key + model)
// instead of the active provider. SUMS both attempts' usage so verifier cost is
// fully folded into per-PR / per-task totals.
// ---------------------------------------------------------------------------

export async function llmJsonWithRepairFor<T>(
  cfg: ProviderConfig,
  opts: LlmCompleteOpts,
  validate: (x: unknown) => T | null,
): Promise<LlmJsonWithRepairResult<T>> {
  const { result, usage1, usage2 } = await jsonWithRepair(
    (o) => dispatchCompleteFor(cfg, o, true),
    opts,
    validate,
  )
  const usage =
    usage1 && usage2
      ? {
          prompt_tokens: usage1.prompt_tokens + usage2.prompt_tokens,
          completion_tokens: usage1.completion_tokens + usage2.completion_tokens,
          total_tokens: usage1.total_tokens + usage2.total_tokens,
        }
      : (usage2 ?? usage1)
  return { result, usage }
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
    // Output budget for the ping. Must be GENEROUS, not 1: reasoning models
    // (OpenAI GPT-5, DeepSeek V4, Gemini 2.5 thinking) spend hidden reasoning
    // tokens before any visible output, so a tiny cap is exhausted before "ok"
    // is emitted — OpenAI 400s with "Could not finish the message … reached
    // max_tokens". The prompt keeps the real reply to one word, so the actual
    // spend stays ~tens of tokens despite this ceiling.
    maxTokens: 1024,
    // The ping's own SHORT window (15s, not the 60s default) — expressed as
    // timeoutMs so the adapter owns the timeout signal and can tell a timeout
    // apart from a cancellation. `signal` stays the CALLER's cancellation
    // channel and is now composed with the window rather than replacing it.
    timeoutMs: 15_000,
    ...(signal ? { signal } : {}),
  }

  switch (provider.transport) {
    case 'openai-compat':
      await openaiCompatComplete(provider, model, opts, false)
      return
    case 'anthropic':
      await anthropicComplete(provider, model, opts)
      return
    case 'gemini':
      // The gemini PING stays uncapped (pinned decision): Gemini 2.5 thinking
      // models can exhaust a small maxOutputTokens on hidden thinking before
      // emitting text, which would read as a failed key. Real tasks pass their
      // own generous maxTokens; only this ping strips it.
      await geminiComplete(provider, model, { ...opts, maxTokens: undefined })
      return
  }
}
