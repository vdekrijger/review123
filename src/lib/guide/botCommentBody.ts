/**
 * src/lib/guide/botCommentBody.ts — making a revealed bot comment worth its
 * height.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM, MEASURED
 *
 * Hiding bot comments is the default, not the only state — the user will reveal
 * them, and one of them was already too tall on its own. In the screenshot that
 * prompted this work each `posthog[bot]` comment cost roughly 200px TO SHOW
 * NOTHING: its entire body was four collapsed `<details>` — "Issue
 * description", "Why we think it's a valid issue", "Suggested fix", "Prompt to
 * fix with AI (copy-paste)". Four disclosure rows conveying a title.
 *
 * Two things are done about it here, and both are deliberately the smallest
 * ones that work, because THIS IS SOMEBODY ELSE'S MARKDOWN. It is also
 * untrusted third-party text (see src/lib/bridge/botComments.ts): nothing below
 * interprets it, executes it, or trusts a claim inside it. These functions
 * rewrite the SOURCE STRING that is then handed to the existing
 * renderMarkdown → marked → DOMPurify boundary exactly as before, so the
 * sanitisation contract is untouched and no new `{@html}` is introduced.
 *
 *   1. A body that is ENTIRELY disclosures gets its first one opened, so the
 *      reader lands on content instead of a stack of shut doors. Non-destructive
 *      and reversible by the reader with one click: the `<details>` is still a
 *      `<details>`, it just starts open. The rest stay shut, so a four-section
 *      comment costs one section plus three rows instead of four rows and no
 *      content. A body with prose OUTSIDE the disclosures already shows
 *      something, so it is left alone.
 *
 *   2. "Prompt to fix with AI (copy-paste)" is REDUNDANT IN THIS APP. It exists
 *      to be pasted into a coding agent, and #285 already sends the whole
 *      comment to exactly such an agent, quoted and fenced, from the fixing
 *      panel. So that one section is dropped — and the thread says so, because
 *      nothing in this codebase is hidden silently.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE MATCHING IS AS NARROW AS IT IS
 *
 * A heading-text rule applied to arbitrary markdown is exactly the kind of thing
 * that quietly eats content it should not. So the AI-prompt rule fires only when
 * ALL of these hold:
 *
 *   - the comment was written by a review bot (the caller checks this);
 *   - the `<details>` is TOP-LEVEL in the body, never one nested inside another
 *     author's section;
 *   - its `<summary>`, reduced to plain lowercase words, STARTS WITH the exact
 *     five-word phrase "prompt to fix with ai". Not "contains"; not a fuzzy
 *     match on "prompt" or "AI". Five words naming one specific artefact.
 *   - removing it leaves something behind. A body that was ONLY that section is
 *     returned untouched, because deleting a comment is not filtering it.
 *
 * Code is masked before ANY of this looks at the text (see maskCode), so a bot
 * quoting `<details>` inside a fence — or writing about `<summary>` in a code
 * span — is never mistaken for markup this module may rewrite. Masking uses a
 * non-whitespace filler of identical length, which keeps every offset valid AND
 * keeps a fenced block counting as CONTENT for the all-disclosures test: a body
 * of one code fence plus one `<details>` is not "entirely disclosures".
 *
 * If the `<details>`/`</details>` tags do not balance, every function here
 * returns its input unchanged. Malformed markup is the case where a clever
 * rewrite does the most damage and the least good.
 */

// ---------------------------------------------------------------------------
// Masking code, so markup inside a fence is never treated as markup
// ---------------------------------------------------------------------------

/** Filler for masked code. NOT whitespace — masked code is still content. */
const FILL = ''

/**
 * Replace the CONTENT of fenced blocks and inline code spans with same-length
 * filler. Offsets into the result are valid offsets into the original.
 */
export function maskCode(src: string): string {
  // Pass 1: fenced blocks, line by line (``` and ~~~, any length >= 3).
  const lines = src.split('\n')
  let fence: string | null = null
  const masked = lines.map((line) => {
    const m = /^[ \t]*(`{3,}|~{3,})/.exec(line)
    if (fence === null) {
      if (m) {
        fence = m[1][0].repeat(3)
        return line // the opening fence line itself is not code
      }
      return line
    }
    // Inside a fence: a closing marker of the same kind ends it.
    if (m && m[1][0] === fence[0]) {
      fence = null
      return line
    }
    return FILL.repeat(line.length)
  })
  let out = masked.join('\n')

  // Pass 2: inline code spans on the lines that are still live.
  out = out.replace(/(`+)([^`\n]*?)\1/g, (whole, ticks: string, inner: string) =>
    ticks + FILL.repeat(inner.length) + ticks,
  )
  return out
}

// ---------------------------------------------------------------------------
// Finding the top-level <details> elements
// ---------------------------------------------------------------------------

export interface DisclosureSpan {
  /** Index of the `<` of the opening tag. */
  start: number
  /** Index just past the `>` of the matching `</details>`. */
  end: number
  /** Index just past the `>` of the opening tag. */
  bodyStart: number
  /** Whether the opening tag already carries `open`. */
  alreadyOpen: boolean
  /** The `<summary>` text, reduced to plain lowercase words. '' when absent. */
  summary: string
}

const DETAILS_OPEN = /<details(\s[^>]*)?>/gi
const DETAILS_CLOSE = /<\/details\s*>/gi

/**
 * Top-level `<details>` spans, outermost only, in document order.
 * Returns null when the tags do not balance — the caller then does nothing.
 */
export function topLevelDisclosures(src: string): DisclosureSpan[] | null {
  // Early out for the overwhelmingly common case — a comment of plain prose.
  // Every function below funnels through here, so one cheap test keeps an
  // ordinary thread from paying for any of the scanning at all.
  //
  // The test matches a CLOSING tag too, so a body carrying only a stray
  // `</details>` still falls through to the real scan and is reported as
  // unbalanced (null) rather than as "nothing here".
  if (!/<\/?details[\s>]/i.test(src)) return []
  const scan = maskCode(src)
  type Tok = { at: number; end: number; open: boolean; attrs: string }
  const toks: Tok[] = []
  DETAILS_OPEN.lastIndex = 0
  for (let m = DETAILS_OPEN.exec(scan); m; m = DETAILS_OPEN.exec(scan)) {
    toks.push({ at: m.index, end: m.index + m[0].length, open: true, attrs: m[1] ?? '' })
  }
  DETAILS_CLOSE.lastIndex = 0
  for (let m = DETAILS_CLOSE.exec(scan); m; m = DETAILS_CLOSE.exec(scan)) {
    toks.push({ at: m.index, end: m.index + m[0].length, open: false, attrs: '' })
  }
  toks.sort((a, b) => a.at - b.at)

  const spans: DisclosureSpan[] = []
  let depth = 0
  let current: Tok | null = null
  for (const t of toks) {
    if (t.open) {
      if (depth === 0) current = t
      depth++
      continue
    }
    if (depth === 0) return null // stray </details>
    depth--
    if (depth === 0 && current) {
      spans.push({
        start: current.at,
        end: t.end,
        bodyStart: current.end,
        alreadyOpen: /(^|\s)open(\s|=|$)/i.test(current.attrs),
        summary: summaryTextIn(scan, src, current.end, t.at),
      })
      current = null
    }
  }
  if (depth !== 0) return null // unclosed <details>
  return spans
}

/**
 * The `<summary>` belonging to THIS disclosure, as plain lowercase words.
 *
 * Only a summary that appears before any nested `<details>` counts, so a
 * section is never named by a sub-section's label.
 */
function summaryTextIn(scan: string, src: string, from: number, to: number): string {
  const region = scan.slice(from, to)
  const nested = region.search(/<details(\s|>)/i)
  const limit = nested === -1 ? region.length : nested
  const m = /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i.exec(region.slice(0, limit))
  if (!m) return ''
  // Read the REAL text at the matched offsets: `scan` has code filled out.
  const innerStart = from + m.index + m[0].indexOf('>') + 1
  return plainWords(src.slice(innerStart, innerStart + m[1].length))
}

/** Markup/markdown → lowercase words, for heading comparison only. */
export function plainWords(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toLowerCase()
}

// ---------------------------------------------------------------------------
// 1. A body that is entirely disclosures
// ---------------------------------------------------------------------------

/**
 * Is every non-whitespace character of this body inside a top-level
 * `<details>`? (Masked code counts as content, so a fence says no.)
 */
export function isAllDisclosures(src: string): boolean {
  const spans = topLevelDisclosures(src)
  if (spans === null || spans.length === 0) return false
  const scan = maskCode(src)
  let cursor = 0
  for (const s of spans) {
    if (scan.slice(cursor, s.start).trim() !== '') return false
    cursor = s.end
  }
  return scan.slice(cursor).trim() === ''
}

/**
 * Open the first top-level `<details>` when the body is nothing but
 * disclosures. Otherwise the body is returned byte-for-byte.
 */
export function openFirstDisclosure(src: string): string {
  if (!isAllDisclosures(src)) return src
  const spans = topLevelDisclosures(src)
  if (spans === null || spans.length === 0) return src
  const first = spans[0]
  if (first.alreadyOpen) return src
  const tag = src.slice(first.start, first.bodyStart)
  // `<details>` → `<details open>`; `<details class="x">` → `<details open class="x">`
  const opened = tag.replace(/^<details/i, '<details open')
  return src.slice(0, first.start) + opened + src.slice(first.bodyStart)
}

// ---------------------------------------------------------------------------
// 2. The copy-paste AI prompt section
// ---------------------------------------------------------------------------

/**
 * The ONE heading this module will drop, as an exact opening phrase.
 *
 * Five words naming one specific artefact. Anchored at the start so a section
 * that merely mentions prompting an AI somewhere in its title is not matched,
 * and the trailing "(copy-paste)" is left free because bots vary it.
 */
const AI_PROMPT_SUMMARY = /^prompt to fix with ai\b/

export interface StrippedBody {
  body: string
  /** True when a copy-paste AI-prompt section was dropped. */
  stripped: boolean
}

/**
 * Drop a top-level "Prompt to fix with AI (copy-paste)" disclosure.
 *
 * The caller applies this to REVIEW-BOT comments only. Returns `stripped:
 * false` and the untouched body when nothing matched, when the markup does not
 * balance, or when dropping it would leave the comment empty.
 */
export function stripAiPromptDisclosure(src: string): StrippedBody {
  const spans = topLevelDisclosures(src)
  if (spans === null) return { body: src, stripped: false }
  const hit = spans.find((s) => AI_PROMPT_SUMMARY.test(s.summary))
  if (!hit) return { body: src, stripped: false }
  const next = src.slice(0, hit.start) + src.slice(hit.end)
  // Never turn a comment into nothing: that is deletion, not filtering.
  if (next.trim() === '') return { body: src, stripped: false }
  return { body: next.replace(/\n{3,}/g, '\n\n'), stripped: true }
}

/**
 * The whole treatment for one comment body, in order.
 *
 * `isBot` gates the AI-prompt rule only. Opening the first disclosure applies
 * to anyone's comment: it removes nothing, and a human whose body is four shut
 * `<details>` has the identical problem.
 */
export function presentCommentBody(src: string, isBot: boolean): StrippedBody {
  const step = isBot ? stripAiPromptDisclosure(src) : { body: src, stripped: false }
  return { body: openFirstDisclosure(step.body), stripped: step.stripped }
}
