import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import RevisionPicker from './RevisionPicker.svelte'
import type { PrCommit } from '../lib/github/commits'

function makeCommit(sha: string, message: string, shortSha?: string): PrCommit {
  return {
    sha,
    shortSha: shortSha ?? sha.slice(0, 7),
    message,
    authoredAt: '2024-01-01T00:00:00Z',
  }
}

const BASE_SHA = 'base0000000'

const COMMITS: PrCommit[] = [
  makeCommit('aaa111122223333', 'feat: first commit'),
  makeCommit('bbb444455556666', 'fix: second commit'),
  makeCommit('ccc777788889999', 'chore: third commit (the head)'),
]

interface PickerProps {
  commits: PrCommit[]
  baseSha: string
  active: { from: string; to: string } | null
  onselect: (from: string, to: string) => void
  onclear: () => void
}

function renderPicker(overrides: Partial<PickerProps> = {}) {
  const onselect = vi.fn()
  const onclear = vi.fn()
  const result = render(RevisionPicker, {
    props: {
      commits: COMMITS,
      baseSha: BASE_SHA,
      active: null,
      onselect,
      onclear,
      ...overrides,
    },
  })
  return { ...result, onselect, onclear }
}

// ---------------------------------------------------------------------------
// Options rendering
// ---------------------------------------------------------------------------

describe('RevisionPicker — options render', () => {
  it('renders "PR base" as first option in both selects', () => {
    renderPicker()
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(2)
    for (const select of selects) {
      const options = Array.from(select.querySelectorAll('option'))
      expect(options[0].value).toBe(BASE_SHA)
      expect(options[0].textContent).toBe('PR base')
    }
  })

  it('renders each commit as an option with shortSha + message (truncated to 40ch)', () => {
    const longMsg = 'a'.repeat(50)
    const commits = [makeCommit('abc123def456789', longMsg)]
    renderPicker({ commits })

    const selects = screen.getAllByRole('combobox')
    // The long message should be truncated with ellipsis
    const options = Array.from(selects[0].querySelectorAll('option'))
    const commitOpt = options.find(o => o.value === 'abc123def456789')
    expect(commitOpt).toBeDefined()
    // 7 chars shortSha + space + 40 chars + '…'
    expect(commitOpt!.textContent).toContain('abc123d')
    expect(commitOpt!.textContent).toContain('…')
    expect(commitOpt!.textContent!.length).toBeLessThan(60)
  })

  it('renders commit message as-is when <= 40 chars', () => {
    const commits = [makeCommit('abc1234def5678', 'feat: short message')]
    renderPicker({ commits })

    const selects = screen.getAllByRole('combobox')
    const options = Array.from(selects[0].querySelectorAll('option'))
    const commitOpt = options.find(o => o.value === 'abc1234def5678')
    expect(commitOpt!.textContent).toContain('feat: short message')
    expect(commitOpt!.textContent).not.toContain('…')
  })

  it('renders all commits (base + each commit) in both selects', () => {
    renderPicker()
    const selects = screen.getAllByRole('combobox')
    for (const select of selects) {
      const options = Array.from(select.querySelectorAll('option'))
      // 1 base + 3 commits
      expect(options).toHaveLength(4)
    }
  })
})

// ---------------------------------------------------------------------------
// onselect args
// ---------------------------------------------------------------------------

describe('RevisionPicker — onselect args', () => {
  it('calls onselect with (fromSha, toSha) when Compare is clicked with valid selection', async () => {
    const user = userEvent.setup()
    const { onselect } = renderPicker({
      active: { from: BASE_SHA, to: COMMITS[0].sha },
    })

    const applyBtn = screen.getByRole('button', { name: /apply revision comparison/i })
    await user.click(applyBtn)

    expect(onselect).toHaveBeenCalledOnce()
    expect(onselect).toHaveBeenCalledWith(BASE_SHA, COMMITS[0].sha)
  })

  it('does not call onselect when Compare is disabled (from >= to position)', async () => {
    const user = userEvent.setup()
    // Select from=head, to=base → invalid (head is position 2, base is position -1)
    const { onselect } = renderPicker({
      active: { from: COMMITS[2].sha, to: BASE_SHA },
    })

    const applyBtn = screen.getByRole('button', { name: /apply revision comparison/i })
    expect(applyBtn).toBeDisabled()
    await user.click(applyBtn)

    expect(onselect).not.toHaveBeenCalled()
  })

  it('calls onselect with correct shas after user changes selects', async () => {
    const user = userEvent.setup()
    const { onselect } = renderPicker()

    const [fromSelect, toSelect] = screen.getAllByRole('combobox')

    // Change from to first commit
    await user.selectOptions(fromSelect, COMMITS[0].sha)
    // Change to to third commit (head)
    await user.selectOptions(toSelect, COMMITS[2].sha)

    const applyBtn = screen.getByRole('button', { name: /apply revision comparison/i })
    expect(applyBtn).not.toBeDisabled()
    await user.click(applyBtn)

    expect(onselect).toHaveBeenCalledWith(COMMITS[0].sha, COMMITS[2].sha)
  })
})

// ---------------------------------------------------------------------------
// Quick links
// ---------------------------------------------------------------------------

describe('RevisionPicker — quick links', () => {
  it('"Last commit only" calls onselect with (second-to-last, head)', async () => {
    const user = userEvent.setup()
    const { onselect } = renderPicker()

    await user.click(screen.getByRole('button', { name: /last commit only/i }))

    expect(onselect).toHaveBeenCalledWith(
      COMMITS[1].sha, // second-to-last
      COMMITS[2].sha, // head
    )
  })

  it('"Last commit only" is disabled when fewer than 2 commits', () => {
    renderPicker({ commits: [COMMITS[0]] })
    expect(screen.getByRole('button', { name: /last commit only/i })).toBeDisabled()
  })

  it('"Full diff" calls onclear', async () => {
    const user = userEvent.setup()
    const { onclear } = renderPicker()

    await user.click(screen.getByRole('button', { name: /full diff/i }))

    expect(onclear).toHaveBeenCalledOnce()
  })

  it('"Full diff" is always enabled', () => {
    renderPicker({ commits: [] })
    expect(screen.getByRole('button', { name: /full diff/i })).not.toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Ordering guard
// ---------------------------------------------------------------------------

describe('RevisionPicker — ordering guard', () => {
  it('Compare button is disabled when from and to are the same commit', async () => {
    const user = userEvent.setup()
    renderPicker()

    const [fromSelect, toSelect] = screen.getAllByRole('combobox')
    await user.selectOptions(fromSelect, COMMITS[0].sha)
    await user.selectOptions(toSelect, COMMITS[0].sha)

    expect(screen.getByRole('button', { name: /apply revision comparison/i })).toBeDisabled()
  })

  it('Compare button is disabled when from comes after to in commit order', async () => {
    const user = userEvent.setup()
    renderPicker()

    const [fromSelect, toSelect] = screen.getAllByRole('combobox')
    // from = third commit (position 2), to = first commit (position 0) → invalid
    await user.selectOptions(fromSelect, COMMITS[2].sha)
    await user.selectOptions(toSelect, COMMITS[0].sha)

    expect(screen.getByRole('button', { name: /apply revision comparison/i })).toBeDisabled()
  })

  it('Compare button is enabled when from=base and to=first commit', async () => {
    const user = userEvent.setup()
    renderPicker()

    const [fromSelect, toSelect] = screen.getAllByRole('combobox')
    await user.selectOptions(fromSelect, BASE_SHA)
    await user.selectOptions(toSelect, COMMITS[0].sha)

    expect(screen.getByRole('button', { name: /apply revision comparison/i })).not.toBeDisabled()
  })

  it('base counts as position -1 — from=base, to=any commit is always valid', async () => {
    const user = userEvent.setup()
    renderPicker()

    const [fromSelect, toSelect] = screen.getAllByRole('combobox')
    await user.selectOptions(fromSelect, BASE_SHA)
    await user.selectOptions(toSelect, COMMITS[2].sha) // head

    expect(screen.getByRole('button', { name: /apply revision comparison/i })).not.toBeDisabled()
  })
})
