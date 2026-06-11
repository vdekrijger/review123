# Review 1-2-3 — Design

**Date:** 2026-06-11
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

1. **Understand** — AI summary, behavior-preservation confidence score,
   before/after architectural Mermaid diagrams.
2. **Inspect** — file diffs in AI-suggested reading order with attention
   (hotspot) highlighting and test-coverage flags; pinnable context rail.
3. **Verdict** — drafted comments recap, then approve / request changes /
   comment, submitted to GitHub as a real review.

## Scope

### v1 (must-have)

- Parse public **and** private GitHub PR URLs (private requires a GitHub PAT).
- Diff view: unified and side-by-side modes, GitHub-style red/green line
  coloring, word-level intra-line highlights.
- Full review write-back: draft line comments, submit a review with
  APPROVE / REQUEST_CHANGES / COMMENT via the GitHub API.
- WYSIWYG markdown editor for comments (toolbar + live preview; GitHub
  comments are markdown).
- AI features (all four), powered by a BYO DeepSeek API key:
  - **PR summary + walkthrough** — plain-language summary and a suggested
    file reading order.
  - **Attention highlighting** — flags hunks/files deserving extra scrutiny;
    maps changed code to covering tests and flags "behavior changed but no
    test touched".
  - **Mermaid before/after diagrams** — architectural view of the touched
    code in base state vs PR state. This is the primary "compare before and
    after the change" feature.
  - **Confidence score** — overall behavior-preservation score with
    reasoning ("why?" expander).
- BYO keys: GitHub PAT + DeepSeek key, entered in a settings panel, stored
  in localStorage, never sent anywhere except to GitHub / DeepSeek directly.
  Both are optional for browsing: with no DeepSeek key, AI panels show an
  "add a key" prompt and everything else (diff view, manual commenting flow
  up to submission) still works; with no GitHub PAT, public PRs are readable
  but review submission prompts for a token.
- Client-side AI-output cache so revisiting a PR re-spends zero tokens.
- PostHog product analytics (posthog-js).
- Deploys to Vercel as a static site.

### Nice-to-have (not v1, tracked)

- Interdiff: compare the PR's diff between two of its own revisions
  (e.g. before/after a force-push).

### Future (explicitly deferred)

- Model switching (other LLM providers/models). v1 prepares for this by
  isolating all LLM calls behind `lib/llm/` with a configurable
  OpenAI-compatible base URL + model name.
- Shared/server-side caching of AI outputs (would require a backend).

## Architecture

Pure static SPA — **Vite + Svelte 5 + TypeScript**, deployed to Vercel as
static files. No backend. Chosen over (B) a Vercel rewrite proxy for DeepSeek
(unnecessary — DeepSeek CORS verified working 2026-06-11; would create an
abusable open proxy) and (C) SvelteKit server routes (violates frontend-only
constraint; caching benefit assumes multi-user usage v1 doesn't have).
Escape hatch: if DeepSeek ever drops CORS, upgrading to (B) is a small
`vercel.json` change.

Browser talks directly to:

1. **GitHub REST API** — PR metadata, per-file patches, before/after file
   contents at base/head SHAs; review submission. Tokenless works for public
   repos (60 req/h); PAT raises limits, unlocks private repos and writes.
2. **DeepSeek API** (`api.deepseek.com`, OpenAI-compatible, CORS confirmed) —
   four independent AI tasks as separate prompts so failures are isolated
   and results stream independently.
3. **PostHog** — client-side analytics. **Privacy rule: no code contents,
   no diffs, no keys, no repo identifiers of private repos in any event.**
   Only event names + coarse metadata (visibility, file count, language).

Persistence (client-side only):

- `localStorage`: keys, preferences.
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
  indicator, confidence score with "why?" expander.
- Step 2 (Inspect): files stacked in AI reading order; high-attention files
  expanded with attention reason shown, low-attention files collapsed with a
  one-line reason ("rename only"); inline test-coverage warning blocks under
  affected files; per-line comment affordance.
- Sticky bottom bar: step navigation + drafted-comment count.
- Diff blocks: GitHub-style red/green, unified/side-by-side toggle,
  word-level highlights.
- The diff view never waits on AI: GitHub data renders immediately, AI
  panels populate progressively as streams complete.

## Components

- **`lib/github/`** — GitHub API client. URL parsing, PR/diff/content
  fetching, review submission. No UI/AI knowledge.
- **`lib/llm/`** — DeepSeek client (OpenAI-compatible chat completions,
  streaming). One function per AI task: `summarize`, `analyzeAttention`,
  `generateDiagrams`, `scoreConfidence`. Typed results.
- **`lib/context/`** — builds AI prompt context from GitHub data: selects
  changed files, trims lock files/generated code, packs before/after
  contents within a token budget, chunks/truncates oversized PRs. Pure
  logic; the highest-risk module; heavily unit-tested.
- **`lib/cache/`** — IndexedDB cache for AI outputs.
- **`lib/settings/`** — keys + preferences (localStorage).
- **`lib/analytics/`** — typed PostHog event wrapper; the single choke-point
  enforcing the privacy rule.
- **UI:** `Stepper`, `UnderstandStep`, `InspectStep`, `VerdictStep`,
  `DiffView`, `ContextRail`, `CommentEditor` (WYSIWYG markdown),
  `SettingsPanel`.

Libraries: `mermaid` for diagrams; diff parsing via an established parser
(e.g. `parse-diff`) + custom Svelte diff rendering (accepted cost of
choosing Svelte: no mature ready-made diff-view component). Final library
picks happen during planning.

## Data flow

Paste URL → parse → parallel GitHub fetches → Step 1 renders skeleton
immediately → `lib/context` packs context → four DeepSeek calls fire in
parallel, stream into their UI slots → results cached on completion.

Comments: drafted locally (in-memory + IndexedDB), attached to file+line,
submitted in Step 3 as one GitHub review.

## Error handling

- **Bad URL / not found / private without token** → specific inline message
  on landing page.
- **GitHub rate limit** → detect `403` + `X-RateLimit-Remaining: 0`, show
  reset time, suggest adding a token.
- **DeepSeek failures** (auth, quota, timeout, CORS regression) → each AI
  panel fails independently with retry; review flow fully usable without AI.
  Invalid key → settings prompt.
- **Malformed AI output** (bad JSON / invalid Mermaid) → one automatic
  repair retry (re-prompt with the error), then graceful "couldn't generate"
  state. Mermaid renders in a sandboxed container.
- **Review submission failure** → drafts preserved until GitHub confirms
  success; GitHub's error shown verbatim.

## Security & supply chain

- BYO keys live only in localStorage and are sent only to their own
  services. No proxy, no server, no third-party key transit.
- **pnpm** is the package manager with `minimumReleaseAge: 10080`
  (7 days) configured, so freshly published package versions cannot be
  installed — mitigating npm supply-chain attacks.
- PostHog privacy rule enforced in `lib/analytics/` (see Architecture).
- Mermaid rendering sandboxed (`securityLevel: 'strict'`).

## Analytics (PostHog)

Typed events, indicative set: `pr_loaded` (visibility, file count, primary
language), `ai_task_completed` / `ai_task_failed` (task name, duration,
cached?), `diagram_viewed`, `hotspot_clicked`, `comment_drafted`,
`review_submitted` (verdict type, comment count), `settings_key_added`
(which service, never the key). Exact schema finalized during planning.

## Testing

- **Unit (Vitest):** URL parsing, diff parsing, context packing (token
  budgets, file filtering), cache keying, AI response parsing/validation.
  Pure logic with fixture PRs.
- **Component (Vitest + Testing Library):** DiffView modes + word-level
  highlights, stepper navigation, comment editor, settings.
- **E2E (Playwright):** full flow against MSW-mocked GitHub/DeepSeek
  fixtures: paste URL → diff renders → AI panels populate → draft comment →
  submit review (mocked). One tokenless smoke test against a real public PR
  in CI.
- AI prompt **quality** is verified at the human checkpoint (non-
  deterministic); automated tests cover plumbing, not prose.

## Decision log

| Decision | Choice |
|---|---|
| Write-back scope | Full review actions (comment, approve, request changes) |
| Repo access | Public + private (PAT) |
| AI features in v1 | All four (summary, attention, diagrams, confidence) |
| "Old vs new diff" feature | Reframed: architectural before/after (= Mermaid feature); commit-interdiff is nice-to-have |
| Stack | Svelte 5 + TypeScript + Vite, pnpm |
| Architecture | Pure static SPA (approach A) + client-side AI cache |
| Layout | 1-2-3 stepper + pinnable context rail (hybrid A+B from mockups) |
| Comments | WYSIWYG markdown editor |
| Analytics | PostHog, client-side, strict privacy rule |
| Supply chain | pnpm `minimumReleaseAge` 7 days |
| Model switching | Deferred; enabled cheaply by `lib/llm/` abstraction |
