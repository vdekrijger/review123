/**
 * PreviewPanel.local.test.ts — the SECOND preview source: the reviewer's own
 * running app.
 *
 * Kept apart from PreviewPanel.test.ts so that file goes on asserting exactly
 * what it always did (the deploy path, untouched), and the source-selection
 * rule is visible as its own contract here.
 *
 * The contract, in one line: the panel frames the local app only when this PR
 * is genuinely checked out AND the dev server genuinely answers, it always
 * SAYS which of the two it is showing, and the deploy preview never becomes
 * unreachable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import PreviewPanel from './PreviewPanel.svelte'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetStackForTest, refreshStack } from '../lib/bridge/runPr.svelte'
import { BRIDGE_STORAGE_KEY } from '../lib/bridge/storage'

const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_SHA = 'def4567890abcdef1234567890abcdef12345678'
const TOKEN = 'pairing-token-0000000000000000000000000000'
const DEPLOY_URL = 'https://app-abc.vercel.app'
/** What `iframeSafeUrl` normalises DEPLOY_URL to — a bare origin gains a "/". */
const DEPLOY_SRC = 'https://app-abc.vercel.app/'

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

/**
 * Put the store into a given world: paired bridge, a checkout at `head`, and a
 * dev server that is or is not answering.
 */
async function seedStack(opts: {
  head: string
  appUrl?: string | null
  reachable?: boolean
}): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      protocol: 1,
      root: 'repo',
      capabilities: { inference: [], infer: true, files: true, search: true, checkout: true },
      git: { head: opts.head, branch: 'main', dirty: false },
      version: '0.1.0',
    }),
  )
  await connectBridge(TOKEN, 7321)

  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      git: { head: opts.head, branch: null, dirty: false },
      dirtyPaths: [],
      dirtyCount: 0,
      prior: null,
      app: {
        url: opts.appUrl === undefined ? 'http://localhost:8010' : opts.appUrl,
        source: 'posthog',
        reachable: opts.reachable !== false,
        detail: 'PostHog checkout.',
      },
      checkoutEnabled: true,
    }),
  )
  await refreshStack()
}

beforeEach(() => {
  localStorage.clear()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
  _resetBridgeForTest()
  _resetStackForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

function renderPanel(url = DEPLOY_URL) {
  return render(PreviewPanel, {
    props: { url, providerName: 'vercel', headSha: HEAD_SHA, onclose: vi.fn() },
  })
}

describe('PreviewPanel — local source', () => {
  it('frames the LOCAL app when this PR is checked out and the server answers', async () => {
    await seedStack({ head: HEAD_SHA })
    const { container } = renderPanel()

    const iframe = container.querySelector('iframe')
    expect(iframe).toHaveAttribute('src', 'http://localhost:8010')
    expect(iframe).toHaveAttribute('title', 'Your local app running this pull request')
    expect(screen.getByTestId('preview-panel-title')).toHaveTextContent(/your local app/i)
  })

  // Local beats the deploy preview because it is this PR against the
  // reviewer's OWN data — strictly more useful than a build on someone else's
  // infrastructure.
  it('prefers local over a ready deploy preview', async () => {
    await seedStack({ head: HEAD_SHA })
    const { container } = renderPanel(DEPLOY_URL)
    expect(container.querySelector('iframe')).toHaveAttribute('src', 'http://localhost:8010')
    expect(container.querySelector('.preview-panel')).toHaveAttribute('data-source', 'local')
  })

  it('ALWAYS says which source it is showing, and names the local URL', async () => {
    await seedStack({ head: HEAD_SHA })
    renderPanel()
    const line = screen.getByTestId('preview-source')
    expect(line).toHaveAttribute('data-reason', 'local-live')
    expect(line).toHaveTextContent('http://localhost:8010')
  })

  it('keeps an Open in new tab escape hatch for the local app too', async () => {
    await seedStack({ head: HEAD_SHA })
    renderPanel()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute(
      'href',
      'http://localhost:8010',
    )
  })

  // An http loopback URL must NOT go through iframeSafeUrl, which is an
  // https-only sanitizer for third-party deployment links — it would reject
  // every real dev server.
  it('does not apply the https-only deploy sanitizer to a loopback URL', async () => {
    await seedStack({ head: HEAD_SHA })
    const { container } = renderPanel()
    expect(container.querySelector('iframe')).not.toBeNull()
    expect(screen.queryByText(/can't be embedded/)).not.toBeInTheDocument()
  })
})

describe('PreviewPanel — falling back to deploy', () => {
  it('shows the DEPLOY preview when the checkout is on another commit', async () => {
    await seedStack({ head: OTHER_SHA })
    const { container } = renderPanel()
    expect(container.querySelector('iframe')).toHaveAttribute('src', DEPLOY_SRC)
    expect(container.querySelector('.preview-panel')).toHaveAttribute('data-source', 'deploy')
    expect(screen.getByTestId('preview-source')).toHaveAttribute('data-reason', 'deploy-only')
  })

  it('shows the DEPLOY preview when this PR is checked out but nothing is running', async () => {
    await seedStack({ head: HEAD_SHA, reachable: false })
    const { container } = renderPanel()
    expect(container.querySelector('iframe')).toHaveAttribute('src', DEPLOY_SRC)
  })

  it('shows the DEPLOY preview when no bridge is paired at all', () => {
    const { container } = renderPanel()
    expect(container.querySelector('iframe')).toHaveAttribute('src', DEPLOY_SRC)
    expect(screen.getByTestId('preview-panel-title')).toHaveTextContent(/deploy preview/i)
  })
})

describe('PreviewPanel — neither source', () => {
  // Two DIFFERENT things for the user to do about it, so two different
  // sentences. "No preview available" would leave them guessing.
  it('says CHECK IT OUT when the PR is not checked out and there is no deploy', async () => {
    await seedStack({ head: OTHER_SHA })
    renderPanel('')
    const line = screen.getByTestId('preview-source')
    expect(line).toHaveAttribute('data-reason', 'local-not-checked-out')
    expect(line).toHaveTextContent(/check this pull request out locally/i)
  })

  it('says START YOUR DEV SERVER when it is checked out but nothing answers', async () => {
    await seedStack({ head: HEAD_SHA, reachable: false })
    renderPanel('')
    const line = screen.getByTestId('preview-source')
    expect(line).toHaveAttribute('data-reason', 'local-not-running')
    expect(line).toHaveTextContent(/start your dev server/i)
    expect(line).toHaveTextContent('http://localhost:8010')
  })

  it('admits it does not know the port rather than naming a guessed one', async () => {
    await seedStack({ head: HEAD_SHA, appUrl: null, reachable: false })
    renderPanel('')
    const line = screen.getByTestId('preview-source')
    expect(line).toHaveTextContent(/could not tell where your dev server listens/i)
    expect(line).not.toHaveTextContent('5173')
  })

  it('renders no iframe and no dead link when there is nothing to frame', async () => {
    await seedStack({ head: OTHER_SHA })
    const { container } = renderPanel('')
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.queryByRole('link', { name: /open in new tab/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('preview-none')).toBeInTheDocument()
  })
})
