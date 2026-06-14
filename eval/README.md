# AI-review eval harness

Makes AI-review **quality measurable** so prompt/harness changes can be judged by
numbers instead of by eyeballing screenshots — e.g. "did turning Deep review on
actually catch more real bugs?" or "did this calibration tweak cut the noise?".

The harness runs the **real** review code paths (the prompt builders in
`src/lib/ai/tasks.ts` and the validators in `src/lib/ai/schemas.ts`) against a
small **golden set** of hand-labeled PR fixtures, then scores the produced
findings against what a good reviewer *should* and *should not* flag.

> **Honesty, up front.** There are two run modes and they prove different things:
>
> - **`--mock` (default, CI-safe, no network/key):** feeds the harness a
>   *scripted* model response per case. This validates the **harness mechanics**
>   — the scoring + matching logic — deterministically. A green `--mock` run says
>   the plumbing works. It says **nothing** about real model quality.
> - **`--live` (you run this locally, needs an API key):** actually calls the
>   configured provider and measures **real model quality** against the golden
>   set. Add `--deep` to also exercise the agentic deep-review guidance.
>
> The golden set is **small and seed-sized** and is meant to **grow** (see below).
> Treat the metrics as a directional signal, not a benchmark leaderboard.

## Running it

```bash
# Mock (default): deterministic, no key, safe for CI
pnpm eval

# A single case
pnpm eval -- --case 01-real-bug

# Live: real provider call (measures actual quality)
DEEPSEEK_API_KEY=sk-... pnpm eval -- --live

# Live + agentic deep-review guidance
DEEPSEEK_API_KEY=sk-... pnpm eval -- --live --deep
```

The runner prints a per-case + aggregate table and a one-line verdict, and writes
a full JSON dump to `eval/results/` (gitignored). It exits **non-zero** when the
aggregate **recall** drops below — or the **noise-rate** rises above — the gates
in `src/lib/eval/scorer.ts` (`DEFAULT_GATES`). This makes it *opt-in* CI-gatable
later; it is intentionally **not** wired into the required CI workflow yet.

### Live provider selection

The live caller is a self-contained OpenAI-compatible `chat/completions` POST.
It picks a provider from the environment, in priority order:

| Env | Base URL | Default model |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` or `https://api.deepseek.com` | `deepseek-chat` |
| `OPENAI_API_KEY` | `OPENAI_BASE_URL` or `https://api.openai.com` | `gpt-4o-mini` |
| `LLM_API_KEY` | `LLM_BASE_URL` (required) | `LLM_MODEL` (required) |

Set `LLM_MODEL` to override the model for any provider.

## Metrics

Every review task's output is reduced to a flat list of findings
`{ file, line, description }`. Each is matched against the golden case's labels by
**file + line proximity** (±`lineTolerance`, default 3) and **fuzzy description
overlap** (token Jaccard ≥ `descOverlapThreshold`). From the matches:

- **recall** — of the KNOWN-REAL findings, how many were caught.
- **noise-rate** — of the KNOWN-NOISE items, how many were *wrongly* flagged.
- **precision** — of everything flagged, the fraction that were real.
- **findings** — raw count of produced findings (over-/under-flagging at a glance).

A finding that matches *neither* a real nor a noise label is counted as
*unmatched* (a likely false positive on a clean case). It lowers precision but is
not penalized by the gates — on a partially-labeled case it may be legitimately
un-labeled.

## Golden-set format

Each case is a directory under `eval/golden/<NN-name>/`:

```
eval/golden/
  01-real-bug/
    fixture.json         # the PR: changed files (patch + full contents) + reviewer personas
    expected.json        # hand labels: KNOWN-REAL + KNOWN-NOISE
    mock/responses.json  # scripted model output per task (for --mock only)
```

### `fixture.json`

The same shapes the app's AI tasks consume — a list of changed files, each with a
unified-diff `patch` and the full `contentAfter` (and optional `contentBefore`),
plus the reviewer `skills` (persona content) to review with.

```jsonc
{
  "name": "01-real-bug",
  "files": [
    {
      "path": "src/lib/paginate.ts",
      "patch": "@@ -1,10 +1,14 @@\n ...unified diff...",
      "contentBefore": "...full file before...",   // optional (null/absent for added files)
      "contentAfter":  "...full file after..."      // null for deleted files
    }
  ],
  "skills": [
    { "name": "bug-hunter", "content": "You are a correctness-focused reviewer. ..." }
  ]
}
```

### `expected.json`

The hand labels. `line` is 1-based, or `null` for a file-level expectation.

```jsonc
{
  "real": [   // things a good reviewer SHOULD flag
    { "file": "src/lib/paginate.ts", "line": 8,
      "description": "off-by-one: end = start + size - 1 with exclusive slice drops the last item" }
  ],
  "noise": [  // things a reviewer should NOT flag (style nits, moot, unchanged code)
    { "file": "src/lib/paginate.ts", "line": 2,
      "description": "comment style: prefer a doc comment over an inline comment" }
  ]
}
```

### `mock/responses.json` (used by `--mock` only)

A map of **task key → the model's scripted JSON response object** (the runner
serializes it). Task keys are `"verdict"`, `"attention"`, and `"skill:<persona-name>"`.
Any task without an entry gets a valid, finding-free ("silent") response — which
shows up as a recall miss, not a crash. Author these to represent a *plausible*
model run (e.g. a good run that catches the real bug and avoids the noise) so the
mock metrics demonstrate the scoring end to end.

```jsonc
{
  "skill:bug-hunter": {
    "skillName": "bug-hunter",
    "findings": [
      { "path": "src/lib/paginate.ts", "line": 8, "severity": "high",
        "body": "Off-by-one: slice end uses start + size - 1 and drops the last item per page." }
    ]
  },
  "attention": { "readingOrder": ["src/lib/paginate.ts"], "hotspots": [], "testFlags": [] },
  "verdict":   { "level": "significant-changes", "evidence": [], "notAnalyzed": [] }
}
```

## Growing the golden set

1. **Pick a real-ish PR** that exercises a behavior you care about. The three seed
   cases cover the archetypes: a real bug that **should** be caught
   (`01-real-bug`), a clean refactor that should produce **~no** findings
   (`02-clean-pr`), and a noise-trap with tempting-but-moot things that should
   **not** be flagged (`03-noise-trap`).
2. `mkdir eval/golden/04-your-case/` and add `fixture.json` + `expected.json`.
   Keep fixtures **small** — a focused hunk beats a giant diff.
3. Label honestly: KNOWN-REAL = genuine defects a reviewer should catch;
   KNOWN-NOISE = the things a *fatigued* reviewer over-flags (style, pre-existing
   issues, unchanged code, moot points). The noise labels are what keep the
   harness honest about over-flagging.
4. Add `mock/responses.json` so the case runs under `--mock` (and CI). Make it a
   plausible *good* run; if you want to assert a regression is caught, you can
   author a deliberately bad run and confirm the gate fails.
5. Run `pnpm eval` (mock) to sanity-check the plumbing, then
   `pnpm eval -- --live` to see how the real model scores on your new case.

## Where the code lives

- `src/lib/eval/scorer.ts` — matching + metrics + gates (pure, unit-tested).
- `src/lib/eval/harness.ts` — golden-case → real prompts → findings (unit-tested).
- `src/lib/eval/mock.ts` — the scripted LLM stub for `--mock`.
- `eval/run-eval.mts` — the thin CLI driver (`pnpm eval`). Loads the harness via a
  throwaway Vite SSR server so the app's bundler-style imports resolve under Node.

The scorer/harness/mock live under `src/lib/` so they run under the normal
`pnpm test`. Their tests are `src/lib/eval/*.test.ts`.
