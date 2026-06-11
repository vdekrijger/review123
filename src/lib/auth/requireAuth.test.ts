import { describe, it, expect, beforeEach } from 'vitest'
import { requireAuth } from './requireAuth'
import { saveGithubAuth } from '../settings/settings'

beforeEach(() => {
  localStorage.clear()
})

describe('requireAuth', () => {
  it('returns ok:false when no auth is set', () => {
    expect(requireAuth()).toEqual({ ok: false })
  })

  it('returns ok:true when signed in via oauth', () => {
    saveGithubAuth({ token: 'gho_TOKEN', method: 'oauth', scopes: ['public_repo'] })
    expect(requireAuth()).toEqual({ ok: true })
  })

  it('returns ok:true when signed in via PAT', () => {
    saveGithubAuth({ token: 'ghp_PAT', method: 'pat', scopes: [] })
    expect(requireAuth()).toEqual({ ok: true })
  })
})
