import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import CommentEditor from './CommentEditor.svelte'

// Helper: get the textarea
function getTextarea() {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('CommentEditor', () => {
  it('renders Write and Preview tabs', () => {
    render(CommentEditor, { props: { value: '', onchange: vi.fn() } })
    expect(screen.getByRole('tab', { name: /write/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /preview/i })).toBeInTheDocument()
  })

  it('shows textarea in Write mode (default)', () => {
    render(CommentEditor, { props: { value: '', onchange: vi.fn() } })
    expect(getTextarea()).toBeInTheDocument()
  })

  it('typing calls onchange with new value', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange } })
    const textarea = getTextarea()
    await userEvent.type(textarea, 'hello')
    expect(onchange).toHaveBeenCalled()
    // Last call should contain the full typed string
    const lastArg = onchange.mock.calls[onchange.mock.calls.length - 1][0]
    expect(lastArg).toContain('hello')
  })

  it('Bold button with selected text wraps in **', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: 'sel', onchange } })
    const textarea = getTextarea()
    // Select all text
    textarea.setSelectionRange(0, 3)
    await userEvent.click(screen.getByRole('button', { name: /bold/i }))
    // onchange should have been called with **sel**
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v === '**sel**')).toBe(true)
  })

  it('Bold button with empty selection inserts **** with cursor in middle', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 0)
    await userEvent.click(screen.getByRole('button', { name: /bold/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v === '****')).toBe(true)
  })

  it('Italic button wraps selection in _', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: 'sel', onchange } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 3)
    await userEvent.click(screen.getByRole('button', { name: /italic/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v === '_sel_')).toBe(true)
  })

  it('Italic button with empty selection inserts __ ', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 0)
    await userEvent.click(screen.getByRole('button', { name: /italic/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v === '__')).toBe(true)
  })

  it('Code button wraps selection in backticks', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: 'sel', onchange } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 3)
    await userEvent.click(screen.getByRole('button', { name: /inline code/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v === '`sel`')).toBe(true)
  })

  it('Code block button with empty selection inserts fenced block', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 0)
    await userEvent.click(screen.getByRole('button', { name: /code block/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v.includes('```'))).toBe(true)
  })

  it('Link button inserts []() pattern', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 0)
    await userEvent.click(screen.getByRole('button', { name: /link/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v.includes(']('))).toBe(true)
  })

  it('List button inserts - prefix', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 0)
    await userEvent.click(screen.getByRole('button', { name: /list/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    expect(calls.some((v: string) => v.includes('- '))).toBe(true)
  })

  it('toolbar buttons have aria-labels', () => {
    render(CommentEditor, { props: { value: '', onchange: vi.fn() } })
    const boldBtn = screen.getByRole('button', { name: /bold/i })
    const italicBtn = screen.getByRole('button', { name: /italic/i })
    expect(boldBtn).toBeInTheDocument()
    expect(italicBtn).toBeInTheDocument()
  })

  it('switching to Preview shows sanitized HTML rendering', async () => {
    const md = '**bold** <script>alert(1)<\/script>'
    render(CommentEditor, { props: { value: md, onchange: vi.fn() } })
    await userEvent.click(screen.getByRole('tab', { name: /preview/i }))
    // script should not be in the DOM
    expect(document.querySelector('script')).toBeNull()
    // bold should render
    expect(document.querySelector('strong')).not.toBeNull()
  })

  it('Preview of a GFM list renders <ul>', async () => {
    const md = '- item 1\n- item 2'
    render(CommentEditor, { props: { value: md, onchange: vi.fn() } })
    await userEvent.click(screen.getByRole('tab', { name: /preview/i }))
    expect(document.querySelector('ul')).not.toBeNull()
  })

  it('Preview hides the textarea', async () => {
    render(CommentEditor, { props: { value: 'hello', onchange: vi.fn() } })
    await userEvent.click(screen.getByRole('tab', { name: /preview/i }))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('switching back to Write shows textarea again', async () => {
    render(CommentEditor, { props: { value: 'hello', onchange: vi.fn() } })
    await userEvent.click(screen.getByRole('tab', { name: /preview/i }))
    await userEvent.click(screen.getByRole('tab', { name: /write/i }))
    expect(getTextarea()).toBeInTheDocument()
  })

  it('Ctrl+Enter calls onsubmit when provided', async () => {
    const onsubmit = vi.fn()
    render(CommentEditor, { props: { value: '', onchange: vi.fn(), onsubmit } })
    const textarea = getTextarea()
    await userEvent.type(textarea, '{Control>}{Enter}{/Control}')
    expect(onsubmit).toHaveBeenCalledOnce()
  })

  it('does not throw when onsubmit is not provided and Ctrl+Enter pressed', async () => {
    render(CommentEditor, { props: { value: '', onchange: vi.fn() } })
    const textarea = getTextarea()
    // Should not throw
    await userEvent.type(textarea, '{Control>}{Enter}{/Control}')
  })
})
