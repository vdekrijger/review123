/**
 * describeTaskError.test.ts — the single task-failure composition helper.
 *
 * Every task catch in run.svelte.ts funnels through describeTaskError, so
 * these tests pin the composition rules:
 *   - kind: LlmError.kind, or 'unknown' for non-LlmError throws
 *   - error: the canned humanMessage sentence for the kind
 *   - errorDetail: the concrete upstream detail, with
 *       - omission when it adds nothing (empty / canned / `llm: <kind>` default)
 *       - `HTTP <status>: ` prefix when the message doesn't name the status
 *       - transient (rate-limited / 5xx) errors noting the automatic retries
 *       - a 300-char cap on the raw message
 */
import { describe, it, expect } from 'vitest'
import { describeTaskError } from './run.svelte'
import { LlmError } from '../llm/llm'

describe('describeTaskError — kind and canned sentence', () => {
  it('LlmError → its kind + the canned human sentence', () => {
    const info = describeTaskError(new LlmError('auth', 'Unauthorized (401): bad key', { status: 401 }))
    expect(info.kind).toBe('auth')
    expect(info.error).toMatch(/API key was rejected/i)
  })

  it("non-LlmError → kind 'unknown' + the generic sentence", () => {
    const info = describeTaskError(new Error('boom'))
    expect(info.kind).toBe('unknown')
    expect(info.error).toMatch(/unexpected error/i)
  })
})

describe('describeTaskError — errorDetail composition', () => {
  it('surfaces the concrete LlmError message (provider error body)', () => {
    const info = describeTaskError(
      new LlmError('server', 'Server error (503): upstream model overloaded', { status: 503 }),
    )
    expect(info.errorDetail).toContain('upstream model overloaded')
  })

  it('non-LlmError throw → the Error message, String()-ed for non-Errors', () => {
    expect(describeTaskError(new Error('boom')).errorDetail).toBe('boom')
    expect(describeTaskError('string failure').errorDetail).toBe('string failure')
  })

  it('omitted when identical to the canned sentence (adds nothing)', () => {
    const canned = describeTaskError(new LlmError('network', 'x')).error
    const info = describeTaskError(new LlmError('network', canned))
    expect(info.errorDetail).toBeUndefined()
  })

  it("omitted for the constructor's bare `llm: <kind>` default message", () => {
    const info = describeTaskError(new LlmError('timeout'))
    expect(info.errorDetail).toBeUndefined()
  })

  it('omitted for an empty/whitespace message', () => {
    // Whitespace-only Error message → trimmed to nothing → no detail.
    expect(describeTaskError(new Error('   ')).errorDetail).toBeUndefined()
  })

  it("prefixes `HTTP <status>: ` when the message doesn't already name the status", () => {
    const info = describeTaskError(new LlmError('auth', 'invalid api key provided', { status: 401 }))
    expect(info.errorDetail).toBe('HTTP 401: invalid api key provided')
  })

  it('does NOT double the status when the message already embeds "(NNN)" (mapHttpError shape)', () => {
    const info = describeTaskError(new LlmError('auth', 'Unauthorized (401): bad key', { status: 401 }))
    expect(info.errorDetail).toBe('Unauthorized (401): bad key')
  })

  it('caps the raw message at 300 chars', () => {
    const long = 'x'.repeat(400)
    const info = describeTaskError(new Error(long))
    expect(info.errorDetail).toBe('x'.repeat(300))
  })
})

describe('describeTaskError — transient errors note the automatic retries', () => {
  it('rate-limited (429) → detail ends with the retried note', () => {
    const info = describeTaskError(
      new LlmError('rate-limited', 'Rate limited (429): slow down', { status: 429, retryAfterMs: 30_000 }),
    )
    expect(info.errorDetail).toBe('Rate limited (429): slow down — retried automatically before failing')
  })

  it('5xx server error → detail ends with the retried note', () => {
    const info = describeTaskError(new LlmError('server', 'upstream exploded', { status: 502 }))
    expect(info.errorDetail).toBe('HTTP 502: upstream exploded — retried automatically before failing')
  })

  it('transient error with a no-information message → the retried note alone', () => {
    const info = describeTaskError(new LlmError('rate-limited', undefined, { status: 429 }))
    expect(info.errorDetail).toBe('Retried automatically before failing')
  })

  it('non-transient statuses (4xx) get NO retried note — the transport never retried them', () => {
    const info = describeTaskError(new LlmError('server', 'Server error (400): bad request', { status: 400 }))
    expect(info.errorDetail).toBe('Server error (400): bad request')
  })
})
