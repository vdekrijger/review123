# Review 1‑2‑3 — "Try a live demo (no setup)" onboarding

Branch: `feat/demo-review-onboarding`

## Problem

A brand‑new user must do a lot before seeing any value: sign in (OAuth) and/or paste an
API key, configure the AI model panel, then paste a public PR URL. We want a **one‑click
path** that shows the FULL review experience — the 3‑step Understand / Inspect / Verdict
flow, the diff viewer, and the AI summary / hotspots / skill findings / verdict — on a
BUNDLED example PR with PRE‑GENERATED AI output. No API key, no auth, no network, no LLM.
Then we nudge them to set up their own.

## Demo shape

- A prominent **"Try a live demo — no setup needed"** button on the Landing page, directly
  under the URL input. Always shown, but visually emphasized as the primary CTA when the
  user has configured **nothing** (no auth, no LLM key) — that's exactly the cold‑start
  user who benefits most. When they already have things set up it stays present but
  secondary (a quiet link), so it never nags returning users.
- Clicking navigates to **`/demo`**.
- The demo route renders the REAL review experience for a small, honest, self‑contained
  fixture PR: a plausible little bugfix/feature with 2 changed files and believable diffs.
- A **dismissible banner** at the top of the demo makes it unmistakable this is a demo:
  "📋 Demo — these results are pre‑generated. Add your API key or sign in to review real
  PRs →" linking to Settings / providers.
- AI state is constructed as already‑`'done'`: no spinners, no streaming, no LLM/network.
- **Read‑only**: drafting is allowed (the draft store is local IndexedDB/localStorage,
  no network) but there is NO submit path in the demo — VerdictStep's submit needs a
  provider + token and we never wire one. No GitHub/LLM `fetch` fires in demo mode.

## Rendering approach — (a) dedicated `/demo` route. WHY.

Two options were considered:

- **(a)** a dedicated `/demo` route that MOUNTS the existing display components
  (`Stepper`, `ContextRail`, `UnderstandStep`, `InspectStep`, `VerdictStep`) fed canned
  data, or
- **(b)** a `demo` flag threaded into the existing `Review.svelte` that short‑circuits the
  GitHub fetch + LLM run and injects the fixture.

**Chosen: (a).** Rationale:

- `Review.svelte` is ~1100 lines and tightly coupled to LIVE data: it creates
  `createPrLoad(...)` (GitHub fetch) and `createAiRun(...)` (LLM orchestration) internally,
  reads `load.state` in dozens of places, fetches comments / commits / CI / file contents,
  and wires provider methods. A `demo` flag would have to branch through ALL of that —
  high‑risk, invasive, and easy to leave a live `fetch` path reachable.
- A concurrent agent is editing `InspectStep.svelte` (dismiss persistence). Approach (a)
  touches **zero** internals of `InspectStep` / `FileDiff` — it only PASSES PROPS to them,
  exactly as `Review.svelte` does. No merge conflict surface.
- The display components consume a well‑defined `AiRun` interface plus plain props. We can
  build a synthetic `AiRun` (every panel `{status:'done', value}`, no‑op async methods,
  empty cost arrays) from the fixture and pass it straight in — the demo then looks
  byte‑identical to the product because it IS the product's display layer.
- Isolation: all demo data lives in `src/lib/demo/`; the route is a thin orchestrator. The
  live `Review.svelte` is untouched.

The only real cost of (a) is re‑implementing the small amount of view orchestration
(stepper nav, which step is active, rail collapse) — but that's ~120 lines of glue, far
less than the branching (b) would inject into a hot, shared, concurrently‑edited file.

## Files

- **`src/lib/demo/fixture.ts`** (new) — the bundled example PR:
  - `demoMeta: PrMeta` (title/author/sha/etc., `private:false`),
  - `demoFiles: PrFile[]` — 2 changed files with realistic unified‑diff `patch`es,
  - pre‑baked AI results matching the real schemas: `demoSummary` (string, with a
    reading‑order block the UI parses), `demoAttention: AttentionResult` (hotspots +
    testFlags), `demoVerdict: VerdictResult` (level + evidence), `demoTests: TestInsight`,
    and `demoSkillFindings: SkillReviewResult` (3 findings, varied severity, short bodies).
  - `DEMO_PR_KEY` constant for the local draft/viewed/decision stores.
- **`src/lib/demo/demoRun.ts`** (new) — `createDemoRun(): AiRun` builds a plain object
  satisfying the `AiRun` interface: panels `done` with the fixture values, `skillReviews`
  pre‑populated `done`, `totalUsage: undefined`, empty `verdictModels` /
  `modelPerformance` / `modelCostBreakdown`, and `start`/`retry`/`coach`/`ask`/
  `runSkillReviews`/`retrySkill` as inert no‑ops (coach/ask resolve to a benign
  `{error:'demo'}` shape so nothing ever calls the network).
- **`src/routes/Demo.svelte`** (new) — mounts `Stepper` + `ContextRail` +
  the three step components with the fixture + `createDemoRun()`, plus the demo banner.
  Owns local step state (1/2/3) without touching the router's `review` route. Creates
  real LOCAL stores (`createDraftStore`/`createViewedStore`) keyed by `DEMO_PR_KEY` —
  these are IndexedDB/localStorage only, never network.
- **`src/lib/router/router.svelte.ts`** (edit) — add `{ name: 'demo' }` to `Route`,
  match `/demo`.
- **`src/App.svelte`** (edit) — lazy‑load + render `Demo.svelte` on the `demo` route
  (same lazy pattern as `Review`, so the highlighter chunk stays out of the entry bundle).
- **`src/routes/Landing.svelte`** (edit) — add the demo CTA button under the input;
  emphasize when nothing is configured.

## Tests

- `src/routes/Demo.test.ts` — render `Demo.svelte`; assert: the summary, a hotspot, a
  skill finding body, and the verdict appear; AI panels show NO spinner/`aria-busy`
  loading state; and a `fetch` spy installed on `window`/`global` is NEVER called for a
  github.com / api.github.com / llm host (assert not called at all for external hosts).
- `src/routes/Landing.test.ts` (extend) — the demo CTA renders and navigates to `/demo`.
- `e2e/demo-onboarding.spec.ts` — land → click the demo CTA → the demo route renders with
  the banner + a finding + the verdict; the banner's set‑up CTA links to settings.

## Gates

`pnpm check` (0 errors), `pnpm test`, `CI=1 E2E_PORT=4303 pnpm exec playwright test`,
`pnpm build`. Calm typographic styling, reuse existing tokens. No external network/LLM in
demo mode (asserted).
