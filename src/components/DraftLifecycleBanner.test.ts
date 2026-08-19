/**
 * DraftLifecycleBanner tests.
 *
 * Uses fake-indexeddb so drafts can be RAW-seeded on disk with (or without)
 * createdAt timestamps — exactly the pre-existing-session data the banner
 * manages. The store is the real createDraftStore (load()ed before render).
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import DraftLifecycleBanner from './DraftLifecycleBanner.svelte'
import { createDraftStore } from '../lib/drafts/drafts.svelte'
import type { PrFile } from '../lib/github/types'

const DAY = 24 * 60 * 60 * 1000

let dbIndex = 0

function prFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0 }
}

/** RAW-seed a draft record (optionally without timestamps) then load a store. */
async function seededStore(
  prKey: string,
  records: { path: string; line: number; body: string; createdAt?: number }[],
) {
  const db = `banner-test-db-${++dbIndex}`
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
  sessionStorage.clear()
})

describe('DraftLifecycleBanner', () => {
  it('shows count, oldest age, and stale count', async () => {
    const prKey = 'github:acme/widgets#1'
    const now = Date.now()
    const store = await seededStore(prKey, [
      { path: 'kept.ts', line: 1, body: 'a', createdAt: now - 3 * DAY },
      { path: 'kept.ts', line: 9, body: 'b', createdAt: now - 1 * DAY },
      { path: 'gone.ts', line: 2, body: 'c', createdAt: now - 2 * DAY },
    ])
    render(DraftLifecycleBanner, {
      props: { store, files: [prFile('kept.ts')], headSha: 'sha-new', prKey },
    })

    const banner = screen.getByTestId('draft-lifecycle-banner')
    expect(banner).toHaveTextContent('3 draft comments from a previous review')
    expect(banner).toHaveTextContent('oldest 3d ago')
    expect(banner).toHaveTextContent('1 on file no longer in this PR')
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear stale (1)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
  })

  it('omits the oldest age when no draft carries a createdAt; hides Clear stale at 0 stale', async () => {
    const prKey = 'github:acme/widgets#2'
    const store = await seededStore(prKey, [
      { path: 'kept.ts', line: 1, body: 'no timestamp' },
    ])
    render(DraftLifecycleBanner, {
      props: { store, files: [prFile('kept.ts')], headSha: 'sha', prKey },
    })

    const banner = screen.getByTestId('draft-lifecycle-banner')
    expect(banner).toHaveTextContent('1 draft comment from a previous review')
    expect(banner).not.toHaveTextContent(/oldest/)
    expect(banner).not.toHaveTextContent(/no longer in this PR/)
    expect(screen.queryByRole('button', { name: /clear stale/i })).toBeNull()
  })

  it('Keep dismisses for the session (sessionStorage) and a re-mount stays hidden', async () => {
    const prKey = 'github:acme/widgets#3'
    const user = userEvent.setup()
    const store = await seededStore(prKey, [{ path: 'kept.ts', line: 1, body: 'x' }])
    render(DraftLifecycleBanner, {
      props: { store, files: [prFile('kept.ts')], headSha: 'sha', prKey },
    })

    await user.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByTestId('draft-lifecycle-banner')).toBeNull()
    expect(sessionStorage.getItem(`review123:draft-banner-dismissed:${prKey}`)).toBe('1')

    // Fresh mount in the SAME session (e.g. step navigation) stays dismissed.
    render(DraftLifecycleBanner, {
      props: { store, files: [prFile('kept.ts')], headSha: 'sha', prKey },
    })
    expect(screen.queryByTestId('draft-lifecycle-banner')).toBeNull()
  })

  it('Clear stale removes ONLY the stale drafts; banner stays with updated counts', async () => {
    const prKey = 'github:acme/widgets#4'
    const user = userEvent.setup()
    const store = await seededStore(prKey, [
      { path: 'kept.ts', line: 1, body: 'keep me' },
      { path: 'gone.ts', line: 2, body: 'stale one' },
      { path: 'also-gone.ts', line: 3, body: 'stale two' },
    ])
    render(DraftLifecycleBanner, {
      props: { store, files: [prFile('kept.ts')], headSha: 'sha', prKey },
    })

    await user.click(screen.getByRole('button', { name: 'Clear stale (2)' }))

    await waitFor(() => expect(store.count).toBe(1))
    expect(store.drafts[0].path).toBe('kept.ts')
    const banner = screen.getByTestId('draft-lifecycle-banner')
    expect(banner).toHaveTextContent('1 draft comment from a previous review')
    expect(screen.queryByRole('button', { name: /clear stale/i })).toBeNull()
  })

  it('Clear all is a two-step confirm: first click arms, second clears + hides banner', async () => {
    const prKey = 'github:acme/widgets#5'
    const user = userEvent.setup()
    const store = await seededStore(prKey, [
      { path: 'kept.ts', line: 1, body: 'a' },
      { path: 'kept.ts', line: 2, body: 'b' },
      { path: 'kept.ts', line: 3, body: 'c' },
    ])
    render(DraftLifecycleBanner, {
      props: { store, files: [prFile('kept.ts')], headSha: 'sha', prKey },
    })

    // First click: nothing cleared yet, button morphs to the confirm label.
    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(store.count).toBe(3)
    const confirmBtn = screen.getByRole('button', { name: 'Really clear 3?' })
    expect(confirmBtn).toBeInTheDocument()

    // Second click: clears everything, banner disappears.
    await user.click(confirmBtn)
    await waitFor(() => expect(store.count).toBe(0))
    expect(screen.queryByTestId('draft-lifecycle-banner')).toBeNull()
  })

  it('Escape abandons the pending Clear all confirm', async () => {
    const prKey = 'github:acme/widgets#6'
    const user = userEvent.setup()
    const store = await seededStore(prKey, [{ path: 'kept.ts', line: 1, body: 'a' }])
    render(DraftLifecycleBanner, {
      props: { store, files: [prFile('kept.ts')], headSha: 'sha', prKey },
    })

    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.getByRole('button', { name: 'Really clear 1?' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
    expect(store.count).toBe(1)
  })
})
