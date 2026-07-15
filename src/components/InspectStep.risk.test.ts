import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { AttentionResult } from '../lib/ai/schemas'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => { localStorage.clear() })

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFile(filename: string, overrides: Partial<PrFile> = {}): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH, ...overrides }
}

function renderStep(files: PrFile[], attention: AttentionResult | null = null) {
  return render(InspectStep, {
    props: { files, changedFiles: files.length, mode: 'unified', onmode: () => {}, draftStore: null, attention },
  })
}

describe('InspectStep — per-file review-effort risk chip', () => {
  it('shows a risk chip for a high-churn added file without a hotspot', () => {
    const files = [makeFile('src/big-new.ts', { status: 'added', additions: 350 })]
    const { container } = renderStep(files)
    const chip = container.querySelector('.file-risk-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('review effort')
    expect(chip!.classList.contains('risk-medium')).toBe(true)
  })

  it('does NOT show a chip for a low-risk file (uncluttered rows)', () => {
    const files = [makeFile('src/tiny.ts', { additions: 5, deletions: 2 })]
    const { container } = renderStep(files)
    expect(container.querySelector('.file-risk-chip')).toBeNull()
  })

  it('does NOT double-render when risk is driven purely by the hotspot level', () => {
    const files = [makeFile('src/hot.ts', { additions: 5 })]
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/hot.ts', reason: 'risky', level: 'high' }],
      testFlags: [],
    }
    const { container } = renderStep(files, attention)
    // Hotspot badge renders …
    expect(container.querySelector('.hotspot-badge')).not.toBeNull()
    // … but the risk chip is suppressed (hotspot alone drives the level).
    expect(container.querySelector('.file-risk-chip')).toBeNull()
  })

  it('shows the chip alongside the hotspot badge when non-hotspot drivers add signal', () => {
    // Hotspot AND large added churn in a sensitive path: residual risk is
    // non-low even without the hotspot, so both render.
    const files = [makeFile('src/auth/big.ts', { status: 'added', additions: 400 })]
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/auth/big.ts', reason: 'risky', level: 'high' }],
      testFlags: [],
    }
    const { container } = renderStep(files, attention)
    expect(container.querySelector('.hotspot-badge')).not.toBeNull()
    const chip = container.querySelector('.file-risk-chip')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('risk-high')).toBe(true)
  })

  it('chip is advisory: title mentions estimate, not defect prediction', () => {
    const files = [makeFile('src/big-new.ts', { status: 'added', additions: 350 })]
    const { container } = renderStep(files)
    const chip = container.querySelector('.file-risk-chip') as HTMLElement
    expect(chip.getAttribute('title')).toMatch(/advisory/i)
    expect(chip.getAttribute('title')).toMatch(/not a defect prediction/i)
  })
})
