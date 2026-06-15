import { describe, it, expect } from 'vitest'
import { snippetLangForFilename, highlightSnippet } from './highlightSnippet'

describe('snippetLangForFilename', () => {
  it.each([
    ['snap.json', 'json'],
    ['src/keys.ts', 'typescript'],
    ['src/keys.tsx', 'typescript'],
    ['app.js', 'javascript'],
    ['mod.py', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['Foo.java', 'java'],
    ['Bar.kt', 'kotlin'],
    ['svc.rb', 'ruby'],
    ['styles.css', 'css'],
    ['q.sql', 'sql'],
    ['conf.yaml', 'yaml'],
    ['conf.yml', 'yaml'],
    ['index.html', 'xml'],
    ['run.sh', 'bash'],
  ])('maps %s → %s', (filename, lang) => {
    expect(snippetLangForFilename(filename)).toBe(lang)
  })

  it('returns null for unknown / extensionless paths', () => {
    expect(snippetLangForFilename('Dockerfile')).toBeNull()
    expect(snippetLangForFilename('weird.xyz')).toBeNull()
  })
})

describe('highlightSnippet', () => {
  it('wraps a JSON key in an hljs token span', async () => {
    const html = await highlightSnippet('{"name": "x"}', 'json')
    expect(html).toContain('hljs-attr')
    expect(html).toContain('name')
  })

  it('wraps a TypeScript keyword in an hljs token span', async () => {
    const html = await highlightSnippet('const x = 1', 'typescript')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('const')
  })

  it('HTML-escapes the source even when highlighting (no raw < >)', async () => {
    const html = await highlightSnippet('const a = b < c && d > e', 'typescript')
    expect(html).not.toContain('< c')
    expect(html).toContain('&lt;')
  })

  it('falls back to escaped plain text for an unknown language', async () => {
    const html = await highlightSnippet('<tag>', null)
    expect(html).toBe('&lt;tag&gt;')
    expect(html).not.toContain('hljs-')
  })
})
