# AI-review quality baseline

The first measured baseline for review123's reviewer output. Everything below
comes from runs actually executed on the date given; nothing is extrapolated.

**Why this file exists.** Between 2026-06-15 and 2026-09-22 eight PRs shipped
claiming to improve finding quality — convergence (#206), simplify (#220),
findingRank triage (#226), solutions + the mootness gate (#228), grounded
verification (#229), dismissal calibration (#230), phase-scoped reviewers + a
separate tests pass (#237) and local grounding (#242). The eval harness existed
the whole time and was never run against any of them. This is the number the
ninth change has to beat.

---

## Run metadata

| | |
| --- | --- |
| Date | 2026-09-22 |
| Commit | `9069f68ab2fbabd236f4b8a47802a597ec5e6f9e` |
| Golden set | 6 seed cases — **4 known-real findings, 11 known-noise** in total |
| Transport | local bridge (`POST /v1/infer`) — no API key, subscription-billed |
| Generator | `claude` CLI 2.1.278 (Claude Code), via the bridge |
| Verifiers | `codex` CLI 0.155.1 ×2 (`BRIDGE_VERIFY_CLIS=codex,codex`) |
| Mode | `--live --matrix --concurrency 3` |
| Wall time | ~25 min for all six cases |
| Runs | **two** identical runs on the same commit — `baseline` and `repeat` — so deltas can be compared against run-to-run jitter |

Reproduce it with:

```bash
pnpm bridge -- --port 7739 --token-file .bridge-token
BRIDGE_URL=http://127.0.0.1:7739 BRIDGE_TOKEN_FILE=.bridge-token \
  BRIDGE_VERIFY_CLIS=codex,codex \
  pnpm eval -- --live --matrix --concurrency 3 --label baseline
node eval/rescore.mts --per-case     # re-score the stored run, no model calls
```

---

## The headline: the app's inline surface today

Variant `app-default` — every post-generation stage on, which is what a user
sees without clicking "show all findings". Run 1; see *Run-to-run variance* for
how much of this is stable.

| case | findings | recall | precision | noise-rate |
| --- | --- | --- | --- | --- |
| `01-real-bug` | 9 | 100% (1/1) | 20% | 0% (0/1) |
| `02-clean-pr` | 0 | — (0/0) | 100% | 0% (0/2) |
| `03-noise-trap` | 0 | — (0/0) | 100% | 0% (0/3) |
| `04-refactor` | 4 | 100% (1/1) | 33% | **50% (1/2)** |
| `05-security` | 5 | 100% (1/1) | 25% | 0% (0/2) |
| `06-perf` | 7 | 100% (1/1) | 25% | 0% (0/1) |
| **aggregate** | **18** | **100% (4/4)** | **44%** | **9% (1/11)** |

Aggregate precision (44%) is higher than every per-case precision because
several produced findings match the *same* golden expectation; `precision` is
`realCaught / (realCaught + noiseFlagged + unmatched)` over expectations, not
over raw findings.

**The good:** every known-real defect is found, and the two over-filtering
detectors (`02-clean-pr`, `03-noise-trap`) end at **zero findings** — the
reviewer says nothing on a clean PR and does not take the noise bait.

**The bad:** `04-refactor` still flags one known-noise item (an "extracting a
helper changes behavior" claim that is false), and roughly half of what
surfaces matches no label at all — 4 unmatched findings against 4 real ones.

---

## Stage-by-stage: did the filtering help, or just hide things?

One generation per case, scored under each combination. Rows below the first are
cumulative unless the key says `/x-off`, which knocks a single stage out of
`app-default`.

Both runs are shown. Where they disagree, the disagreement *is* the finding.

| variant | findings (1 / 2) | recall | precision (1 / 2) | noise-rate (1 / 2) | isolates |
| --- | --- | --- | --- | --- | --- |
| `generate-only` | 27 / 30 | 100% (4/4) | 18% / 17% | 36% / 45% | the pre-#226 surface |
| `+tests-pass` | 34 / 37 | 100% (4/4) | 16% / 15% | 36% / 45% | #237 tests pass |
| `+verify` | 19 / 21 | 100% (4/4) | 29% / 31% | **9% / 9%** | cross-model verification |
| `+triage` | 26 / 28 | 100% (4/4) | 19% / 19% | 36% / 45% | #226 alone, unverified |
| `verify+triage/moot-off` | 14 / 15 | 100% (4/4) | 40% / 44% | 9% / 9% | |
| `verify+triage` | 14 / 15 | 100% (4/4) | 40% / 44% | 9% / 9% | #228 mootness gate |
| `app-default` | 18 / 19 | 100% (4/4) | 44% / 36% | 9% / 9% | everything |
| `app-default/show-all` | 25 / 27 | 100% (4/4) | 29% / 24% | 9% / 9% | triage, at the end |
| `app-default/simplify-off` | 18 / 19 | 100% (4/4) | 40% / 40% | 9% / 9% | #220 simplify |
| `app-default/moot-off` | 18 / 19 | 100% (4/4) | 44% / 36% | 9% / 9% | #228 again |
| `app-default/tests-off` | 14 / 15 | 100% (4/4) | 44% / 40% | 9% / 9% | #237 at the end |

Noise-rate moves in steps of 9pp (one of 11 noise labels); precision jitters by
about 4-8pp between runs. **Treat anything under ~8pp of precision as noise.**

### Read-outs

**Cross-model verification is the single biggest win, and it is real.**
Noise-rate **36% → 9%** in run 1 and **45% → 9%** in run 2 — it lands on exactly
1 of 11 noise items both times, from different starting points. Findings drop
27 → 19 and 30 → 21; precision rises 18% → 29% and 17% → 31%. Everything it
removed was noise or unmatched. This is the only effect in the set that is both
large and reproducible, and it is the clearest evidence that a quality pass
earned its cost.

**Triage (#226) does almost nothing on its own, and a lot after verification.**
Alone: 27 → 26 and 30 → 28 findings, noise-rate unchanged (36% / 45%), precision
+1pp and +2pp. After verification: 19 → 14 and 21 → 15, precision 29% → 40% and
31% → 44%. That is not a contradiction — `findingTier` keeps an unverified
MEDIUM inline by design (single-model setups must not be punished), so with no
verification data almost nothing is demoted. Triage's value is *conditional on
verification having run*, and the +11 to +13pp it adds there is the second
effect in this set that clears the noise floor.

**The mootness gate (#228) changed nothing at all, in either run.**
`verify+triage` is identical to `verify+triage/moot-off`, and `app-default` to
`app-default/moot-off` — same finding count, same recall, same precision, same
noise-rate, both times. It is not that the worth axis was silent: **15 findings
were judged moot in run 1 and 17 in run 2**. Of run 1's 15, nine had already
been dropped by cross-verification and the other six were MEDIUM at
`confirmedBy 1/3`, which `findingTier` already collapses on the reality axis.
Run 2 reproduces this exactly (10 already dropped, 5 medium, 2 low — a lone LOW
is secondary regardless). The gate never got to decide anything it wasn't
already told.
*Caveat on this one:* with two instances of the same verifier model, a finding's
confirm count is effectively 1/3 or 3/3 — the 2/3 middle, where "majority-real
but not worth it" lives and where the gate is designed to bite, never occurred.
A genuine 3-distinct-provider panel could give a different answer. This measures
the gate under *this* configuration, not in principle.

**The separate tests pass (#237) adds volume, not information.** At the raw
surface it adds 7 findings in both runs and costs 1-2pp of precision. At the
app's operating point (`app-default` vs `app-default/tests-off`) it adds 4
findings while recall stays 4/4 and noise-rate stays 9% — precision unchanged in
run 1, −4pp in run 2. Every finding it contributed duplicated one the
implementation pass already produced. Honest caveat: the golden set contains
exactly one test file (`02-clean-pr/greet.test.ts`), so this set is a poor place
to judge a tests reviewer. The result says "no measurable benefit *here*", not
"no benefit".

**Simplify (#220): no measurable effect — the first run's apparent win did not
survive a repeat.** Run 1 had `app-default` at 44% precision against
`app-default/simplify-off` at 40%, which looked like a small win. Run 2 has 36%
against 40% — the same magnitude, the opposite sign. Finding count, recall and
noise-rate are identical with and without it in both runs. A ±4pp swing is
inside the run-to-run jitter measured above, so **the honest reading is "no
detectable effect on matching", not "a small positive"**. The useful part of
this result is the negative one: rewriting every finding with an LLM is exactly
the kind of pass that could silently destroy the technical anchors fuzzy
matching depends on, and it demonstrably did not.

**Nothing hid a real finding.** Recall is 4/4 in all eleven variants, in both
runs — 22 measurements, zero variation. No stage, in any combination, removed a
known-real defect. That is the result the under-filtering detectors exist to
produce — see the honesty section for why it is weaker evidence than it looks.

---

## What this baseline canNOT tell you

State these next to any number quoted from this file.

1. **The golden set has only 4 real findings.** One missed finding is 25% of
   recall. The instrument's resolution is far coarser than the effects being
   measured, and recall showed **zero** variation across every variant — so the
   over-filtering detectors (`01-real-bug`, `05-security`) never actually fired.
   The strongest claim available is "no filter removed a real finding *that this
   model found with high confidence on these six small fixtures*". **Growing the
   golden set is the highest-value follow-up** — specifically with defects a
   model catches at MEDIUM or LOW severity, since those are the only ones triage
   can bury.
2. **Convergence (#206) is untestable from this set.** Every fixture has exactly
   one reviewer persona, and convergence merges findings *across* reviewers.
   There is nothing to converge. A multi-persona fixture is needed.
3. **Grounded verification (#229) and deep review (`--deep`) were not measured.**
   Both instruct the model to verify claims with repo tools and drop what it
   cannot verify. The bridge's `/v1/infer` runs the CLI with `--tools ""`, so
   those tools do not exist on this transport — a run would have measured a
   crippled prompt, not the feature. Needs an API-key transport driving the
   app's real agentic harness.
4. **Local grounding (#242)** has the same problem, for the same reason.
5. **Dismissal calibration (#230) was not measured.** `skillReviewPrompt` takes
   a `calibration` argument built from the user's real dismissal ledger. These
   fixtures are synthetic and have no ledger; inventing one would have produced
   a number about a fiction.
6. **Solutions (#228's `suggestedFix`) cannot be toggled** without editing the
   prompt, which measuring must not do.
7. **Phase scoping (#237)** is only partly exercised: `packFixture` packs every
   file with no scope, and only one fixture has a test file to scope out.
8. **Run-to-run variance is not yet characterised** — see below.

---

## Run-to-run variance

Two identical runs, same commit, same transport, same flags. What moved:

| quantity | run 1 | run 2 | read |
| --- | --- | --- | --- |
| recall (every variant) | 4/4 | 4/4 | **perfectly stable — and perfectly insensitive** |
| noise-rate after verification | 9% | 9% | **stable**; lands on the same single noise item |
| noise-rate before verification | 36% | 45% | ±1 noise item = ±9pp |
| raw findings produced | 27 | 30 | ±10% volume |
| `app-default` precision | 44% | 36% | **±8pp of pure jitter** |

The practical rule this gives you:

- **Precision deltas under ~8pp are not evidence.** This is what killed the
  apparent simplify win above.
- **Noise-rate moves in 9pp steps** (11 labels). A one-step move is one finding;
  treat it as weak evidence, two steps as real.
- **Recall cannot currently move at all**, so it is not yet usable as a
  regression signal — which is the strongest argument for growing the set.

Re-score either stored run without paying for inference:

```bash
pnpm eval:rescore eval/baseline-run.json -- --per-case
```

---

## The mock baseline (harness mechanics only)

`pnpm eval` with no flags, same commit: recall 100% (4/4), precision 67%,
noise-rate 9% (1/11), 13 findings. This proves the scoring and matching plumbing
works. It says nothing about model quality — the "model" is a scripted stub.

---

## Verdict on three months of quality work

Measured on this set, on this date, with this transport:

- **Cross-model verification: clearly positive, and the only large effect.**
  Noise-rate 36%/45% → 9% in both runs. Reproducible, and far outside the jitter.
- **Triage (#226): positive, but only downstream of verification.**
  +11 to +13pp precision once verification has run; near-inert without it.
- **Simplify (#220): no detectable effect.** The run-1 "win" reversed sign in
  run 2. Not harmful, which is itself worth knowing.
- **The mootness gate (#228): no effect at all** — fully shadowed by rules that
  already existed, identically in both runs, under this verifier configuration.
- **The tests pass (#237): no measurable benefit**, plus a small precision cost.
  Weak evidence — the set has almost no test files.
- **Convergence (#206), grounded verification (#229), local grounding (#242),
  dismissal calibration (#230): unmeasured.** Not "no effect" — *unmeasured*.

The honest summary: **of the eight quality PRs, one is demonstrably doing the
work, one is positive but only in combination with it, two show nothing on this
set, and four could not be measured at all.** Nothing was found to have made the
output worse — but with recall pinned at 4/4 across 22 measurements, this set
could not have detected it if something had.

**The single highest-value follow-up is not another quality feature — it is
growing the golden set** with defects a model reports at MEDIUM or LOW severity,
and with a multi-persona fixture. Until then the harness can tell you whether a
change adds noise, and cannot tell you whether it costs you a bug.
