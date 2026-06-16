/**
 * Regression: dismissals (and added-as-draft → 'accepted') survive a full page
 * RELOAD, not just slide-nav.
 *
 * The bug: InspectStep's suppression sets (dismissedKeys / addedDraftKeys) were
 * session-only $state, never seeded from the durable IndexedDB decision store.
 * After a reload they started empty, so a previously dismissed finding reappeared.
 *
 * The fix: on mount InspectStep awaits decisionStore.load() and SEEDS the
 * suppression sets from the stored decisions — 'dismissed' → dismissedKeys,
 * 'accepted' → addedDraftKeys — so the derived finding filters hide them.
 *
 * We test at InspectStep level with a REAL createDecisionStore on fake-indexeddb,
 * pre-seeded the way a prior session would have left it. The finding KEY format is
 * `${skillId}:${path}:${line}:${body.slice(0,30)}` — the SAME key the store records.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import { createDecisionStore, type DecisionVerificationContext } from '../lib/eval/decisions'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import 'fake-indexeddb/auto'

// Canvas stub for DiffView in jsdom
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
    writable: true,
  })
})

// New-file line 2 ("line2new") is the anchorable line inside the diff.
const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'
const SKILL_ID = 'rev-persist'
const PATH = 'src/foo.ts'

function makeFile(): PrFile {
  return { filename: PATH, status: 'modified', additions: 1, deletions: 1, patch: PATCH }
}

const ctx: DecisionVerificationContext = {
  deep: false,
  crossVerified: false,
  confirmedBy: 0,
  polledModels: 0,
  raisedByCount: 0,
}

const BODY_DISMISSED = 'Dismissed last session — must stay hidden'
const BODY_ACCEPTED = 'Added as draft last session — must stay hidden'
const BODY_LIVE = 'Never decided — must still show'

/** The finding key InspectStep computes for a finding on this skill/path/line. */
function findingKey(line: number, body: string): string {
  return `${SKILL_ID}:${PATH}:${line}:${body.slice(0, 30)}`
}

function doneReview(): SkillReviewEntry {
  return {
    skillId: SKILL_ID,
    name: 'Security',
    state: {
      status: 'done',
      value: {
        skillName: 'Security',
        findings: [
          { path: PATH, line: 2, severity: 'high', body: BODY_DISMISSED },
          { path: PATH, line: 2, severity: 'high', body: BODY_ACCEPTED },
          { path: PATH, line: 2, severity: 'high', body: BODY_LIVE },
        ],
      },
    },
  }
}

describe('Dismissals persist across a full reload (decision-store seed)', () => {
  it('seeds dismissed + accepted findings as hidden on mount; an undecided finding still shows', async () => {
    // A prior session's store: one dismissed finding, one accepted (added-as-draft).
    const prKey = `github:o/r#1@${Date.now()}`
    const db = `review123-decisions-test-${Date.now()}`
    const store = createDecisionStore(prKey, db)
    await store.load()
    await store.record({
      findingKey: findingKey(2, BODY_DISMISSED),
      decision: 'dismissed',
      severity: 'high',
      verificationContext: ctx,
    })
    await store.record({
      findingKey: findingKey(2, BODY_ACCEPTED),
      decision: 'accepted',
      severity: 'high',
      verificationContext: ctx,
    })

    // Fresh store instance for the "reloaded" page — same prKey + db.
    const reloaded = createDecisionStore(prKey, db)

    render(InspectStep, {
      props: {
        files: [makeFile()],
        changedFiles: 1,
        mode: 'unified' as const,
        onmode: () => {},
        draftStore: null,
        decisionStore: reloaded,
        skillReviews: [doneReview()],
      },
    })

    // The undecided finding renders inline...
    await waitFor(() => {
      expect(screen.getByText(BODY_LIVE)).toBeInTheDocument()
    })

    // ...and the seeded dismissed + accepted findings are hidden once the async
    // seed completes (the derived filters re-run when the sets update).
    await waitFor(() => {
      expect(screen.queryByText(BODY_DISMISSED)).not.toBeInTheDocument()
      expect(screen.queryByText(BODY_ACCEPTED)).not.toBeInTheDocument()
    })
    // The live finding remains visible alongside the hidden ones.
    expect(screen.getByText(BODY_LIVE)).toBeInTheDocument()
  })
})
