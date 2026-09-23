/**
 * llmToolLoop — agentic tool-use loop for deep review (Plan G part 2).
 *
 * Sends tool definitions to the active model, executes the tool calls it
 * requests, appends the results, and repeats until the model returns a final
 * text answer or the call budget exhausts (at which point tools are disabled
 * and the final answer is demanded).
 *
 * Per-transport wire formats (verified 2026-06-13):
 * - openai-compat (DeepSeek direct + OpenAI proxy):
 *     request  body.tools = [{ type:'function', function:{ name, description, parameters } }]
 *     response choices[0].message.tool_calls = [{ id, type:'function', function:{ name, arguments } }]
 *     results  appended as { role:'tool', tool_call_id, content }
 *     forced final: tool_choice = 'none'
 *     DeepSeek function calling: supported on deepseek-v4-flash / v4-pro /
 *     deepseek-chat (api-docs.deepseek.com/guides/function_calling);
 *     legacy deepseek-reasoner does NOT support it (capability-gated upstream
 *     via LlmModelDef.supportsTools — this module assumes the model supports tools).
 * - anthropic:
 *     request  body.tools = [{ name, description, input_schema }]
 *     response content blocks: { type:'text' } + { type:'tool_use', id, name, input }
 *     results  appended as user message content blocks
 *              { type:'tool_result', tool_use_id, content, is_error? }
 *     forced final: tool_choice = { type:'none' }
 * - gemini:
 *     request  body.tools = [{ functionDeclarations: [{ name, description, parameters }] }]
 *     response candidates[0].content.parts: { text } and/or { functionCall:{ name, args } }
 *     results  appended as user content parts { functionResponse:{ name, response } }
 *     forced final: toolConfig.functionCallingConfig.mode = 'NONE'
 *
 * - bridge: NO ROUNDS ARE DRIVEN HERE AT ALL. The user's own CLI is given
 *     read-only tools and runs its own agent loop against the served working
 *     tree, returning a finished answer in ONE call. See
 *     runDelegatedBridgeLoop, which explains why delegating is right where
 *     driving would be wrong, and why that still leaves every call site
 *     unchanged.
 *
 * All rounds are NON-streaming (tool calls don't stream); each round gets a
 * fresh 60 s timeout unless the caller supplies a signal. Usage is summed
 * across rounds so the llm*WithUsage / PostHog token-event pattern keeps
 * working unchanged.
 *
 * Failure honesty: tool executor failures are fed back to the model as
 * tool-result errors (it can proceed without); transport-level failures throw
 * LlmError so callers surface the existing error rendering — never a hang.
 */

import { activeLlmConfig, activeBridgeModel } from './config'
import { gateFor } from './concurrencyGate'
import type { LlmProviderDef, LlmModelDef } from './providers'
import {
  LlmError,
  bridgeAgenticComplete,
  getKeyForProvider,
  buildOpenAICompatHeaders,
  buildAnthropicHeaders,
  buildGeminiHeaders,
  mapFetchError,
  mapHttpError,
  anySignal,
  retryWithCancellation,
} from './llm'
import type { LlmCompleteOpts, LlmUsage } from './llm'
import { sizeAwareTimeoutMs, timeoutDetail } from './requestWindow'
import { INFER_AGENTIC_REQUEST_TIMEOUT_MS } from '../bridge/protocol'
import { estimateTokens } from '../context/pack'

/**
 * Base per-round request window for the deep-mode tool loop (one HTTP call
 * each). A round whose conversation has grown large gets a SCALED window on top
 * of this — see requestWindow.ts.
 */
export const TOOL_LOOP_BASE_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Provider-neutral tool definition (parameters = JSON Schema object). */
export interface LlmToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A single tool invocation requested by the model. */
export interface LlmToolCall {
  /** Transport call id (openai/anthropic). Gemini has none — synthesized. */
  id: string
  name: string
  /** Parsed arguments object ({} when the model sent malformed JSON). */
  args: Record<string, unknown>
}

/** Result of executing one tool call. Executors must never throw. */
export interface LlmToolResult {
  ok: boolean
  /** Tool output on ok, human-readable error message otherwise. */
  content: string
}

/** Activity event for the run indicator ("Reading src/foo.ts…"). */
export interface LlmToolEvent {
  name: string
  /** Humanized one-liner provided by the executor layer. */
  detail: string
}

export interface LlmToolLoopOpts {
  system: string
  user: string
  tools: LlmToolDef[]
  /** Executes one tool call. Must resolve (never reject) — errors as ok:false. */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<LlmToolResult>
  /** Humanizes a call for the activity feed. Falls back to "name(...)". */
  humanize?: (name: string, args: Record<string, unknown>) => string
  onToolEvent?: (ev: LlmToolEvent) => void
  /** Hard cap on executed tool calls across the whole loop. Default 8. */
  maxToolCalls?: number
  signal?: AbortSignal
  /**
   * Provider+model OVERRIDE (Plan P deep multi-gen). When set, the loop runs on
   * THIS provider/model instead of the active config — so each ensemble
   * GENERATOR can run its own deep pass on its own provider. The key is resolved
   * per-provider via getKeyForProvider (same as the active path). Omitted →
   * byte-identical to the active-config behaviour.
   */
  override?: { provider: LlmProviderDef; model: LlmModelDef }
}

export interface LlmToolLoopResult {
  content: string
  usage?: LlmUsage
  toolCallsUsed: number
}

export const DEFAULT_MAX_TOOL_CALLS = 8

/** Safety valve: rounds are bounded even if a model emits 1 call per round. */
function maxRounds(maxToolCalls: number): number {
  return maxToolCalls + 2
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sumUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // malformed arguments JSON — executor receives {} and reports the miss
    }
  }
  return {}
}

/**
 * The stage name folded into a round's timeout copy. Deep review and grounded
 * verification both run through this loop, so it names the ROUND rather than
 * any one task.
 */
const TOOL_LOOP_STAGE = 'This deep-review round'

/**
 * mapFetchError for one loop round, with the round's own size folded into a
 * TIMEOUT so the panel hover says what timed out, how big it was, and what to
 * do — instead of the bare "the model took too long".
 *
 * An error that is ALREADY an LlmError (mapHttpError's, or a nested map) passes
 * through untouched apart from that timeout enrichment.
 */
function mapRoundError(
  err: unknown,
  timeoutSignal: AbortSignal,
  windowMs: number,
  promptTokens: number,
): never {
  let mapped: unknown = err
  if (!(err instanceof LlmError)) {
    try {
      mapFetchError(err, timeoutSignal)
    } catch (e) {
      mapped = e
    }
  }
  if (mapped instanceof LlmError && mapped.kind === 'timeout') {
    throw new LlmError('timeout', timeoutDetail(TOOL_LOOP_STAGE, windowMs, promptTokens))
  }
  throw mapped
}

/**
 * The estimated prompt size of ONE round, from the serialized request body.
 * The conversation grows with every appended tool result, so a late round is
 * genuinely bigger than the first — the window has to be computed per round,
 * not once for the loop.
 */
function roundPromptTokens(body: Record<string, unknown>): number {
  return estimateTokens(JSON.stringify(body))
}

async function postJson(
  providerId: string,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  // The round's window scales with the round's own size (see requestWindow.ts).
  // It used to be a flat 60s: reviewers whose grounded-verification rounds ran
  // to 130k–370k tokens could not possibly answer inside it, so the biggest
  // reviewers failed while the small ones passed.
  const promptTokens = roundPromptTokens(body)
  const windowMs = sizeAwareTimeoutMs(promptTokens) ?? TOOL_LOOP_BASE_TIMEOUT_MS
  // Each deep-mode tool-loop round is a separate non-streaming HTTP call, so it
  // acquires/releases a slot of ITS provider's gate individually (the loop's
  // rounds are sequential, but they coexist with all the OTHER concurrent
  // task/reviewer/verifier calls — the gate caps the union of them, per
  // provider). Transient 429/5xx rounds are retried by the SAME shared wrapper
  // as the llm.ts dispatchers; retry wraps the gate, so a backoff sleep holds
  // no slot, and each attempt builds a fresh 60s timeout signal. Retrying a
  // round is safe: nothing is appended to the conversation until it succeeds.
  return retryWithCancellation(
    () =>
      gateFor(providerId).run(async () => {
        // The caller's signal is COMPOSED with the round's 60s window, never
        // substituted for it (a caller signal used to disable the timeout
        // outright), and the window is kept in hand so mapFetchError can tell
        // "this round timed out" from "someone cancelled us".
        const timeoutSignal = AbortSignal.timeout(windowMs)
        const effectiveSignal = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal
        let res: Response
        try {
          res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: effectiveSignal,
          })
        } catch (err) {
          mapRoundError(err, timeoutSignal, windowMs, promptTokens)
        }
        if (!res!.ok) await mapHttpError(res!)
        // The body read is INSIDE the mapped boundary. fetch() resolves on
        // HEADERS; a window that fires while the body is still streaming
        // rejects THIS read, and Blink reports that as a plain AbortError. It
        // used to be read outside the try/catch, so that DOMException escaped
        // unclassified and the engine's "The user aborted a request." text was
        // rendered verbatim in the reviewer chip's hover.
        try {
          return (await res!.json()) as unknown
        } catch (err) {
          mapRoundError(err, timeoutSignal, windowMs, promptTokens)
        }
      }),
    { providerId, signal },
  )
}

/**
 * One assistant turn: either tool calls to execute, final text, or both
 * (text alongside tool calls is kept as transport-specific raw state).
 */
interface AssistantTurn {
  text: string | null
  toolCalls: LlmToolCall[]
  usage?: LlmUsage
  /** Opaque transport-shaped assistant payload to append to the conversation. */
  raw: unknown
}

/**
 * Transport adapter: owns the conversation state in its native wire shape.
 * `finalOnly` disables tools for the round (budget exhausted).
 */
interface ToolTransport {
  callOnce(finalOnly: boolean): Promise<AssistantTurn>
  appendAssistantTurn(turn: AssistantTurn): void
  appendToolResults(results: { call: LlmToolCall; result: LlmToolResult }[]): void
  appendNudge(text: string): void
}

const BUDGET_NUDGE =
  'Tool budget exhausted — no further tool calls are available. ' +
  'Provide your final answer now using only what you have verified.'

// ---------------------------------------------------------------------------
// openai-compat transport (DeepSeek direct + OpenAI proxy)
// ---------------------------------------------------------------------------

interface OpenAIToolCallWire {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

function createOpenAICompatTransport(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmToolLoopOpts,
): ToolTransport {
  const key = getKeyForProvider(provider)
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ]
  const tools = opts.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

  return {
    async callOnce(finalOnly: boolean): Promise<AssistantTurn> {
      const body: Record<string, unknown> = { model: model.id, messages, tools }
      if (finalOnly) body.tool_choice = 'none'
      const data = (await postJson(
        provider.id,
        `${provider.baseUrl}/chat/completions`,
        buildOpenAICompatHeaders(key, provider.id),
        body,
        opts.signal,
      )) as {
        choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCallWire[] } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }

      const message = data?.choices?.[0]?.message
      if (!message) throw new LlmError('server', 'Missing choices[0].message in response')

      const toolCalls: LlmToolCall[] = (message.tool_calls ?? [])
        .filter((c) => c.type === 'function' || c.function)
        .map((c, i) => ({
          id: c.id ?? `call_${i}`,
          name: c.function?.name ?? '',
          args: parseArgs(c.function?.arguments),
        }))

      let usage: LlmUsage | undefined
      const u = data.usage
      if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number' && typeof u.total_tokens === 'number') {
        usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens }
      }

      return {
        text: typeof message.content === 'string' ? message.content : null,
        toolCalls,
        usage,
        raw: message,
      }
    },
    appendAssistantTurn(turn) {
      const message = turn.raw as { content?: string | null; tool_calls?: OpenAIToolCallWire[] }
      messages.push({
        role: 'assistant',
        content: message.content ?? null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      })
    },
    appendToolResults(results) {
      for (const { call, result } of results) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.ok ? result.content : `Error: ${result.content}`,
        })
      }
    },
    appendNudge(text) {
      messages.push({ role: 'user', content: text })
    },
  }
}

// ---------------------------------------------------------------------------
// anthropic transport
// ---------------------------------------------------------------------------

interface AnthropicBlockWire {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

function createAnthropicTransport(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmToolLoopOpts,
): ToolTransport {
  const key = getKeyForProvider(provider)
  const messages: Record<string, unknown>[] = [{ role: 'user', content: opts.user }]
  const tools = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  return {
    async callOnce(finalOnly: boolean): Promise<AssistantTurn> {
      const body: Record<string, unknown> = {
        model: model.id,
        max_tokens: 4096,
        system: opts.system,
        messages,
        tools,
      }
      if (finalOnly) body.tool_choice = { type: 'none' }
      const data = (await postJson(
        provider.id,
        `${provider.baseUrl}/v1/messages`,
        buildAnthropicHeaders(key),
        body,
        opts.signal,
      )) as {
        content?: AnthropicBlockWire[]
        usage?: { input_tokens?: number; output_tokens?: number }
      }

      const blocks = data?.content ?? []
      const textBlock = blocks.find((b) => b.type === 'text')
      const toolCalls: LlmToolCall[] = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b, i) => ({
          id: b.id ?? `toolu_${i}`,
          name: b.name ?? '',
          args: parseArgs(b.input),
        }))

      let usage: LlmUsage | undefined
      const u = data.usage
      if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
        usage = {
          prompt_tokens: u.input_tokens,
          completion_tokens: u.output_tokens,
          total_tokens: u.input_tokens + u.output_tokens,
        }
      }

      return { text: textBlock?.text ?? null, toolCalls, usage, raw: blocks }
    },
    appendAssistantTurn(turn) {
      messages.push({ role: 'assistant', content: turn.raw })
    },
    appendToolResults(results) {
      messages.push({
        role: 'user',
        content: results.map(({ call, result }) => ({
          type: 'tool_result',
          tool_use_id: call.id,
          content: result.content,
          ...(result.ok ? {} : { is_error: true }),
        })),
      })
    },
    appendNudge(text) {
      messages.push({ role: 'user', content: text })
    },
  }
}

// ---------------------------------------------------------------------------
// gemini transport
// ---------------------------------------------------------------------------

interface GeminiPartWire {
  text?: string
  functionCall?: { name?: string; args?: unknown }
}

function createGeminiTransport(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmToolLoopOpts,
): ToolTransport {
  const key = getKeyForProvider(provider)
  // Gemini has no system role in v1beta generateContent — prepend (same
  // convention as buildGeminiBody in llm.ts).
  const contents: Record<string, unknown>[] = [
    { role: 'user', parts: [{ text: `${opts.system}\n\n${opts.user}` }] },
  ]
  const tools = [
    {
      functionDeclarations: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ]

  return {
    async callOnce(finalOnly: boolean): Promise<AssistantTurn> {
      const body: Record<string, unknown> = { contents, tools }
      if (finalOnly) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
      const data = (await postJson(
        provider.id,
        `${provider.baseUrl}/v1beta/models/${model.id}:generateContent`,
        buildGeminiHeaders(key),
        body,
        opts.signal,
      )) as {
        candidates?: { content?: { parts?: GeminiPartWire[] } }[]
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
      }

      const parts = data?.candidates?.[0]?.content?.parts ?? []
      const text = parts.map((p) => p.text ?? '').join('') || null
      const toolCalls: LlmToolCall[] = parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          // Gemini has no call ids — synthesize; results are matched by name.
          id: `fc_${i}`,
          name: p.functionCall?.name ?? '',
          args: parseArgs(p.functionCall?.args),
        }))

      let usage: LlmUsage | undefined
      const u = data.usageMetadata
      if (u && typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number') {
        usage = {
          prompt_tokens: u.promptTokenCount,
          completion_tokens: u.candidatesTokenCount,
          total_tokens: u.totalTokenCount ?? (u.promptTokenCount + u.candidatesTokenCount),
        }
      }

      return { text, toolCalls, usage, raw: parts }
    },
    appendAssistantTurn(turn) {
      contents.push({ role: 'model', parts: turn.raw })
    },
    appendToolResults(results) {
      contents.push({
        role: 'user',
        parts: results.map(({ call, result }) => ({
          functionResponse: {
            name: call.name,
            response: result.ok ? { result: result.content } : { error: result.content },
          },
        })),
      })
    },
    appendNudge(text) {
      contents.push({ role: 'user', parts: [{ text }] })
    },
  }
}

// ---------------------------------------------------------------------------
// llmToolLoop — the transport-agnostic driver
// ---------------------------------------------------------------------------

function createTransport(opts: LlmToolLoopOpts): ToolTransport {
  // An explicit override (deep multi-gen) routes the loop to a specific
  // provider/model; otherwise fall back to the active config (unchanged).
  const { provider, model } = opts.override ?? activeLlmConfig()
  switch (provider.transport) {
    case 'openai-compat':
      return createOpenAICompatTransport(provider, model, opts)
    case 'anthropic':
      return createAnthropicTransport(provider, model, opts)
    case 'gemini':
      return createGeminiTransport(provider, model, opts)
    case 'bridge':
      // Unreachable: llmToolLoop routes the bridge to runDelegatedBridgeLoop
      // before ever building a transport. The arm stays so that adding a
      // transport without deciding which loop drives it is a compile error
      // rather than a silent fall-through.
      throw new LlmError('server', 'The bridge does not use a round-driving tool transport.')
  }
}

/**
 * The BRIDGE's deep-review path: the CLI runs the agent loop, we do not.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ONE CALL AND NOT A LOOP
 *
 * Everything above this line drives rounds: send tools, receive tool_use,
 * execute, append, send again. That shape is right for an API model, which
 * cannot touch anything itself. It is the WRONG shape for a CLI that is already
 * a full agent — it would be an agent steering an agent through a text pipe,
 * with two tool vocabularies that do not agree and no way to attribute a tool
 * call to either. That objection was always correct and nothing here overturns
 * it.
 *
 * What was wrong was the CONCLUSION drawn from it: that deep review therefore
 * could not run over the bridge at all. The bridge's ordinary call passes
 * `--tools ""` — review123 strips the CLI's tools deliberately — so "the CLI is
 * already an agent" described a capability we had switched off. Switching it
 * back on, narrowed to read-only, gives an agent loop that is BETTER grounded
 * than the API path: it reads the user's real working tree, uncommitted changes
 * included, instead of fetching files through a rate-limited VCS API.
 *
 * So the division of labour is: the CLI owns the loop, and this function owns
 * the contract that the loop's callers already depend on.
 *
 * WHAT THE TOOLKIT IS FOR HERE: nothing, and that is deliberate. `opts.tools`
 * and `opts.executeTool` describe review123's OWN tools, and the CLI neither
 * receives nor can call them — it has its own equivalents pointed at the same
 * code. They are ignored rather than adapted, because an adapter would be the
 * agent-driving-an-agent design this function exists to avoid.
 * ────────────────────────────────────────────────────────────────────────────
 */
async function runDelegatedBridgeLoop(
  provider: LlmProviderDef,
  model: LlmModelDef,
  opts: LlmToolLoopOpts,
): Promise<LlmToolLoopResult> {
  // One honest activity line. There is no per-call feed to mirror: the CLI does
  // not report its tool calls as it makes them, and inventing "Reading foo.ts…"
  // to keep the indicator busy would be describing work we cannot see.
  opts.onToolEvent?.({
    name: 'bridge_agentic',
    detail: `${model.label} is investigating your working tree…`,
  })

  const completeOpts: LlmCompleteOpts = {
    system: opts.system,
    user: opts.user,
    // NAMED EXPLICITLY, because the default would be wrong in a way that looks
    // like a flaky bridge. The transport sends `timeoutMs ?? 60_000`, so
    // omitting it would both abort the fetch at 60 s and TELL the bridge to
    // kill the CLI then — an agent mid-investigation, with the user's
    // subscription already spent on the part it had done.
    timeoutMs: INFER_AGENTIC_REQUEST_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
  const result = await bridgeAgenticComplete(
    provider,
    model,
    completeOpts,
    activeBridgeModel(model.id),
  )

  // The bridge answered, but WITHOUT an agentic report — so the CLI ran
  // tool-less. That is what a bridge predating the agentic release does: it
  // ignores the request field and returns a perfectly good single-pass answer.
  //
  // Returning that text as a deep review is the one outcome this whole feature
  // must not produce, because nobody downstream could tell. deepReview.ts's
  // harness gate normally catches this and falls back to standard review WITH a
  // note; this is the backstop for a call site that reached the loop anyway, and
  // it fails loudly rather than quietly relabelling a shallow answer.
  if (result.agentic === null) {
    throw new LlmError(
      'server',
      'The local bridge ran the CLI without its tools, so this was not a deep review. Update the bridge and restart it.',
    )
  }

  if (result.content === '') {
    throw new LlmError('invalid-output', 'Tool loop ended without a final answer')
  }

  // `toolCallsAtLeast` is a LOWER BOUND the CLI reported (see InferAgentic), and
  // it is passed through as-is rather than rounded up to look busy. Absent means
  // the CLI reported nothing countable, which becomes 0 — the same value a real
  // zero produces. Both mean "we cannot show that it looked anything up", and a
  // caller reading this as an exact count would be over-reading it either way.
  const toolCallsUsed = result.agentic.toolCallsAtLeast ?? 0
  if (toolCallsUsed > 0) {
    opts.onToolEvent?.({
      name: 'bridge_agentic',
      detail: `${model.label} read your working tree (${toolCallsUsed} ${toolCallsUsed === 1 ? 'lookup' : 'lookups'} or more)`,
    })
  }

  const out: LlmToolLoopResult = { content: result.content, toolCallsUsed }
  if (result.usage) out.usage = result.usage
  return out
}

export async function llmToolLoop(opts: LlmToolLoopOpts): Promise<LlmToolLoopResult> {
  // The bridge's loop lives in the CLI, so it branches BEFORE the round driver
  // rather than pretending to be a transport inside it.
  const resolved = opts.override ?? activeLlmConfig()
  if (resolved.provider.transport === 'bridge') {
    return runDelegatedBridgeLoop(resolved.provider, resolved.model, opts)
  }

  const transport = createTransport(opts)
  const maxCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
  const roundCap = maxRounds(maxCalls)

  let usage: LlmUsage | undefined
  let callsUsed = 0
  let nudged = false

  for (let round = 0; round < roundCap; round++) {
    const budgetExhausted = callsUsed >= maxCalls
    if (budgetExhausted && !nudged) {
      transport.appendNudge(BUDGET_NUDGE)
      nudged = true
    }

    const turn = await transport.callOnce(budgetExhausted)
    usage = sumUsage(usage, turn.usage)

    if (turn.toolCalls.length === 0 || budgetExhausted) {
      // Final answer (or forced final round). A model that returns neither
      // text nor tool calls is a broken response.
      if (turn.text === null || turn.text === '') {
        throw new LlmError('invalid-output', 'Tool loop ended without a final answer')
      }
      return { content: turn.text, usage, toolCallsUsed: callsUsed }
    }

    transport.appendAssistantTurn(turn)

    // Execute the round's calls sequentially (byte budget is shared state in
    // the executor layer; sequential keeps accounting deterministic). Calls
    // beyond the remaining budget are answered with an error result instead
    // of being executed.
    const results: { call: LlmToolCall; result: LlmToolResult }[] = []
    for (const call of turn.toolCalls) {
      if (callsUsed >= maxCalls) {
        results.push({
          call,
          result: { ok: false, content: 'Tool call budget exhausted — provide your final answer.' },
        })
        continue
      }
      callsUsed++
      opts.onToolEvent?.({
        name: call.name,
        detail: opts.humanize?.(call.name, call.args) ?? `${call.name}(${JSON.stringify(call.args)})`,
      })
      const result = await opts.executeTool(call.name, call.args)
      results.push({ call, result })
    }
    transport.appendToolResults(results)
  }

  // Round cap exceeded without a final answer — defensive hard stop.
  throw new LlmError('invalid-output', 'Tool loop exceeded round limit without a final answer')
}
