import { describe, it, expect } from 'vitest'
import { parsePrUrl } from './parse'

const ok = { owner: 'octo-org', repo: 'repo.js', number: 123 }

describe('parsePrUrl', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrUrl('https://github.com/octo-org/repo.js/pull/123')).toEqual({ ok: true, value: ok })
  })
  it('EC-01a: null/undefined input → error, no throw', () => {
    expect(parsePrUrl(null as never).ok).toBe(false)
    expect(parsePrUrl(undefined as never).ok).toBe(false)
  })
  it('EC-01b/EC-01c: empty and whitespace-only → "empty" error', () => {
    for (const u of ['', '   ']) {
      expect(parsePrUrl(u)).toEqual({ ok: false, error: 'empty' })
    }
  })
  it('EC-01h: non-numeric PR segment rejected', () => {
    expect(parsePrUrl('https://github.com/a/b/pull/abc')).toEqual({ ok: false, error: 'not-a-pr-url' })
  })
  it('EC-01i: partial URL, wrong host, issues URL → specific errors', () => {
    expect(parsePrUrl('https://github.com/onlyowner')).toEqual({ ok: false, error: 'not-a-pr-url' })
    expect(parsePrUrl('https://gitlab.com/a/b/pull/1')).toEqual({ ok: false, error: 'not-github' })
    expect(parsePrUrl('https://github.com/a/b/issues/1')).toEqual({ ok: false, error: 'not-a-pr-url' })
  })
  it('EC-01j: trailing path/query/fragment still parse', () => {
    for (const s of ['/files', '#discussion_r1', '?w=1', '/files?w=1#x']) {
      expect(parsePrUrl(`https://github.com/octo-org/repo.js/pull/123${s}`)).toEqual({ ok: true, value: ok })
    }
  })
  it('EC-01l: injection strings in segments are rejected', () => {
    expect(parsePrUrl('https://github.com/<script>/x/pull/1').ok).toBe(false)
    expect(parsePrUrl('https://github.com/a%00b/x/pull/1').ok).toBe(false)
  })
  it('EC-01n: http and protocol-less forms accepted', () => {
    expect(parsePrUrl('http://github.com/octo-org/repo.js/pull/123')).toEqual({ ok: true, value: ok })
    expect(parsePrUrl('github.com/octo-org/repo.js/pull/123')).toEqual({ ok: true, value: ok })
  })
  it('EC-01d/e/g: number boundaries', () => {
    expect(parsePrUrl('https://github.com/a/b/pull/0').ok).toBe(false)
    expect(parsePrUrl('https://github.com/a/b/pull/1').ok).toBe(true)
    expect(parsePrUrl('https://github.com/a/b/pull/-1').ok).toBe(false)
  })
  it('EC-01m: 10k+ char URL rejected without hang', () => {
    expect(parsePrUrl('https://github.com/a/b/pull/1' + 'x'.repeat(10_000)).ok).toBe(false)
  })
})
