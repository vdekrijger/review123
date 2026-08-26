/**
 * PreviewButton component tests — the header deploy-preview affordance.
 *
 * States:
 *   - preview=null → renders NOTHING (zero-cost absence, no settings row)
 *   - ready       → "Open preview ↗" link + panel toggle + state note
 *   - building    → no link; spinner + "building" note; no panel toggle
 *   - failed      → muted "preview failed" note; no link, no toggle
 * Freshness: deployment sha ≠ headSha → "1+ commits behind" note.
 * Panel toggle: click calls onTogglePanel; analytics preview_opened fires with
 * method 'tab' | 'panel' and NEVER a URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import PreviewButton from './PreviewButton.svelte'
import { track } from '../lib/analytics/analytics'
import type { PreviewDeployment } from '../lib/preview/preview'

vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

const HEAD = 'headsha1'

function preview(overrides: Partial<PreviewDeployment> = {}): PreviewDeployment {
  return {
    url: 'https://app-abc.vercel.app',
    providerName: 'vercel',
    state: 'ready',
    updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(), // 2m ago
    sha: HEAD,
    ...overrides,
  }
}

function renderButton(p: PreviewDeployment | null, panelOpen = false, onTogglePanel = vi.fn()) {
  render(PreviewButton, {
    props: { preview: p, headSha: HEAD, panelOpen, onTogglePanel },
  })
  return onTogglePanel
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PreviewButton — absent', () => {
  it('renders nothing when no preview was detected', () => {
    const { container } = render(PreviewButton, {
      props: { preview: null, headSha: HEAD, panelOpen: false, onTogglePanel: vi.fn() },
    })
    expect(container.querySelector('.preview-affordance')).toBeNull()
    expect(screen.queryByText(/Open preview/)).toBeNull()
  })
})

describe('PreviewButton — ready', () => {
  it('shows the Open preview link with the preview URL, new-tab + noopener', () => {
    renderButton(preview())
    const link = screen.getByRole('link', { name: /open deploy preview/i })
    expect(link).toHaveAttribute('href', 'https://app-abc.vercel.app')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows the state note: provider · ready · relative time', () => {
    renderButton(preview())
    expect(screen.getByText(/vercel · ready/)).toBeInTheDocument()
    expect(screen.getByText(/2m ago/)).toBeInTheDocument()
  })

  it('shows NO behind note when the deployment sha matches head', () => {
    renderButton(preview({ sha: HEAD }))
    expect(screen.queryByText(/commits behind/)).toBeNull()
  })

  it('shows "1+ commits behind" when the deployment sha differs from head', () => {
    renderButton(preview({ sha: 'oldersha' }))
    expect(screen.getByText('1+ commits behind')).toBeInTheDocument()
  })

  it('panel toggle calls onTogglePanel and reflects aria-pressed', async () => {
    const user = userEvent.setup()
    const onToggle = renderButton(preview(), false)
    const toggle = screen.getByRole('button', { name: 'Preview panel' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('aria-pressed is true when the panel is open', () => {
    renderButton(preview(), true)
    expect(screen.getByRole('button', { name: 'Preview panel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('fires preview_opened {method:tab} on link click — no URL in props', async () => {
    const user = userEvent.setup()
    renderButton(preview())
    await user.click(screen.getByRole('link', { name: /open deploy preview/i }))
    expect(track).toHaveBeenCalledWith('preview_opened', {
      method: 'tab',
      provider_name: 'vercel',
      state: 'ready',
    })
  })

  it('fires preview_opened {method:panel} only when OPENING the panel', async () => {
    const user = userEvent.setup()
    renderButton(preview(), false)
    await user.click(screen.getByRole('button', { name: 'Preview panel' }))
    expect(track).toHaveBeenCalledWith('preview_opened', {
      method: 'panel',
      provider_name: 'vercel',
      state: 'ready',
    })
  })

  it('does NOT fire preview_opened when CLOSING the panel', async () => {
    const user = userEvent.setup()
    renderButton(preview(), true)
    await user.click(screen.getByRole('button', { name: 'Preview panel' }))
    expect(track).not.toHaveBeenCalled()
  })
})

describe('PreviewButton — building', () => {
  it('shows a building note with the spinner token, no link, no toggle', () => {
    const { container } = render(PreviewButton, {
      props: {
        preview: preview({ state: 'building', url: '' }),
        headSha: HEAD,
        panelOpen: false,
        onTogglePanel: vi.fn(),
      },
    })
    expect(screen.getByText(/vercel · preview building/)).toBeInTheDocument()
    expect(container.querySelector('.ui-spinner')).not.toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview panel' })).toBeNull()
  })
})

describe('PreviewButton — failed', () => {
  it('shows a muted failure note, no link, no toggle', () => {
    renderButton(preview({ state: 'failed' }))
    expect(screen.getByText(/vercel · preview failed/)).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview panel' })).toBeNull()
  })
})
