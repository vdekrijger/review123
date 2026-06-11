# Review 1-2-3 — Design

**Date:** 2026-06-11 (revised same day after controversy review)
**Status:** Approved pending final user review
**Mode:** proof-driven-dev, full pipeline

## Problem

Reviewing PRs is painful and slow in an AI-generated world: many PRs, each
requiring the reviewer to rebuild context from scratch. Review 1-2-3 takes a
GitHub PR URL and presents the change in a way optimized for building
understanding fast and reviewing with confidence — including whether behavior
is preserved.

## Product summary

Paste a GitHub PR URL → get a guided three-step review:

1. **Understand** — AI summary, behavior-change verdict, CI status summary,
   before/after architectural Mermaid diagrams.
2. **Inspect** — file diffs in AI-suggested reading order with attention
   (hotspot) highlighting and test-coverage flags; pinnable context rail.
3. **Verdict** — drafted comments recap, then approve / request changes /
   comment, submitted to GitHub as a real review.

## Scope

### v1 (must-have)

- Parse public **and** private GitHub PR URLs (private requires auth).
- **Auth: GitHub OAuth (primary) + PAT fallback.** OAuth sign-in via a
  single Vercel serverless function that performs the authorization-code
  exchange (it holds only the app's client secret; user tokens never touch
  our storage — the resulting token is returned to the browser and kept
  client-side). PAT entry remains in Settings as a fallback for
  self-hosters who don't want to register an OAuth app.
  **Incremental scopes:** initial sign-in requests `public_repo` only;
  opening a private PR triggers a re-authorization requesting `repo`.
  Most users never grant the broad scope. Deployment requires registering
  a GitHub OAuth app (callback URL + client secret in Vercel env) — this
  setup, including the local-dev story (second OAuth app or PAT), is
  documented in the README.
- Diff view: unified and side-by-side modes, GitHub-style red/green line
  coloring, word-level intra-line highlights.
- Full review write-back: draft line comments, submit a review with
  APPROVE / REQUEST_CHANGES / COMMENT via the GitHub API.
- WYSIWYG markdown editor for comments (toolbar + live preview; GitHub
  comments are markdown).
- **CI signals:** fetch check runs + annotations for the PR head SHA. Show
  a pass/fail summary in Understand; feed failed checks and annotation
  messages into the attention and behavior-verdict prompt context.
- **Private-code consent gate:** before any private-repo content is sent
  to DeepSeek, an explicit one-time confirmation ("This sends code from a
  private repo to DeepSeek — proceed?"), remembered per repo. Public repos
  skip the gate.
- AI features (all four), powered by a BYO DeepSeek API key:
  - **PR summary + walkthrough** — plain-language summary and a suggested
    file reading order.
  - **Attention highlighting** — flags hunks/files deserving extra scrutiny;
    maps changed code to covering tests and flags "behavior changed but no
    test touched". Test mapping is AI-inferred, not measured coverage, and
    is labeled as such in the UI.
  - **Mermaid before/after diagrams** — architectural view of the touched
    code in base state vs PR state. This is the primary "compare before and
    after the change" feature. **The LLM never emits Mermaid syntax**: it
    returns a structured graph (JSON nodes/edges/labels, schema-validated);
    we serialize to Mermaid deterministically in code. Prompting uses
    few-shot examples and selects diagram type by change shape (e.g. flow
    vs class/module graph).
  - **Behavior-change verdict** (formerly "confidence score") — categorical,
    three levels: *Behavior preserved* / *Minor behavioral changes* /
    *Significant behavioral changes*, with bulleted evidence and an explicit
    "not analyzed" list (e.g. files truncated for token budget). No
    percentages — we don't have calibration to back them.
- BYO DeepSeek key entered in Settings, stored in localStorage, sent only
  to DeepSeek directly. Keys/tokens are optional for browsing: with no
  DeepSeek key, AI panels show an "add a key" prompt and everything else
  (diff view, manual commenting flow up to submission) still works; signed
  out, public PRs are readable but review submission prompts for sign-in.
- Client-side AI-output cache so revisiting a PR re-spends zero tokens.
- PostHog product analytics (posthog-js).
- Deploys to Vercel: static SPA + the one OAuth exchange function.

### Nice-to-have (not v1, tracked)

- Interdiff: compare the PR's diff between two of its own revisions
  (e.g. before/after a force-push).
- Mining raw CI job logs (beyond check runs/annotations) for AI context —
  log downloads redirect to blob storage without CORS, so this likely needs
  the serverless tier; deferred.

### Future (explicitly deferred)

- Model switching (other LLM providers/models). v1 prepares for this by
  isolating all LLM calls behind `lib/llm/` with a configurable
  OpenAI-compatible base URL + model name.
- Shared/server-side caching of AI outputs.

## Architecture

Static SPA — **Vite + Svelte 5 + TypeScript** — deployed to Vercel, plus a
single serverless function (`/api/oauth/exchange`) whose only job is the
GitHub OAuth authorization-code exchange. No other backend; no user data or
user tokens stored server-side.

(Original approach comparison: pure static SPA chosen over a DeepSeek
rewrite proxy — unnecessary, DeepSeek CORS verified working 2026-06-11 —
and over full server routes. The OAuth function was added afterwards as a
deliberate, minimal exception to frontend-only. Escape hatch remains: if
DeepSeek drops CORS, a `vercel.json` rewrite proxy is a small change.)

Browser talks directly to:

1. **GitHub REST API** — PR metadata, per-file patches, before/after file
   contents at base/head SHAs, check runs + annotations; review submission.
   Tokenless works for public repos (60 req/h); OAuth token or PAT raises
   limits, unlocks private repos and writes.
2. **DeepSeek API** (`api.deepseek.com`, OpenAI-compatible, CORS confirmed) —
   four independent AI tasks as separate prompts so failures are isolated
   and results stream independently.
3. **PostHog** — client-side analytics. **Privacy rule: no code contents,
   no diffs, no keys/tokens, no repo identifiers of private repos in any
   event.** Only event names + coarse metadata (visibility, file count,
   language).

Persistence (client-side only):

- `localStorage`: OAuth token / PAT, DeepSeek key, preferences.
- IndexedDB: AI-output cache keyed by `repo#pr@headSHA` + task + prompt
  version; comment drafts (survive tab close).

Routing: `/` (landing: URL paste + settings) and
`/review/:owner/:repo/:number` (the stepper). Deep-linkable.

State: Svelte 5 runes; no external state library.

## UI design

Hybrid layout (validated via mockups): **guided 1-2-3 stepper** as the spine
with a **pinnable, collapsible context rail** available in all steps:

- Rail contents: summary (expandable), before/after diagram (click =
  full-screen overlay), hotspot list (click jumps to file), tests-touched
  indicator, behavior-change verdict with evidence expander.
- Step 1 (Understand) additionally shows the CI check summary (pass/fail
  counts, failed check names + annotations).
- Step 2 (Inspect): files stacked in AI reading order; high-attention files
  expanded with attention reason shown, low-attention files collapsed with a
  one-line reason ("rename only"); inline test-coverage warning blocks under
  affected files (labeled as AI-inferred); per-line comment affordance.
- Sticky bottom bar: step navigation + drafted-comment count.
- Diff blocks: GitHub-style red/green, unified/side-by-side toggle,
  word-level highlights.
- The diff view never waits on AI: GitHub data renders immediately, AI
  panels populate progressively as streams complete.

## Components

- **`lib/github/`** — GitHub API client. URL parsing, PR/diff/content/check
  fetching, review submission, OAuth token handling. No UI/AI knowledge.
- **`lib/llm/`** — DeepSeek client (OpenAI-compatible chat completions,
  streaming). One function per AI task: `summarize`, `analyzeAttention`,
  `generateDiagrams`, `assessBehavior`. Typed results, schema validation.
- **`lib/diagram/`** — deterministic graph-JSON → Mermaid serializer +
  graph schema. Pure, fully unit-testable.
- **`lib/context/`** — builds AI prompt context from GitHub data: selects
  changed files, trims lock files/generated code, packs before/after
  contents within a token budget, chunks/truncates oversized PRs, includes
  CI failures/annotations. Pure logic; the highest-risk module; heavily
  unit-tested.
- **`lib/cache/`** — IndexedDB cache for AI outputs.
- **`lib/settings/`** — tokens/keys + preferences (localStorage).
- **`lib/analytics/`** — typed PostHog event wrapper; the single choke-point
  enforcing the privacy rule.
- **`api/oauth/exchange`** — the one serverless function: receives the OAuth
  code + PKCE verifier, exchanges with GitHub using the app client secret,
  returns the token to the browser. Stateless, no logging of tokens.
- **UI:** `Stepper`, `UnderstandStep`, `InspectStep`, `VerdictStep`,
  `DiffView`, `ContextRail`, `CommentEditor` (WYSIWYG markdown),
  `SettingsPanel`, `SignIn`.

Libraries: `mermaid` for rendering; `@git-diff-view/svelte` for diffs — a
thin Svelte 5 wrapper over `@git-diff-view/core`, the same engine behind
the widely-used React package (~512k downloads/month), giving unified/split
modes and word-level highlights without hand-rolling; if the wrapper falls
short we render via the core package directly. WYSIWYG markdown editor
picked at planning (e.g. `carta-md`). Final picks during planning.

## Data flow

Paste URL → parse → parallel GitHub fetches (meta, patches, check runs) →
Step 1 renders skeleton immediately → `lib/context` packs context → four
DeepSeek calls fire in parallel, stream into their UI slots → results
cached on completion.

Comments: drafted locally (in-memory + IndexedDB), attached to file+line,
submitted in Step 3 as one GitHub review.

OAuth: Sign in → GitHub authorize (PKCE) → redirect back with code →
`/api/oauth/exchange` → token stored in localStorage → all GitHub calls
authenticated.

## Error handling

- **Bad URL / not found / private without auth** → specific inline message
  on landing page.
- **GitHub rate limit** → detect `403` + `X-RateLimit-Remaining: 0`, show
  reset time, suggest signing in.
- **OAuth failures** (denied, exchange error) → return to landing with
  message; PAT fallback always available.
- **DeepSeek failures** (auth, quota, timeout, CORS regression) → each AI
  panel fails independently with retry; review flow fully usable without AI.
  Invalid key → settings prompt.
- **Malformed AI output** (schema-invalid JSON) → one automatic repair retry
  (re-prompt with the validation error), then graceful "couldn't generate"
  state. Mermaid syntax errors are designed out (deterministic serializer);
  rendering still sandboxed as defense in depth.
- **Review submission failure** → drafts preserved until GitHub confirms
  success; GitHub's error shown verbatim.

## Security & supply chain

- DeepSeek key only in localStorage, sent only to DeepSeek. GitHub tokens
  (OAuth or PAT) only in localStorage, sent only to GitHub. The OAuth
  function holds the app's client secret but never stores or logs user
  tokens.
- Token-in-browser risk acknowledged: an XSS hole could leak a write-scoped
  token. Mitigations: strict CSP, PostHog as the only third-party script,
  incremental OAuth scopes (`public_repo` first, `repo` only on demand for
  private PRs), PAT users guided to fine-grained repo-scoped tokens.
- Private-repo code never reaches DeepSeek without the explicit per-repo
  consent gate (see Scope).
- **pnpm** is the package manager with `minimumReleaseAge: 10080`
  (7 days) configured, so freshly published package versions cannot be
  installed — mitigating npm supply-chain attacks.
- PostHog privacy rule enforced in `lib/analytics/` (see Architecture).
- Mermaid rendering sandboxed (`securityLevel: 'strict'`).

## Analytics (PostHog)

Typed events, indicative set: `pr_loaded` (visibility, file count, primary
language), `signed_in` (method: oauth|pat), `ai_task_completed` /
`ai_task_failed` (task name, duration, cached?), `diagram_viewed`,
`hotspot_clicked`, `ci_summary_viewed`, `comment_drafted`,
`review_submitted` (verdict type, comment count), `settings_key_added`
(which service, never the key). Exact schema finalized during planning.

## Testing

- **Unit (Vitest):** URL parsing, diff parsing, context packing (token
  budgets, file filtering, CI inclusion), graph-JSON → Mermaid serializer,
  cache keying, AI response schema validation. Pure logic with fixture PRs.
- **Component (Vitest + Testing Library):** DiffView modes + word-level
  highlights, stepper navigation, comment editor, settings, sign-in states.
- **E2E (Playwright):** full flow against MSW-mocked GitHub/DeepSeek
  fixtures: paste URL → diff renders → AI panels populate → draft comment →
  submit review (mocked). OAuth exchange function tested with a mocked
  GitHub token endpoint. One tokenless smoke test against a real public PR
  in CI.
- AI prompt **quality** is verified at the human checkpoint (non-
  deterministic); automated tests cover plumbing, not prose.

## Decision log

| Decision | Choice |
|---|---|
| Write-back scope | Full review actions (comment, approve, request changes) |
| Repo access | Public + private |
| Auth | **OAuth in v1** (one Vercel function for code exchange) + PAT fallback |
| OAuth scopes | **Incremental**: `public_repo` at sign-in, `repo` requested on first private PR |
| Private code → LLM | Explicit per-repo consent gate before sending private-repo content to DeepSeek |
| AI features in v1 | All four (summary, attention, diagrams, behavior verdict) |
| "Old vs new diff" feature | Reframed: architectural before/after (= Mermaid feature); commit-interdiff is nice-to-have |
| Confidence presentation | **Categorical 3-level behavior verdict + evidence; no percentages** |
| Diagram reliability | **LLM emits graph JSON; Mermaid serialized deterministically in code** |
| CI signals | **Check runs + annotations in v1**; raw log mining deferred |
| Stack | **Svelte 5 + TypeScript + Vite**, pnpm (React switch considered for diff-view ecosystem, reverted after finding `@git-diff-view/svelte`) |
| Architecture | Static SPA + single OAuth exchange function; client-side AI cache |
| Layout | 1-2-3 stepper + pinnable context rail (hybrid from mockups) |
| Comments | WYSIWYG markdown editor |
| Analytics | PostHog, client-side, strict privacy rule |
| Supply chain | pnpm `minimumReleaseAge` 7 days |
| Model switching | Deferred; enabled cheaply by `lib/llm/` abstraction |
| Test-coverage flags | AI-inferred, labeled as such in UI (not measured coverage) |
