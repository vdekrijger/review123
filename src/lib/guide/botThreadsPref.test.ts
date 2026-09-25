/**
 * src/lib/guide/botThreadsPref — the per-browser "Hide bots" preference.
 *
 * Mirrors resolvedThreadsPref.test.ts: default HIDDEN, absent/garbage entries
 * read as hidden, and a localStorage that throws never takes the app with it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getHideBotThreads,
  setHideBotThreads,
  toggleHideBotThreads,
  botThreadsPref,
  _resetBotThreadsPrefForTest,
} from './botThreadsPref.svelte'

const KEY = 'review123:hide-bot-comments'

beforeEach(() => {
  localStorage.clear()
  _resetBotThreadsPrefForTest()
})

describe('default', () => {
  it('hides bot threads when nothing is stored', () => {
    expect(getHideBotThreads()).toBe(true)
    expect(botThreadsPref.hidden).toBe(true)
  })

  it('reads an explicit false', () => {
    localStorage.setItem(KEY, JSON.stringify({ hidden: false }))
    _resetBotThreadsPrefForTest()
    expect(getHideBotThreads()).toBe(false)
    expect(botThreadsPref.hidden).toBe(false)
  })

  it('does not share storage with the resolved-threads switch', () => {
    localStorage.setItem('review123:hide-resolved', JSON.stringify({ hidden: false }))
    _resetBotThreadsPrefForTest()
    expect(getHideBotThreads()).toBe(true)
  })
})

describe('malformed entries read as hidden', () => {
  for (const raw of ['', 'not json', 'null', '[]', '"hidden"', '{"hidden":"no"}', '{}']) {
    it(`${JSON.stringify(raw)} → hidden`, () => {
      localStorage.setItem(KEY, raw)
      _resetBotThreadsPrefForTest()
      expect(getHideBotThreads()).toBe(true)
    })
  }
})

describe('writing', () => {
  it('persists and publishes', () => {
    setHideBotThreads(false)
    expect(botThreadsPref.hidden).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hidden: false })
  })

  it('toggle returns the new state', () => {
    expect(toggleHideBotThreads()).toBe(false)
    expect(toggleHideBotThreads()).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hidden: true })
  })

  it('survives a localStorage that throws — the session still follows the holder', () => {
    const real = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(() => setHideBotThreads(false)).not.toThrow()
      expect(botThreadsPref.hidden).toBe(false)
    } finally {
      Storage.prototype.setItem = real
    }
  })
})
