/**
 * llmToolLoop tests (Plan G part 2 — agentic deep review).
 *
 * Coverage:
 *   - openai-compat: tool round-trip wire shapes (tools array, tool_calls,
 *     role:'tool' results), multi-call rounds, usage summing, budget
 *     exhaustion (tool_choice 'none' + nudge), tool-error feedback
 *   - anthropic: tools/input_schema, tool_use → tool_result (is_error),
 *     usage summing from input/output tokens
 *   - gemini: functionDeclarations, functionCall → functionResponse parts
 *   - transport errors mid-loop → LlmError propagation
 *   - modelSupportsTools capability flag
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { llmToolLoop, DEFAULT_MAX_TOOL_CALLS } from './llmToolLoop'
import { setTransientRetryPolicyForTests } from './transientRetry'
import type { LlmToolDef } from './llmToolLoop'
import { LlmError } from './llm'
import { PROVIDERS, getProvider, modelSupportsTools } from './providers'
import {
  setDeepseekKey,
  setAnthropicKey,
  setGeminiKey,
  setAiProvider,
} from '../settings/settings'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOLS: LlmToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a file at the PR head',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
]

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function openaiToolCallResponse(
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
    usage,
  }
}

function openaiFinalResponse(
  content: string,
  usage = { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
) {
  return {
    id: 'chatcmpl-2',
    object: 'chat.completion',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content } },
    ],
    usage,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  // Terminal-error expectations in this suite (e.g. a mid-loop 429) assume no
  // transient retry — retry behavior is covered by transientRetry.test.ts.
  setTransientRetryPolicyForTests({ maxRetries: 0 })
})

afterEach(() => {
  setTransientRetryPolicyForTests(null)
})

// ===========================================================================
// capability flag
// ===========================================================================

describe('modelSupportsTools', () => {
  it('defaults to true when the flag is omitted', () => {
    const deepseek = getProvider('deepseek')!
    const flash = deepseek.models.find((m) => m.id === 'deepseek-v4-flash')!
    expect(modelSupportsTools(flash)).toBe(true)
  })

  it('legacy deepseek-reasoner is flagged unsupported', () => {
    const deepseek = getProvider('deepseek')!
    const reasoner = deepseek.models.find((m) => m.id === 'deepseek-reasoner')!
    expect(modelSupportsTools(reasoner)).toBe(false)
  })

  it('all non-legacy models across providers support tools', () => {
    for (const p of PROVIDERS) {
      const def = p.models.find((m) => m.id === p.defaultModel)!
      expect(modelSupportsTools(def)).toBe(true)
    }
  })
})

// ===========================================================================
// openai-compat transport (DeepSeek default path)
// ===========================================================================

describe('llmToolLoop — openai-compat (DeepSeek)', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
    setAiProvider('deepseek')
  })

  it('executes a 2-round tool conversation with correct wire shapes and summed usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(openaiToolCallResponse([{ id: 'call_1', name: 'read_file', args: { path: 'src/a.ts' } }])),
      )
      .mockResolvedValueOnce(makeJsonResponse(openaiFinalResponse('{"verdict":"ok"}')))
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'file contents here' })
    const events: { name: string; detail: string }[] = []

    const result = await llmToolLoop({
      system: 'sys',
      user: 'usr',
      tools: TOOLS,
      executeTool,
      humanize: (name, args) => `Reading ${String(args.path)}…`,
      onToolEvent: (ev) => events.push(ev),
    })

    expect(result.content).toBe('{"verdict":"ok"}')
    expect(result.toolCallsUsed).toBe(1)
    // Usage summed across both rounds: 120 + 230
    expect(result.usage).toEqual({ prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 })
    expect(executeTool).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' })
    expect(events).toEqual([{ name: 'read_file', detail: 'Reading src/a.ts…' }])

    // Round 1 request: tools array in OpenAI function shape
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body1.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file at the PR head', parameters: TOOLS[0].parameters },
      },
    ])
    expect(body1.stream).toBeUndefined()

    // Round 2 request: assistant tool_calls turn + role:'tool' result appended
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file' } }],
    })
    expect(body2.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'file contents here',
    })
  })

  it('executes multiple tool calls in a single round', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(
          openaiToolCallResponse([
            { id: 'call_a', name: 'read_file', args: { path: 'a.ts' } },
            { id: 'call_b', name: 'read_file', args: { path: 'b.ts' } },
          ]),
        ),
      )
      .mockResolvedValueOnce(makeJsonResponse(openaiFinalResponse('done')))
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'x' })
    const result = await llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool })

    expect(result.toolCallsUsed).toBe(2)
    expect(executeTool).toHaveBeenCalledTimes(2)
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    const toolMessages = body2.messages.filter((m: { role: string }) => m.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.map((m: { tool_call_id: string }) => m.tool_call_id)).toEqual(['call_a', 'call_b'])
  })

  it('feeds executor errors back as Error: tool messages and continues', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(openaiToolCallResponse([{ id: 'call_1', name: 'read_file', args: { path: 'gone.ts' } }])),
      )
      .mockResolvedValueOnce(makeJsonResponse(openaiFinalResponse('answer without that file')))
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: false, content: 'File not found at head ref: gone.ts' })
    const result = await llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool })

    expect(result.content).toBe('answer without that file')
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.messages[3].content).toBe('Error: File not found at head ref: gone.ts')
  })

  it('hard-stops at the call budget: disables tools and demands the final answer', async () => {
    // Model requests one tool call per round, forever.
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.tool_choice === 'none') {
        return Promise.resolve(makeJsonResponse(openaiFinalResponse('forced final')))
      }
      return Promise.resolve(
        makeJsonResponse(openaiToolCallResponse([{ id: `call_${body.messages.length}`, name: 'read_file', args: { path: 'x.ts' } }])),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'y' })
    const result = await llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool, maxToolCalls: 3 })

    expect(result.content).toBe('forced final')
    expect(result.toolCallsUsed).toBe(3)
    expect(executeTool).toHaveBeenCalledTimes(3)

    // The forced-final request carries the budget nudge as a user message
    const finalCall = fetchMock.mock.calls.find(
      (c) => JSON.parse((c[1] as RequestInit).body as string).tool_choice === 'none',
    )!
    const finalBody = JSON.parse(finalCall[1].body as string)
    const lastMessage = finalBody.messages[finalBody.messages.length - 1]
    expect(lastMessage.role).toBe('user')
    expect(lastMessage.content).toContain('Tool budget exhausted')
  })

  it('default budget is 8 tool calls', () => {
    expect(DEFAULT_MAX_TOOL_CALLS).toBe(8)
  })

  it('propagates transport errors mid-loop as LlmError (no hang)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(openaiToolCallResponse([{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }])),
      )
      .mockResolvedValueOnce(makeJsonResponse({ error: 'rate limited' }, 429))
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'x' })
    await expect(
      llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool }),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'rate-limited' })
  })

  it('throws invalid-output when the model returns neither text nor tool calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeJsonResponse({
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null } }],
        }),
      ),
    )
    await expect(
      llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool: vi.fn() }),
    ).rejects.toBeInstanceOf(LlmError)
  })

  it('throws no-key when the provider key is missing', async () => {
    localStorage.clear()
    await expect(
      llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool: vi.fn() }),
    ).rejects.toMatchObject({ kind: 'no-key' })
  })
})

// ===========================================================================
// anthropic transport
// ===========================================================================

describe('llmToolLoop — anthropic', () => {
  beforeEach(() => {
    setAnthropicKey('sk-ant-test')
    setAiProvider('anthropic')
  })

  it('round-trips tool_use → tool_result blocks and sums input/output usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 'msg_1',
          type: 'message',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me verify that.' },
            { type: 'tool_use', id: 'toolu_abc', name: 'read_file', input: { path: 'src/a.ts' } },
          ],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 'msg_2',
          type: 'message',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"level":"minor-changes"}' }],
          usage: { input_tokens: 80, output_tokens: 20 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'verified contents' })
    const result = await llmToolLoop({ system: 'sys', user: 'usr', tools: TOOLS, executeTool })

    expect(result.content).toBe('{"level":"minor-changes"}')
    expect(result.toolCallsUsed).toBe(1)
    expect(result.usage).toEqual({ prompt_tokens: 130, completion_tokens: 30, total_tokens: 160 })

    // Round 1: anthropic tool shape (input_schema, not parameters)
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body1.tools).toEqual([
      { name: 'read_file', description: 'Read a file at the PR head', input_schema: TOOLS[0].parameters },
    ])
    expect(body1.system).toBe('sys')

    // Round 2: assistant content blocks echoed + user tool_result message
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.messages[1].role).toBe('assistant')
    expect(body2.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'verified contents' }],
    })
  })

  it('marks failed tool results with is_error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'gone.ts' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          content: [{ type: 'text', text: 'final' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: false, content: 'not found' })
    await llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool })

    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'not found',
      is_error: true,
    })
  })

  it('forces the final answer with tool_choice {type:"none"} at budget exhaustion', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.tool_choice?.type === 'none') {
        return Promise.resolve(
          makeJsonResponse({ content: [{ type: 'text', text: 'forced' }], usage: { input_tokens: 1, output_tokens: 1 } }),
        )
      }
      return Promise.resolve(
        makeJsonResponse({
          content: [{ type: 'tool_use', id: 'toolu_x', name: 'read_file', input: { path: 'x' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await llmToolLoop({
      system: 's',
      user: 'u',
      tools: TOOLS,
      executeTool: vi.fn().mockResolvedValue({ ok: true, content: 'x' }),
      maxToolCalls: 2,
    })
    expect(result.content).toBe('forced')
    expect(result.toolCallsUsed).toBe(2)
  })
})

// ===========================================================================
// gemini transport
// ===========================================================================

describe('llmToolLoop — gemini', () => {
  beforeEach(() => {
    setGeminiKey('AIza-test')
    setAiProvider('gemini')
  })

  it('round-trips functionCall → functionResponse parts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'read_file', args: { path: 'src/a.ts' } } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5, totalTokenCount: 45 },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: '{"answer":42}' }] } }],
          usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 10, totalTokenCount: 70 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: true, content: 'gemini file body' })
    const result = await llmToolLoop({ system: 'sys', user: 'usr', tools: TOOLS, executeTool })

    expect(result.content).toBe('{"answer":42}')
    expect(result.toolCallsUsed).toBe(1)
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 })

    // Round 1: functionDeclarations shape, non-streaming endpoint
    expect(fetchMock.mock.calls[0][0]).toContain(':generateContent')
    expect(fetchMock.mock.calls[0][0]).not.toContain('streamGenerateContent')
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body1.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'read_file', description: 'Read a file at the PR head', parameters: TOOLS[0].parameters },
        ],
      },
    ])

    // Round 2: model functionCall turn + user functionResponse part
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.contents[1].role).toBe('model')
    expect(body2.contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'read_file', response: { result: 'gemini file body' } } },
      ],
    })
  })

  it('returns tool errors inside the functionResponse payload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'gone' } } }] } }],
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({ candidates: [{ content: { parts: [{ text: 'final' }] } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const executeTool = vi.fn().mockResolvedValue({ ok: false, content: 'nope' })
    await llmToolLoop({ system: 's', user: 'u', tools: TOOLS, executeTool })

    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.contents[2].parts[0].functionResponse.response).toEqual({ error: 'nope' })
  })

  it('forces the final answer with functionCallingConfig mode NONE at budget exhaustion', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.toolConfig?.functionCallingConfig?.mode === 'NONE') {
        return Promise.resolve(
          makeJsonResponse({ candidates: [{ content: { parts: [{ text: 'forced gemini' }] } }] }),
        )
      }
      return Promise.resolve(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'x' } } }] } }],
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await llmToolLoop({
      system: 's',
      user: 'u',
      tools: TOOLS,
      executeTool: vi.fn().mockResolvedValue({ ok: true, content: 'x' }),
      maxToolCalls: 1,
    })
    expect(result.content).toBe('forced gemini')
  })
})
