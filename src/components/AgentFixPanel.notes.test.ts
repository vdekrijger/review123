/**
 * AgentFixPanel — the reviewer's OWN drafted notes.
 *
 * The workflow this app is built around has eight steps. Steps 5 and 7 —
 * "address what I found when I read the code / the tests myself" — had no
 * surface: the panel could send a model's findings and (since #282) a bot's
 * comments, and not one word the reviewer wrote.
 *
 * What these tests pin is the part that is easy to get subtly wrong:
 *
 *   - whose words are being sent is answerable at a glance, and stays that way
 *     when all three kinds go out in one run;
 *   - the note travels as the reviewer's DIRECTION, in `body`, with this repo's
 *     own constant in the imperative slot — never a synthesised suggestedFix;
 *   - the note's fate is ASKED, never assumed. The default posts it unchanged,
 *     withdrawing does not delete it, and the way back is on the same row —
 *     including when the withdrawal happened while the result was on screen;
 *   - a rejected change moves nothing about the note.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AgentFixPanel, { type FixCandidateEntry } from './AgentFixPanel.svelte'
import { _setCaptureForTest } from '../lib/analytics/analytics'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetStackForTest } from '../lib/bridge/runPr.svelte'
import { _resetFixTestFactForTest } from '../lib/bridge/fixTestFact.svelte'
import { BRIDGE_STORAGE_KEY } from '../lib/bridge/storage'
import { PROTOCOL_VERSION, type BridgeFixFinding } from '../lib/bridge/protocol'
import {
  DRAFT_NOTE_SUGGESTED_FIX,
  intakeDraftNotes,
  withdrawnNotes,
  type DraftNoteCandidate,
  type WithdrawnNote,
} from '../lib/bridge/draftComments'
import { BOT_COMMENT_SUGGESTED_FIX, intakeBotComments } from '../lib/bridge/botComments'
import type { BotCommentIntake } from '../lib/bridge/botComments'
import type { Draft } from '../lib/drafts/drafts.svelte'
import type { PrComment } from '../lib/github/comments'

const HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const hoisted = vi.hoisted(() => ({ botIntake: null as BotCommentIntake | null }))

vi.mock('../lib/ai/fixVerifyRun', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ai/fixVerifyRun')>()
  return {
    ...actual,
    verifyAgentFixDetailed: async (_head: string, changes: readonly { findingId: string }[]) => ({
      report: {
        byFinding: changes.map((c) => ({
          findingId: c.findingId,
          persona: 'Your own note',
          outcome: 'not-raised-again' as const,
          votes: [],
          polledModels: 2,
          agreeing: 2,
        })),
        newProblems: [],
        witnesses: ['P · m1'],
        calls: 1,
        failedCalls: 0,
      },
      cached: false,
      durationMs: 5,
    }),
  }
})

vi.mock('../lib/bridge/botComments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bridge/botComments')>()
  return { ...actual, loadBotComments: async () => hoisted.botIntake }
})

const fetchMock = vi.fn()
const captured: { event: string; props: Record<string, unknown> }[] = []
/** Every finding batch the bridge was actually sent, in order. */
const sentBatches: BridgeFixFinding[][] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function connectReadyBridge(): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    json({
      ok: true,
      protocol: PROTOCOL_VERSION,
      root: 'review123',
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, fix: true },
      git: { head: HEAD, branch: 'feat/x', dirty: false },
      version: '0.1.0',
    }),
  )
  await connectBridge(TOKEN, 7321)
}

function stackBody(): unknown {
  return {
    ok: true,
    git: { head: HEAD, branch: 'feat/x', dirty: false },
    dirtyPaths: [],
    dirtyCount: 0,
    prior: null,
    app: { url: null, source: 'unknown', reachable: false, detail: '' },
    checkoutEnabled: false,
  }
}

/** Echo every id it is sent back as one green commit each. */
function echoFix(_url: string, init: RequestInit): Response {
  const sent = JSON.parse(String(init.body)) as { findings: BridgeFixFinding[] }
  sentBatches.push(sent.findings)
  return json({
    ok: true,
    cli: 'claude',
    baseSha: HEAD,
    branch: 'review123/fix/abc',
    changes: sent.findings.map((f, i) => ({
      findingId: f.id,
      commit: String(i + 1).repeat(40).slice(0, 40),
      subject: 's',
      intent: `Agent intent for ${f.id}`,
      files: [f.path],
      diff: `--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n-a\n+b\n`,
      truncated: false,
      rounds: 1,
      stopReason: 'all-addressed',
      tests: { status: 'passed', command: 'pnpm test', durationMs: 9, output: 'ok' },
    })),
    skipped: [],
    rounds: 1,
    stopReason: 'all-addressed',
    tests: null,
    durationMs: 100,
  })
}

const PR = 'github:o/r#7'
const FILES = [{ filename: 'src/render.ts' }]

function draft(over: Partial<Draft> = {}): Draft {
  return {
    prKey: PR,
    path: 'src/render.ts',
    line: 42,
    side: 'RIGHT',
    body: 'Use a Map here — this linear scan runs inside the render loop.',
    n: 0,
    ...over,
  }
}

function notesFor(drafts: Draft[], head = HEAD): DraftNoteCandidate[] {
  return intakeDraftNotes(drafts, FILES, head).offered
}

function candidate(key: string): FixCandidateEntry {
  return {
    key,
    skillName: 'Security Reviewer',
    path: 'src/secret.ts',
    line: 12,
    severity: 'high',
    body: 'Unescaped user input reaches the DOM',
    suggestedFix: 'Escape it with textContent.',
  }
}

function botComment(): PrComment {
  return {
    id: 101,
    author: 'greptile-apps[bot]',
    authorAvatar: null,
    body: 'This loop is quadratic.',
    createdAt: '2026-09-01T10:00:00Z',
    path: 'src/render.ts',
    line: 7,
    side: 'RIGHT',
    inReplyTo: null,
    url: null,
  } as unknown as PrComment
}

/**
 * Render the panel with a note-handoff sink that behaves the way the draft
 * store does: a decision is recorded, a withdrawn note leaves the offered list
 * and joins the withdrawn one, and the panel is handed the new props — which is
 * exactly what InspectStep's derived chain does against the real store.
 */
function renderWithNotes(opts: {
  drafts?: Draft[]
  candidates?: FixCandidateEntry[]
  head?: string
}) {
  const state = new Map<string, Draft>()

  function storeKey(d: Draft): string {
    return `${d.prKey}|${d.path}|${d.line}|${d.side}|${d.n ?? 0}`
  }

  for (const d of opts.drafts ?? []) state.set(storeKey(d), { ...d })

  let rerender: ((props: Record<string, unknown>) => unknown) | null = null

  function props(): Record<string, unknown> {
    const drafts = [...state.values()]
    return {
      headSha: HEAD,
      candidates: opts.candidates ?? [],
      draftNotes: notesFor(drafts, opts.head),
      withdrawn: withdrawnNotes(drafts) as WithdrawnNote[],
      draftNoteRefusals: [],
      onNoteHandoff: (draftKey: string, handoff: Draft['handoff']) => {
        for (const [k, d] of state) {
          if (storeKey(d) === draftKey) state.set(k, { ...d, handoff })
        }
        rerender?.(props())
      },
      onNotesSent: (keys: string[]) => {
        for (const [k, d] of state) {
          if (d.handoff === undefined && keys.includes(storeKey(d))) {
            state.set(k, { ...d, handoff: 'sent' })
          }
        }
        rerender?.(props())
      },
    }
  }

  const result = render(AgentFixPanel, props() as never)
  rerender = result.rerender as never
  return { state }
}

beforeEach(() => {
  localStorage.clear()
  captured.length = 0
  sentBatches.length = 0
  hoisted.botIntake = null
  _resetBridgeForTest()
  _resetStackForTest()
  _resetFixTestFactForTest()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    const target = String(url)
    if (target.endsWith('/v1/stack')) return Promise.resolve(json(stackBody()))
    return Promise.resolve(echoFix(target, init))
  })
  vi.stubGlobal('fetch', fetchMock)
  _setCaptureForTest((event, props) => captured.push({ event, props }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
})

/** Rendered text with template line breaks collapsed, so copy can be wrapped. */
function flat(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function eventsNamed(name: string): Record<string, unknown>[] {
  return captured.filter((c) => c.event === name).map((c) => c.props)
}

// ---------------------------------------------------------------------------
// Whose words are being sent
// ---------------------------------------------------------------------------

describe('the reviewer’s own notes in the panel', () => {
  it('lists them separately from the AI’s findings, and opens the panel on their own', async () => {
    await connectReadyBridge()
    renderWithNotes({ drafts: [draft()] })

    // With no AI finding at all the panel still appears: a reviewer with notes
    // and no model findings is the whole point of steps 5 and 7.
    await screen.findByTestId('agent-fix-panel')
    expect(screen.getByTestId('agent-fix-notes')).toBeTruthy()
    expect(screen.queryByTestId('agent-fix-count')).toBeNull()

    const rows = screen.getAllByTestId('agent-fix-note-candidate')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('your note')).toBeTruthy()
    expect(rows[0].textContent).toContain('src/render.ts:42')
    expect(rows[0].textContent).toContain('Use a Map here')
  })

  it('leaves them UNTICKED — not every note is a request', async () => {
    await connectReadyBridge()
    renderWithNotes({ drafts: [draft(), draft({ line: 9 })] })

    expect(flat(screen.getByTestId('agent-fix-notes-count'))).toMatch(/0 of 2 of your own notes selected/)
    for (const box of screen.getAllByTestId('agent-fix-note-checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false)
    }
    // And the send button does not pick them up until asked.
    expect((screen.getByTestId('agent-fix-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('counts the AI findings on their own line, not muddled with the notes', async () => {
    await connectReadyBridge()
    renderWithNotes({ drafts: [draft()], candidates: [candidate('f1'), candidate('f2')] })

    expect(flat(screen.getByTestId('agent-fix-count'))).toMatch(/2 of 2 selected/)
    await userEvent.click(screen.getAllByTestId('agent-fix-note-checkbox')[0])
    expect(flat(screen.getByTestId('agent-fix-count'))).toMatch(/2 of 2 selected/)
    expect(flat(screen.getByTestId('agent-fix-notes-count'))).toMatch(/1 of 1/)
  })

  it('labels a note written on an earlier commit, in the row AND in the quote', async () => {
    await connectReadyBridge()
    const older = 'def4567890abcdef1234567890abcdef12345678'
    renderWithNotes({ drafts: [draft({ headSha: older })] })

    expect(screen.getByTestId('agent-fix-note-moved').textContent).toContain(older.slice(0, 7))

    await userEvent.click(screen.getByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    expect(sentBatches[0][0].body).toMatch(/line number may have moved/)
  })
})

// ---------------------------------------------------------------------------
// What actually goes over the wire
// ---------------------------------------------------------------------------

describe('a note on the wire', () => {
  it('sends the reviewer’s words as their direction, with no synthesised fix', async () => {
    await connectReadyBridge()
    renderWithNotes({ drafts: [draft()] })

    await userEvent.click(screen.getByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    expect(sentBatches).toHaveLength(1)
    const [wire] = sentBatches[0]
    expect(wire.body).toContain('Use a Map here')
    expect(wire.body).toMatch(/REVIEWER'S OWN NOTE/)
    expect(wire.suggestedFix).toBe(DRAFT_NOTE_SUGGESTED_FIX)
    expect(wire.suggestedFix).not.toContain('Use a Map here')
    expect(wire.path).toBe('src/render.ts')
    expect(wire.line).toBe(42)
  })

  it('carries a note, an AI finding and a bot comment in ONE run, each labelled', async () => {
    await connectReadyBridge()
    hoisted.botIntake = intakeBotComments([botComment()], new Set())
    renderWithNotes({ drafts: [draft()], candidates: [candidate('f1')] })

    await userEvent.click(screen.getByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-bots-load'))
    await userEvent.click(await screen.findByTestId('agent-fix-bot-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findAllByTestId('agent-fix-result')

    const batch = sentBatches[0]
    expect(batch).toHaveLength(3)
    const note = batch.find((f) => f.id.startsWith('draft-note:'))!
    const bot = batch.find((f) => f.id.startsWith('bot-comment:'))!
    const finding = batch.find((f) => f.id === 'f1')!

    // Three sources, three different things said to the agent about authority.
    expect(note.suggestedFix).toBe(DRAFT_NOTE_SUGGESTED_FIX)
    expect(bot.suggestedFix).toBe(BOT_COMMENT_SUGGESTED_FIX)
    expect(finding.suggestedFix).toBe('Escape it with textContent.')
    expect(note.body).toMatch(/REVIEWER'S OWN NOTE/)
    expect(bot.body).toMatch(/THIRD-PARTY DATA/)

    // And the results say whose each one was, rather than one anonymous list.
    const reviewers = screen.getAllByTestId('agent-fix-result').map((el) => el.textContent ?? '')
    expect(reviewers.some((t) => t.includes('Your own note'))).toBe(true)
    expect(reviewers.some((t) => t.includes('Security Reviewer'))).toBe(true)
    expect(reviewers.some((t) => t.includes('Standing in for greptile-apps[bot]'))).toBe(true)
  })

  it('reports how many of the batch were the reviewer’s own, as a count', async () => {
    await connectReadyBridge()
    renderWithNotes({ drafts: [draft(), draft({ line: 9 })], candidates: [candidate('f1')] })

    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')
    expect(eventsNamed('bridge_fix_dispatched')[0]).toMatchObject({ findings: 1, notes: 0 })

    captured.length = 0
    await userEvent.click(screen.getByTestId('agent-fix-done'))
    for (const box of screen.getAllByTestId('agent-fix-note-checkbox')) await userEvent.click(box)
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findAllByTestId('agent-fix-result')

    const dispatched = eventsNamed('bridge_fix_dispatched')[0]
    expect(dispatched).toMatchObject({ findings: 3, notes: 2 })
    // Counts and enums only — never a note, a path or a word of it.
    const blob = JSON.stringify(dispatched)
    expect(blob).not.toContain('Use a Map')
    expect(blob).not.toContain('src/render.ts')
  })
})

// ---------------------------------------------------------------------------
// What happens to the note afterwards — the real design question
// ---------------------------------------------------------------------------

describe('what happens to the note after the agent answers', () => {
  async function runOneNote() {
    await connectReadyBridge()
    const harness = renderWithNotes({ drafts: [draft()] })
    await userEvent.click(screen.getByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')
    return harness
  }

  it('asks, rather than assuming — and the default posts the note unchanged', async () => {
    const { state } = await runOneNote()

    const fate = screen.getByTestId('agent-fix-result-note-fate')
    expect(fate).toHaveAttribute('data-handoff', 'sent')
    expect(fate.textContent).toMatch(/still in your review/)
    expect(fate.textContent).toMatch(/yours to say/)
    // Nothing was decided FOR the reviewer: the note is 'sent', which is the
    // fact that it went, not a decision about the review.
    expect([...state.values()][0].handoff).toBe('sent')
    expect(within(fate).getByTestId('agent-fix-result-note-keep')).toBeTruthy()
    expect(within(fate).getByTestId('agent-fix-result-note-withdraw')).toBeTruthy()
  })

  it('keeps the note in the review when the reviewer says so, as a record', async () => {
    const { state } = await runOneNote()

    await userEvent.click(screen.getByTestId('agent-fix-result-note-keep'))

    const fate = screen.getByTestId('agent-fix-result-note-fate')
    expect(fate).toHaveAttribute('data-handoff', 'kept')
    expect(fate.textContent).toMatch(/Staying in your review/)
    expect(fate.textContent).toMatch(/exactly as you wrote it/)
    expect([...state.values()][0].handoff).toBe('kept')
    // A kept note is not offered "keep it" again; withdrawing stays available.
    expect(screen.queryByTestId('agent-fix-result-note-keep')).toBeNull()
    expect(screen.getByTestId('agent-fix-result-note-withdraw')).toBeTruthy()
    expect(eventsNamed('draft_note_decided')).toEqual([{ decision: 'kept' }])
  })

  it('withdraws WITHOUT deleting, and keeps the way back on the same row', async () => {
    const { state } = await runOneNote()

    await userEvent.click(screen.getByTestId('agent-fix-result-note-withdraw'))

    const fate = screen.getByTestId('agent-fix-result-note-fate')
    expect(fate).toHaveAttribute('data-handoff', 'withdrawn')
    expect(fate.textContent).toMatch(/will not be posted/)
    expect(fate.textContent).toMatch(/not deleted/)
    // THE WORDS SURVIVE. The store still holds the note, body untouched.
    const stored = [...state.values()][0]
    expect(stored.handoff).toBe('withdrawn')
    expect(stored.body).toContain('Use a Map here')

    // And the undo is HERE, where the decision was made — not only in a list
    // the reviewer would have to restart the run to reach.
    await userEvent.click(screen.getByTestId('agent-fix-result-note-restore'))
    expect(screen.getByTestId('agent-fix-result-note-fate')).toHaveAttribute('data-handoff', 'kept')
    expect([...state.values()][0].handoff).toBe('kept')
  })

  it('leaves the note exactly where it was when the CHANGE is rejected', async () => {
    const { state } = await runOneNote()

    await userEvent.click(screen.getByTestId('agent-fix-reject'))

    expect(screen.getByTestId('agent-fix-result')).toHaveAttribute('data-verdict', 'rejected')
    // There is no path from "I did not take that diff" to a note of the
    // reviewer's leaving their own review.
    expect([...state.values()][0].handoff).toBe('sent')
    expect(screen.getByTestId('agent-fix-result-note-fate')).toHaveAttribute('data-handoff', 'sent')
  })

  it('lists a withdrawn note with its words and a way back, next run too', async () => {
    const { state } = await runOneNote()
    await userEvent.click(screen.getByTestId('agent-fix-result-note-withdraw'))
    await userEvent.click(screen.getByTestId('agent-fix-done'))

    const listed = screen.getByTestId('agent-fix-withdrawn-note')
    expect(listed.textContent).toContain('src/render.ts:42')
    expect(listed.textContent).toContain('Use a Map here')
    expect(flat(screen.getByTestId('agent-fix-withdrawn'))).toMatch(/Nothing was deleted/)
    // A withdrawn note is not offered to the agent again by default.
    expect(screen.queryByTestId('agent-fix-note-candidate')).toBeNull()

    await userEvent.click(screen.getByTestId('agent-fix-note-restore'))
    expect([...state.values()][0].handoff).toBe('kept')
    expect(screen.getAllByTestId('agent-fix-note-candidate')).toHaveLength(1)
  })

  it('offers the decision on a SKIP too — a note the agent could not act on', async () => {
    await connectReadyBridge()
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      const target = String(url)
      if (target.endsWith('/v1/stack')) return Promise.resolve(json(stackBody()))
      const sent = JSON.parse(String(init.body)) as { findings: BridgeFixFinding[] }
      return Promise.resolve(
        json({
          ok: true,
          cli: 'claude',
          baseSha: HEAD,
          branch: 'review123/fix/abc',
          changes: [],
          skipped: sent.findings.map((f) => ({
            findingId: f.id,
            reason: 'refused',
            detail: 'the note does not say what to change',
          })),
          rounds: 1,
          stopReason: 'all-addressed',
          tests: null,
          durationMs: 10,
        }),
      )
    })
    renderWithNotes({ drafts: [draft({ body: 'this feels wrong' })] })

    await userEvent.click(screen.getByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))

    const skip = await screen.findByTestId('agent-fix-skip')
    expect(skip.textContent).toContain('Your own note')
    // A vague note is a refusal, not a gap — and its fate is still the
    // reviewer's to decide, from the row that says what happened.
    expect(within(skip).getByTestId('agent-fix-result-note-fate')).toHaveAttribute(
      'data-handoff',
      'sent',
    )
  })

  it('still says nobody has read the code — the notes change nothing about that', async () => {
    await runOneNote()
    expect(screen.getByTestId('agent-fix-not-reviewed').textContent).toMatch(/no person has read/i)
  })
})

describe('several notes on one file', () => {
  it('sends each as its own task and asks about each one separately', async () => {
    await connectReadyBridge()
    const { state } = renderWithNotes({
      drafts: [draft({ line: 12, body: 'name this' }), draft({ line: 42, body: 'use a Map' })],
    })

    for (const box of screen.getAllByTestId('agent-fix-note-checkbox')) await userEvent.click(box)
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findAllByTestId('agent-fix-result')

    expect(sentBatches[0]).toHaveLength(2)
    expect(sentBatches[0].map((f) => f.line).sort()).toEqual([12, 42])
    expect(sentBatches[0][0].body).not.toContain('use a Map')

    const fates = screen.getAllByTestId('agent-fix-result-note-fate')
    expect(fates).toHaveLength(2)
    // Withdrawing one must not touch the other.
    await userEvent.click(within(fates[0]).getByTestId('agent-fix-result-note-withdraw'))
    const handoffs = [...state.values()].map((d) => d.handoff)
    expect(handoffs.filter((h) => h === 'withdrawn')).toHaveLength(1)
    expect(handoffs.filter((h) => h === 'sent')).toHaveLength(1)
  })
})
