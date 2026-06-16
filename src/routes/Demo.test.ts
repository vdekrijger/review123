import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/svelte'
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

    // Step 2 (Inspect) — a skill reviewer finding body appears inline in the diff.
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))
    expect(
      (await screen.findAllByText(/an attacker probing the search endpoint/i)).length,
    ).toBeGreaterThan(0)

    expect(externalFetchCalls()).toEqual([])
  })

  it('shows MULTIPLE reviewer personas on the Inspect step', async () => {
    render(Demo)
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))

    // Several distinct reviewer personas render (names appear in the settled
    // result bar AND inline on each finding card → match all occurrences).
    expect((await screen.findAllByText(/Security Reviewer \(OWASP-minded\)/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Performance Reviewer/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Pragmatic Senior Reviewer/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/Resiliency & SRE Reviewer/i)).toBeInTheDocument()

    // The empty reviewer shows the "no significant issues" state.
    expect(screen.getByText(/no significant issues/i)).toBeInTheDocument()

    expect(externalFetchCalls()).toEqual([])
  })

  it('shows a CONFIRMED cross-model finding with a "raised by" provenance chip', async () => {
    render(Demo)
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))

    // The Security reviewer's inline finding carries cross-model verification:
    // a "✓ confirmed by 3/4 models" chip + the multi-generator provenance chip.
    // (Inline + side-by-side rendering can repeat it → match all occurrences.)
    expect((await screen.findAllByText(/confirmed by 3\/4 models/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/raised by GPT-5\.5, DeepSeek V4 Pro/i).length).toBeGreaterThan(0)

    expect(externalFetchCalls()).toEqual([])
  })

  it('shows a DEMOTED / lower-confidence cross-model finding', async () => {
    render(Demo)
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))

    // The Performance reviewer's inline finding was flagged by only one model and
    // refuted by the rest → the dimmed "flagged by 1/5 · lower confidence" chip.
    expect((await screen.findAllByText(/flagged by 1\/5 · lower confidence/i)).length).toBeGreaterThan(0)

    expect(externalFetchCalls()).toEqual([])
  })

  it('shows the Story|Files toggle on the Inspect step and renders the walkthrough when Story is chosen', async () => {
    render(Demo)
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))

    // The Story|Files flow toggle is present (story panel is pre-'done').
    const storyBtn = await screen.findByRole('button', { name: /^Story$/ })
    const filesBtn = screen.getByRole('button', { name: /^Files$/ })
    expect(storyBtn).toBeInTheDocument()
    expect(filesBtn).toBeInTheDocument()

    // Defaults to Files: the canned walkthrough's first caption is NOT shown yet
    // (captions render markdown, so match a plain-text fragment that isn't split
    // across `code`/`strong` spans).
    expect(screen.queryByText(/so a request can be aborted mid-flight/i)).toBeNull()

    // Switch to Story → the walkthrough renders: the data-layer first step's
    // caption (plain-text fragment) + its layer chip + the "1 of 6" step counter.
    await fireEvent.click(storyBtn)
    expect(
      await screen.findByText(/so a request can be aborted mid-flight/i),
    ).toBeInTheDocument()
    expect(screen.getByText('Data model')).toBeInTheDocument()
    expect(document.querySelector('.story-counter')?.textContent).toMatch(/1 of 6/)

    // Walking forward reveals the next layer's caption (the API step). Two
    // "Next step" buttons now exist (the slideshow nav + the demo draft-bar);
    // the slideshow's lives inside the .story region — click that one.
    const controls = document.querySelector('.story-controls') as HTMLElement
    const slideNext = within(controls).getByRole('button', { name: /next step/i })
    await fireEvent.click(slideNext)
    expect(
      await screen.findByText(/so cancelling a request actually reaches the network/i),
    ).toBeInTheDocument()
    expect(screen.getByText('API / service')).toBeInTheDocument()

    expect(externalFetchCalls()).toEqual([])
  })

  it('shows the Step-3 cost & model-performance panel with $ and per-model rows', async () => {
    render(Demo)
    // Jump to step 3 (Verdict).
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))

    // The consolidated cost panel renders with the aggregate $ headline (demo
    // turns showTokenCost on) and the per-model performance breakdown.
    const panel = await screen.findByRole('region', {
      name: /review cost and model performance/i,
    })
    expect(panel).toBeInTheDocument()
    expect(screen.getByText(/this review used .* total/i)).toBeInTheDocument()
    // Both generators and a verifier model id appear as rows.
    expect(screen.getByText('deepseek-v4-pro')).toBeInTheDocument()
    expect(screen.getByText('gpt-5.5')).toBeInTheDocument()
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument()
    // Generator impact (surfaced findings + unique catch) reads through (both
    // generators caught one unique finding → match all occurrences).
    expect(screen.getAllByText(/caught 1 the others missed/i).length).toBeGreaterThan(0)

    expect(externalFetchCalls()).toEqual([])
  })
})
