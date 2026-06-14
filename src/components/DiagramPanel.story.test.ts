/**
 * DiagramPanel story-mode highlight tests (Plan H).
 *
 * Mocks mermaid to return an SVG with .node groups whose text is a file
 * basename, then asserts the change-map highlights the current step's nodes,
 * dims done-step nodes, and wires click-to-jump.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/svelte'
import DiagramPanel from './DiagramPanel.svelte'
import type { GraphResult } from '../lib/diagram/types'

// An SVG with two named nodes (matches change-map labels by basename).
const NODE_SVG =
  '<svg data-testid="mock-svg">' +
  '<g class="node" id="n1"><text>schema.ts</text></g>' +
  '<g class="node" id="n2"><text>route.ts</text></g>' +
  '</svg>'

const mockInitialize = vi.fn()
const mockRender = vi.fn().mockResolvedValue({ svg: NODE_SVG })

vi.mock('mermaid', () => ({
  default: { initialize: mockInitialize, render: mockRender },
}))
vi.mock('../lib/diagram/mermaidInit', () => ({
  getMermaid: async () => ({ initialize: mockInitialize, render: mockRender }),
}))
vi.mock('../lib/settings/appearance.svelte', () => ({
  resolvedTheme: () => 'dark',
  applyAppearance: vi.fn(),
}))

beforeEach(() => {
  mockRender.mockClear()
})

const RESULT: GraphResult = {
  kind: 'flow',
  before: { nodes: [{ id: 'a', label: 'schema.ts' }], edges: [] },
  after: { nodes: [{ id: 'a', label: 'schema.ts' }, { id: 'b', label: 'route.ts' }], edges: [] },
  changeMap: {
    nodes: [
      { id: 'a', label: 'schema.ts', status: 'changed' },
      { id: 'b', label: 'route.ts', status: 'added' },
    ],
    edges: [],
  },
}

describe('DiagramPanel — story highlight', () => {
  it('marks the current step node and dims done-step nodes', async () => {
    render(DiagramPanel, {
      props: {
        result: RESULT,
        panelState: 'idle',
        highlightFiles: ['src/api/route.ts'],
        doneFiles: ['src/db/schema.ts'],
        onnodeclick: () => {},
      },
    })
    await waitFor(() => {
      const current = document.querySelector('.story-node-current')
      const done = document.querySelector('.story-node-done')
      expect(current?.id).toBe('n2') // route.ts is the current step
      expect(done?.id).toBe('n1') // schema.ts was a done step
    })
  })

  it('calls onnodeclick with the matched file path on node click', async () => {
    const onnodeclick = vi.fn()
    render(DiagramPanel, {
      props: {
        result: RESULT,
        panelState: 'idle',
        highlightFiles: ['src/api/route.ts'],
        doneFiles: ['src/db/schema.ts'],
        onnodeclick,
      },
    })
    await waitFor(() => expect(document.querySelector('.story-node-current')).not.toBeNull())
    const node = document.getElementById('n1')!
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onnodeclick).toHaveBeenCalledWith('src/db/schema.ts')
  })

  it('does not add story classes when no highlight inputs are given (standalone)', async () => {
    render(DiagramPanel, { props: { result: RESULT, panelState: 'idle' } })
    await waitFor(() => expect(mockRender).toHaveBeenCalled())
    expect(document.querySelector('.story-node-current')).toBeNull()
    expect(document.querySelector('.story-node-done')).toBeNull()
  })
})
