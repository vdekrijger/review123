/**
 * Tests for src/lib/ai/reviewPrompt.ts — buildReviewPrompt (pure, deterministic).
 */

import { describe, it, expect } from 'vitest'
import { buildReviewPrompt, fenceLangForPath, type ReviewPromptInput } from './reviewPrompt'
import type { Draft } from '../drafts/drafts.svelte'
import type { PrFile } from '../github/types'

function pr(): ReviewPromptInput['pr'] {
  return {
    owner: 'acme',
    repo: 'widgets',
    number: 42,
    title: 'Add the thing',
    provider: 'GitHub',
    url: 'https://github.com/acme/widgets/pull/42',
  }
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    prKey: 'acme/widgets#42',
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    body: 'Use a constant here.',
    updatedAt: 0,
    ...overrides,
  }
}

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    filename: 'src/a.ts',
    status: 'modified',
    patch: ['@@ -8,4 +8,4 @@', ' before', '-old line', '+const x = 1', ' after'].join('\n'),
    additions: 1,
    deletions: 1,
    ...overrides,
  }
}

describe('fenceLangForPath', () => {
  it('maps known extensions', () => {
    expect(fenceLangForPath('src/a.ts')).toBe('ts')
    expect(fenceLangForPath('x.svelte')).toBe('svelte')
    expect(fenceLangForPath('s.py')).toBe('python')
  })
  it('returns empty for unknown / no extension', () => {
    expect(fenceLangForPath('Makefile')).toBe('')
    expect(fenceLangForPath('a.zzz')).toBe('')
  })
})

describe('buildReviewPrompt', () => {
  it('includes the preamble with repo, PR number, title, and url', () => {
    const out = buildReviewPrompt({ pr: pr(), drafts: [] })
    expect(out).toContain('acme/widgets')
    expect(out).toContain('PR #42 — Add the thing')
    expect(out).toContain('https://github.com/acme/widgets/pull/42')
    expect(out).toContain('Preserve existing style and tests')
  })

  it('renders one numbered section per draft with file:line, request and code fence', () => {
    const out = buildReviewPrompt({
      pr: pr(),
      drafts: [draft({ line: 10, body: 'Use a constant here.' })],
      files: [file()],
    })
    expect(out).toContain('### 1. src/a.ts:10 (RIGHT)')
    expect(out).toContain('**Request:**')
    expect(out).toContain('Use a constant here.')
    expect(out).toContain('**Current code:**')
    expect(out).toContain('```ts')
    expect(out).toContain('const x = 1')
  })

  it('uses fileWindow from contents when available', () => {
    const contents = new Map([
      ['src/a.ts', { before: null, after: ['l1', 'l2', 'TARGET', 'l4', 'l5'].join('\n') }],
    ])
    const out = buildReviewPrompt({
      pr: pr(),
      drafts: [draft({ line: 3 })],
      contents,
    })
    expect(out).toContain('TARGET')
  })

  it('notes a multi-line range', () => {
    const out = buildReviewPrompt({
      pr: pr(),
      drafts: [draft({ startLine: 8, line: 12 })],
    })
    expect(out).toContain('lines 8–12, RIGHT')
  })

  it('renders a ```suggestion block as a proposed change', () => {
    const body = 'Rename this.\n\n```suggestion\nconst better = 1\n```'
    const out = buildReviewPrompt({ pr: pr(), drafts: [draft({ body })] })
    expect(out).toContain('**Proposed change:**')
    expect(out).toContain('const better = 1')
  })

  it('appends an Overall comment section when present', () => {
    const out = buildReviewPrompt({ pr: pr(), drafts: [], overall: 'Nice work overall.' })
    expect(out).toContain('## Overall comment')
    expect(out).toContain('Nice work overall.')
  })

  it('omits the Overall comment section when blank', () => {
    const out = buildReviewPrompt({ pr: pr(), drafts: [draft()], overall: '   ' })
    expect(out).not.toContain('## Overall comment')
  })

  it('produces a prompt with only an overall comment and no drafts', () => {
    const out = buildReviewPrompt({ pr: pr(), drafts: [], overall: 'Just a note.' })
    expect(out).toContain('## Overall comment')
    expect(out).toContain('Just a note.')
    expect(out).not.toContain('### 1.')
  })

  it('orders drafts deterministically by path then line', () => {
    const out = buildReviewPrompt({
      pr: pr(),
      drafts: [
        draft({ path: 'src/z.ts', line: 5 }),
        draft({ path: 'src/a.ts', line: 30 }),
        draft({ path: 'src/a.ts', line: 3 }),
      ],
    })
    const i1 = out.indexOf('src/a.ts:3')
    const i2 = out.indexOf('src/a.ts:30')
    const i3 = out.indexOf('src/z.ts:5')
    expect(i1).toBeGreaterThan(-1)
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
    // numbering follows sorted order
    expect(out).toContain('### 1. src/a.ts:3')
    expect(out).toContain('### 2. src/a.ts:30')
    expect(out).toContain('### 3. src/z.ts:5')
  })

  it('includes the verdict line when REQUEST_CHANGES is chosen', () => {
    const out = buildReviewPrompt({ pr: pr(), drafts: [draft()], verdict: 'REQUEST_CHANGES' })
    expect(out).toContain('requested changes')
  })

  it('includes the verdict line when APPROVE is chosen', () => {
    const out = buildReviewPrompt({ pr: pr(), drafts: [draft()], verdict: 'APPROVE' })
    expect(out).toContain('approved')
  })

  it('omits a verdict line for the neutral COMMENT verdict', () => {
    const out = buildReviewPrompt({ pr: pr(), drafts: [draft()], verdict: 'COMMENT' })
    expect(out).not.toContain('Overall verdict:')
  })

  it('is deterministic for identical input', () => {
    const input: ReviewPromptInput = { pr: pr(), drafts: [draft(), draft({ line: 4 })], files: [file()] }
    expect(buildReviewPrompt(input)).toBe(buildReviewPrompt(input))
  })
})
