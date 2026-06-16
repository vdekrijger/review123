import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import VerdictPanel from './VerdictPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { VerdictResult, FindingVerification } from '../../lib/ai/schemas'

// Mock mermaid (MarkdownView)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg/>' }),
  },
}))

function makeRun(overrides: Partial<AiRun>): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    alternatives: { status: 'idle' },
    story: { status: 'idle' },
    skillReviews: [],
    totalUsage: undefined,
    verdictModels: [],
    modelPerformance: [],
    modelCostBreakdown: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    retrySkill: async () => {},
    ...overrides,
  }
}

describe('VerdictPanel — explainer text', () => {
  it('shows the muted one-line explainer at the top of the panel', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/foo.ts: clean'],
      notAnalyzed: [],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
    expect(
      screen.getByText(
        /the specific observations the AI based the behavior verdict on/i
      )
    ).toBeInTheDocument()
  })
})

describe('VerdictPanel', () => {
  it('shows no-key message when verdict status is no-key', () => {
    render(VerdictPanel, { props: { run: makeRun({ verdict: { status: 'no-key' } }) } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })

  it('renders evidence items', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['Change in src/foo.ts: no side effects'],
      notAnalyzed: [],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
    expect(screen.getByText(/no side effects/i)).toBeInTheDocument()
  })

  it('shows notAnalyzed paths when non-empty', () => {
    const verdict: VerdictResult = {
      level: 'significant-changes',
      evidence: [],
      notAnalyzed: ['src/skipped.ts'],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
    expect(screen.getByText('src/skipped.ts')).toBeInTheDocument()
  })

  it('hides notAnalyzed section when empty', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['all good'],
      notAnalyzed: [],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
    expect(screen.queryByText('Not analyzed')).not.toBeInTheDocument()
  })

  it('calls onhotspot when evidence path chip is clicked', async () => {
    const onhotspot = vi.fn()
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/bar.ts: minor refactor'],
      notAnalyzed: [],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }), onhotspot },
    })
    const chip = screen.getByRole('button', { name: /Jump to src\/bar\.ts/i })
    chip.click()
    expect(onhotspot).toHaveBeenCalledWith('src/bar.ts')
  })
})

describe('VerdictPanel — cross-model verify chip (Plan M, styled tooltip)', () => {
  const verification: FindingVerification = {
    confirmedBy: 2,
    polledModels: 3,
    surfaced: true,
    perModel: [
      { provider: 'DeepSeek', model: 'deepseek-v4-flash', raised: true, verdict: 'confirm', reason: '' },
      { provider: 'OpenAI', model: 'gpt-5-mini', verdict: 'confirm', reason: 'real regression' },
      { provider: 'Anthropic', model: 'claude-sonnet-4-6', verdict: 'refute', reason: 'looks moot' },
    ],
  }

  function renderWithVerification(over: Partial<FindingVerification> = {}) {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/foo.ts: off-by-one in the loop bound'],
      notAnalyzed: [],
      evidenceVerification: { 0: { ...verification, ...over } },
    }
    return render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
  }

  it('renders the "✓ confirmed by N/M models" chip, keyboard-focusable (no native title)', () => {
    const { container } = renderWithVerification()
    const chip = container.querySelector('.evidence-verify-chip')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('confirmed by 2/3 models')
    // Keyboard-focusable, button role — not a cramped native title tooltip.
    expect(chip?.getAttribute('tabindex')).toBe('0')
    expect(chip?.getAttribute('role')).toBe('button')
    expect(chip?.getAttribute('title')).toBeNull()
  })

  it('exposes the readable STYLED tooltip: a row per vote with model + verdict indicator + reason', () => {
    const { container } = renderWithVerification()
    const tip = container.querySelector('.skill-verify-tip')
    expect(tip).toBeTruthy()
    expect(tip?.querySelector('.skill-verify-tip-heading')?.textContent).toContain('Confirmed by 2/3 models')
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    expect(rows.length).toBe(3)
    // Generator/raiser row: model + "raised it" tag.
    expect(rows[0].querySelector('.skill-verify-tip-model')?.textContent).toBe('deepseek-v4-flash')
    expect(rows[0].querySelector('.skill-verify-tip-raised')?.textContent).toContain('raised it')
    // Verifier row: model + reason, no "raised it" tag.
    expect(rows[1].querySelector('.skill-verify-tip-model')?.textContent).toBe('gpt-5-mini')
    expect(rows[1].querySelector('.skill-verify-tip-raised')).toBeNull()
    expect(rows[1].querySelector('.skill-verify-tip-reason')?.textContent).toContain('real regression')
    // A refute vote carries the refute indicator.
    expect(rows[2].querySelector('.skill-verify-tip-glyph.verdict-refute')).toBeTruthy()
  })

  it('falls back to the provider name when a vote has no model (old cached data)', () => {
    const { container } = renderWithVerification({
      perModel: [
        { provider: 'DeepSeek', verdict: 'confirm', reason: '' },
        { provider: 'OpenAI', verdict: 'confirm', reason: 'agree' },
      ],
    })
    const models = [...container.querySelectorAll('.skill-verify-tip-model')].map((m) => m.textContent)
    expect(models).toEqual(['DeepSeek', 'OpenAI'])
  })
})

describe('VerdictPanel — pending skeleton (text-shaped)', () => {
  it('shows the text-line skeleton when verdict is idle (pending, no blank gap)', () => {
    const { container } = render(VerdictPanel, { props: { run: makeRun({}) } })
    expect(container.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()
    expect(container.querySelectorAll('.skeleton-line').length).toBeGreaterThan(0)
  })

  it('shows the skeleton when verdict is loading', () => {
    const { container } = render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'loading' } }) },
    })
    expect(container.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()
  })
})
