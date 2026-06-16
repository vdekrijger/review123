/**
 * ModelBreakdownTable — per-model cost + impact table (Plan N).
 *
 * Cost-column contract (dollar-first, 2026-06-16):
 *  - The cost cell leads with the $ value (primary), then the token count
 *    (secondary) — e.g. "$0.02 · 1.5k tokens".
 *  - A sub-cent priced row reads "<$0.01 · …" (never "$0.00", never blank).
 *  - A row whose model has NO pricing shows the honest "$—" marker with a
 *    "no pricing on file for <model>" tooltip — the column is NEVER empty.
 *  - The whole cost column only renders when showCost is true.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import ModelBreakdownTable from './ModelBreakdownTable.svelte'
import type { VerdictModelBreakdown } from '../lib/ai/run.svelte'

const usage = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c })

// claude-opus-4-8 ($5/$25 per MTok) generator — priced, multi-cent.
const pricedGenerator: VerdictModelBreakdown = {
  providerId: 'anthropic',
  modelId: 'claude-opus-4-8',
  role: 'generator',
  usage: usage(1_000, 500), // $0.005 + $0.0125 = $0.0175 → "$0.02"
  surfaced: 3,
}

// claude-haiku-4-5 ($1/$5 per MTok) verifier — priced, sub-cent.
const subCentVerifier: VerdictModelBreakdown = {
  providerId: 'anthropic',
  modelId: 'claude-haiku-4-5',
  role: 'verifier',
  usage: usage(800, 200), // $0.0008 + $0.001 = $0.0018 → "<$0.01"
  impact: { confirms: 1, refutes: 0, uncertains: 0, decisive: 0 },
}

// An id no provider lists → no pricing → "$—" marker.
const unpriced: VerdictModelBreakdown = {
  providerId: 'anthropic',
  modelId: 'made-up-model',
  role: 'verifier',
  usage: usage(1_700_000, 33_000), // 1733k tokens, but no $ to compute
  impact: { confirms: 1, refutes: 0, uncertains: 0, decisive: 0 },
}

describe('ModelBreakdownTable — dollar-first cost column', () => {
  it('a priced row leads with the $ BEFORE the token count', () => {
    render(ModelBreakdownTable, { props: { models: [pricedGenerator], showCost: true } })
    const cell = screen.getByText('$0.02 · 1.5k tokens')
    expect(cell).toBeInTheDocument()
    // Dollar-first: the rendered text starts with the $ value.
    expect(cell.textContent!.trim().startsWith('$0.02')).toBe(true)
  })

  it('a sub-cent priced row shows "<$0.01" (still dollar-first, never $0.00)', () => {
    render(ModelBreakdownTable, { props: { models: [subCentVerifier], showCost: true } })
    expect(screen.getByText('<$0.01 · 1.0k tokens')).toBeInTheDocument()
  })

  it('a row with no pricing shows the "$—" marker (not blank) + a tooltip', () => {
    render(ModelBreakdownTable, { props: { models: [unpriced], showCost: true } })
    const cell = screen.getByText(/^\$— · 1733k tokens$/)
    expect(cell).toBeInTheDocument()
    expect(cell.getAttribute('title')).toBe('no pricing on file for made-up-model')
  })

  it('omits the cost column entirely when showCost is false', () => {
    render(ModelBreakdownTable, { props: { models: [pricedGenerator], showCost: false } })
    expect(screen.queryByRole('columnheader', { name: /cost/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument()
  })
})
