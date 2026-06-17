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
  // Per-vote rows carry the specific MODEL. Every verifier runs the same
  // comprehensive adversarial check (no lens). The generator/raiser row is marked
  // `raised` and shows a "raised it" tag; verifier rows carry no tag.
  const surfaced = {
    confirmedBy: 2,
    polledModels: 3,
    surfaced: true,
    perModel: [
      { provider: 'DeepSeek', model: 'deepseek-v4-flash', raised: true, verdict: 'confirm' as const, reason: '' },
      { provider: 'OpenAI', model: 'gpt-5-mini', verdict: 'confirm' as const, reason: 'real off-by-one' },
      { provider: 'Anthropic', model: 'claude-sonnet-4-6', verdict: 'refute' as const, reason: 'looks moot' },
    ],
  }

  it('renders a "✓ confirmed by N/M models" chip when surfaced', () => {
    const { container } = renderCard({ verification: surfaced })
    const chip = container.querySelector('.skill-verify-chip')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('confirmed by 2/3 models')
  })

  it('the chip is keyboard-focusable (tabindex + role)', () => {
    const { container } = renderCard({ verification: surfaced })
    const chip = container.querySelector('.skill-verify-chip')
    expect(chip?.getAttribute('tabindex')).toBe('0')
    expect(chip?.getAttribute('role')).toBe('button')
  })

  it('the styled tooltip lists per-vote MODEL + verdict indicator + reason (no lens tag)', () => {
    const { container } = renderCard({ verification: surfaced })
    const tip = container.querySelector('.skill-verify-tip')
    expect(tip).toBeTruthy()
    // Heading mirrors the chip.
    expect(tip?.querySelector('.skill-verify-tip-heading')?.textContent).toContain('Confirmed by 2/3 models')
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    expect(rows.length).toBe(3)
    // No lens tag anywhere — per-lens verification is retired.
    expect(container.querySelector('.skill-verify-tip-lens')).toBeNull()
    // Generator/raiser row: shows its MODEL and a "raised it" tag.
    expect(rows[0].querySelector('.skill-verify-tip-model')?.textContent).toBe('deepseek-v4-flash')
    expect(rows[0].querySelector('.skill-verify-tip-raised')?.textContent).toContain('raised it')
    // Verifier row: model + reason, and NO "raised it" tag.
    expect(rows[1].querySelector('.skill-verify-tip-model')?.textContent).toBe('gpt-5-mini')
    expect(rows[1].querySelector('.skill-verify-tip-raised')).toBeNull()
    expect(rows[1].querySelector('.skill-verify-tip-reason')?.textContent).toContain('real off-by-one')
    // A REFUTE vote gets the refute indicator class, still no tag.
    expect(rows[2].querySelector('.skill-verify-tip-glyph.verdict-refute')).toBeTruthy()
    expect(rows[2].querySelector('.skill-verify-tip-raised')).toBeNull()
  })

  it('falls back to the provider name when a vote has no model (old cached data)', () => {
    const { container } = renderCard({
      verification: {
        confirmedBy: 1,
        polledModels: 2,
        surfaced: true,
        perModel: [
          { provider: 'DeepSeek', verdict: 'confirm' as const, reason: '' },
          { provider: 'OpenAI', verdict: 'confirm' as const, reason: 'agree' },
        ],
      },
    })
    const models = [...container.querySelectorAll('.skill-verify-tip-model')].map((m) => m.textContent)
    expect(models).toEqual(['DeepSeek', 'OpenAI'])
  })

  it('an UNCERTAIN vote shows the uncertain indicator', () => {
    const { container } = renderCard({
      verification: {
        confirmedBy: 1,
        polledModels: 2,
        surfaced: true,
        perModel: [
          { provider: 'DeepSeek', model: 'deepseek-v4-flash', raised: true, verdict: 'confirm' as const, reason: '' },
          { provider: 'OpenAI', model: 'gpt-5-mini', verdict: 'uncertain' as const, reason: 'cannot tell' },
        ],
      },
    })
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    expect(rows[1].querySelector('.skill-verify-tip-glyph.verdict-uncertain')).toBeTruthy()
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
      { provider: 'DeepSeek', model: 'deepseek-v4-flash', raised: true, verdict: 'confirm' as const, reason: '' },
      { provider: 'OpenAI', model: 'gpt-5-mini', verdict: 'refute' as const, reason: 'not a real issue' },
      { provider: 'Anthropic', model: 'claude-sonnet-4-6', verdict: 'uncertain' as const, reason: '' },
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

  it('the lower-confidence chip still carries the per-model styled tooltip', () => {
    const { container } = renderCard({ verification: demoted })
    const chip = container.querySelector('.skill-lower-confidence-chip')
    expect(chip?.getAttribute('tabindex')).toBe('0')
    const tip = container.querySelector('.skill-verify-tip')
    expect(tip?.querySelector('.skill-verify-tip-heading')?.textContent).toContain('Flagged by 1/3')
    const rows = container.querySelectorAll('.skill-verify-tip-row')
    // No lens tag anywhere.
    expect(container.querySelector('.skill-verify-tip-lens')).toBeNull()
    // Generator row: model + "raised it" tag.
    expect(rows[0].querySelector('.skill-verify-tip-model')?.textContent).toBe('deepseek-v4-flash')
    expect(rows[0].querySelector('.skill-verify-tip-raised')?.textContent).toContain('raised it')
    // Refuting verifier: model + refute indicator + reason, no "raised it" tag.
    expect(rows[1].querySelector('.skill-verify-tip-model')?.textContent).toBe('gpt-5-mini')
    expect(rows[1].querySelector('.skill-verify-tip-raised')).toBeNull()
    expect(rows[1].querySelector('.skill-verify-tip-glyph.verdict-refute')).toBeTruthy()
    expect(rows[1].querySelector('.skill-verify-tip-reason')?.textContent).toContain('not a real issue')
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

describe('SkillFindingCard — Ask AI (grounded follow-up)', () => {
  // An askFn that streams two deltas then resolves with the final answer.
  function streamingAskFn(answer = 'Break-even is ~1k rows.') {
    return vi.fn(async (_q: string, onDelta: (t: string) => void) => {
      onDelta('Break-even ')
      onDelta('is ~1k rows.')
      return { ok: true as const, answer }
    })
  }

  it('no Ask AI button when askFn is not provided', () => {
    renderCard({})
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument()
  })

  it('shows the Ask AI button when askFn is provided', () => {
    renderCard({ askFn: streamingAskFn() })
    expect(screen.getByRole('button', { name: /ask ai/i })).toBeInTheDocument()
  })

  it('clicking Ask AI opens the inline ask box', async () => {
    renderCard({ askFn: streamingAskFn() })
    expect(screen.queryByTestId('ask-box')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    expect(screen.getByTestId('ask-box')).toBeInTheDocument()
    expect(screen.getByTestId('ask-box-input')).toBeInTheDocument()
  })

  it('submitting a question calls askFn with a focus whose finding equals the card body (+ path/excerpt)', async () => {
    const askFn = streamingAskFn()
    const body = "the migration doesn't add db_index=True — full table scan"
    renderCard({ askFn, body, askPath: 'm/0003.py', askExcerpt: '+ field = CharField()', line: 12, anchored: true })

    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    await userEvent.type(screen.getByTestId('ask-box-input'), 'what is the break-even?')
    await userEvent.click(screen.getByTestId('ask-box-send'))

    expect(askFn).toHaveBeenCalledOnce()
    const [q, , focus] = askFn.mock.calls[0]
    expect(q).toBe('what is the break-even?')
    expect(focus).toMatchObject({
      path: 'm/0003.py',
      line: 12,
      excerpt: '+ field = CharField()',
      finding: body,
    })
  })

  it('file-level (null line): focus.line falls back to 1 and finding is the body', async () => {
    const askFn = streamingAskFn()
    renderCard({ askFn, body: 'File-level concern', line: null, askPath: 'src/big.py' })
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    await userEvent.type(screen.getByTestId('ask-box-input'), 'why?')
    await userEvent.click(screen.getByTestId('ask-box-send'))
    const [, , focus] = askFn.mock.calls[0]
    expect(focus).toMatchObject({ path: 'src/big.py', line: 1, finding: 'File-level concern' })
  })

  it('renders the streamed answer as markdown', async () => {
    const askFn = vi.fn(async (_q: string, onDelta: (t: string) => void) => {
      onDelta('answer')
      return { ok: true as const, answer: 'Use a **partial index** here.' }
    })
    const { container } = renderCard({ askFn })
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    await userEvent.type(screen.getByTestId('ask-box-input'), 'how to fix?')
    await userEvent.click(screen.getByTestId('ask-box-send'))

    const answer = await screen.findByTestId('ask-box-answer')
    expect(answer.querySelector('strong')?.textContent).toBe('partial index')
    void container
  })

  it('renders the error state when askFn resolves not-ok', async () => {
    const askFn = vi.fn(async () => ({ ok: false as const, error: 'No API key configured.' }))
    renderCard({ askFn })
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    await userEvent.type(screen.getByTestId('ask-box-input'), 'q?')
    await userEvent.click(screen.getByTestId('ask-box-send'))
    const err = await screen.findByTestId('ask-box-error')
    expect(err.textContent).toContain('No API key configured.')
  })

  it('an empty question does not submit', async () => {
    const askFn = streamingAskFn()
    renderCard({ askFn })
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    // Send button is disabled with no text; clicking it is a no-op.
    const send = screen.getByTestId('ask-box-send')
    expect(send).toBeDisabled()
    await userEvent.click(send)
    expect(askFn).not.toHaveBeenCalled()
    // Whitespace-only also does not submit.
    await userEvent.type(screen.getByTestId('ask-box-input'), '   ')
    expect(screen.getByTestId('ask-box-send')).toBeDisabled()
  })

  it('Enter sends the question (no Shift)', async () => {
    const askFn = streamingAskFn()
    renderCard({ askFn })
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    const input = screen.getByTestId('ask-box-input')
    await userEvent.type(input, 'why?{Enter}')
    expect(askFn).toHaveBeenCalledOnce()
    expect(askFn.mock.calls[0][0]).toBe('why?')
  })

  it('Escape closes the ask box', async () => {
    renderCard({ askFn: streamingAskFn() })
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    const input = screen.getByTestId('ask-box-input')
    await userEvent.type(input, '{Escape}')
    expect(screen.queryByTestId('ask-box')).not.toBeInTheDocument()
  })

  it('the answer is ephemeral — it does not call onAdd (not saved as a draft)', async () => {
    const onAdd = vi.fn()
    const askFn = streamingAskFn()
    renderCard({ askFn, onAdd })
    await userEvent.click(screen.getByRole('button', { name: /ask ai/i }))
    await userEvent.type(screen.getByTestId('ask-box-input'), 'q?')
    await userEvent.click(screen.getByTestId('ask-box-send'))
    await screen.findByTestId('ask-box-answer')
    expect(onAdd).not.toHaveBeenCalled()
  })
})
