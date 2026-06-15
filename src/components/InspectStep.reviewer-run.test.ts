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
    const btn = screen.getByRole('button', { name: 'Retry Security Reviewer' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('title', 'Click to retry')
  })

  it('clicking the error chip calls onRetrySkill with that reviewer\'s skillId', async () => {
    const onRetrySkill = vi.fn()
    render(InspectStep, {
      props: baseProps({
        skillReviews: [errorEntry('skill-77', 'Security Reviewer'), doneEntry('skill-ok', 'Perf Reviewer', [])],
        onRetrySkill,
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Retry Security Reviewer' }))
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
    expect(screen.getAllByRole('button', { name: /^Retry / })).toHaveLength(1)
    // The done sibling still shows its result chip.
    expect(screen.getByText(/no significant issues/i)).toBeInTheDocument()
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
