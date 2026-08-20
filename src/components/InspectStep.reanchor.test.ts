/**
 * InspectStep — finding re-anchor integration:
 *
 *  - "Add as draft" on a re-anchored (moved) finding APPENDS a draft at the
 *    CORRECTED line via the store's n:-1 sentinel (the #213 multi-draft path),
 *    so dropping onto a line that already has comments coexists — never
 *    clobbers.
 *  - Orphan pruning: once a reviewer has settled, stored overrides whose
 *    finding no longer exists in the run results are dropped; live ones kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import type { createDraftStore } from '../lib/drafts/drafts.svelte'
import {
  findingAnchorHash,
  getAnchorOverride,
  setAnchorOverride,
  _resetReanchorForTest,
} from '../lib/findings/reanchor.svelte'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  _resetReanchorForTest()
})

// New-file lines: 1 "line1" (ctx), 2 "line2new" (+), 3 "line3" (ctx)
const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'

const FILE: PrFile = { filename: 'src/foo.ts', status: 'modified', additions: 1, deletions: 1, patch: PATCH }

const FINDING = { path: 'src/foo.ts', line: 2, severity: 'high' as const, body: 'Wrong-line finding body' }
// MUST mirror InspectStep's key construction: `${skillId}:${path}:${line}:${body.slice(0, 30)}`
const FINDING_KEY = `skill-line:${FINDING.path}:${FINDING.line}:${FINDING.body.slice(0, 30)}`
const FINDING_HASH = findingAnchorHash({ key: FINDING_KEY, path: FINDING.path, line: FINDING.line, body: FINDING.body })

function makeReview(): SkillReviewEntry {
  return {
    skillId: 'skill-line',
    name: 'Security',
    state: { status: 'done', value: { skillName: 'Security', findings: [FINDING] } },
  }
}

function makeDraftStore(): ReturnType<typeof createDraftStore> {
  const upsert = vi.fn().mockResolvedValue(undefined)
  return {
    get drafts() { return [] },
    get count() { return 0 },
    get persistent() { return false },
    upsert,
    remove: vi.fn(),
    clearAll: vi.fn(),
    load: vi.fn(),
    draftsAt: vi.fn().mockReturnValue([]),
  }
}

function renderInspect(draftStore: ReturnType<typeof createDraftStore>) {
  return render(InspectStep, {
    props: {
      files: [FILE],
      changedFiles: 1,
      mode: 'unified' as const,
      onmode: () => {},
      draftStore,
      skillReviews: [makeReview()],
    },
  })
}

describe('InspectStep re-anchor — Add as draft appends at the corrected line', () => {
  it('moved finding → upsert at the NEW line with the n:-1 append sentinel (never clobbers)', async () => {
    const user = userEvent.setup()
    setAnchorOverride(FINDING_HASH, { path: FILE.filename, line: 3, side: 'RIGHT' })
    const draftStore = makeDraftStore()
    const { container } = renderInspect(draftStore)

    // The card renders at the corrected line…
    expect(container.querySelector('[data-line-findings="3"]')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /add as draft comment/i }))

    // …and the draft is APPENDED there (multi-draft #213 path: n === -1).
    expect(draftStore.upsert).toHaveBeenCalledTimes(1)
    expect(draftStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/foo.ts', line: 3, side: 'RIGHT', n: -1, aiAuthored: true }),
    )
  })

  it('un-moved finding still appends at its reported line (regression guard)', async () => {
    const user = userEvent.setup()
    const draftStore = makeDraftStore()
    renderInspect(draftStore)
    await user.click(screen.getByRole('button', { name: /add as draft comment/i }))
    expect(draftStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/foo.ts', line: 2, side: 'RIGHT', n: -1 }),
    )
  })
})

describe('InspectStep re-anchor — orphan override pruning', () => {
  it('an override for a finding that no longer exists is pruned once a reviewer settles', async () => {
    setAnchorOverride('stale-hash-of-removed-finding', { path: FILE.filename, line: 3, side: 'RIGHT' })
    setAnchorOverride(FINDING_HASH, { path: FILE.filename, line: 3, side: 'RIGHT' })
    renderInspect(makeDraftStore())
    await waitFor(() => {
      expect(getAnchorOverride('stale-hash-of-removed-finding')).toBeNull()
    })
    // The LIVE finding's override survives.
    expect(getAnchorOverride(FINDING_HASH)).not.toBeNull()
  })
})
