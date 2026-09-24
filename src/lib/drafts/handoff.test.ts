/**
 * drafts — what happens to a note after it is handed to the fixing agent.
 *
 * THE PROPERTY UNDER TEST is not a data shape. It is a promise: the app never
 * removes words somebody wrote, and every state it does record can be undone.
 * So these tests are written as the things that must stay true:
 *
 *   - the default changes nothing. A note that went to the agent is still in
 *     the review and still posts, exactly as before;
 *   - withdrawing takes a note out of what gets SUBMITTED and out of nothing
 *     else. The words stay in the database, stay at their line, and come back;
 *   - a decision the reviewer made is never overwritten by the machinery —
 *     including by sending the same note round again;
 *   - deleting stays what it always was: an explicit, separate act.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createDraftStore, draftKey, isWithdrawnDraft } from './drafts.svelte'

afterEach(() => {
  vi.unstubAllGlobals()
})

let n = 0
function fresh() {
  n += 1
  const prKey = `github:o/r#${n}`
  vi.stubGlobal('indexedDB', new IDBFactory())
  return { prKey, store: createDraftStore(prKey, `review123-handoff-${n}`) }
}

const KEY = (prKey: string, line: number, ordinal = 0) =>
  draftKey({ prKey, path: 'src/a.ts', line, side: 'RIGHT', n: ordinal })

async function seed(store: ReturnType<typeof createDraftStore>, line: number, body: string) {
  await store.upsert({ path: 'src/a.ts', line, side: 'RIGHT', body })
}

describe('a note handed to the agent', () => {
  it('changes nothing about the review by default', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')

    await store.markSent([KEY(prKey, 10)])

    // Still in the review, still counted, still submitted. The ONLY difference
    // is that the app now knows it was sent, which is what lets it ask later.
    expect(store.drafts).toHaveLength(1)
    expect(store.count).toBe(1)
    expect(store.drafts[0].body).toBe('use a Map here')
    expect(store.drafts[0].handoff).toBe('sent')
    expect(store.withdrawn).toEqual([])
  })

  it('records the reviewer keeping it as a decision, distinct from not deciding', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')
    await store.markSent([KEY(prKey, 10)])
    expect(store.drafts[0].handoff).toBe('sent')

    await store.setHandoff(KEY(prKey, 10), 'kept')

    // Same outcome — it posts either way — but "I chose to post this anyway"
    // and "I never looked" are different facts and stay different.
    expect(store.drafts[0].handoff).toBe('kept')
    expect(store.drafts).toHaveLength(1)
  })

  it('does not overwrite a decision when the same note goes round again', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')
    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    await store.markSent([KEY(prKey, 10)])

    // Sending a withdrawn note back for another attempt must not quietly put
    // it back in the review.
    expect(store.all[0].handoff).toBe('withdrawn')
    expect(store.drafts).toEqual([])
  })

  it('leaves an unknown key alone rather than inventing a note', async () => {
    const { prKey, store } = fresh()
    await store.setHandoff(KEY(prKey, 999), 'withdrawn')
    await store.markSent([KEY(prKey, 999)])
    expect(store.all).toEqual([])
  })
})

describe('withdrawing a note', () => {
  it('takes it out of what gets submitted, and out of nothing else', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')
    await seed(store, 20, 'name this better')

    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    // Out of the submitted review, and out of the count the Verdict step shows.
    expect(store.drafts.map((d) => d.line)).toEqual([20])
    expect(store.count).toBe(1)
    // Still written, still at its line, still readable in the diff.
    expect(store.all.map((d) => d.line)).toEqual([10, 20])
    expect(store.all[0].body).toBe('use a Map here')
    expect(store.draftsAt('src/a.ts', 10, 'RIGHT')).toHaveLength(1)
    expect(store.withdrawn.map((d) => d.line)).toEqual([10])
    expect(isWithdrawnDraft(store.all[0])).toBe(true)
  })

  it('survives a reload — a withdrawal is a fact, not a screen state', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')
    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    const reopened = createDraftStore(prKey, `review123-handoff-${n}`)
    await reopened.load()

    expect(reopened.drafts).toEqual([])
    expect(reopened.all).toHaveLength(1)
    expect(reopened.all[0].body).toBe('use a Map here')
    expect(reopened.withdrawn).toHaveLength(1)
  })

  it('comes back when the note is written again — the way back needs no new plumbing', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')
    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    // "Put it back" is a plain re-save of the body that is already stored.
    await store.upsert({ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'use a Map here', n: 0 })

    expect(store.drafts).toHaveLength(1)
    expect(store.drafts[0].handoff).toBe('kept')
    expect(store.drafts[0].body).toBe('use a Map here')
    expect(store.withdrawn).toEqual([])
  })

  it('comes back when the note is EDITED — you do not edit something you dropped', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')
    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    await store.upsert({ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'use a Map — see the loop', n: 0 })

    expect(store.drafts).toHaveLength(1)
    expect(store.drafts[0].body).toBe('use a Map — see the loop')
    expect(store.drafts[0].handoff).toBe('kept')
  })

  it('does not un-decide a note that was merely sent or kept', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'first')
    await store.markSent([KEY(prKey, 10)])
    await store.upsert({ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'second', n: 0 })
    expect(store.drafts[0].handoff).toBe('sent')

    await store.setHandoff(KEY(prKey, 10), 'kept')
    await store.upsert({ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'third', n: 0 })
    expect(store.drafts[0].handoff).toBe('kept')
  })

  it('does not take the ordinal with it — a reply is not appended over it', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'first note')
    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    // n: -1 is the store's "append" sentinel. A withdrawn note still occupies
    // n=0, so appending must land at n=1 rather than overwriting words nobody
    // deleted.
    await store.upsert({ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'a follow-up', n: -1 })

    expect(store.all).toHaveLength(2)
    expect(store.all.map((d) => d.n)).toEqual([0, 1])
    expect(store.all[0].body).toBe('first note')
    expect(store.drafts.map((d) => d.body)).toEqual(['a follow-up'])
  })

  it('leaves deleting exactly what it was — an explicit, separate act', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'use a Map here')
    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    expect(store.all).toHaveLength(1)
    await store.remove(KEY(prKey, 10))
    expect(store.all).toEqual([])
  })

  it('is cleared by "clear all", which was always the reviewer’s own gesture', async () => {
    const { prKey, store } = fresh()
    await seed(store, 10, 'a')
    await seed(store, 20, 'b')
    await store.setHandoff(KEY(prKey, 10), 'withdrawn')

    await store.clearAll()
    expect(store.all).toEqual([])
  })
})
