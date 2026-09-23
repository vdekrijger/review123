# AI-review quality baseline

The measured baseline for review123's reviewer output. Everything below comes
from runs actually executed on the date given; nothing is extrapolated.

**Three measurements live in this file**, newest first, each kept verbatim.

- [Measurement 3 (2026-09-23)](#measurement-3--2026-09-23--the-unanimity-carve-out-for-low)
  — the first measurement of a *fix*: does letting a unanimously-verified LOW
  stay inline recover the defect Measurement 2 found being eaten?
- [Measurement 2 (2026-09-23)](#measurement-2--2026-09-23--the-expanded-9-case-set)
  — the expanded 9-case golden set, and the measurement that found the loss.
- [Measurement 1 (2026-09-22)](#measurement-1--2026-09-22--the-6-case-seed-set-superseded)
  — the 6-case seed set eight quality PRs were never measured against.

Nothing is deleted when a measurement is superseded: the older numbers are the
evidence that the newer instrument is an improvement on the *instrument*, not
just on the numbers.

---

## The headline, in one line

**Measurement 3: the fix is provably correct on the case it was built for and
provably inert everywhere else — and it did not move recall in either fresh
run, because the verifier panel never repeated the unanimous verdict that
triggers it.** Re-scored against Measurement 2's own generations it takes
`app-default` from **8/9 to 9/9** in the run where the panel was unanimous, with
noise-rate unchanged. In two fresh live runs it fired **zero** times and the
numbers are byte-identical with and without it.

**Measurement 2: recall finally moved, and it moved downwards at the app's own
operating point.** The reviewer model finds **9 of 9** known-real defects at raw
generation, in both runs. What a user actually sees inline — variant
`app-default` — is **8 of 9**, in both runs. **The post-generation pipeline
costs one real defect out of nine.**

Measurement 1 reported recall 4/4 in all 22 of its measurements and said, in
its own honesty section, that the set "could not have detected over-filtering
if it were happening". It was happening.

---

## Measurement 3 — 2026-09-23 · the unanimity carve-out for LOW

### What was changed, and why this measurement exists

Measurement 2 found `findingTier` burying a real defect that the verifier panel
had unanimously confirmed. `findingRank.ts` now keeps a LOW inline when the
panel **unanimously** backed it on **both** axes — every polled model confirmed
(`confirmedBy === polledModels`), the engine surfaced it, `worthFlagging` is
explicitly `true`, and the poll was one that *could* have demoted it
(`verifierVotesCanDemote`, #253, so a 1-verifier poll where `2/2` always holds
is excluded as decorative). Nothing else about triage changed.

This section reports whether that helped. **No threshold was tuned in response
to any number below.**

### Run metadata

| | |
| --- | --- |
| Date | 2026-09-23 |
| Branch | `fix/finding-tier-verified-low` (off `b87727c`) |
| Golden set | 9 cases — 9 known-real findings, 17 known-noise (unchanged from M2) |
| Transport | local bridge (`POST /v1/infer`) — no API key, subscription-billed |
| Generator | `claude` CLI, via the bridge |
| Verifiers | `codex` CLI ×2 (`BRIDGE_VERIFY_CLIS=codex,codex`) |
| Mode | `--live --matrix --concurrency 3` |
| Live runs | **two** — `eval/unanimity-baseline-run.json`, `eval/unanimity-repeat-run.json` |
| Offline re-scores | Measurement 2's committed generations, re-scored under the new rule **and** under the old one — the only way to vary the policy while holding the model output fixed |

### A. The controlled measurement: same generations, only the rule changed

Re-scoring costs nothing and is the *only* comparison where the model output is
identical on both sides, so this is the measurement that actually isolates the
policy change.

| stored generation | `app-default` BEFORE | `app-default` AFTER | change |
| --- | --- | --- | --- |
| `expanded-baseline-run.json` (M2 run 1) | 8/9 · 36f · prec 62% · noise 6% (1/17) | 8/9 · 36f · prec 62% · noise 6% (1/17) | **nothing** |
| `expanded-repeat-run.json` (M2 run 2) | 8/9 · 42f · prec 40% · noise 6% (1/17) | **9/9** · 44f · prec 41% · noise 6% (1/17) | **+11pp recall, +2 findings, noise unchanged** |

M2 run 2 is the run whose panel voted `3/3 surfaced=true worthFlagging=true` on
`08-quiet-low` line 13. The carve-out recovers exactly that defect. M2 run 1 is
the run where verification had already demoted it (`1/3 surfaced=false`); triage
never saw it, so a triage rule cannot help, and the re-score confirms it changes
nothing there.

**`verify+triage` moves the same way** — 8/9 → 9/9 on run 2, 35f → 37f, precision
50% → 50%, noise 6% → 6% — so the gain is the triage rule, not an interaction
with simplify or convergence.

### B. The two fresh live runs: the fix was a complete no-op

| variant | run 1 | run 2 |
| --- | --- | --- |
| `generate-only` | 9/9 · 52f · 29% · 18% (3/17) | 8/9 · 53f · 21% · 41% (7/17) |
| `+tests-pass` | 9/9 · 70f · 23% · 18% | 9/9 · 71f · 18% · 41% |
| `+verify` | 9/9 · 40f · 45% · 6% | 7/9 · 43f · 25% · 6% |
| `+triage` | 8/9 · 46f · 31% · 18% | 7/9 · 47f · 20% · 41% |
| `verify+triage` | 8/9 · 33f · 57% · 6% | 7/9 · 32f · 37% · 6% |
| **`app-default`** | **8/9 · 40f · 38% · 6% (1/17)** | **8/9 · 39f · 50% · 6% (1/17)** |
| `app-default/show-all` | 8/9 · 48f · 28% · 6% | 8/9 · 49f · 31% · 6% |

Re-scoring both of these runs under the **pre-fix** rule reproduces every cell
above **exactly** — same finding counts, same recall, same precision, same
noise, in all thirteen variants of both runs. The carve-out fired zero times in
either run. So on fresh generations the fix is measurably neither a gain nor a
regression: it is inert.

### C. Why it stayed inert: the panel never repeated its verdict

The rule is deterministic given the verification tally. The tally is not. Here
is the panel's verdict on the *same* defect — `08-quiet-low` line 13, the `catch`
that discards its error — across all four runs this file now contains:

| run | panel on line 13 | what removed it | carve-out |
| --- | --- | --- | --- |
| M2 run 1 | `1/3`, `surfaced=false` | cross-model verification | inert (correctly — triage never saw it) |
| M2 run 2 | `3/3`, `surfaced=true`, `worth=true` | triage | **fires → 9/9** |
| M3 run 1 | `2/3`, `surfaced=true`, `worth=true` | triage | inert — majority, not unanimous |
| M3 run 2 | `1/3`, `surfaced=false` (both instances) | cross-model verification | inert (correctly) |

So the defect is lost to a *different* mechanism in three of four runs, and only
one of those mechanisms is the one this fix addresses. **The unanimous verdict
that triggers the carve-out occurred in 1 of 4 runs.** That is the honest reason
recall did not reach 9/9 on the fresh runs, and it is not a reason to loosen the
rule — see §E.

### D. Blast radius: how often the new rule fires at all

Across all four runs — **283 raw findings, 16 of them LOW** — the carve-out
promotes exactly **two**:

| run | promoted | what it is |
| --- | --- | --- |
| M2 run 2 | `08-quiet-low` L13 | **the real defect.** The point of the change. |
| M2 run 2 | `06-perf` (file-level) | a real observation — the added comment does not describe what the loop does — unanimously confirmed and worth-flagged, but matching no golden label, so it scores as precision dilution rather than noise |
| M2 run 1, M3 run 1, M3 run 2 | *(none)* | |

**Noise did not regress in any measurement.** `app-default` noise-rate is 6%
(1 of 17) in every run, before and after, and `02-clean-pr` and `03-noise-trap`
both end at **zero findings** in both fresh runs. The only cost measured is the
single unlabelled `06-perf` card — one extra inline card in one run of four.

### E. The threshold: what a looser rule would have bought, and why it was not taken

The obvious way to make the number move is to accept a *majority* instead of
unanimity. That was measured offline (same re-score method, **not shipped**):

| generation | unanimity (shipped) | majority + worth (not shipped) |
| --- | --- | --- |
| M2 run 1 | 8/9 · 36f | 8/9 · 36f |
| M2 run 2 | **9/9** · 44f | 9/9 · **45f** |
| M3 run 1 | 8/9 · 40f | `verify+triage` **9/9**; `app-default` 8/9 · 44f · prec 32% |

So majority *would* have recovered M3 run 1's defect at `verify+triage`. It is
still the wrong trade, for reasons that do not depend on this run:

1. **Majority is already the MEDIUM bar.** `isMajorityVerified` is what promotes
   a medium; using it for LOW too erases the severity distinction inside triage
   rather than carving out an exception to it.
2. **It fires far more often.** In M3 run 1 alone, majority-with-worth would
   promote three LOWs instead of zero, only one of which is a labelled defect.
3. **It is the Goodhart move.** The rule was designed before these runs existed;
   changing it *because* a run came back 2/3 would be tuning the policy to the
   instrument, which is the failure the golden set exists to prevent.

The stricter rule is the one whose justification survives the measurement. The
decision to loosen it belongs to the repo owner, with the numbers above.

### F. An instrument artifact worth recording

In M3 run 1, `app-default/show-all` also scores 8/9 even though the line-13
finding is *present* in its output. The simplify pass rewrote "discards the
original RangeError" to "drops the original RangeError", and that one word puts
the body under the matcher's Jaccard bar for the golden label. This is
Measurement 2's "simplify's recall effect is entangled with the matcher" caveat
firing again, and it means that in that run the harness cannot fully separate
"triage hid it" from "the matcher lost it". The `+verify` row (9/9, no simplify)
is the clean read for that run.

### G. What this measurement still canNOT tell you

1. **The recall gain rests on one re-scored run.** It is a correct,
   mechanistically-understood gain, not a rate.
2. **Two live runs is not enough to estimate how often the panel is unanimous.**
   1 of 4 is the whole sample.
3. Every Measurement 2 caveat still applies: 9 real findings is small, precision
   jitter on this set is ~±20pp, grounded verification and deep review are still
   unmeasurable over this transport, and the mootness gate has still never been
   observed in its design regime.
4. **The carve-out depends on the worth axis being populated.** With
   `worthFlagging` stripped (`app-default/moot-off`) it cannot fire — visible in
   the M2 run 2 re-score, where `moot-off` stays at 8/9 while `app-default`
   reaches 9/9. That is self-consistent (no worth evidence, no promotion) and
   carries no product risk, because the mootness gate is not user-toggleable —
   `moot-off` exists only as an instrument variant.

### The mock baseline (harness mechanics only)

`pnpm eval` with no flags, on this branch: recall 100% (9/9), precision 82%,
noise-rate 6% (1/17), 23 findings, PASS — identical to Measurement 2's mock
baseline, confirming the change did not disturb the scoring plumbing.

### Verdict

- **The fix is correct and narrow.** It recovers the exact defect Measurement 2
  documented being eaten, in the exact conditions that defect was eaten under,
  and it is a provable no-op everywhere else: 2 promotions in 283 findings.
- **It did not move recall on fresh generations**, because the verifier panel
  returned a unanimous verdict on that defect in only 1 of 4 runs. Reported as
  measured; no threshold was adjusted to improve it.
- **No noise regression was measured.** Noise-rate is 6% (1/17) in every run
  before and after; the clean-PR and noise-trap cases stay at zero findings.
- **The residual recall loss is now mostly cross-model verification, not
  triage** — it removed the defect in 2 of 4 runs. That is the next thing worth
  measuring, and it is a different change from this one.

---

## Measurement 2 — 2026-09-23 · the expanded 9-case set

### Run metadata

| | |
| --- | --- |
| Date | 2026-09-23 |
| Commit | `9974879` (branch `feat/golden-set-expansion`) |
| Golden set | **9 cases — 9 known-real findings, 17 known-noise** (was 6 / 4 / 11) |
| Transport | local bridge (`POST /v1/infer`) — no API key, subscription-billed |
| Generator | `claude` CLI, via the bridge |
| Verifiers | `codex` CLI ×2 (`BRIDGE_VERIFY_CLIS=codex,codex`) |
| Mode | `--live --matrix --concurrency 3` |
| Wall time | ~11.5 min (run 1), ~12.5 min (run 2) |
| Runs | **two** identical runs on the same commit — `expanded-baseline` and `expanded-repeat` |

Same transport and same verifier configuration as Measurement 1, deliberately,
so the two are comparable. Reproduce with:

```bash
node bridge/dist/cli.js --port 7739 --token-file .bridge-token
BRIDGE_URL=http://127.0.0.1:7739 BRIDGE_TOKEN_FILE=.bridge-token \
  BRIDGE_VERIFY_CLIS=codex,codex \
  pnpm eval -- --live --matrix --concurrency 3 --label expanded-baseline
pnpm eval:rescore eval/expanded-baseline-run.json -- --per-case   # free, no model calls
```

### What changed about the instrument

Three cases were added, chosen so they **can fail**:

| case | the defects | why it can detect what the seed set could not |
| --- | --- | --- |
| `07-quiet-medium` | a TTL default that silently changed units (5 minutes → 5 ms), and a `slice(0, count - 1)` bound | MEDIUM is the tier where `findingTier` weighs verification |
| `08-quiet-low` | an error message interpolating `${min}` twice, and a `catch` that discards its caught error | a non-convergent LOW is **always** secondary — the sharpest probe in the set |
| `09-two-reviewers` | one dropped `await`, raised by two personas on different lines in different words | the first multi-persona fixture, so convergence (#206) has something to merge |

All four of Measurement 1's real findings are HIGH, and `findingTier` never
demotes a non-moot HIGH. That is why its recall could not move.

The harness also gained a real `convergence` stage: it now runs the app's own
convergence pass and **attaches** the merge rather than applying it, so the
stage is a genuine on/off switch. Stored runs stay re-scorable —
`pnpm eval:rescore eval/baseline-run.json` reproduces every one of
Measurement 1's published numbers exactly.

### The headline: the app's inline surface today

Variant `app-default` — every post-generation stage on, which is what a user
sees without clicking "show all findings". Both runs shown; where they
disagree, the disagreement is the finding.

| case | findings (1 / 2) | recall (1 / 2) | precision (1 / 2) | noise-rate (1 / 2) |
| --- | --- | --- | --- | --- |
| `01-real-bug` | 4 / 5 | 100% / 100% | 100% / 50% | 0% / 0% |
| `02-clean-pr` | 0 / 0 | — (0/0) | 100% / 100% | 0% / 0% |
| `03-noise-trap` | 0 / 0 | — (0/0) | 100% / 100% | 0% / 0% |
| `04-refactor` | 4 / 6 | 100% / 100% | 33% / 50% | 0% / 0% |
| `05-security` | 4 / 4 | 100% / 100% | 33% / 50% | **50%** / 0% |
| `06-perf` | 4 / 6 | 100% / 100% | 100% / 33% | 0% / **100%** |
| `07-quiet-medium` | 8 / 8 | 100% / 100% (2/2 both) | 67% / 50% | 0% / 0% |
| `08-quiet-low` | 4 / 5 | **50% / 50%** (1/2 both) | 100% / 33% | 0% / 0% |
| `09-two-reviewers` | 8 / 8 | 100% / 100% | 100% / 25% | 0% / 0% |
| **aggregate** | **36 / 42** | **89% / 89%** (8/9 both) | **62% / 40%** | **6% / 6%** (1/17) |

`02-clean-pr` and `03-noise-trap` still end at **zero findings** in both runs —
the reviewer says nothing on a clean PR and does not take the noise bait. That
half of the result is unchanged and good.

### Stage-by-stage: what each filter costs and buys

One generation per case, scored under each combination. Both runs.

| variant | findings (1 / 2) | **recall (1 / 2)** | precision (1 / 2) | noise-rate (1 / 2) |
| --- | --- | --- | --- | --- |
| `generate-only` | 52 / 54 | **100% / 100%** (9/9 both) | 26% / 26% | 29% / 29% (5/17) |
| `+tests-pass` | 70 / 72 | **100% / 100%** | 21% / 21% | 29% / 29% |
| `+verify` | 40 / 45 | **89% / 100%** | 36% / 38% | 12% / 6% |
| `+convergence` | 51 / 52 | **100% / 100%** | 26% / 27% | 29% / 29% |
| `+triage` | 48 / 50 | **100% / 89%** | 27% / 27% | 29% / 29% |
| `verify+triage/moot-off` | 30 / 35 | **89% / 89%** | 53% / 50% | 12% / 6% |
| `verify+triage` | 29 / 35 | **89% / 89%** | 57% / 50% | 12% / 6% |
| `app-default` | 36 / 42 | **89% / 89%** | 62% / 40% | 6% / 6% |
| `app-default/show-all` | 46 / 54 | **89% / 100%** | 36% / 31% | 6% / 6% |
| `app-default/simplify-off` | 36 / 42 | **89% / 100%** | 53% / 47% | 12% / 6% |
| `app-default/moot-off` | 37 / 42 | **89% / 89%** | 57% / 40% | 6% / 6% |
| `app-default/convergence-off` | 36 / 42 | **89% / 89%** | 53% / 42% | 6% / 6% |
| `app-default/tests-off` | 29 / 34 | **89% / 89%** | 73% / 50% | 6% / 6% |

### The finding that gets eaten, exactly

Both runs lose the **same** defect: `08-quiet-low` line 13 — the `catch` in
`parsePort` that discards its caught `err` and rethrows a bare message,
throwing away which bound was violated. The model **found it in both runs**,
from both the implementation and the tests pass. It is removed by a different
filter each time:

- **Run 1 — cross-model verification removed it.** The reviewer rated it
  MEDIUM; the codex panel voted `confirmedBy 1/3`, `surfaced=false`,
  `worthFlagging=false`. It disappears at `+verify` and never comes back —
  note `app-default/show-all` stays at 89%, because "show all findings" only
  undoes triage, not verification.
- **Run 2 — triage removed it.** Here the panel was *unanimous*:
  `confirmedBy 3/3`, `surfaced=true`, `worthFlagging=true`. The reviewer rated
  it LOW, and `findingTier`'s rule for LOW is `if (!convergent) return
  'secondary'` — a lone LOW is collapsed **no matter how strongly it was
  verified**. `app-default/show-all` recovers it to 100%, which confirms triage
  as the cause.

Run 2's mechanism is the more important of the two, because it is not model
noise: it is a deterministic policy in `findingRank.ts`. **A real defect that
three of three verifiers confirm as real and worth flagging is still hidden
from the inline surface if one reviewer rated it LOW.** Whether that is the
right trade is a product decision — this file only reports that the trade is
being made, and how often. Nothing was tuned in response to it.

### Read-outs

**Cross-model verification is still the biggest noise win, and it now has a
measured recall cost.** Noise-rate 29% → 12% / 6% in the two runs, findings
52 → 40 and 54 → 45. That reproduces Measurement 1's headline result. What is
new is the other side of the ledger: in run 1 it also removed a real defect.
One of two runs, so treat the cost as *demonstrated to be possible*, not as a
rate.

**Triage's recall cost is structural, not stochastic.** `+triage` alone: recall
100% in run 1 and 89% in run 2. The rule that produced the run-2 drop is
readable in the source and will fire on any non-convergent LOW. Triage is still
the second-biggest precision win once verification has run (`+verify` 36% →
`verify+triage` 57% in run 1; 38% → 50% in run 2), so this is a trade, not a
defect — but it is now a *measured* trade.

**Simplify (#220) broke one match in run 2, and did nothing in run 1.**
`app-default/simplify-off` is 100% against `app-default` at 89% in run 2.
*Read this one carefully:* the simplified text still describes the defect
perfectly well to a human — what it lost was enough token overlap with the
golden label to clear the matcher's 0.12 Jaccard bar. So this is partly an
instrument-resolution artifact. It is still worth knowing, because it is
exactly the failure mode the rewrite risks: the rewrite dropped the technical
anchors the label was written around. Measurement 1 concluded simplify had "no
detectable effect on matching"; with more findings in flight, it has one.

**The mootness gate (#228) is still very nearly inert.** `app-default` vs
`app-default/moot-off`: 36 vs 37 findings in run 1, identical in run 2; recall
unchanged in both. It removed exactly one finding across two runs. Measurement
1's caveat still applies and still explains it — with two instances of the same
verifier model a finding's confirm count is effectively 1/3 or 3/3, and the 2/3
middle where the gate is designed to bite never occurs.

**Convergence (#206) is measurable for the first time, and shows no metric
effect.** On `09-two-reviewers` the pass formed **3 clusters, absorbing 9 of 13
reviewer findings**, every cluster spanning both personas — so the mechanism
demonstrably works. But `app-default` and `app-default/convergence-off` have
identical finding counts (36/36, 42/42) and identical recall in both runs;
precision differs by +9pp and −2pp, which is well inside this set's jitter.
Honest read: **convergence deduplicates cards without changing what is found or
hidden, measured on one fixture.** One multi-persona case is not enough to
generalise.

**The separate tests pass (#237) costs precision, reproducibly.** At the
operating point it adds 7-8 findings for −11pp and −10pp of precision
(`app-default` 62%/40% vs `app-default/tests-off` 73%/50%) with recall
unchanged. That is a stronger version of Measurement 1's "no measurable
benefit", now in the same direction twice. The caveat also survives: the golden
set still has almost no test files, so this measures a tests reviewer with
nothing to review.

### Run-to-run variance — and an inversion worth noting

| quantity | run 1 | run 2 | read |
| --- | --- | --- | --- |
| recall, `generate-only` | 9/9 | 9/9 | **stable** |
| recall, `app-default` | 8/9 | 8/9 | **stable — and it is not 9/9** |
| which stage ate it | verification | triage | **the loss is stable; the mechanism is not** |
| noise-rate, `app-default` | 6% | 6% | stable (1 of 17) |
| raw findings | 52 | 54 | ±4% volume |
| precision, `app-default` | 62% | 40% | **±22pp of jitter** |

**The instrument has inverted since Measurement 1.** There, recall was
perfectly stable *because it was insensitive*, and precision jittered ±8pp.
Here recall is stable *and load-bearing* — the same defect is lost in both runs
— while precision jitter has grown to **±22pp**, because precision is dominated
by unmatched findings and the raw volume is larger.

Practical rules for this set:

- **Recall is now the trustworthy signal.** One real finding = 11pp. A recall
  move that reproduces across two runs is evidence.
- **Precision deltas under ~20pp are not evidence** on this set. That is worse
  than Measurement 1's ~8pp rule and it invalidates finer precision readings.
- **Noise-rate moves in 5.9pp steps** (17 labels), better resolution than the
  seed set's 9pp.

### What this baseline still canNOT tell you

1. **Nine real findings is still small.** One missed finding is 11% of recall.
2. **The recall loss rests on one case.** `08-quiet-low` is the only case that
   loses anything, in both runs. The result "the pipeline costs a real defect"
   is well-evidenced for *this class* of defect (a genuine, low-severity, easily
   dismissed one) and is not yet a rate.
3. **Convergence is measured on exactly one fixture.** Its "no metric effect"
   read-out is weak for that reason.
4. **Grounded verification (#229), deep review (`--deep`) and local grounding
   (#242) are still unmeasured** — the bridge's `/v1/infer` runs the CLI with
   `--tools ""`, so the tools those features depend on do not exist on this
   transport. Unchanged from Measurement 1.
   > **SUPERSEDED BY CAPABILITY (2026-09-23, #266 / #267).** The premise stopped
   > being true after this measurement was taken: bridge 0.3.0 added
   > `InferRequest.agentic`, which runs the CLI *with* read-only tools. The
   > limitation above is a correct record of what the transport did on the date
   > given — it is no longer a statement about the transport today. Measured in
   > [Measurement 4](#measurement-4--2026-09-23--grounded-verification-deep-review-and-local-grounding).
5. **Dismissal calibration (#230) is still unmeasured** — the fixtures are
   synthetic and have no dismissal ledger.
6. **The mootness gate has still never been observed in its design regime**, for
   the verifier-panel reason above.
7. **Simplify's recall effect is entangled with the matcher.** Separating "the
   rewrite lost the point" from "the rewrite lost the tokens" needs a human
   read, not a Jaccard score.

### The mock baseline (harness mechanics only)

`pnpm eval` with no flags, same commit: recall 100% (9/9), precision 82%,
noise-rate 6% (1/17), 23 findings, PASS. This proves the scoring and matching
plumbing works. It says nothing about model quality — the "model" is a scripted
stub.

### Verdict

Measured on this set, on this date, with this transport:

- **The pipeline costs one real defect in nine, at its own operating point,
  reproducibly.** That is the result the expanded set was built to be able to
  produce, and it is the first time the harness has produced it.
- **Cross-model verification: still the largest noise win** (29% → 6-12%), now
  with a demonstrated recall cost in one run of two.
- **Triage: a real precision win downstream of verification, with a structural
  recall cost** — every non-convergent LOW is collapsed regardless of
  verification strength.
- **Simplify: one broken match in two runs**, at least partly a matcher artifact.
- **The mootness gate: still effectively inert** under this verifier config.
- **Convergence: now measurable, merges as designed, no metric effect on one
  fixture.**
- **The tests pass: a reproducible precision cost with no measured benefit**, on
  a set with almost no test files.

No threshold, prompt or ranking rule was changed in response to any of this.
The next decision — whether `findingTier` should bury a unanimously-verified
LOW — belongs to the repo owner, not to the instrument.

---

## Measurement 1 — 2026-09-22 · the 6-case seed set (superseded)

*Kept verbatim. This is the baseline the eight quality PRs of 2026-06..09 were
never measured against, and the one whose flat 4/4 recall motivated the expanded
set. Its numbers are still reproducible from the committed run:*
`pnpm eval:rescore eval/baseline-run.json`.

**Why this file was written.** Between 2026-06-15 and 2026-09-22 eight PRs
shipped claiming to improve finding quality — convergence (#206), simplify
(#220), findingRank triage (#226), solutions + the mootness gate (#228),
grounded verification (#229), dismissal calibration (#230), phase-scoped
reviewers + a separate tests pass (#237) and local grounding (#242). The eval
harness existed the whole time and was never run against any of them. This is
the number the ninth change had to beat.

### Run metadata

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

### The headline: the app's inline surface today

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

### Stage-by-stage: did the filtering help, or just hide things?

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

#### Read-outs

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

### What this baseline canNOT tell you

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
   > **SUPERSEDED BY CAPABILITY (2026-09-23, #266 / #267)** — items 3 and 4 both.
   > Bridge 0.3.0's `InferRequest.agentic` runs the CLI with read-only tools, so
   > the "those tools do not exist on this transport" premise no longer holds.
   > The text stays as the correct record of 2026-09-22. Measured in
   > [Measurement 4](#measurement-4--2026-09-23--grounded-verification-deep-review-and-local-grounding).
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

### Run-to-run variance

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

### The mock baseline (harness mechanics only)

`pnpm eval` with no flags, same commit: recall 100% (4/4), precision 67%,
noise-rate 9% (1/11), 13 findings. This proves the scoring and matching plumbing
works. It says nothing about model quality — the "model" is a scripted stub.

---

### Verdict on three months of quality work

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
