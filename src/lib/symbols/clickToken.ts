/**
 * src/lib/symbols/clickToken.ts — Resolve which identifier a click in the
 * rendered diff landed on (symbol click-through, Tier 1).
 *
 * The @git-diff-view DOM shape (with the lowlight highlighter registered):
 *
 *   td.diff-line-content            (unified)  — or old/new-content (split)
 *     span.diff-line-content-operator   "+" / "-" marker
 *     span.diff-line-syntax-raw         highlighted code…
 *       span.hljs-keyword / .hljs-title / … <text>   (hljs-style classes)
 *     span.diff-line-content-raw        …or plain code text (no highlight)
 *
 * Strategy: a click qualifies ONLY when it lands inside a `-raw` code span
 * (this excludes line numbers, +/- operators, add-comment widgets, and the
 * extend-row annotation content by construction). Clicks on spans classed as
 * keywords / strings / comments / other non-symbol token kinds are rejected.
 * The exact token is extracted from the caret position under the pointer
 * (document.caretPositionFromPoint / caretRangeFromPoint) and trimmed to the
 * identifier charset; when the caret API is unavailable we fall back to the
 * clicked span's text if — and only if — it is exactly one identifier.
 */

/** Identifier charset shared with the symbol index (JS-style, incl. `$`). */
const IDENT_CHAR = /[A-Za-z0-9_$]/
const IDENT_START = /[A-Za-z_$]/
const IDENT_EXACT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * hljs token classes that are never clickable symbols: language keywords,
 * string/comment content, literals/numbers, regexes, punctuation, meta.
 */
const EXCLUDED_TOKEN_CLASSES = [
  'hljs-keyword',
  'hljs-string',
  'hljs-comment',
  'hljs-literal',
  'hljs-number',
  'hljs-regexp',
  'hljs-operator',
  'hljs-punctuation',
  'hljs-meta',
  'hljs-doctag',
  'hljs-char',
]

/**
 * Extract the identifier that spans `offset` in `text`. The offset may sit on
 * any character of the identifier, or immediately AFTER its last character
 * (a caret position at a token's right edge). Returns null when the position
 * isn't on an identifier or the identifier would start with a digit.
 */
export function identifierAt(text: string, offset: number): string | null {
  if (text.length === 0) return null
  let pos = Math.max(0, Math.min(offset, text.length))
  // A caret at the right edge of a token reports the index AFTER it — step
  // back one when the char at `pos` isn't part of an identifier.
  if (pos >= text.length || !IDENT_CHAR.test(text[pos])) {
    if (pos > 0 && IDENT_CHAR.test(text[pos - 1])) pos -= 1
    else return null
  }
  let start = pos
  while (start > 0 && IDENT_CHAR.test(text[start - 1])) start--
  let end = pos
  while (end < text.length && IDENT_CHAR.test(text[end])) end++
  const token = text.slice(start, end)
  if (!IDENT_START.test(token[0])) return null // e.g. starts with a digit
  return token
}

/** Whether any element from `el` up to (excluding) `boundary` carries an excluded token class. */
function hasExcludedClass(el: Element, boundary: Element): boolean {
  let cur: Element | null = el
  while (cur && cur !== boundary) {
    for (const cls of EXCLUDED_TOKEN_CLASSES) {
      if (cur.classList.contains(cls)) return true
    }
    cur = cur.parentElement
  }
  return false
}

/** Caret text position under viewport coords, via whichever API exists. */
function caretTextAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos) return { node: pos.offsetNode, offset: pos.offset }
    return null
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y)
    if (range) return { node: range.startContainer, offset: range.startOffset }
    return null
  }
  return null
}

/**
 * Resolve the identifier under a click in the diff, or null when the click
 * isn't a symbol click (whitespace, punctuation, keyword/string/comment
 * tokens, line numbers, widgets, annotation content, …).
 */
export function resolveClickedToken(target: EventTarget | null, x: number, y: number): string | null {
  if (!(target instanceof Element)) return null
  // Only real code text qualifies — the -raw spans hold the source line.
  const raw = target.closest('.diff-line-syntax-raw, .diff-line-content-raw')
  if (!raw) return null
  if (hasExcludedClass(target, raw)) return null

  // Preferred: exact caret position under the pointer.
  const caret = caretTextAt(x, y)
  if (caret && raw.contains(caret.node)) {
    // Reject when the caret landed inside an excluded token (the click target
    // can be the outer -raw span while the caret text node sits in a child).
    const caretEl = caret.node instanceof Element ? caret.node : caret.node.parentElement
    if (caretEl && caretEl !== raw && hasExcludedClass(caretEl, raw)) return null
    const text = caret.node.textContent ?? ''
    return identifierAt(text, caret.offset)
  }

  // Fallback (no caret API): only unambiguous single-identifier spans.
  const text = (target.textContent ?? '').trim()
  return IDENT_EXACT.test(text) ? text : null
}
