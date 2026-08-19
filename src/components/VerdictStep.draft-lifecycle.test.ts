/**
 * VerdictStep — draft lifecycle in the step-3 recap:
 *   - per-draft relative created-at chip ("2d ago"; "earlier session" fallback)
 *   - per-draft remove button (single click, reflects live)
 *   - "file no longer in this PR" stale marker (only with a real file list)
 *   - "Clear all drafts (N)" two-step inline confirm
 *
 * fake-indexeddb lets drafts be RAW-seeded with (or without) createdAt, the
 * same way pre-existing sessions left them on disk.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import VerdictStep from './VerdictStep.svelte'
import { setGithubPat } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { createDraftStore, draftTimeTitle } from '../lib/drafts/drafts.svelte'
import type { PrRef } from '../lib/github/parse'
import type { SubmitOutcome } from '../lib/github/review'
import type { PrFile } from '../lib/github/types'

const DAY = 24 * 60 * 60 * 1000

const prRef: PrRef = { owner: 'alice', repo: 'widgets', number: 42 }
const commitId = 'head-sha-current'
const prUrl = 'https://github.com/alice/widgets/pull/42'

function okSubmit(): Promise<SubmitOutcome> {
  return Promise.resolve({ ok: true })
}

function prFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0 }
}

let dbIndex = 0

/** RAW-seed drafts (optionally without createdAt) and return a load()ed store. */
async function seededStore(
  records: { path: string; line: number; body: string; createdAt?: number }[],
) {
  const prKey = `github:alice/widgets#${++dbIndex}`
  const db = `verdict-lifecycle-db-${dbIndex}`
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(db, 1)
    open.onupgradeneeded = () => {
      const dbh = open.result
      if (!dbh.objectStoreNames.contains('drafts')) dbh.createObjectStore('drafts')
    }
    open.onsuccess = () => {
      const dbh = open.result
      const tx = dbh.transaction('drafts', 'readwrite')
      for (const r of records) {
        const record: Record<string, unknown> = {
          prKey, path: r.path, line: r.line, side: 'RIGHT', body: r.body, n: 0, updatedAt: r.createdAt ?? Date.now(),
        }
        if (r.createdAt != null) record.createdAt = r.createdAt
        tx.objectStore('drafts').put(record, `${prKey}|${r.path}|${r.line}|RIGHT|0`)
      }
      tx.oncomplete = () => { dbh.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  })
  const store = createDraftStore(prKey, db)
  await store.load()
  return store
}

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
  setGithubPat('ghp_test_token') // signed-in → the recap/form renders
})

describe('VerdictStep — recap draft lifecycle', () => {
  it('shows a relative created-at chip with the exact datetime as title', async () => {
    const createdAt = Date.now() - 2 * DAY
    const store = await seededStore([
      { path: 'src/a.ts', line: 3, body: 'timed draft', createdAt },
    ])
    render(VerdictStep, { props: { prRef, commitId, store, prUrl, submitFn: okSubmit } })

    const chip = screen.getByTestId('recap-draft-time')
    expect(chip).toHaveTextContent('2d ago')
    expect(chip).toHaveAttribute('title', draftTimeTitle(createdAt))
  })

  it('falls back to "earlier session" for drafts without createdAt', async () => {
    const store = await seededStore([
      { path: 'src/a.ts', line: 3, body: 'legacy draft' },
    ])
    render(VerdictStep, { props: { prRef, commitId, store, prUrl, submitFn: okSubmit } })

    const chip = screen.getByTestId('recap-draft-time')
    expect(chip).toHaveTextContent('earlier session')
    expect(chip).toHaveAttribute('title', 'Created in an earlier session (no timestamp recorded)')
  })

  it('remove button deletes exactly that draft and the recap updates live', async () => {
    const user = userEvent.setup()
    const store = await seededStore([
      { path: 'src/a.ts', line: 3, body: 'first draft' },
      { path: 'src/b.ts', line: 7, body: 'second draft' },
    ])
    render(VerdictStep, { props: { prRef, commitId, store, prUrl, submitFn: okSubmit } })

    expect(screen.getByText('Drafted comments (2)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove draft at src/a.ts line 3' }))

    await waitFor(() => expect(store.count).toBe(1))
    expect(screen.getByText('Drafted comments (1)')).toBeInTheDocument()
    expect(screen.queryByText('first draft')).toBeNull()
    expect(screen.getByText('second draft')).toBeInTheDocument()
  })

  it('marks drafts whose file left the diff as stale — only those', async () => {
    const store = await seededStore([
      { path: 'src/kept.ts', line: 1, body: 'still anchored' },
      { path: 'src/gone.ts', line: 2, body: 'file left the diff' },
    ])
    render(VerdictStep, {
      props: { prRef, commitId, store, prUrl, submitFn: okSubmit, files: [prFile('src/kept.ts')] },
    })

    const markers = screen.getAllByTestId('recap-draft-stale')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toHaveTextContent('file no longer in this PR')
    // The marker sits in the gone.ts group, not the kept.ts group.
    expect(markers[0].closest('.file-group')).toHaveTextContent('src/gone.ts')
  })

  it('shows NO stale markers when no file list is provided (default files=[])', async () => {
    const store = await seededStore([
      { path: 'src/whatever.ts', line: 1, body: 'cannot judge staleness' },
    ])
    render(VerdictStep, { props: { prRef, commitId, store, prUrl, submitFn: okSubmit } })

    expect(screen.queryByTestId('recap-draft-stale')).toBeNull()
  })

  it('"Clear all drafts (N)" needs a second confirming click, then empties the recap', async () => {
    const user = userEvent.setup()
    const store = await seededStore([
      { path: 'src/a.ts', line: 3, body: 'one' },
      { path: 'src/b.ts', line: 7, body: 'two' },
    ])
    render(VerdictStep, { props: { prRef, commitId, store, prUrl, submitFn: okSubmit } })

    // First click only arms the confirm.
    await user.click(screen.getByRole('button', { name: 'Clear all drafts (2)' }))
    expect(store.count).toBe(2)
    const confirmBtn = screen.getByRole('button', { name: 'Really clear 2?' })

    // Second click clears; the empty-state copy replaces the recap.
    await user.click(confirmBtn)
    await waitFor(() => expect(store.count).toBe(0))
    expect(screen.getByText(/No line comments drafted yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId('recap-clear-all')).toBeNull()
  })

  it('Escape abandons the pending clear-all confirm without clearing', async () => {
    const user = userEvent.setup()
    const store = await seededStore([{ path: 'src/a.ts', line: 3, body: 'kept' }])
    render(VerdictStep, { props: { prRef, commitId, store, prUrl, submitFn: okSubmit } })

    await user.click(screen.getByRole('button', { name: 'Clear all drafts (1)' }))
    expect(screen.getByRole('button', { name: 'Really clear 1?' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Clear all drafts (1)' })).toBeInTheDocument()
    expect(store.count).toBe(1)
  })
})
