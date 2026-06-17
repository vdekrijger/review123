import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import BuildIndicator from './BuildIndicator.svelte'
import { BUILD_SHA, repoUrl } from '../lib/buildInfo'

describe('BuildIndicator', () => {
  it('renders the build sha text in a muted footer', () => {
    const { container } = render(BuildIndicator)
    const footer = container.querySelector('footer.build-indicator')
    expect(footer).not.toBeNull()
    expect(footer?.textContent).toContain('build')
    // Under vitest BUILD_SHA falls back to 'test'.
    expect(footer?.textContent).toContain(BUILD_SHA)
  })

  it('renders the sha as plain text (no commit link) for the sentinel test sha', () => {
    const { container } = render(BuildIndicator)
    // 'test' is a non-commit sentinel, so no COMMIT anchor should be rendered.
    expect(container.querySelector('footer.build-indicator a.commit-link')).toBeNull()
  })

  it('always renders a GitHub source link to the repository', () => {
    const { container } = render(BuildIndicator)
    const gh = container.querySelector<HTMLAnchorElement>('footer.build-indicator a.gh-link')
    expect(gh).not.toBeNull()
    expect(gh?.getAttribute('href')).toBe(repoUrl)
    expect(gh?.getAttribute('aria-label')).toContain('GitHub')
  })
})
