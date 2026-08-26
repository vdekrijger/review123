/**
 * PreviewPanel component tests — the embedded side-by-side preview panel.
 *
 * Hard-reality contract:
 *   - the fallback bar ("…site refuses embedding — Open in new tab ↗") is
 *     ALWAYS present — framing refusal is undetectable cross-origin, so there
 *     is no blank-detection heuristic to hide it behind
 *   - the iframe is sandboxed exactly "allow-scripts allow-same-origin
 *     allow-forms" and sends no referrer
 *   - the iframe src is SANITIZED: query/hash/credentials stripped (tokens
 *     never forwarded), https only; unframeable URLs render no iframe at all
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import PreviewPanel from './PreviewPanel.svelte'

function renderPanel(url = 'https://app-abc.vercel.app', onclose = vi.fn()) {
  const utils = render(PreviewPanel, {
    props: { url, providerName: 'vercel', onclose },
  })
  return { ...utils, onclose }
}

describe('PreviewPanel — fallback bar', () => {
  it('is always present, with an Open in new tab escape hatch', () => {
    renderPanel()
    expect(screen.getByText(/If the preview stays blank, the site refuses embedding/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /open in new tab/i })
    expect(link).toHaveAttribute('href', 'https://app-abc.vercel.app')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('stays present even when the URL is unframeable', () => {
    renderPanel('http://insecure.example.com')
    expect(screen.getByText(/If the preview stays blank/)).toBeInTheDocument()
  })
})

describe('PreviewPanel — iframe', () => {
  it('renders the iframe with the sanitized preview URL', () => {
    const { container } = renderPanel('https://app-abc.vercel.app/some/path')
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe).toHaveAttribute('src', 'https://app-abc.vercel.app/some/path')
    expect(iframe).toHaveAttribute('title', 'Deploy preview')
  })

  it('has EXACTLY the specified sandbox and no-referrer policy', () => {
    const { container } = renderPanel()
    const iframe = container.querySelector('iframe')
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')
  })

  it('never leaks tokens/query params into the iframe src', () => {
    const { container } = renderPanel(
      'https://app-abc.vercel.app/p?x-vercel-protection-bypass=SECRET&token=abc#frag',
    )
    const iframe = container.querySelector('iframe')
    expect(iframe).toHaveAttribute('src', 'https://app-abc.vercel.app/p')
    expect(iframe?.getAttribute('src')).not.toContain('SECRET')
    expect(iframe?.getAttribute('src')).not.toContain('token')
  })

  it('renders NO iframe for a non-https URL — the explanation shows instead', () => {
    const { container } = renderPanel('http://insecure.example.com')
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText(/can't be embedded/)).toBeInTheDocument()
  })
})

describe('PreviewPanel — close', () => {
  it('close button calls onclose', async () => {
    const user = userEvent.setup()
    const { onclose } = renderPanel()
    await user.click(screen.getByRole('button', { name: 'Close preview panel' }))
    expect(onclose).toHaveBeenCalledTimes(1)
  })
})
