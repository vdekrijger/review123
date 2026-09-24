/**
 * InspectStep — the reviewer's own drafted notes, end to end against the REAL
 * draft store.
 *
 * AgentFixPanel.notes.test.ts drives the panel with a hand-written sink. This
 * file pins the wiring that sink stands in for, because the wiring is where the
 * promise actually lives: withdrawing a note has to reach the store the submit
 * path reads, and the note has to stay on screen in the diff while it does.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import { createDraftStore } from '../lib/drafts/drafts.svelte'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetStackForTest } from '../lib/bridge/runPr.svelte'
import { PROTOCOL_VERSION } from '../lib/bridge/protocol'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})
Element.prototype.scrollIntoView = function () {}

const HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const TOKEN = 'pairing-token-0000000000000000000000000000'
const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'
const FILES: PrFile[] = [
  { filename: 'src/foo.ts', status: 'modified', additions: 1, deletions: 1, patch: PATCH },
]

const fetchMock = vi.fn()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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

async function pairBridge(): Promise<void> {
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

let dbn = 0
async function storeWithNote(body = 'Use a Map here, not a linear scan.') {
  dbn += 1
  vi.stubGlobal('indexedDB', new IDBFactory())
  const store = createDraftStore('github:o/r#1', `review123-inspect-notes-${dbn}`)
  await store.upsert({ path: 'src/foo.ts', line: 2, side: 'RIGHT', body })
  return store
}

function renderInspect(draftStore: ReturnType<typeof createDraftStore> | null) {
  return render(InspectStep, {
    props: {
      files: FILES,
      changedFiles: 1,
      mode: 'unified',
      onmode: () => {},
      draftStore,
      skillReviews: [],
      currentHeadSha: HEAD,
    },
  })
}

/** Let the diff view mount its extend rows (where the draft widgets live). */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60))
}

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  _resetStackForTest()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string) =>
    String(url).endsWith('/v1/stack')
      ? Promise.resolve(json(stackBody()))
      : Promise.reject(new TypeError('Failed to fetch')),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetBridgeForTest()
})

describe('InspectStep — the reviewer’s own notes reach the fix panel', () => {
  it('opens the panel for a note alone, with no AI finding anywhere', async () => {
    await pairBridge()
    renderInspect(await storeWithNote())
    await settle()

    const panel = await screen.findByTestId('agent-fix-panel')
    const row = within(panel).getByTestId('agent-fix-note-candidate')
    expect(row.textContent).toContain('src/foo.ts:2')
    expect(row.textContent).toContain('Use a Map here')
    // The reviewer's own notes are the only thing here — no findings list.
    expect(within(panel).queryByTestId('agent-fix-candidate')).toBeNull()
  })

  it('does not offer a note whose file left this pull request, and says why', async () => {
    await pairBridge()
    dbn += 1
    vi.stubGlobal('indexedDB', new IDBFactory())
    const store = createDraftStore('github:o/r#1', `review123-inspect-notes-${dbn}`)
    await store.upsert({ path: 'src/gone.ts', line: 3, side: 'RIGHT', body: 'rename this' })
    renderInspect(store)
    await settle()

    // Nothing to send, so no panel — but the note is untouched and still posts.
    expect(screen.queryByTestId('agent-fix-note-candidate')).toBeNull()
    expect(store.drafts).toHaveLength(1)
  })

  it('withdraws a note into the store the submit path reads, and keeps it on screen', async () => {
    await pairBridge()
    const store = await storeWithNote()
    renderInspect(store)
    await settle()

    const panel = await screen.findByTestId('agent-fix-panel')
    // Nothing has been decided, so no fate row is offered yet: a note that has
    // not been handed over has no fate to decide.
    expect(within(panel).queryByTestId('agent-fix-note-fate')).toBeNull()

    await store.setHandoff(`github:o/r#1|src/foo.ts|2|RIGHT|0`, 'sent')
    const fate = await within(panel).findByTestId('agent-fix-note-fate')
    await userEvent.click(within(fate).getByTestId('agent-fix-note-withdraw'))

    // THE STORE IS WHAT CHANGED — `drafts` is what submitReview is handed.
    expect(store.drafts).toEqual([])
    expect(store.all).toHaveLength(1)
    expect(store.all[0].body).toContain('Use a Map here')
    expect(store.count).toBe(0)

    // And it is still on screen in the diff, struck through, with a way back.
    const thread = await screen.findByTestId('draft-thread')
    expect(thread).toHaveAttribute('data-handoff', 'withdrawn')
    expect(thread.textContent).toContain('Use a Map here')

    await userEvent.click(within(thread).getByTestId('draft-restore'))
    expect(store.drafts).toHaveLength(1)
    expect(store.drafts[0].handoff).toBe('kept')
  })
})
