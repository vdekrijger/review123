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
  testInsightPrompt,
  coachPrompt,
  alternativesPrompt,
  storyOrderPrompt,
  askPrompt,
  parseReadingOrder,
  stripReadingOrder,
  FLOW_MAX_STEPS,
} from './tasks'
import { STORY_LAYERS } from './schemas'
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

  // Plan L — flow-of-execution prompt

  it('instructs the model to TRACE THE EXECUTION PATH the change touches', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('execution path')
    // entry → effect framing
    expect(system.toLowerCase()).toContain('entry')
    expect(system.toLowerCase()).toContain('effect')
  })

  it('system prompt mentions the flow shape: steps + transitions', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('"flow"')
    expect(system).toContain('"steps"')
    expect(system).toContain('"transitions"')
  })

  it('system prompt advertises the step kind enum values', () => {
    const { system } = diagramsPrompt(makeCtx())
    for (const kind of ['"entry"', '"call"', '"branch"', '"effect"', '"return"']) {
      expect(system).toContain(kind)
    }
  })

  it('system prompt advertises the four change enum values', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('"added"')
    expect(system).toContain('"removed"')
    expect(system).toContain('"changed"')
    expect(system).toContain('"unchanged"')
  })

  it('system prompt tells the model to set each step file (for jump/coverage)', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('"file"')
  })

  it('system prompt instructs the graceful empty-flow fallback (no fabrication)', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('no clear execution flow')
    expect(system).toMatch(/empty flow|"steps": \[\]/i)
    expect(system).toMatch(/do not fabricate|never invent|do not fabricate a flow/i)
  })

  it('system prompt instructs the flow step cap', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain(String(FLOW_MAX_STEPS))
    expect(FLOW_MAX_STEPS).toBe(14)
  })

  it('few-shot example demonstrates a flow with steps + change tags', () => {
    const { system } = diagramsPrompt(makeCtx())
    const start = system.indexOf('FEW_SHOT_EXAMPLE_START')
    const end = system.indexOf('FEW_SHOT_EXAMPLE_END')
    expect(start).toBeGreaterThan(-1)
    const block = system.slice(start, end)
    expect(block).toContain('"flow"')
    expect(block).toContain('"kind"')
    expect(block).toContain('"change"')
    expect(block).toContain('"transitions"')
  })
})

// ---------------------------------------------------------------------------
// diagramsPrompt — deep mode (follow the call chain; Plan L)
// ---------------------------------------------------------------------------

describe('diagramsPrompt — deep mode (call chain)', () => {
  it('single-pass (default / deep:false) omits the deep call-chain section', () => {
    const { system: def } = diagramsPrompt(makeCtx())
    const { system: off } = diagramsPrompt(makeCtx(), { deep: false })
    expect(def).not.toContain('follow the real call chain')
    expect(off).not.toContain('follow the real call chain')
    // Default and explicit deep:false are byte-identical
    expect(def).toBe(off)
  })

  it('deep mode tells the model to USE THE TOOLS to follow the call chain', () => {
    const { system } = diagramsPrompt(makeCtx(), { deep: true })
    expect(system.toLowerCase()).toContain('follow the real call chain')
    expect(system).toMatch(/read_file|search_code/)
    // trace entry → effect using tools
    expect(system.toLowerCase()).toContain('entry')
  })

  it('deep mode tells the model to DROP steps it cannot substantiate', () => {
    const { system } = diagramsPrompt(makeCtx(), { deep: true })
    expect(system.toLowerCase()).toMatch(/drop any step|cannot substantiate/)
  })

  it('deep mode keeps the flow shape and the no-Mermaid rule', () => {
    const { system } = diagramsPrompt(makeCtx(), { deep: true })
    expect(system).toContain('"flow"')
    expect(system).toContain('"steps"')
    expect(system.toLowerCase()).toContain('mermaid')
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

// ---------------------------------------------------------------------------
// PROMPT_VERSION ≥ 3 (bumped for sentinel contract)
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v3', () => {
  it('is at least 3 (bumped for sentinel reading-order contract)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// summarizePrompt — sentinel instructions
// ---------------------------------------------------------------------------

describe('summarizePrompt v3 sentinel contract', () => {
  it('system prompt instructs ending with ===READING-ORDER=== sentinel', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toContain('===READING-ORDER===')
    expect(system).toContain('===END===')
  })

  it('system prompt instructs NOT mentioning reading order in prose', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system.toLowerCase()).toMatch(/do not mention reading order|not.*mention.*reading order|no.*reading order.*prose/i)
  })
})

// ---------------------------------------------------------------------------
// parseReadingOrder — sentinel block
// ---------------------------------------------------------------------------

describe('parseReadingOrder — sentinel block', () => {
  it('parses sentinel block correctly', () => {
    const text = `Summary prose here.

===READING-ORDER===
src/lib/router/router.ts
src/lib/router/parse.ts
src/App.svelte
===END===`
    expect(parseReadingOrder(text)).toEqual([
      'src/lib/router/router.ts',
      'src/lib/router/parse.ts',
      'src/App.svelte',
    ])
  })

  it('sentinel parse returns [] when sentinel absent', () => {
    const text = 'This is prose without any reading order block.'
    expect(parseReadingOrder(text)).toEqual([])
  })

  it('sentinel parse handles empty block between sentinels', () => {
    const text = '===READING-ORDER===\n===END==='
    expect(parseReadingOrder(text)).toEqual([])
  })

  it('legacy heading fallback still works for cached v2 outputs', () => {
    const text = `Prose.\n\nSuggested reading order:\nsrc/a.ts\nsrc/b.ts`
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

// ---------------------------------------------------------------------------
// stripReadingOrder — sentinel block
// ---------------------------------------------------------------------------

describe('stripReadingOrder — sentinel block', () => {
  it('strips sentinel block from summary', () => {
    const text = `This PR adds caching.

===READING-ORDER===
src/lib/cache/cache.ts
src/routes/Review.svelte
===END===`
    const result = stripReadingOrder(text)
    expect(result).toBe('This PR adds caching.')
    expect(result).not.toContain('===READING-ORDER===')
    expect(result).not.toContain('===END===')
    expect(result).not.toContain('src/lib/cache/cache.ts')
  })

  it('sentinel strip: prose before sentinel is preserved', () => {
    const text = `Important context.\n\nMore prose.\n\n===READING-ORDER===\nsrc/a.ts\n===END===`
    const result = stripReadingOrder(text)
    expect(result).toContain('Important context.')
    expect(result).toContain('More prose.')
  })

  it('legacy heading strip still works for cached v2 outputs', () => {
    const text = `Summary.\n\nSuggested reading order:\nsrc/a.ts\nsrc/b.ts`
    const result = stripReadingOrder(text)
    expect(result).toBe('Summary.')
  })

  it('strips trailing bare-path-run (≥3 consecutive lines) defensively', () => {
    const text = `This PR refactors routing.\n\nsrc/lib/router.ts\nsrc/App.svelte\nsrc/index.ts`
    const result = stripReadingOrder(text)
    expect(result).not.toContain('src/lib/router.ts')
    expect(result).not.toContain('src/App.svelte')
    expect(result).not.toContain('src/index.ts')
    expect(result).toContain('This PR refactors routing.')
  })

  it('does NOT strip trailing section with only 2 bare paths (not ≥3)', () => {
    const text = `This PR refactors routing.\n\nsrc/lib/router.ts\nsrc/App.svelte`
    const result = stripReadingOrder(text)
    expect(result).toContain('src/lib/router.ts')
  })

  it('prose lines with spaces are NOT stripped by trailing-path heuristic', () => {
    const text = `This PR is great.\n\nIt has many features.\nAnd some more text.\nWith three lines.`
    const result = stripReadingOrder(text)
    expect(result).toContain('It has many features.')
    expect(result).toContain('And some more text.')
  })
})

// ---------------------------------------------------------------------------
// PROMPT_VERSION v4 (D1/D2/D4 bump)
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v4', () => {
  it('is at least 4 (bumped for changeMap, testInsight, and coach prompts)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// PROMPT_VERSION v8 (coach accuracy + duplicate + prComments)
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v8', () => {
  it('is at least 8 (bumped for coach accuracy/duplicate/prComments dimensions)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(8)
  })
})

// ---------------------------------------------------------------------------
// testInsightPrompt (D2)
// ---------------------------------------------------------------------------

describe('testInsightPrompt', () => {
  it('returns object with system and user strings', () => {
    const { system, user } = testInsightPrompt(makeCtx())
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt contains ctx.text', () => {
    const ctx = makeCtx('test-insight-context-abc')
    const { user } = testInsightPrompt(ctx)
    expect(user).toContain('test-insight-context-abc')
  })

  it('system prompt instructs JSON output', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('json')
  })

  it('system prompt mentions covered field', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toContain('covered')
  })

  it('system prompt mentions gaps field', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toContain('gaps')
  })

  it('system prompt instructs analyzing CHANGED test files', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system.toLowerCase()).toMatch(/changed test file|changed.*test/i)
  })

  it('system prompt instructs up to 10 behaviors in covered', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/10 behavior|up to 10/i)
  })

  it('system prompt states test mapping is inferred not measured', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('inferred')
  })

  it('system prompt mentions behavior, test, and file sub-fields', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toContain('"behavior"')
    expect(system).toContain('"test"')
    expect(system).toContain('"file"')
  })
})

// ---------------------------------------------------------------------------
// coachPrompt (D4)
// ---------------------------------------------------------------------------

describe('coachPrompt', () => {
  const drafts = [
    { index: 0, path: 'src/auth.ts', line: 42, body: 'This variable name is confusing.' },
    { index: 1, path: 'src/api.ts', line: 10, body: 'You should never do it this way.' },
  ]

  it('returns object with system and user strings', () => {
    const { system, user } = coachPrompt(drafts)
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt embeds the draft bodies', () => {
    const { user } = coachPrompt(drafts)
    expect(user).toContain('This variable name is confusing.')
    expect(user).toContain('You should never do it this way.')
  })

  it('user prompt embeds the draft indices', () => {
    const { user } = coachPrompt(drafts)
    // Indices should appear in the JSON payload
    expect(user).toContain('"index"')
    expect(user).toContain('0')
    expect(user).toContain('1')
  })

  it('system prompt instructs JSON output', () => {
    const { system } = coachPrompt(drafts)
    expect(system.toLowerCase()).toContain('json')
  })

  it('system prompt mentions reviews field', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('reviews')
  })

  it('system prompt mentions clarity field with 1–5 range', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('clarity')
    expect(system).toMatch(/1[–-]5|1 to 5/i)
  })

  it('system prompt mentions actionable field', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('actionable')
  })

  it('system prompt mentions tone enum values', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('"ok"')
    expect(system).toContain('"blunt"')
    expect(system).toContain('"harsh"')
  })

  it('system prompt mentions biasQuestion field', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('biasQuestion')
  })

  it('system prompt mentions suggestion field', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('suggestion')
  })

  it('system prompt instructs biasQuestion only when preference stated as defect', () => {
    const { system } = coachPrompt(drafts)
    expect(system.toLowerCase()).toMatch(/preference.*defect|defect.*preference/i)
  })

  it('user prompt is valid JSON containing all draft entries under a drafts key', () => {
    const { user } = coachPrompt(drafts)
    const parsed = JSON.parse(user)
    // Now the payload is { drafts: [...], ... }
    expect(Array.isArray(parsed.drafts)).toBe(true)
    expect(parsed.drafts).toHaveLength(2)
    expect(parsed.drafts[0].body).toBe('This variable name is confusing.')
    expect(parsed.drafts[1].body).toBe('You should never do it this way.')
  })

  it('handles empty drafts array gracefully', () => {
    const { system, user } = coachPrompt([])
    expect(typeof system).toBe('string')
    const parsed = JSON.parse(user)
    expect(parsed.drafts).toEqual([])
  })

  // --- new accuracy + duplicate dimensions ---

  it('system prompt mentions accuracy field with its three enum values', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('accuracy')
    expect(system).toContain('consistent')
    expect(system).toContain('questionable')
    expect(system).toContain('contradicted')
  })

  it('system prompt mentions duplicate field', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('duplicate')
  })

  it('system prompt instructs per-comment accuracy assessment against the diff', () => {
    const { system } = coachPrompt(drafts)
    expect(system.toLowerCase()).toMatch(/accuracy|consistent.*diff|diff.*claim/i)
  })

  it('system prompt says to cite why when contradicted', () => {
    const { system } = coachPrompt(drafts)
    expect(system.toLowerCase()).toMatch(/contradict|cite|why/i)
  })

  it('system prompt mentions accuracyNote field', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('accuracyNote')
  })

  it('user payload embeds existing PR comments when provided', () => {
    const prComments = [
      'This function is too complex.',
      'Please add a test for this edge case.',
    ]
    const { user } = coachPrompt(drafts, prComments)
    expect(user).toContain('This function is too complex.')
    expect(user).toContain('Please add a test for this edge case.')
  })

  it('user payload has no prComments section when not provided', () => {
    const { user } = coachPrompt(drafts)
    // The user should be valid JSON starting with the drafts array when no prComments
    const parsed = JSON.parse(user)
    expect(Array.isArray(parsed) || typeof parsed === 'object').toBe(true)
  })

  it('coachPrompt caps existing PR comments at 30', () => {
    const manyComments = Array.from({ length: 50 }, (_, i) => `comment ${i}`)
    const { user } = coachPrompt(drafts, manyComments)
    // Should not contain comment 30 and beyond (0-indexed)
    expect(user).not.toContain('comment 30')
    expect(user).not.toContain('comment 49')
    // Should contain up to comment 29
    expect(user).toContain('comment 0')
  })

  it('coachPrompt truncates individual PR comment bodies at 200 chars', () => {
    const longComment = 'x'.repeat(300)
    const { user } = coachPrompt(drafts, [longComment])
    // The full 300-char string should NOT appear
    expect(user).not.toContain('x'.repeat(300))
    // But a 200-char truncation should
    expect(user).toContain('x'.repeat(200))
  })

  // --- v9: specificity + grounded dimensions ---

  it('system prompt mentions specificity field with concrete-code rule', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('specificity')
    expect(system.toLowerCase()).toMatch(/concrete code|identifiers/)
  })

  it('system prompt mentions grounded field with verifiability rule', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('grounded')
    expect(system.toLowerCase()).toMatch(/verif/)
  })

  it('system prompt carries the evidence-discipline calibration block', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('Evidence discipline')
    expect(system).toMatch(/ground every assessment.*in what you can SEE/i)
    expect(system.toLowerCase()).toContain('codecontext')
    expect(system.toLowerCase()).toMatch(/neutral, factual phrasing over alarm/)
  })

  // --- v9: per-dimension reasons (pass AND fail) ---

  it('system prompt requires a reasons object with all seven dimension keys', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toContain('reasons')
    for (const dim of ['clarity', 'tone', 'actionable', 'accuracy', 'duplicate', 'specificity', 'grounded']) {
      expect(system).toContain(`"${dim}"`)
    }
  })

  it('system prompt instructs reasons for passing grades as well as failing ones', () => {
    const { system } = coachPrompt(drafts)
    expect(system).toMatch(/passing grades as well as failing/i)
  })

  it('system prompt keeps reasons concise (one short line)', () => {
    const { system } = coachPrompt(drafts)
    expect(system.toLowerCase()).toContain('one short line')
    expect(system).toMatch(/12 words/)
  })

  // --- v9: verdict in context (coherence check) ---

  it('user payload embeds chosenVerdict when verdict option is provided', () => {
    const { user } = coachPrompt(drafts, undefined, { verdict: 'APPROVE' })
    const parsed = JSON.parse(user)
    expect(parsed.chosenVerdict).toBe('APPROVE')
  })

  it('system prompt requests verdictCoherence when verdict option is provided', () => {
    const { system } = coachPrompt(drafts, undefined, { verdict: 'REQUEST_CHANGES' })
    expect(system).toContain('verdictCoherence')
    expect(system).toContain('coherent')
    expect(system).toContain('note')
    // The mismatch examples must be spelled out
    expect(system).toMatch(/harsh or blocking comments alongside/i)
    expect(system).toMatch(/unanimous praise alongside/i)
  })

  it('user payload has no chosenVerdict and system has no verdictCoherence when verdict absent', () => {
    const { system, user } = coachPrompt(drafts)
    const parsed = JSON.parse(user)
    expect('chosenVerdict' in parsed).toBe(false)
    expect(system).not.toContain('verdictCoherence')
  })

  // --- v9: diff context threading ---

  it('user payload embeds prContext when contextText option is provided', () => {
    const { user } = coachPrompt(drafts, undefined, { contextText: 'diff-context-marker-xyz' })
    const parsed = JSON.parse(user)
    expect(parsed.prContext).toContain('diff-context-marker-xyz')
  })

  it('user payload has no prContext when contextText is absent or empty', () => {
    const { user: noOpts } = coachPrompt(drafts)
    expect('prContext' in JSON.parse(noOpts)).toBe(false)
    const { user: emptyCtx } = coachPrompt(drafts, undefined, { contextText: '' })
    expect('prContext' in JSON.parse(emptyCtx)).toBe(false)
  })

  it('verdict + contextText + prComments combine into one valid JSON payload', () => {
    const { user } = coachPrompt(drafts, ['Existing comment.'], {
      verdict: 'COMMENT',
      contextText: 'packed context',
    })
    const parsed = JSON.parse(user)
    expect(parsed.drafts).toHaveLength(2)
    expect(parsed.existingPrComments).toEqual(['Existing comment.'])
    expect(parsed.chosenVerdict).toBe('COMMENT')
    expect(parsed.prContext).toBe('packed context')
  })

  // --- v16: per-comment code context (excerpt + fileWindow) ---

  it('embeds per-comment codeContext (excerpt + fileWindow) on the matching draft', () => {
    const { user } = coachPrompt(drafts, undefined, {
      codeContexts: [
        {
          index: 0,
          path: 'src/auth.ts',
          line: 42,
          side: 'RIGHT',
          excerpt: '+ const userName = getUser()',
          fileWindow: '42: const userName = getUser()',
        },
      ],
    })
    const parsed = JSON.parse(user)
    expect(parsed.drafts[0].codeContext).toBeDefined()
    expect(parsed.drafts[0].codeContext.excerpt).toContain('userName')
    expect(parsed.drafts[0].codeContext.fileWindow).toContain('userName')
    expect(parsed.drafts[0].codeContext.side).toBe('RIGHT')
    // Draft 1 had no code context provided → none attached.
    expect(parsed.drafts[1].codeContext).toBeUndefined()
  })

  it('omits fileWindow from codeContext when not provided', () => {
    const { user } = coachPrompt(drafts, undefined, {
      codeContexts: [
        { index: 0, path: 'src/auth.ts', line: 42, side: 'RIGHT', excerpt: '+ x' },
      ],
    })
    const parsed = JSON.parse(user)
    expect(parsed.drafts[0].codeContext.excerpt).toBe('+ x')
    expect('fileWindow' in parsed.drafts[0].codeContext).toBe(false)
  })

  it('system prompt instructs the model to VERIFY against codeContext rather than default to cannot-verify', () => {
    const { system } = coachPrompt(drafts, undefined, {
      codeContexts: [
        { index: 0, path: 'src/auth.ts', line: 42, side: 'RIGHT', excerpt: '+ x' },
      ],
    })
    // Mentions the concrete code-context evidence and the verify-don't-default rule.
    expect(system).toContain('codeContext')
    expect(system).toMatch(/VERIFY/)
    expect(system.toLowerCase()).toContain('cannot verify')
    expect(system.toLowerCase()).toMatch(/do not default|do not default to/)
  })
})

// ---------------------------------------------------------------------------
// PROMPT_VERSION ≥ 9 (bumped for coach v9: reasons, specificity, grounded,
// verdict coherence)
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v9', () => {
  it('is at least 9 after the coach v9 prompt change', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(9)
  })
})

// ---------------------------------------------------------------------------
// alternativesPrompt (Plan F)
// ---------------------------------------------------------------------------

describe('alternativesPrompt', () => {
  it('returns object with system and user strings', () => {
    const { system, user } = alternativesPrompt(makeCtx())
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt contains ctx.text', () => {
    const ctx = makeCtx('unique-alt-context-xyz')
    const { user } = alternativesPrompt(ctx)
    expect(user).toContain('unique-alt-context-xyz')
  })

  it('system prompt instructs JSON-only output', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('json only')
  })

  it('system prompt references all four assessment enum values', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toContain('pr-is-better')
    expect(system).toContain('comparable')
    expect(system).toContain('alternative-is-better')
    expect(system).toContain('different-goals')
  })

  it('system prompt mentions maximum 3 alternatives', () => {
    const { system } = alternativesPrompt(makeCtx())
    // Instruction should cap at 3
    expect(system).toContain('3')
  })

  it('system prompt includes intellectual honesty instruction about pr-is-better', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toContain('pr-is-better')
    // Should signal it is valid to say PR is better
    expect(system.toLowerCase()).toContain('valid')
  })

  it('system prompt specifies problem field as one sentence', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system.toLowerCase()).toContain('one')
    expect(system.toLowerCase()).toContain('problem')
  })

  it('system prompt spells out the JSON shape with problem and alternatives fields', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toContain('"problem"')
    expect(system).toContain('"alternatives"')
    expect(system).toContain('"approach"')
    expect(system).toContain('"tradeoffs"')
    expect(system).toContain('"assessment"')
    expect(system).toContain('"rationale"')
  })

  it('user is exactly ctx.text', () => {
    const ctx = makeCtx('my context text')
    const { user } = alternativesPrompt(ctx)
    expect(user).toBe('my context text')
  })
})

// ---------------------------------------------------------------------------
// PROMPT_VERSION v6 — evidence-discipline block in attentionPrompt + verdictPrompt
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v6', () => {
  it('is at least 6 (bumped for evidence-discipline in attention + verdict prompts)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// attentionPrompt — evidence-discipline block
// ---------------------------------------------------------------------------

describe('attentionPrompt — evidence-discipline', () => {
  it('system prompt instructs grounding claims in visible context', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/ground every claim|grounded.*context|ground.*claim/i)
  })

  it('system prompt states diff shows ALL changes so completed refactors must not be flagged', () => {
    const { system } = attentionPrompt(makeCtx())
    // Must mention that if call sites are updated in the same diff, it is a completed refactor
    expect(system).toMatch(/completed refactor|same diff|all changes/i)
  })

  it('system prompt instructs flagging consumer risk only when unreferenced file exists or context is truncated', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/without being updated|not analyzed.*truncation|couldn't verify|couldn.t verify/i)
  })

  it('system prompt instructs neutral factual phrasing over alarm', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/neutral|factual phrasing|prefer neutral/i)
  })

  it('system prompt instructs severity must reflect evidence not speculation', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/severity.*evidence|evidence.*severity|not.*specul|worst.case/i)
  })
})

// ---------------------------------------------------------------------------
// verdictPrompt — evidence-discipline block
// ---------------------------------------------------------------------------

describe('verdictPrompt — evidence-discipline', () => {
  it('system prompt instructs grounding claims in visible context', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/ground every claim|grounded.*context|ground.*claim/i)
  })

  it('system prompt states diff shows ALL changes so completed refactors must not be flagged as breakage', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/completed refactor|same diff|all changes/i)
  })

  it('system prompt instructs flagging consumer risk only when unreferenced file exists or context is truncated', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/without being updated|not analyzed.*truncation|couldn't verify|couldn.t verify/i)
  })

  it('system prompt instructs neutral factual phrasing over alarm', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/neutral|factual phrasing|prefer neutral/i)
  })

  it('system prompt instructs severity must reflect evidence not speculation', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/severity.*evidence|evidence.*severity|not.*specul|worst.case/i)
  })

  it('system prompt instructs evidence items to cite observed facts not speculative consequences', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/observed fact|cite.*file|file.*what changed|factual/i)
  })
})

// ---------------------------------------------------------------------------
// askPrompt (Ask AI feature)
// ---------------------------------------------------------------------------

describe('askPrompt', () => {
  it('returns object with system and user strings', () => {
    const { system, user } = askPrompt(makeCtx(), [], 'Why is this here?')
    expect(typeof system).toBe('string')
    expect(typeof user).toBe('string')
  })

  it('user prompt contains ctx.text', () => {
    const ctx = makeCtx('ask-context-unique-xyz')
    const { user } = askPrompt(ctx, [], 'my question')
    expect(user).toContain('ask-context-unique-xyz')
  })

  it('user prompt contains the question', () => {
    const ctx = makeCtx('some context')
    const { user } = askPrompt(ctx, [], 'Why is this coded here?')
    expect(user).toContain('Why is this coded here?')
  })

  it('system prompt contains senior-engineer code explainer persona', () => {
    const { system } = askPrompt(makeCtx(), [], 'question')
    expect(system.toLowerCase()).toMatch(/senior engineer|senior-engineer|code explainer|senior.*engineer/i)
  })

  it('system prompt says grounded only in the provided context', () => {
    const { system } = askPrompt(makeCtx(), [], 'question')
    // Must say it's grounded ONLY in the provided context
    expect(system.toLowerCase()).toMatch(/provided context|grounded.*context|context.*provided/i)
  })

  it('system prompt contains hallucination guard — says "I can\'t see that" or similar', () => {
    const { system } = askPrompt(makeCtx(), [], 'question')
    // Must instruct the model to say it can't see rather than invent
    expect(system).toMatch(/can't see|cannot see|not.*in.*context|not visible.*context/i)
  })

  it('user prompt includes last ≤3 Q&A pairs from history', () => {
    const history = [
      { q: 'First question', a: 'First answer' },
      { q: 'Second question', a: 'Second answer' },
    ]
    const { user } = askPrompt(makeCtx(), history, 'New question')
    expect(user).toContain('First question')
    expect(user).toContain('First answer')
    expect(user).toContain('Second question')
    expect(user).toContain('Second answer')
    expect(user).toContain('New question')
  })

  it('user prompt includes only last 3 Q&A pairs when history is longer than 3', () => {
    const history = [
      { q: 'Q1', a: 'A1' },
      { q: 'Q2', a: 'A2' },
      { q: 'Q3', a: 'A3' },
      { q: 'Q4', a: 'A4' }, // this is #4, should be included
    ]
    // Only the last 3 should be included (Q2-Q4), not Q1/A1
    const { user } = askPrompt(makeCtx(), history, 'Q5')
    expect(user).not.toContain('Q1')
    expect(user).not.toContain('A1')
    expect(user).toContain('Q2')
    expect(user).toContain('Q4')
    expect(user).toContain('Q5')
  })

  it('user prompt with empty history contains no Q&A noise', () => {
    const { user } = askPrompt(makeCtx('the context'), [], 'What does this do?')
    expect(user).toContain('the context')
    expect(user).toContain('What does this do?')
  })

  it('system prompt instructs concise answers', () => {
    const { system } = askPrompt(makeCtx(), [], 'question')
    expect(system.toLowerCase()).toMatch(/concise|brief|short/i)
  })
})

// ---------------------------------------------------------------------------
// askPrompt — focus parameter (line-level Ask AI)
// ---------------------------------------------------------------------------

describe('askPrompt with focus', () => {
  const focus = { path: 'src/foo.ts', line: 42, excerpt: '-old\n+new' }

  it('without focus: system prompt has no location directive', () => {
    const { system } = askPrompt(makeCtx(), [], 'why?')
    expect(system).not.toContain('src/foo.ts')
    expect(system).not.toContain('concerns the specific change')
  })

  it('with focus: system prompt includes path and line', () => {
    const { system } = askPrompt(makeCtx(), [], 'why?', focus)
    expect(system).toContain('src/foo.ts:42')
    expect(system).toContain('specific change')
  })

  it('with focus: system instructs AI to address that location first', () => {
    const { system } = askPrompt(makeCtx(), [], 'why?', focus)
    expect(system).toMatch(/address.*location first|location first/i)
  })

  it('with focus: user prompt includes the excerpt quoted in a code block', () => {
    const { user } = askPrompt(makeCtx(), [], 'why?', focus)
    expect(user).toContain('-old\n+new')
    // Excerpt should be inside a fenced code block
    expect(user).toContain('```')
  })

  it('with focus: user prompt includes the focused path and line reference', () => {
    const { user } = askPrompt(makeCtx(), [], 'why?', focus)
    expect(user).toContain('src/foo.ts:42')
  })

  it('with focus: user prompt still contains the ctx.text', () => {
    const ctx = makeCtx('unique-ctx-text-xyz')
    const { user } = askPrompt(ctx, [], 'why?', focus)
    expect(user).toContain('unique-ctx-text-xyz')
  })

  it('with focus: user prompt still contains the question', () => {
    const { user } = askPrompt(makeCtx(), [], 'why is this done?', focus)
    expect(user).toContain('why is this done?')
  })

  it('with focus: history is still included', () => {
    const history = [{ q: 'prev-q', a: 'prev-a' }]
    const { user } = askPrompt(makeCtx(), history, 'why?', focus)
    expect(user).toContain('prev-q')
    expect(user).toContain('prev-a')
  })

  it('focus does not affect history trimming (still ≤3 pairs)', () => {
    const history = [
      { q: 'Q1', a: 'A1' }, { q: 'Q2', a: 'A2' },
      { q: 'Q3', a: 'A3' }, { q: 'Q4', a: 'A4' },
    ]
    const { user } = askPrompt(makeCtx(), history, 'Qnew', focus)
    expect(user).not.toContain('Q1')
    expect(user).toContain('Q2')
    expect(user).toContain('Qnew')
  })
})

// ---------------------------------------------------------------------------
// testInsightPrompt — gaps grouping instruction (ai-quality-round2)
// Gaps must start with file path + colon so the UI can group them by file.
// ---------------------------------------------------------------------------

describe('testInsightPrompt — gaps file-path instruction (ai-quality-round2)', () => {
  it('system prompt instructs gaps to start with the file path + colon', () => {
    const { system } = testInsightPrompt(makeCtx())
    // Must contain an instruction that gaps start with a file path followed by a colon
    expect(system).toMatch(/gaps.*start.*file|start.*with.*file.*path|file path.*colon|file.*:.*colon/i)
  })

  it('system prompt mentions colon separator for gaps grouping', () => {
    const { system } = testInsightPrompt(makeCtx())
    // The colon separator for grouping must be mentioned
    expect(system).toMatch(/colon|file:|\bpath\b.*colon/i)
  })
})

// ---------------------------------------------------------------------------
// diagramsPrompt — import graph section (ai-quality-round2)
// ---------------------------------------------------------------------------

describe('diagramsPrompt — import graph context section (ai-quality-round2)', () => {
  it('includes importGraph section when ctx.importGraph is provided', () => {
    const ctx: PackedContext = {
      text: 'PR context text',
      notAnalyzed: [],
      includedFiles: [],
      importGraph: 'src/foo.ts -> src/bar.ts\nsrc/foo.ts -> (external) lodash x1',
    }
    const { system } = diagramsPrompt(ctx)
    expect(system).toMatch(/module relationships|import graph/i)
    expect(system).toContain('src/foo.ts -> src/bar.ts')
  })

  it('omits import graph section when ctx.importGraph is empty or absent', () => {
    const ctxEmpty: PackedContext = {
      text: 'PR context',
      notAnalyzed: [],
      includedFiles: [],
      importGraph: '',
    }
    const { system: sysEmpty } = diagramsPrompt(ctxEmpty)
    expect(sysEmpty).not.toMatch(/## Module relationships/)

    const ctxAbsent: PackedContext = {
      text: 'PR context',
      notAnalyzed: [],
      includedFiles: [],
    }
    const { system: sysAbsent } = diagramsPrompt(ctxAbsent)
    expect(sysAbsent).not.toMatch(/## Module relationships/)
  })

  it('instructs model to ground nodes/edges in real import relationships', () => {
    const ctx: PackedContext = {
      text: 'PR context',
      notAnalyzed: [],
      includedFiles: [],
      importGraph: 'src/a.ts -> src/b.ts',
    }
    const { system } = diagramsPrompt(ctx)
    expect(system).toMatch(/ground.*real|real.*relationship|appear.*import graph|import graph.*nodes/i)
  })

  it('PROMPT_VERSION is at least 7 (bumped for import graph context)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(7)
  })
})

// ---------------------------------------------------------------------------
// askPrompt — typed comment text contract + concision (inline widget Ask AI)
// ---------------------------------------------------------------------------

describe('askPrompt — typed text contract and concision', () => {
  const focus = { path: 'src/widget.ts', line: 12, excerpt: '-a\n+b' }

  it('the typed comment text lands verbatim in the user prompt (with focus)', () => {
    const typed = 'Is this loop accidentally quadratic?'
    const { user } = askPrompt(makeCtx(), [], typed, focus)
    expect(user).toContain(typed)
  })

  it('user prompt labels the typed text as the question to answer', () => {
    const { user } = askPrompt(makeCtx(), [], 'why was this changed?', focus)
    expect(user).toMatch(/Question:\s*why was this changed\?/)
  })

  it('system prompt instructs the model to answer the user\'s question directly', () => {
    const { system } = askPrompt(makeCtx(), [], 'q', focus)
    expect(system).toMatch(/answer the user'?s question directly/i)
  })

  it('system prompt contains the VERY concise 2-4 sentences instruction', () => {
    const { system } = askPrompt(makeCtx(), [], 'q')
    expect(system).toMatch(/very concise/i)
    expect(system).toMatch(/2[-–]4 sentences/i)
    expect(system).toMatch(/unless code/i)
  })

  it('concision instruction is present with and without focus', () => {
    const withFocus = askPrompt(makeCtx(), [], 'q', focus).system
    const withoutFocus = askPrompt(makeCtx(), [], 'q').system
    expect(withFocus).toMatch(/2[-–]4 sentences/i)
    expect(withoutFocus).toMatch(/2[-–]4 sentences/i)
  })

  it('focus grounding (path:line + excerpt) is retained alongside the typed question', () => {
    const { system, user } = askPrompt(makeCtx(), [], 'my typed question', focus)
    expect(system).toContain('src/widget.ts:12')
    expect(user).toContain('-a\n+b')
    expect(user).toContain('my typed question')
  })
})

// ---------------------------------------------------------------------------
// PROMPT_VERSION v10 — anti-fatigue calibration across review-output prompts
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v10', () => {
  it('is at least 10 (bumped for anti-fatigue calibration — cache invalidation)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(10)
  })
})

// ---------------------------------------------------------------------------
// Shared anti-fatigue block — present in every JSON review-output prompt
// ---------------------------------------------------------------------------

describe('anti-fatigue calibration block (v10)', () => {
  const systems: Record<string, string> = {
    attention: attentionPrompt(makeCtx()).system,
    verdict: verdictPrompt(makeCtx(), null).system,
    testInsight: testInsightPrompt(makeCtx()).system,
    alternatives: alternativesPrompt(makeCtx()).system,
  }

  for (const [task, system] of Object.entries(systems)) {
    it(`${task}: carries the evidence gate (cite + concrete harm)`, () => {
      expect(system).toMatch(/Evidence gate/i)
      expect(system).toMatch(/what breaks, or who gets hurt/i)
      expect(system).toMatch(/stated failure mode/i)
    })

    it(`${task}: bans hedge phrasing without a failure mode ("consider...", "might want to...")`, () => {
      expect(system).toContain('"consider..."')
      expect(system).toContain('"might want to..."')
      expect(system).toContain('"ensure that..."')
    })

    it(`${task}: instructs "couldn't verify" or silence over assertion`, () => {
      expect(system).toMatch(/couldn't verify/i)
      expect(system).toMatch(/never assert/i)
    })

    it(`${task}: carries the brevity format (what+where / why it matters)`, () => {
      expect(system).toMatch(/WHAT \+ WHERE/i)
      expect(system).toMatch(/WHY IT MATTERS/i)
      expect(system).toMatch(/no praise padding, no methodology narration/i)
    })

    it(`${task}: states silence is a valid, GOOD answer`, () => {
      expect(system).toMatch(/Silence is a valid answer/i)
      expect(system).toMatch(/GOOD and expected outcome/i)
    })

    it(`${task}: carries severity honesty (nits are nits, never inflate)`, () => {
      expect(system).toMatch(/nits are nits/i)
      expect(system).toMatch(/never inflate/i)
    })
  }
})

// ---------------------------------------------------------------------------
// attentionPrompt — hard cap + omission note (v10)
// ---------------------------------------------------------------------------

describe('attentionPrompt — anti-fatigue caps (v10)', () => {
  it('caps hotspots at 5, ranked by severity × confidence', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/at most 5 hotspots/i)
    expect(system).toMatch(/severity × confidence/i)
  })

  it('instructs the one-line lower-confidence omission note', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/lower-confidence observations omitted/i)
  })

  it('states an empty hotspots array is a GOOD outcome', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/empty hotspots array\s+is a GOOD/i)
    expect(system).toMatch(/do\s+not invent hotspots/i)
  })

  it('constrains hotspot reasons to the two-sentence format', () => {
    const { system } = attentionPrompt(makeCtx())
    expect(system).toMatch(/one sentence of WHAT \+ WHERE plus one sentence of WHY IT MATTERS/i)
  })
})

// ---------------------------------------------------------------------------
// verdictPrompt — evidence caps (v10)
// ---------------------------------------------------------------------------

describe('verdictPrompt — anti-fatigue caps (v10)', () => {
  it('caps evidence at 5 one-sentence bullets', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/at most 5 evidence bullets/i)
    expect(system).toMatch(/ONE sentence/i)
  })

  it('bans diff restating and padding in evidence', () => {
    const { system } = verdictPrompt(makeCtx(), null)
    expect(system).toMatch(/do not restate the diff/i)
  })
})

// ---------------------------------------------------------------------------
// testInsightPrompt — gap caps + tightened prose (v10)
// ---------------------------------------------------------------------------

describe('testInsightPrompt — anti-fatigue caps (v10)', () => {
  it('caps gaps at 5, ranked by severity × confidence', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/at most 5 gaps/i)
    expect(system).toMatch(/severity × confidence/i)
  })

  it('instructs the one-line "General: N lower-confidence observations omitted" gap', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/General: N lower-confidence observations omitted/i)
  })

  it('states an empty gaps array is a GOOD outcome on well-tested changes', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/empty gaps array is a GOOD/i)
    expect(system).toMatch(/do\s+not invent gaps/i)
  })

  it('tightens covered behavior descriptions to terse bullets (≤12 words)', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/TERSE bullet/i)
    expect(system).toMatch(/12 words/i)
  })

  it('requires each gap to name the concrete harm if it regresses', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/concrete harm if it regresses/i)
  })
})

// ---------------------------------------------------------------------------
// alternativesPrompt — card prose caps (v10)
// ---------------------------------------------------------------------------

describe('alternativesPrompt — anti-fatigue caps (v10)', () => {
  it('caps approach at one sentence', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toMatch(/approach:[^.]*AT MOST ONE sentence/i)
  })

  it('caps tradeoffs at one sentence (one gain, one cost)', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toMatch(/tradeoffs:\s*AT MOST ONE sentence/i)
  })

  it('states an empty alternatives array is a GOOD outcome', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toMatch(/empty alternatives array is a GOOD/i)
  })
})

// ---------------------------------------------------------------------------
// summarizePrompt — length-cap drift audit (v10)
// ---------------------------------------------------------------------------

describe('summarizePrompt — anti-fatigue (v10)', () => {
  it('keeps an overall ~120-word ceiling on the whole summary', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toContain('120')
  })

  it('bans praise padding, methodology narration, and diff restating in the prose', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toMatch(/no praise padding/i)
    expect(system).toMatch(/no methodology narration/i)
    expect(system).toMatch(/do not restate the diff/i)
  })
})

// ---------------------------------------------------------------------------
// PROMPT_VERSION v11 — phase-1 tightening + test-insight/alternatives harness
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v11', () => {
  it('is at least 11 (bumped for phase-1 tightening — cache invalidation)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(11)
  })
})

// ---------------------------------------------------------------------------
// summarizePrompt — v11 hard 60-word TL;DR cap + sentinel-phrase discipline
// ---------------------------------------------------------------------------

describe('summarizePrompt — v11 TL;DR hard cap + sentinels', () => {
  it('states an explicit HARD CAP of 60 words on the TL;DR', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toMatch(/HARD CAP:\s*60 words/i)
    expect(system).toMatch(/TL;DR/i)
  })

  it('names the discipline as the sentinel tests the output is graded against', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toMatch(/sentinel tests/i)
  })

  it('forbids methodology narration with concrete banned phrases', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toMatch(/No methodology narration/i)
    expect(system).toContain('this PR appears to')
    expect(system).toContain('after reviewing')
  })

  it('forbids praise padding with concrete banned adjectives', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toMatch(/No praise padding/i)
    expect(system).toContain('clean')
    expect(system).toContain('well-structured')
  })

  it('still forbids restating the diff line-by-line', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toMatch(/Do not restate the diff/i)
  })
})

// ---------------------------------------------------------------------------
// testInsightPrompt — v11 terse grouped bullets + one-line harm gaps
// ---------------------------------------------------------------------------

describe('testInsightPrompt — v11 terse caps', () => {
  it('caps each covered behavior at a terse ≤12-word bullet', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/≤12 words|12 words/i)
    expect(system).toMatch(/TERSE bullet/i)
  })

  it('requires grouping related cases instead of per-assertion listing', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/GROUP related cases/i)
    expect(system).toMatch(/never list per-assertion|never.*per-assertion/i)
  })

  it('drops any prose intro / narration', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/no prose intro/i)
  })

  it('keeps gaps to one line each with concrete harm and the ≤5 cap', () => {
    const { system } = testInsightPrompt(makeCtx())
    expect(system).toMatch(/at most 5 gaps/i)
    expect(system).toMatch(/ONE line naming\s+the untested behavior AND the concrete harm/i)
  })
})

// ---------------------------------------------------------------------------
// alternativesPrompt — v11 one-sentence approach + one-sentence tradeoff
// ---------------------------------------------------------------------------

describe('alternativesPrompt — v11 one-sentence caps', () => {
  it('caps approach at AT MOST ONE sentence, no multi-paragraph cards', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toMatch(/approach:[^.]*AT MOST ONE sentence/i)
    expect(system).toMatch(/No multi-paragraph cards/i)
  })

  it('caps tradeoffs at AT MOST ONE sentence with exactly one gain and one cost', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toMatch(/tradeoffs:\s*AT MOST ONE sentence/i)
    expect(system).toMatch(/exactly one gain and one\s+cost/i)
  })

  it('caps the list at 3 alternatives', () => {
    const { system } = alternativesPrompt(makeCtx())
    expect(system).toMatch(/Maximum 3 alternatives|up to 3/i)
  })
})

// ---------------------------------------------------------------------------
// diagramsPrompt — v11 terse edge labels + no explanatory prose
// ---------------------------------------------------------------------------

describe('diagramsPrompt — terse labels (Plan L flow)', () => {
  it('caps edge/condition labels at ≤3 words', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toMatch(/Edge \/ condition labels ≤ 3 words/i)
  })

  it('forbids explanatory prose in the flow output', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toMatch(/Emit NO explanatory prose/i)
  })

  it('caps step labels at ≤6 words', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toMatch(/Step labels ≤ 6 words/i)
  })
})

// ---------------------------------------------------------------------------
// PROMPT_VERSION v13 — assume-best-intent + deep attention harness
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v13', () => {
  it('is at least 13 (bumped for assume-best-intent + deep attention — cache invalidation)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(13)
  })
})

// ---------------------------------------------------------------------------
// attentionPrompt — assume-best-intent calibration (v13)
//
// The framing applies to BOTH prompt paths (single-pass AND deep) — the
// calibration helps even without tools; deep mode adds verification on top.
// ---------------------------------------------------------------------------

describe('attentionPrompt — assume-best-intent (v13)', () => {
  for (const [label, opts] of [
    ['single-pass', undefined],
    ['deep', { deep: true }],
  ] as const) {
    it(`${label}: carries the assume-best-intent framing`, () => {
      const { system } = attentionPrompt(makeCtx(), opts)
      expect(system).toMatch(/Assume best intent/i)
      expect(system).toMatch(/competent engineer acting in good faith/i)
    })

    it(`${label}: states a file is NOT a hotspot just for being large or touched`, () => {
      const { system } = attentionPrompt(makeCtx(), opts)
      expect(system).toMatch(/NOT a hotspot because it is large/i)
      expect(system).toMatch(/simply because it was touched/i)
    })

    it(`${label}: flags genuine risk only — not style/preference/speculation`, () => {
      const { system } = attentionPrompt(makeCtx(), opts)
      expect(system).toMatch(/Flag ONLY genuine risk/i)
      expect(system).toMatch(/correctness/i)
      expect(system).toMatch(/blast radius/i)
      expect(system).toMatch(/security/i)
      expect(system).toMatch(/broken contract|contract.*stale|signature\/behavior/i)
      expect(system).toMatch(/Do NOT flag style, naming, preference/i)
      expect(system).toMatch(/could maybe break something/i)
    })

    it(`${label}: evidence gate — couldn't verify means DROP/stay silent`, () => {
      const { system } = attentionPrompt(makeCtx(), opts)
      expect(system).toMatch(/Evidence gate over alarm/i)
      expect(system).toMatch(/couldn't verify means stay silent|DROP it/i)
      expect(system).toMatch(/never assert/i)
    })

    it(`${label}: an empty hotspots list is the EXPECTED, GOOD outcome on a clean PR`, () => {
      const { system } = attentionPrompt(makeCtx(), opts)
      expect(system).toMatch(/EMPTY hotspots list is the EXPECTED, GOOD outcome/i)
      expect(system).toMatch(/clean, well-scoped PR/i)
      expect(system).toMatch(/Do not manufacture hotspots/i)
    })

    it(`${label}: still caps hotspots at 5`, () => {
      const { system } = attentionPrompt(makeCtx(), opts)
      expect(system).toMatch(/at most 5 hotspots/i)
    })
  }
})

// ---------------------------------------------------------------------------
// attentionPrompt — deep mode verification guidance (v13)
//
// Single-pass omits the tool-verification section (byte-identical to today's
// calibrated prompt save for the assume-best-intent block); deep mode adds the
// "verify each hotspot with the tools before reporting it" guidance.
// ---------------------------------------------------------------------------

describe('attentionPrompt — deep mode verification (v13)', () => {
  it('single-pass (default / deep:false) omits the deep verify-hotspot section', () => {
    const { system: def } = attentionPrompt(makeCtx())
    const { system: off } = attentionPrompt(makeCtx(), { deep: false })
    expect(def).not.toContain('VERIFY each hotspot before reporting it')
    expect(off).not.toContain('VERIFY each hotspot before reporting it')
    // Default and explicit deep:false are byte-identical
    expect(def).toBe(off)
  })

  it('deep mode adds the verify-each-hotspot-with-tools guidance', () => {
    const { system } = attentionPrompt(makeCtx(), { deep: true })
    expect(system).toContain('VERIFY each hotspot before reporting it')
    expect(system).toMatch(/read_file/i)
    expect(system).toMatch(/search_code/i)
    expect(system).toMatch(/callers\/consumers|callers|blast radius/i)
    expect(system).toMatch(/DROP any hotspot you cannot substantiate/i)
  })

  it('deep mode keeps the JSON shape + anti-fatigue + assume-best-intent', () => {
    const { system } = attentionPrompt(makeCtx(), { deep: true })
    expect(system).toContain('hotspots')
    expect(system).toContain('testFlags')
    expect(system).toMatch(/Anti-fatigue calibration/i)
    expect(system).toMatch(/Assume best intent/i)
  })
})

// ---------------------------------------------------------------------------
// storyOrderPrompt (Plan H — Story mode)
// ---------------------------------------------------------------------------

describe('storyOrderPrompt', () => {
  it('asks for JSON-only output matching the StoryOrderResult shape', () => {
    const { system, user } = storyOrderPrompt(makeCtx('story-context-123'))
    expect(system).toMatch(/JSON ONLY/i)
    expect(system).toContain('"steps"')
    expect(system).toContain('"caption"')
    expect(system).toContain('"layer"')
    expect(system).toContain('"relatedTests"')
    expect(user).toBe('story-context-123')
  })

  it('names every layer in the taxonomy', () => {
    const { system } = storyOrderPrompt(makeCtx())
    for (const layer of STORY_LAYERS) {
      expect(system).toContain(layer)
    }
  })

  it('states the chronological/logical ordering rule', () => {
    const { system } = storyOrderPrompt(makeCtx())
    expect(system).toMatch(/data\s*→\s*api\s*→\s*logic\s*→\s*tests\s*→\s*ui/i)
    expect(system).toMatch(/just before/i)
  })

  it('embeds the import graph when present (for ordering + test pairing)', () => {
    const ctx: PackedContext = { text: 'x', notAnalyzed: [], includedFiles: [], importGraph: 'A imports B' }
    const { system } = storyOrderPrompt(ctx)
    expect(system).toContain('A imports B')
  })

  it('caps the step count and tells the model to group aggressively on big PRs', () => {
    const { system } = storyOrderPrompt(makeCtx())
    expect(system).toMatch(/AT MOST 12 steps/i)
    expect(system).toMatch(/GROUP AGGRESSIVELY/i)
  })

  it('states the no-overlap invariant (every file in EXACTLY ONE step)', () => {
    const { system } = storyOrderPrompt(makeCtx())
    expect(system).toMatch(/EXACTLY ONE step/i)
    expect(system).toMatch(/NO OVERLAP/i)
  })

  it('single-pass variant does NOT include deep verification guidance', () => {
    const { system } = storyOrderPrompt(makeCtx())
    expect(system).not.toMatch(/Deep mode/i)
  })

  it('deep variant adds verification guidance for ordering + test-pairing', () => {
    const { system } = storyOrderPrompt(makeCtx(), { deep: true })
    expect(system).toMatch(/Deep mode/i)
    expect(system).toMatch(/read_file|search_code/i)
  })
})

describe('PROMPT_VERSION', () => {
  it('is bumped to 17 (Plan L: diagram → flow-of-execution output shape)', () => {
    expect(PROMPT_VERSION).toBe(17)
  })
})
