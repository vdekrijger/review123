import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/svelte'
import Demo from './Demo.svelte'
import { navigate } from '../lib/router/router.svelte'
import { saveGithubAuth } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'

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
    // Start every test signed OUT with a clean settings/auth slate so the
    // standalone cost-panel gating is deterministic (signed-out by default).
    localStorage.clear()
    _resetAuthStateForTest()
    // Install a fetch spy. If the demo ever tries to fetch an external host the
    // test fails; we still return a never-resolving promise so nothing throws.
    fetchSpy = vi.fn(() => new Promise(() => {})) as unknown as ReturnType<typeof vi.fn>
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    _resetAuthStateForTest()
  })

  /**
   * Count the "Review cost & model performance" panels currently rendered. The
   * panel is a <section role="region" aria-label="Review cost and model
   * performance">; on the verdict step there must be EXACTLY ONE regardless of
   * auth state (VerdictStep renders its own when signed in; Demo renders the
   * standalone one when signed out).
   */
  function countCostPanels(): number {
    return screen.queryAllByRole('region', {
      name: /review cost and model performance/i,
    }).length
  }

  async function gotoVerdictStep(): Promise<void> {
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))
  }

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
    // the single "✓ verified" trust chip (vote detail in the accessible name /
    // hover tooltip) + the multi-generator provenance chip.
    const chips = await screen.findAllByText('✓ verified')
    expect(chips.length).toBeGreaterThan(0)
    expect(chips[0].getAttribute('aria-label')).toContain('confirmed by 3 of 4 models')
    expect(screen.getAllByText(/raised by GPT-5\.5, DeepSeek V4 Pro/i).length).toBeGreaterThan(0)

    expect(externalFetchCalls()).toEqual([])
  })

  it('collapses DEMOTED / minor findings into per-file groups with a review-level triage line', async () => {
    render(Demo)
    await fireEvent.click(screen.getByRole('button', { name: /next step/i }))
    await screen.findAllByText('✓ verified') // reviewers rendered

    // The Performance reviewer's demoted finding (flagged by 1/5, refuted) and
    // the Pragmatic reviewer's lone low note collapse into per-file secondary
    // groups — the old inline "flagged by 1/5 · lower confidence" chrome is gone.
    expect(screen.queryByText(/flagged by 1\/5/i)).toBeNull()
    expect(screen.queryByText(/lower confidence/i)).toBeNull()
    const groups = document.querySelectorAll('[data-testid="secondary-findings"]')
    expect(groups.length).toBe(2)
    for (const group of groups) {
      expect(group.querySelector('summary')?.textContent).toContain('1 more finding — low confidence or minor')
    }
    // The demoted card lives INSIDE a group (full card, actions intact).
    const demoted = screen.getByText(/A fixed 250ms debounce may feel sluggish/i)
    expect(demoted.closest('[data-testid="secondary-findings"]')).not.toBeNull()

    // Review-level triage line: 1 of 3 line-bearing findings inline + Show all.
    const line = document.querySelector('[data-testid="findings-triage-line"]')
    expect(line?.textContent).toContain('Showing 1 of 3 findings')
    expect(line?.textContent).toContain('2 minor or low-confidence collapsed')
    expect(line?.querySelector('[data-testid="findings-show-all"]')).not.toBeNull()

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

  it('renders EXACTLY ONE cost panel on the verdict step when SIGNED OUT', async () => {
    // Default beforeEach state is signed out — the standalone ReviewCostPanel
    // shows (VerdictStep itself only shows a sign-in prompt, no cost panel).
    render(Demo)
    await gotoVerdictStep()

    expect(
      await screen.findByRole('region', { name: /review cost and model performance/i }),
    ).toBeInTheDocument()
    expect(countCostPanels()).toBe(1)

    expect(externalFetchCalls()).toEqual([])
  })

  it('renders EXACTLY ONE cost panel on the verdict step when SIGNED IN (no duplicate)', async () => {
    // Sign in BEFORE rendering: VerdictStep now renders its OWN cost panel in
    // the signed-in form branch, so Demo must NOT also render the standalone one
    // — exactly one panel, no duplicate (the bug being fixed).
    saveGithubAuth({ token: 'gho_demo_signedin', method: 'oauth', scopes: ['public_repo'] })
    _resetAuthStateForTest()

    render(Demo)
    await gotoVerdictStep()

    expect(
      await screen.findByRole('region', { name: /review cost and model performance/i }),
    ).toBeInTheDocument()
    expect(countCostPanels()).toBe(1)

    expect(externalFetchCalls()).toEqual([])
  })

  it('renders the change-impact diagram on the Understand step (done, not "enable in settings")', async () => {
    render(Demo)

    // The diagrams section reaches the rendered/done state: DiagramPanel's
    // static "Change impact" heading renders (blast-radius view) — the impact
    // diagram's own nodes render into an async Mermaid SVG (not asserted here as
    // jsdom has no real SVG layout).
    // (Appears on the page section AND in the ContextRail → match all.)
    expect((await screen.findAllByText(/Change impact/i)).length).toBeGreaterThan(0)

    // The diagrams panel is NOT the muted "Disabled — enable in AI settings"
    // state (that copy lives inside .diagrams-panel when status==='disabled').
    const diagramsPanel = document.querySelector('.diagrams-panel')
    expect(diagramsPanel).not.toBeNull()
    expect(diagramsPanel?.querySelector('.ai-panel-disabled')).toBeNull()

    expect(externalFetchCalls()).toEqual([])
  })
})
