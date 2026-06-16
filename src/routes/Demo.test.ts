import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import Demo from './Demo.svelte'
import { navigate } from '../lib/router/router.svelte'

// Mock navigate so the banner CTA can be asserted without touching the router.
vi.mock('../lib/router/router.svelte', () => ({
  navigate: vi.fn(),
}))

// DiffView uses canvas.getContext('2d') for text measurement — jsdom has no
// canvas. Stub it so InspectStep's diff cards can mount without throwing.
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ font: '', measureText: (_t: string) => ({ width: 0 }) }),
    writable: true,
  })
})

/**
 * Hosts that the demo must NEVER contact. The whole point of the demo is that it
 * runs with zero external network: no GitHub API, no LLM provider.
 */
const EXTERNAL_HOST_RE = /github\.com|githubusercontent|gitlab|bitbucket|deepseek|openai|anthropic|api\./i

describe('Demo route', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(navigate).mockClear()
    // Install a fetch spy. If the demo ever tries to fetch an external host the
    // test fails; we still return a never-resolving promise so nothing throws.
    fetchSpy = vi.fn(() => new Promise(() => {})) as unknown as ReturnType<typeof vi.fn>
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function externalFetchCalls(): string[] {
    return fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((url) => EXTERNAL_HOST_RE.test(url))
  }

  it('renders the pre-generated summary with no spinner and no external fetch', async () => {
    render(Demo)

    // Summary text from the fixture is present (AI panel is in a done state).
    // It appears in both the TL;DR glance line and the full summary, so match all.
    expect((await screen.findAllByText(/fixes a race condition in the search box/i)).length).toBeGreaterThan(0)

    // No loading/busy spinner anywhere — the demo is fully pre-generated.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()

    // Zero external network calls (github / llm / etc.).
    expect(externalFetchCalls()).toEqual([])
  })

  it('shows the demo banner with a set-up CTA that navigates to settings', async () => {
    render(Demo)

    expect(screen.getByText(/these results are pre‑generated/i)).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /add your api key or sign in/i })
    await fireEvent.click(cta)
    expect(vi.mocked(navigate)).toHaveBeenCalledWith('/settings/providers')

    expect(externalFetchCalls()).toEqual([])
  })

  it('renders the verdict evidence on the Understand step', async () => {
    render(Demo)

    // The pre-generated verdict evidence renders in the Understand step's
    // "Verdict evidence" panel (closed <details> still render their DOM).
    expect(
      await screen.findByText(/Adds a 250ms debounce in useSearch/i),
    ).toBeInTheDocument()

    expect(externalFetchCalls()).toEqual([])
  })

  it('renders a skill reviewer finding on the Inspect step without network', async () => {
    render(Demo)

    // Step 2 (Inspect) — the skill reviewer finding body appears.
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))
    expect(
      await screen.findByText(/does not show src\/search\/api\.ts honouring it/i),
    ).toBeInTheDocument()

    expect(externalFetchCalls()).toEqual([])
  })
})
