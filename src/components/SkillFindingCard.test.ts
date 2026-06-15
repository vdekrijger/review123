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
