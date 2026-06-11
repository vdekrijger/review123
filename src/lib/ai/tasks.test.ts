/**
 * Tests for src/lib/ai/tasks.ts
 *
 * Tests cover structural requirements only — prose quality is a human checkpoint.
 * EC-15g: verdictPrompt user text contains CI failure name + annotation lines.
 * EC-12e (consumer): reading order filtering happens at consumption, not here.
 */

import { describe, it, expect } from 'vitest'
import {
  PROMPT_VERSION,
  summarizePrompt,
  attentionPrompt,
  diagramsPrompt,
  verdictPrompt,
  parseReadingOrder,
  stripReadingOrder,
} from './tasks'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(text = 'PR context text here'): PackedContext {
  return { text, notAnalyzed: [], includedFiles: [] }
}

function makeCi(failures: { name: string; annotations: string[] }[]): CiSummary {
  return {
    total: failures.length,
    passed: 0,
    failed: failures.length,
    pending: 0,
    failures,
  }
}

// ---------------------------------------------------------------------------
// PROMPT_VERSION
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION', () => {
  it('is exported as a number', () => {
    expect(typeof PROMPT_VERSION).toBe('number')
    expect(PROMPT_VERSION).toBeGreaterThan(0)
  })

  it('is at least 2 (bumped for concise-summary prompt change)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// summarizePrompt
// ---------------------------------------------------------------------------

describe('summarizePrompt', () => {
  it('returns object with system and user strings', () => {
    const { system, user } = summarizePrompt(makeCtx())
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt contains the ctx.text', () => {
    const ctx = makeCtx('unique-context-text-abc')
    const { user } = summarizePrompt(ctx)
    expect(user).toContain('unique-context-text-abc')
  })

  it('system prompt contains "Suggested reading order:" heading instruction', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toContain('Suggested reading order:')
  })

  it('system prompt does NOT instruct JSON output (streaming plain text)', () => {
    const { system } = summarizePrompt(makeCtx())
    // summarize is plain text, not JSON
    expect(system.toLowerCase()).not.toContain('json only')
  })

  it('system prompt contains word-limit instruction (~120 words)', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toContain('120')
  })

  it('user is exactly ctx.text (no additional CI appended)', () => {
    const ctx = makeCtx('my context')
    const { user } = summarizePrompt(ctx)
    expect(user).toBe('my context')
  })
})

// ---------------------------------------------------------------------------
// attentionPrompt
// ---------------------------------------------------------------------------

describe('attentionPrompt', () => {
  it('returns object with system and user strings', () => {
    const { system, user } = attentionPrompt(makeCtx())
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt contains ctx.text', () => {
    const ctx = makeCtx('attention-context-xyz')
    const { user } = attentionPrompt(ctx)
    expect(user).toContain('attention-context-xyz')
  })

  it('system prompt instructs JSON output', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('json')
  })

  it('system prompt mentions readingOrder field', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toContain('readingOrder')
  })

  it('system prompt mentions hotspots field', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toContain('hotspots')
  })

  it('system prompt mentions testFlags field', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toContain('testFlags')
  })

  it('system prompt mentions hotspot level enum values', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toContain('"high"')
    expect(system).toContain('"medium"')
    expect(system).toContain('"low"')
  })

  it('system prompt states test mapping is inferred not measured', () => {
    const { system } = attentionPrompt(makeCtx())
    // Must be explicit that test mapping is inferred from reading code, not measured coverage
    expect(system.toLowerCase()).toContain('inferred')
  })
})

// ---------------------------------------------------------------------------
// diagramsPrompt
// ---------------------------------------------------------------------------

describe('diagramsPrompt', () => {
  it('returns object with system and user strings', () => {
    const { system, user } = diagramsPrompt(makeCtx())
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt contains ctx.text', () => {
    const ctx = makeCtx('diagrams-context-abc123')
    const { user } = diagramsPrompt(ctx)
    expect(user).toContain('diagrams-context-abc123')
  })

  it('system prompt instructs JSON output', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('json')
  })

  it('system prompt mentions GraphResult shape fields (before, after, kind)', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('"before"')
    expect(system).toContain('"after"')
    expect(system).toContain('"kind"')
  })

  it('system prompt mentions flow and module kind options', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('"flow"')
    expect(system).toContain('"module"')
  })

  it('system prompt explicitly states model must NOT write Mermaid', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('mermaid')
    // Should contain a prohibition — look for "not" or "never" near "mermaid"
    expect(system).toMatch(/never|do not|no mermaid/i)
  })

  it('system prompt contains the few-shot example (FEW_SHOT_EXAMPLE_START marker)', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('FEW_SHOT_EXAMPLE_START')
  })

  it('system prompt few-shot contains valid JSON example shape', () => {
    const { system } = diagramsPrompt(makeCtx())
    // The few-shot must include a valid JSON example with kind, before, after
    expect(system).toContain('FEW_SHOT_EXAMPLE_END')
    // The JSON snippet in the example has nodes and edges
    expect(system).toContain('"nodes"')
    expect(system).toContain('"edges"')
  })
})

// ---------------------------------------------------------------------------
// verdictPrompt
// ---------------------------------------------------------------------------

describe('verdictPrompt', () => {
  it('returns object with system and user strings', () => {
    const { system, user } = verdictPrompt(makeCtx(), null)
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt contains ctx.text', () => {
    const ctx = makeCtx('verdict-context-text')
    const { user } = verdictPrompt(ctx, null)
    expect(user).toContain('verdict-context-text')
  })

  it('system prompt instructs JSON output', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system.toLowerCase()).toContain('json')
  })

  it('system prompt mentions all three verdict level values', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toContain('behavior-preserved')
    expect(system).toContain('minor-changes')
    expect(system).toContain('significant-changes')
  })

  it('system prompt mentions evidence and notAnalyzed fields', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toContain('evidence')
    expect(system).toContain('notAnalyzed')
  })

  it('user prompt does NOT contain "CI failures:" section when ci is null', () => {
    const ctx = makeCtx('no-ci-context')
    const { user } = verdictPrompt(ctx, null)
    expect(user).not.toContain('CI failures:')
  })

  it('user prompt does NOT contain "CI failures:" section when ci has no failures (EC-15g)', () => {
    const ctx = makeCtx('no-failures-context')
    const ci = makeCi([])
    const { user } = verdictPrompt(ctx, ci)
    expect(user).not.toContain('CI failures:')
  })

  it('user prompt contains CI failure name when ci has failures (EC-15g)', () => {
    const ctx = makeCtx('base-context')
    const ci = makeCi([{ name: 'unit-tests', annotations: ['src/foo.ts:42 - TypeError'] }])
    const { user } = verdictPrompt(ctx, ci)
    expect(user).toContain('CI failures:')
    expect(user).toContain('unit-tests')
  })

  it('user prompt contains annotation text when ci has failures (EC-15g)', () => {
    const ctx = makeCtx('base-context')
    const ci = makeCi([
      { name: 'e2e-tests', annotations: ['src/bar.ts:10 - Expected true got false'] },
    ])
    const { user } = verdictPrompt(ctx, ci)
    expect(user).toContain('src/bar.ts:10 - Expected true got false')
  })

  it('user prompt contains all failures when ci has multiple (EC-15g)', () => {
    const ctx = makeCtx('multi-ci')
    const ci = makeCi([
      { name: 'unit-tests', annotations: ['annotation-1a'] },
      { name: 'build', annotations: ['annotation-2a', 'annotation-2b'] },
    ])
    const { user } = verdictPrompt(ctx, ci)
    expect(user).toContain('unit-tests')
    expect(user).toContain('annotation-1a')
    expect(user).toContain('build')
    expect(user).toContain('annotation-2a')
    expect(user).toContain('annotation-2b')
  })

  it('user prompt still contains ctx.text when ci has failures', () => {
    const ctx = makeCtx('base-text-preserved')
    const ci = makeCi([{ name: 'test', annotations: [] }])
    const { user } = verdictPrompt(ctx, ci)
    expect(user).toContain('base-text-preserved')
  })

  it('user prompt CI section appears after ctx.text', () => {
    const ctx = makeCtx('context-comes-first')
    const ci = makeCi([{ name: 'my-check', annotations: [] }])
    const { user } = verdictPrompt(ctx, ci)
    const ctxIdx = user.indexOf('context-comes-first')
    const ciIdx = user.indexOf('CI failures:')
    expect(ctxIdx).toBeLessThan(ciIdx)
  })
})

// ---------------------------------------------------------------------------
// parseReadingOrder
// ---------------------------------------------------------------------------

describe('parseReadingOrder', () => {
  it('returns [] when heading is absent', () => {
    expect(parseReadingOrder('Here is a summary of the PR.\nSome more text.')).toEqual([])
  })

  it('returns [] for empty string', () => {
    expect(parseReadingOrder('')).toEqual([])
  })

  it('parses a normal reading order list', () => {
    const text = `This PR refactors the router.

Suggested reading order:
src/lib/router/router.ts
src/lib/router/parse.ts
src/App.svelte`
    expect(parseReadingOrder(text)).toEqual([
      'src/lib/router/router.ts',
      'src/lib/router/parse.ts',
      'src/App.svelte',
    ])
  })

  it('stops at the first blank line after the heading', () => {
    const text = `Summary text.

Suggested reading order:
src/a.ts
src/b.ts

Trailing prose that should not be included.`
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('strips bullet-point prefixes (- )', () => {
    const text = `Suggested reading order:\n- src/a.ts\n- src/b.ts`
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('strips asterisk-bullet prefixes (* )', () => {
    const text = `Suggested reading order:\n* src/a.ts\n* src/b.ts`
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('strips number+dot prefixes (1. 2.)', () => {
    const text = `Suggested reading order:\n1. src/a.ts\n2. src/b.ts`
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('strips number+paren prefixes (1) 2))', () => {
    const text = `Suggested reading order:\n1) src/a.ts\n2) src/b.ts`
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('strips backtick wrapping', () => {
    const text = 'Suggested reading order:\n`src/a.ts`\n`src/b.ts`'
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('trims whitespace from file paths', () => {
    const text = 'Suggested reading order:\n   src/a.ts   \n  src/b.ts  '
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('handles heading case-insensitively', () => {
    const text = 'SUGGESTED READING ORDER:\nsrc/a.ts'
    expect(parseReadingOrder(text)).toEqual(['src/a.ts'])
  })

  it('handles trailing prose (no blank line) — stops at end of input', () => {
    const text = 'Summary.\n\nSuggested reading order:\nsrc/a.ts\nsrc/b.ts'
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('returns [] for heading with no subsequent lines', () => {
    const text = 'Suggested reading order:'
    expect(parseReadingOrder(text)).toEqual([])
  })

  it('returns [] for heading immediately followed by blank line', () => {
    const text = 'Suggested reading order:\n\nsrc/a.ts'
    expect(parseReadingOrder(text)).toEqual([])
  })

  it('handles mixed bullet and plain entries', () => {
    const text = 'Suggested reading order:\nsrc/a.ts\n- src/b.ts\n* src/c.ts'
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })
})

// ---------------------------------------------------------------------------
// stripReadingOrder
// ---------------------------------------------------------------------------

describe('stripReadingOrder', () => {
  it('returns the original string when no heading is present', () => {
    const text = 'This PR refactors the router. Nothing else here.'
    expect(stripReadingOrder(text)).toBe(text)
  })

  it('removes the heading and its list block from a normal summary', () => {
    const text = `This PR adds caching.

Suggested reading order:
src/lib/cache/cache.ts
src/routes/Review.svelte`
    expect(stripReadingOrder(text)).toBe('This PR adds caching.')
  })

  it('removes heading + list and any subsequent blank lines from the tail', () => {
    const text = `Summary prose here.

Suggested reading order:
src/a.ts
src/b.ts

Trailing prose after blank line.`
    const result = stripReadingOrder(text)
    expect(result).toContain('Summary prose here.')
    // The trailing prose is preserved (it was after a blank line — not part of the list)
    expect(result).toContain('Trailing prose after blank line.')
    expect(result).not.toContain('Suggested reading order')
    expect(result).not.toContain('src/a.ts')
  })

  it('handles summary with heading at end (missing blank terminator)', () => {
    const text = `Summary.\n\nSuggested reading order:\nsrc/a.ts\nsrc/b.ts`
    const result = stripReadingOrder(text)
    expect(result).toBe('Summary.')
    expect(result).not.toContain('Suggested reading order')
  })

  it('handles empty string input gracefully', () => {
    expect(stripReadingOrder('')).toBe('')
  })

  it('handles input that is only the heading (no list items)', () => {
    const text = 'Suggested reading order:'
    expect(stripReadingOrder(text)).toBe('')
  })

  it('is case-insensitive for the heading', () => {
    const text = 'Prose.\n\nSUGGESTED READING ORDER:\nsrc/a.ts'
    expect(stripReadingOrder(text)).toBe('Prose.')
  })
})
