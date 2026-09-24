/**
 * src/lib/bridge/quotedText.ts — quoting somebody's words into an agent prompt.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN MODULE
 *
 * Two kinds of text reach the fixing agent without this app having written
 * them: a review bot's comment (botComments.ts, #282) and the reviewer's own
 * drafted note (draftComments.ts). They are treated VERY differently — one is
 * hostile third-party data, the other is the user's own direction — and the
 * difference is expressed in the WRAPPER each module writes.
 *
 * What they share is the mechanical part, and it is the part that must not
 * drift: the table of code points that hide meaning from a human reader, the
 * repo-relative path check, and the unguessable fence nonce. A second copy of
 * the smuggled-character table is a second copy that gets updated once.
 *
 * So the mechanics live here, exactly once, and each caller writes its own
 * sentences on top. Nothing in this file decides whether text is trusted; that
 * judgment belongs to the module that knows who wrote it.
 */

// ---------------------------------------------------------------------------
// Where a quoted note may point
// ---------------------------------------------------------------------------

/** Does this string carry a control character? Numbers, never a literal class. */
function hasControlChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** A repo-relative path, at most this long. Anything longer is not a path. */
const MAX_PATH_CHARS = 400

/**
 * A `path`, if and only if it is a plain repo-relative path.
 *
 * Returns null for an absolute path, a Windows drive, a URL, a `..` segment,
 * anything inside `.git`, control characters, or an absurd length. The bridge
 * confines writes to its scratch worktree anyway (`confine.ts`), but a path
 * that escapes should never be OFFERED in the first place — a refusal the user
 * can see beats a refusal buried in a skip.
 */
export function safeRepoPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null
  const trimmed = path.trim()
  if (trimmed === '' || trimmed.length > MAX_PATH_CHARS) return null
  if (hasControlChar(trimmed)) return null
  if (trimmed.includes('://')) return null
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null
  const segments = trimmed.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) return null
  if (segments[0] === '.git') return null
  return trimmed
}

// ---------------------------------------------------------------------------
// Making the text readable as exactly what it says
// ---------------------------------------------------------------------------

/**
 * Code points that smuggle meaning past the person reading the text.
 *
 * WRITTEN AS NUMBERS, NEVER AS A CHARACTER CLASS WITH THE CHARACTERS IN IT.
 * A source file containing the invisible characters it exists to strip is a
 * source file nobody can review; src/source-bytes.test.ts refuses the worst of
 * them outright. Numbers are greppable, diffable and safe to paste.
 *
 *   control    - everything below U+0020 plus DEL. Newline and tab are kept:
 *                they are text in a review comment.
 *   invisible  - zero-width and BIDIRECTIONAL-OVERRIDE code points. A
 *                right-to-left override can make a quoted instruction render as
 *                something else entirely, and a zero-width joiner can split a
 *                word the eye reads as one. Neither belongs in a note about to
 *                be quoted to an agent — including a note the user wrote
 *                themselves, since text arrives in a draft by paste as often as
 *                by typing, and a note that reads one way on screen and another
 *                in the prompt is the bug this prevents either way.
 */
function isSmuggledCode(code: number): boolean {
  if (code === 0x0a || code === 0x09) return false
  if (code < 0x20 || code === 0x7f) return true
  if (code >= 0x200b && code <= 0x200f) return true // ZWSP .. RLM
  if (code >= 0x202a && code <= 0x202e) return true // LRE .. RLO
  if (code >= 0x2060 && code <= 0x2064) return true // word joiner .. invisible plus
  if (code >= 0x2066 && code <= 0x2069) return true // LRI .. PDI
  return code === 0xfeff // BOM / zero-width no-break space
}

/** Drop every code point `isSmuggledCode` names, keeping everything else. */
function stripSmuggled(text: string): string {
  let out = ''
  for (const char of text) {
    if (!isSmuggledCode(char.codePointAt(0) ?? 0)) out += char
  }
  return out
}

/** What a caller must tell this module to quote one kind of text. */
export interface QuoteRules {
  /** The caller's own fence marker, defanged wherever it occurs in the text. */
  marker: RegExp
  /** How much of one note is quoted. Past this it is cut, visibly. */
  maxChars: number
  /** The visible truncation note, given the cap. The caller's own sentence. */
  cutNote: (maxChars: number) => string
}

/**
 * Strip everything that could smuggle meaning past a reader, and cap the rest.
 *
 * Never rewrites the claim itself: the point is that the user and the agent
 * read the SAME words, minus the ones that are not words.
 */
export function sanitizeQuoted(text: string, rules: QuoteRules): string {
  const cleaned = stripSmuggled(String(text ?? '').replace(/\r\n?/g, '\n'))
    .replace(rules.marker, '[quoted fence marker]')
    .trim()
  if (cleaned.length <= rules.maxChars) return cleaned
  return `${cleaned.slice(0, rules.maxChars)}\n${rules.cutNote(rules.maxChars)}`
}

/**
 * A random fence nonce.
 *
 * THE NONCE IS THE POINT. A fixed delimiter can be typed by the text it is
 * supposed to contain; an unpredictable one cannot, so a note containing a
 * forged closing marker just contains a forged closing marker. `crypto` is
 * present in every browser this app supports and in jsdom; the fallback exists
 * so a missing one degrades to a weaker fence rather than to no fence.
 */
export function fenceNonce(): string {
  try {
    const bytes = new Uint8Array(8)
    crypto.getRandomValues(bytes)
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`
  }
}
