import { describe, it, expect, afterEach, vi } from 'vitest'
import { identifierAt, resolveClickedToken } from './clickToken'

describe('identifierAt', () => {
  const text = 'const total = computeTotal(items)'

  it('extracts the identifier spanning the offset', () => {
    // offset inside "computeTotal" (starts at 14)
    expect(identifierAt(text, 18)).toBe('computeTotal')
    expect(identifierAt(text, 14)).toBe('computeTotal') // first char
    expect(identifierAt(text, 25)).toBe('computeTotal') // last char
  })

  it('accepts a caret at the right edge of a token', () => {
    expect(identifierAt(text, 26)).toBe('computeTotal') // caret just after 'l'
    expect(identifierAt(text, 5)).toBe('const')
  })

  it('returns null on whitespace and punctuation', () => {
    expect(identifierAt('a +  b', 4)).toBe(null) // run of whitespace
    expect(identifierAt('a + b', 2)).toBe(null) // on the '+'
    expect(identifierAt('foo()', 4)).toBe(null) // between the parens
  })

  it('handles $ and _ identifiers', () => {
    expect(identifierAt('const $el = _priv', 7)).toBe('$el')
    expect(identifierAt('const $el = _priv', 13)).toBe('_priv')
  })

  it('rejects digit-led tokens and clamps out-of-range offsets', () => {
    expect(identifierAt('123abc', 2)).toBe(null)
    expect(identifierAt('token', 999)).toBe('token') // clamped to end → right-edge rule
    expect(identifierAt('', 0)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// resolveClickedToken — DOM shape mirrors @git-diff-view + lowlight output
// ---------------------------------------------------------------------------

function buildCell(innerHtml: string): HTMLElement {
  const td = document.createElement('td')
  td.className = 'diff-line-content'
  td.innerHTML = `<span class="diff-line-content-operator">+</span><span class="diff-line-syntax-raw">${innerHtml}</span>`
  document.body.appendChild(td)
  return td
}

afterEach(() => {
  document.body.innerHTML = ''
  // Remove any caret API stub installed by a test.
  delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
  delete (document as unknown as Record<string, unknown>).caretRangeFromPoint
  vi.restoreAllMocks()
})

describe('resolveClickedToken (caret API unavailable — fallback path)', () => {
  it('resolves a single-identifier hljs span', () => {
    const cell = buildCell('<span class="hljs-title function_">computeTotal</span>(items)')
    const span = cell.querySelector('.hljs-title') as Element
    expect(resolveClickedToken(span, 0, 0)).toBe('computeTotal')
  })

  it('rejects keyword, string, and comment spans', () => {
    const cell = buildCell(
      '<span class="hljs-keyword">const</span> <span class="hljs-string">"txt"</span> <span class="hljs-comment">// note</span>',
    )
    expect(resolveClickedToken(cell.querySelector('.hljs-keyword'), 0, 0)).toBe(null)
    expect(resolveClickedToken(cell.querySelector('.hljs-string'), 0, 0)).toBe(null)
    expect(resolveClickedToken(cell.querySelector('.hljs-comment'), 0, 0)).toBe(null)
  })

  it('rejects clicks outside the raw code spans (operator, line numbers, widgets)', () => {
    const cell = buildCell('<span class="hljs-title">name</span>')
    const operator = cell.querySelector('.diff-line-content-operator') as Element
    expect(resolveClickedToken(operator, 0, 0)).toBe(null)

    const num = document.createElement('td')
    num.className = 'diff-line-new-num'
    num.innerHTML = '<span data-line-num="3">3</span>'
    document.body.appendChild(num)
    expect(resolveClickedToken(num.querySelector('span'), 0, 0)).toBe(null)
  })

  it('rejects multi-token spans without a caret API (ambiguous)', () => {
    const cell = buildCell('plainCall(otherThing)')
    const raw = cell.querySelector('.diff-line-syntax-raw') as Element
    expect(resolveClickedToken(raw, 0, 0)).toBe(null)
  })

  it('rejects non-element targets', () => {
    expect(resolveClickedToken(null, 0, 0)).toBe(null)
  })
})

describe('resolveClickedToken (caret API available)', () => {
  it('extracts the exact token under the pointer from a multi-token text node', () => {
    const cell = buildCell('renderTotals(perItem)')
    const raw = cell.querySelector('.diff-line-syntax-raw') as Element
    const textNode = raw.firstChild as Node
    ;(document as unknown as Record<string, unknown>).caretPositionFromPoint = () => ({
      offsetNode: textNode,
      offset: 15, // inside "perItem"
    })
    expect(resolveClickedToken(raw, 10, 10)).toBe('perItem')
  })

  it('ignores caret results outside the clicked raw span', () => {
    const cell = buildCell('onlyToken')
    const raw = cell.querySelector('.diff-line-syntax-raw') as Element
    const elsewhere = document.createElement('div')
    elsewhere.textContent = 'unrelatedText'
    document.body.appendChild(elsewhere)
    ;(document as unknown as Record<string, unknown>).caretPositionFromPoint = () => ({
      offsetNode: elsewhere.firstChild as Node,
      offset: 3,
    })
    // Caret node not inside the raw span → falls back to single-identifier text.
    expect(resolveClickedToken(raw, 0, 0)).toBe('onlyToken')
  })

  it('rejects when the caret lands in an excluded child token', () => {
    const cell = buildCell('use(<span class="hljs-string">"lit"</span>)')
    const raw = cell.querySelector('.diff-line-syntax-raw') as Element
    const strNode = (raw.querySelector('.hljs-string') as Element).firstChild as Node
    ;(document as unknown as Record<string, unknown>).caretPositionFromPoint = () => ({
      offsetNode: strNode,
      offset: 2,
    })
    expect(resolveClickedToken(raw, 0, 0)).toBe(null)
  })
})
