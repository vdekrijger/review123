/**
 * FIX 2 reproduction + regression: retried reviewer findings must render inline.
 *
 * The bug: after restarting a reviewer (the #108 retry button → retrySkill →
 * executeSkillReview writes `skillReviewsState[idx] = {...}`), its NEW findings
 * did not appear inline in the diff. Two distinct failure modes:
 *
 *   (a) Reactivity gap — retrySkill mutates ONE array ELEMENT
 *       (`skillReviewsState[idx] = {...}`) instead of replacing the whole array
 *       (the batch run does `skillReviewsState = skills.map(...)`). The inline
 *       findings derive from `skillReviews` through a `$derived.by`, and the
 *       per-element mutation must propagate to that derived / the FileDiff
 *       `skillFindings` prop, exactly like the batch run does.
 *
 *   (b) Stale suppression — a retried finding sharing a key with a previously
 *       DISMISSED finding was filtered out of `lineSkillFindingsByPath`, so the
 *       fresh re-run never showed it. A retry is a fresh run: its findings must
 *       all show, even if a same-keyed finding was dismissed before the retry.
 *
 * We drive the REAL reactivity boundary: a $state-backed reviews array passed as
 * the `skillReviews` prop, mutated element-wise the way retrySkill does, and
 * assert the inline annotation appears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { flushSync } from 'svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

// jsdom has no scrollIntoView — the run-complete auto-scroll effect calls it.
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  localStorage.clear()
})

// New-file line 2 ("line2new") is the anchorable line inside the diff.
const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'
const SKILL_ID = 'rev-retry'

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 1, patch: PATCH }
}

function loadingEntry(): SkillReviewEntry {
  return { skillId: SKILL_ID, name: 'Security', state: { status: 'loading' } }
}

function errorEntry(): SkillReviewEntry {
  return { skillId: SKILL_ID, name: 'Security', state: { status: 'error', error: 'rate-limited' } }
}

function doneEntry(body: string, line: number | null = 2): SkillReviewEntry {
  return {
    skillId: SKILL_ID,
    name: 'Security',
    state: {
      status: 'done',
      value: { skillName: 'Security', findings: [{ path: 'src/foo.ts', line, severity: 'high', body }] },
    },
  }
}

/**
 * A $state-backed reviews array, rendered into InspectStep. Returns a `retry`
 * fn that mutates element [0] EXACTLY like executeSkillReview does
 * (`reviews[0] = doneEntry(...)`), so we exercise the real reactive boundary
 * between the element mutation and InspectStep's `$derived` inline findings.
 */
function renderWithReactiveReviews(initial: SkillReviewEntry, nextOnRetry?: SkillReviewEntry) {
  const reviews = $state<SkillReviewEntry[]>([initial])
  // The error-chip (#108) retry button calls onRetrySkill(skillId); the real
  // AiRun.retrySkill resolves the entry via `skillReviewsState[idx] = {...}`. We
  // mirror that element-wise mutation here.
  const onRetrySkill = (skillId: string) => {
    const idx = reviews.findIndex(e => e.skillId === skillId)
    if (idx !== -1 && nextOnRetry) {
      reviews[idx] = nextOnRetry
      flushSync()
    }
  }
  const result = render(InspectStep, {
    props: {
      files: [makeFile('src/foo.ts')],
      changedFiles: 1,
      mode: 'unified' as const,
      onmode: () => {},
      draftStore: null,
      onRetrySkill,
      get skillReviews() { return reviews },
    },
  })
  // Mutate element-wise — the retrySkill / executeSkillReview pattern.
  const retry = (entry: SkillReviewEntry) => {
    reviews[0] = entry
    flushSync()
  }
  return { ...result, retry }
}

describe('FIX 2 — retried reviewer findings render inline (reactivity)', () => {
  it('reviewer that previously ERRORED shows its retried finding inline', async () => {
    const { container, retry } = renderWithReactiveReviews(errorEntry())
    // Error chip is visible; no inline finding yet.
    expect(container.querySelector('.chip-error')).not.toBeNull()
    expect(container.querySelector('.diff-line-extend .skill-finding')).toBeNull()

    // Retry resolves to a finding on an anchorable line (mutates reviews[0]).
    retry(doneEntry('Newly surfaced after retry', 2))

    await waitFor(() => {
      const inline = container.querySelector('.diff-line-extend .line-findings .skill-finding')
      expect(inline).toBeTruthy()
      expect(inline?.textContent).toContain('Newly surfaced after retry')
    })
  })

  it('reviewer that previously had findings shows the NEW retried finding inline', async () => {
    const { container, retry } = renderWithReactiveReviews(doneEntry('Original finding', 2))
    await waitFor(() => {
      expect(container.querySelector('.line-findings')?.textContent).toContain('Original finding')
    })

    // Retry produces a DIFFERENT finding — the inline view must reflect the new one.
    retry(doneEntry('Replacement finding after retry', 2))

    await waitFor(() => {
      const inline = container.querySelector('.diff-line-extend .line-findings .skill-finding')
      expect(inline?.textContent).toContain('Replacement finding after retry')
      expect(inline?.textContent).not.toContain('Original finding')
    })
  })

  it('loading → done retry surfaces the finding inline (derived recomputes on element reassignment)', async () => {
    const { container, retry } = renderWithReactiveReviews(loadingEntry())
    expect(container.querySelector('.diff-line-extend .skill-finding')).toBeNull()

    retry(doneEntry('Resolved from loading', 2))

    await waitFor(() => {
      expect(container.querySelector('.diff-line-extend .line-findings .skill-finding')?.textContent)
        .toContain('Resolved from loading')
    })
  })
})

describe('FIX 2 — retry after dismiss: a fresh re-run is not pre-suppressed', () => {
  it('the error-chip retry clears this reviewer\'s suppressed keys so a re-surfaced (previously DISMISSED) finding shows', async () => {
    // Same path/line/body across runs → identical finding key. The user dismisses
    // it, the reviewer later errors, then the #108 retry button re-runs it and the
    // SAME finding comes back — it must NOT be pre-suppressed by the stale dismiss.
    const body = 'Recurring finding worth re-surfacing'
    const { container, retry } = renderWithReactiveReviews(
      doneEntry(body, 2),
      // Retry resolves the reviewer back to done with the SAME finding (same key).
      doneEntry(body, 2),
    )

    await waitFor(() => {
      expect(screen.getByText(body)).toBeInTheDocument()
    })

    // Dismiss it (session-only suppression keyed by the finding key).
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText(body)).not.toBeInTheDocument()
    })

    // The reviewer then errors → the #108 retry button appears.
    retry(errorEntry())
    await waitFor(() => {
      expect(container.querySelector('.chip-error')).not.toBeNull()
    })

    // Click Retry — this clears the reviewer's suppressed keys, then re-runs it.
    await userEvent.click(screen.getByRole('button', { name: /retry security/i }))

    await waitFor(() => {
      const inline = container.querySelector('.diff-line-extend .line-findings .skill-finding')
      expect(inline?.textContent).toContain(body)
    })
  })

  it('clears InspectStep-level dismiss (fallback/off-diff finding) on the error-chip retry', async () => {
    // An off-diff (line 999) finding renders in the per-file fallback block whose
    // Dismiss wires InspectStep's own `dismissedKeys`. Retry must clear it too.
    const body = 'Off-diff finding that recurs'
    const { container, retry } = renderWithReactiveReviews(
      doneEntry(body, 999),
      doneEntry(body, 999),
    )

    await waitFor(() => {
      expect(screen.getByText(body)).toBeInTheDocument()
    })
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText(body)).not.toBeInTheDocument()
    })

    retry(errorEntry())
    await waitFor(() => expect(container.querySelector('.chip-error')).not.toBeNull())

    await userEvent.click(screen.getByRole('button', { name: /retry security/i }))
    await waitFor(() => {
      expect(container.querySelector('.skill-findings-annotations')?.textContent).toContain(body)
    })
  })
})
