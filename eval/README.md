# AI-review eval harness

Makes AI-review **quality measurable** so prompt/harness changes can be judged by
numbers instead of by eyeballing screenshots — e.g. "did turning Deep review on
actually catch more real bugs?" or "did this calibration tweak cut the noise?".

> **This harness is the gate for finding-quality changes.** Any PR that claims to
> improve what the reviewer surfaces — a prompt edit, a calibration tweak, a new
> filtering or ranking pass — must post a `--matrix` run before and after, and
> `eval/BASELINE.md` is what it diffs against. Between 2026-06 and 2026-09 eight
> such PRs shipped without a single measurement; the harness existed the whole
> time and nobody ran it. Don't repeat that.
>
> The measurement that matters is the **per-case delta**, not the aggregate. A
> filtering change that raises precision on `02-clean-pr` / `03-noise-trap` while
> dropping recall on `01-real-bug` / `05-security` has not improved anything — it
> has moved the failure from noise to blindness.

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

# Live with NO API key, on your Claude Code / Codex subscription (see "Live
# transports" below) — costs nothing per token:
pnpm bridge -- --port 7739 --token-file .bridge-token      # in another terminal
BRIDGE_URL=http://127.0.0.1:7739 BRIDGE_TOKEN_FILE=.bridge-token \
  pnpm eval -- --live --matrix --concurrency 3

# Live + agentic deep-review guidance
DEEPSEEK_API_KEY=sk-... pnpm eval -- --live --deep

# Cross-model verification (Plan M): measure precision/recall/noise-rate WITH
# the adversarial verify pass applied (demoted findings dropped before scoring)
pnpm eval -- --cross-verify                          # mock
DEEPSEEK_API_KEY=sk-... pnpm eval -- --live --cross-verify
```

### `--matrix` — the on/off comparison (start here)

A single precision number cannot tell you whether a filtering pass **improved**
the findings or merely **hid** them. `--matrix` answers that: it pays for **one**
generation per case, then scores those same findings under every combination of
the post-generation stages the app grew between #206 and #242.

```bash
pnpm eval -- --live --matrix --concurrency 3
```

The stages, and the PR each one came from, live in `src/lib/eval/surface.ts`:

| variant | what it is |
| --- | --- |
| `generate-only` | the raw reviewer output — the surface this harness measured before 2026-09 |
| `+tests-pass` | the separate tests reviewer (#237) added |
| `+verify` | cross-model verification drops demoted findings |
| `+triage` | `findingRank` (#226) keeps only the inline tier, with no verification data |
| `verify+triage/moot-off` | verification + triage, **mootness gate off** |
| `verify+triage` | the same with the mootness gate (#228) on — the isolating pair |
| `app-default` | every stage on: what review123 shows inline today |
| `app-default/show-all` | the same, with the "show all findings" escape hatch |

Read the table as **deltas between adjacent rows**, and always per case:

- `03-noise-trap` and `02-clean-pr` are the **over-filtering detectors** — they
  have no real findings, so filtering can only help there.
- `01-real-bug` and `05-security` are the **under-filtering detectors** — they
  each hold a genuine defect, so a recall drop there is a filter that went too far.

A stage that cuts noise-rate on the first pair while holding recall on the second
earned its place. One that cuts both is trading blindness for tidiness.

**The measured baseline lives in [`BASELINE.md`](./BASELINE.md)**, and the two
runs behind it are committed at `eval/baseline-run.json` and
`eval/repeat-run.json` (the second one so the run-to-run jitter — which decides
whether your delta means anything — is checkable rather than asserted).

### Re-scoring a stored run for free (`pnpm eval:rescore`)

A `--matrix` run writes every generated finding — with its severity, its
cross-model verification and its simplify rewrite — into `eval/results/`. Those
are all the inputs the post-generation stages consume, so **any variant can be
scored again from the file with no model call at all**:

```bash
pnpm eval:rescore                            # the newest run in eval/results/
pnpm eval:rescore eval/baseline-run.json     # the committed baseline
pnpm eval:rescore -- --per-case              # per-case breakdown
```

Use this rather than re-running whenever you add or fix a variant. Two rows only
belong in the same comparison if they came from the **same** generation; models
are stochastic, so a second run cannot give you that and re-scoring can.

> **Two verifiers minimum.** Cross-verification surfaces a finding when
> `score >= polledModels / 2`, and the generator counts as one implicit confirm.
> With a single verifier that is `1 >= 2/2` — true no matter how the verifier
> votes. A one-verifier run **cannot demote anything**, and its worth axis can
> never reach the mootness threshold either, so both `--cross-verify` and the
> mootness gate are silent no-ops. The runner prints a warning when it detects
> this. (It was the live configuration here until 2026-09, which is why the
> "cross-verification lift" this README promised had never actually been
> observable in `--live`.)

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

### Live transports

`--live` needs a way to reach a model. There are two, and the **bridge is tried
first** whenever `BRIDGE_URL` is set, because a user who started a bridge meant
to use it.

**1. The local bridge — no API key, no per-token cost.**

`POST /v1/infer` is the same transport the app offers: it invokes the user's
**already-installed `claude` / `codex` CLI** as a subprocess, so the run spends
an existing subscription instead of metered API credit. This is the only way to
run the harness on a machine with no API key at all.

```bash
pnpm bridge -- --port 7739 --token-file .bridge-token
BRIDGE_URL=http://127.0.0.1:7739 BRIDGE_TOKEN_FILE=.bridge-token \
  pnpm eval -- --live --matrix --concurrency 3
```

| Env | Meaning |
| --- | --- |
| `BRIDGE_URL` | Where the bridge listens, e.g. `http://127.0.0.1:7739`. |
| `BRIDGE_TOKEN` / `BRIDGE_TOKEN_FILE` | The pairing token, inline or via the `--token-file` path. |
| `BRIDGE_CLI` | Generator CLI — `claude` (default) or `codex`. |
| `BRIDGE_VERIFY_CLIS` | Comma-separated verifier CLIs. Defaults to the *other* vendor's CLI plus the generator's. **Repeat a CLI to reach the two-verifier minimum** (e.g. `codex,codex`). |
| `BRIDGE_TIMEOUT_MS` | Per-call budget. Default 240000. |

Two things the bridge **cannot** measure, and will not pretend to:

- **Deep review (`--deep`) and grounded verification (#229).** `/v1/infer` runs
  the CLI with `--tools ""` — every built-in tool disabled, by design, so the
  route cannot touch the repo. Both features instruct the model to verify claims
  with repo tools and to *drop whatever it cannot verify*. Over the bridge those
  tools do not exist, so a run would measure a crippled prompt, not the feature.
  Use an API-key transport with the app's real agentic harness for those.
- **A genuinely cross-vendor verifier panel**, if you point both verifier slots
  at the same CLI. Two calls to one model are two samples, not two opinions.

Known wrinkle: the `claude` CLI reliably times out on the multi-finding verify
payload through `/v1/infer`, while `codex` answers it in ~50s. `codex,codex` is
the configuration that currently works end-to-end for verification.

**2. An OpenAI-compatible API key.** A self-contained `chat/completions` POST.
Picked from the environment in priority order:

| Env | Base URL | Default model |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` or `https://api.deepseek.com` | `deepseek-chat` |
| `OPENAI_API_KEY` | `OPENAI_BASE_URL` or `https://api.openai.com` | `gpt-4o-mini` |
| `LLM_API_KEY` | `LLM_BASE_URL` (required) | `LLM_MODEL` (required) |

Set `LLM_MODEL` to override the model for any provider. One API provider means
one verifier model — see the two-verifier note above.

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
serializes it). Task keys are `"verdict"`, `"attention"`, `"skill:<persona-name>"`
and — for the separate tests pass (#237) — `"tests:<persona-name>"`.
Any task without an entry gets a valid, finding-free ("silent") response — which
shows up as a recall miss, not a crash.

Skill findings carry `suggestedFix` (the solutions requirement, #228). The
validator tolerates its absence, but a mock is supposed to look like a
*plausible current* model run, so the seed cases include it. Author these to represent a *plausible*
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
- `src/lib/eval/surface.ts` — the post-generation pipeline as toggles: cross-model
  verification, `findingRank` triage, the mootness gate, simplify, the tests
  pass. This is what `--matrix` varies, and it reuses the app's real
  `rankFindings` rather than re-implementing the policy (unit-tested).
- `src/lib/eval/mock.ts` — the scripted LLM stub for `--mock`.
- `eval/run-eval.mts` — the thin CLI driver (`pnpm eval`). Loads the harness via a
  throwaway Vite SSR server so the app's bundler-style imports resolve under Node.
- `eval/rescore.mts` — re-scores a stored run under the variants, offline
  (`pnpm eval:rescore`).
- `eval/BASELINE.md` + `eval/baseline-run.json` + `eval/repeat-run.json` — the
  measured baseline and the two runs behind it.

The scorer/harness/mock live under `src/lib/` so they run under the normal
`pnpm test`. Their tests are `src/lib/eval/*.test.ts`.
