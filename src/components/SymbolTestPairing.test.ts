import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import SymbolTestPairing from './SymbolTestPairing.svelte'
import type { SymbolTestPairing as Pairing } from '../lib/diff/symbolTests'

vi.mock('../lib/analytics/analytics', () => ({ track: vi.fn() }))

const TS_TEST_CONTENT = "describe('keys', () => {\n  const expected = 2\n  it('buildKey works', () => {\n    expect(buildKey(1)).toBe(expected)\n  })\n})"

function makePairing(testFile: string): Pairing {
  return {
    symbol: 'buildKey',
    implFile: 'src/keys.ts',
    implLineRange: { start: 1, end: 3 },
    tests: [
      { testFile, lineRange: { start: 1, end: 6 }, title: 'buildKey works', confidence: 'named' },
    ],
  }
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    pairing: makePairing('src/keys.test.ts'),
    testContents: new Map([['src/keys.test.ts', TS_TEST_CONTENT]]),
    prPathSet: new Set<string>(['src/keys.test.ts']),
    onJumpToFile: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('SymbolTestPairing — snippet highlighting', () => {
  it('renders hljs token spans for a TS keyword in the expanded snippet', async () => {
    render(SymbolTestPairing, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    await waitFor(() => {
      const pre = document.querySelector('.sym-test-pre')
      expect(pre?.innerHTML).toContain('hljs-keyword')
    })
    // The keyword text is still present (const).
    expect(document.querySelector('.sym-test-pre')?.textContent).toContain('const')
  })
})

describe('SymbolTestPairing — diff membership', () => {
  it('shows an "in this PR" chip and a clickable path when the test is in the PR diff', async () => {
    const onJumpToFile = vi.fn()
    render(SymbolTestPairing, { props: baseProps({ onJumpToFile }) })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    expect(screen.getByText(/in this PR/i)).toBeInTheDocument()
    // The file path is a button that jumps to the file.
    const jump = screen.getByRole('button', { name: /src\/keys\.test\.ts/ })
    await fireEvent.click(jump)
    expect(onJumpToFile).toHaveBeenCalledWith('src/keys.test.ts')
  })

  it('labels a pre-existing test (not in PR diff) as "existing test" and does not make it clickable', async () => {
    const onJumpToFile = vi.fn()
    render(SymbolTestPairing, {
      props: baseProps({
        pairing: makePairing('src/preexisting.test.ts'),
        testContents: new Map([['src/preexisting.test.ts', TS_TEST_CONTENT]]),
        prPathSet: new Set<string>(['src/keys.test.ts']),
        onJumpToFile,
      }),
    })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    expect(screen.getByText(/existing test/i)).toBeInTheDocument()
    expect(screen.queryByText(/in this PR/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /src\/preexisting\.test\.ts/ })).not.toBeInTheDocument()
  })
})
