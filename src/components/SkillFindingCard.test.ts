/**
 * SkillFindingCard — the single visual system for reviewer finding cards.
 *
 * Contract:
 *  - Severity is the ONLY thing the border/badge color encodes:
 *    severity class on the card root + matching severity chip.
 *  - No accent/dashed mystery borders (severity borders are solid; verified
 *    via the severity-* classes which map to legend tokens in CSS).
 *  - State is shown ONLY via small labeled chips:
 *    added-as-draft → "✓ added as draft" chip; unresolvable anchor →
 *    "line N — not in this diff" note.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SkillFindingCard from './SkillFindingCard.svelte'

function renderCard(props: Partial<Parameters<typeof render>[1]> & Record<string, unknown> = {}) {
  return render(SkillFindingCard, {
    props: {
      skillName: 'Architecture & Design Reviewer',
      severity: 'medium',
      body: 'Consider extracting this into a helper',
      onAdd: vi.fn(),
      onDismiss: vi.fn(),
      ...props,
    },
  })
}

describe('SkillFindingCard — severity visual system', () => {
  it.each(['high', 'medium', 'low'] as const)(
    'severity %s: card has severity class and a matching severity chip',
    (severity) => {
      const { container } = renderCard({ severity })
      const card = container.querySelector('.skill-finding')
      expect(card?.classList.contains(`severity-${severity}`)).toBe(true)
      const chip = container.querySelector(`.severity-chip-${severity}`)
      expect(chip).toBeTruthy()
      expect(chip?.textContent).toBe(severity)
    },
  )

  it('renders the persona label', () => {
    renderCard()
    expect(screen.getByText('Architecture & Design Reviewer')).toBeInTheDocument()
  })

  it('renders the finding body', () => {
    renderCard()
    expect(screen.getByText('Consider extracting this into a helper')).toBeInTheDocument()
  })

  it('renders inline markdown in the body: backticks become a <code> element', () => {
    const { container } = renderCard({ body: 'The `REDIS_URL` env var must be set' })
    const codeEl = container.querySelector('.skill-finding-body code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('REDIS_URL')
    // No literal backticks leak through
    expect(container.querySelector('.skill-finding-body')!.textContent).not.toContain('`')
  })

  it('renders block markdown: a fenced code block becomes a <pre>/<code> block, not literal backticks', () => {
    const body = 'Use a guard:\n\n```ts\nif (!user) return\n```'
    const { container } = renderCard({ body })
    const pre = container.querySelector('.skill-finding-body pre code')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('if (!user) return')
    // The fence markers do not leak through as literal text
    expect(container.querySelector('.skill-finding-body')!.textContent).not.toContain('```')
  })

  it('renders block markdown: a bullet list becomes <li> elements', () => {
    const body = '- first\n- second'
    const { container } = renderCard({ body })
    const items = container.querySelectorAll('.skill-finding-body li')
    expect(items.length).toBe(2)
    expect(items[0].textContent).toContain('first')
  })

  it('renders block markdown: plain prose becomes a <p>', () => {
    const { container } = renderCard({ body: 'Consider extracting this into a helper' })
    const p = container.querySelector('.skill-finding-body p')
    expect(p).not.toBeNull()
    expect(p!.textContent).toBe('Consider extracting this into a helper')
  })

  it('exposes an aria-label naming the persona and severity', () => {
    renderCard({ severity: 'high' })
    expect(
      screen.getByRole('note', { name: /Architecture & Design Reviewer finding, severity high/i }),
    ).toBeInTheDocument()
  })
})

describe('SkillFindingCard — state chips (the only state styling)', () => {
  it('added=false: no state chip, active Add-as-draft button', () => {
    renderCard({ added: false })
    expect(screen.queryByText(/added as draft/i)).not.toBeInTheDocument()
    const btn = screen.getByRole('button', { name: /add as draft/i })
    expect(btn).toBeEnabled()
    expect(btn.textContent).toBe('Add as draft')
  })

  it('added=true: labeled "✓ added as draft" state chip and disabled button', () => {
    const { container } = renderCard({ added: true })
    const chip = container.querySelector('.skill-state-chip')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('added as draft')
    expect(screen.getByRole('button', { name: /added to drafts/i })).toBeDisabled()
  })

  it('unanchored with a line: shows the labeled "not in this diff" note', () => {
    const { container } = renderCard({ line: 42, anchored: false })
    const note = container.querySelector('.skill-line-note')
    expect(note?.textContent).toBe('line 42 — not in this diff')
  })

  it('anchored: no line note (position in the diff is the label)', () => {
    const { container } = renderCard({ line: 42, anchored: true })
    expect(container.querySelector('.skill-line-note')).toBeNull()
  })

  it('file-level (line=null): no line note', () => {
    const { container } = renderCard({ line: null, anchored: false })
    expect(container.querySelector('.skill-line-note')).toBeNull()
  })

  it('compact prop adds the compact class for inline rendering', () => {
    const { container } = renderCard({ compact: true })
    expect(container.querySelector('.skill-finding.compact')).toBeTruthy()
  })
})

describe('SkillFindingCard — cross-model verification chip (Plan M)', () => {
  const surfaced = {
    confirmedBy: 2,
    polledModels: 3,
    surfaced: true,
    perModel: [
      { provider: 'DeepSeek', verdict: 'confirm' as const, reason: '' },
      { provider: 'OpenAI', verdict: 'confirm' as const, reason: 'real off-by-one' },
      { provider: 'Anthropic', verdict: 'refute' as const, reason: 'looks moot' },
    ],
  }

  it('renders a "✓ confirmed by N/M models" chip when surfaced', () => {
    const { container } = renderCard({ verification: surfaced })
    const chip = container.querySelector('.skill-verify-chip')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('confirmed by 2/3 models')
  })

  it('the chip tooltip lists each model verdict', () => {
    const { container } = renderCard({ verification: surfaced })
    const chip = container.querySelector('.skill-verify-chip')
    const title = chip?.getAttribute('title') ?? ''
    expect(title).toContain('DeepSeek: confirm')
    expect(title).toContain('OpenAI: confirm — real off-by-one')
    expect(title).toContain('Anthropic: refute — looks moot')
  })

  it('no chip when there is no verification (single-key / off)', () => {
    const { container } = renderCard({})
    expect(container.querySelector('.skill-verify-chip')).toBeNull()
  })

  it('no GREEN confirmed chip when the finding was demoted (surfaced=false)', () => {
    const { container } = renderCard({
      verification: { ...surfaced, surfaced: false, confirmedBy: 1 },
    })
    expect(container.querySelector('.skill-verify-chip')).toBeNull()
  })
})

describe('SkillFindingCard — lower-confidence (cross-model demoted, Plan M)', () => {
  const demoted = {
    confirmedBy: 1,
    polledModels: 3,
    surfaced: false,
    perModel: [
      { provider: 'DeepSeek', verdict: 'confirm' as const, reason: 'raised it' },
      { provider: 'OpenAI', verdict: 'refute' as const, reason: 'not a real issue' },
      { provider: 'Anthropic', verdict: 'uncertain' as const, reason: '' },
    ],
  }

  it('renders the card DIMMED with a lower-confidence badge when surfaced=false', () => {
    const { container } = renderCard({ verification: demoted })
    const card = container.querySelector('.skill-finding')
    expect(card?.classList.contains('lower-confidence')).toBe(true)
    const chip = container.querySelector('.skill-lower-confidence-chip')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('flagged by 1/3')
    expect(chip?.textContent).toContain('lower confidence')
  })

  it('the lower-confidence chip still carries the per-model tooltip', () => {
    const { container } = renderCard({ verification: demoted })
    const chip = container.querySelector('.skill-lower-confidence-chip')
    const title = chip?.getAttribute('title') ?? ''
    expect(title).toContain('DeepSeek: confirm — raised it')
    expect(title).toContain('OpenAI: refute — not a real issue')
  })

  it('a surfaced finding is NOT dimmed and shows no lower-confidence chip', () => {
    const { container } = renderCard({
      verification: { ...demoted, surfaced: true, confirmedBy: 2 },
    })
    expect(container.querySelector('.skill-finding.lower-confidence')).toBeNull()
    expect(container.querySelector('.skill-lower-confidence-chip')).toBeNull()
  })

  it('no verification → no lower-confidence treatment at all', () => {
    const { container } = renderCard({})
    expect(container.querySelector('.skill-finding.lower-confidence')).toBeNull()
    expect(container.querySelector('.skill-lower-confidence-chip')).toBeNull()
  })

  it('the demoted card still renders inline (anchored) with the badge', () => {
    const { container } = renderCard({ verification: demoted, line: 12, anchored: true, compact: true })
    expect(container.querySelector('.skill-finding.lower-confidence.compact')).toBeTruthy()
    expect(container.querySelector('.skill-lower-confidence-chip')).toBeTruthy()
  })
})

describe('SkillFindingCard — actions', () => {
  it('Add as draft calls onAdd', async () => {
    const onAdd = vi.fn()
    renderCard({ onAdd })
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('Dismiss calls onDismiss', async () => {
    const onDismiss = vi.fn()
    renderCard({ onDismiss })
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('disabled Add button does not call onAdd when added', async () => {
    const onAdd = vi.fn()
    renderCard({ onAdd, added: true })
    await userEvent.click(screen.getByRole('button', { name: /added to drafts/i }))
    expect(onAdd).not.toHaveBeenCalled()
  })
})

describe('SkillFindingCard — raised-by chip (Plan O)', () => {
  const verif = (polled: number) => ({ confirmedBy: 2, polledModels: polled, surfaced: true, perModel: [] })

  it('shows "raised by B" when one model raised it but more were polled (recall catch)', () => {
    renderCard({ raisedBy: ['Anthropic'], verification: verif(2) })
    expect(screen.getByText('raised by Anthropic')).toBeTruthy()
  })

  it('shows "raised by A, B" when a subset of the polled models raised it', () => {
    renderCard({ raisedBy: ['DeepSeek', 'Anthropic'], verification: verif(3) })
    expect(screen.getByText('raised by DeepSeek, Anthropic')).toBeTruthy()
  })

  it('no chip when every polled model raised it (no signal)', () => {
    const { container } = renderCard({ raisedBy: ['DeepSeek', 'Anthropic'], verification: verif(2) })
    expect(container.querySelector('.skill-raised-chip')).toBeNull()
  })

  it('no chip when raisedBy is absent (verify mode)', () => {
    const { container } = renderCard({})
    expect(container.querySelector('.skill-raised-chip')).toBeNull()
  })
})
