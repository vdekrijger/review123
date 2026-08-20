/**
 * Tests for src/lib/github/reviewExport.ts — pure, deterministic builders that
 * turn a drafted review into a paste-ready command (browser console / gh / curl)
 * posting the WHOLE review to the GitHub PR without the OAuth app.
 *
 * The three formatters wrap the SAME payload (buildReviewPayload), which must
 * reproduce submitReview's request body EXACTLY.
 */

import { describe, it, expect } from 'vitest'
import {
  buildReviewPayload,
  buildBrowserConsoleSnippet,
  buildGhCommand,
  buildCurlScript,
  buildReviewCommand,
  type ReviewExportInput,
  type ReviewPayload,
} from './reviewExport'
import type { Draft } from '../drafts/drafts.svelte'

function input(overrides: Partial<ReviewExportInput> = {}): ReviewExportInput {
  return {
    owner: 'o',
    repo: 'r',
    number: 7,
    commitId: 'deadbeef',
    verdict: 'COMMENT',
    body: 'Overall: nice work.',
    drafts: [],
    ...overrides,
  }
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    prKey: 'o/r#7',
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    body: 'Use a constant here.',
    updatedAt: 0,
    ...overrides,
  }
}

/**
 * Extract the JSON object that follows the first occurrence of `marker` and
 * parse it. For the browser snippet (`const PAYLOAD = {...};`) and the heredoc
 * formats (delimited by `REVIEW_PAYLOAD`).
 */
function extractHeredocJson(text: string): unknown {
  const start = text.indexOf("<<'REVIEW_PAYLOAD'")
  expect(start).toBeGreaterThan(-1)
  const after = text.slice(text.indexOf('\n', start) + 1)
  const end = after.indexOf('\nREVIEW_PAYLOAD')
  expect(end).toBeGreaterThan(-1)
  return JSON.parse(after.slice(0, end))
}

function extractBrowserPayload(text: string): unknown {
  const marker = 'const PAYLOAD = '
  const start = text.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  // The payload is a pretty-printed object literal terminated by `;` at column 0.
  const after = text.slice(start + marker.length)
  const end = after.indexOf('\n};')
  expect(end).toBeGreaterThan(-1)
  return JSON.parse(after.slice(0, end + 2)) // include the closing `}`
}

// ---------------------------------------------------------------------------
// buildReviewPayload — must mirror submitReview exactly
// ---------------------------------------------------------------------------

describe('buildReviewPayload', () => {
  it('carries commit_id, body, and event', () => {
    const p = buildReviewPayload(input({ commitId: 'abc', body: 'hi', verdict: 'APPROVE' }))
    expect(p.commit_id).toBe('abc')
    expect(p.body).toBe('hi')
    expect(p.event).toBe('APPROVE')
  })

  it('maps each verdict to the event verbatim', () => {
    expect(buildReviewPayload(input({ verdict: 'APPROVE' })).event).toBe('APPROVE')
    expect(buildReviewPayload(input({ verdict: 'REQUEST_CHANGES' })).event).toBe('REQUEST_CHANGES')
    expect(buildReviewPayload(input({ verdict: 'COMMENT' })).event).toBe('COMMENT')
  })

  it('OMITS the comments key when there are no drafts', () => {
    const p = buildReviewPayload(input({ drafts: [] }))
    expect('comments' in p).toBe(false)
  })

  it('includes one comment per draft with path/line/side/body', () => {
    const p = buildReviewPayload(input({
      drafts: [draft({ path: 'src/x.ts', line: 5, side: 'LEFT', body: 'fix' })],
    }))
    expect(p.comments).toEqual([
      { path: 'src/x.ts', line: 5, side: 'LEFT', body: 'fix' },
    ])
  })

  it('adds start_line/start_side ONLY when startLine != null && startLine < line', () => {
    const p = buildReviewPayload(input({
      drafts: [draft({ startLine: 8, line: 12, side: 'RIGHT' })],
    }))
    expect(p.comments![0]).toMatchObject({ start_line: 8, start_side: 'RIGHT' })
  })

  it('does NOT add start_line when startLine equals line (not a real range)', () => {
    const p = buildReviewPayload(input({ drafts: [draft({ startLine: 10, line: 10 })] }))
    expect('start_line' in p.comments![0]).toBe(false)
    expect('start_side' in p.comments![0]).toBe(false)
  })

  it('does NOT add start_line when startLine > line', () => {
    const p = buildReviewPayload(input({ drafts: [draft({ startLine: 20, line: 10 })] }))
    expect('start_line' in p.comments![0]).toBe(false)
  })

  it('does NOT add start_line when startLine is undefined', () => {
    const p = buildReviewPayload(input({ drafts: [draft({ startLine: undefined, line: 10 })] }))
    expect('start_line' in p.comments![0]).toBe(false)
  })

  it('is deterministic for identical input', () => {
    const i = input({ drafts: [draft(), draft({ line: 4 })] })
    expect(buildReviewPayload(i)).toEqual(buildReviewPayload(i))
  })

  it('prepends the 🤖 AI-suggested marker for AI-authored drafts (hand-written verbatim)', () => {
    const p = buildReviewPayload(input({
      drafts: [
        draft({ path: 'a.ts', line: 1, body: 'Use a constant.', aiAuthored: true, aiReviewer: 'Security' }),
        draft({ path: 'b.ts', line: 2, body: 'My own note.' }),
      ],
    }))
    expect(p.comments![0].body).toBe('🤖 _AI-suggested · Security_\n\nUse a constant.')
    expect(p.comments![1].body).toBe('My own note.')
  })

  it('maps MULTIPLE drafts at the SAME line (n=0 and n=1) to separate comments', () => {
    // Multi-drafts-per-line: every draft at a line goes out as its own review
    // comment (GitHub/GitLab allow several comments on one line).
    const p = buildReviewPayload(input({
      drafts: [
        draft({ path: 'src/x.ts', line: 5, side: 'RIGHT', body: 'First comment', n: 0 }),
        draft({ path: 'src/x.ts', line: 5, side: 'RIGHT', body: 'Second comment', n: 1 }),
      ],
    }))
    expect(p.comments).toEqual([
      { path: 'src/x.ts', line: 5, side: 'RIGHT', body: 'First comment' },
      { path: 'src/x.ts', line: 5, side: 'RIGHT', body: 'Second comment' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Off-diff coherence — with `files` the payload applies the SAME split as
// submitReview: only anchorable drafts ride comments[]; off-diff drafts fold
// into the body's marked section (a one-shot command cannot post file-level
// comments, and leaving them inline would make the exported command 422).
// ---------------------------------------------------------------------------
describe('buildReviewPayload — off-diff split (files provided)', () => {
  // RIGHT lines 1..4 in this patch
  const PATCH = '@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added2\n context'
  const FILES = [{ filename: 'src/a.ts', patch: PATCH }]

  it('off-diff draft moves from comments[] into the body fold section', () => {
    const p = buildReviewPayload(input({
      files: FILES,
      drafts: [
        draft({ line: 3, body: 'In-diff comment' }),
        draft({ line: 99, body: 'Off-diff comment' }),
      ],
    }))
    expect(p.comments).toEqual([
      { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'In-diff comment' },
    ])
    expect(p.body).toContain('#### Comments on lines outside the diff')
    expect(p.body).toContain('**src/a.ts:99** — Off-diff comment')
    expect(p.body).toContain('Overall: nice work.')
  })

  it('ALL drafts off-diff → comments key omitted entirely, everything folded', () => {
    const p = buildReviewPayload(input({
      files: FILES,
      drafts: [draft({ line: 99, body: 'Only off-diff' })],
    }))
    expect('comments' in p).toBe(false)
    expect(p.body).toContain('**src/a.ts:99** — Only off-diff')
  })

  it('without files the payload is unchanged (no split, no fold)', () => {
    const p = buildReviewPayload(input({
      drafts: [draft({ line: 99, body: 'Anywhere' })],
    }))
    expect(p.comments).toHaveLength(1)
    expect(p.body).toBe('Overall: nice work.')
  })

  it('AI-authored off-diff draft keeps the 🤖 marker inside the folded body', () => {
    const p = buildReviewPayload(input({
      files: FILES,
      drafts: [draft({ line: 99, body: 'Check this.', aiAuthored: true, aiReviewer: 'Security' })],
    }))
    expect(p.body).toContain('🤖 _AI-suggested · Security_')
    expect(p.body).toContain('Check this.')
  })
})

// ---------------------------------------------------------------------------
// The 🤖 marker travels through all three console formats for AI-authored drafts
// ---------------------------------------------------------------------------
describe('AI-authored marker across console formats', () => {
  const aiInput = () => input({
    drafts: [draft({ path: 'a.ts', line: 1, body: 'Use a constant.', aiAuthored: true, aiReviewer: 'Security' })],
  })

  it('browser console snippet carries the marker', () => {
    const payload = extractBrowserPayload(buildBrowserConsoleSnippet(aiInput())) as ReviewPayload
    expect(payload.comments![0].body).toBe('🤖 _AI-suggested · Security_\n\nUse a constant.')
  })

  it('gh command carries the marker', () => {
    const payload = extractHeredocJson(buildGhCommand(aiInput())) as ReviewPayload
    expect(payload.comments![0].body).toBe('🤖 _AI-suggested · Security_\n\nUse a constant.')
  })

  it('curl script carries the marker', () => {
    const payload = extractHeredocJson(buildCurlScript(aiInput())) as ReviewPayload
    expect(payload.comments![0].body).toBe('🤖 _AI-suggested · Security_\n\nUse a constant.')
  })
})

// ---------------------------------------------------------------------------
// A body with awkward characters used across the round-trip tests.
// ---------------------------------------------------------------------------

const AWKWARD = "It's a `backtick` and $VAR and a newline\nand a ```suggestion\nx = 1\n``` block."

// ---------------------------------------------------------------------------
// buildBrowserConsoleSnippet
// ---------------------------------------------------------------------------

describe('buildBrowserConsoleSnippet', () => {
  it('contains the api.github.com reviews URL for the PR', () => {
    const out = buildBrowserConsoleSnippet(input({ owner: 'acme', repo: 'w', number: 42 }))
    expect(out).toContain('https://api.github.com/repos/acme/w/pulls/42/reviews')
  })

  it('uses Bearer token auth and the GitHub Accept + API version headers', () => {
    const out = buildBrowserConsoleSnippet(input())
    expect(out).toContain('"Authorization": "Bearer " + TOKEN')
    expect(out).toContain('application/vnd.github+json')
    expect(out).toContain('2022-11-28')
  })

  it('prompts for a token and guards against an empty token', () => {
    const out = buildBrowserConsoleSnippet(input())
    expect(out).toContain('prompt(')
    expect(out).toMatch(/if \(!TOKEN\)/)
    expect(out).toContain('throw')
  })

  it('embeds the payload as parseable JSON equal to buildReviewPayload', () => {
    const i = input({ drafts: [draft({ startLine: 8, line: 12 })] })
    const out = buildBrowserConsoleSnippet(i)
    const parsed = extractBrowserPayload(out) as ReviewPayload
    expect(parsed).toEqual(buildReviewPayload(i))
  })

  it("round-trips an awkward body (quotes, backtick, $VAR, newline, ```suggestion) intact", () => {
    const i = input({ drafts: [draft({ body: AWKWARD })] })
    const parsed = extractBrowserPayload(buildBrowserConsoleSnippet(i)) as ReviewPayload
    expect(parsed.comments![0].body).toBe(AWKWARD)
  })
})

// ---------------------------------------------------------------------------
// buildGhCommand
// ---------------------------------------------------------------------------

describe('buildGhCommand', () => {
  it('uses gh api --method POST with the reviews path and --input -', () => {
    const out = buildGhCommand(input({ owner: 'o', repo: 'r', number: 7 }))
    expect(out).toContain('gh api --method POST')
    expect(out).toContain('"/repos/o/r/pulls/7/reviews"')
    expect(out).toContain('--input -')
  })

  it('does not reference any token (uses gh login)', () => {
    const out = buildGhCommand(input())
    expect(out).not.toContain('GITHUB_TOKEN')
    expect(out).not.toContain('Bearer')
  })

  it('carries the payload in a single-quoted heredoc that parses to buildReviewPayload', () => {
    const i = input({ drafts: [draft(), draft({ path: 'src/b.ts', line: 3 })] })
    const out = buildGhCommand(i)
    expect(out).toContain("<<'REVIEW_PAYLOAD'")
    expect(extractHeredocJson(out)).toEqual(buildReviewPayload(i))
  })

  it('round-trips an awkward body through the single-quoted heredoc', () => {
    const i = input({ drafts: [draft({ body: AWKWARD })] })
    const parsed = extractHeredocJson(buildGhCommand(i)) as ReviewPayload
    expect(parsed.comments![0].body).toBe(AWKWARD)
  })
})

// ---------------------------------------------------------------------------
// buildCurlScript
// ---------------------------------------------------------------------------

describe('buildCurlScript', () => {
  it('checks $GITHUB_TOKEN is set', () => {
    const out = buildCurlScript(input())
    expect(out).toContain('GITHUB_TOKEN')
    expect(out).toMatch(/if \[ -z "\$\{GITHUB_TOKEN:-\}" \]/)
  })

  it('uses the Authorization Bearer header and the reviews URL', () => {
    const out = buildCurlScript(input({ owner: 'o', repo: 'r', number: 7 }))
    expect(out).toContain('Authorization: Bearer $GITHUB_TOKEN')
    expect(out).toContain('https://api.github.com/repos/o/r/pulls/7/reviews')
  })

  it('carries the payload in a single-quoted heredoc that parses to buildReviewPayload', () => {
    const i = input({ drafts: [draft({ startLine: 2, line: 6 })] })
    const out = buildCurlScript(i)
    expect(out).toContain("<<'REVIEW_PAYLOAD'")
    expect(extractHeredocJson(out)).toEqual(buildReviewPayload(i))
  })

  it('round-trips an awkward body through the single-quoted heredoc', () => {
    const i = input({ drafts: [draft({ body: AWKWARD })] })
    const parsed = extractHeredocJson(buildCurlScript(i)) as ReviewPayload
    expect(parsed.comments![0].body).toBe(AWKWARD)
  })
})

// ---------------------------------------------------------------------------
// buildReviewCommand dispatch
// ---------------------------------------------------------------------------

describe('buildReviewCommand', () => {
  it('dispatches to the browser snippet', () => {
    expect(buildReviewCommand('browser', input())).toBe(buildBrowserConsoleSnippet(input()))
  })
  it('dispatches to the gh command', () => {
    expect(buildReviewCommand('gh', input())).toBe(buildGhCommand(input()))
  })
  it('dispatches to the curl script', () => {
    expect(buildReviewCommand('curl', input())).toBe(buildCurlScript(input()))
  })
})
