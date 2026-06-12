/**
 * renderMarkdown — the ONE place in this codebase that uses marked + DOMPurify.
 *
 * Security contract:
 * - marked converts Markdown → HTML (GFM, line breaks enabled)
 * - DOMPurify sanitizes the HTML before it leaves this function
 * - No caller should ever pass the return value through another layer of
 *   sanitization, nor should any caller use {@html} without calling this first.
 *
 * {@html} usage is ONLY acceptable with the output of this function.
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// ---------------------------------------------------------------------------
// GitHub-style emoji shortcode map (preview parity — GitHub renders these
// server-side; the preview should match for the ~20 most common ones).
// ---------------------------------------------------------------------------

const EMOJI_MAP: Record<string, string> = {
  smile: '😄',
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  tada: '🎉',
  rocket: '🚀',
  heart: '❤️',
  eyes: '👀',
  thinking: '🤔',
  fire: '🔥',
  white_check_mark: '✅',
  check: '✅',
  x: '❌',
  warning: '⚠️',
  bug: '🐛',
  sparkles: '✨',
  zap: '⚡',
  100: '💯',
  pray: '🙏',
  clap: '👏',
  wave: '👋',
  point_up: '☝️',
  laughing: '😆',
  sob: '😭',
}

/**
 * Replace GitHub-style :emoji: shortcodes with their Unicode equivalents.
 * Unknown shortcodes are left as-is (e.g. `:zzzz:` stays `:zzzz:`).
 */
export function replaceEmojiShortcodes(src: string): string {
  return src.replace(/:([a-z0-9_+\-]+):/g, (match, name) => EMOJI_MAP[name] ?? match)
}

/**
 * DOMPurify is a factory in non-browser environments (jsdom, node with jsdom).
 * In a real browser, the default export is already an initialized instance.
 * We detect by checking `isSupported` — false means we need to call it as a factory.
 */
function createPurify(): typeof DOMPurify {
  if (typeof DOMPurify === 'function' && !(DOMPurify as { isSupported?: boolean }).isSupported) {
    // Non-browser / jsdom test environment: call the factory with the global window
    return (DOMPurify as unknown as (win: Window) => typeof DOMPurify)(
      globalThis.window ?? globalThis as unknown as Window,
    )
  }
  return DOMPurify
}

const purify = createPurify()

// Belt-and-braces link security: hook runs after DOMPurify has already stripped
// javascript: hrefs in most cases, but this ensures:
//   1. All <a> links get rel="noopener nofollow" (privacy + security)
//   2. All <a> links open in a new tab (target="_blank")
//   3. Any href that is not http(s) is removed (catches edge cases)
purify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener nofollow')
    node.setAttribute('target', '_blank')
    const href = node.getAttribute('href') ?? ''
    if (href && !/^https?:\/\//i.test(href)) {
      node.removeAttribute('href')
    }
  }
})

const PURIFY_CONFIG: Parameters<typeof purify.sanitize>[1] = {
  // Explicitly forbid style (CSS exfiltration) and common event handler attributes.
  // DOMPurify strips event handlers by default, but being explicit is belt-and-braces.
  FORBID_ATTR: [
    'style',
    'onerror',
    'onclick',
    'onmouseover',
    'onmouseout',
    'onload',
    'onfocus',
    'onblur',
    'onkeydown',
    'onkeyup',
    'onkeypress',
    'onsubmit',
    'onchange',
    'oninput',
  ],
}

// ---------------------------------------------------------------------------
// Suggestion fence renderer
// ---------------------------------------------------------------------------

/**
 * Pre-process src to replace ```suggestion ... ``` fences with a custom
 * HTML block BEFORE marked parses it. We output a safe <div> structure that
 * DOMPurify will preserve (we add 'suggestion-block' to the allowed classes via
 * ADD_ATTR is not needed — DOMPurify keeps class by default on divs).
 *
 * The replacement happens at the raw-string level so the inner content is
 * treated as plain text (HTML-escaped), preventing XSS from the suggestion body.
 *
 * The output is intentionally simple so DOMPurify does not strip it.
 */
function processSuggestionFences(src: string): string {
  return src.replace(/```suggestion\r?\n([\s\S]*?)```/g, (_match, inner: string) => {
    // HTML-escape the inner code content to prevent injection
    const escaped = inner
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    return (
      `<div class="suggestion-block">` +
      `<div class="suggestion-header">Suggested change</div>` +
      `<pre class="suggestion-code"><code>${escaped}</code></pre>` +
      `</div>\n`
    )
  })
}

/**
 * Render Markdown to sanitized HTML.
 *
 * Also expands GitHub-style :emoji: shortcodes before passing through marked,
 * so the preview matches what GitHub renders server-side.
 *
 * Also renders ```suggestion fences as distinct styled blocks.
 *
 * @param src - Raw Markdown string (may contain user-supplied content).
 * @returns Safe HTML string. Safe to embed via {@html} — sanitization is done here.
 */
export function renderMarkdown(src: string): string {
  // Process suggestion fences before emoji expansion or marked parsing
  const withSuggestions = processSuggestionFences(src)
  // Expand :emoji: shortcodes before rendering so they appear in the HTML
  const withEmoji = replaceEmojiShortcodes(withSuggestions)
  // marked 18: parse() with async:false returns string synchronously
  const rawHtml = marked(withEmoji, { gfm: true, breaks: true, async: false }) as string
  return purify.sanitize(rawHtml, PURIFY_CONFIG)
}
