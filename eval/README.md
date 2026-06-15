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

# Cross-model verification (Plan M): measure precision/recall/noise-rate WITH
# the adversarial verify pass applied (demoted findings dropped before scoring)
pnpm eval -- --cross-verify                          # mock
DEEPSEEK_API_KEY=sk-... pnpm eval -- --live --cross-verify
```

### Measuring the cross-verification lift (`--cross-verify`)

`--cross-verify` runs the same review, then a second **adversarial verify pass**
(the prompt + aggregation from `src/lib/ai/crossVerify.ts`) over the produced
findings. Findings the verifier **demotes** (refute / uncertain → below the
surface threshold) are **dropped before scoring**, so the printed
precision / recall / noise-rate reflect the *post-verification* surface.

To measure the lift, run the same mode twice and compare:

```bash
pnpm eval -- --live                  # baseline (no verification)
pnpm eval -- --live --cross-verify   # with verification
```

Expect cross-verification to **raise precision / cut noise-rate** (it drops
findings other models don't back) at a possible small **recall** cost (a real
finding the verifier wrongly refutes). The token cost rises (one extra verify
call per case).

- In **`--live`**, the verifier is the **same** live provider (one verifier, for
  harness simplicity — the app polls up to 3 *distinct* providers). It judges
  each finding and demotes refute/uncertain.
- In **`--mock`**, an optional `eval/golden/<case>/mock/verify.json` maps a
  finding's `description` string to a verdict (`confirm` | `refute` |
  `uncertain`); absent entries default to `confirm` (surface), so without the
  file `--cross-verify` is a no-op. This keeps the mock path deterministic.

### Measuring the multi-generator RECALL lift (`--fusion generate`, Plan O)

`--cross-verify` is **precision-only**: a single generator produces findings and
the others can only PRUNE them. `--fusion generate` measures the orthogonal win —
**recall** from independent generators. The review runs once **per generator**,
the union is **dedup-merged** (via the shared `findingsMatch` predicate in
`src/lib/ai/findingMatch.ts`, the same notion the app's `mergeGeneratorFindings`
uses), then cross-confirmed before scoring. A real finding only ONE generator
caught now enters the union — so multi-gen catches **more** of a case's known-real
findings. `--fusion generate` implies `--cross-verify` (the merged union is
cross-confirmed).

To measure the lift, run single-gen vs multi-gen and compare **recall**:

```bash
pnpm eval -- --live                    # single-generator baseline
pnpm eval -- --live --fusion generate  # multi-generator union (recall)
```

Expect `--fusion generate` to **raise recall** (it surfaces real bugs only one
model caught) at a higher token cost (every generator generates AND verifies).

- In **`--live`**, two stand-in generators use the **same** live provider (harness
  simplicity — the app fans out to the distinct ensemble models the user picked).
- In **`--mock`**, each generator reads its own scripted response map from
  `eval/golden/<case>/mock/responses.<gen>.json` (`<gen>` ∈ `a`, `b`, `c`…). When
  a case has ≥2 such files, give each generator a DIFFERENT subset of the case's
  real findings to demonstrate the union catching more than either alone. With no
  per-gen files the runner falls back to the base `responses.json` for every
  generator (deterministic, but no recall lift — the union equals one generator).

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

## Capturing a real PR as a golden case

Hand-authoring fixtures is fine, but the fastest way to grow the set is to point
the capture tool at a **real PR** and let it scaffold the case for you:

```bash
GITHUB_TOKEN=ghp_... DEEPSEEK_API_KEY=sk-... \
  pnpm eval:capture https://github.com/owner/repo/pull/42 --name 07-my-case

# owner/repo/number shorthand also works:
GITHUB_TOKEN=ghp_... DEEPSEEK_API_KEY=sk-... \
  pnpm eval:capture owner/repo/42 --name 07-my-case
```

What it does, in three steps:

1. **Fetch** the PR via GitHub's REST API (the same meta + files/patches + full
   after-contents the app's review path consumes) into `fixture.json`.
2. **Run the REAL review tasks LIVE** (verdict + attention + a default
   `bug-hunter`/security/perf skill persona) against the configured provider —
   the **same** env keys and OpenAI-compatible call `pnpm eval -- --live` uses —
   and records every finding the model produces. Those are written to
   `mock/responses.json`, so the case is **replayable offline** under `--mock`.
3. **Scaffold `expected.json`** pre-populated with every AI finding under a
   `findings` array, each `{ file, line, description, label: "UNLABELED" }`.

> **UNLABELED is the load-bearing part.** A freshly captured case is **not yet
> labeled** — every finding starts `"label": "UNLABELED"`, and the scorer
> **SKIPS** UNLABELED entries entirely (they count toward neither *real* nor
> *noise*). So a half-labeled case never scores garbage. You finish the case by
> editing each label:
>
> - `"real"` — a genuine defect a reviewer SHOULD flag.
> - `"noise"` — tempting-but-moot; a reviewer should NOT flag it.
> - leave `"UNLABELED"` — ignored until you resolve it.
>
> You can also **add real findings the AI MISSED** (with `"label": "real"`) — the
> mock won't surface them, so they show up as a recall miss under `--live`, which
> is exactly what you want to measure.

Then:

```bash
# Replay offline against the captured model output (deterministic):
pnpm eval -- --case 07-my-case
# Measure how the real model scores on your labeled case:
DEEPSEEK_API_KEY=sk-... pnpm eval -- --case 07-my-case --live
```

### Auto-labeling from your accept/dismiss decisions

When you **actually review a PR in the app**, every AI finding you **accept**
("Add as draft") or **dismiss** is recorded locally in a per-browser decision
store (`src/lib/eval/decisions.ts`, IndexedDB, keyed by the PR + finding). That
accept/dismiss signal is real ground truth — so the capture tool can use it to
**pre-label the case for you**, turning a reviewed PR into a (mostly) labeled
eval case with near-zero manual effort:

- a finding you **accepted** → `"label": "real"`
- a finding you **dismissed** → `"label": "noise"`
- a finding with **no decision** → `"label": "UNLABELED"` (the default above)

The decision store lives in the browser (IndexedDB) and isn't reachable from
Node, so export your decisions to a JSON file (a JSON array of decision records,
or `{ "decisions": [...] }`) and point `--decisions` at it:

```bash
pnpm eval:capture owner/repo/42 --name 07-my-case --decisions ./my-decisions.json
```

The match is **skillId-independent** — findings are re-matched by
`path:line:bodyPrefix` (the content tail of the finding key), so the captured
live reviewer name need not equal the runtime skill id. Decisions carry **only**
ids/enums/counts + the finding key/anchor needed to re-match — never finding
body text beyond the 30-char prefix already in the key, never code or diffs.
Findings with no decision stay UNLABELED for you to resolve as before.

The capture tool fails **honestly**: no `GITHUB_TOKEN` → clear message; PR fetch
failure → clear; no provider key (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` /
`LLM_API_KEY`) → clear; an existing `eval/golden/<slug>/` → it refuses to
overwrite. The scaffolding logic (PR + findings → the three file shapes, the
UNLABELED contract, and the decision auto-labeling) lives in
`src/lib/eval/capture.ts` + `src/lib/eval/decisions.ts` and is unit-tested.

Captured cases use the labeled `{ findings: [...] }` form of `expected.json`;
hand-authored cases use the `{ real, noise }` form. The scorer accepts **both**
(see `normalizeExpectation` in `scorer.ts`).

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
**Two accepted shapes** (the scorer normalizes both — `normalizeExpectation`):

**(a) hand-authored `{ real, noise }`** — what the seed cases use:

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

**(b) labeled `{ findings: [...] }`** — what `pnpm eval:capture` scaffolds. Each
entry carries a `label`; `UNLABELED` entries are **SKIPPED** by the scorer until
you resolve them to `"real"` or `"noise"`:

```jsonc
{
  "findings": [
    { "file": "src/api/search.ts", "line": 6,
      "description": "SQL injection via ORDER BY interpolation", "label": "real" },
    { "file": "src/api/search.ts", "line": 7,
      "description": "the LIKE term is parameterized — safe", "label": "noise" },
    { "file": "src/api/search.ts", "line": 12,
      "description": "not yet reviewed", "label": "UNLABELED" }   // ignored by the scorer
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

0. **Easiest path:** `pnpm eval:capture <pr> --name <slug>` (see *Capturing a real
   PR as a golden case* above), then label the scaffolded `expected.json`.
1. **Or hand-author.** Pick a real-ish PR that exercises a behavior you care
   about. The six seed cases cover the archetypes: a real bug that **should** be
   caught (`01-real-bug`), a clean refactor that should produce **~no** findings
   (`02-clean-pr`), a noise-trap with tempting-but-moot things that should **not**
   be flagged (`03-noise-trap`), a behavior-preserving refactor that hides one
   genuine behavior change among equivalent rewrites (`04-refactor`), a real
   injection alongside a tempting-but-safe parameterized/escaped pattern
   (`05-security`), and a real N+1 alongside a noise micro-optimization
   (`06-perf`).
2. `mkdir eval/golden/07-your-case/` and add `fixture.json` + `expected.json`.
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
