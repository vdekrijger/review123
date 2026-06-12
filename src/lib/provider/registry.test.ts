import { describe, it, expect } from 'vitest'
import { providerFor, parseAnyUrl, PROVIDERS } from './registry'
import { githubProvider } from './github'
import { gitlabProvider } from './gitlab'

describe('providerFor', () => {
  it('returns the github provider for "github"', () => {
    expect(providerFor('github')).toBe(githubProvider)
  })

  it('throws for an unknown provider id', () => {
    expect(() => providerFor('unknown')).toThrow(/unknown provider/i)
  })

  it('throws for an empty string', () => {
    expect(() => providerFor('')).toThrow()
  })

  it('PROVIDERS map contains "github"', () => {
    expect([...PROVIDERS.keys()]).toContain('github')
  })

  it('PROVIDERS map contains "gitlab"', () => {
    expect([...PROVIDERS.keys()]).toContain('gitlab')
  })

  it('returns the gitlab provider for "gitlab"', () => {
    expect(providerFor('gitlab')).toBe(gitlabProvider)
  })
})

describe('parseAnyUrl', () => {
  it('parses a valid GitHub PR URL', () => {
    const result = parseAnyUrl('https://github.com/owner/repo/pull/123')
    expect(result).not.toBeNull()
    expect(result!.provider).toBe(githubProvider)
    expect(result!.ref).toEqual({
      provider: 'github',
      owner: 'owner',
      repo: 'repo',
      number: 123,
    })
  })

  it('parses a GitHub PR URL with trailing slash', () => {
    const result = parseAnyUrl('https://github.com/myorg/myrepo/pull/42/')
    expect(result).not.toBeNull()
    expect(result!.ref.number).toBe(42)
    expect(result!.ref.owner).toBe('myorg')
    expect(result!.ref.repo).toBe('myrepo')
  })

  it('returns null for an unrecognized URL', () => {
    expect(parseAnyUrl('https://not-anything.com/foo')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseAnyUrl('')).toBeNull()
  })

  it('returns null for a plain non-URL string', () => {
    expect(parseAnyUrl('not a url at all')).toBeNull()
  })

  it('parses a gitlab.com MR URL now that GitLab is registered', () => {
    const result = parseAnyUrl('https://gitlab.com/owner/repo/-/merge_requests/1')
    expect(result).not.toBeNull()
    expect(result!.provider.id).toBe('gitlab')
    expect(result!.ref).toEqual({
      provider: 'gitlab',
      owner: 'owner',
      repo: 'repo',
      number: 1,
    })
  })
})
