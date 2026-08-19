import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { jumpToDiffLine, JUMP_FLASH_CLASS } from './jumpToLine'

/** Build the InspectStep-shaped wrapper + a diff row for a line. */
function buildFileCard(path: string, opts: { newLine?: number; oldLine?: number; splitNewLine?: number }) {
  // slugify('src/a.ts') → 'src-a-ts'
  const slug = path.replace(/[^a-zA-Z0-9]/g, '-')
  const wrapper = document.createElement('div')
  wrapper.id = `file-${slug}`
  const article = document.createElement('article')
  article.className = 'file-diff'
  const table = document.createElement('table')
  const tbody = document.createElement('tbody')
  const tr = document.createElement('tr')
  const td = document.createElement('td')
  if (opts.newLine !== undefined) {
    const span = document.createElement('span')
    span.setAttribute('data-line-new-num', String(opts.newLine))
    td.appendChild(span)
  }
  if (opts.oldLine !== undefined) {
    const span = document.createElement('span')
    span.setAttribute('data-line-old-num', String(opts.oldLine))
    td.appendChild(span)
  }
  if (opts.splitNewLine !== undefined) {
    td.className = 'diff-line-new-num'
    const span = document.createElement('span')
    span.setAttribute('data-line-num', String(opts.splitNewLine))
    td.appendChild(span)
  }
  tr.appendChild(td)
  tbody.appendChild(tr)
  table.appendChild(tbody)
  article.appendChild(table)
  wrapper.appendChild(article)
  document.body.appendChild(wrapper)
  return { wrapper, tr }
}

beforeEach(() => {
  document.body.innerHTML = ''
  // jsdom has no scrollIntoView — install a spyable stub (same as jumpToFile.test.ts)
  Element.prototype.scrollIntoView = vi.fn()
  // Keep retry loops inert so a not-found jump can't leak frames across tests.
  vi.stubGlobal('requestAnimationFrame', () => 0)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('jumpToDiffLine', () => {
  it('scrolls to and flashes the unified row for a new-side line', () => {
    vi.useFakeTimers()
    const { tr } = buildFileCard('src/a.ts', { newLine: 7 })
    jumpToDiffLine('src/a.ts', 7, 'new')
    expect(tr.classList.contains(JUMP_FLASH_CLASS)).toBe(true)
    expect(tr.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    // The flash class clears after its timeout.
    vi.advanceTimersByTime(2000)
    expect(tr.classList.contains(JUMP_FLASH_CLASS)).toBe(false)
  })

  it('finds old-side rows via data-line-old-num', () => {
    const { tr } = buildFileCard('src/b.ts', { oldLine: 3 })
    jumpToDiffLine('src/b.ts', 3, 'old')
    expect(tr.classList.contains(JUMP_FLASH_CLASS)).toBe(true)
  })

  it('finds split-mode rows via the side num cell', () => {
    const { tr } = buildFileCard('src/c.ts', { splitNewLine: 12 })
    jumpToDiffLine('src/c.ts', 12, 'new')
    expect(tr.classList.contains(JUMP_FLASH_CLASS)).toBe(true)
  })

  it('does not match the wrong side or line', () => {
    const { tr } = buildFileCard('src/d.ts', { newLine: 5 })
    jumpToDiffLine('src/d.ts', 5, 'old') // wrong side
    expect(tr.classList.contains(JUMP_FLASH_CLASS)).toBe(false)
    jumpToDiffLine('src/d.ts', 6, 'new') // wrong line
    expect(tr.classList.contains(JUMP_FLASH_CLASS)).toBe(false)
  })

  it('retries across animation frames while the row mounts (card expansion)', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    jumpToDiffLine('src/late.ts', 2, 'new')
    expect(rafCallbacks.length).toBeGreaterThan(0)
    // Row mounts between frames.
    const { tr } = buildFileCard('src/late.ts', { newLine: 2 })
    const before = rafCallbacks.length
    rafCallbacks[before - 1](0)
    expect(tr.classList.contains(JUMP_FLASH_CLASS)).toBe(true)
  })

  it('degrades silently when the file card does not exist', () => {
    expect(() => jumpToDiffLine('missing/file.ts', 1, 'new')).not.toThrow()
  })
})
