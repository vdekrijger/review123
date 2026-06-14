import { describe, it, expect } from 'vitest'
import { groupByRepo } from './groupQueue'
import type { QueueItem } from '../provider/types'

function makeItem(
  provider: 'github' | 'gitlab' | 'bitbucket',
  owner: string,
  repo: string,
  number: number,
): QueueItem {
  return {
    ref: { provider, owner, repo, number },
    title: `PR ${number}`,
    authorIsMe: false,
    updatedAt: new Date().toISOString(),
  }
}

describe('groupByRepo', () => {
  it('returns an empty array for no items', () => {
    expect(groupByRepo([])).toEqual([])
  })

  it('puts items from a single repo into one group', () => {
    const items = [makeItem('github', 'org', 'repo', 1), makeItem('github', 'org', 'repo', 2)]
    const groups = groupByRepo(items)
    expect(groups).toHaveLength(1)
    expect(groups[0].owner).toBe('org')
    expect(groups[0].repo).toBe('repo')
    expect(groups[0].provider).toBe('github')
    expect(groups[0].items.map((i) => i.ref.number)).toEqual([1, 2])
  })

  it('groups items from multiple repos, preserving first-seen group order and item order', () => {
    const items = [
      makeItem('github', 'org', 'alpha', 1),
      makeItem('github', 'org', 'beta', 2),
      makeItem('github', 'org', 'alpha', 3),
    ]
    const groups = groupByRepo(items)
    expect(groups).toHaveLength(2)
    expect(groups[0].repo).toBe('alpha')
    expect(groups[0].items.map((i) => i.ref.number)).toEqual([1, 3])
    expect(groups[1].repo).toBe('beta')
    expect(groups[1].items.map((i) => i.ref.number)).toEqual([2])
  })

  it('treats the same owner/repo on different providers as distinct groups', () => {
    const items = [makeItem('github', 'org', 'repo', 1), makeItem('gitlab', 'org', 'repo', 2)]
    const groups = groupByRepo(items)
    expect(groups).toHaveLength(2)
  })

  it('gives each group a stable unique key', () => {
    const items = [makeItem('github', 'org', 'repo', 1), makeItem('gitlab', 'org', 'repo', 2)]
    const keys = groupByRepo(items).map((g) => g.key)
    expect(new Set(keys).size).toBe(2)
  })
})
