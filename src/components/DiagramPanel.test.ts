/**
 * DiagramPanel component tests.
 *
 * jsdom cannot render SVG via Mermaid's actual renderer, so mermaid is mocked
 * to return { svg: '<svg data-testid="mock-svg"/>' }.
 * The initialize spy lets us assert that securityLevel:'strict' is passed
 * (EC-14j).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import DiagramPanel from './DiagramPanel.svelte'
import type { GraphResult } from '../lib/diagram/types'

// ---------------------------------------------------------------------------
// Mock mermaid module
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn()
const mockRender = vi.fn().mockResolvedValue({ svg: '<svg data-testid="mock-svg"/>' })

vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(opts: {
  beforeNodes?: number
  afterNodes?: number
} = {}): GraphResult {
  const { beforeNodes = 2, afterNodes = 2 } = opts

  return {
    kind: 'flow',
    before: {
      nodes: Array.from({ length: beforeNodes }, (_, i) => ({ id: `b${i}`, label: `Before ${i}` })),
      edges: beforeNodes >= 2 ? [{ from: 'b0', to: 'b1' }] : [],
    },
    after: {
      nodes: Array.from({ length: afterNodes }, (_, i) => ({ id: `a${i}`, label: `After ${i}` })),
      edges: afterNodes >= 2 ? [{ from: 'a0', to: 'a1' }] : [],
    },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue({ svg: '<svg data-testid="mock-svg"/>' })
})

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------

describe('DiagramPanel — state rendering', () => {
  it('idle state with null result shows nothing (idle + no result)', () => {
    render(DiagramPanel, { props: { result: null, panelState: 'idle' } })
    // No loading/error/decline messages for idle+null (treated same as idle+empty)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('loading state shows loading indicator', () => {
    render(DiagramPanel, { props: { result: null, panelState: 'loading' } })
    expect(screen.getByRole('status', { name: /loading diagrams/i })).toBeInTheDocument()
    expect(screen.getByText(/loading diagrams/i)).toBeInTheDocument()
  })

  it('error state shows error message', () => {
    render(DiagramPanel, { props: { result: null, panelState: 'error' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/failed/i)
  })

  it('declined state shows declined message', () => {
    render(DiagramPanel, { props: { result: null, panelState: 'declined' } })
    expect(screen.getByText(/declined/i)).toBeInTheDocument()
  })

  it('EC-14a: both empty graphs → "No structural changes detected"', () => {
    const result = makeResult({ beforeNodes: 0, afterNodes: 0 })
    render(DiagramPanel, { props: { result, panelState: 'idle' } })
    expect(screen.getByText('No structural changes detected.')).toBeInTheDocument()
  })

  it('EC-14a: null result + idle → "No structural changes detected"', () => {
    render(DiagramPanel, { props: { result: null, panelState: 'idle' } })
    expect(screen.getByText('No structural changes detected.')).toBeInTheDocument()
  })

  it('renders diagram containers when graphs have nodes', async () => {
    const result = makeResult({ beforeNodes: 2, afterNodes: 2 })
    render(DiagramPanel, { props: { result, panelState: 'idle' } })
    // The labels Before and After should be visible
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
  })

  it('renders "No structural changes" for empty before graph only', () => {
    const result = makeResult({ beforeNodes: 0, afterNodes: 2 })
    render(DiagramPanel, { props: { result, panelState: 'idle' } })
    // Only one graph is empty; the other renders a container
    expect(screen.getAllByText('No structural changes detected.').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// EC-14j — mermaid.initialize called with strict securityLevel
// ---------------------------------------------------------------------------

describe('EC-14j — mermaid initialize with strict security', () => {
  it('calls mermaid.initialize with securityLevel strict and startOnLoad false', async () => {
    const result = makeResult()
    render(DiagramPanel, { props: { result, panelState: 'idle' } })

    // Wait for the effect to fire and mermaid to be lazy-imported
    await waitFor(() => {
      expect(mockInitialize).toHaveBeenCalled()
    })

    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        startOnLoad: false,
      })
    )
  })

  it('mermaid.render is called for non-empty graphs', async () => {
    const result = makeResult({ beforeNodes: 2, afterNodes: 2 })
    render(DiagramPanel, { props: { result, panelState: 'idle' } })

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled()
    })
    // Should be called twice: once for before, once for after
    expect(mockRender).toHaveBeenCalledTimes(2)
  })

  it('mermaid.render is NOT called for empty graphs', async () => {
    const result = makeResult({ beforeNodes: 0, afterNodes: 0 })
    render(DiagramPanel, { props: { result, panelState: 'idle' } })

    // Give it a moment to NOT call render
    await new Promise((r) => setTimeout(r, 50))
    expect(mockRender).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// EC-14k — overlay open/close
// ---------------------------------------------------------------------------

describe('EC-14k — overlay open and close', () => {
  it('clicking a diagram opens the overlay dialog', async () => {
    const user = userEvent.setup()
    const result = makeResult()
    render(DiagramPanel, { props: { result, panelState: 'idle' } })

    // Wait for render to complete
    await waitFor(() => expect(mockRender).toHaveBeenCalled())

    // Click the "before" diagram button
    const beforeBtn = screen.getByRole('button', { name: /view before diagram full screen/i })
    await user.click(beforeBtn)

    // Overlay should be open
    expect(screen.getByRole('dialog', { name: /diagram full screen/i })).toBeInTheDocument()
  })

  it('clicking the close button closes the overlay', async () => {
    const user = userEvent.setup()
    const result = makeResult()
    render(DiagramPanel, { props: { result, panelState: 'idle' } })

    await waitFor(() => expect(mockRender).toHaveBeenCalled())

    const beforeBtn = screen.getByRole('button', { name: /view before diagram full screen/i })
    await user.click(beforeBtn)

    expect(screen.getByRole('dialog', { name: /diagram full screen/i })).toBeInTheDocument()

    const closeBtn = screen.getByRole('button', { name: /close/i })
    await user.click(closeBtn)

    expect(screen.queryByRole('dialog', { name: /diagram full screen/i })).not.toBeInTheDocument()
  })

  it('pressing Escape closes the overlay', async () => {
    const user = userEvent.setup()
    const result = makeResult()
    const { container } = render(DiagramPanel, { props: { result, panelState: 'idle' } })

    await waitFor(() => expect(mockRender).toHaveBeenCalled())

    const beforeBtn = screen.getByRole('button', { name: /view before diagram full screen/i })
    await user.click(beforeBtn)

    const dialog = screen.getByRole('dialog', { name: /diagram full screen/i })
    expect(dialog).toBeInTheDocument()

    // jsdom does not trap focus in <dialog open> (only showModal() does that).
    // Fire Escape keydown directly on the dialog element so the onkeydown handler fires.
    const dialogEl = container.querySelector('dialog.diagram-overlay')!
    dialogEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    // The overlay should close
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /diagram full screen/i })).not.toBeInTheDocument()
    })
  })

  it('clicking the backdrop (dialog element directly) closes the overlay', async () => {
    const user = userEvent.setup()
    const result = makeResult()
    const { container } = render(DiagramPanel, { props: { result, panelState: 'idle' } })

    await waitFor(() => expect(mockRender).toHaveBeenCalled())

    const beforeBtn = screen.getByRole('button', { name: /view before diagram full screen/i })
    await user.click(beforeBtn)

    expect(screen.getByRole('dialog', { name: /diagram full screen/i })).toBeInTheDocument()

    // Click the dialog element itself (backdrop)
    const dialog = container.querySelector('dialog.diagram-overlay')!
    await user.click(dialog)

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /diagram full screen/i })).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// analytics — track('diagram_viewed') fires once on first render
// ---------------------------------------------------------------------------

describe('analytics — diagram_viewed', () => {
  it('calls track("diagram_viewed") once on first successful render', async () => {
    const trackMock = vi.fn()
    // Inject a capture spy via the analytics module
    const analytics = await import('../lib/analytics/analytics')
    analytics._setCaptureForTest(trackMock)

    const result = makeResult()
    render(DiagramPanel, { props: { result, panelState: 'idle' } })

    await waitFor(() => expect(mockRender).toHaveBeenCalled())

    // Give effects time to settle
    await new Promise((r) => setTimeout(r, 50))

    expect(trackMock).toHaveBeenCalledWith('diagram_viewed', {})

    // Reset capture
    analytics._setCaptureForTest(
      (await import('posthog-js')).default.capture.bind((await import('posthog-js')).default)
    )
  })
})
