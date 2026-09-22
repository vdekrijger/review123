/**
 * InspectStep — the test-file display modes (highlight / dim / normal).
 *
 * PHASE NOTE: these fixtures mix an implementation file with a test file, so
 * review phases (src/lib/guide/phase.svelte) engage and the Implementation
 * phase — the default — hides the test file entirely. The display modes style
 * a RENDERED test file, so each case puts the component in the Tests phase
 * first. That the Implementation phase hides it is covered in
 * InspectStep.phase.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import { setTestFileDisplay } from '../lib/settings/settings'
import { setReviewPhase } from '../lib/guide/phase.svelte'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  // Standalone renders fall into the 'local' phase bucket (currentPrKey()).
  setReviewPhase('local', 'tests')
})

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
