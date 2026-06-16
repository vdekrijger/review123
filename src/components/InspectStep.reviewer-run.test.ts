/**
 * Tests for the reorganized "Run my reviewers" run area (InspectStep):
 *
 *  PROBLEM 1 — bounded, aligned loading layout. Running reviewers render as a
 *  compact ONE-LINE-PER-REVIEWER list: a spinner + the reviewer NAME + (deep
 *  mode) ONLY the latest activity line (truncated) — NOT N full scrolling logs.
 *  A single global "Running… (N)" indicator heads the block.
 *
 *  PROBLEM 2 — a failed reviewer's "↻ error" chip is a real Retry BUTTON
 *  (aria-label "Retry {name}") that re-invokes JUST that reviewer via the
 *  onRetrySkill prop, without disturbing sibling entries.
 *
 *  DONE state — result chips (findings / no-issues + tokens) still render.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFiles(names: string[]): PrFile[] {
  return names.map(filename => ({
    filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH,
  }))
}

function loadingEntry(id: string, name: string, activity?: string[]): SkillReviewEntry {
  return {
    skillId: id,
    name,
    state: { status: 'loading', ...(activity ? { activity } : {}) },
  }
}

function errorEntry(id: string, name: string): SkillReviewEntry {
  return { skillId: id, name, state: { status: 'error', error: 'Rate limited.' } }
}

function queuedEntry(id: string, name: string): SkillReviewEntry {
  return { skillId: id, name, state: { status: 'queued' } }
}

function doneEntry(id: string, name: string, findings: Array<{ path: string; line: number | null; severity: 'high' | 'medium' | 'low'; body: string }>): SkillReviewEntry {
  return {
    skillId: id,
    name,
    state: { status: 'done', value: { skillName: name, findings } },
  }
}

function baseProps(extra: Record<string, unknown>) {
  return {
    files: makeFiles(['src/foo.ts']),
    changedFiles: 1,
    mode: 'unified' as const,
    onmode: () => {},
    draftStore: null,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// PROBLEM 1 — compact, bounded, aligned loading layout
// ---------------------------------------------------------------------------

describe('InspectStep — compact reviewer loading layout', () => {
  it('shows a single global "Running… (N)" indicator with the in-flight count', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [
          loadingEntry('a', 'Reviewer A'),
          loadingEntry('b', 'Reviewer B'),
          loadingEntry('c', 'Reviewer C'),
        ],
      }),
    })
    expect(screen.getByText(/Running…\s*\(3\)/)).toBeInTheDocument()
  })

  it('renders ONE compact row per running reviewer (name visible)', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [loadingEntry('a', 'Security Reviewer'), loadingEntry('b', 'Perf Reviewer')],
      }),
    })
    const region = screen.getByLabelText('Reviewers running')
    expect(within(region).getByText('Security Reviewer')).toBeInTheDocument()
    expect(within(region).getByText('Perf Reviewer')).toBeInTheDocument()
    // One list item per running reviewer
    expect(within(region).getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows ONLY the latest activity line per row (not the full scrolling log)', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [
          loadingEntry('a', 'Reviewer A', ['Reading foo.py…', 'Searching: handler', 'Reading bar.py…']),
        ],
      }),
    })
    const region = screen.getByLabelText('Reviewers running')
    // Latest line shown
    expect(within(region).getByText('Reading bar.py…')).toBeInTheDocument()
    // Earlier lines are NOT rendered by default (collapsed)
    expect(within(region).queryByText('Reading foo.py…')).not.toBeInTheDocument()
    expect(within(region).queryByText('Searching: handler')).not.toBeInTheDocument()
  })

  it('lets a single reviewer expand to its full activity log on demand', async () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [
          loadingEntry('a', 'Reviewer A', ['Reading foo.py…', 'Searching: handler', 'Reading bar.py…']),
        ],
      }),
    })
    const region = screen.getByLabelText('Reviewers running')
    await userEvent.click(within(region).getByRole('button', { name: /expand reviewer a activity/i }))
    // Now all lines render
    expect(within(region).getByText('Reading foo.py…')).toBeInTheDocument()
    expect(within(region).getByText('Searching: handler')).toBeInTheDocument()
    expect(within(region).getByText('Reading bar.py…')).toBeInTheDocument()
  })

  it('does not render a full multi-line AiProgress block per running reviewer', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [
          loadingEntry('a', 'Reviewer A', ['line 1', 'line 2', 'line 3']),
          loadingEntry('b', 'Reviewer B', ['line A', 'line B', 'line C']),
        ],
      }),
    })
    // No per-reviewer "Running {name}…" status lines (that was the old AiProgress
    // block). The compact layout has ONE global header instead.
    expect(screen.queryByText('Running Reviewer A…')).not.toBeInTheDocument()
    expect(screen.queryByText('Running Reviewer B…')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// FEATURE A — queued reviewers render in a Waiting region (not settled)
// ---------------------------------------------------------------------------

describe('InspectStep — queued reviewers (Waiting region)', () => {
  it('renders queued entries in a "Waiting (N)" region, not the results bar', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [
          loadingEntry('a', 'Reviewer A'),
          loadingEntry('b', 'Reviewer B'),
          queuedEntry('c', 'Reviewer C'),
          queuedEntry('d', 'Reviewer D'),
        ],
      }),
    })
    const waiting = screen.getByLabelText('Reviewers waiting')
    expect(within(waiting).getByText(/Waiting\s*\(2\)/)).toBeInTheDocument()
    // Queued reviewer names live in the waiting region.
    expect(within(waiting).getByText('Reviewer C')).toBeInTheDocument()
    expect(within(waiting).getByText('Reviewer D')).toBeInTheDocument()
    // The running region shows only the 2 in-flight reviewers.
    expect(screen.getByText(/Running…\s*\(2\)/)).toBeInTheDocument()
    // No settled results bar yet (nothing is done/error).
    expect(screen.queryByLabelText('Reviewer run results')).not.toBeInTheDocument()
  })

  it('a queued entry shows a spinner-free "queued" chip (it has not started)', () => {
    const { container } = render(InspectStep, {
      props: baseProps({
        skillReviews: [queuedEntry('a', 'Reviewer A')],
      }),
    })
    const waiting = screen.getByLabelText('Reviewers waiting')
    expect(within(waiting).getByText('queued')).toBeInTheDocument()
    // No spinner inside the waiting region (queued ≠ running).
    expect(waiting.querySelector('.spinner, [class*="spinner"]')).toBeNull()
    expect(container.querySelector('.chip-queued')).not.toBeNull()
  })

  it('a reviewer moves from Waiting to Running when it flips queued → loading', async () => {
    const { rerender } = render(InspectStep, {
      props: baseProps({
        skillReviews: [loadingEntry('a', 'Reviewer A'), queuedEntry('b', 'Reviewer B')],
      }),
    })
    // Initially B is waiting.
    expect(within(screen.getByLabelText('Reviewers waiting')).getByText('Reviewer B')).toBeInTheDocument()

    // A slot frees: B flips to loading.
    await rerender(baseProps({
      skillReviews: [loadingEntry('a', 'Reviewer A'), loadingEntry('b', 'Reviewer B')],
    }))

    // No more waiting region; B is now in the running region.
    expect(screen.queryByLabelText('Reviewers waiting')).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Reviewers running')).getByText('Reviewer B')).toBeInTheDocument()
    expect(screen.getByText(/Running…\s*\(2\)/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// PROBLEM 2 — error chip is a Retry button
// ---------------------------------------------------------------------------

describe('InspectStep — per-reviewer retry', () => {
  it('renders the error chip as a Retry button with an aria-label naming the reviewer', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [errorEntry('a', 'Security Reviewer')],
        onRetrySkill: vi.fn(),
      }),
    })
    // The error chip surfaces the humanized failure reason on hover/focus: its
    // title is "{error} — click to retry" and the aria-label includes the error
    // so keyboard/screen-reader users reach it too.
    const btn = screen.getByRole('button', { name: /Security Reviewer failed: Rate limited\. — click to retry/i })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('title', 'Rate limited. — click to retry')
  })

  it('clicking the error chip calls onRetrySkill with that reviewer\'s skillId', async () => {
    const onRetrySkill = vi.fn()
    render(InspectStep, {
      props: baseProps({
        skillReviews: [errorEntry('skill-77', 'Security Reviewer'), doneEntry('skill-ok', 'Perf Reviewer', [])],
        onRetrySkill,
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: /Security Reviewer failed:.*click to retry/i }))
    expect(onRetrySkill).toHaveBeenCalledExactlyOnceWith('skill-77')
  })

  it('retrying does not touch sibling entries (only the errored one is a button)', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [
          errorEntry('a', 'Failed One'),
          doneEntry('b', 'Clean One', []),
        ],
        onRetrySkill: vi.fn(),
      }),
    })
    // Only the errored reviewer is rendered as a retry button.
    expect(screen.getAllByRole('button', { name: /click to retry/i })).toHaveLength(1)
    // The done sibling still shows its result chip.
    expect(screen.getByText(/no significant issues/i)).toBeInTheDocument()
  })

  it('surfaces the failure reason on hover (title) and in the accessible name, and still retries on click', async () => {
    const onRetrySkill = vi.fn()
    render(InspectStep, {
      props: baseProps({
        skillReviews: [errorEntry('skill-9', 'Security Reviewer')],
        onRetrySkill,
      }),
    })
    const btn = screen.getByRole('button', { name: /Security Reviewer failed: Rate limited\./i })
    // Hover tooltip surfaces the error + the retry affordance.
    expect(btn).toHaveAttribute('title', 'Rate limited. — click to retry')
    // The error text is also reachable by keyboard/screen reader (aria-label).
    expect(btn.getAttribute('aria-label')).toContain('Rate limited.')
    // Clicking still retries this reviewer.
    await userEvent.click(btn)
    expect(onRetrySkill).toHaveBeenCalledExactlyOnceWith('skill-9')
  })

  it('falls back to "Click to retry" when the error reason is empty', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [{ skillId: 'a', name: 'Security Reviewer', state: { status: 'error' } }],
        onRetrySkill: vi.fn(),
      }),
    })
    const btn = screen.getByRole('button', { name: 'Retry Security Reviewer' })
    expect(btn).toHaveAttribute('title', 'Click to retry')
  })

  it('without onRetrySkill the error chip is a non-interactive span (no button)', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [errorEntry('a', 'Security Reviewer')],
        // onRetrySkill omitted
      }),
    })
    expect(screen.queryByRole('button', { name: /^Retry / })).not.toBeInTheDocument()
    expect(screen.getByText('↻ error')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// DONE state chips still render
// ---------------------------------------------------------------------------

describe('InspectStep — settled result chips', () => {
  it('renders a findings count chip for a reviewer with findings', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [doneEntry('a', 'Security Reviewer', [
          { path: 'src/foo.ts', line: 2, severity: 'high', body: 'XSS' },
        ])],
      }),
    })
    // The done chip is now a navigation button (jumps to the finding); its
    // accessible name is "Show {N} finding(s) from {reviewer}", and it shows the
    // finding count text.
    const chip = screen.getByRole('button', { name: 'Show 1 finding from Security Reviewer' })
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveTextContent('✓ 1 finding')
  })

  it('renders the no-issues chip for a clean reviewer', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [doneEntry('a', 'Security Reviewer', [])],
      }),
    })
    expect(screen.getByLabelText('Done, no significant issues')).toBeInTheDocument()
  })

  it('running and settled reviewers coexist (running region + results bar)', () => {
    render(InspectStep, {
      props: baseProps({
        skillReviews: [
          loadingEntry('a', 'Still Going'),
          doneEntry('b', 'Done One', []),
          errorEntry('c', 'Broke One'),
        ],
        onRetrySkill: vi.fn(),
      }),
    })
    expect(screen.getByLabelText('Reviewers running')).toBeInTheDocument()
    expect(screen.getByLabelText('Reviewer run results')).toBeInTheDocument()
    expect(screen.getByText(/Running…\s*\(1\)/)).toBeInTheDocument()
  })
})
