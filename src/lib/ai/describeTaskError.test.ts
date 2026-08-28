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
import { describeTaskError, TRUNCATED_OUTPUT_MESSAGE } from './run.svelte'
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

// ---------------------------------------------------------------------------
// invalid-output: truncation copy, parse-vs-schema, and the analytics boundary
// ---------------------------------------------------------------------------

describe('describeTaskError — truncated invalid-output gets its own lead line', () => {
  it('a TRUNCATED invalid-output names the real remedy, not "unexpected response format"', () => {
    const info = describeTaskError(
      new LlmError('invalid-output', 'LLM produced invalid JSON after repair retry — x', { truncated: true }),
    )
    expect(info.kind).toBe('invalid-output')
    expect(info.error).toBe(TRUNCATED_OUTPUT_MESSAGE)
    expect(info.error).toMatch(/cut off/i)
    expect(info.error).toMatch(/larger output budget/i)
  })

  it('a NON-truncated invalid-output keeps the generic format sentence', () => {
    const info = describeTaskError(
      new LlmError('invalid-output', 'LLM produced invalid JSON after repair retry — y', { truncated: false }),
    )
    expect(info.error).toMatch(/unexpected response format/i)
    expect(info.error).not.toBe(TRUNCATED_OUTPUT_MESSAGE)
  })

  it('the truncation lead line is NOT applied to other kinds carrying the flag', () => {
    const info = describeTaskError(new LlmError('server', 'boom', { truncated: true, status: 500 }))
    expect(info.error).not.toBe(TRUNCATED_OUTPUT_MESSAGE)
  })

  it('parse vs schema stays distinguishable in the detail', () => {
    const parseInfo = describeTaskError(
      new LlmError(
        'invalid-output',
        'LLM produced invalid JSON after repair retry — no valid JSON could be parsed from the reply',
      ),
    )
    const schemaInfo = describeTaskError(
      new LlmError(
        'invalid-output',
        'LLM produced invalid JSON after repair retry — the JSON did not match the expected shape',
      ),
    )
    expect(parseInfo.errorDetail).toMatch(/no valid JSON could be parsed/i)
    expect(schemaInfo.errorDetail).toMatch(/did not match the expected shape/i)
    expect(parseInfo.errorDetail).not.toBe(schemaInfo.errorDetail)
  })
})

describe('describeTaskError — the model-output excerpt is UI-only', () => {
  const withExcerpt = new LlmError('invalid-output', 'LLM produced invalid JSON after repair retry — parse', {
    outputExcerpt: 'Sure! Here is the summary of src/secret.ts …',
  })

  it('errorDetail carries the excerpt for the tooltip', () => {
    const info = describeTaskError(withExcerpt)
    expect(info.errorDetail).toContain('the model returned: Sure! Here is the summary')
  })

  it('analyticsDetail — the ONLY form allowed into PostHog — omits it', () => {
    const info = describeTaskError(withExcerpt)
    expect(info.analyticsDetail).toBeDefined()
    expect(info.analyticsDetail).not.toContain('secret.ts')
    expect(info.analyticsDetail).not.toContain('the model returned')
    expect(info.analyticsDetail).toContain('LLM produced invalid JSON after repair retry')
  })

  it('an error with no excerpt has errorDetail === analyticsDetail (unchanged shape)', () => {
    const info = describeTaskError(new LlmError('server', 'Server error (503): overloaded', { status: 503 }))
    expect(info.errorDetail).toBe(info.analyticsDetail)
  })

  it('an excerpt alone (no other detail) still renders a UI detail', () => {
    const info = describeTaskError(new LlmError('invalid-output', undefined, { outputExcerpt: 'blah' }))
    expect(info.errorDetail).toBe('The model returned: blah')
    expect(info.analyticsDetail).toBeUndefined()
  })
})
