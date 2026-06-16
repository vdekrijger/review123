import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import SymbolTestPairing from './SymbolTestPairing.svelte'
import type { SymbolTestPairing as Pairing } from '../lib/diff/symbolTests'

vi.mock('../lib/analytics/analytics', () => ({ track: vi.fn() }))

// A small TS test file with a describe group, a shared beforeEach + vi.mock
// (setup bucket), and two it() cases. `buildKey works` references the changed
// symbol; `handles zero` does not.
const TS_TEST_CONTENT = [
  "import { describe, it, expect, vi, beforeEach } from 'vitest'",
  "import { buildKey } from './keys'",
  '',
  "vi.mock('./db', () => ({ query: vi.fn() }))",
  '',
  "describe('keys', () => {",
  '  let store',
  '  beforeEach(() => {',
  '    store = new Map()',
  '  })',
  '',
  "  it('buildKey works', () => {",
  '    expect(buildKey(1)).toBe(2)',
  '  })',
  '',
  "  it('handles zero', () => {",
  '    expect(other(0)).toBe(0)',
  '  })',
  '})',
].join('\n')

// The pairing's tests[] point at the `buildKey works` block (lines 12-14).
function makePairing(testFile: string): Pairing {
  return {
    symbol: 'buildKey',
    implFile: 'src/keys.ts',
    implLineRange: { start: 1, end: 3 },
    tests: [
      { testFile, lineRange: { start: 12, end: 14 }, title: 'buildKey works', confidence: 'named' },
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

describe('SymbolTestPairing — test-case list', () => {
  it('lists every test title in the file, not just the paired one (no truncation)', async () => {
    render(SymbolTestPairing, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    await waitFor(() => {
      expect(screen.getByText('buildKey works')).toBeInTheDocument()
      expect(screen.getByText('handles zero')).toBeInTheDocument()
    })
  })

  it('pins a "Setup & teardown" row when the file has shared scaffolding', async () => {
    render(SymbolTestPairing, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Setup & teardown/i })).toBeInTheDocument()
    })
  })

  it('expanding a test row reveals its highlighted body', async () => {
    render(SymbolTestPairing, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    // The relevant test ("buildKey works") expands by default → its body shows.
    await waitFor(() => {
      const pre = document.querySelector('.sym-test-pre')
      expect(pre?.textContent).toContain('buildKey(1)')
    })
    await waitFor(() => {
      expect(document.querySelector('.sym-test-pre')?.innerHTML).toContain('hljs-')
    })
  })

  it('marks the test that covers the changed symbol with a chip', async () => {
    render(SymbolTestPairing, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    await waitFor(() => {
      expect(screen.getByText(/covers this change/i)).toBeInTheDocument()
    })
  })

  it('falls back to the legacy snippet when the file is unparseable', async () => {
    // A plain-text file with no it/test declarations → fallback path. The
    // pairing still drives a single snippet of its lineRange.
    const content = 'some random\nfile content\nwith no tests\n'
    render(SymbolTestPairing, {
      props: baseProps({
        pairing: {
          symbol: 'buildKey',
          implFile: 'src/keys.ts',
          implLineRange: { start: 1, end: 3 },
          tests: [{ testFile: 'src/keys.test.ts', lineRange: { start: 1, end: 3 }, confidence: 'referenced' }],
        } satisfies Pairing,
        testContents: new Map([['src/keys.test.ts', content]]),
      }),
    })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    await waitFor(() => {
      const pre = document.querySelector('.sym-test-pre')
      expect(pre?.textContent).toContain('random')
    })
    // No test-case list rows in fallback mode.
    expect(screen.queryByText(/covers this change/i)).not.toBeInTheDocument()
  })
})

describe('SymbolTestPairing — diff membership', () => {
  it('shows an "in this PR" chip and a clickable path when the test is in the PR diff', async () => {
    const onJumpToFile = vi.fn()
    render(SymbolTestPairing, { props: baseProps({ onJumpToFile }) })
    await fireEvent.click(screen.getByRole('button', { name: /Tested by/i }))
    expect(screen.getByText(/in this PR/i)).toBeInTheDocument()
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
