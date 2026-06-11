import { describe, it, expect } from 'vitest'
import { matchRoute } from './router.svelte'

describe('matchRoute', () => {
  it('matches landing', () => {
    expect(matchRoute('/')).toEqual({ name: 'landing' })
  })
  it('matches review route with params', () => {
    expect(matchRoute('/review/sveltejs/svelte/123')).toEqual({
      name: 'review', owner: 'sveltejs', repo: 'svelte', number: 123,
    })
  })
  it('rejects invalid PR number in deep link (EC-01o)', () => {
    expect(matchRoute('/review/a/b/abc')).toEqual({ name: 'not-found' })
    expect(matchRoute('/review/a/b/-1')).toEqual({ name: 'not-found' })
  })
  it('unknown paths are not-found', () => {
    expect(matchRoute('/nope')).toEqual({ name: 'not-found' })
  })
  it('matches /auth/callback → auth-callback', () => {
    expect(matchRoute('/auth/callback')).toEqual({ name: 'auth-callback' })
  })
})
