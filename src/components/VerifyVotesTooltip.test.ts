/**
 * VerifyVotesTooltip — the shared readable cross-model verification tooltip used
 * by SkillFindingCard and VerdictPanel. One row per polled model: a color-coded
 * verdict indicator (✓ confirm / ✗ refute / ? uncertain), the specific MODEL
 * (falling back to provider when absent), and the reason (the generator/raiser
 * row shows a "raised it" tag instead).
 */

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import VerifyVotesTooltip from './VerifyVotesTooltip.svelte'
import type { FindingVerification } from '../lib/ai/schemas'

// A minimal chip snippet to host the tooltip — mirrors how the callers pass a
// focusable chip element as children.
const chip = createRawSnippet(() => ({
  render: () => `<span class="host-chip" tabindex="0" role="button">chip</span>`,
}))

function renderTip(verification: FindingVerification, heading?: string) {
  return render(VerifyVotesTooltip, {
    props: heading === undefined ? { verification, children: chip } : { verification, heading, children: chip },
  })
}

describe('VerifyVotesTooltip', () => {
  const surfaced: FindingVerification = {
    confirmedBy: 2,
    polledModels: 3,
    surfaced: true,
    perModel: [
      { provider: 'DeepSeek', model: 'deepseek-v4-flash', raised: true, verdict: 'confirm', reason: '' },
      { provider: 'OpenAI', model: 'gpt-5-mini', verdict: 'confirm', reason: 'real off-by-one' },
      { provider: 'Anthropic', model: 'claude-sonnet-4-6', verdict: 'refute', reason: 'looks moot' },
    ],
  }

  it('renders the host chip (children) plus the styled tooltip wrapper', () => {
    const { container } = renderTip(surfaced)
    expect(container.querySelector('.skill-verify-tip-anchor .host-chip')).toBeTruthy()
    expect(container.querySelector('.skill-verify-tip')).toBeTruthy()
    expect(container.querySelector('.skill-verify-tip')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('lists each vote with model + verdict indicator + reason', () => {
    const { container } = renderTip(surfaced)
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    expect(rows.length).toBe(3)
    expect(rows[1].querySelector('.skill-verify-tip-model')?.textContent).toBe('gpt-5-mini')
    expect(rows[1].querySelector('.skill-verify-tip-glyph.verdict-confirm')).toBeTruthy()
    expect(rows[1].querySelector('.skill-verify-tip-reason')?.textContent).toContain('real off-by-one')
  })

  it('the generator/raiser row shows "raised it" instead of a reason', () => {
    const { container } = renderTip(surfaced)
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    expect(rows[0].querySelector('.skill-verify-tip-model')?.textContent).toBe('deepseek-v4-flash')
    expect(rows[0].querySelector('.skill-verify-tip-raised')?.textContent).toContain('raised it')
    expect(rows[0].querySelector('.skill-verify-tip-reason')).toBeNull()
  })

  it('a refute vote gets the refute indicator', () => {
    const { container } = renderTip(surfaced)
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    expect(rows[2].querySelector('.skill-verify-tip-glyph.verdict-refute')).toBeTruthy()
  })

  it('an uncertain vote gets the uncertain indicator', () => {
    const { container } = renderTip({
      confirmedBy: 1,
      polledModels: 2,
      surfaced: true,
      perModel: [
        { provider: 'DeepSeek', model: 'deepseek-v4-flash', raised: true, verdict: 'confirm', reason: '' },
        { provider: 'OpenAI', model: 'gpt-5-mini', verdict: 'uncertain', reason: 'cannot tell' },
      ],
    })
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    expect(rows[1].querySelector('.skill-verify-tip-glyph.verdict-uncertain')).toBeTruthy()
  })

  it('falls back to the provider name when a vote has no model', () => {
    const { container } = renderTip({
      confirmedBy: 1,
      polledModels: 2,
      surfaced: true,
      perModel: [
        { provider: 'DeepSeek', verdict: 'confirm', reason: '' },
        { provider: 'OpenAI', verdict: 'confirm', reason: 'agree' },
      ],
    })
    const models = [...container.querySelectorAll('.skill-verify-tip-model')].map((m) => m.textContent)
    expect(models).toEqual(['DeepSeek', 'OpenAI'])
  })

  it('derives a "Confirmed by N/M models" heading for a surfaced verification', () => {
    const { container } = renderTip(surfaced)
    expect(container.querySelector('.skill-verify-tip-heading')?.textContent).toBe('Confirmed by 2/3 models')
  })

  it('derives a "Flagged by C/P · lower confidence" heading for a demoted verification', () => {
    const { container } = renderTip({ ...surfaced, surfaced: false, confirmedBy: 1 })
    expect(container.querySelector('.skill-verify-tip-heading')?.textContent).toContain('Flagged by 1/3')
    expect(container.querySelector('.skill-verify-tip-heading')?.textContent).toContain('lower confidence')
  })

  it('uses a caller-supplied heading when provided', () => {
    const { container } = renderTip(surfaced, 'Custom heading')
    expect(container.querySelector('.skill-verify-tip-heading')?.textContent).toBe('Custom heading')
  })
})
