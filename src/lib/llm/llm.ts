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
 *   bridge         — NOT a vendor API: POST 127.0.0.1/v1/infer on the optional
 *                   local bridge, which spawns the user's own Claude Code /
 *                   Codex CLI on their subscription. No JSON mode (the shared
 *                   extract/repair ladder handles it) and usage only when the
 *                   CLI reports it. Streaming goes to /v1/infer/stream, whose
 *                   framing is NDJSON rather than SSE — see bridgeStream.
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
import {
  isAbortException,
  isTimeoutException,
  requestSignals as sharedRequestSignals,
} from '../net/signals'
import { readStoredBridge } from '../bridge/storage'
import { BRIDGE_START_COMMAND } from '../bridge/install'
import {
  bridgeUrl,
  parseBridgeError,
  parseInferResponse,
  parseInferStreamEvent,
  isValidModelId,
  INFER_STREAM_PATH,
  type BridgeCli,
  type InferAgentic,
  type InferRequest,
  type InferUsage,
} from '../bridge/protocol'
import { activeLlmConfig, activeBridgeModel, PROVIDER_KEY_FIELDS } from './config'
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
  /**
   * LOCAL BRIDGE ONLY — the EFFECTIVE model this participant's CLI should run
   * (`--model <id>`), already resolved by config.ts's resolvePanel from the
   * panel row's own choice falling back to the global `bridgeModel`.
   * `undefined` → no flag, so the CLI keeps its own default.
   *
   * It is carried on the CONFIG rather than read from settings at the transport
   * because a panel can hold several bridge participants that differ ONLY here
   * — one generator on `fable`, a verifier on `opus`, the same CLI, the same
   * subscription. A transport that asked settings would give all of them the
   * same answer, which is the bug this replaces.
   */
  bridgeModel?: string
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

// The abort/timeout discriminants and the signal combinators live in
// net/signals.ts — the VCS API clients need exactly the same two, and this
// module's public surface (anySignal / manualAnySignal) is preserved by the
// re-export below so no caller or test has to move.
export { anySignal, manualAnySignal } from '../net/signals'

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

/**
 * Classify a RAW engine exception that escaped a transport unmapped — 'aborted'
 * or 'timeout' when it is recognisably one, else null.
 *
 * The UI boundary (describeTaskError) uses this as defence in depth. #233
 * classified the transports; the reported regression came from ONE unguarded
 * response-body read, which let a DOMException reach the panel with the
 * engine's own "The user aborted a request." text intact. Any future
 * un-audited fetch would do the same, so the last gate before the UI classifies
 * too rather than trusting every call site to have been wrapped.
 */
export function rawTransportKind(err: unknown): 'aborted' | 'timeout' | null {
  if (err instanceof LlmError) return null
  if (isTimeoutException(err)) return 'timeout'
  if (isAbortException(err)) return 'aborted'
  return null
}

/**
 * Read a response body inside the SAME classification boundary as the fetch.
 *
 * `fetch()` resolves as soon as the response HEADERS arrive; the body streams
 * afterwards. So a per-request window that fires mid-body rejects the READ, not
 * the fetch — and Blink reports that as a plain AbortError. Reading the body
 * outside the adapter's try/catch therefore bypasses mapFetchError entirely.
 * That was exactly the hole behind the reported "The user aborted a request."
 * tooltips: #233 wrapped the SSE reader loop but not the non-streaming reads,
 * and the biggest reviewers (the largest responses, hence the longest reads)
 * were the ones whose body read was still in flight when the window expired.
 */
export async function readBody<T>(
  read: () => Promise<T>,
  timeoutSignal?: AbortSignal,
): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (err instanceof LlmError) throw err
    mapFetchError(err, timeoutSignal)
  }
}

// ---------------------------------------------------------------------------
// Signal composition
// ---------------------------------------------------------------------------

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
  return sharedRequestSignals(callerSignal, timeoutMs ?? DEFAULT_TIMEOUT_MS)
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
  // The local bridge has no API key: its credential is the pairing token the
  // bridge printed, stored by the Local bridge settings section. Narrowed on
  // the ID (not the transport) so PROVIDER_KEY_FIELDS below sees ApiProviderId.
  if (provider.id === 'bridge') {
    const stored = readStoredBridge()
    if (stored === null) throw new LlmError('no-key', BRIDGE_NOT_PAIRED_MESSAGE)
    return stored.token
  }
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

  const data = (await readBody(() => res!.json(), timeoutSignal)) as {
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

  const data = (await readBody(() => res!.json(), timeoutSignal)) as {
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

  const data = (await readBody(() => res!.json(), timeoutSignal)) as {
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
// bridge transport — the user's OWN Claude Code / Codex CLI, over 127.0.0.1
//
// Not a vendor API. The "request" is a POST to the local bridge, which spawns
// the CLI the user already pays for. Three consequences shape this adapter:
//
//   1. NO JSON MODE. A CLI returns whatever the model wrote. Anthropic's
//      forced-tool JSON mode (#232) is unreachable here, so `json: true` falls
//      back to INSTRUCTING the model — and the answer then goes through the
//      SAME extractJsonCandidate / repair ladder every other provider's
//      fallback uses. There is deliberately no second JSON path.
//   2. USAGE MAY BE UNKNOWN. `claude` reports tokens, `codex` does not. When it
//      is unknown we OMIT `usage` — exactly as openaiCompatComplete does for a
//      provider that sent none — rather than reporting a zero that would render
//      as "this cost nothing".
//   3. STREAMING IS A SECOND ROUTE, not a flag on the first: /v1/infer/stream,
//      framed as NDJSON. A bridge too old to have it 404s and the transport
//      falls back to the one-shot route — transparently, but never silently:
//      `bridgeLastStreamMode()` records which of the two actually happened.
// ===========================================================================

/**
 * The instruction appended to the system prompt when a caller asks for JSON.
 *
 * TRANSPORT-level, not task-level: it says how to FORMAT the answer and nothing
 * about what to answer, so it is the bridge's equivalent of
 * `response_format: json_object` — not a task prompt, and not a reason to touch
 * any PROMPT_VERSIONS entry.
 */
export const BRIDGE_JSON_INSTRUCTION =
  'Respond with a single valid JSON value and nothing else: no prose before or after it, no explanation, and no markdown code fence.'

/**
 * The instruction appended to the system prompt when the caller asks for an
 * AGENTIC bridge run.
 *
 * TRANSPORT-level, exactly like BRIDGE_JSON_INSTRUCTION above and for the same
 * reason: it describes a CAPABILITY THIS TRANSPORT HAS — "you can open files
 * yourself" — and says nothing about what to review or how to judge it. It is
 * the bridge's equivalent of handing an API model a `tools` array, which is
 * likewise not part of any task prompt. So it is NOT a task prompt and NOT a
 * reason to touch any PROMPT_VERSIONS entry.
 *
 * It is needed because the two ends know different halves of the situation. The
 * CLI is given real tools, but the TASK prompt was written for a single-pass
 * reviewer that had none, so nothing in it invites the model to look anything
 * up. Without this sentence a tool-equipped CLI frequently answers from the
 * diff alone — technically agentic, substantively not.
 */
export const BRIDGE_AGENTIC_INSTRUCTION =
  'You can read the files in this repository yourself with your Read, Glob and Grep tools, ' +
  'and the working tree you are reading is the code under review. ' +
  'Use them to check any claim that depends on code outside the excerpt you were given — ' +
  'open the file, find the callers, confirm the symbol — before you assert it. ' +
  'You have read-only access: you cannot modify anything, so there is no risk in looking.'

/** Shown when the user picked the bridge but never paired one. */
export const BRIDGE_NOT_PAIRED_MESSAGE =
  'No local bridge is paired. Open Settings → Local bridge and paste the pairing token the bridge printed.'

/**
 * Shown when the bridge was paired but is not answering — the mid-review case.
 *
 * It names the command from Settings → Local bridge (lib/bridge/install.ts),
 * because that is the one the user actually ran: since #239 the primary install
 * is the downloaded release bundle, and `pnpm bridge` is the build-it-yourself
 * fallback. Telling someone mid-review to run a command from a checkout they
 * may not have would be a detour, not an instruction.
 */
export const BRIDGE_UNREACHABLE_MESSAGE =
  `The local bridge is not responding. Start it in your repo (${BRIDGE_START_COMMAND}), or pick an API provider in Settings → AI models.`

/**
 * Map a bridge failure onto an LlmError.
 *
 * The rule the whole feature rests on: a bridge failure NEVER silently becomes
 * an API-key call. The user chose to spend their subscription; quietly falling
 * back to a metered provider would spend their money without asking. So every
 * branch here throws, with a message that says what to do about it.
 */
async function mapBridgeHttpError(res: Response, timeoutSignal?: AbortSignal): Promise<never> {
  const body = await readBody(() => res.json().catch(() => null), timeoutSignal)
  const { code, message } = parseBridgeError(body)
  mapBridgeErrorCode(code, message, res.status)
}

/**
 * The bridge's failure vocabulary → an LlmError. ONE copy, because the
 * streaming route carries exactly the same codes in an NDJSON `error` event
 * that the one-shot route carries in an HTTP status, and two mappings would
 * mean two sets of user-facing copy for one set of failures.
 *
 * `status` is the RETRY LEVER, not decoration — see the table below. The
 * streaming caller passes `undefined` once it has emitted a delta, because a
 * retry would re-emit text the consumer already has.
 */
function mapBridgeErrorCode(
  code: string | null,
  message: string,
  status: number | undefined,
): never {
  // WHETHER `status` IS ATTACHED IS A RETRY DECISION, not decoration:
  // withTransientRetry retries ANY LlmError carrying `status >= 500`. The
  // bridge's failures are mostly 5xx, and most of them are deterministic — so
  // the status is attached only where another attempt could genuinely differ.
  //
  //   RETRIED    cli-failed (502)  a CLI run that failed can succeed next time
  //              unknown 5xx       a newer bridge's transient failure
  //   NOT        cli-unavailable   the CLI is not installed; waiting never
  //                                installs it, and 3 backoffs × ~50 tasks in
  //                                a review is minutes of certain failure
  //              timeout           the CLI already burned the full budget;
  //                                re-running it spends that again, ×3
  //              not-implemented   an old bridge does not grow the route
  //                                mid-review
  // `detail` is attached only when there IS a status. A mid-stream failure has
  // none (the 200 was committed before the CLI produced a byte), and that is
  // also exactly when a retry would be wrong — see bridgeStream.
  const detail = status === undefined ? undefined : { status }
  const httpSuffix = status === undefined ? '' : ` (HTTP ${status})`
  switch (code) {
    case 'unauthorized':
      throw new LlmError('auth', 'The local bridge rejected its pairing token. The bridge mints a new one every time it starts — re-pair it in Settings → Local bridge.', detail)
    case 'cli-unavailable':
      throw new LlmError('no-key', message || 'That CLI is not installed on this machine.')
    case 'timeout':
      throw new LlmError('timeout', message || TIMED_OUT_MESSAGE)
    case 'not-implemented':
      throw new LlmError('server', 'This local bridge is too old to run inference. Update it and restart.')
    case 'forbidden-origin':
    case 'forbidden-host':
      throw new LlmError('auth', 'The local bridge refused this origin. Restart it with --allow-origin for this URL.', detail)
    case 'forbidden-path':
    case 'bad-request':
    case 'payload-too-large':
      // Our own request was wrong. Sending it again cannot fix it.
      throw new LlmError('server', message || `The local bridge refused the request${httpSuffix}.`)
    case 'cli-failed':
      throw new LlmError('server', message || `The local bridge could not run the CLI${httpSuffix}.`, detail)
    default:
      // An unrecognised code must never crash the client: protocol v1 codes are
      // additive, so a newer bridge can legitimately send one we do not know.
      throw new LlmError('server', message || `The local bridge answered with an error${httpSuffix}.`, detail)
  }
}

async function bridgeComplete(
  _provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmCompleteOpts,
  includeUsage: boolean,
  /**
   * The model this CLI should run, ALREADY RESOLVED by the caller (row choice →
   * global default → undefined). Required rather than optional so every call
   * site has to decide which participant it is speaking for; `undefined` means
   * "send no --model flag", never "look it up yourself".
   */
  bridgeModel: string | undefined,
  /**
   * Run the CLI WITH its read-only tools, so it investigates the working tree.
   *
   * The CALLER is responsible for having checked `capabilities.inferAgentic`
   * first — see bridgeAgenticReady(). This function faithfully reports what came
   * back (`agentic` present or absent) and never infers grounding from having
   * asked for it.
   */
  agentic = false,
  // The extra field is on THIS function's return, not on LlmCompleteResult:
  // that shape is what all six providers return, and a bridge-only field there
  // would be permanently undefined for the other five. Callers that assign the
  // result to an LlmCompleteResult simply ignore it.
): Promise<LlmCompleteResult & { bridgeAgentic?: InferAgentic | null }> {
  const stored = readStoredBridge()
  // 'no-key' is the honest kind: the pairing token IS this provider's
  // credential, and the UI's no-key copy is "configure your provider".
  if (stored === null) throw new LlmError('no-key', BRIDGE_NOT_PAIRED_MESSAGE)

  const { system, user, json, signal, maxTokens, timeoutMs } = opts
  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

  // Both instructions are TRANSPORT-level and compose: an agentic run that also
  // wants JSON is told it may look things up AND how to shape the answer.
  let effectiveSystem = system
  if (agentic) effectiveSystem = `${effectiveSystem}\n\n${BRIDGE_AGENTIC_INSTRUCTION}`
  if (json) effectiveSystem = `${effectiveSystem}\n\n${BRIDGE_JSON_INSTRUCTION}`

  const payload: InferRequest = {
    cli: bridgeCliFor(model),
    prompt: user,
    system: effectiveSystem,
    // The bridge clamps this to its own ceiling; sending our window keeps the
    // two budgets aligned so the CLI is killed at roughly the moment the
    // browser would have given up anyway.
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  if (maxTokens !== undefined) payload.maxOutputTokens = maxTokens
  // `model` here is the CLI to spawn; WHICH MODEL that CLI runs is a separate,
  // PER-PARTICIPANT choice, because the bridge provider's "models" are process
  // names. Left unset the flag is omitted entirely and the CLI keeps its own
  // default. Re-validated at the last possible moment: this is the only
  // caller-supplied string that reaches the bridge's argv, and the bridge
  // rejects a bad one too (#253) — neither end trusts the other to have checked.
  if (bridgeModel !== undefined && isValidModelId(bridgeModel)) payload.model = bridgeModel
  // Only ever literal true. An older bridge ignores the field and answers with
  // no `agentic` report, which is precisely how the caller finds out.
  if (agentic) payload.agentic = true

  let res: Response
  try {
    res = await fetch(bridgeUrl(stored.port, '/v1/infer'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stored.token}` },
      // Bearer-token authenticated; never attach ambient cookies.
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify(payload),
      signal: effectiveSignal,
    })
  } catch (err) {
    // mapFetchError preserves the #233/#234 abort-vs-timeout split. A genuine
    // connection refusal lands on 'network', and THAT is the mid-review
    // disconnect case, so it gets the actionable message rather than the
    // engine's "Failed to fetch".
    if (isAbortException(err) || isTimeoutException(err)) mapFetchError(err, timeoutSignal)
    throw new LlmError('network', BRIDGE_UNREACHABLE_MESSAGE)
  }

  if (!res.ok) await mapBridgeHttpError(res, timeoutSignal)

  const body = await readBody(() => res.json(), timeoutSignal)
  const parsed = parseInferResponse(body)
  if (parsed === null) {
    throw new LlmError('server', 'The local bridge returned a malformed answer.')
  }

  // Usage is reported ONLY when the CLI reported it. `total_tokens` is the sum
  // of two numbers we actually have — never an estimate.
  let usage: LlmUsage | undefined
  if (includeUsage && parsed.usage) {
    usage = {
      prompt_tokens: parsed.usage.inputTokens,
      completion_tokens: parsed.usage.outputTokens,
      total_tokens: parsed.usage.inputTokens + parsed.usage.outputTokens,
    }
  }

  // The report RIDES ON THE RESULT, and must never become a module-level
  // "last call" latch.
  //
  // Up to MAX_INFLIGHT_LLM_CALLS bridge calls are in flight at once (a review
  // runs its tasks concurrently, and deep multi-gen runs several generators).
  // A latch would be written by whichever call parsed last and read by whichever
  // resumed next — there is an await between the write and the read, so those
  // are not the same call. That race decides whether we report a review as
  // grounded, so it gets a per-call value, not a shared slot.
  return { content: parsed.text, usage, truncated: parsed.truncated, bridgeAgentic: parsed.agentic ?? null }
}

/** What an agentic bridge completion produced, report included. */
export interface BridgeAgenticResult {
  content: string
  usage?: LlmUsage
  /**
   * The CLI's own report of what its tools did. NULL when the bridge did not
   * run agentically — an older bridge that ignored the flag, which is the case
   * that must never be mistaken for a grounded review.
   */
  agentic: InferAgentic | null
}

/**
 * One agentic bridge completion: the CLI runs its OWN read-only tool loop
 * against the served working tree and returns a finished answer.
 *
 * This is the delegated deep-review path. It is a SINGLE round trip on purpose
 * — the loop happens inside the CLI, not here — so there is no conversation to
 * accumulate and no per-round budget to spend. See llmToolLoop's bridge arm.
 */
export async function bridgeAgenticComplete(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmCompleteOpts,
  bridgeModel: string | undefined,
): Promise<BridgeAgenticResult> {
  const result = await bridgeComplete(provider, model, opts, true, bridgeModel, true)
  return { content: result.content, usage: result.usage, agentic: result.bridgeAgentic ?? null }
}

/**
 * How the LAST bridge stream was actually delivered.
 *
 * Read by the settings UI (and by anyone debugging "why doesn't it type out?")
 * so the app can answer honestly instead of implying a stream it never got.
 * Deliberately a fact recorded after the event, never a promise made before
 * one: `null` means no bridge stream has run in this session.
 *
 *   'streamed'    — deltas arrived from the CLI as the model wrote them.
 *   'cli-one-shot'— the bridge streams, but this CLI has no partial output.
 *   'no-route'    — the bridge is older than the streaming route.
 */
export type BridgeStreamMode = 'streamed' | 'cli-one-shot' | 'no-route'

let lastBridgeStreamMode: BridgeStreamMode | null = null

export function bridgeLastStreamMode(): BridgeStreamMode | null {
  return lastBridgeStreamMode
}

/** FOR TESTS ONLY. */
export function _resetBridgeStreamModeForTest(): void {
  lastBridgeStreamMode = null
}

/**
 * The one-shot fallback: run `/v1/infer` and hand the finished answer over as
 * a single delta.
 *
 * Used when the paired bridge predates `/v1/infer/stream` (it 404s). NOT a
 * silent degradation: `lastBridgeStreamMode` records it, and nothing in this
 * path ever claims to have streamed. Emitting one delta rather than none is
 * what keeps a delta-rendered panel from staying blank for a perfectly good
 * answer.
 */
async function bridgeStreamViaOneShot(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
  includeUsage: boolean,
  /** Passed straight through, so the fallback runs the SAME model the stream would have. */
  bridgeModel: string | undefined,
): Promise<LlmStreamResult> {
  const completeOpts: LlmCompleteOpts = { system: opts.system, user: opts.user }
  if (opts.signal !== undefined) completeOpts.signal = opts.signal
  if (opts.timeoutMs !== undefined) completeOpts.timeoutMs = opts.timeoutMs

  const result = await bridgeComplete(provider, model, completeOpts, includeUsage, bridgeModel)
  if (result.content) onDelta(result.content)
  return result.usage ? { content: result.content, usage: result.usage } : { content: result.content }
}

/**
 * Streaming over the bridge — `POST /v1/infer/stream`, NDJSON.
 *
 * #238 shipped inference with the whole answer in one delta and said what was
 * missing: event framing, mid-stream abort on both sides, and cancellation
 * through the child process. This is that route's client.
 *
 * THREE THINGS THIS HAS TO GET EXACTLY RIGHT:
 *
 * 1. EVERY READ IS INSIDE THE MAPPED BOUNDARY. `fetch()` resolves when the
 *    HEADERS arrive; the body streams after. So our per-request window firing
 *    mid-answer rejects `reader.read()`, not the fetch — and Blink reports
 *    that as a plain AbortError, which reads as a cancellation unless the
 *    timeout signal is consulted. #234's regression was exactly one body read
 *    left outside the try/catch. The read loop below is wrapped whole, and an
 *    LlmError thrown INSIDE it (from an NDJSON `error` event) is rethrown
 *    untouched rather than re-classified as a network failure.
 *
 * 2. A FAILURE IS NEVER A SHORT ANSWER. A stream that ends without `done` was
 *    cut; it throws. A mid-stream `error` event throws. Neither is allowed to
 *    return the partial text as if the model had finished.
 *
 * 3. NO SILENT PAID FALLBACK. Every failure path throws, exactly as
 *    bridgeComplete's does. The only fallback here is to the bridge's OWN
 *    one-shot route on an older bridge — never to a metered API.
 */
async function bridgeStream(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmStreamOpts,
  onDelta: (text: string) => void,
  includeUsage: boolean,
  /** See bridgeComplete — already resolved by the caller, never looked up here. */
  bridgeModel: string | undefined,
): Promise<LlmStreamResult> {
  const stored = readStoredBridge()
  if (stored === null) throw new LlmError('no-key', BRIDGE_NOT_PAIRED_MESSAGE)

  const { system, user, signal, timeoutMs } = opts
  const { timeoutSignal, effectiveSignal } = requestSignals(signal, timeoutMs)

  const payload: InferRequest = {
    cli: bridgeCliFor(model),
    prompt: user,
    system,
    // Same budget on both ends, so the CLI is killed at roughly the moment the
    // browser would have given up anyway.
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  // The streaming route must pick the same model as the one-shot route, or the
  // same review would be answered by two different models depending only on
  // whether the CLI happened to support partial output — so it takes the same
  // already-resolved value, and re-validates it the same way.
  if (bridgeModel !== undefined && isValidModelId(bridgeModel)) payload.model = bridgeModel

  let res: Response
  try {
    res = await fetch(bridgeUrl(stored.port, INFER_STREAM_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stored.token}` },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify(payload),
      signal: effectiveSignal,
    })
  } catch (err) {
    if (isAbortException(err) || isTimeoutException(err)) mapFetchError(err, timeoutSignal)
    throw new LlmError('network', BRIDGE_UNREACHABLE_MESSAGE)
  }

  // AN OLDER BRIDGE. The route does not exist, so it 404s — before spawning
  // anything, so nothing was run and nothing was spent. Fall back to the
  // one-shot route the same bridge does have.
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    lastBridgeStreamMode = 'no-route'
    return bridgeStreamViaOneShot(provider, model, opts, onDelta, includeUsage, bridgeModel)
  }

  if (!res.ok) await mapBridgeHttpError(res, timeoutSignal)

  const bodyStream = res.body
  if (!bodyStream) throw new LlmError('network', 'The local bridge sent no body for a streaming request.')

  const reader = bodyStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let emitted = 0
  let final: { text: string; usage?: InferUsage } | null = null

  try {
    let reading = true
    while (reading) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)

        const event = parseInferStreamEvent(line)
        // Null is SKIP: a blank line, or an event type a newer bridge grew.
        if (event === null) continue

        if (event.type === 'start') {
          lastBridgeStreamMode = event.streaming ? 'streamed' : 'cli-one-shot'
          continue
        }
        if (event.type === 'delta') {
          if (event.text === '') continue
          accumulated += event.text
          emitted += 1
          onDelta(event.text)
          continue
        }
        if (event.type === 'error') {
          // A mid-stream failure carries NO status once a delta has gone out:
          // withTransientRetry would re-run the whole stream and the consumer
          // would see the opening of the answer twice. Before the first delta
          // a retry is exactly as safe as it is on the one-shot route, so the
          // bridge's own retry decision (the code) stands.
          mapBridgeErrorCode(event.code, event.message, emitted === 0 ? 502 : undefined)
        }
        // done
        final = event.usage ? { text: event.text, usage: event.usage } : { text: event.text }
        reading = false
        break
      }
    }
  } catch (err) {
    // An LlmError from an `error` event is already classified — re-mapping it
    // would turn a precise `timeout` into a generic `network`.
    if (err instanceof LlmError) throw err
    // Everything else lands here: a mid-stream timeout (reported by Blink as a
    // plain AbortError, which is why the timeout signal is consulted), a
    // caller cancellation, a dropped connection.
    mapFetchError(err, timeoutSignal)
  } finally {
    reader.releaseLock()
  }

  // THE STREAM ENDED WITHOUT A TERMINATOR. The bridge died, or the socket was
  // cut. Whatever text arrived is partial, and returning it would turn a
  // broken run into a confident short answer.
  if (final === null) {
    throw new LlmError('server', 'The local bridge ended the stream before the answer was finished.')
  }

  // `done.text` is the CLI's own final answer and wins over the concatenation.
  // They agree in practice; when they cannot (a run cut at the output cap) the
  // CLI's version is the one it actually committed to.
  const content = final.text || accumulated

  let usage: LlmUsage | undefined
  if (includeUsage && final.usage) {
    usage = {
      prompt_tokens: final.usage.inputTokens,
      completion_tokens: final.usage.outputTokens,
      total_tokens: final.usage.inputTokens + final.usage.outputTokens,
    }
  }
  return usage ? { content, usage } : { content }
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
          case 'bridge':
            // The active path IS the panel's primary generator in verify mode,
            // so it asks config.ts which model that generator row chose rather
            // than reading the global setting directly.
            return bridgeComplete(provider, model, opts, includeUsage, activeBridgeModel(model.id))
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
          case 'bridge':
            // A bridge participant ignores cfg.key: its credential is the
            // pairing token in localStorage, not a per-participant API key.
            // Its MODEL, though, is per-participant — that is how one
            // subscription runs `fable` here and `opus` on the next row.
            return bridgeComplete(provider, cfg.model, opts, includeUsage, cfg.bridgeModel)
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
          case 'bridge':
            return bridgeStream(provider, model, opts, onDelta, includeUsage, activeBridgeModel(model.id))
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

/**
 * The ping window for an HTTP API provider.
 *
 * Unchanged by the bridge fix below, and deliberately short: a hosted endpoint
 * that cannot answer a one-word prompt inside fifteen seconds genuinely IS
 * broken, and saying so quickly is most of the button's value.
 */
export const API_TEST_TIMEOUT_MS = 15_000

/**
 * The ping window for a BRIDGE provider — a CLI running on this machine.
 *
 * The 15s above was sized for an HTTP round trip and is simply the wrong unit
 * for a local CLI, which pays process startup, config load and an auth check
 * BEFORE the model is reached at all. Measured against the real CLIs on this
 * machine, one-word "reply ok" pings through `/v1/infer`:
 *
 *   codex   n=11   min 4.8s · median 15.6s · max 28.4s   (6 of 11 over 15s)
 *   claude  n=8    min 3.1s · median  8.5s · max 16.7s   (1 of 8  over 15s)
 *
 * So the old window failed codex more often than it passed — the reported bug.
 * It was never a codex-only problem, though: claude blew 15s too once the
 * machine was busy. ONE shared window for both CLIs is therefore the honest
 * shape. Two numbers would encode a difference in kind the data does not show;
 * what it shows is a single slow, high-variance startup cost that both CLIs pay
 * and neither bounds tightly.
 *
 * 90s is ~3x the slowest ping observed on a machine that was NOT heavily
 * loaded, which is the headroom a loaded one needs. It stays under the bridge's
 * own DEFAULT_INFER_TIMEOUT_MS (120s), so it asks the bridge for nothing beyond
 * the budget that side already treats as normal.
 *
 * REVIEWS ARE NOT AFFECTED by any of this. They have always had their own
 * windows — DEFAULT_TIMEOUT_MS, sizeAwareTimeoutMs, and the agentic budget —
 * which is precisely why reviews worked while the test button could not.
 */
export const BRIDGE_TEST_TIMEOUT_MS = 90_000

/**
 * The CLI a bridge model row spawns. ONE rule, shared by the transport and by
 * everything that NAMES the CLI, so a message can never blame a different
 * process than the one that actually ran.
 */
function bridgeCliFor(model: LlmModelDef): BridgeCli {
  return model.id === 'codex' ? 'codex' : 'claude'
}

/** The model a connection test pings: the caller's, else the provider default. */
function resolveTestModel(provider: LlmProviderDef, modelId?: string): LlmModelDef {
  return (
    (modelId ? getModelDef(provider, modelId) : undefined) ??
    getModelDef(provider, provider.defaultModel) ??
    provider.models[0]
  )
}

/**
 * Which CLI a connection test for `providerId` would actually spawn, or null
 * for an HTTP provider.
 *
 * Exported so the settings UI can name that CLI while the test is in flight
 * without re-deriving the resolution. A bridge "model" IS a process name, and
 * the UI's answer has to be the one llmTestConnection reaches — otherwise the
 * progress line would talk about a different CLI than the one being tested.
 */
export function testConnectionCli(providerId: LlmProviderId, modelId?: string): BridgeCli | null {
  const provider = getProvider(providerId)
  if (!provider || provider.transport !== 'bridge') return null
  return bridgeCliFor(resolveTestModel(provider, modelId))
}

/**
 * The actionable half of a failed bridge test: WHICH CLI was slow, roughly how
 * long it was given, and the one thing worth doing about it.
 *
 * It replaces what the user actually saw before this fix — the engine's own
 * "The operation was aborted due to timeout", which names no CLI, carries no
 * duration, and reads as though something had been cancelled. Same split as
 * requestWindow's timeoutDetail and #209's errorDetail: a canned sentence
 * carrying only a label and a duration, never model output.
 */
export function bridgeTestTimeoutMessage(cli: BridgeCli, elapsedMs: number): string {
  return (
    `The ${cli} CLI didn't answer a one-word connection test within ` +
    `${Math.round(elapsedMs / 1000)}s. It is most likely still starting up, signing in, ` +
    `or busy — run \`${cli}\` once in a terminal, then test again.`
  )
}

/**
 * A failed bridge PING, re-told so the user learns which CLI was slow.
 *
 * ONLY a timeout is rewritten. A cancellation stays 'aborted' (#233/#234 — the
 * user cancelled and nothing timed out, so it must never be dressed up as a
 * timeout), and every other failure already carries the bridge's own specific
 * copy, which is better than anything this could say. A RAW engine exception
 * that escaped the transport unmapped is classified here too rather than
 * reaching the UI as engine text — the same last-gate rule describeTaskError
 * applies at the panel boundary.
 */
function mapBridgeTestFailure(err: unknown, cli: BridgeCli, elapsedMs: number): unknown {
  const kind = err instanceof LlmError ? err.kind : rawTransportKind(err)
  if (kind !== 'timeout') return err
  return new LlmError('timeout', bridgeTestTimeoutMessage(cli, elapsedMs))
}

export async function llmTestConnection(
  providerId: LlmProviderId,
  modelId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = getProvider(providerId)
  if (!provider) throw new LlmError('server', `Unknown provider: ${providerId}`)

  const model = resolveTestModel(provider, modelId)

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
    // The ping's own window — expressed as timeoutMs so the adapter owns the
    // timeout signal and can tell a timeout apart from a cancellation.
    // `signal` stays the CALLER's cancellation channel and is composed with the
    // window rather than replacing it.
    //
    // It is SHORTER than the 60s default for an HTTP provider and LONGER for a
    // local CLI, because those two are not the same kind of wait: see the two
    // constants for the measurements behind each.
    timeoutMs: provider.transport === 'bridge' ? BRIDGE_TEST_TIMEOUT_MS : API_TEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  }

  switch (provider.transport) {
    case 'bridge': {
      // A real round-trip through the bridge and into the CLI. It is the only
      // honest connection test here: /v1/health proves the bridge answers but
      // says nothing about whether the CLI is signed in, and guessing from a
      // credentials file on disk is exactly what this feature refuses to do.
      // The ping runs the model a review WOULD run through this CLI, not a
      // blanket default: a green "Save & test" that exercised a different model
      // than the panel's generator would be testing the wrong thing.
      //
      // Timed so a failure can say how long the CLI actually had. The browser's
      // window is what fires in practice — it starts before the request even
      // reaches the bridge, so it always wins the race against the bridge's own
      // (equal) budget, and the bridge's CLI-naming message never arrives.
      const cli = bridgeCliFor(model)
      const startedAt = Date.now()
      try {
        await bridgeComplete(provider, model, opts, false, activeBridgeModel(model.id))
      } catch (err) {
        throw mapBridgeTestFailure(err, cli, Date.now() - startedAt)
      }
      return
    }
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
