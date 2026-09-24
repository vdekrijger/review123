/**
 * src/lib/guide/resolvedThreadsPref.test.ts — per-browser "exclude resolved
 * threads" persistence.
 *
 * Storage: localStorage `review123:hide-resolved`, { hidden: boolean }.
 * Default HIDDEN; invalid/corrupt entries degrade to hidden.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getHideResolvedThreads,
  setHideResolvedThreads,
  toggleHideResolvedThreads,
  resolvedThreadsPref,
  _resetResolvedThreadsPrefForTest,
} from './resolvedThreadsPref.svelte'

const KEY = 'review123:hide-resolved'

beforeEach(() => {
  localStorage.clear()
  _resetResolvedThreadsPrefForTest()
})

describe('resolvedThreadsPref', () => {
  it('defaults to hidden when nothing is stored (resolved threads are noise)', () => {
    expect(getHideResolvedThreads()).toBe(true)
    expect(resolvedThreadsPref.hidden).toBe(true)
  })

  it('round-trips shown', () => {
    setHideResolvedThreads(false)
    expect(getHideResolvedThreads()).toBe(false)
    expect(resolvedThreadsPref.hidden).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hidden: false })
  })

  it('round-trips back to hidden', () => {
    setHideResolvedThreads(false)
    setHideResolvedThreads(true)
    expect(getHideResolvedThreads()).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hidden: true })
  })

  it('toggle flips and returns the new value', () => {
    expect(toggleHideResolvedThreads()).toBe(false)
    expect(resolvedThreadsPref.hidden).toBe(false)
    expect(toggleHideResolvedThreads()).toBe(true)
    expect(resolvedThreadsPref.hidden).toBe(true)
  })

  it('degrades corrupt JSON to hidden', () => {
    localStorage.setItem(KEY, '{not json')
    expect(getHideResolvedThreads()).toBe(true)
  })

  it('degrades wrong shapes to hidden (array, primitive, missing key)', () => {
    localStorage.setItem(KEY, JSON.stringify([false]))
    expect(getHideResolvedThreads()).toBe(true)
    localStorage.setItem(KEY, JSON.stringify('nope'))
    expect(getHideResolvedThreads()).toBe(true)
    localStorage.setItem(KEY, JSON.stringify({ other: false }))
    expect(getHideResolvedThreads()).toBe(true)
  })

  it('only an explicit hidden:false reads as shown', () => {
    localStorage.setItem(KEY, JSON.stringify({ hidden: 'false' }))
    expect(getHideResolvedThreads()).toBe(true)
    localStorage.setItem(KEY, JSON.stringify({ hidden: false }))
    expect(getHideResolvedThreads()).toBe(false)
  })

  it('the reactive holder re-reads storage on reset (test seam)', () => {
    localStorage.setItem(KEY, JSON.stringify({ hidden: false }))
    _resetResolvedThreadsPrefForTest()
    expect(resolvedThreadsPref.hidden).toBe(false)
  })
})
