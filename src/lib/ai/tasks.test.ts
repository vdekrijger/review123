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
  askPrompt,
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

  it('system prompt instructs max 14 nodes for changeMap (D1)', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toMatch(/14\s+nodes|14 nodes/i)
  })

  it('system prompt instructs labels ≤ 3 words', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toMatch(/3 words|three words/i)
  })

  // D1: changeMap instructions
  it('system prompt mentions changeMap field (D1)', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('changeMap')
  })

  it('system prompt mentions all four status enum values (D1)', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toContain('"added"')
    expect(system).toContain('"removed"')
    expect(system).toContain('"changed"')
    expect(system).toContain('"unchanged"')
  })

  it('system prompt instructs that every node and edge in changeMap must carry a status (D1)', () => {
    const { system } = diagramsPrompt(makeCtx())
    // Should instruct status is required on all nodes and edges in changeMap
    expect(system).toMatch(/every node.*status|every edge.*status|must carry a status/i)
  })

  it('few-shot example contains status field on a node (D1)', () => {
    const { system } = diagramsPrompt(makeCtx())
    // The FEW_SHOT_EXAMPLE_START block must demonstrate statuses
    const fewShotStart = system.indexOf('FEW_SHOT_EXAMPLE_START')
    const fewShotEnd = system.indexOf('FEW_SHOT_EXAMPLE_END')
    expect(fewShotStart).toBeGreaterThan(-1)
    const fewShotBlock = system.slice(fewShotStart, fewShotEnd)
    expect(fewShotBlock).toContain('"status"')
    expect(fewShotBlock).toContain('"added"')
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

  it('user prompt is valid JSON containing all draft entries', () => {
    const { user } = coachPrompt(drafts)
    const parsed = JSON.parse(user)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].body).toBe('This variable name is confusing.')
    expect(parsed[1].body).toBe('You should never do it this way.')
  })

  it('handles empty drafts array gracefully', () => {
    const { system, user } = coachPrompt([])
    expect(typeof system).toBe('string')
    const parsed = JSON.parse(user)
    expect(parsed).toEqual([])
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
