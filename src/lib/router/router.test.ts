import { describe, it, expect } from 'vitest'
import { matchRoute } from './router.svelte'

describe('matchRoute', () => {
  it('matches landing', () => {
    expect(matchRoute('/')).toEqual({ name: 'landing' })
  })
  it('matches review route with params', () => {
    expect(matchRoute('/review/sveltejs/svelte/123')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 123, step: 1,
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

describe('matchRoute — step URLs', () => {
  it('bare /review/o/r/n (no step) → step 1', () => {
    expect(matchRoute('/review/sveltejs/svelte/42')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 1,
    })
  })
  it('/review/o/r/n/understand → step 1', () => {
    expect(matchRoute('/review/sveltejs/svelte/42/understand')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 1,
    })
  })
  it('/review/o/r/n/inspect → step 2', () => {
    expect(matchRoute('/review/sveltejs/svelte/42/inspect')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 2,
    })
  })
  it('/review/o/r/n/verdict → step 3', () => {
    expect(matchRoute('/review/sveltejs/svelte/42/verdict')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 3,
    })
  })
  it('invalid step segment → not-found', () => {
    expect(matchRoute('/review/sveltejs/svelte/42/foobar')).toEqual({ name: 'not-found' })
  })
})

describe('matchRoute — provider-qualified URLs', () => {
  it('/review/github/owner/repo/42 → provider form step 1', () => {
    expect(matchRoute('/review/github/sveltejs/svelte/42')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 1,
    })
  })
  it('/review/github/owner/repo/42/understand → step 1', () => {
    expect(matchRoute('/review/github/sveltejs/svelte/42/understand')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 1,
    })
  })
  it('/review/github/owner/repo/42/inspect → step 2', () => {
    expect(matchRoute('/review/github/sveltejs/svelte/42/inspect')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 2,
    })
  })
  it('/review/github/owner/repo/42/verdict → step 3', () => {
    expect(matchRoute('/review/github/sveltejs/svelte/42/verdict')).toEqual({
      name: 'review', provider: 'github', owner: 'sveltejs', repo: 'svelte', number: 42, step: 3,
    })
  })
  it('/review/github/owner/repo/42/foobar → not-found', () => {
    expect(matchRoute('/review/github/sveltejs/svelte/42/foobar')).toEqual({ name: 'not-found' })
  })
  it('/review/gitlab/owner/repo/99 → gitlab provider', () => {
    expect(matchRoute('/review/gitlab/myorg/myrepo/99')).toEqual({
      name: 'review', provider: 'gitlab', owner: 'myorg', repo: 'myrepo', number: 99, step: 1,
    })
  })
  it('/review/bitbucket/owner/repo/7 → bitbucket provider', () => {
    expect(matchRoute('/review/bitbucket/myorg/myrepo/7')).toEqual({
      name: 'review', provider: 'bitbucket', owner: 'myorg', repo: 'myrepo', number: 7, step: 1,
    })
  })
})
