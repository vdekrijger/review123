/**
 * types.test.ts — `deriveRepoRelation`, the one rule all three provider
 * adapters share for "did this pull request's code come from this repository?".
 *
 * The rule has exactly one dangerous failure mode: answering `same-repo` when
 * it does not actually know. Most of what follows is that one assertion, from
 * every direction an unknown can arrive from.
 */
import { describe, it, expect } from 'vitest'
import { deriveRepoRelation, type PrMeta } from './types'

describe('deriveRepoRelation', () => {
  it('is SAME-REPO only when both sides are present and equal', () => {
    expect(deriveRepoRelation('octo/hello', 'octo/hello')).toBe('same-repo')
  })

  // Providers are inconsistent about case (GitHub preserves the owner's
  // capitalisation; a URL may not), and none of them is case-sensitive about
  // repository identity.
  it('compares case-insensitively and ignores surrounding whitespace', () => {
    expect(deriveRepoRelation('Octo/Hello', 'octo/hello')).toBe('same-repo')
    expect(deriveRepoRelation(' octo/hello ', 'octo/hello')).toBe('same-repo')
  })

  it('is FORK when both sides are present and differ', () => {
    expect(deriveRepoRelation('stranger/hello', 'octo/hello')).toBe('fork')
    // Bitbucket forks usually keep the slug and change only the workspace, so
    // the full name is the comparison that works — the slug alone is not.
    expect(deriveRepoRelation('hoolisoftware/official-pipes', 'bitbucketpipelines/official-pipes'))
      .toBe('fork')
    // GitLab identities are numeric project ids, stringified.
    expect(deriveRepoRelation('73200868', '13083')).toBe('fork')
    expect(deriveRepoRelation('13083', '13083')).toBe('same-repo')
  })

  // THE RULE THAT MATTERS. Every shape of "we do not know" must land here, and
  // an unknown is never rounded up to the reassuring answer.
  it.each([
    ['both absent', undefined, undefined],
    ['head absent', undefined, 'octo/hello'],
    ['base absent', 'octo/hello', undefined],
    ['head null (deleted fork)', null, 'octo/hello'],
    ['base null', 'octo/hello', null],
    ['both null', null, null],
    ['head empty', '', 'octo/hello'],
    ['base empty', 'octo/hello', ''],
    ['both empty — NOT equal', '', ''],
    ['both whitespace — NOT equal', '   ', '   '],
  ])('is UNKNOWN when %s', (_label, head, base) => {
    expect(deriveRepoRelation(head as string | null | undefined, base as string | null | undefined))
      .toBe('unknown')
  })

  // The two empty/whitespace rows above are the trap: `'' === ''` is true, so a
  // naive equality check would call a PR with no provenance at all "same-repo".
  it('does not let two equally-empty identities prove sameness', () => {
    expect(deriveRepoRelation('', '')).not.toBe('same-repo')
    expect(deriveRepoRelation('  ', '')).not.toBe('same-repo')
  })
})

describe('PrMeta repo fields', () => {
  /**
   * A `PrMeta` built by a build from BEFORE these fields existed — exactly the
   * shape any cached or serialised meta still has. It must remain assignable
   * (the fields are optional, not required) and read as unknown.
   */
  it('accepts a meta with no repo fields and reads it as unknown', () => {
    const stale: PrMeta = {
      title: 'T',
      state: 'open',
      merged: false,
      body: null,
      baseSha: 'b1',
      headSha: 'h1',
      private: false,
      changedFiles: 2,
      authorLogin: 'octocat',
    }
    expect(stale.repoRelation).toBeUndefined()
    expect(deriveRepoRelation(stale.headRepo, stale.baseRepo)).toBe('unknown')
  })
})
