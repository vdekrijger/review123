/**
 * jsonRobustness.test.ts — REPRODUCTION tests for the production failure
 * "LLM produced invalid JSON after repair retry" on the Understand step.
 *
 * These three cases are written BEFORE the fix and fail against the code as it
 * stands (llm.ts:994/1042/1093 call JSON.parse on the RAW model output, and the
 * repair prompt at llm.ts:1006/1054/1104 echoes the ENTIRE previous output):
 *
 *   (a) a model that wraps perfectly valid JSON in a ```json fence
 *   (b) a model that adds a prose preamble/suffix around valid JSON
 *   (c) a TRUNCATED first response, whose full body is echoed back into the
 *       repair prompt — inflating the input that already overflowed
 *
 * They stay in the suite after the fix as the regression pins.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { llmJsonWithRepair, llmJsonWithRepairWithUsage, llmJsonWithRepairFor, type ProviderConfig } from './llm'
import { setTransientRetryPolicyForTests } from './transientRetry'
import { setDeepseekKey } from '../settings/settings'
import { getProvider, getModelDef } from './providers'

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** An openai-compat completion body; `finishReason` opts into a truncation marker. */
function completionBody(content: string, finishReason?: string) {
  return { choices: [{ message: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }] }
}

interface Shape {
  x: number
}
function validate(v: unknown): Shape | null {
  const obj = v as Record<string, unknown>
  return obj && typeof obj.x === 'number' ? (obj as unknown as Shape) : null
}

function userMessageOf(call: unknown): string {
  const init = (call as [string, RequestInit])[1]
  const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] }
  return body.messages.find((m) => m.role === 'user')!.content
}

function cfgFor(providerId: 'deepseek'): ProviderConfig {
  const provider = getProvider(providerId)!
  return { providerId, model: getModelDef(provider, provider.defaultModel)!, key: 'verifier-key' }
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  setTransientRetryPolicyForTests({ maxRetries: 0 })
  setDeepseekKey('sk-test')
})

afterEach(() => {
  setTransientRetryPolicyForTests(null)
})

// ---------------------------------------------------------------------------
// (a) fenced JSON — valid JSON the transport currently rejects
// ---------------------------------------------------------------------------

describe('repro (a): a ```json fenced reply is valid JSON and must parse', () => {
  const FENCED = '```json\n{"x": 1}\n```'

  it('llmJsonWithRepair parses a fenced reply on the FIRST attempt (no repair spend)', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody(FENCED)))
    vi.stubGlobal('fetch', f)
    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).resolves.toEqual({ x: 1 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('llmJsonWithRepairWithUsage parses a fenced reply and keeps first-attempt usage', async () => {
    const f = vi.fn().mockResolvedValue(
      makeJsonResponse({
        ...completionBody(FENCED),
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }),
    )
    vi.stubGlobal('fetch', f)
    const { result, usage } = await llmJsonWithRepairWithUsage({ system: 's', user: 'u' }, validate)
    expect(result).toEqual({ x: 1 })
    expect(usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('llmJsonWithRepairFor parses a fenced reply on the FIRST attempt', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody(FENCED)))
    vi.stubGlobal('fetch', f)
    const { result } = await llmJsonWithRepairFor(cfgFor('deepseek'), { system: 's', user: 'u' }, validate)
    expect(result).toEqual({ x: 1 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a bare ``` fence (no language tag) parses too', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('```\n{"x": 2}\n```')))
    vi.stubGlobal('fetch', f)
    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).resolves.toEqual({ x: 2 })
    expect(f).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// (b) prose-wrapped JSON
// ---------------------------------------------------------------------------

describe('repro (b): prose around valid JSON must parse', () => {
  it('a preamble + suffix around the object still yields the object', async () => {
    const prose = 'Here is the analysis you asked for:\n{"x": 3}\nLet me know if you need more detail.'
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody(prose)))
    vi.stubGlobal('fetch', f)
    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).resolves.toEqual({ x: 3 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a trailing stray fence after the object still yields the object', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('{"x": 4}\n```')))
    vi.stubGlobal('fetch', f)
    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).resolves.toEqual({ x: 4 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('genuinely unparseable output still fails after the repair retry', async () => {
    // A fresh Response per call — a Response body can only be read once.
    const f = vi.fn().mockImplementation(async () => makeJsonResponse(completionBody('I cannot answer that.')))
    vi.stubGlobal('fetch', f)
    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).rejects.toMatchObject({
      kind: 'invalid-output',
    })
    expect(f).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// (c) truncation amplification — the repair must NOT echo the cut-off output
// ---------------------------------------------------------------------------

describe('repro (c): a truncated reply must not be echoed back into the repair prompt', () => {
  // A long, unterminated object — exactly what a max_tokens cut looks like.
  const TRUNCATED = `{"x": 1, "notes": "${'y'.repeat(6000)}`

  it('the repair request does NOT contain the full truncated body', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody(TRUNCATED, 'length')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"x": 1}')))
    vi.stubGlobal('fetch', f)

    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).resolves.toEqual({ x: 1 })
    expect(f).toHaveBeenCalledTimes(2)

    const repairUser = userMessageOf(f.mock.calls[1])
    // The amplification bug: today the WHOLE cut-off body is pasted back in.
    expect(repairUser).not.toContain(TRUNCATED)
    expect(repairUser.length).toBeLessThan(TRUNCATED.length)
  })

  it('the truncation retry raises the output cap instead of repeating it', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody(TRUNCATED, 'length')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"x": 1}')))
    vi.stubGlobal('fetch', f)

    await llmJsonWithRepair({ system: 's', user: 'u', maxTokens: 8192 }, validate)

    const firstBody = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string) as { max_tokens: number }
    const secondBody = JSON.parse((f.mock.calls[1] as [string, RequestInit])[1].body as string) as { max_tokens: number }
    expect(firstBody.max_tokens).toBe(8192)
    expect(secondBody.max_tokens).toBeGreaterThan(firstBody.max_tokens)
  })

  it('a still-truncated second attempt fails with a TRUNCATION-classified error', async () => {
    const f = vi.fn().mockImplementation(async () => makeJsonResponse(completionBody(TRUNCATED, 'length')))
    vi.stubGlobal('fetch', f)

    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).rejects.toMatchObject({
      kind: 'invalid-output',
      truncated: true,
    })
  })

  it('a NON-truncated schema mismatch is NOT classified as truncation', async () => {
    const f = vi.fn().mockImplementation(async () => makeJsonResponse(completionBody('{"wrong": true}')))
    vi.stubGlobal('fetch', f)

    await expect(llmJsonWithRepair({ system: 's', user: 'u' }, validate)).rejects.toMatchObject({
      kind: 'invalid-output',
      truncated: false,
    })
  })

  it('an untruncated repair still echoes the (capped) previous output — unchanged path', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody('not-json')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"x": 9}')))
    vi.stubGlobal('fetch', f)

    await llmJsonWithRepair({ system: 's', user: 'u' }, validate)
    expect(userMessageOf(f.mock.calls[1])).toContain('not-json')
  })
})
