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
import { render, screen, fireEvent } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SkillFindingCard from './SkillFindingCard.svelte'
import type { AskFocus } from '../lib/ai/tasks'
import { reanchorDrag } from '../lib/findings/reanchor.svelte'

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

  it('renders the single "✓ verified" trust chip when majority-confirmed', () => {
    const { container } = renderCard({ verification: surfaced })
    const chip = container.querySelector('.skill-verify-chip')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toBe('✓ verified')
    // The vote detail moved out of the chip text into the accessible name /
    // hover detail — the chip itself stays a single calm word.
    expect(chip?.textContent).not.toContain('2/3')
    expect(chip?.getAttribute('aria-label')).toContain('confirmed by 2 of 3 models')
  })

  it('NO chip for a surfaced-but-below-majority verification (weak signal ≠ verified)', () => {
    // 1 explicit confirm of 3 polled — surfaced by the vote threshold
    // (uncertains count 0.5 there) but not a real majority of confirms.
    const { container } = renderCard({
      verification: { ...surfaced, confirmedBy: 1 },
    })
    expect(container.querySelector('.skill-verify-chip')).toBeNull()
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

describe('SkillFindingCard — demoted verification renders NO chip chrome (finding-triage)', () => {
  // The old "flagged by X/Y · lower confidence" chip + dimmed treatment are
  // GONE: a demoted finding's weakness is communicated by its triage tier
  // (the collapsed per-file group), not by per-card metadata the reviewer
  // must decode. The verification DATA stays on the finding object.
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

  it('surfaced=false: no verification chip of any kind, no dimming class, no "flagged by" text', () => {
    const { container } = renderCard({ verification: demoted })
    expect(container.querySelector('.skill-verify-chip')).toBeNull()
    expect(container.querySelector('.skill-lower-confidence-chip')).toBeNull()
    expect(container.querySelector('.skill-finding.lower-confidence')).toBeNull()
    expect(container.textContent).not.toContain('flagged by')
    expect(container.textContent).not.toContain('lower confidence')
  })

  it('the demoted card still renders as a normal card (severity border + body + actions)', () => {
    const { container } = renderCard({ verification: demoted, line: 12, anchored: true, compact: true })
    const card = container.querySelector('.skill-finding.severity-medium.compact')
    expect(card).toBeTruthy()
    expect(screen.getByText('Consider extracting this into a helper')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add as draft/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })

  it('no verification → equally chip-free', () => {
    const { container } = renderCard({})
    expect(container.querySelector('.skill-verify-chip')).toBeNull()
    expect(container.querySelector('.skill-lower-confidence-chip')).toBeNull()
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
    return vi.fn(async (_q: string, onDelta: (t: string) => void, _focus?: AskFocus) => {
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

// ---------------------------------------------------------------------------
// Convergence: merged multi-reviewer cards + covered-by-draft rendering
// ---------------------------------------------------------------------------

describe('SkillFindingCard — convergence merged card', () => {
  const MERGED_FROM = [
    { reviewer: 'Resiliency & SRE', path: 'src/a.ts', line: 12 as number | null, severity: 'high' as const, body: 'comparing naive datetime raises TypeError\nsecond line' },
  ]

  it('shows all contributing reviewer names (label passed by the parent)', () => {
    renderCard({ skillName: 'UX & Interaction · Resiliency & SRE', mergedFrom: MERGED_FROM })
    expect(screen.getByText('UX & Interaction · Resiliency & SRE')).toBeInTheDocument()
  })

  it('renders an expandable "also flagged as…" disclosure listing each absorbed finding', () => {
    const { container } = renderCard({ mergedFrom: MERGED_FROM, mergedReason: 'same TypeError' })
    const details = container.querySelector('details.merged-from')
    expect(details).toBeTruthy()
    // The cluster reason is surfaced as the disclosure tooltip.
    expect(details?.getAttribute('title')).toBe('same TypeError')
    expect(screen.getByText('also flagged as… (1)')).toBeInTheDocument()
    // Absorbed finding preserved: reviewer + location + ONE-LINE body.
    expect(screen.getByText('Resiliency & SRE')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts:12')).toBeInTheDocument()
    expect(screen.getByText('comparing naive datetime raises TypeError')).toBeInTheDocument()
    expect(screen.queryByText(/second line/)).not.toBeInTheDocument()
  })

  it('renders no disclosure without mergedFrom (unmerged cards unchanged)', () => {
    const { container } = renderCard()
    expect(container.querySelector('details.merged-from')).toBeNull()
  })
})

describe('SkillFindingCard — covered by the user draft (convergence)', () => {
  const COVERED = { path: 'src/a.ts', line: 11 }

  it('renders collapsed/de-emphasized with the covered label; body hidden until expanded', async () => {
    const { container } = renderCard({ coveredByDraft: COVERED })
    const collapsed = container.querySelector('.skill-finding.covered-collapsed')
    expect(collapsed).toBeTruthy()
    expect(screen.getByText(/covered by your comment on src\/a\.ts:11/)).toBeInTheDocument()
    // The finding did NOT vanish — but its body is collapsed away.
    expect(screen.queryByText('Consider extracting this into a helper')).not.toBeInTheDocument()

    // Expanding discloses the full card (body + actions), still marked covered.
    await userEvent.click(screen.getByRole('button', { name: /covered by your comment/i }))
    expect(screen.getByText('Consider extracting this into a helper')).toBeInTheDocument()
    expect(container.querySelector('.skill-finding.covered-by-draft')).toBeTruthy()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()

    // And it can collapse back.
    await userEvent.click(screen.getByRole('button', { name: /collapse this covered finding/i }))
    expect(screen.queryByText('Consider extracting this into a helper')).not.toBeInTheDocument()
  })

  it('keeps the data-finding-key on the collapsed card (jump targets still work)', () => {
    const { container } = renderCard({ coveredByDraft: COVERED, findingKey: 'skill:src/a.ts:10:x' })
    const collapsed = container.querySelector('.skill-finding.covered-collapsed')
    expect(collapsed?.getAttribute('data-finding-key')).toBe('skill:src/a.ts:10:x')
  })
})

describe('SkillFindingCard — re-anchor affordances (drag handle / moved chip / move-to-line)', () => {
  it('drag handle renders when anchorHash is set and the card is not added', () => {
    const { container } = renderCard({ anchorHash: 'abc123' })
    const handle = container.querySelector('[data-testid="finding-drag-handle"]')
    expect(handle).toBeTruthy()
    expect(handle?.getAttribute('draggable')).toBe('true')
  })

  it('no drag handle without an anchorHash (contexts without re-anchor support)', () => {
    const { container } = renderCard()
    expect(container.querySelector('[data-testid="finding-drag-handle"]')).toBeNull()
  })

  it('no drag handle once added as draft (the draft is the user document now)', () => {
    const { container } = renderCard({ anchorHash: 'abc123', added: true })
    expect(container.querySelector('[data-testid="finding-drag-handle"]')).toBeNull()
  })

  it('buttons never carry the draggable attribute (clicks must not fight drags)', () => {
    const { container } = renderCard({ anchorHash: 'abc123', onMoveToLine: () => true })
    for (const btn of container.querySelectorAll('button')) {
      expect(btn.getAttribute('draggable')).not.toBe('true')
    }
  })

  it('moved chip shows the original line and its undo calls onUndoMove', async () => {
    const onUndoMove = vi.fn()
    const { container } = renderCard({ movedFrom: { path: 'src/a.ts', line: 12 }, onUndoMove })
    const chip = container.querySelector('[data-testid="finding-moved-chip"]')
    expect(chip?.textContent).toContain('moved from line 12')
    await userEvent.click(screen.getByRole('button', { name: /undo move — restore line 12/i }))
    expect(onUndoMove).toHaveBeenCalledOnce()
  })

  it('no moved chip without movedFrom', () => {
    const { container } = renderCard({ anchorHash: 'abc123' })
    expect(container.querySelector('[data-testid="finding-moved-chip"]')).toBeNull()
  })

  it('"Move to line…" opens the form; a valid line calls onMoveToLine and closes it', async () => {
    const onMoveToLine = vi.fn().mockReturnValue(true)
    const { container } = renderCard({ onMoveToLine })
    await userEvent.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /target line number/i }), '7')
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(onMoveToLine).toHaveBeenCalledWith(7)
    expect(container.querySelector('[data-testid="finding-move-form"]')).toBeNull()
  })

  it('an invalid line (onMoveToLine → false) shows an inline error; the form stays open', async () => {
    const onMoveToLine = vi.fn().mockReturnValue(false)
    const { container } = renderCard({ onMoveToLine })
    await userEvent.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /target line number/i }), '999')
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('alert').textContent).toContain("line 999 isn't in this diff")
    expect(container.querySelector('[data-testid="finding-move-form"]')).toBeTruthy()
  })

  it('Escape in the line input closes the form without moving', async () => {
    const onMoveToLine = vi.fn().mockReturnValue(true)
    const { container } = renderCard({ onMoveToLine })
    await userEvent.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /target line number/i }), '{Escape}')
    expect(container.querySelector('[data-testid="finding-move-form"]')).toBeNull()
    expect(onMoveToLine).not.toHaveBeenCalled()
  })

  it('no "Move to line…" button once added, or without onMoveToLine', () => {
    renderCard({ onMoveToLine: () => true, added: true })
    expect(screen.queryByRole('button', { name: /move this finding to another diff line/i })).not.toBeInTheDocument()
    renderCard({})
    expect(screen.queryByRole('button', { name: /move this finding to another diff line/i })).not.toBeInTheDocument()
  })

  it('dragstart publishes the anchor hash (dataTransfer + in-flight drag state)', async () => {
    const { container } = renderCard({ anchorHash: 'hash-xyz' })
    const handle = container.querySelector('[data-testid="finding-drag-handle"]')!
    const setData = vi.fn()
    await fireEvent.dragStart(handle, { dataTransfer: { setData, setDragImage: vi.fn(), effectAllowed: 'none' } })
    expect(setData).toHaveBeenCalledWith('application/x-review123-finding', 'hash-xyz')
    expect(reanchorDrag.hash).toBe('hash-xyz')
    await fireEvent.dragEnd(handle)
    expect(reanchorDrag.hash).toBeNull()
  })
})

describe('SkillFindingCard — simplified body (simplify pass)', () => {
  const ORIGINAL = 'It is worth noting a potential inconsistency wherein the `cache` may possibly serve stale entries'
  const SIMPLE = 'The `cache` can serve stale entries — invalidate on write.'

  it('shows the simplified body by default; the original text is not rendered', () => {
    const { container } = renderCard({ body: ORIGINAL, simpleBody: SIMPLE })
    const bodyEl = container.querySelector('.skill-finding-body')!
    expect(bodyEl.textContent).toContain('can serve stale entries')
    expect(bodyEl.textContent).not.toContain('It is worth noting')
  })

  it('"Show original" reveals the raw text; "Show simplified" flips back (per-card toggle)', async () => {
    const { container } = renderCard({ body: ORIGINAL, simpleBody: SIMPLE })
    const toggle = screen.getByTestId('finding-simple-toggle')
    expect(toggle.textContent).toBe('Show original')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(toggle)
    const bodyEl = container.querySelector('.skill-finding-body')!
    expect(bodyEl.textContent).toContain('It is worth noting')
    expect(toggle.textContent).toBe('Show simplified')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(toggle)
    expect(bodyEl.textContent).not.toContain('It is worth noting')
    expect(bodyEl.textContent).toContain('can serve stale entries')
  })

  it('Add as draft passes the DISPLAYED text: simplified by default, original after the toggle', async () => {
    const onAdd = vi.fn()
    renderCard({ body: ORIGINAL, simpleBody: SIMPLE, onAdd })

    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenLastCalledWith(SIMPLE)

    await userEvent.click(screen.getByTestId('finding-simple-toggle'))
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenLastCalledWith(ORIGINAL)
  })

  it('no simpleBody → the original renders and there is NO toggle', () => {
    const { container } = renderCard({ body: ORIGINAL })
    expect(container.querySelector('.skill-finding-body')!.textContent).toContain('It is worth noting')
    expect(screen.queryByTestId('finding-simple-toggle')).toBeNull()
  })

  it('a simpleBody identical to the body → no toggle (nothing to disclose), onAdd gets the body', async () => {
    const onAdd = vi.fn()
    renderCard({ body: 'Short and plain.', simpleBody: 'Short and plain.', onAdd })
    expect(screen.queryByTestId('finding-simple-toggle')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenLastCalledWith('Short and plain.')
  })

  it('markdown in the simplified body still renders (backticks become <code>)', () => {
    const { container } = renderCard({ body: ORIGINAL, simpleBody: SIMPLE })
    const code = container.querySelector('.skill-finding-body code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toBe('cache')
  })
})

// ---------------------------------------------------------------------------
// Fix block (solutions-required pass)
// ---------------------------------------------------------------------------

describe('SkillFindingCard — Fix block (solutions required)', () => {
  it('renders a labeled Fix block below the body when suggestedFix is present', () => {
    renderCard({ suggestedFix: 'Extract the branch into a named helper.' })
    const fix = screen.getByTestId('finding-fix')
    expect(fix).toBeInTheDocument()
    expect(fix.textContent).toContain('Fix')
    expect(fix.textContent).toContain('Extract the branch into a named helper.')
  })

  it('renders NOTHING without a fix — absent and empty alike (old cached findings)', () => {
    renderCard()
    expect(screen.queryByTestId('finding-fix')).toBeNull()
    renderCard({ suggestedFix: '   ' })
    expect(screen.queryByTestId('finding-fix')).toBeNull()
  })

  it('the fix is code-capable markdown: inline code and fenced blocks render', () => {
    const { container } = renderCard({
      suggestedFix: 'Guard the call:\n\n```ts\nif (!user) return\n```\nthen drop the `!` assertion.',
    })
    const fix = container.querySelector('[data-testid="finding-fix"]')!
    const pre = fix.querySelector('pre code')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('if (!user) return')
    const inline = [...fix.querySelectorAll('code')].find((c) => c.textContent === '!')
    expect(inline).toBeTruthy()
    expect(fix.textContent).not.toContain('```')
  })

  it('the honest "No clean fix — tradeoff" form renders in the same block', () => {
    renderCard({ suggestedFix: 'No clean fix — batching adds latency; accept the extra query here.' })
    expect(screen.getByTestId('finding-fix').textContent).toContain('No clean fix —')
  })

  it('Add-as-draft appends the fix to the displayed body', async () => {
    const onAdd = vi.fn()
    renderCard({ body: 'The check is inverted.', suggestedFix: 'Flip the condition to `if (ok)`.', onAdd })
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenLastCalledWith('The check is inverted.\n\n**Fix:** Flip the condition to `if (ok)`.')
  })

  it('Add-as-draft without a fix keeps the plain displayed body (unchanged contract)', async () => {
    const onAdd = vi.fn()
    renderCard({ body: 'The check is inverted.', onAdd })
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenLastCalledWith('The check is inverted.')
  })

  it('composes with the simplify toggle: the fix rides the DISPLAYED body on both sides', async () => {
    const onAdd = vi.fn()
    renderCard({
      body: 'Original wording of the issue.',
      simpleBody: 'Plain wording.',
      suggestedFix: 'Rename `x` to `retryCount`.',
      onAdd,
    })
    // Default: simplified body + fix suffix.
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenLastCalledWith('Plain wording.\n\n**Fix:** Rename `x` to `retryCount`.')
    // The Fix block itself is untouched by the toggle.
    await userEvent.click(screen.getByTestId('finding-simple-toggle'))
    expect(screen.getByTestId('finding-fix').textContent).toContain('Rename')
  })

  it('after "Show original", Add-as-draft carries the original body + fix', async () => {
    const onAdd = vi.fn()
    renderCard({
      body: 'Original wording of the issue.',
      simpleBody: 'Plain wording.',
      suggestedFix: 'Rename `x` to `retryCount`.',
      onAdd,
    })
    await userEvent.click(screen.getByTestId('finding-simple-toggle'))
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAdd).toHaveBeenLastCalledWith('Original wording of the issue.\n\n**Fix:** Rename `x` to `retryCount`.')
  })
})

// ---------------------------------------------------------------------------
// Moot chip (mootness gate — the new secondary reason)
// ---------------------------------------------------------------------------

describe('SkillFindingCard — "judged minor by verification" chip (mootness gate)', () => {
  const verification = (worthFlagging?: boolean) => ({
    confirmedBy: 3,
    polledModels: 3,
    surfaced: true,
    ...(worthFlagging !== undefined ? { worthFlagging } : {}),
    perModel: [],
  })

  it('renders the muted reason chip when the panel judged the finding moot', () => {
    renderCard({ verification: verification(false) })
    const chip = screen.getByTestId('finding-moot-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toBe('judged minor by verification')
  })

  it('renders no chip when judged worth attention, or without worth data (old cache), or unverified', () => {
    renderCard({ verification: verification(true) })
    expect(screen.queryByTestId('finding-moot-chip')).toBeNull()
    renderCard({ verification: verification(undefined) })
    expect(screen.queryByTestId('finding-moot-chip')).toBeNull()
    renderCard()
    expect(screen.queryByTestId('finding-moot-chip')).toBeNull()
  })

  it('a moot majority-verified high shows BOTH the verified chip and the moot chip (honest carve-out)', () => {
    renderCard({ severity: 'high', verification: verification(false) })
    expect(screen.getByText('✓ verified')).toBeInTheDocument()
    expect(screen.getByTestId('finding-moot-chip')).toBeInTheDocument()
  })
})
