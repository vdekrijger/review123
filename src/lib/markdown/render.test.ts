import { describe, it, expect } from 'vitest'
import { renderMarkdown, replaceEmojiShortcodes } from './render'

describe('renderMarkdown', () => {
  it('strips <script> tags (XSS: script injection)', () => {
    const out = renderMarkdown('<script>alert(1)<\/script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })

  it('strips onerror from <img> (XSS: event handler)', () => {
    const out = renderMarkdown('<img src="x" onerror="alert(1)">')
    // img may be preserved but onerror must be gone
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert')
  })

  it('strips style attribute (EC-08c: style-based exfiltration)', () => {
    const out = renderMarkdown('<p style="background:url(x)">text</p>')
    expect(out).not.toContain('style=')
  })

  it('renders fenced code block as <pre><code> (EC-08c)', () => {
    const out = renderMarkdown('```\nconsole.log("hi")\n```')
    expect(out).toContain('<pre>')
    expect(out).toContain('<code>')
  })

  it('renders fenced code block with language tag', () => {
    const out = renderMarkdown('```js\nconst x = 1\n```')
    expect(out).toContain('<pre>')
    expect(out).toContain('<code')
  })

  it('neutralizes javascript: href (EC-08c: javascript: URL)', () => {
    const out = renderMarkdown('[x](javascript:alert(1))')
    // href must be absent or empty — not javascript:
    expect(out).not.toContain('javascript:')
    // The link text should still be present
    expect(out).toContain('>x<')
  })

  it('adds rel="noopener nofollow" to normal links', () => {
    const out = renderMarkdown('[link](https://example.com)')
    expect(out).toContain('rel="noopener nofollow"')
    expect(out).toContain('href="https://example.com"')
  })

  it('adds target="_blank" to normal links', () => {
    const out = renderMarkdown('[link](https://example.com)')
    expect(out).toContain('target="_blank"')
  })

  it('renders **bold** (GFM)', () => {
    const out = renderMarkdown('**bold**')
    expect(out).toContain('<strong>bold</strong>')
  })

  it('renders _italic_ (GFM)', () => {
    const out = renderMarkdown('_italic_')
    expect(out).toContain('<em>italic</em>')
  })

  it('renders unordered list (GFM)', () => {
    const out = renderMarkdown('- item 1\n- item 2')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>')
    expect(out).toContain('item 1')
    expect(out).toContain('item 2')
  })

  it('renders GFM table (EC-08c)', () => {
    const out = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('<table')
    expect(out).toContain('<td')
  })

  it('renders line breaks with breaks:true option', () => {
    const out = renderMarkdown('line1\nline2')
    // With breaks:true, single newlines become <br>
    expect(out).toContain('<br')
  })

  it('returns a string', () => {
    expect(typeof renderMarkdown('hello')).toBe('string')
  })

  it('handles empty string', () => {
    const out = renderMarkdown('')
    expect(typeof out).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// replaceEmojiShortcodes — GitHub-style :emoji: preview parity
// ---------------------------------------------------------------------------

describe('replaceEmojiShortcodes', () => {
  it(':tada: → 🎉', () => {
    expect(replaceEmojiShortcodes(':tada:')).toBe('🎉')
  })

  it(':smile: → 😄', () => {
    expect(replaceEmojiShortcodes(':smile:')).toBe('😄')
  })

  it(':+1: → 👍', () => {
    expect(replaceEmojiShortcodes(':+1:')).toBe('👍')
  })

  it(':-1: → 👎', () => {
    expect(replaceEmojiShortcodes(':-1:')).toBe('👎')
  })

  it(':rocket: → 🚀', () => {
    expect(replaceEmojiShortcodes(':rocket:')).toBe('🚀')
  })

  it(':heart: → ❤️', () => {
    expect(replaceEmojiShortcodes(':heart:')).toBe('❤️')
  })

  it(':eyes: → 👀', () => {
    expect(replaceEmojiShortcodes(':eyes:')).toBe('👀')
  })

  it(':thinking: → 🤔', () => {
    expect(replaceEmojiShortcodes(':thinking:')).toBe('🤔')
  })

  it(':fire: → 🔥', () => {
    expect(replaceEmojiShortcodes(':fire:')).toBe('🔥')
  })

  it(':check: → ✅', () => {
    expect(replaceEmojiShortcodes(':check:')).toBe('✅')
  })

  it('unknown shortcode :zzzz: left as literal text', () => {
    expect(replaceEmojiShortcodes(':zzzz:')).toBe(':zzzz:')
  })

  it('mixed known and unknown shortcodes', () => {
    const result = replaceEmojiShortcodes(':tada: great work :zzzz:!')
    expect(result).toBe('🎉 great work :zzzz:!')
  })

  it('empty string returns empty string', () => {
    expect(replaceEmojiShortcodes('')).toBe('')
  })

  it('no shortcodes left unchanged', () => {
    const text = 'No emojis here'
    expect(replaceEmojiShortcodes(text)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// renderMarkdown + emoji: ensure shortcodes survive through the pipeline
// ---------------------------------------------------------------------------

describe('renderMarkdown emoji integration', () => {
  it(':tada: expands to 🎉 in rendered output', () => {
    const out = renderMarkdown('Congrats :tada:')
    expect(out).toContain('🎉')
    expect(out).not.toContain(':tada:')
  })

  it('unknown :zzzz: shortcode left as text in rendered output', () => {
    const out = renderMarkdown('Test :zzzz: here')
    expect(out).toContain(':zzzz:')
  })
})
