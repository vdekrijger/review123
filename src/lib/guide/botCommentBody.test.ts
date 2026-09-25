/**
 * src/lib/guide/botCommentBody — the two rewrites applied to a revealed bot
 * comment, and (mostly) the cases where they must NOT fire.
 *
 * This is somebody else's markdown. The bulk of this file is therefore about
 * restraint: prose outside the disclosures, a heading that merely resembles the
 * one we drop, markup inside a code fence, unbalanced tags, and a body that
 * would be emptied. Each of those leaves the source byte-for-byte alone.
 */
import { describe, it, expect } from 'vitest'
import {
  maskCode,
  topLevelDisclosures,
  plainWords,
  isAllDisclosures,
  openFirstDisclosure,
  stripAiPromptDisclosure,
  presentCommentBody,
} from './botCommentBody'
import { renderMarkdown } from '../markdown/render'

/** The shape from the screenshot: four sections, no prose outside them. */
const FOUR_SECTIONS = [
  '<details><summary>Issue description</summary>',
  '',
  'The catch block re-throws without a handler.',
  '',
  '</details>',
  '<details><summary>Why we think it is a valid issue</summary>',
  '',
  'Unhandled rejections crash the page.',
  '',
  '</details>',
  '<details><summary>Suggested fix</summary>',
  '',
  'Route the failure to component state.',
  '',
  '</details>',
  '<details><summary>Prompt to fix with AI (copy-paste)</summary>',
  '',
  'Fix the unhandled rejection in useSearch.ts.',
  '',
  '</details>',
].join('\n')

describe('maskCode', () => {
  it('fills fenced content with non-whitespace of the same length', () => {
    const src = '```ts\n<details>x</details>\n```'
    const out = maskCode(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('<details>')
    // Filler is NOT whitespace: a fence is content, not emptiness.
    expect(out.split('\n')[1].trim()).not.toBe('')
  })

  it('masks inline code spans', () => {
    const out = maskCode('write `<summary>` here')
    expect(out).not.toContain('<summary>')
    expect(out.length).toBe('write `<summary>` here'.length)
  })

  it('leaves ordinary prose alone', () => {
    expect(maskCode('plain <details>x</details>')).toBe('plain <details>x</details>')
  })

  it('handles ~~~ fences and a longer backtick run', () => {
    expect(maskCode('~~~\n<details>\n~~~')).not.toContain('<details>')
    expect(maskCode('````\n<details>\n````')).not.toContain('<details>')
  })
})

describe('topLevelDisclosures', () => {
  it('finds the four sections and their summaries', () => {
    const spans = topLevelDisclosures(FOUR_SECTIONS)!
    expect(spans.map((s) => s.summary)).toEqual([
      'issue description',
      'why we think it is a valid issue',
      'suggested fix',
      'prompt to fix with ai (copy-paste)',
    ])
  })

  it('reports the OUTER element only when disclosures nest', () => {
    const spans = topLevelDisclosures(
      '<details><summary>Outer</summary><details><summary>Inner</summary>x</details></details>',
    )!
    expect(spans).toHaveLength(1)
    expect(spans[0].summary).toBe('outer')
  })

  it('never names a section after a sub-section', () => {
    const spans = topLevelDisclosures(
      '<details><details><summary>Inner</summary>x</details></details>',
    )!
    expect(spans[0].summary).toBe('')
  })

  it('ignores markup inside a code fence', () => {
    expect(topLevelDisclosures('```\n<details><summary>x</summary>\n```')).toEqual([])
  })

  it('returns null on an unclosed <details>', () => {
    expect(topLevelDisclosures('<details><summary>x</summary>no end')).toBeNull()
  })

  it('returns null on a stray </details>', () => {
    expect(topLevelDisclosures('text </details>')).toBeNull()
  })

  it('reads an existing open attribute', () => {
    expect(topLevelDisclosures('<details open><summary>x</summary>y</details>')![0].alreadyOpen).toBe(
      true,
    )
    expect(
      topLevelDisclosures('<details class="opener"><summary>x</summary>y</details>')![0].alreadyOpen,
    ).toBe(false)
  })
})

describe('plainWords', () => {
  it('reduces markup and markdown to lowercase words', () => {
    expect(plainWords('<b>Prompt</b> to **fix** with `AI`')).toBe('prompt to fix with ai')
  })

  it('drops a leading badge or emoji', () => {
    expect(plainWords('🤖 Prompt to fix with AI')).toBe('prompt to fix with ai')
  })
})

describe('isAllDisclosures', () => {
  it('is true for the four-section body', () => {
    expect(isAllDisclosures(FOUR_SECTIONS)).toBe(true)
  })

  it('is false when there is prose before the disclosures', () => {
    expect(isAllDisclosures('P1 The handler swallows errors.\n\n<details><summary>More</summary>x</details>')).toBe(
      false,
    )
  })

  it('is false when there is prose after the disclosures', () => {
    expect(isAllDisclosures('<details><summary>More</summary>x</details>\n\nSee the rule page.')).toBe(false)
  })

  it('is false when a code fence sits outside the disclosures', () => {
    expect(isAllDisclosures('```\ncode\n```\n<details><summary>x</summary>y</details>')).toBe(false)
  })

  it('is false for a body with no disclosures at all', () => {
    expect(isAllDisclosures('Just a sentence.')).toBe(false)
  })

  it('is false when the markup does not balance', () => {
    expect(isAllDisclosures('<details><summary>x</summary>')).toBe(false)
  })
})

describe('openFirstDisclosure', () => {
  it('opens the first section and leaves the rest shut', () => {
    const out = openFirstDisclosure(FOUR_SECTIONS)
    expect(out).toContain('<details open><summary>Issue description</summary>')
    expect(out.match(/<details open>/g)).toHaveLength(1)
  })

  it('survives the renderMarkdown → DOMPurify boundary as a real open attribute', () => {
    const html = renderMarkdown(openFirstDisclosure(FOUR_SECTIONS))
    expect(html).toContain('<details open=""><summary>Issue description</summary>')
  })

  it('keeps existing attributes when opening', () => {
    expect(openFirstDisclosure('<details class="x"><summary>a</summary>b</details>')).toBe(
      '<details open class="x"><summary>a</summary>b</details>',
    )
  })

  it('leaves a body that already opens its first section alone', () => {
    const src = '<details open><summary>a</summary>b</details>'
    expect(openFirstDisclosure(src)).toBe(src)
  })

  it('leaves a body with prose outside the disclosures alone', () => {
    const src = 'P1 Broken.\n<details><summary>a</summary>b</details>'
    expect(openFirstDisclosure(src)).toBe(src)
  })

  it('leaves an unbalanced body alone', () => {
    const src = '<details><summary>a</summary>b'
    expect(openFirstDisclosure(src)).toBe(src)
  })
})

describe('stripAiPromptDisclosure — the one section it will drop', () => {
  it('drops "Prompt to fix with AI (copy-paste)" and keeps the other three', () => {
    const out = stripAiPromptDisclosure(FOUR_SECTIONS)
    expect(out.stripped).toBe(true)
    expect(out.body).not.toContain('Prompt to fix with AI')
    expect(out.body).not.toContain('Fix the unhandled rejection')
    expect(out.body).toContain('Issue description')
    expect(out.body).toContain('Why we think it is a valid issue')
    expect(out.body).toContain('Suggested fix')
  })

  it('matches without the trailing "(copy-paste)"', () => {
    const src = '<details><summary>a</summary>b</details><details><summary>Prompt to fix with AI</summary>p</details>'
    expect(stripAiPromptDisclosure(src).stripped).toBe(true)
  })

  for (const summary of [
    'Suggested fix',
    'Prompt',
    'Fix with AI',
    'AI prompt',
    'Prompt for AI agent',
    'How we prompt to fix with AI internally',
    'A prompt to fix with AI',
    'Prompt to fix without AI',
  ]) {
    it(`leaves "${summary}" alone — the rule is an exact opening phrase, not a fuzzy match`, () => {
      const src = `<details><summary>Issue</summary>i</details><details><summary>${summary}</summary>keep-me</details>`
      const out = stripAiPromptDisclosure(src)
      expect(out.stripped).toBe(false)
      expect(out.body).toBe(src)
    })
  }

  it('never drops a NESTED section, only a top-level one', () => {
    const src =
      '<details><summary>Issue</summary><details><summary>Prompt to fix with AI</summary>p</details></details>'
    const out = stripAiPromptDisclosure(src)
    expect(out.stripped).toBe(false)
    expect(out.body).toBe(src)
  })

  it('never empties a comment: a body that is ONLY that section survives whole', () => {
    const src = '<details><summary>Prompt to fix with AI (copy-paste)</summary>p</details>'
    const out = stripAiPromptDisclosure(src)
    expect(out.stripped).toBe(false)
    expect(out.body).toBe(src)
  })

  it('keeps prose that sits outside the dropped section', () => {
    const src =
      'P1 The handler swallows errors.\n\n<details><summary>Prompt to fix with AI</summary>p</details>'
    const out = stripAiPromptDisclosure(src)
    expect(out.stripped).toBe(true)
    expect(out.body.trim()).toBe('P1 The handler swallows errors.')
  })

  it('ignores a match inside a code fence', () => {
    const src = '```\n<details><summary>Prompt to fix with AI</summary>p</details>\n```'
    const out = stripAiPromptDisclosure(src)
    expect(out.stripped).toBe(false)
    expect(out.body).toBe(src)
  })

  it('leaves an unbalanced body alone', () => {
    const src = '<details><summary>Prompt to fix with AI</summary>p'
    expect(stripAiPromptDisclosure(src)).toEqual({ body: src, stripped: false })
  })
})

describe('presentCommentBody — the whole treatment, in order', () => {
  it('a bot comment loses the AI prompt and opens what is left', () => {
    const out = presentCommentBody(FOUR_SECTIONS, true)
    expect(out.stripped).toBe(true)
    expect(out.body).toContain('<details open><summary>Issue description</summary>')
    expect(out.body).not.toContain('Prompt to fix with AI')
    // Still all disclosures after the drop, so the open applies to the rest.
    expect(topLevelDisclosures(out.body)).toHaveLength(3)
  })

  it("a person's disclosure-only body is opened but never stripped", () => {
    const out = presentCommentBody(FOUR_SECTIONS, false)
    expect(out.stripped).toBe(false)
    expect(out.body).toContain('Prompt to fix with AI')
    expect(out.body).toContain('<details open><summary>Issue description</summary>')
  })

  it('an ordinary prose comment passes through byte-for-byte', () => {
    const src = 'Should `signal` be required rather than optional?'
    expect(presentCommentBody(src, true)).toEqual({ body: src, stripped: false })
    expect(presentCommentBody(src, false)).toEqual({ body: src, stripped: false })
  })

  it('an empty body is untouched', () => {
    expect(presentCommentBody('', true)).toEqual({ body: '', stripped: false })
  })
})
