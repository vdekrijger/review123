# Working agreement — Review 1-2-3

How AI sessions should operate in this repo. This codifies the workflow we've
been running; follow it by default.

## Execution model

Default to **subagent-driven, one-PR-per-change** execution. For any non-trivial
feature or fix, dispatch a FRESH background subagent in an isolated git worktree
(`isolation: "worktree"`, `run_in_background: true`) that implements it
end-to-end (code + tests + PR + auto-merge). Keep your own (controller) context
lean for coordination — don't hand-implement large work. Do small, cohesive
changes directly. Run independent agents in parallel only when they touch
**disjoint files** (otherwise sequence them to avoid merge conflicts).

The loop per change:

1. Scope the work into independent, one-PR-sized pieces.
2. Dispatch a background `general-purpose` agent with a precise prompt (below).
3. The agent implements → passes ALL gates → opens a PR → enables auto-merge.
4. Monitor; hand-resolve any conflict; if an agent's "green" regressed and CI
   fails, reproduce + fix it directly and push.

## Gates — every PR must pass before it merges

```
pnpm check          # svelte-check — 0 errors
pnpm test           # vitest, FULL suite (run it all, not just changed files)
pnpm exec playwright test   # e2e (CI=1 E2E_PORT=<free port> for a local run)
pnpm build          # vite build — clean
```

- **Known e2e flake:** `e2e/real-pr.smoke.spec.ts` fails/​self-skips LOCALLY
  (unauthenticated GitHub rate-limit). CI authenticates it and it passes. If
  ONLY that spec fails locally, proceed. Any other spec failing is real.
- There's no `test:e2e` script — run Playwright via `pnpm exec playwright test`.

## Branch + PR + merge

- One `feat/…` or `fix/…` (or `docs/…`) branch per change; conventional-commit
  messages.
- **Commit author:** `akatchi <akatchi@codekrijger.io>` — set it per-commit when
  needed: `git -c user.name=akatchi -c user.email=akatchi@codekrijger.io commit …`
  (Vercel rejects unrecognized author emails on deploy).
- End every commit body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `gh pr create` with an honest body (what + why + gate results), then
  `gh pr merge --auto --merge <PR#>`.
- Auto-merge-to-`main`-on-green is the **accepted workflow for this solo, fast
  repo** — it is NOT an unauthorized action here. (On a shared/team codebase you
  would require human review instead.)
- Vercel free-tier deploys lag behind `main`; the footer build-SHA indicator
  shows the deployed commit — check it before judging "it didn't work."

## Every dispatched agent prompt MUST include

- **Goal** (+ root cause, for fixes) in 1–2 sentences.
- **READ FIRST:** the specific files (+ line hints) to read before editing.
- Numbered, concrete **deliverables**; **tests required** per behavior.
- The grep-before-push rule (below); the gates; the commit/PR/auto-merge rules.
- **Report back:** structured data (PR #, what changed, gate results, anything
  deferred). Its final message is data for the controller, not a user message.

## Bug fixes: reproduce first

When a diagnosis is uncertain, write a FAILING test that reproduces the bug
BEFORE fixing, and **report back if the hypothesis turns out wrong** rather than
fix blind. (This has repeatedly caught wrong guesses — e.g. a story-mode
"under-count" theory the repro disproved.)

## Decisions: ask on genuine forks

For real design forks (UX shape, architecture with cost trade-offs), present 2–4
concrete options with trade-offs (ASCII/preview mockups help) and a
recommendation via AskUserQuestion, let the human pick, then build. Don't ask
about choices with an obvious default — pick it, mention it, proceed.

## THE RECURRING LESSON (the #1 CI failure here)

Before pushing, `grep -rn` the WHOLE repo — **`src/` AND `e2e/`** — for every
identifier / string / prop / `PROMPT_VERSION` / label you changed, and update
every sibling test + caller. "Changed-file tests passed locally" ≠ full suite
green. A constant, signature, or label change ripples; CI will catch it if you
don't.

## Project shape (orientation)

- Svelte 5 + Vite + TS, frontend-only SPA; pnpm; deployed on Vercel
  (review123.dev). One OAuth serverless fn under `api/`.
- LLM providers are BYO-key (deepseek / openai / anthropic / gemini /
  openrouter); the ensemble engine fuses generators + verifiers (cross-model
  verification). `PROMPT_VERSION` (in `src/lib/ai/tasks.ts`) gates the per-task
  cache — bump it when a prompt changes.
- Daily GitHub Action syncs the OpenRouter model catalog.
