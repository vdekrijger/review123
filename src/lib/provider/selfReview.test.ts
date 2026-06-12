/**
 * selfReview.test.ts — own-PR verdict gating predicate.
 *
 * GitHub rejects APPROVE / REQUEST_CHANGES on your own PR (422), Bitbucket
 * Cloud rejects self-approval too; GitLab self-approval is governed by
 * project settings so it is never gated client-side.
 */
import { describe, it, expect } from 'vitest'
import { isSelfReviewGated } from './selfReview'

describe('isSelfReviewGated', () => {
  it('gates when the provider blocks self-review and viewer === author', () => {
    expect(isSelfReviewGated(true, 'alice', 'alice')).toBe(true)
  })

  it('compares logins case-insensitively', () => {
    expect(isSelfReviewGated(true, 'Alice', 'aLiCe')).toBe(true)
  })

  it('does not gate when the provider allows self-review (GitLab)', () => {
    expect(isSelfReviewGated(false, 'alice', 'alice')).toBe(false)
  })

  it('does not gate when viewer and author differ', () => {
    expect(isSelfReviewGated(true, 'alice', 'bob')).toBe(false)
  })

  it('does not gate when viewer identity is unknown (null/undefined)', () => {
    expect(isSelfReviewGated(true, null, 'alice')).toBe(false)
    expect(isSelfReviewGated(true, undefined, 'alice')).toBe(false)
  })

  it('does not gate when author identity is unknown (null/undefined)', () => {
    expect(isSelfReviewGated(true, 'alice', null)).toBe(false)
    expect(isSelfReviewGated(true, 'alice', undefined)).toBe(false)
  })

  it('does not gate when both identities are empty strings', () => {
    expect(isSelfReviewGated(true, '', '')).toBe(false)
  })
})
