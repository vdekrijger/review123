/**
 * Tests for prWebUrl(ref) — provider-native web URL construction.
 *
 * Pure URL construction (no network). Covers:
 *  - GitHub: /pull/{number}
 *  - GitLab: default gitlab.com, configured self-hosted host, subgroup owner
 *  - Bitbucket: /pull-requests/{number}
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { githubProvider } from './github'
import { gitlabProvider } from './gitlab'
import { bitbucketProvider } from './bitbucket'
import { setGitlabHost } from '../settings/settings'
import type { PrRefX } from './types'

describe('prWebUrl', () => {
  beforeEach(() => localStorage.clear())

  describe('github', () => {
    it('builds the canonical pull request URL', () => {
      const ref: PrRefX = { provider: 'github', owner: 'PostHog', repo: 'posthog', number: 63251 }
      expect(githubProvider.prWebUrl(ref)).toBe('https://github.com/PostHog/posthog/pull/63251')
    })
  })

  describe('gitlab', () => {
    it('defaults to gitlab.com when no host is configured', () => {
      const ref: PrRefX = { provider: 'gitlab', owner: 'mygroup', repo: 'myproject', number: 42 }
      expect(gitlabProvider.prWebUrl(ref)).toBe(
        'https://gitlab.com/mygroup/myproject/-/merge_requests/42',
      )
    })

    it('uses the configured self-hosted host', () => {
      setGitlabHost('gitlab.mycompany.com')
      const ref: PrRefX = { provider: 'gitlab', owner: 'mygroup', repo: 'myproject', number: 7 }
      expect(gitlabProvider.prWebUrl(ref)).toBe(
        'https://gitlab.mycompany.com/mygroup/myproject/-/merge_requests/7',
      )
    })

    it('preserves a subgroup owner path (slashes not encoded)', () => {
      const ref: PrRefX = { provider: 'gitlab', owner: 'org/sub', repo: 'project', number: 9 }
      expect(gitlabProvider.prWebUrl(ref)).toBe(
        'https://gitlab.com/org/sub/project/-/merge_requests/9',
      )
    })

    it('preserves a subgroup owner on a self-hosted host', () => {
      setGitlabHost('internal.gitlab.corp')
      const ref: PrRefX = { provider: 'gitlab', owner: 'org/team/sub', repo: 'project', number: 3 }
      expect(gitlabProvider.prWebUrl(ref)).toBe(
        'https://internal.gitlab.corp/org/team/sub/project/-/merge_requests/3',
      )
    })
  })

  describe('bitbucket', () => {
    it('builds the canonical pull-requests URL', () => {
      const ref: PrRefX = { provider: 'bitbucket', owner: 'myworkspace', repo: 'myrepo', number: 12 }
      expect(bitbucketProvider.prWebUrl(ref)).toBe(
        'https://bitbucket.org/myworkspace/myrepo/pull-requests/12',
      )
    })
  })
})
