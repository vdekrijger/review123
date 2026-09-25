/**
 * VerdictStep — handing the FINISHED review to the local coding agent.
 *
 * The substance of this already existed on Step 2: the fix panel can send the
 * reviewer's own drafted notes to their agent, loop under a budget, re-read what
 * came back and ask what should happen to each note. What it could not do was
 * serve this moment — the reviewer has stopped reading and wants to hand over the
 * whole thing.
 *
 * So what these tests pin is not the loop (AgentFixPanel.*.test.ts owns that).
 * It is the four things that are only true HERE, and each one is a decision
 * somebody could reverse by accident:
 *
 *   1. it is offered only where a bridge can take it, and where a capability is
 *      missing it says WHICH and how to start one — never a dead control, and
 *      never a word about the bridge to somebody who has not paired one;
 *   2. handing over is not submitting, in either direction: nothing is posted,
 *      nothing is cleared, and a reviewer who sends and then decides not to
 *      submit loses nothing;
 *   3. it does not read as though the checking has been discharged. The grade
 *      lives directly up the page, and this must not look like its answer — no
 *      "fixed", no "resolved", no tick, and the output is a proposal;
 *   4. what travels is the notes and the overall comment, as background —
 *      including the notes the POSTING path has to re-route, which an agent has
 *      no reason to refuse. The verdict does not travel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import VerdictStep from './VerdictStep.svelte'
import { setGithubPat } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { createDraftStore, type Draft } from '../lib/drafts/drafts.svelte'
import { _setCaptureForTest } from '../lib/analytics/analytics'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetStackForTest } from '../lib/bridge/runPr.svelte'
import { _resetFixTestFactForTest, currentFixTestFact } from '../lib/bridge/fixTestFact.svelte'
import { BRIDGE_STORAGE_KEY } from '../lib/bridge/storage'
import { BRIDGE_START_COMMAND } from '../lib/bridge/install'
import { PROTOCOL_VERSION, type BridgeFixFinding } from '../lib/bridge/protocol'
import type { PrRef } from '../lib/github/parse'
import type { SubmitOutcome } from '../lib/github/review'
import type { PrFile } from '../lib/github/types'

const HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const TOKEN = 'pairing-token-0000000000000000000000000000'
const prRef: PrRef = { owner: 'alice', repo: 'widgets', number: 42 }
const prUrl = 'https://github.com/alice/widgets/pull/42'

// One file, one hunk covering lines 40-44 on the RIGHT side. A draft on line 42
// anchors; a draft on line 400 does not, which is the case deliverable 4 is about.
const FILES: PrFile[] = [
  {
    filename: 'src/render.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    changes: 4,
    patch: '@@ -40,3 +40,5 @@\n ctx\n+one\n+two\n three\n',
  } as unknown as PrFile,
]

const captured: { event: string; props: Record<string, unknown> }[] = []
/** Every finding batch the bridge was actually sent, in order. */
const sentBatches: BridgeFixFinding[][] = []
const fetchMock = vi.fn()

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function connectBridgeWith(capabilities: Record<string, unknown>): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    json({
      ok: true,
      protocol: PROTOCOL_VERSION,
      root: 'review123',
      capabilities: { inference: ['claude'], infer: true, files: true, search: true, ...capabilities },
      git: { head: HEAD, branch: 'feat/x', dirty: false },
      version: '0.1.0',
    }),
  )
  await connectBridge(TOKEN, 7321)
}

/** Paired, write-enabled, a CLI on PATH, sitting on this PR's head. */
const connectReadyBridge = () => connectBridgeWith({ fix: true })
/** Paired and read-only — the refusal the user can act on at their terminal. */
const connectReadOnlyBridge = () => connectBridgeWith({ fix: false })

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
function echoFix(init: RequestInit): Response {
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

function draft(over: Partial<Draft> = {}): Draft {
  return {
    prKey: `github:alice/widgets#42@${HEAD}`,
    path: 'src/render.ts',
    line: 42,
    side: 'RIGHT',
    body: 'Use a Map here — this linear scan runs inside the render loop.',
    n: 0,
    ...over,
  }
}

async function storeWith(drafts: Draft[]) {
  const store = createDraftStore(`github:alice/widgets#42@${HEAD}`, undefined, HEAD)
  for (const d of drafts) {
    await store.upsert({ path: d.path, line: d.line, side: d.side, body: d.body, n: d.n ?? 0 })
  }
  return store
}

function okSubmit(): Promise<SubmitOutcome> {
  return Promise.resolve({ ok: true })
}

/**
 * Render the step the way Review.svelte does, with an optional submit spy.
 * `commitId` is the PR head, which is what the fix readiness rule compares the
 * bridge's checkout against.
 */
function renderStep(
  store: Awaited<ReturnType<typeof storeWith>>,
  over: Record<string, unknown> = {},
) {
  return render(VerdictStep, {
    props: {
      prRef,
      commitId: HEAD,
      store,
      prUrl,
      prTitle: 'Speed up the render loop',
      files: FILES,
      submitFn: okSubmit,
      ...over,
    } as never,
  })
}

function eventsNamed(name: string): Record<string, unknown>[] {
  return captured.filter((c) => c.event === name).map((c) => c.props)
}

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
  _resetBridgeForTest()
  _resetStackForTest()
  _resetFixTestFactForTest()
  captured.length = 0
  sentBatches.length = 0
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    const target = String(url)
    if (target.endsWith('/v1/stack')) return Promise.resolve(json(stackBody()))
    return Promise.resolve(echoFix(init))
  })
  vi.stubGlobal('fetch', fetchMock)
  _setCaptureForTest((event, props) => captured.push({ event, props }))
  setGithubPat('ghp_test_token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
  _setCaptureForTest(() => {})
})

// ---------------------------------------------------------------------------
// 1. Offered only where a bridge can take it
// ---------------------------------------------------------------------------

describe('when the bridge cannot take it', () => {
  it('says nothing at all with none paired, and leaves the export untouched', async () => {
    const store = await storeWith([draft()])
    renderStep(store)

    expect(screen.queryByTestId('agent-fix-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('verdict-handover-empty')).not.toBeInTheDocument()
    // "Copy as LLM prompt" is exactly what it was: enabled, same label, no
    // greyed-out sibling and no hint about a bridge nobody has heard of.
    const copy = screen.getByRole('button', { name: 'Copy as LLM prompt' })
    expect(copy).toBeEnabled()
    expect(document.body.textContent).not.toMatch(/bridge/i)
  })

  it('names the missing grant and the command that starts one, read-only', async () => {
    await connectReadOnlyBridge()
    const store = await storeWith([draft()])
    renderStep(store)

    const readiness = await screen.findByTestId('agent-fix-readiness')
    expect(readiness).toHaveAttribute('data-reason', 'write-disabled')
    expect(readiness.textContent).toMatch(/--allow-write/)
    expect((await screen.findByTestId('agent-fix-start-command')).textContent).toBe(
      BRIDGE_START_COMMAND,
    )
    // A refusal is not a dead button: there is no send control to grey out.
    expect(screen.queryByTestId('agent-fix-send')).not.toBeInTheDocument()
    // The framing still renders — a refusal has to say what was being refused.
    expect(screen.getByTestId('verdict-handover-separable')).toBeInTheDocument()
  })

  it('explains itself when there is a comment but nothing anchored to send', async () => {
    await connectReadyBridge()
    const store = await storeWith([])
    renderStep(store)

    await userEvent.type(
      screen.getByRole('textbox'),
      'Overall: please stop throwing in this module.',
    )

    const empty = await screen.findByTestId('verdict-handover-empty')
    expect(empty.textContent).toMatch(/names no\s+file and no line/)
    expect(empty.textContent).toMatch(/Copy as LLM prompt/)
    expect(screen.queryByTestId('agent-fix-panel')).not.toBeInTheDocument()
  })

  it('stays silent with neither a note nor a comment', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([]))

    expect(screen.queryByTestId('agent-fix-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('verdict-handover-empty')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 2 + 4. What travels, and what it is NOT
// ---------------------------------------------------------------------------

describe('what is handed over', () => {
  it('offers the reviewer’s own notes, opt-in, under this step’s heading', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft(), draft({ line: 43, body: 'Name this properly.' })]))

    expect(await screen.findByText('Hand these notes to your coding agent')).toBeInTheDocument()
    expect(screen.getAllByTestId('agent-fix-note-candidate')).toHaveLength(2)
    // Opt-in: nothing is ticked, so nothing can leave by accident.
    expect(screen.getByTestId('agent-fix-send')).toBeDisabled()
    // This step is past reading the pull request, so bot comments are not offered.
    expect(screen.queryByTestId('agent-fix-bots')).not.toBeInTheDocument()
  })

  it('sends each note as the reviewer’s own direction, never as a suggestedFix', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))

    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    expect(sentBatches).toHaveLength(1)
    const [wire] = sentBatches[0]!
    expect(wire.path).toBe('src/render.ts')
    expect(wire.line).toBe(42)
    expect(wire.body).toContain('Use a Map here')
    expect(wire.body).toMatch(/REVIEWER'S OWN NOTE/)
    expect(wire.suggestedFix).not.toContain('Use a Map here')
  })

  it('carries the overall comment as BACKGROUND and the verdict not at all', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))

    await userEvent.type(screen.getByRole('textbox'), 'Use the Result helper throughout.')
    await userEvent.click(screen.getByRole('radio', { name: 'Request changes' }))

    const payload = screen.getByTestId('verdict-handover-payload')
    expect(payload.textContent).toMatch(/background, marked as\s+context rather than a task/)
    expect(payload.textContent).toMatch(/verdict does not travel/)

    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    const [wire] = sentBatches[0]!
    expect(wire.body).toContain('Use the Result helper throughout.')
    expect(wire.body).toMatch(/BACKGROUND, NOT YOUR TASK/)
    // The verdict is a statement to the author. Nothing about it reaches the wire.
    expect(JSON.stringify(sentBatches[0])).not.toMatch(/REQUEST_CHANGES|requested changes/)
  })

  it('says nothing about an overall comment when there is none', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))

    const payload = await screen.findByTestId('verdict-handover-payload')
    expect(payload.textContent).not.toMatch(/overall comment/i)
    expect(payload.textContent).toMatch(/verdict does not travel/)
  })

  it('sends a note the POSTING path has to re-route, and says so', async () => {
    await connectReadyBridge()
    // Line 400 is not in any hunk: submitting turns it into a file comment, and
    // a one-shot review command folds it into the body. An agent has no such limit.
    renderStep(await storeWith([draft({ line: 400 })]))

    expect(screen.getByTestId('offdiff-presubmit-note')).toBeInTheDocument()
    const payload = await screen.findByTestId('verdict-handover-payload')
    expect(payload.textContent).toMatch(/one that can only post as a file comment/)
    expect(payload.textContent).toMatch(/an agent has no such limit/)

    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    expect(sentBatches[0]!.map((f) => f.line)).toEqual([400])
  })

  it('never drops a note silently — a refused one is counted and named', async () => {
    await connectReadyBridge()
    // Its file is not in this pull request at all, so there is no code to point
    // an agent at. Refused, counted, and said out loud.
    renderStep(await storeWith([draft(), draft({ path: 'src/gone.ts', line: 3 })]))

    const refused = await screen.findByTestId('agent-fix-notes-refused')
    expect(refused.textContent).toMatch(/no longer changes/)
    expect(screen.getAllByTestId('agent-fix-note-candidate')).toHaveLength(1)
  })

  it('reports the batch as counts and an enum naming this entry point', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))

    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    const dispatched = eventsNamed('bridge_fix_dispatched')[0]!
    expect(dispatched).toMatchObject({ findings: 1, notes: 1, surface: 'verdict' })
    const blob = JSON.stringify(dispatched)
    expect(blob).not.toContain('Use a Map')
    expect(blob).not.toContain('src/render.ts')
  })
})

// ---------------------------------------------------------------------------
// 2. Handing over is not submitting — in either direction
// ---------------------------------------------------------------------------

describe('sending and submitting stay separate acts', () => {
  it('posts nothing and clears nothing when the reviewer sends', async () => {
    await connectReadyBridge()
    const submit = vi.fn(okSubmit)
    const store = await storeWith([draft()])
    renderStep(store, { submitFn: submit })

    await userEvent.type(screen.getByRole('textbox'), 'Overall note stays put.')
    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    expect(submit).not.toHaveBeenCalled()
    expect(store.count).toBe(1)
    expect(store.drafts[0]!.body).toContain('Use a Map here')
    expect(screen.getByRole('textbox')).toHaveValue('Overall note stays put.')
    // Still the ordinary form — no success panel, no "submitted".
    expect(screen.getByRole('button', { name: 'Submit review' })).toBeInTheDocument()
  })

  it('lets a reviewer send and then NOT submit, keeping every word', async () => {
    await connectReadyBridge()
    const submit = vi.fn(okSubmit)
    const store = await storeWith([draft()])
    renderStep(store, { submitFn: submit })

    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')
    // The reviewer reads the proposal and walks away without submitting.
    expect(submit).not.toHaveBeenCalled()
    await waitFor(() => expect(store.all[0]!.handoff).toBe('sent'))
    expect(store.count).toBe(1)
  })

  it('submits the notes that are still in the review after a send', async () => {
    await connectReadyBridge()
    const submit = vi.fn(okSubmit)
    const store = await storeWith([draft(), draft({ line: 43, body: 'Name this properly.' })])
    renderStep(store, { submitFn: submit })

    for (const box of await screen.findAllByTestId('agent-fix-note-checkbox')) {
      await userEvent.click(box)
    }
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findAllByTestId('agent-fix-result')

    // One note is withdrawn from the review — the words survive, the posting
    // does not. That is the whole point of a decision at this moment.
    await userEvent.click(screen.getAllByTestId('agent-fix-result-note-withdraw')[0]!)
    await waitFor(() => expect(store.count).toBe(1))
    // Withdrawing is not deleting: the words are still there, just not posted.
    expect(store.all).toHaveLength(2)
    expect(store.withdrawn).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Submit review' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const posted = submit.mock.calls[0]![3] as Draft[]
    expect(posted).toHaveLength(1)
    expect(posted[0]!.line).toBe(43)
    // Submitting IS the end of the review, and only then are the drafts cleared
    // — the pre-existing rule (EC-09g), unchanged by the handover.
    await waitFor(() => expect(store.all).toHaveLength(0))
  })
})

// ---------------------------------------------------------------------------
// 3. It must not read as the readiness basis' answer
// ---------------------------------------------------------------------------

describe('it does not stand in for the reviewer’s own read', () => {
  it('frames the result as a proposal, and says it answers no grade', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))

    const proposal = await screen.findByTestId('verdict-handover-proposal')
    expect(proposal.textContent).toMatch(/a proposal, not a change/)
    expect(proposal.textContent).toMatch(/how much of this pull request was actually\s+read/)
    expect(proposal.textContent).toMatch(/an agent writing code is not that being done/)
  })

  it('never says fixed, resolved or done, and shows no tick', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))

    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\bfixed\b/i)
    expect(text).not.toMatch(/\bresolved\b/i)
    expect(text).not.toContain('✓ ')
    expect(text).not.toContain('✅')
  })

  it('sits below the verdict and the actions, not under the grade', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))

    const panel = await screen.findByTestId('agent-fix-panel')
    const submit = screen.getByRole('button', { name: 'Submit review' })
    expect(submit.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('publishes no test fact until this panel has actually run something', async () => {
    await connectReadyBridge()
    renderStep(await storeWith([draft()]))
    await screen.findByTestId('agent-fix-panel')

    // A mount is not a run. Nothing here may erase what another surface recorded.
    expect(currentFixTestFact(HEAD).status).toBe('not-run')

    await userEvent.click(screen.getByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await screen.findByTestId('agent-fix-result')

    const fact = currentFixTestFact(HEAD)
    expect(fact.status).toBe('passed')
    // Scoped to the agent's commit, never claimed of the pull request.
    expect(fact.command).toMatch(/on the agent's fix commit/)
  })
})

// ---------------------------------------------------------------------------
// A run the user stops mid-flight
// ---------------------------------------------------------------------------

describe('a run the reviewer stops', () => {
  it('keeps the review intact and does not report a failure', async () => {
    await connectReadyBridge()
    const submit = vi.fn(okSubmit)
    const store = await storeWith([draft()])
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      const target = String(url)
      if (target.endsWith('/v1/stack')) return Promise.resolve(json(stackBody()))
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    })
    renderStep(store, { submitFn: submit })

    await userEvent.click(await screen.findByTestId('agent-fix-note-checkbox'))
    await userEvent.click(screen.getByTestId('agent-fix-send'))
    await userEvent.click(await screen.findByTestId('agent-fix-cancel'))

    const settled = eventsNamed('bridge_fix_settled')
    expect(settled[0]).toMatchObject({ outcome: 'cancelled' })
    expect(settled[0]).not.toHaveProperty('failure')
    // The review is untouched, and submitting still does what it always did.
    expect(store.count).toBe(1)
    expect(submit).not.toHaveBeenCalled()
  })
})
