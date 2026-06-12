import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    font: '',
    measureText: () => ({ width: 0 }),
  }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

// A file with a real change AND a whitespace-only change
const MIXED_BEFORE = 'a\nfoo bar\nkeep\nreal change\nend\n'
const MIXED_AFTER = 'a\nfoo  bar\nkeep\nreal CHANGE\nend\n'
const MIXED_PATCH = '@@ -1,5 +1,5 @@\n a\n-foo bar\n+foo  bar\n keep\n-real change\n+real CHANGE\n end'

// A file whose ENTIRE change is whitespace (indentation only)
const WS_ONLY_BEFORE = 'function f() {\nreturn 1\n}\n'
const WS_ONLY_AFTER = 'function f() {\n  return 1\n}\n'
const WS_ONLY_PATCH = '@@ -1,3 +1,3 @@\n function f() {\n-return 1\n+  return 1\n }'

const mixedFile: PrFile = {
  filename: 'src/mixed.ts', status: 'modified', additions: 2, deletions: 2, patch: MIXED_PATCH,
}
const wsOnlyFile: PrFile = {
  filename: 'src/ws-only.ts', status: 'modified', additions: 1, deletions: 1, patch: WS_ONLY_PATCH,
}
const noContentsFile: PrFile = {
  filename: 'src/huge.ts', status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -1 +1 @@\n-x\n+y',
}

function makeContentsMap() {
  return new Map<string, { before: string | null; after: string | null }>([
    ['src/mixed.ts', { before: MIXED_BEFORE, after: MIXED_AFTER }],
    ['src/ws-only.ts', { before: WS_ONLY_BEFORE, after: WS_ONLY_AFTER }],
    // src/huge.ts intentionally absent (beyond the fetch cap / failed)
  ])
}

const baseProps = {
  changedFiles: 3,
  mode: 'unified' as const,
  onmode: () => {},
  draftStore: null,
}

describe('InspectStep — Hide whitespace toggle', () => {
  it('renders the toggle with aria-pressed=false by default', () => {
    render(InspectStep, { props: { ...baseProps, files: [mixedFile] } })
    const btn = screen.getByRole('button', { name: 'Hide whitespace' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking the toggle calls onhidewhitespace with the flipped value', async () => {
    const onhidewhitespace = vi.fn()
    render(InspectStep, { props: { ...baseProps, files: [mixedFile], onhidewhitespace } })
    await userEvent.click(screen.getByRole('button', { name: 'Hide whitespace' }))
    expect(onhidewhitespace).toHaveBeenCalledWith(true)
  })

  it('toggle reflects hideWhitespace=true with aria-pressed', () => {
    render(InspectStep, { props: { ...baseProps, files: [mixedFile], hideWhitespace: true, contentsMap: makeContentsMap() } })
    expect(screen.getByRole('button', { name: 'Hide whitespace' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('is disabled with a tooltip when whitespaceDisabledReason is set (compare mode)', async () => {
    const onhidewhitespace = vi.fn()
    render(InspectStep, {
      props: { ...baseProps, files: [mixedFile], onhidewhitespace, whitespaceDisabledReason: 'Not available in compare view' },
    })
    const btn = screen.getByRole('button', { name: 'Hide whitespace' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Not available in compare view')
  })

  it('whitespace-only file collapses to placeholder and is counted in the toolbar note', () => {
    render(InspectStep, {
      props: { ...baseProps, files: [mixedFile, wsOnlyFile], hideWhitespace: true, contentsMap: makeContentsMap() },
    })
    expect(screen.getByText('No changes when hiding whitespace.')).toBeInTheDocument()
    expect(screen.getByText('1 whitespace-only file hidden')).toBeInTheDocument()
  })

  it('shows no toolbar note when nothing collapses', () => {
    render(InspectStep, {
      props: { ...baseProps, files: [mixedFile], hideWhitespace: true, contentsMap: makeContentsMap() },
    })
    expect(screen.queryByText(/whitespace-only file/)).not.toBeInTheDocument()
  })

  it('file without full contents keeps its diff and shows the unavailable note', () => {
    render(InspectStep, {
      props: { ...baseProps, files: [noContentsFile], hideWhitespace: true, contentsMap: makeContentsMap() },
    })
    expect(
      screen.getByText("Whitespace hiding isn't available for this file — showing the full diff."),
    ).toBeInTheDocument()
    // The normal diff still renders (not a placeholder)
    expect(screen.queryByText('No changes when hiding whitespace.')).not.toBeInTheDocument()
  })

  it('toggle off → no placeholders, no notes', () => {
    render(InspectStep, {
      props: { ...baseProps, files: [mixedFile, wsOnlyFile, noContentsFile], hideWhitespace: false, contentsMap: makeContentsMap() },
    })
    expect(screen.queryByText('No changes when hiding whitespace.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Whitespace hiding isn't available/)).not.toBeInTheDocument()
  })

  it('shows the comment-anchoring note on recomputed files when hiding is active', () => {
    render(InspectStep, {
      props: { ...baseProps, files: [mixedFile], hideWhitespace: true, contentsMap: makeContentsMap() },
    })
    expect(screen.getByText(/Line comments are disabled while whitespace changes are hidden/)).toBeInTheDocument()
  })
})
