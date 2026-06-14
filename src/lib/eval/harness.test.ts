/**
 * Tests for src/lib/eval/harness.ts — the LLM-agnostic eval core.
 *
 * Covers:
 * - packFixture produces a context whose text contains each file's path + patch.
 * - extractPath pulls source paths out of prose and ignores non-paths.
 * - runCase with a scripted mock produces a DETERMINISTIC scored result:
 *   a "good run" mock catches the real bug + avoids the noise → recall 1,
 *   noise-rate 0; a "noisy run" mock flags the noise nit → noise-rate 1;
 *   a "silent run" misses the bug → recall 0.
 * - output normalization: skill findings carry lines; attention hotspots are
 *   file-level; verdict evidence with a path becomes a file-level finding.
 */

import { describe, it, expect } from 'vitest'
import { runCase, packFixture, extractPath, type GoldenCase } from './harness'
import { mockComplete } from './mock'

// ---------------------------------------------------------------------------
// A tiny in-memory golden case: a real bug + a tempting noise nit.
// ---------------------------------------------------------------------------

const goldenCase: GoldenCase = {
  name: 'overflow-bug',
  fixture: {
    name: 'overflow-bug',
    files: [
      {
        path: 'src/pay.ts',
        patch: [
          '@@ -8,6 +8,9 @@',
          '+export function total(items: number[]): number {',
          '+  let sum = 0',
          '+  for (let i = 0; i <= items.length; i++) sum += items[i]',
          '+  return sum',
          '+}',
        ].join('\n'),
        contentAfter:
          'export function total(items: number[]): number {\n' +
          '  let sum = 0\n' +
          '  for (let i = 0; i <= items.length; i++) sum += items[i]\n' +
          '  return sum\n' +
          '}\n',
      },
    ],
    skills: [{ name: 'bug-hunter', content: 'Find correctness bugs only.' }],
  },
  expected: {
    real: [
      {
        file: 'src/pay.ts',
        line: 10,
        description: 'off-by-one: loop uses <= so it reads items[length] (undefined)',
      },
    ],
    noise: [
      {
        file: 'src/pay.ts',
        line: 9,
        description: 'prefer const over let for sum',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// packFixture
// ---------------------------------------------------------------------------

describe('packFixture', () => {
  it('includes each file path, its patch, and after-contents', () => {
    const ctx = packFixture(goldenCase.fixture)
    expect(ctx.text).toContain('src/pay.ts')
    expect(ctx.text).toContain('i <= items.length')
    expect(ctx.includedFiles).toEqual(['src/pay.ts'])
  })
})

// ---------------------------------------------------------------------------
// extractPath
// ---------------------------------------------------------------------------

describe('extractPath', () => {
  it('pulls a source path out of a sentence', () => {
    expect(extractPath('src/pay.ts changed its summation loop')).toBe('src/pay.ts')
  })

  it('matches a bare filename with a source extension', () => {
    expect(extractPath('config.json was added')).toBe('config.json')
  })

  it('returns null when there is no path', () => {
    expect(extractPath('this loop is off by one')).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// runCase — deterministic scored results from scripted mocks
// ---------------------------------------------------------------------------

describe('runCase (mock)', () => {
  it('a good run catches the real bug and avoids the noise', async () => {
    const responses = {
      'skill:bug-hunter': JSON.stringify({
        skillName: 'bug-hunter',
        findings: [
          {
            path: 'src/pay.ts',
            line: 10,
            severity: 'high',
            body: 'off-by-one: the loop condition uses <= so it reads items[length] which is undefined',
          },
        ],
      }),
    }
    const result = await runCase(goldenCase, mockComplete(responses))
    expect(result.score.realCaught).toBe(1)
    expect(result.score.recall).toBe(1)
    expect(result.score.noiseFlagged).toBe(0)
    expect(result.score.noiseRate).toBe(0)
    expect(result.score.precision).toBe(1)
  })

  it('is deterministic: same input → identical score', async () => {
    const responses = {
      'skill:bug-hunter': JSON.stringify({
        skillName: 'bug-hunter',
        findings: [
          { path: 'src/pay.ts', line: 10, severity: 'high', body: 'off-by-one reads items[length] undefined' },
        ],
      }),
    }
    const a = await runCase(goldenCase, mockComplete(responses))
    const b = await runCase(goldenCase, mockComplete(responses))
    expect(a.score).toEqual(b.score)
  })

  it('a noisy run that flags the style nit scores noise-rate 1', async () => {
    const responses = {
      'skill:bug-hunter': JSON.stringify({
        skillName: 'bug-hunter',
        findings: [
          { path: 'src/pay.ts', line: 9, severity: 'low', body: 'prefer const over let for the sum variable' },
        ],
      }),
    }
    const result = await runCase(goldenCase, mockComplete(responses))
    expect(result.score.noiseFlagged).toBe(1)
    expect(result.score.noiseRate).toBe(1)
    expect(result.score.realCaught).toBe(0)
  })

  it('a silent run (no scripted findings) misses the real bug', async () => {
    const result = await runCase(goldenCase, mockComplete({}))
    expect(result.score.realCaught).toBe(0)
    expect(result.score.recall).toBe(0)
    expect(result.score.noiseFlagged).toBe(0)
    expect(result.score.produced).toBe(0)
  })

  it('normalizes attention hotspots to file-level findings', async () => {
    const responses = {
      attention: JSON.stringify({
        readingOrder: ['src/pay.ts'],
        hotspots: [
          { path: 'src/pay.ts', level: 'high', reason: 'off-by-one in the summation loop reads items[length]' },
        ],
        testFlags: [],
      }),
    }
    const result = await runCase(goldenCase, mockComplete(responses))
    const hotspot = result.produced.find((p) => p.line === null && p.file === 'src/pay.ts')
    expect(hotspot).toBeDefined()
    expect(result.score.realCaught).toBe(1) // file-level matches the real bug line
  })

  it('maps verdict evidence with a path into a file-level finding', async () => {
    const responses = {
      verdict: JSON.stringify({
        level: 'significant-changes',
        evidence: ['src/pay.ts: off-by-one in the summation loop reads items[length] which is undefined'],
        notAnalyzed: [],
      }),
    }
    const result = await runCase(goldenCase, mockComplete(responses))
    const fromVerdict = result.produced.find((p) => p.file === 'src/pay.ts')
    expect(fromVerdict).toBeDefined()
  })
})
