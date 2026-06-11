/**
 * MarkdownView component tests.
 *
 * Mermaid is mocked; renderMarkdown output is real (uses marked+DOMPurify).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/svelte'
import MarkdownView from './MarkdownView.svelte'

// ---------------------------------------------------------------------------
// Mock mermaid via the shared mermaidInit helper
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn()
const mockRender = vi.fn().mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"/>' })

vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"/>' })
})

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

describe('MarkdownView — markdown rendering', () => {
  it('renders ## heading as h2 element', () => {
    const { container } = render(MarkdownView, { props: { source: '## Hello World' } })
    expect(container.querySelector('h2')).not.toBeNull()
    expect(container.querySelector('h2')?.textContent).toContain('Hello World')
  })

  it('renders **bold** as strong', () => {
    const { container } = render(MarkdownView, { props: { source: '**bold text**' } })
    expect(container.querySelector('strong')).not.toBeNull()
  })

  it('strips <script> tags (XSS)', () => {
    const { container } = render(MarkdownView, { props: { source: 'Text <script>alert(1)<\/script>' } })
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('alert(1)')
  })

  it('renders plain text without errors', () => {
    const { container } = render(MarkdownView, { props: { source: 'just some text' } })
    expect(container.textContent).toContain('just some text')
  })

  it('handles empty source without error', () => {
    expect(() => render(MarkdownView, { props: { source: '' } })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Mermaid fence replacement
// ---------------------------------------------------------------------------

describe('MarkdownView — mermaid fence replacement', () => {
  it('replaces pre>code.language-mermaid with SVG container when mermaid.render resolves', async () => {
    const source = '```mermaid\nflowchart TD\n  A --> B\n```'
    const { container } = render(MarkdownView, { props: { source } })

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled()
    })

    // The SVG container should be in the DOM
    await waitFor(() => {
      expect(container.querySelector('[data-mermaid-container]')).not.toBeNull()
    })
  })

  it('calls mermaid.render with the fence content', async () => {
    const fenceContent = 'flowchart TD\n  A --> B'
    const source = `\`\`\`mermaid\n${fenceContent}\n\`\`\``
    render(MarkdownView, { props: { source } })

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled()
    })

    // The second arg to mermaid.render should contain the fence content
    const callArg = mockRender.mock.calls[0][1] as string
    expect(callArg).toContain('flowchart TD')
  })

  it('leaves code block as-is when mermaid.render rejects', async () => {
    mockRender.mockRejectedValueOnce(new Error('parse error'))
    const source = '```mermaid\ninvalid\n```'
    const { container } = render(MarkdownView, { props: { source } })

    // Give async effect time to run
    await new Promise((r) => setTimeout(r, 100))

    // code block should still be in the DOM
    const codeEl = container.querySelector('code.language-mermaid')
    expect(codeEl).not.toBeNull()
    // No mermaid container added
    expect(container.querySelector('[data-mermaid-container]')).toBeNull()
  })

  it('does NOT call mermaid.render for non-mermaid fenced code blocks', async () => {
    const source = '```js\nconsole.log("hi")\n```'
    render(MarkdownView, { props: { source } })

    // Give async time to run
    await new Promise((r) => setTimeout(r, 100))
    expect(mockRender).not.toHaveBeenCalled()
  })
})
