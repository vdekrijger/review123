import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import { setTestFileDisplay } from '../lib/settings/settings'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => { localStorage.clear() })

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH }
}

describe('InspectStep — test-file display modes', () => {
  it('highlight mode: test file header has test-highlight class', () => {
    setTestFileDisplay('highlight')
    const files = [makeFile('src/foo.test.ts'), makeFile('src/bar.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null }
    })
    const highlights = container.querySelectorAll('header.test-highlight')
    expect(highlights.length).toBe(1)
  })

  it('dim mode: test file article has test-dim class', () => {
    setTestFileDisplay('dim')
    const files = [makeFile('src/foo.test.ts'), makeFile('src/bar.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null }
    })
    const dims = container.querySelectorAll('article.file-diff.test-dim')
    expect(dims.length).toBe(1)
  })

  it('normal mode: no test-highlight or test-dim classes at all', () => {
    setTestFileDisplay('normal')
    const files = [makeFile('src/foo.test.ts'), makeFile('src/bar.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null }
    })
    expect(container.querySelector('.test-highlight')).not.toBeInTheDocument()
    expect(container.querySelector('.test-dim')).not.toBeInTheDocument()
  })
})
