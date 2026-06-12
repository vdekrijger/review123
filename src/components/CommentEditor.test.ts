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

// ---------------------------------------------------------------------------
// Suggest Change button
// ---------------------------------------------------------------------------

describe('CommentEditor — Suggest Change button', () => {
  it('does NOT render "Suggest change" button when suggestionSource is absent', () => {
    render(CommentEditor, { props: { value: '', onchange: vi.fn() } })
    expect(screen.queryByRole('button', { name: /suggest change/i })).not.toBeInTheDocument()
  })

  it('renders "Suggest change" button when suggestionSource is provided', () => {
    render(CommentEditor, { props: { value: '', onchange: vi.fn(), suggestionSource: ['const x = 1'] } })
    expect(screen.getByRole('button', { name: /suggest change/i })).toBeInTheDocument()
  })

  it('clicking "Suggest change" inserts suggestion fence with original lines at cursor', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange, suggestionSource: ['const x = 1', 'const y = 2'] } })
    const textarea = getTextarea()
    textarea.setSelectionRange(0, 0)
    await userEvent.click(screen.getByRole('button', { name: /suggest change/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    const inserted = calls[calls.length - 1] as string
    expect(inserted).toContain('```suggestion')
    expect(inserted).toContain('const x = 1')
    expect(inserted).toContain('const y = 2')
    expect(inserted).toContain('```')
  })

  it('suggestion fence is inserted after existing text (at cursor)', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: 'existing text\n', onchange, suggestionSource: ['old line'] } })
    const textarea = getTextarea()
    // Place cursor at end
    const len = 'existing text\n'.length
    textarea.setSelectionRange(len, len)
    await userEvent.click(screen.getByRole('button', { name: /suggest change/i }))
    const calls = onchange.mock.calls.map((c) => c[0])
    const inserted = calls[calls.length - 1] as string
    expect(inserted).toContain('existing text\n')
    expect(inserted).toContain('```suggestion')
    expect(inserted).toContain('old line')
  })
})

describe('CommentEditor emoji support', () => {
  it('direct emoji character (😄) typed into textarea is preserved via onchange', async () => {
    const onchange = vi.fn()
    render(CommentEditor, { props: { value: '', onchange } })
    const textarea = getTextarea()
    // Fire input event directly (userEvent.type doesn't handle emoji chars well in jsdom)
    textarea.value = '😄'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    // onchange should have been called with the emoji
    const calls = onchange.mock.calls.map((c: string[]) => c[0])
    expect(calls.some((v: string) => v.includes('😄'))).toBe(true)
  })

  it(':tada: shortcode renders as 🎉 in the Preview tab', async () => {
    render(CommentEditor, { props: { value: ':tada:', onchange: vi.fn() } })
    await userEvent.click(screen.getByRole('tab', { name: /preview/i }))
    // The preview should contain the rendered emoji, not the raw shortcode
    const preview = document.querySelector('.preview')
    expect(preview?.textContent).toContain('🎉')
    expect(preview?.textContent).not.toContain(':tada:')
  })

  it(':zzzz: (unknown shortcode) left as literal text in Preview', async () => {
    render(CommentEditor, { props: { value: ':zzzz:', onchange: vi.fn() } })
    await userEvent.click(screen.getByRole('tab', { name: /preview/i }))
    const preview = document.querySelector('.preview')
    expect(preview?.textContent).toContain(':zzzz:')
  })
})
