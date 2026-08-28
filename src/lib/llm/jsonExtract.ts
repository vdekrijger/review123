/**
 * jsonExtract — tolerant extraction of a JSON document from a model reply.
 *
 * Models asked for JSON routinely return VALID JSON wrapped in something else:
 * a ```json fence, a "Here is the analysis:" preamble, a trailing "Hope that
 * helps.", a stray closing fence, or a trailing comma before a closing brace.
 * Calling JSON.parse on the raw string throws on every one of those, which is
 * how a perfectly usable answer became "LLM produced invalid JSON after repair
 * retry" for the user.
 *
 * This module is PURE and transport-agnostic: text in, a parseable JSON string
 * (or null) out. It never "fixes" a document's meaning — every candidate it
 * returns is one that JSON.parse actually accepts, so a caller can parse the
 * result without a second try/catch. Genuinely unparseable text (including a
 * TRUNCATED reply, whose braces never balance) returns null, which is what
 * keeps a real failure a real failure.
 *
 * Strategy order (first candidate that parses wins):
 *   1. the raw text (fast path — byte-identical behaviour for a clean reply)
 *   2. the contents of each ``` / ```json fenced block, in document order
 *   3. every balanced top-level {...} / [...] span, LONGEST first
 * Each candidate is retried once with trailing commas removed.
 *
 * Brace matching is a real scanner that respects string literals and escapes —
 * NOT a regex — so a `}` or a ``` inside a string value can never end a span
 * early.
 */

/** Hard cap on the input we scan. Beyond this a reply is not a JSON document. */
const MAX_SCAN_CHARS = 2_000_000

/** Does JSON.parse accept this exactly? */
function parses(candidate: string): boolean {
  try {
    JSON.parse(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Remove commas that directly precede a `}` or `]` (JSON5/JS habit; invalid
 * JSON). String-aware: a comma inside a string literal is never touched.
 */
export function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === ',') {
      // Look ahead past whitespace: a closing bracket means this comma is trailing.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue // drop it
    }

    out += ch
  }

  return out
}

/**
 * The contents of every fenced code block, in document order. Handles ```json,
 * ```JSON, bare ```, and a fence whose info string carries extra words. An
 * UNTERMINATED fence yields the remainder of the text (a truncated reply's
 * fence never closes — the balanced-span pass then decides whether it is
 * salvageable).
 */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = []
  // Opening fence: three-or-more backticks at a line start, optional info string.
  const opener = /^[ \t]*(`{3,})[ \t]*([^\n`]*)\n/gm
  let match: RegExpExecArray | null

  while ((match = opener.exec(text)) !== null) {
    const ticks = match[1]
    const bodyStart = match.index + match[0].length
    // Closing fence: the same run length (or longer) alone on its own line.
    const closer = new RegExp(`^[ \\t]*\`{${ticks.length},}[ \\t]*$`, 'm')
    closer.lastIndex = 0
    const rest = text.slice(bodyStart)
    const closeMatch = closer.exec(rest)
    if (closeMatch) {
      blocks.push(rest.slice(0, closeMatch.index))
      // Continue scanning AFTER this block so a nested/second fence is found too.
      opener.lastIndex = bodyStart + closeMatch.index + closeMatch[0].length
    } else {
      blocks.push(rest)
      break
    }
  }

  return blocks
}

/**
 * Every balanced top-level `{...}` / `[...]` span in the text, string- and
 * escape-aware. Scanning resumes AFTER a completed span, so an object embedded
 * in prose that also mentions `{}` yields both spans and the caller can pick.
 *
 * Scanning STOPS at the first opener that never closes, keeping only the spans
 * completed before it. That is the deliberate safety rule: an unclosed opener
 * is the signature of a TRUNCATED reply, and inside a truncated document the
 * inner objects are still individually balanced — descending into them would
 * hand the caller a fragment ("the first item of a cut-off list") dressed up as
 * the whole answer, and misreport the truncation as a schema mismatch. Losing
 * the rare "stray `{` in the preamble" salvage is worth never doing that.
 */
function balancedSpans(text: string): string[] {
  const spans: string[] = []
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (ch !== '{' && ch !== '[') {
      i++
      continue
    }

    const stack: string[] = []
    let inString = false
    let escaped = false
    let j = i
    let closed = false

    for (; j < text.length; j++) {
      const c = text[j]

      if (inString) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') inString = false
        continue
      }

      if (c === '"') {
        inString = true
      } else if (c === '{' || c === '[') {
        stack.push(c)
      } else if (c === '}' || c === ']') {
        const open = stack.pop()
        if (open === undefined) break // stray closer — abandon this start
        if ((c === '}') !== (open === '{')) break // mismatched pair — abandon
        if (stack.length === 0) {
          closed = true
          break
        }
      }
    }

    if (!closed) break // unclosed opener → everything past here is incomplete
    spans.push(text.slice(i, j + 1))
    i = j + 1
  }

  return spans
}

/**
 * Find a parseable JSON document inside a model reply.
 *
 * Returns a string that JSON.parse is GUARANTEED to accept, or null when the
 * text contains no complete JSON document (unbalanced / truncated / pure
 * prose). Never throws.
 */
export function extractJsonCandidate(text: string): string | null {
  if (typeof text !== 'string') return null
  const scoped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const trimmed = scoped.trim()
  if (trimmed === '') return null

  const candidates: string[] = [trimmed]

  for (const block of fencedBlocks(scoped)) {
    const t = block.trim()
    if (t !== '') candidates.push(t)
  }

  // Longest first: a decoy `{}` mentioned in the prose must never beat the
  // real payload that follows it.
  const spans = balancedSpans(scoped).sort((a, b) => b.length - a.length)
  candidates.push(...spans)

  for (const candidate of candidates) {
    if (parses(candidate)) return candidate
    const relaxed = stripTrailingCommas(candidate)
    if (relaxed !== candidate && parses(relaxed)) return relaxed
  }

  return null
}

/**
 * extractJsonCandidate + JSON.parse in one step, for the transport's repair
 * loop. Returns { ok: false } rather than throwing so the caller can classify
 * the failure (parse vs schema) itself.
 */
export function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false } {
  const candidate = extractJsonCandidate(text)
  if (candidate === null) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown }
  } catch {
    // Unreachable: extractJsonCandidate only returns strings it has parsed.
    return { ok: false }
  }
}
