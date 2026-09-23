# UI refactor plan — phased, reviewable, revertible

Companion to [`ui-audit.md`](./ui-audit.md) (the findings, `F1`-`F18`) and
[`refactoring-ui-principles.md`](./refactoring-ui-principles.md) (the rubric and
its page refs).

**Status: Phase 1 shipped. Phase 2 in progress — Batches 2A, 2B and 2C shipped,
Batch 2D's first two slices shipped with more to come. Phase 3 shipped, and its
one deferred item is now closed — measured, and deliberately not changed.**

Phase 1 landed as one PR — see [Phase 1 — as shipped](#p1-shipped) for what
changed against what this document proposed, and for the measurements taken from
the built app rather than from the token values. Batch 2B likewise records what
it actually decided in [Batch 2B — as shipped](#b2b-shipped); later batches
should inherit its [border rule](#b2b-border) rather than re-litigate it. Batch
2C follows in [Batch 2C — as shipped](#b2c-shipped), which also corrects one of
the audit's own measurements ([F8](./ui-audit.md#f8)). Batch 2A closes Phase 2's
form work in [Batch 2A — as shipped](#b2a-shipped), which corrects one of *this
document's* items — [F14](./ui-audit.md#f14) had already been fixed, by Phase 1.
Batch 2D's opening slice is in [Batch 2D — as shipped](#b2d-shipped), with the
ledger that measures every later slice; its second slice
([slice 2](#b2d-slice2)) takes the two things that slice deliberately left
open — it **decides** [F18](./ui-audit.md#f18) rather than freezing it
([the weight set](#f18-decided)), and converges the hand-copied settings cards
onto `.card`. Phase 3 closes the diff viewer in
[Phase 3 — as shipped](#p3-shipped): it settles the recede question Phase 1
deliberately left open, and it confirms Batch 2B's suspicion about
`SymbolPopover.svelte` — measured, that was a live bug. Its deferred item 4
closes in [Phase 3, item 4 — measured, not changed](#p3-item4), which disproves
one of the audit's own claims and ships a measurement instead of a change.

The screenshots in [`./shots/`](./shots/) are the **after** state of the whole
tree, and **nothing in the set is stale any more**: all fourteen are re-captured
together by [`scripts/capture-shots.mjs`](../../scripts/capture-shots.mjs), which
is the committed recipe — see [the capture script](#capture-script). `focus-dim-*`
stays byte-identical to `step2-inspect-unified-*`, and that is now a recorded
property of the set rather than an accident: the two recipes ARE the same recipe,
because focus mode's import dimming is already on in the unified shot.
The pre-Phase-1 before state is in git
history at commit `38b9e9a`; at commit `038e6d4`, the pre-Batch-2B state of
`step1-understand-*.png` and the pre-Batch-2C state of the settings page and the
Inspect step; at commit `1e2de30`, the pre-Batch-2A state of all fourteen; at
commit `a83a56d`, the pre-Phase-3 state of the six diff shots.

Batch 2D is the one batch with work still outstanding; its remaining token
values remain *proposed and measured*, not applied.

---

## Sequencing, and why

Three phases, each independently shippable and independently revertible.

| phase | scope | why here |
|---|---|---|
| **1** | Token layer only — invert the authoring order to light-first, define what is missing, fix the measured contrast failures | Everything downstream is judged against these values. Doing it second means doing every component twice. |
| **2** | Component batches by theme: forms/inputs → cards/panels → nav/settings | Each batch is a coherent visual language, reviewable on its own, and the batches touch disjoint files. |
| **3** | The diff viewer | Densest surface; wraps a pnpm-patched dependency; carries the `0.45` dimming from focus mode and hunk attention. Touching it early would fight every other batch, and its palette fork ([F5](./ui-audit.md#f5)) can only be resolved once the tokens it should adopt are settled. |

**The one-sentence case for the order:** the palette the owner actually reads in
is the *derived* one, so it has never been verified — invert that first, and
every later judgement is made against values that are known good.

---

## Phase 1 — token inversion (light-first)

### The problem this solves

Every colour in `src/app.css` was authored against `#14161a` and then re-mapped
for light. The audit's measurements show the consequence: dark mode clears AA
everywhere, and nearly every failure is light-only —
[F3](./ui-audit.md#f3) (accent illegal as text), [F4](./ui-audit.md#f4) (the
recede opacity), [F11](./ui-audit.md#f11) (invisible control boundaries),
[F16](./ui-audit.md#f16) (the changed chip). That is the signature of a palette
derived rather than verified.

The owner reads exclusively in light mode, and their stated constraint is that
*"reading on a light background with black text helps parsing things, and improves
readability."* The palette serving that requirement is the one nobody checked.

**The proposal: author light directly against white with dark text, verify contrast
there, and derive dark from it.** Keep all three modes (`auto` / `dark` / `light`)
and keep `auto` as the default.

<a id="p1-1"></a>

### P1-1 — de-duplicate the light palette first

**Do this before touching a single value.** `src/app.css:123-156` and
`src/app.css:159-194` currently contain **30 byte-identical declarations** — the
explicit `:root[data-theme='light']` block and the `@media (prefers-color-scheme: light)`
block ([F17](./ui-audit.md#f17)). Editing a palette that exists twice is how a
token silently diverges between the two ways a user reaches light mode.

Collapse to one source. Either:

```css
:root[data-theme='light'],
@media (prefers-color-scheme: light) { :root:not([data-theme]) { … } }
```
(not expressible as one selector — so:)

```css
/* Declare the light palette ONCE, in a custom-property-only rule. */
:root[data-theme='light'] { /* …the 30 declarations… */ }

@media (prefers-color-scheme: light) {
  :root:not([data-theme]) { /* re-declare by @apply-like reference, or */ }
}
```

CSS has no include, so the honest options are (a) accept the duplication but add
a unit test asserting the two blocks are identical (cheap, mechanical, catches
every future drift), or (b) emit the light block from a single source at build
time. **(a) is recommended** — it is a ~15-line test, no build complexity, and it
converts a silent hazard into a red CI light. It also pairs naturally with
[P1-6](#p1-6).

*Zero visual change. Ship it on its own.*

<a id="p1-2"></a>

### P1-2 — the proposed light palette (authored, measured on white)

Every ratio below is measured, not estimated. Floors: 4.5:1 normal text, 3:1
large text and non-text boundaries (p.142, SC 1.4.11).

```css
/* ── Light palette — AUTHORED. Verify every change against this block. ── */
--bg:              #faf8f4;   /* page ground (p.132: lightest grey, not pure white) */
--surface:         #ffffff;   /* cards/panels come FORWARD (p.167-168) */
--surface-sunken:  #f4f1ea;   /* wells, inputs, inactive chips — RENAMED, see P1-5 */

--hairline:        #ded9cf;   /* decorative separation ONLY */
--border-control:  #8d8370;   /* NEW — control boundaries, 3:1 (SC 1.4.11) */

--text:            #1f2328;   /* primary  */
--text-secondary:  #4a5158;   /* NEW — second of three tiers (p.34) */
--text-muted:      #6e6a61;   /* tertiary */

--accent:          #1f7a66;   /* CHANGED from #2e8b78 */
--accent-subtle:   rgba(31,122,102,.10);
--on-accent:       #ffffff;   /* NEW — was undefined (F1) */

--recede-opacity:  0.55;      /* NEW — see P1-4 */
```

Measured:

| token | on `--bg` | on `--surface` | on `--surface-sunken` | floor |
|---|---|---|---|---|
| `--text` | 14.89 | 15.80 | 14.00 | 4.5 |
| `--text-secondary` | 7.59 | 8.05 | 7.14 | 4.5 |
| `--text-muted` | 5.08 | 5.39 | 4.78 | 4.5 |
| `--accent` as text | **4.91** | **5.21** | **4.62** | 4.5 |
| `--border-control` | 3.53 | 3.74 | 3.32 | 3.0 |

| pair | measured | floor |
|---|---|---|
| `--on-accent` on `--accent` | **5.21** | 4.5 |
| `--accent` as a fill vs `--surface` | 5.21 | 3.0 |

**Why `#1f7a66` and not today's `#2e8b78`.** It is the only candidate on the ramp
that clears 4.5:1 with margin *both* as text on every light ground *and* as a fill
carrying white — so it repairs [F3](./ui-audit.md#f3) and [F1](./ui-audit.md#f1)
with one value, rather than needing a separate "accent for text" token. It is one
step darker on the same hue, well inside the ≤20-30° rotation limit (p.138) —
in fact no rotation at all.

| candidate | as text on `#ffffff` | on `#faf8f4` | white on it | `#0a1410` on it |
|---|---|---|---|---|
| `#2e8b78` *(today)* | **4.13** | **3.90** | **4.13** | 4.53 |
| `#24806c` | 4.80 | 4.52 | 4.80 | **3.91** |
| **`#1f7a66`** ← | **5.21** | **4.91** | **5.21** | 3.60 |
| `#176b59` | 6.40 | 6.03 | 6.40 | 2.93 |

`#24806c` is the **minimal-shift alternative** if the visual change proves too
large in review: it also clears every floor, with less margin (4.52 on `--bg`).

**Status colours** — only `changed` needs a repair ([F16](./ui-audit.md#f16)):

```css
--legend-changed-color: #8f5f00;   /* was #9a6700 — 4.45:1 FAIL -> 5.04:1 */
```
Added (4.71), removed (4.59) and unchanged (5.04) pass and stay. They pass
*narrowly*, which is worth noting: if the tints are ever re-toned, re-measure.

<a id="p1-3"></a>

### P1-3 — the derived dark palette

Derived from light by lifting the greys and the accent back up the same hue.
**A dark-mode user sees no change, with exactly one deliberate exception, flagged
below.**

```css
/* ── Dark palette — DERIVED from the light block above. ── */
--bg:              #14161a;   /* unchanged */
--surface:         #1b1e24;   /* unchanged */
--surface-sunken:  #22262d;   /* unchanged value, renamed (P1-5) */

--hairline:        #2e333b;   /* unchanged */
--border-control:  #6b7380;   /* NEW — 3.79/3.49/3.17 on bg/surface/sunken */

--text:            #e8e6e1;   /* unchanged */
--text-secondary:  #b4b1a9;   /* NEW — 8.45/7.79/7.09 */
--text-muted:      #9a9890;   /* unchanged */

--accent:          #4db6a0;   /* unchanged — already 6.16-7.34:1 as text */
--accent-subtle:   rgba(77,182,160,.12);  /* unchanged */
--on-accent:       #0a1410;   /* NEW — 7.60:1 (was undefined -> #fff at 2.47:1) */

--recede-opacity:  0.45;      /* unchanged */
```

Every existing dark value is preserved. Validated: all 24 checks pass.

> **⚠️ The one dark-mode visual change, stated honestly.** Defining `--on-accent`
> in dark flips the six call sites in [F1](./ui-audit.md#f1) — the AI-models mode
> segmented control and the model-combobox's selected lab row — from white text
> (**2.47:1**, a hard WCAG failure) to `#0a1410` (**7.60:1**). Those two controls
> *will* look different in dark mode. This is a contrast repair, not a restyle,
> and it is the reason `--on-accent` cannot simply be defined as `#ffffff`
> everywhere: an accent that carries white on a light ground does not carry it on
> a dark one. Call it out in the Phase 1 PR body so it is not mistaken for drift.

<a id="p1-4"></a>

### P1-4 — `opacity: 0.45`, the recede token

Two problems are stacked here ([F4](./ui-audit.md#f4)); they need separate
answers.

**(a) The value is theme-dependent — tokenise it.**

`0.45` was tuned against `#0d1117`. Measured on the diff's real grounds:

| ground | dark @0.45 | light @0.45 | light @**0.55** |
|---|---|---|---|
| context line | 4.53 | **3.35** | **4.76** |
| added line | 4.29 | **3.30** | **4.64** |
| removed line | 4.44 | **3.28** | **4.60** |

Parity with dark's 4.53:1 requires alpha **0.54**; **0.55** is the scale value and
clears AA on all three grounds. Proposal:

```css
:root                      { --recede-opacity: 0.45; }  /* dark  */
:root[data-theme='light']  { --recede-opacity: 0.55; }  /* light */
```

and replace the two literals at `src/components/FileDiff.svelte:1685` and `:1704`
with `opacity: var(--recede-opacity)`.

**Do not fold the disabled-state opacity into this token.** The 13 `0.45`
literals in the app serve three distinct semantics — receded *content*, a
*disabled control*, de-emphasised *chrome*. They are one number by coincidence.
Give them three tokens (`--recede-opacity`, `--disabled-opacity`,
`--chrome-muted-opacity`) so they can be tuned independently; that satisfies
p.27-28 without pretending three meanings are one.

**(b) Opacity is the wrong tool over coloured text — accept the limit, in writing.**

Alpha collapses every hue toward the ground at once, so the syntax tokens fall
much further than the base ink:

| token | dark @0.45 | light @0.45 | light @0.55 | light @0.70 |
|---|---|---|---|---|
| comment | 2.18 | **1.83** | 1.97 | **2.74** |
| keyword | 2.39 | **1.97** | 2.14 | 2.90 |

**No alpha that still reads as "receded" holds 3:1 for coloured syntax** — not
even 0.70, which barely looks receded at all. `0.55` is therefore the right
*immediate* fix (it restores the base ink to parity and stops the regression on
white), but the real answer belongs to Phase 3: recede by **substituting a single
muted ink for the syntax set** on receded rows, rather than by alpha. That keeps
one measurable colour instead of six unmeasurable ones, and it is the only way to
put a floor under it. Recorded as rubric B5.

**How to verify (a) before shipping.** Three gates, in order:

1. **Computed.** Extend the contrast unit test ([P1-6](#p1-6)) to assert
   `--text` at `--recede-opacity` over each of the three diff grounds clears
   **3:1** in both themes, and that the two themes land within ±0.3 of each other.
   This is the one that catches regressions forever.
2. **Visual, side by side.** Re-capture `shots/focus-dim-{light,dark}.png` with
   the same script at the same route and viewport and put the before/after pairs
   in the PR. The demo PR has 8 dimmed rows with default settings, so the shot is
   deterministic.
3. **Read it.** Open `/demo` step 2 in light with `Focus: imports` and
   `Hunk focus: on`, and confirm the receded rows still read as *receded* and not
   as *disabled*. 0.55 is a 22% change in alpha; the risk is over-correcting into
   "not actually de-emphasised". If it reads too present, `0.52` still clears AA
   on context (4.34) and added (4.24) — but do not go below `0.50`, which fails
   (3.98/3.89/3.87).

<a id="p1-5"></a>

### P1-5 — token naming, resolved during the inversion

Two names to settle while the file is open, both cheap now and expensive later:

- **`--surface-raised` → `--surface-sunken`.** In light it is `#f4f1ea`, *darker*
  than both `--surface` and `--bg`, and it is used for wells, inputs and `.btn`.
  p.167-168 says lighter comes forward, darker recedes — so the value is right for
  a well and the *name* is wrong. Renaming it makes the flat-depth rule usable in
  Phase 2 instead of contradicting it. Keep `--surface-raised` as a deprecated
  alias for one release.
- **`--accent-contrast` → `--on-accent`.** Two token names exist for one role
  ([F2](./ui-audit.md#f2)); one is undefined. Standardise on `--on-accent`, keep
  `--accent-contrast` as an alias, and replace the hardcoded `#0a1410` at
  `src/app.css:283` and `src/routes/Landing.svelte:762` with it — they are the two
  places that will otherwise not follow the palette at all.

*Both are mechanical. The alias makes them zero-risk.*

<a id="p1-6"></a>

### P1-6 — make the measurements a gate, not a one-off

Add `src/lib/theme/contrast.test.ts` (vitest, no DOM needed — pure arithmetic on
the token values):

1. Parse the token blocks out of `src/app.css` (or, better, move the palettes into
   a typed `tokens.ts` the CSS is generated from — larger change, propose
   separately).
2. Assert, for **both** themes:
   - each of the three text tiers ≥ 4.5:1 on `--bg`, `--surface`, `--surface-sunken`;
   - `--accent` as text ≥ 4.5:1 on all three;
   - `--on-accent` on `--accent` ≥ 4.5:1;
   - `--border-control` ≥ 3:1 on all three;
   - each status ink ≥ 4.5:1 on its own tint;
   - `--text` at `--recede-opacity` ≥ 3:1 on each diff ground.
3. Assert the two light blocks are identical ([P1-1](#p1-1)).

This is ~120 lines and it converts the whole of Appendix A into a red light. It
is the deliverable that stops this audit from being needed twice.

### Phase 1 shipping order

| PR | contents | visual change |
|---|---|---|
| 1a | [P1-1](#p1-1) de-duplicate + identity test | **none** |
| 1b | [P1-6](#p1-6) contrast test, asserting **today's** values, with the known failures marked `.fails()` / skipped and referenced to this doc | **none** |
| 1c | [P1-5](#p1-5) renames + aliases, literals → tokens | **none** |
| 1d | [P1-2](#p1-2) + [P1-3](#p1-3) the palette inversion; flip the skipped assertions green | **light: yes. dark: only the `--on-accent` repair** |
| 1e | [P1-4](#p1-4) recede tokens | light diff dimming only |

1a-1c are pure refactors and can ship while the owner is working. **1d and 1e are
the first PRs in this whole plan that change what the owner sees** — they should
land at a moment of their choosing, with the before/after shots in the PR body.

<a id="p1-shipped"></a>

### Phase 1 — as shipped

Shipped as **one** PR rather than the five above, split into commits along the
1a-1e seams so each step is still reviewable on its own: the structural collapse
(no pixel changes), then the token values with their tests, then the
token-consumption fixes. The staged `.fails()` step (1b) was dropped — it exists
only to keep an intermediate tree green, and there was no intermediate tree.

**Three things differ from what this document proposed. Each is an
improvement on the proposal, not a substitution of a measured value — every
token value shipped exactly as specified in [P1-2](#p1-2) and [P1-3](#p1-3).**

1. **[P1-1](#p1-1) used `light-dark()`, not the recommended option (a).** The
   plan offered (a) keep the duplication and test it, or (b) generate the CSS at
   build time, and recommended (a). There is a third option it did not consider:
   `light-dark(light, dark)` puts both themes in a **single declaration** per
   token, resolved against the `color-scheme` already set on `:root`. That
   removes the duplication outright instead of testing for it, needs no build
   step, and is supported by every browser this app targets. 30 duplicated
   declarations became 0.

   Two tokens cannot use it, because it takes `<color>` and they are not
   colours: `--select-chevron` (a `url()`) and `--recede-opacity` (a number).
   Those two are still written out for both dark paths — the last 2
   declarations of the original 30 — and are pinned by both tests below.

2. **The `#0a1410` convergence was larger than [F2](./ui-audit.md#f2) recorded.**
   The audit named two hardcoded literals; grep found **six**, every one on a
   `background: var(--accent)` fill. This mattered more than tidiness: `#0a1410`
   on the new light accent measures **3.60:1**, so leaving them literal would
   have turned the accent repair into a regression on six live buttons.

3. **[F14](./ui-audit.md#f14) was a three-link bug, not two.** The audit records
   `BridgeSection`'s links as correctly styled; in fact its `.install a` rule
   covers only the install block, so the link inside its `.field-note` was
   rendering in the same UA-default `#0000EE`. All three are fixed.

**Measured in the built app** (`getComputedStyle`, not token arithmetic):

| element | dark before → after | light before → after |
|---|---|---|
| AI-models mode control (selected) | **2.47 → 7.60** | 4.13 → **5.21** |
| model-combobox selected row | **2.47 → 7.60** | 4.13 → **5.21** |
| landing demo CTA (accent as text) | 7.34 → 7.34 | **3.90 → 4.91** |
| landing submit / `.btn-primary` fill | 7.60 → 7.60 | 4.53 → **5.21** |
| the three `#0000EE` links | — → 6.27 | — → 5.08 |

**Verification that shipped with it:**

- `src/lib/theme/contrast.test.ts` — 64 assertions, parsing the real token
  values out of `src/app.css` and compositing `rgba()`/`opacity` over their true
  grounds. Mutation-checked: restoring the pre-Phase-1 values reproduces the
  audit's hand-measured failures to the hundredth (3.90 / 4.13 / 3.66 accent,
  4.13 on-accent, 4.45 changed chip). This is [P1-6](#p1-6), delivered.
- `e2e/theme-token-parity.spec.ts` — enumerates every custom property the app
  declares (so a token added later is covered without editing the spec) and
  proves in a real browser that explicit light ≡ `auto` + OS light, explicit
  dark ≡ `auto` + OS dark, and that an explicit choice is independent of the OS
  preference. This is the behavioural half of [P1-1](#p1-1).

**Deferred out of Phase 1, deliberately:**

- The ~40 `--surface-raised` call sites. The token is now an alias of the
  correctly-named `--surface-sunken`; Phase 2 sweeps the call sites as it
  restyles those components anyway ([P1-5](#p1-5) kept its alias promise).
- `Landing.svelte`'s `.discard-confirm` keeps a hardcoded `#0a1410` — it sits on
  `--legend-removed-color`, not the accent, so `--on-accent` would be the wrong
  token. It needs an `--on-danger`, which is a Phase 2 decision.
- `src/lib/diagram/mermaid.ts:40` hardcodes the light "changed" chip triple
  (`fill:#fff5cc,stroke:#d4a72c,color:#9a6700`) into a mermaid `classDef`.
  Phase 1's [F16](./ui-audit.md#f16) repair moved the token to `#8f5f00`, so the
  diagram's amber is now one step lighter than the chip it was copying — both
  still read as the same colour, but it is a real (small) divergence this PR
  created. Mermaid `classDef` cannot reference a CSS custom property, so closing
  it means re-stating the value there; Batch 2B owns it.
- The component-level copies of the [F17](./ui-audit.md#f17) hazard.
  `SymbolPopover.svelte` and `SymbolTestPairing.svelte` each write their light
  treatment out **twice** — once under `:root[data-theme='light']` and again
  under `@media (prefers-color-scheme: light)` / `:root:not([data-theme])` —
  the same duplication Phase 1 just removed from `app.css`, at component scope.
  Both paths are present and correct today, so nothing is broken; they are
  simply the next places a token can silently diverge. `SymbolPopover`'s copies
  are hardcoded GitHub syntax colours, so Phase 3 owns that one when it
  tokenises the syntax set; `SymbolTestPairing` belongs to Batch 2B.

---

## Phase 2 — component batches by theme

Against the corrected tokens, never before. Batches touch **disjoint files** so
they can run in parallel; within a batch, the work is one coherent visual
language, which is what makes it reviewable.

### Batch 2A — forms and inputs

**Files:** `src/app.css` (input/select/checkbox primitives),
`src/components/settings/*.svelte`, `src/components/CommentEditor.svelte`,
`src/components/AskBox.svelte`.

1. Point control borders at `--border-control` ([F11](./ui-audit.md#f11)) —
   the fix that makes fields visible again.
2. Demote form labels to support: `--text-secondary`, one step smaller than the
   value they label, not larger ([F12](./ui-audit.md#f12), p.44).
3. Fix stacked-field rhythm to the scale: label→input one step, input→next field
   at least two steps up ([F12](./ui-audit.md#f12), p.84).
4. ~~Style the two unstyled anchors ([F14](./ui-audit.md#f14)) —
   `AiModelsSection.svelte:481`, `StandingRulesSection.svelte:385`.~~
   **Already done by Phase 1**, which also found a third
   ([see its record](#p1-shipped)) — this item should have been struck then.
   What Batch 2A found instead was the *cause*, and seven more anchors;
   see [its record](#b2a-shipped).
5. Replace the `0.45` disabled literals with `--disabled-opacity`.

<a id="b2a-shipped"></a>

### Batch 2A — as shipped

Shipped as one PR, four commits along the item seams: the control boundaries and
the two new tokens, then the label/rhythm primitive, then the gates, then the
screenshots. **One of the five items above was already done**, and three of the
other four found more sites than this document or the audit recorded. The
pattern by now is unmistakable and worth stating plainly: *the citation is a
starting point, the grep is the set.*

**Item 4 was already closed, by Phase 1.** This document asks Batch 2A to style
`AiModelsSection.svelte:481` and `StandingRulesSection.svelte:385`. Phase 1
styled both — and found a third in `BridgeSection` — and
[said so](#p1-shipped). The item should have been struck then; it is struck now.
What was left was the *cause*: `app.css` had **no `a` rule at all**, so the
default for an anchor in this app was the UA's `#0000EE` / `#9e9eff`, and each
new anchor was a fresh instance of the same bug. Grepping every `<a>` in `src/`
and checking whether any rule could reach it found **seven still unstyled**, none
of them in this batch's files:

| file | anchor | why the existing rule missed it |
|---|---|---|
| `App.svelte:148` | "Go home" (not-found route) | `.topbar a` covers the header only |
| `AiPanel.svelte:80` | `.ai-panel-no-key` | the rule covers the sibling `.ai-panel-disabled` state |
| `InspectStep.svelte:1700` | `.story-fallback-note` | likewise a sibling of the styled `.reviewers-disabled-note` |
| `VerdictStep.svelte:564` | "Open Settings" | no rule |
| `VerdictStep.svelte:806` | org-access link in `.error-msg` | no rule |
| `Review.svelte:786` | "Settings" in `p.muted` | no rule |
| `AuthCallback.svelte:94` | "Go home" | the file has no anchor rule at all |

Five of the seven are a link inside a *sibling state* of a state someone did
style. That is the signature of a missing default, not of seven oversights.
`a { color: inherit; text-decoration: underline }` in `app.css` — the idiom six
components had already written out by hand — fixes all seven and every future
one, at element specificity (0,0,1) so it cannot reach a `.btn`, a `.nav-link`
or any component rule. Measured in the built app on `/this-route-does-not-exist`:
"Go home" was `#0000EE` (light) / `#9e9eff` (dark) and is now `--text`, underlined,
in both. Note that UA blue *passed* contrast (8.86:1 light, 7.58:1 dark) — F14
was never a legibility bug. It was a second hue competing with the accent, in
neither palette, and not theme-aware.

<a id="b2a-f11"></a>

**Item 1 — control borders ([F11](./ui-audit.md#f11)). Done, and it is the
largest visible change in the batch.**

Measured with `getComputedStyle` in the **built** app at 1440×1000, both themes:

| ground | `--hairline` (before) | `--border-control` (after) |
|---|---|---|
| light `--bg` | 1.33 | **3.53** |
| light `--surface` | 1.41 | **3.74** |
| light `--surface-sunken` | 1.25 | **3.32** |
| dark `--bg` | 1.43 | **3.79** |
| dark `--surface` | 1.31 | **3.49** |
| dark `--surface-sunken` | 1.19 | **3.17** |

Every control boundary in the app now clears **SC 1.4.11's 3:1**, where none of
them did before; the improvement is a uniform **2.65×**. The numbers are the
token's, so the interesting part is the scope. The plan says "one-line-per-rule",
and in `app.css` it is exactly that — three rules, `.btn`, the
`input`/`textarea`/`select` primitive, and the `checkbox`/`radio` primitive. But
**21 component-level controls bypass those primitives** with a border of their
own, and a repair that stopped at `app.css` would have left most of the settings
page untouched. All 21 are converted: the segmented controls and their internal
dividers, the combobox trigger and its search box, the ensemble row's selects and
its add/remove buttons, the quick-set buttons, the skills forms' textareas and
buttons, the bridge and standing-rules primary/secondary buttons, Appearance's
move/reset buttons, the ask box's input and close button, and `CommentEditor`'s
wrapper — whose `<textarea>` is `border: none`, so the wrapper **is** the
control's edge.

**The line this batch draws, and the one it does not.** A control's boundary is
required information (SC 1.4.11) and gets `--border-control`. A *surface* or a
*separator* is not, and keeps `--hairline`: section cards, `<details>` panels,
fieldsets, provider cards, popover chrome, row separators, `.chip`, `.cmd` code
blocks, the comment editor's own internal tab/toolbar rules. That is the split
the two tokens exist to express, and it is now asserted in both directions —
`.card` and `dialog` must *not* reference the control token.

Worth being explicit about one judgement: **`.btn` is a control**, so it took the
token too, and that is why the change is visible on every screen and not just in
settings. A `.btn`'s fill is `--surface-sunken`, which stands **1.06:1** off the
page and **1.13:1** off a card — invisible. Its border was the only thing making
it a button, at 1.33:1. That is the same finding as F11, on a different element.

**Item 2 — label demotion ([F12](./ui-audit.md#f12), p.44). Done.**

Measured in the built app, the `DeepSeek API key` field on `/settings`:

| | before | after |
|---|---|---|
| label size | 15px (ProvidersSection) / 13.5px (AiModelsSection) | **12px** |
| label weight | 400 | **500** |
| label ink | `--text` — 15.80:1 light | `--text-secondary` — **7.14:1** light / **7.09:1** dark |
| value size | 13.5px | 13.5px (unchanged) |
| value ink | `--text` — 14.00:1 light | unchanged |

The label was *larger than, and exactly as dark as*, the value in one section and
*the same size and just as dark* in the other. It is now one scale step below the
value on size and roughly half its contrast, while staying well clear of the
4.5:1 floor — a demotion, not a legibility trade.

**`--text-secondary`, not `--text-muted`, and the difference is the point.**
`BridgeSection` had already hand-rolled a demoted label — at `--text-muted`,
which is where its own `.field-note` hints live. Label and hint were therefore on
one tier, which flattens the thing a form most needs to distinguish: *what this
field is* versus *what you should know about it*. The middle tier Phase 1 added
and left unconsumed is exactly this role. Weight is the one axis that goes **up**
(400 → 500): at 12px in a secondary ink a 400-weight label gets thin, and stroke
weight is not emphasis once both size and contrast have dropped. No new weight is
introduced — 500 was already in use ([F18](./ui-audit.md#f18)).

**Item 3 — stacked-field rhythm ([F12](./ui-audit.md#f12), p.84). Done.**

Rendered geometry, not declared CSS:

| | before | after |
|---|---|---|
| label → its own control | 3.7px (AiModels) / **0px** (Providers, SecretInput) | **3.75px** everywhere |
| field → next field | 7.5px | **15px** |
| ratio | 2.0:1 | **4.0:1** |

The 0px cases were a block-level control opening its own line inside a
`display: block` label, which fused the label to its field. `.field` /
`.field-label` are now a primitive in `app.css` rather than a shape each section
re-invents; the four sections that had their own copy (`BridgeSection`,
`AiModelsSection`, `SkillsSection`, `ProvidersSection`) adopt it. A label may be
a `<span class="field-label">` or a bare text node in the `.field` — both get the
same treatment, so adopting the primitive never forces a markup rewrite. 4:1 is
the same register Batch 2C used for the Inspect toolbar (3.3:1).

> **The fix reintroduced the defect once, two lines below itself.**
> `ProvidersSection`'s `details .field { margin: 0 0.75rem }` shorthand
> out-specified the primitive's `.field + .field { margin-top: 1rem }` and
> flattened the two adjacent Bitbucket fields back to a 0 gap. The *screenshots*
> caught it; neither the unit gates nor the e2e gates did, because both measure
> the AI-models field. `margin-inline` is the repair. Recorded because "the
> primitive is right, therefore every call site is right" is exactly the
> assumption that was wrong.

**Item 5 — `--disabled-opacity`. Done, and the sweep was bigger than the
literal.**

`0.45` was never the whole story. Parsing every rule whose selector carries
`:disabled` / `[disabled]` / `.locked` / `.disabled` found **35 disabled-state
opacity rules across the app, carrying seven different values** (0.35, 0.4, 0.45,
0.5, 0.55, 0.6, 0.85) for one meaning. Inside this batch's fence there were
**14**, with five different values; they now carry one token. Three of them
actually move: `.move-btn:disabled` 0.35 → 0.45 (a disabled move arrow becomes
slightly more legible), `BridgeSection`'s `.primary-btn:disabled` and
`AiModelsSection`'s two `.disabled` panels 0.55 → 0.45, and
`StandingRulesSection`'s buttons 0.5 → 0.45.

**The value is a single theme-independent `0.45`, deliberately.** The asymmetry
is real and is recorded in `app.css` and in a test: `--text` at 0.45 measures
**2.68:1** on the light well against **3.65:1** on the dark one, so light lands
27% harsher — the same shape of bug `--recede-opacity` exists to fix. The
difference is that `--recede-opacity` had a **floor** (3:1 on the three diff
grounds) which *forced* 0.55 in light; a disabled control has no floor at all —
WCAG 2.1 excepts inactive components from both SC 1.4.3 and SC 1.4.11 — so a
second value would be taste dressed as a measurement. It would also cost
something concrete: a number cannot use `light-dark()`, so splitting it would
grow the app's last copy of the [F17](./ui-audit.md#f17) hazard from two
declarations to three. Measured, reported, single value.

**Closed here, from Batch 2B's deferred list:**
`settings/ModelCombobox.svelte:440`'s hand-picked
`0 10px 30px rgba(0,0,0,.28)` → `--elevation-4`. It is a large dropdown, which is
what step 4 is for, and its alpha was a dark-ground pick: black at .28 measures
2.10:1 on the light page against 1.04:1 on the dark one, so the one declaration
landed twice as heavy in the theme it was *not* chosen for. **The guard's
allowlist is now empty**, and a new assertion says it must stay empty — the two
tests worked exactly as Batch 2B designed them: removing the literal turned the
"names only files that really do still carry one" test red until the allowlist
entry went with it.

**Verification that shipped with it:**

- **`src/lib/theme/contrast.test.ts` — 80 → 103 assertions**, in four groups.
  F11: `--border-control` must beat `--hairline` by >2× on every ground in both
  themes (a clear margin, so the two roles cannot quietly re-converge);
  `--border-subtle` is still only an alias; every control primitive in `app.css`
  really does reference the control token and `.card`/`dialog` really do not —
  *that* is the assertion whose absence let Phase 1 define a contrast-gated token
  that nothing rendered. F12: the three inks are strictly ordered; the `.field`
  label is smaller than the control primitive's own size; both spellings of the
  label agree; the control declares `font-weight: 400` so it cannot inherit the
  wrapper's 500; and the between-field gap is ≥3× the inside gap, asserted as a
  **ratio** so a later change of scale step still passes. F14: `app.css` declares
  a global `a` colour and underline, and does *not* pick a hue there. P1-4:
  `--disabled-opacity` is a number in (0,1), absent from **both** dark-override
  blocks, not an alias of `--recede-opacity`, and its light-vs-dark asymmetry is
  pinned as a test rather than a comment that can drift.
  Mutation-checked in all four families: pointing `.btn` back at `--hairline`,
  enlarging `.field-label` past its value, halving the between-field gap and
  deleting the global `a` rule each turn exactly the intended assertion red.
- **`src/components/design-system-primitives.test.ts`** — the elevation
  allowlist is empty and a test enforces that.
- **`src/components/CommentEditor.test.ts`** — its border assertion follows the
  source to `--border-control` and is *narrowed*: it now also proves the
  `<textarea>` has no border of its own (which is *why* the wrapper must clear
  the non-text floor) and that the editor's internal separators stay decorative.
- **`e2e/settings.spec.ts`** — the unchecked-radio assertion follows the source
  (an unchecked radio is F11's worst case: nothing inside it but its border),
  plus **four new gates**, two per theme, measuring the built app: every control
  boundary in `#ai-models` clears 3:1 *and* beats the hairline by 2×; and the
  label ranks below its value on both size and contrast while the **rendered
  geometry** keeps the gap between fields >3× the gap inside one. Relationships,
  not hardcoded steps. They wait out the 150ms `border-color` transition first —
  read immediately after a theme flip, both ends of that interpolation happen to
  clear 3:1, which is the kind of accident that makes a gate pass for the wrong
  reason.

**Deferred out of Batch 2A, deliberately:**

- **`--chrome-muted-opacity`, the third of P1-4a's three semantics.** Three bare
  `opacity: 0.45` literals remain and they are *not* disabled states:
  `BridgeSection.svelte:356` and `GroundingIndicator.svelte:80` (an "off" status
  dot) and `CommentThread.svelte:281` (a menu button revealed on hover). Two of
  the three are outside this batch's files, and tuning de-emphasised chrome is a
  decision about chrome, not about forms. **Batch 2D owns it** — it is a scale
  question.
- **The other 21 disabled-state opacities**, in `VerdictStep` (5), `InspectStep`
  (4), `RevisionPicker` (3), `AskAi` (2), `Landing` (2), `AgentFixPanel`,
  `CiSummary`, `DraftThread`, `RunPrPanel`, `StorySlideshow` and
  `SectionStatus`. Converging them is mechanical, but at least one is a
  deliberate outlier — `run-reviewers-btn:disabled` sits at 0.85 because it is
  disabled *while busy* and must stay readable — so they want a per-site look,
  not a sweep. The token exists and is the obvious target.
- **The remaining `--surface-raised` call sites.** Phase 1's
  [P1-5](#p1-5) deferral stands; this batch swept none, because in its files the
  alias always resolves to the right value and the per-site "should this come
  forward instead?" question is genuinely per-site.
- **`Landing.svelte`'s `.discard-confirm`** still hardcodes `#0a1410` and still
  wants an `--on-danger`. Inherited from Phase 1 and from Batch 2B; Landing is
  not a Batch 2A file either. Nobody has taken it yet.
- **`src/routes/Demo.svelte:235`** paints `.demo-banner a { color: #6ab4f0 }` —
  a hardcoded blue that does not flip with the theme, sitting on the banner's own
  fixed tint. Measured and left alone: it is legible on its own ground and
  `Demo.svelte` is nobody's fence yet, but it is the last saturated blue in the
  app outside the diff viewer, and it is the natural companion to F14 whenever a
  batch claims that file.
- **The two-column control grid** Batch 2C floated for the settings page
  ([item 4](#b2c-item4)) is **not** built. This batch made the column shorter
  (≈100px) by tightening the field primitive, but it did not restructure the
  layout — that is a different change with a different risk profile, and item 4's
  own conclusion was that it is optional.


### Batch 2B — cards, panels and elevation

**Files:** `src/app.css` (`.card`, `dialog`, `.chip`), `src/components/panels/*.svelte`,
`src/components/SkillFindingCard.svelte`, `src/components/*Panel.svelte`.

1. **Define the elevation scale** — five steps, two-part shadows (p.163-166), with
   light-appropriate alphas (today's 0.18-0.40 black were all picked on the dark
   ground, [F10](./ui-audit.md#f10)). Replace the 8 bespoke values with scale steps.
2. Give `dialog` a real modal elevation (`src/app.css:517-525` has none today).
3. Reduce border reliance: separate with space and a background shift first
   (p.206-209). The ten identical `<details>` panels on step 1
   ([F9](./ui-audit.md#f9)) are the test case — rank them, or group them, or drop
   their borders; do not leave ten equal bordered boxes.
4. Apply the flat-depth rule now that `--surface-sunken` is named correctly
   ([P1-5](#p1-5)): forward elements lighter than their ground, receded ones darker.

<a id="b2b-shipped"></a>

### Batch 2B — as shipped

All four items shipped. **One thing differs from what this document proposed,
and it is a correction, not a shortcut:** item 3 says to drop the panels'
borders, and that turned out to be right in light and wrong in dark. The
measurement is below.

#### The elevation scale as shipped

Five steps plus one drawer variant, in `src/app.css :root`. Each step is two
shadows (p.163-165): a large soft one for the direct light, plus a tighter
darker one for the ambient occlusion, which **fades from `--shadow-tight` to
`--shadow-faint` from step 3 up** (p.165-166). The soft part's geometry is the
rubric's reference ramp verbatim (p.161).

```css
--shadow-tight: light-dark(rgba(31,35,40,.14), rgba(0,0,0,.32));
--shadow-soft:  light-dark(rgba(31,35,40,.10), rgba(0,0,0,.22));
--shadow-faint: light-dark(rgba(31,35,40,.06), rgba(0,0,0,.14));

--elevation-1: 0 1px 1px var(--shadow-tight), 0 1px 3px   var(--shadow-soft);
--elevation-2: 0 1px 2px var(--shadow-tight), 0 4px 6px   var(--shadow-soft);
--elevation-3: 0 1px 3px var(--shadow-faint), 0 5px 15px  var(--shadow-soft);
--elevation-4: 0 2px 4px var(--shadow-faint), 0 10px 24px var(--shadow-soft);
--elevation-5: 0 2px 6px var(--shadow-faint), 0 15px 35px var(--shadow-soft);
--elevation-drawer: -2px 0 6px var(--shadow-faint), -10px 0 24px var(--shadow-soft);
```

| step | purpose (p.158-161) | consumers |
|---|---|---|
| 1 | rests on the page | `.card`, `.detail-panel[open]` |
| 2 | the primary card on a page | `.glance-card` |
| 3 | menus, tooltips, small popovers | CommentEditor emoji picker, CommentThread menu, VerifyVotesTooltip, InspectStep findings popover |
| 4 | dropdowns and large popovers | SymbolPopover, VerdictStep review-command dropdown |
| 5 | modals | `dialog` — which had **no shadow at all** |
| drawer | edge-anchored overlays, casting sideways | InspectStep file-tree drawer, PreviewPanel overlay drawer |

**Why the alphas are theme-dependent.** A shadow's weight is the luminance drop
it makes in *its own* ground, and all nine replaced values were picked against
`#14161a`. Re-measured on each page ground:

| declaration | on `--bg` light | on `--bg` dark |
|---|---|---|
| `rgba(0,0,0,.18)` | 1.52 | 1.03 |
| `rgba(0,0,0,.25)` | 1.83 | 1.05 |
| `rgba(0,0,0,.40)` | **2.83** | **1.07** |

The same declaration lands **2.8× heavier in light**, which is what made the
light page read as sooty. Light now uses a low-alpha warm near-black (the
`--text` ink, so the mark stays in the palette's family on `#faf8f4`); dark
keeps pure black inside the 0.18–0.40 envelope it already had, so no dark
surface gains or loses a shadow it did not have.

<a id="b2b-border"></a>

#### The correction: dark keeps its rim

Item 3 assumed a shadow can stand in for a border. Measured in the built app:

| mechanism | light | dark |
|---|---|---|
| `--hairline` as a 1px rim | 1.33 | 1.31 |
| `--surface` against `--bg` (the background shift) | 1.06 | 1.08 |
| the `--elevation-1` shadow | **1.58** | **1.08** |

In light the shadow beats the border outright — stronger *and* softer — so the
border is redundant and goes. In dark it does not, and **no alpha rescues it**:
black on `#14161a` tops out at 1.07:1 even at 0.40, because a near-black ground
has nothing left to cast into. That is very likely *why* the nine replaced
values kept climbing toward 0.40 without ever separating anything.

Dropping the border in both themes would have traded a 1.31:1 rim for a 1.08:1
shadow in dark — a regression dressed as a principle. So the rim is
theme-dependent, in one declaration:

```css
border: 1px solid light-dark(transparent, var(--hairline));
```

on `.card`, `dialog`, `.glance-card` and `.detail-panel[open]`. The nested
`light-dark()` was verified in a real browser before use; it keeps the dark side
pointing at `--hairline` rather than duplicating `#2e333b`.

**Later batches should inherit this rule, not re-litigate it:** in light, prefer
depth over a line; in dark, keep the line and let depth support it.

#### The ten `<details>` panels

Ranked by **open vs closed** — the one axis that always means something and that
survives the reader reordering the list in settings (`panels/sectionRegistry.ts`
makes the order a user preference, so any rank keyed to a specific section's
identity would be wrong for some readers).

- **closed** — chrome. No box: a summary row on the page ground, with a
  `--surface-sunken` hover so it still reads as a control. Ten of them read as a
  list of ten things to choose from rather than ten panels competing.
- **open** — content. Comes forward onto `--surface` with `--elevation-1`.
- above them, `.glance-card` takes `--elevation-2`, so the page reads in **three
  depths instead of one** — which is the [F9](./ui-audit.md#f9) complaint for
  step 1, answered.

A closed panel keeps a *transparent* 1px rim so opening one does not shift the
layout; the re-captured shot is the same 1440×1105 as the before-state, which
makes the comparison purely visual.

#### Verification that shipped with it

- **`src/lib/theme/contrast.test.ts` — 64 → 80 assertions.** The scale is
  exactly five steps plus the drawer; every step is two-part and takes its
  colour only from a `--shadow-*` ink; the tight part fades from step 3; the
  soft geometry equals p.161's ramp verbatim; the drawer casts sideways; the
  inks are ordered in both themes; the light ramp sits in a
  visible-but-not-sooty band; the dark ramp stays in its old envelope; light's
  shadow beats its border while in dark every alpha 0.2–0.6 loses to the rim;
  and the flat-depth rule holds. Mutation-checked: pasting `rgba(0,0,0,.40)`
  into the light ramp fails the band assertion, and reducing a step to one part
  fails three.
- **`src/components/design-system-primitives.test.ts` — 4 new static guards.**
  No component may hand-pick a raw black `box-shadow`; the two still doing so
  are allowlisted *by name with the batch that owns them*, and a second test
  fails if an allowlisted file no longer needs its exemption, so the list cannot
  outlive the exception.

#### Measured, reported, left alone

- **In dark, `--surface-sunken` (`#22262d`) is lighter than `--surface`
  (`#1b1e24`)** — the opposite sign to light, where it is darker. That is the
  universal dark-UI convention (there is no "less light" below a dark ground),
  not a defect, and the batch's brief forbids changing a settled palette value.
  It is now pinned by a test that says so rather than left as folklore. Anything
  wanting the literal p.167-168 direction in *both* themes needs a separate
  `--surface-well` value for dark — a token decision, not a component one.

#### Deferred out of Batch 2B

- **Two bespoke shadows remain**, each outside this batch's fence:
  `ContextRail.svelte:313` (Batch 2C owns the file) and
  `settings/ModelCombobox.svelte:440` (Batch 2A). Both map to
  `--elevation-drawer` and `--elevation-4` respectively; converting them is a
  one-line change each. They are allowlisted by name in the static guard, which
  fails once the literal is gone, so the exemption cannot be forgotten.
  > **Since resolved, both halves.** Batch 2C landed after this and took
  > `ContextRail.svelte`; Batch 2A took `settings/ModelCombobox.svelte` onto
  > `--elevation-4` — see [its record](#b2a-shipped). `DEFERRED_TO_A_LATER_BATCH`
  > is now **empty**, and a test says it must stay empty. The guard worked
  > exactly as designed both times: removing the literal made the "names only
  > files that really do still carry one" test fail until the allowlist entry
  > went with it.
- **`--surface-raised` still has ~30 call sites** outside this batch's files
  (settings/\*, FileDiff, InspectStep, VerdictStep, Landing, Review, …). Batch 2B
  swept the 32 in its own fence to `--surface-sunken`; the alias resolves to the
  same value, so that was zero visual change. **Whether a given well should
  instead come *forward* onto `--surface` is a per-site question**, and this
  batch deliberately did not answer it blind for sites it could not see in
  context — `SkillFindingCard`'s `severity-low` is the clearest example: it is a
  neutral member of a status-tint family, so moving it to `--surface` would
  break that family's logic, not fix it.
- **`Landing.svelte`'s `.discard-confirm`** still hardcodes `#0a1410` and still
  needs an `--on-danger` (inherited from Phase 1; Landing is not a Batch 2B
  file).

#### Closed here, from Phase 1's deferred list

- **`src/lib/diagram/mermaid.ts`** — the light `changed` `classDef` re-states
  `--legend-changed-color` as `#8f5f00` (was `#9a6700`, 4.45:1, under the
  floor), with a comment tying the two together. Mermaid `classDef` cannot read
  a custom property, so re-stating is the only option.
- **`SymbolTestPairing.svelte`** — the component-scope [F17](./ui-audit.md#f17)
  copy, and Phase 1's note that "both paths are present and correct" was
  **wrong**. The `@media (prefers-color-scheme: light)` copy was missing
  **thirteen selectors** the explicit `[data-theme='light']` copy had
  (`.hljs-meta .hljs-keyword`, `.hljs-template-tag`, `.hljs-template-variable`,
  `.hljs-title.class_`, `.hljs-attribute`, `.hljs-meta`, `.hljs-operator`,
  `.hljs-variable`, `.hljs-selector-attr`, `.hljs-selector-class`,
  `.hljs-meta .hljs-string`, `.hljs-code`, `.hljs-formula`, `.hljs-quote`), so a
  reader on `auto` with an OS set to light saw those tokens still painted in the
  **dark** palette — salmon `#ff7b72` keywords on a white snippet. Three blocks
  collapsed to one `light-dark()` declaration per colour, which makes the
  divergence unrepresentable rather than merely fixed. This is the concrete
  evidence that the remaining copy in `SymbolPopover.svelte` (Phase 3) is worth
  treating as a live bug, not tidying.

### Batch 2C — nav, settings and page structure

**Files:** `src/routes/SettingsPage.svelte`, `src/components/Stepper.svelte`,
`src/components/ContextRail.svelte`, section components' heading markup.

1. Give the settings sections real headings ([F13](./ui-audit.md#f13), p.46-47) —
   semantic `<h2>`/`<h3>`, styled down to today's visual weight. No visual change
   required; this is the outline the page is missing.
2. Fix the inverted nav emphasis ([F3](./ui-audit.md#f3)): with `--accent` at
   5.21:1 the active item is legal, but it should also *out-contrast* the inactive
   items, not merely match them.
3. Section heading spacing: clearly more above than below (p.85, rubric D2).
4. Reconsider the 663px column in a 1440px viewport (p.71) — there is unused
   horizontal room and the page is ~6,000px tall.
5. **The Inspect toolbar** ([F8](./ui-audit.md#f8), [F9](./ui-audit.md#f9)) — the
   highest-value single fix in Phase 2. Group `Unified`/`Side-by-side` as one
   segmented control with no internal gap, put a scale-step gap between groups, and
   rank the seven control rows so the reader's eye reaches the code.

<a id="b2c-shipped"></a>

### Batch 2C — as shipped

Shipped as one PR, three commits along the item seams: the outline (zero
rendered pixels), the nav and heading spacing, then the Inspect toolbar. Every
number below was taken with `getComputedStyle` in the **built** app at
1440×1000 in both themes — the audit's numbers came from the browser, so these
do too. Screenshots re-captured: `settings-models-*`, `step2-inspect-unified-*`,
`step2-inspect-split-*` and `focus-dim-*` (the last two pairs are the same
capture; `focus-dim` is byte-identical to `step2-inspect-unified` and always
was). The other six shots are untouched because Batch 2C did not reach them.

**Item 1 — semantic headings ([F13](./ui-audit.md#f13), rubric D1). Done, and
provably pixel-neutral.**

Six `<p class="section-label">` became `<h2>`; four sub-titles became `<h3>`
(`Built-in reviewers`, `Generate from my reviews`, `What runs (and how deep)`,
`Model panel`). `StandingRulesSection`'s existing per-group `<h3>` therefore
stops being a level with no `<h2>` above it. The outline is now
`h1 → 6×h2 → h3`, where it was a single `h1` for ~6,000px of page.

`letter-spacing: normal` is pinned on those rules: `app.css`'s global `h2`/`h3`
tighten it to `-0.01em`, and the brief for this item was "no visual change".
Before/after in the built app: font-size 13.5px, weight 600, every above/below
gap, every section's scroll top and the page height (6069px) are identical.

**Item 2 — nav emphasis ([F3](./ui-audit.md#f3), p.30-31, p.142). Done.**

Phase 1 made the active item legal (3.47 → 4.31:1) but not *emphatic*: it was
still the least-contrasted item in a list of six. The accent now carries the
indicator instead of the label — the left bar (2px → 3px, 65% → 70%) and the
tint stay accent, the label takes `--text` at 600 weight.

| | active before | active after | inactive | active ÷ inactive |
|---|---|---|---|---|
| light | 4.31:1 | **13.07:1** | 5.08:1 | 0.85× → **2.57×** |
| dark | 6.08:1 | **12.03:1** | 6.27:1 | 0.97× → **1.92×** |

**Item 3 — heading spacing (rubric D2, p.85). Done where it was actually
broken.**

Measured visual gaps, above / below:

| heading | before | after |
|---|---|---|
| `Providers & access` | 15 / 13.5 (1.1:1) | 15 / 6 (**2.5:1**) |
| `Built-in reviewers` | 11.3 / 6 (1.9:1) | 18.8 / 6 (**3.1:1**) |
| `What runs (and how deep)` | 22.8 / 4.5 (5.1:1) | 27.3 / 4.5 (**6.1:1**) |
| standing-rules group title | 13.5 / 6 (2.25:1) | 17.3 / 6 (**2.9:1**) |

`Providers & access` was the real violation and it was invisible in the CSS: as
a `<p>`, `.auth-status` carried the UA `1em` top margin, which **collapsed**
with the heading's own `0.4rem` bottom margin and all but erased the difference
between above and below. `margin-top: 0` is the whole fix.

The six top-level `<h2>`s already passed — 15px of card padding above (plus
22.5px of inter-card gap outside the border) against 6px below, 2.5:1 — and are
deliberately left alone. Not churning them also keeps every section's scroll top
where `e2e/settings.spec.ts`'s scrollspy assertions expect it.

<a id="b2c-item4"></a>

**Item 4 — the 663px column. Decided AGAINST widening. Here is the evidence.**

The measurements that settle it:

- the content column is **663px = 74ch** at the body size — the top of the
  45-75ch comfortable measure, not below it;
- the **widest paragraphs in it already render at ~86ch** (623px at 12-12.75px:
  the bridge explainer, the model-panel explainer, the key-storage note). The
  column is not too narrow for its prose; it is marginally too wide already;
- using the 550px of unused horizontal room would put those paragraphs near
  **140ch**, a straightforward p.68-70 violation;
- and the height is not a width problem. `#ai-models` alone is **2,578px, 42%
  of the 6,069px page**. Widening the column might shave ~15% off that. Ranking
  and collapsing those sections is the real fix, and it belongs to Batches 2A
  and 2B, which own the form primitives and the panels.

p.71 warns against cramming content into a small area to look compact. 663px of
stacked form fields at 74ch is not cramped, and p.68-70's prescription for a
narrow component lost in a wide area is to **split it into columns, not stretch
it** — which this is not, being a centred document with a sticky section nav,
the conventional and correct shape for a settings page.

**If this is revisited**, the move is a two-column *control grid* (the six
provider cards, the per-task mode matrix, the model panel rows) inside a prose
measure that stays narrow — not a wider page. That is a Batch 2A/2B decision
about those components, not a page-shell decision, so it is recorded here and
left to them.

**Item 5 — the Inspect toolbar ([F8](./ui-audit.md#f8),
[F9](./ui-audit.md#f9)). Done, and F8's measurement is corrected.**

> **Correction to [F8](./ui-audit.md#f8).** The audit recorded 4px inside the
> view-mode pair against 3px between unrelated controls. Measured sub-pixel,
> **every gap in that row was the same 3.55px** — a collapsed whitespace text
> node between `inline-flex` children of a `display: block` container, not a
> declared gap anywhere. The 4-vs-3 was integer rounding of one value. The
> defect is therefore worse than "inverted": the grouping was **absent**, the
> ratio of around-to-inside was exactly 1.0, and the row could only read as five
> peer buttons.

`Unified | Side-by-side` is now a segmented pill — the treatment `.flow-switch`,
`.sort-switch` and `.phase-switch` already used, so the row finally speaks one
language: **a pill is a mutually exclusive choice, a bordered button is an
independent switch.**

| measured gap | before | after |
|---|---|---|
| inside the view-mode pair | 3.55px | **0px** |
| inside the three toggles | 3.55px | **4.5px** |
| pair → toggles (between groups) | 3.55px | **15px** |
| `Story\|Files` → pair (between groups) | *(different row)* | **15px** |

Space around a group is now **3.3× the space inside it** (p.83, p.86).

**Ranking the seven rows** (p.30-31: de-emphasise the secondary, do not enlarge
the important). Three tiers:

| tier | rows | treatment |
|---|---|---|
| **1 — decisions that change what you see** | the stepper; the phase bar (`Implementation`/`Tests`, which scopes the file set and carries the approval) | untouched. The phase bar is the only filled, bordered row and should be. |
| **2 — reading preferences** | `Story\|Files`, diff layout, the three view toggles, the sort switch | `Story\|Files` and the diff controls answer one question, so they are **one row now, not two**. The toggles lose the filled `--surface-raised` ground and the 700-weight accent underline: they are preferences you set once. |
| **3 — status, never a control** | the reviewer chips, the findings-triage line | left as muted text |

**Seven rows → six; chrome before the first line of code 260px → 231px.**

Two things fell out of making `.mode-toggle` a real flex row:

1. `run-reviewers-btn { margin-left: auto }` was **dead CSS** under
   `display: block`. "Run my reviewers" now sits at the right edge it was
   written for.
2. Four `color: var(--surface, #fff)` declarations on `background: var(--accent)`
   fills (the flow, mode, phase and sort pills) converge onto `--on-accent`.
   Phase 1 grepped for the `#0a1410` literal and missed this spelling of the
   same bug. Light is unchanged (both resolve to white, 5.21:1); dark goes
   **6.81 → 7.60:1**.

Every accent-fill ink in the row now measures 5.21:1 light / 7.60:1 dark; the
demoted toggles 7.59:1 off and 13.07:1 on in light, 8.45 / 12.03:1 in dark.

**Verification that shipped with it:**

- `src/routes/SettingsPage.test.ts` — three outline assertions: the six `<h2>`s
  in nav order, exactly one `<h2>` per section element with no `p.section-label`
  surviving, and every `<h3>` inside a section that has an `<h2>`. A section
  added later as a `<p>` fails them.
- `e2e/settings.spec.ts` — two gates (light + dark) that composite the **real**
  rendered colours, translucent tint over its true ground, and assert the
  *ordering* rather than a hardcoded ratio: the active item clears AA,
  out-contrasts its siblings by >1.5×, and carries both the heavier weight and
  the indicator bar. A palette change that re-inverts them fails here.
- `e2e/focus-mode.spec.ts` — a gate that measures the **rendered geometry** of
  the toolbar and asserts around > inside with no hardcoded pixel value, so a
  restyle that re-flattens the row fails whatever the scale step turns out to be.
- `src/components/InspectStep.test.ts` — four structural tests replace the two
  that asserted "`Unified` has class `btn`". They assert the grouping instead:
  the pair is its own `role="group"` with exactly those two buttons, the three
  toggles are a disjoint group, the pills carry the pill class, and the flow
  switch shares the view bar.

**Deferred out of Batch 2C, deliberately:**

- **Widening the settings column** — see [item 4](#b2c-item4). The follow-up, if
  any, is a two-column control grid owned by Batches 2A/2B, not a wider page.
- **`Stepper.svelte`** was listed in this batch's files and was **not changed**.
  It is Tier 1 and already the most prominent chrome row on the Inspect step; it
  needed no change for items 1-5 and did not get one for its own sake.
- **`ContextRail.svelte`** needed nothing for items 1-5 either — collapsed to a
  27px off-canvas tab, it is not one of the seven rows. It did get **one** line:
  Batch 2B deferred its hand-picked `-4px 0 16px rgba(0,0,0,.4)` here because
  the `--elevation-*` tokens did not exist yet. They do now, so this batch took
  it. That literal was the [F10](./ui-audit.md#f10) signature *and* a measured
  theme bug — `rgba(0,0,0,.4)` is 2.83:1 on the light ground against 1.07:1 on
  the dark, so the single declaration landed 2.6× heavier in the theme the owner
  reads in. It is an edge-anchored overlay casting sideways, which is precisely
  what `--elevation-drawer` is for.
- **The inactive `.mode-btn`** reads 5.08:1 at `--text-muted`, matching the three
  pill switches it now stands beside exactly. That is consistency, not a
  measurement: if the pill language is ever re-toned, all four move together.
- **The remaining `--surface-raised` call sites.** The view toggles dropped
  theirs; Phase 1's [P1-5](#p1-5) deferral otherwise stands.
- **[F18](./ui-audit.md#f18) (four font weights)** is untouched. This batch adds
  no new weight — 500, 600 and 700 were all already in use — but it does not
  reduce the count either. That is Batch 2D's scale work.

### Batch 2D — the scales themselves

**Files:** repo-wide; sequence **last** in Phase 2 and land it in slices.

The type ([F6](./ui-audit.md#f6)) and spacing ([F7](./ui-audit.md#f7)) scales are
the largest mechanical change in the plan: 142 `em` font-sizes and 1,221 spacing
declarations. Approach:

1. Define the scales as tokens first (`--text-xs … --text-2xl`,
   `--space-1 … --space-8`), matching the rubric's reference scales (p.63, p.91-92),
   in **`rem` against a 16px root** — not `em`.
2. Add a **ratchet test** snapshotting today's per-file count of `em` font-sizes
   and off-scale spacing values; fail the suite if any file's count *grows*. Every
   subsequent PR shrinks it. (This pattern is proven in the sister project.)
3. Migrate file by file, one batch per PR, letting the ratchet prove progress.

Changing `:root { font-size: 15px }` to `16px` is a *separate*, deliberate
decision with a whole-app visual effect — do not smuggle it into a batch.

**Inherited into this batch by Batch 2A**, because both are scale questions and
neither belongs to a component:

- **`--chrome-muted-opacity`**, the last of the three semantics
  [P1-4](#p1-4) split out of one bare `0.45`. Three literals are still
  un-tokenised: `BridgeSection.svelte:356`, `GroundingIndicator.svelte:80` (both
  an "off" status dot) and `CommentThread.svelte:281` (a hover-revealed menu
  button). `--recede-opacity` and `--disabled-opacity` both exist now; this is
  the one left.
- **The 21 remaining disabled-state opacities** outside Batch 2A's fence, which
  carry six different values for one meaning. `--disabled-opacity` is the target,
  but at least one is a deliberate outlier (`run-reviewers-btn:disabled` at 0.85
  is disabled *while busy* and must stay readable), so this wants a per-site
  pass rather than a sweep. The full inventory is in
  [Batch 2A's record](#b2a-shipped).

<a id="b2d-shipped"></a>

### Batch 2D — as shipped (slice 1 of N)

Shipped as one PR in four commits: the scales + the ratchet (no rendered
pixels), the inherited opacity work, `app.css`, then the first component slice.
**This is the opening slice, not the whole batch** — by design. The plan asks
for the scales, the ratchet, and a first meaningful migration; the ledger below
says exactly how much corpus is left and is the instrument every later slice is
measured with.

**The scales, and the 15px root.** Both are the rubric's own reference scales
(p.63, p.91-92), authored in `rem` against a **16px** base, so the "nominal"
column is literally the rubric's number:

| | tokens | nominal px | rendered at the 15px root |
|---|---|---|---|
| type | `--text-xs … --text-2xl` (6) | 12 / 14 / 16 / 18 / 20 / 24 | 11.25 / 13.125 / 15 / 16.875 / 18.75 / 22.5 |
| spacing | `--space-1 … --space-8` (8) | 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 | 3.75 / 7.5 / 11.25 / 15 / 22.5 / 30 / 45 / 60 |

`:root { font-size: 15px }` is **unchanged**, as the plan requires. Because the
scale is root-relative, every step simply renders at 15/16 = **93.75% of
nominal, uniformly** — one multiplication, applied to all fourteen steps
equally. Flipping the root to 16px later is still one line and makes every
nominal number true at once. A test pins both halves of that: the root is 15px,
and **no step may be declared in `px` or `em`**, because a step in either unit
would be immune to the flip and would fragment the scale the day it is taken.

`rem`, never `em`, is the load-bearing rule (p.92-93) and it is asserted:
`em` compounding is the disease, and shipping the cure in the same unit would
reproduce it one level down.

Two encouraging measurements that made this cheaper than F6/F7 suggested:

- The app's **five most-used spacing values** (`0.25 / 0.5 / 0.75 / 1 / 1.5rem`,
  545 declarations between them) are **already exactly `--space-1 … --space-5`**.
  The scale is the codebase's own dominant mode; the 40 values are noise around it.
- At the declaration level F6 is worse than recorded — **50 distinct declared
  `font-size` values across 604 declarations**, ~400 of them in the 10.5-13.5px
  band — but **every one of them lands within 7% of a step**. The differences
  were never carrying meaning, which is the finding as much as the fix.

**There is deliberately no spacing step below `--space-1`.** 154 declarations sit
in the 1.5-3px band (`0.1 / 0.15 / 0.2rem`); those are the "never nudge sizes 1px
at a time" defect (p.60), not a missing token, and each is a per-site choice
between `--space-1` and `0`. A ninth token would only make the defect
expressible.

**The ratchet** (`src/lib/theme/scaleRatchet.test.ts`,
`src/lib/theme/scaleScan.ts`, `src/lib/theme/scaleBaseline.ts`,
`scripts/generate-scale-baseline.mjs`) is the sister project's pattern: the
baseline records a per-file ceiling, growth fails, **and an unrecorded shrink
fails too**, so a banked win cannot silently come back later disguised as "still
under the ceiling". Generator and test count with the same module, and a test
asserts that too. Mutation-checked in both directions and on every scale
assertion.

| ledger | at 9ada655 | after this PR |
|---|---|---|
| `emFont` — `font-size` in `em` | **137** | **96** |
| `offScaleFont` — `font-size` not on the scale | **596** | **546** |
| `offScaleSpace` — spacing components not on the scale | **1391** | **1299** |
| `offScaleWeight` — `font-weight` neither 400 nor 600 (F18) | **83** | **83** |
| files off the scale | 61 of 64 | 61 of 64 |
| …files with **zero** `em` font-sizes | 40 of 64 | 42 of 64 |

The file count does not move yet, and that is the ratchet telling the truth
rather than flattering the PR: `app.css` still carries `:root`'s 15px and the
three control primitives' padding, `AiModelsSection` still carries the
five-times-copied card and two `-1px` nudges, and `ModelCombobox` still carries
one surplus font-weight. A file leaves the ledger only when it is *finished*.

**Measured in the built app** at 1440×1000, `/settings`, both builds
(`getComputedStyle`, the audit's own method — and it reproduces the audit's 21
exactly on the base build, which is what makes the after-number trustworthy):

| | before | after |
|---|---|---|
| distinct computed font sizes on the page | **21** | **15** |
| …inside `#ai-models` | **13** | **4** |
| smallest size rendered anywhere | **8.64px** | 10.56px |
| page height | 6651px | **6588px** |
| `#ai-models` height | 2625px | **2574px** |
| `.btn` height | 28px | 28px |

> **Nearest-step is not always the right step, and an e2e gate caught it.**
> `app.css`'s full-width diff gutter was `10px`; nearest-step put it on
> `--space-3` (11.25px) — **wider than what it replaced**, which is backwards for
> the one mode whose entire purpose is going edge-to-edge.
> `e2e/fullwidth-rail.spec.ts` asserts full mode buys ≥8px of diff width over
> centered; it measured **949.5 against a required 950** and failed, twice,
> including the retry. `--space-2` (7.5px) is the step that preserves the
> intention, and it buys 15px. Recorded because a mechanical mapping applied to
> 1,391 values will be wrong somewhere, and this is what "wrong" looks like:
> arithmetically nearest, semantically inverted. Nothing but a behavioural gate
> was ever going to see it.

**Two real bugs the scale exposed**, both invisible in the CSS and both visible
in `shots/settings-models-light.png`:

1. **The ensemble row's two halves disagreed.** Its provider `<select>` rendered
   at 12.3px and the model combobox beside it at 10.125px — 21% apart, for two
   controls that are one choice. The combobox's chevron was at **8.64px**, the
   product of four nested `em` levels (`0.8 × 0.9 × 0.82 × …`).
2. **The same class rendered at different sizes in different places**, because
   each was sized relative to whatever it happened to sit in.

**The inherited items, all three closed or measured:**

- **`--chrome-muted-opacity`** — added, and its three named sites converted
  (`BridgeSection .status-dot`, `GroundingIndicator .dot`,
  `CommentThread .comment-menu-btn`). Not a disabled state and not receded
  content: in all three the information is carried at full strength by the text
  label beside it (rubric B2), so quiet chrome has no floor here.
- **The 21 disabled-state opacities** — done per site, as 2A asked. 18 converge
  on `--disabled-opacity` from four different values. **The outlier is two
  sites, not one**: `.run-reviewers-btn` *and* `.tests-review-btn` are both
  `disabled={isRunning}` with `aria-busy`, so both took a new
  **`--busy-opacity` (0.85)** — promoted from a literal to a token precisely so
  the next sweep reads an intention instead of a number it is tempted to
  flatten. The 21st was never a disabled state:
  `.picker-quick:not(:disabled):hover` is the *enabled* state, and a blind sweep
  is exactly what would have eaten it. Two sites are measured and deliberately
  left: `SectionStatus .is-disabled` (0.6) is a section that did not *run* —
  status a reader needs, not an unavailable control — and the hover rule above.
  Guarded: no component may write a bare opacity number on a disabled selector,
  `:not(:disabled)` excluded by name.
- **[F18](./ui-audit.md#f18)** — **measured and frozen, not fixed**, and that is
  a deliberate refusal. The surplus is **500 (×56) and 700 (×24)**; collapsing to
  the rubric's two weights would overturn [Batch 2A's stated choice](#b2a-f11) of
  500 for the 12px `.field-label` ("at 12px in a secondary ink a 400-weight label
  gets thin"). That is a design fork, not a mechanical one. The ratchet's
  `offScaleWeight` column now stops a fifth weight arriving and the two surplus
  ones spreading, which is what a ratchet is for when the decision behind a
  number has not been taken yet.
  > **Decided in [slice 2](#b2d-slice2): [the weight set](#f18-decided).** The
  > fork was resolved in 2A's favour — its 500 survives re-examination and is
  > kept, now as a *rule* (`--text-xs` **and** `--text-secondary` together)
  > rather than a blessed call site. The surplus was elsewhere, as suspected:
  > weight competing with a border, a fill or a hue that had already done the
  > job. `offScaleWeight` 83 → 74, which is every site inside that slice's
  > fence. Slice 2 also found [F18's invisible half](#f18-strong): `<strong>`
  > rendered at 700 with **no rule anywhere in the app**, so nineteen of the
  > twenty-one 700s on `/settings` were never in this count at all.

**Deferred out of Batch 2D's first slice, deliberately:**

- **The control primitives' padding** (`.btn`, `input`/`textarea`/`select`,
  `.chip` — 10 of `app.css`'s remaining components). These set **control
  height**, and the scale forces a genuine fork: up to `--space-2/3` makes every
  control ~6px taller and undoes Batch 2C's 260px → 231px chrome win on the
  Inspect toolbar; down to `--space-1` shortens the settings page but takes
  buttons to 25px. Same shape as the 15px root — a whole-app visual decision, so
  it gets its own slice.
- **`:root { font-size: 15px }`**, per the plan. It is the single
  `offScaleFont` entry left in `app.css`, and that entry is *meant* to sit there
  until the decision is taken.
- **The five hand-copied settings cards.** `section { margin-bottom: 1.5rem;
  padding: 1rem 1.25rem; border: 1px solid var(--hairline); border-radius: 10px }`
  is written out **byte-identically in five sections** (`AiModels`,
  `Appearance`, `Bridge`, `Providers`, `StandingRules`) — a settings card
  re-invented five times, beside the `.card` primitive that already exists in
  `app.css`. Migrating one copy would have made that section visibly differ from
  its four siblings on the same page, which is Batch 2A's recorded lesson in a
  new costume. It needs a slice that takes all five, or converges them onto
  `.card`. **This is the highest-value follow-up in the batch.**
  > **Done in [slice 2](#b2d-slice2) — and there were SIX, not five.**
  > `SkillsSection` carries a seventh-identical copy under a class selector
  > (`.skills-section`) rather than the `section` element, which is why the grep
  > that produced this count missed it. All six converged onto `.card`, keeping
  > only `margin-bottom`. Adopting it was **not** a no-op: the copies carried
  > `--hairline` in *both* themes, which is precisely the rule
  > [Batch 2B](#b2b-border) had already corrected.
- **`line-height`.** F6 records 21 distinct line-heights alongside the sizes
  (19 after this PR). A line-height scale is a ratio, not a length, and adding
  it here would have made the first ratchet reading un-actionable.
- **The two `margin: -1px` hairline-overlap nudges** in `AiModelsSection` — not
  points on a spacing scale.
- **`FileDiff.svelte` and `SymbolPopover.svelte`** stay in the baseline
  untouched: Phase 3 owns them.
- **The UA monospace default.** `13.3333px` appears 78 times on `/settings` and
  is not declared anywhere — it is Chrome's `medium` for `font-family: monospace`
  on an element with no explicit size. It is a genuine F6 contributor that no
  amount of grepping the CSS would find, and it wants one `code, pre { font-size:
  var(--text-…) }` rule in `app.css`.

**Verification that shipped with it:**

- `src/lib/theme/scaleRatchet.test.ts` — 8 tests: the two ratchet directions,
  a glob-emptiness guard, the opening ledger as a ceiling, both scales' shape
  (six strictly increasing type steps, eight spacing steps each ≥25% above its
  predecessor, every step a plain `rem` length), the root-relative property, and
  that the generator imports the same counting module.
- `src/lib/theme/contrast.test.ts` — **103 → 108 assertions.** Four cover the two
  new opacity tokens (numbers in (0,1), neither an alias, neither theme-split,
  and `busy > disabled` with the busy label clearing 4.5:1 in both themes); one
  is the assertion whose absence let Phase 1 ship a token nothing rendered —
  **every sized primitive in `app.css` must reference the scale**, with `:root`'s
  15px named as the one exception. Two existing assertions were **repaired, not
  deleted**: the F12 label-vs-control size test and the field-rhythm ratio test
  both read literal `rem` out of `app.css`, so `var(--text-*)` made them silently
  match nothing. They now resolve the indirection and fail if a rule references a
  step that does not exist.
- `src/components/design-system-primitives.test.ts` — three disabled-opacity
  guards (above).
- Screenshots: **all 14 re-captured**. The capture method was validated by
  reproducing the committed pre-change `step1-understand-light.png` height
  (1105px) exactly before capturing the new set.

---

<a id="b2d-slice2"></a>

### Batch 2D — as shipped (slice 2: the weight set and the settings card)

Slice 1 deliberately left two things open and said so. This slice closes both.
One of them was a **decision**, not a migration, and the owner delegated it.

<a id="f18-decided"></a>

#### F18 — the weight set, decided

**The set is 400 and 600, plus one named exception at 500.**

```
400  body, and anything whose emphasis is already carried by another axis
     — size, colour, position, a border, a fill, a shape.
600  emphasis: headings, the active nav item, a group label.
500  ONLY where BOTH --text-xs and --text-secondary are already in play.
```

**Batch 2A's 500 stays, and the re-examination is why.** Slice 1 froze F18
because collapsing to two weights would overturn
[2A's stated choice](#b2a-f11) of 500 for the 12px secondary `.field-label`.
Tested rather than assumed, 2A's reasoning holds: at 11.25px in a secondary ink,
size and colour have *both* already gone down, and stroke is the only axis left
holding the glyph together. Weight there is not adding emphasis — it is paying
back a little of what two other axes just took away.

The surplus was indeed elsewhere, exactly as suspected: **weight competing with
an axis that had already done the job** (p.44). Nine sites, each with the axis
that displaced it:

| site | was | now | what already carried it |
|---|---|---|---|
| `app.css .btn` | 500 | **400** | the box: a 3.5:1 `--border-control` rim (2A item 1), a fill, padding, a radius — and full `--text` ink, so nothing was taken away to pay back |
| `app.css .chip` | 500 | **400** | the pill: a 999px radius, a fill, a status tint |
| `BridgeSection .primary-btn/.secondary-btn` | 500 | **400** | the same object as `.btn`; they must not read heavier than it on the same page |
| `AppearanceSection .reset-btn` | 500 | **400** | a bordered, padded, radiused control |
| `ProvidersSection .chip-check` | 700 | **400** | a green hue no other text on the page carries (p.48-49) |
| `ModelCombobox .combobox-result-lab` | 700 | **600** | uppercase + 0.04em tracking + `--text-muted`; it IS a heading, so it takes the emphasis weight, but 700-against-600 at 11.25px buys nothing |
| `Bridge`/`Appearance`/`StandingRules` notes | `normal` | **400** | nothing — `normal` *is* 400, and a second spelling is a weight the ratchet cannot count |

`SkillsSection .mine-provider-label` **keeps** its 500 and now actually meets the
rule it always claimed to. It was `0.8rem` — a step off the scale and a step
*above* `--text-xs` — so its own comment ("the same label treatment") was true in
spirit and false in fact.

**There are no `--weight-*` tokens, and that absence is the decision.** A weight
is a choice between two values, not a scale; naming it would make a third easy to
add. It would also **launder the ratchet**, which skips `var()` values by design —
spelling 500 as a token would zero `offScaleWeight` without changing one rendered
pixel.

<a id="f18-strong"></a>

**F18's invisible half, and it is the finding of this slice.** Abolishing 700 in
the stylesheet does not abolish it on the *page*. `<strong>` and `<b>` had no
rule anywhere in this app, so they rendered at the UA's `bolder` — 700 — where
no grep and no ratchet that reads CSS can see them. Measured on `/settings` in
the built app: **21 text runs rendered at 700, and nineteen of them were
`<strong>`.** One rule in `app.css` closes it. This is the same shape as slice
1's UA-monospace finding (13.3333px, 78 occurrences, declared nowhere), and the
two together are the argument for measuring the rendered page and not only the
source.

Rendered weights on `/settings` after this slice: **400**, **500** (18 runs, all
of them `.field-label` — every one the earned exception), **600**, and two
remaining 700s, both in `SettingsPage.svelte` (`.settings-title` and one anchor),
which is outside this slice's fence.

#### The settings card — all six, converged onto `.card`

Slice 1 called this its highest-value follow-up and counted **five** copies.
**There were six.** `SkillsSection` is the only one written under a class
selector (`.skills-section`) rather than the `section` element, so the grep that
produced the count walked straight past it. *The citation is a starting point,
the grep is the set* — the third batch in a row to learn it.

All six move together, because moving one would have made that section visibly
differ from its five siblings on the same page. Each now carries
`class="card"` and keeps exactly one line of its own, `margin-bottom:
var(--space-5)`: the gap to the next card is the **page's** rhythm, and `.card`
deliberately owns no margin — a test says so, because six sections silently
doubling their gap is what would happen if it ever grew one.

**Adopting `.card` was not a no-op**, and every difference is the primitive
applying a rule the hand-copies predated. Measured with `getComputedStyle` in the
built app at 1440×1000, `/settings`, against a build of `origin/main`:

| | before (all six) | after (all six) |
|---|---|---|
| background | `rgba(0,0,0,0)` — none | `--surface` |
| border, light | `1px solid var(--hairline)` | `1px solid transparent` |
| border, dark | `1px solid var(--hairline)` | **unchanged** |
| radius | 10px | 8px |
| padding | 15px 18.75px | 11.25px 15px (`--space-3`/`--space-4`) |
| shadow | none | `--elevation-1` |
| margin-bottom | 22.5px | 22.5px (unchanged, now a token) |

The border row is [Batch 2B's rule](#b2b-border) reaching the last surface that
had not taken it. Boundary contrast on `/settings`, measured against the page
ground:

| | light before | light after | dark before | dark after |
|---|---|---|---|---|
| rim vs page ground | **1.33** | — (transparent) | **1.43** | **1.43** (kept) |
| surface vs page ground | — (transparent) | **1.06** | — (transparent) | **1.08** |
| `--elevation-1`, tight part | — | **1.31** | — | **1.06** |

Stated honestly: in **light** the shadow at 1.31 does not *beat* the 1.33 rim it
replaces — it is a wash on that one axis — but the card also gains a background
shift it never had, so the boundary is carried by **two** cues instead of one and
the page stops reading as six outlined rectangles. In **dark** nothing is given
up at all: the rim is kept at 1.43 and both other cues are added on top. That
asymmetry is the whole point of 2B's `light-dark(transparent, var(--hairline))`.

**On 2B's claim that it styled `.glance-card` so adopting `.card` would be a
no-op: verified, and qualified.** It holds for background, border and radius, and
*exactly* for padding — `0.75rem`/`1rem` **is** `--space-3`/`--space-4`. It does
not hold for elevation: `.glance-card` takes `--elevation-2` deliberately, to
outrank the detail panels below it, and adds its own flex layout. So the claim is
true of the card's **skin** and false of its **depth**, which is a deliberate
divergence rather than drift. `.glance-card` is left alone.

#### The ledger

| ledger | after slice 1 | after this slice |
|---|---|---|
| `emFont` | 96 | 96 |
| `offScaleFont` | 546 | **545** |
| `offScaleSpace` | 1299 | **1281** |
| `offScaleWeight` | 83 | **74** |
| files off the scale | 61 of 64 | **60 of 64** |

`settings/ModelCombobox.svelte` **leaves the baseline entirely** — the first
settings file to finish. Page height on `/settings`: **6064px → 6019px**.

**Why `offScaleWeight` stops at 74 and not lower: the fence.** Of the 83, only
**12 were inside this slice's files**; nine of those are gone and the three that
remain are the earned exception. The other 71 sit in step components and panels
(`VerdictStep` 11, `UnderstandStep` 10, `InspectStep` 8, `panels/*` 14, and a
long tail) that parallel agents own. The decision above is the rule those slices
should apply; the ratchet holds them at today's count meanwhile.

#### Verification that shipped with it

- **`src/components/design-system-primitives.test.ts` — 12 new guards.** F18
  (7): `app.css` declares only 400/500/600; no `normal`/`bold` spelling in the
  fence; **every 500 sits on text demoted in both size and colour**; the
  exception is still actually taken, so the rule cannot pass vacuously with no
  500s left; `.btn`/`.chip` are pinned at 400; no settings section declares 700;
  and the glob really reaches the sections. The card (5): all six sections are
  found and wear `class="card"`; none re-declares the card chrome (a
  section-level rule may carry `margin-bottom` and nothing else); `.card` keeps
  2B's border rule, a `--surface` background, `--elevation-1` and scale padding;
  and `.card` carries no margin. Mutation-checked: putting `.btn` back to 500
  turns exactly two of them red, and the failure names the site and which axis it
  is missing.
- **Screenshots: four re-captured** (`settings-models-*`, `landing-*`). The
  capture recipe is not committed anywhere, so it was reverse-engineered and
  **validated against `origin/main` before use**, the way slice 1 validated its
  own: full page at a 1440×1000 viewport, `deviceScaleFactor` 1, then
  `sips --resampleWidth 780` for the settings page. Rebuilding `main` reproduced
  the committed `settings-models-light.png` at 780×3284 against its committed
  780×3282, and `landing-light.png` at 1440×1000 exactly.

#### Deferred out of this slice, deliberately

- **The other 71 `offScaleWeight` declarations**, all outside the fence. Not a
  sweep: the rule above is per-site, and slice 1's `.picker-quick` near-miss is
  the standing warning about blind ones.
- **The six review-flow shots** (`step1-understand-*`, `step2-inspect-*`,
  `focus-dim-*`). They *are* affected — `.btn` and `<strong>` appear on all of
  them — but each is driven by a mocked PR fixture that exists only inside an
  e2e spec, and no capture script is committed. Shooting them against an invented
  fixture would make the set internally inconsistent and destroy the before/after
  comparison the directory exists for. **The real fix is a committed capture
  script**, which is its own small piece of work.
  *(Closed — and the premise was wrong. The fixture was never e2e-only; it is
  `src/lib/demo/fixture.ts`, served at `/demo`. See
  [the capture script](#capture-script).)*
- **`SettingsPage.svelte`'s two remaining 700s** (`.settings-title` and one
  anchor) — outside the fence, and the only 700s still rendering on `/settings`.
- **`SkillsSection`'s `0.8rem` siblings.** Only `.mine-provider-label` moved to a
  scale step, because it was the one the weight rule had to be true of. The other
  27 `em` font-sizes in that file are a type-migration slice, not a weight one.
- **Everything slice 1 deferred that this slice did not name** stands unchanged:
  the control primitives' padding, `:root { font-size: 15px }`, `line-height`,
  the two `margin: -1px` nudges, and the UA monospace default.

---

## Phase 3 — the diff viewer, last

**Files:** `src/components/FileDiff.svelte`, `patches/@git-diff-view__svelte.patch`,
the lowlight syntax theme.

Why last is not negotiable: it is the densest surface, it wraps a pnpm-patched
dependency, it carries the recede dimming that Phase 1 retunes, and its palette
fork ([F5](./ui-audit.md#f5)) can only be resolved against tokens that are already
settled. Touching it earlier means re-doing it after every other batch.

1. **Re-point the vendored palette at the app's tokens** ([F5](./ui-audit.md#f5)):
   the context ground (`#0d1117` → `--surface`), the body ink
   (`#ffffff`/`#000000` → `--text`), the added/removed grounds (one green and one
   red, shared with the legend chips, not two of each), and the `#0969da`
   add-comment widget (→ `--accent`, 78 instances).
2. **Bring syntax highlighting inside the contrast gate** (rubric A4): every token
   ≥ 4.5:1 on *every* ground it can land on. Three light tokens fail today —
   keyword 4.11:1 and comment 4.33:1 on the added ground, built-in 3.49:1 on plain
   white.
3. **Replace alpha-recede with ink-substitution** on receded rows
   ([P1-4](#p1-4)(b)): one muted ink for the whole row instead of six dimmed hues.
   This is the only change that puts a real floor under focus mode and hunk
   attention, and it is why 0.55 is an interim fix rather than the answer.
4. **Side-by-side density** — it inherits unified's padding at half the column
   width; give it its own decision (p.59). *(Decided: measured, not changed —
   see [item 4](#p3-item4). The premise about the padding is true; the
   conclusion drawn from it is not.)*
5. Keep what works: the row grouping (gutter / number / marker / content as one
   group, rubric A3) and the marker + line-number status redundancy (rubric B2)
   are the best-executed parts of the app. Do not regress them.

**Risk note.** Items 1 and 3 touch the patched dependency. The existing patch is
already a behavioural fix to `DiffUnifiedExtendLine.svelte`; adding palette
changes to it increases rebase cost on every upgrade. Prefer CSS custom-property
overrides from `FileDiff.svelte` where the vendored markup allows it, and extend
the patch only where it does not.

<a id="p3-shipped"></a>

### Phase 3 — as shipped

Items 1, 2, 3 and 5 shipped. **Item 4 (side-by-side density) is deliberately not
in this PR** — see the bottom of this section. *(It closed later, in
[item 4 — measured, not changed](#p3-item4): the measurement it was waiting for
said not to change anything.)* One PR, seven commits along the
item seams, plus a merge of [Batch 2D's first slice](#b2d-shipped), which landed
on `main` while this was in flight and needed three hand-resolved conflicts
(recorded in that merge commit).

**The risk note was over-cautious, and that is the headline.** The patch was not
touched at all. `@git-diff-view` resolves every one of its grounds through a
custom property (`dist/utils/color.js` names them; the components emit
`var(--diff-…--)` into inline styles), so the whole structural palette re-points
from outside. `patches/@git-diff-view__svelte.patch` is byte-identical to what
it was — the single behavioural `isHidden` fix — and this change adds nothing to
the rebase cost of the next upgrade. Inline `extendData` rendering was
re-verified anyway, in both modes: the receded-hunk marker and the MEDIUM
finding render inline in the shots, and `guided-review`, `finding-reanchor`,
`draft-lifecycle` and `skill-reviewers` all pass.

#### Where it lives

A new `src/components/diff-view-theme.css`, imported by `FileDiff.svelte`
immediately after the vendored sheet. Not the component's `<style>` block,
because the syntax mapping is ~40 selectors and `SymbolPopover` needs the same
tokens; not `app.css`, because it is a binding layer, not a palette.

**Every selector is prefixed `:root`.** The vendored rules are theme-scoped
(`.diff-tailwindcss-wrapper[data-theme="light"] .diff-line-syntax-raw
.hljs-keyword`), and ours must beat them *without depending on stylesheet order*
— the library's CSS is imported from a component, so its position relative to
`app.css` is a bundler detail. `:root` is a pseudo-class, so prefixing it adds
exactly one class-level unit to every selector: a uniform +1 over each vendored
rule it mirrors, whether that rule carries one class or three.

#### Item 1 — the palette re-point ([F5](./ui-audit.md#f5))

Twenty bindings, every one asserted in `contrast.test.ts`:

| the viewer's role | was (GitHub) | now |
|---|---|---|
| context ground | `#ffffff` / `#0d1117` | `--surface` |
| expand + empty rows, plain gutter | `#fafafa` / `#161b22` | `--surface-sunken` |
| added / removed row | `#dafbe1` `#ffebe9` / `#18271f` `#23191c` | `--legend-added-bg` / `--legend-removed-bg` |
| changed-words highlight, add/del gutter | `#aceebb` `#ffcecb` / `#2f5732` `#713431` | `--diff-added-emphasis` / `--diff-removed-emphasis` |
| line numbers | `#555555` / `#a0aaab` | `--text-secondary` |
| hunk header row | `#ddf4ff` `#b6e3ff` `#777777` | `--surface-sunken` + `--text-muted` |
| hunk expand hover | `#0969da` | `--accent` |
| border | `#dedede` / `#3d444d` | `--hairline` |
| **add-comment widget** | **`#0969d2` + `#ffffff`** | **`--accent` + `--on-accent`** |
| body ink | `#000000` / `#ffffff` | `--syntax-ink` (= `--text`) |

The `#0969d2` widget count in the built app was exactly the audit's **78** per
file-set in unified (194 in split, which renders both columns). After: **0**
elements paint any `rgb(9, 105, 21x)`.

**The body ink was not where the audit implied.** It is not a per-element
colour: each vendored theme block ends with a bare `color: black` / `color:
white` on `.diff-style-root`, the inherited base of the *entire* subtree. That
is why 278 elements measured `#ffffff`. Re-pointing the named properties left
**151 dark elements still inheriting white**; it was caught by sweeping every
computed colour in the wrapper and flagging anything that is not a resolved app
token, not by re-reading the declarations that had just been changed. That sweep
is now an e2e gate.

In dark this is what closes the audit's "three unrelated dark greys meeting
within a few pixels": the diff body is `--surface` `#1b1e24` inside a card on
`--bg` `#14161a`, and `#0d1117` is gone. Two greys, each with a job.

#### Item 2 — syntax inside the contrast gate (rubric A4)

**The audit under-counted: four failing tokens, not three, across seven
(token, ground) pairs.** It measured only the context and added grounds, and it
missed `.hljs-name` entirely. On the grounds the viewer actually painted:

| token | on context `#ffffff` | on added `#dafbe1` | on removed `#ffebe9` |
|---|---|---|---|
| keyword `#d73a49` | 4.57 | **4.11** | **3.99** |
| comment `#6a737d` | 4.82 | **4.33** | **4.20** |
| built-in `#e36209` | **3.49** | **3.14** | **3.04** |
| name/tag `#22863a` | 4.63 | **4.16** | **4.03** |

Five of those seven were confirmed with `getComputedStyle` in the built app; the
two on the removed row are arithmetic on the same values, because the demo PR
happens not to delete a line containing a comment or a tag.

GitHub's hues are kept — a reader already knows them — and repaired by the
*smallest* walk toward black (light) or white (dark) that clears 4.5 on all six
grounds. Six light values and two dark values moved; the hue is untouched:

```
light  keyword  #d73a49 -> #ac2f3b     dark  keyword #ff7b72 -> #ff8880
       variable #e36209 -> #9c4306           comment #8b949e -> #a5acb3
       comment  #6a737d -> #575f67
       tag      #22863a -> #1b6c2f
       constant #005cc5 -> #005ac1   (one step)
       bullet   #735c0f -> #725b0f   (one step)
```

Worst ratio across the whole 9x6 matrix (nine inks, six grounds): **4.50 light**
(`--syntax-constant` on the removed emphasis tint) and **4.50 dark**
(`--syntax-keyword` on the added emphasis tint), computed in `contrast.test.ts`
from the shipped token values. Before: 3.04 light. The browser sweep, which only
sees the combinations the demo PR actually renders, bottoms out at **5.39**
light and **5.41** dark. Counting (token, ground, state) triples below their
floor on the Inspect step: **42 before, 0 after** — 14 in light-unified, 14 in
light-split, 7 in each dark mode.

**The word-level highlight is where the real trade-off was**, and it is worth
recording because the obvious ordering is wrong. Solving the inks against all
six grounds *including* a GitHub-strength highlight tint produces a muddy,
near-black light theme (keyword `#942833`, variable `#863a05`). Solving the inks
against the four ROW grounds first, then choosing the highlight as the strongest
tint those inks still clear, leaves almost no room — the removed row is already
the binding constraint at exactly 4.5. The tints shipped are the smallest mix of
the legend *border* into the legend *background* whose step off the row reaches
**1.20:1** — the same step GitHub's own light highlight makes, and the step our
removed row makes off white (1.19). That fixes the tint, and the inks are solved
against it.

#### Item 3 — recede by ink substitution ([P1-4](#p1-4)(b))

`--recede-opacity` is **retired**, not merely unused. Phase 1 shipped it as an
explicitly interim fix and its own test documented why alpha could never work;
when the real answer lands, leaving the interim token declared is how it comes
back. Retiring it also halves the app's last copy of the
[F17](./ui-audit.md#f17) hazard — the two dark-override blocks now carry one
declaration each, not two.

**Phase 1's diagnosis was right and, if anything, understated: alpha failed in
BOTH themes.** The plan's table only measured the base ink in dark (4.53, fine).
Measured on the real syntax:

| receded token | light @0.55 | dark @0.45 |
|---|---|---|
| keyword on the removed row | **2.16** | **2.40** |
| keyword on the context row | **2.31** | **2.39** |
| title on the added row | **2.45** | **2.73** |
| string on the context row | 3.44 | 3.34 |

The mechanism is one custom property. Every rule in `diff-view-theme.css` reads
`var(--syntax-recede-ink, var(--syntax-<role>))`, so a receded cell needs
**one declaration** — `--syntax-recede-ink: var(--syntax-receded)` — to repaint
fifteen syntax roles plus the base ink, with no specificity fight. Hover sets it
to `initial`, which makes the property guaranteed-invalid so every rule falls
back to its own role token. Focus mode (`.dimmed-noise`) and hunk attention
(`.hunk-receded`) share the rule, exactly as they shared the alpha.

`--syntax-receded` is **`--text-muted`**, not a new colour. "De-emphasised but
still readable" is a tier the palette already has, and reusing it keeps receded
code in the same visual language as every other muted thing in the app.

| | context | sunken | added | removed | add-emph | del-emph |
|---|---|---|---|---|---|---|
| light | 5.39 | 4.78 | 5.00 | 4.51 | 4.16 | 3.74 |
| dark | 5.78 | 5.25 | 4.33 | 5.41 | 3.60 | 4.49 |

Against 2.16-3.34 before, in both themes. It still recedes hard: the step down
from `--syntax-ink` is 15.80 -> 5.39 in light and 13.39 -> 5.78 in dark.

**Two consequences, both deliberate.** A receded row now keeps its **full
add/remove tint** — `opacity` on the cell used to fade the cell's own background
too. The content recedes; the structure does not, so a reader still sees which
receded lines are additions. And the row is genuinely opaque, which the e2e gate
asserts, so "recede" can no longer be quietly reintroduced as alpha.

#### The `SymbolPopover` question — Batch 2B was right

[Phase 1](#p1-shipped) deferred it and Batch 2B, having found the identical
pattern in `SymbolTestPairing` to be a live bug, said to treat this one the same
way. **It is the same bug**, and the evidence is from the build, not the source:
driving the real popover to its definition peek and reading `getComputedStyle`
on all 32 classes the explicit-light block styles, **12 resolve to a different
colour on the two ways a reader reaches light.** The
`@media (prefers-color-scheme: light)` copy was missing **14 selectors**, so on
`auto` + an OS set to light the peek painted:

| class | auto + OS light painted | on the white snippet |
|---|---|---|
| `.hljs-template-tag`, `.hljs-template-variable` | `#ff7b72` (dark keyword) | **2.5:1** |
| `.hljs-attribute`, `.hljs-meta`, `.hljs-operator`, `.hljs-variable`, `.hljs-selector-attr`, `.hljs-selector-class` | `#79c0ff` (dark constant) | **1.9:1** |
| `.hljs-quote` | `#7ee787` (dark tag) | **1.5:1** |
| `.hljs-code`, `.hljs-formula` | `#8b949e` (dark comment) | 3.0:1 |

(14 missing selectors, 12 observable divergences: `.hljs-title.class_` and
`.hljs-meta .hljs-string` also match a shorter selector that *was* present and
carries the same group colour.)

Three blocks collapsed to one pointing at the new `--syntax-*` tokens.
Re-measured after: **0 of 32 diverge**. `SymbolTestPairing`'s `light-dark()`
literals point at the same tokens, so the app now has **one** syntax palette
where it had three copies of one.

#### Item 5 — what was kept

The row grouping and the marker + line-number redundancy are untouched; the
before/after shots are otherwise identical in layout. The one visible structural
change is that the gutter is now a well (`--surface-sunken`) on context rows and
one emphasis step on changed rows, which is the same "lighter comes forward"
rule Batch 2B settled.

#### Verification that shipped with it

- **`src/lib/theme/contrast.test.ts` — 103 assertions -> 255.** `DIFF_GROUNDS`
  was a hand-copied table of the dependency's own hex values with a breadcrumb
  saying "replace these in Phase 3"; it is token names now, so it cannot go
  stale behind the app again. Mutation-checked with 8 mutations, each caught:
  reverting the keyword or variable ink to GitHub's (6 failures each),
  brightening the receded ink (2), restoring `#0969d2` (2), mis-binding the
  removed row (1), collapsing an emphasis tint onto its row (3), re-adding
  `opacity` to the recede path (1), dropping the `:root` prefix (1).
- **`e2e/diff-palette.spec.ts` — 12 tests**, light/dark x unified/split. The
  unit test proves the values are right and the bindings are *written*; it
  cannot prove they *win*, and a rule that is out-specified looks exactly like a
  rule that is right, in the source. So: every computed colour in the viewer
  resolves to an app token; a receded row paints one ink at opacity 1 and hover
  restores the role colours; every rendered token clears its floor on the ground
  it actually landed on. Mutation-checked in the browser — dropping the `:root`
  prefix, the entire specificity argument, fails all three.

This is [2A's lesson](#b2a-shipped) applied: two things were caught only by
measuring rendered output — the 151 elements still inheriting white, and (in the
spec itself) that at 1280x720 the first receded cell is below the fold, so a
`mouse.move` to its bounding box never reached it and "hover does not restore"
looked like a product bug.

#### Deferred, and why

- **Item 4, side-by-side density.** Untouched. It is a spacing decision that
  needs its own measurement and its own before/after, the cell padding lives in
  the vendored components' Tailwind classes rather than in a custom property,
  and this PR is already a palette change across four files. Splitting it keeps
  both reviewable. It is also the one Phase 3 item with no contrast component,
  so nothing else was waiting on it. **Closed in [item 4 — measured, not
  changed](#p3-item4)**, which found that the padding is identical between the
  modes and that split's density is bounded by column width instead.
- **Batch 2D's ratchet baseline is unchanged by this PR**, and it is worth
  recording what the ratchet actually sees here, because the brief for Phase 3
  assumed otherwise. `FileDiff.svelte` is `emFont: 0` — the diff viewer's `em`
  font-sizes are all in the **vendored** stylesheet and components
  (`text-[1.2em]` and friends), which are outside `src/` and therefore outside
  the ratchet's scope by design. What is on the ratchet is
  `FileDiff.svelte`'s `offScaleFont: 18` / `offScaleSpace: 53`,
  `SymbolPopover.svelte`'s `19 / 35` and `SymbolTestPairing.svelte`'s `11 / 23`,
  and Phase 3 moved none of them: it added and removed only `color`
  declarations, one `transition` property name, and one custom-property
  declaration. The new `src/components/diff-view-theme.css` is not scanned
  either — the scope is `src/**/*.svelte` plus `src/app.css` — and it contains
  no length or font-size to scan.

  Migrating those three files onto the scale is a later 2D slice, and it should
  stay that way: the shared `--space-*` decision for a code table is a density
  judgement that wants its own before/after, not a rider on a palette change.
- **The audit's F5 entry is left as written.** It is the record of the
  pre-refactor state; the two places it undercounts (three light syntax failures
  rather than five, and the body ink as a per-element colour rather than an
  inherited base) are corrected here instead.

<a id="p3-item4"></a>

### Phase 3, item 4 — side-by-side density: measured, not changed

The deferred item, closed. **No pixel changed.** What shipped is the measurement
that was owed, plus [`e2e/diff-density.spec.ts`](../../e2e/diff-density.spec.ts)
— a gate on the relationships, so the decision stays checked rather than
remembered.

**The audit's stated mechanism is disproven.** [The density
entry](./ui-audit.md#density-of-the-review-surfaces) says side-by-side "inherits
the same padding as unified at half the column width, **so each pane's code sits
tighter against its gutter**." The first clause is true; the second does not
follow and is not what the browser reports. Measured in the built app at
1440x1000, `/demo` step 2, both themes (spacing is theme-independent — every
number below is identical in light and dark):

| | unified | split, per pane |
|---|---|---|
| gutter cell padding | 10px / 10px | 10px / 10px |
| content cell padding | 0 / 10px | 0 / 10px |
| marker inset (`pl-[2.0em]`) | 28px | 28px |
| line-number ink → code text | **38px** | **38px** |
| font-size / line-height | 14px / 22.4px (1.6) | 14px / 22.4px (1.6) |
| unwrapped row height | 22.39px | 22.39px |

Nothing sits tighter against anything. Split and unified are one surface with
one density, declared once — which is what rubric A1 asks for. The failure A1
actually describes ("dense merely because it inherited tight padding") does not
apply either: the audit's own [What passes](./ui-audit.md#what-passes) calls the
diff body "the best-executed surface in the app," so the density was chosen, and
split uses the chosen one.

**What does differ is the column left over, and that is a width question.**

| at 1440x1000 | code column | columns of code | rows that wrap | source rows per 1000px |
|---|---|---|---|---|
| unified, centered | 892px | 106 | 0 % | **44.7** |
| split, centered | 430px | **51** | 16.2 % | **38.4** |
| unified, full-width | 1259px | 149 | 0 % | 44.7 |
| split, full-width | 614px | **72** | 4.1 % | **42.9** |

Split is 14 % less dense than unified at the default width and 3.9 % less at
full width, and the whole of that difference is wrapping — 16.2 % of split's
rows against none of unified's, at 1.16 visual lines per source row. A wrapped
row is the real cost: its second visual line has no line number and no marker,
so it spends a row of height while breaking rubric A3's grouping for that line,
and `word-break: break-all` splits identifiers mid-word (`strin|g`, `ab|orted`
in [the shot](./shots/step2-inspect-split-light.png)).

**So padding is the wrong lever, by two orders of magnitude.** Everything
reclaimable inside a pane is the 7px of dead space before the marker box; across
both panes that is 14px, or **1.7 characters of 51**. The width setting is worth
**21 characters**, and the app already ships it — `diffWidth: full` in
Appearance, which closes 72 % of the gap. Re-tuning the vendored padding to buy
1.7 characters would spend the marker inset that A3's grouping depends on, and
would fork split's density from unified's to chase a rounding error. Hence: no
change.

<a id="p3-seam"></a>

**The one genuine soft spot, recorded rather than fixed.** In split there are
two `[number | marker | code]` groups on one row, so the seam between the panes
is a group boundary and p.83 / p.86 apply: the space around a group must exceed
the space inside it. Measured, the seam is **21px** (10px content padding + 1px
divider + 10px gutter padding) against a largest within-pane gap of **~19.8px**
(line-number ink → marker ink). It clears the rule — by 6 %. Under p.61-62's own
standard (adjacent values must differ by ~25 % or the choice is arbitrary), a
6 % margin is not a relationship a reader can perceive; the boundary is really
carried by the 1px `--hairline` divider, which measures 1.41:1 (light) and
1.31:1 (dark) against the grounds it separates.

It is left alone deliberately, and both available fixes are worse:

- **Widening the seam** costs code width in the mode that is already
  width-starved — [Batch 2D's mistake](#b2d-shipped) exactly, a gutter made
  wider in the mode whose purpose is fitting more across.
- **Thickening the divider to 2px** (p.50-51 is the applicable rule) re-forks
  `--hairline`, which the app decided once and [Phase 3](#p3-shipped) spent its
  effort unforking.

And the grouping is redundantly carried anyway, the way rubric B2 asks: the
line numbers restart, the marker column restarts, and on changed rows the two
panes carry different tints. The 6 % margin is therefore recorded, and pinned by
the spec, rather than tuned.

**Verification.** Three tests x two themes, all measuring rendered output in the
built app. Mutation-checked in the browser with five effective mutations, each
caught: split-only content padding (4 failures), `--diff-border--` reverted to
the vendor's `#e1e1e1` (the hairline assertion alone), the divider removed, a
split-only marker inset, and pane asymmetry. A sixth was **inert**, and is the
useful one for the next person: setting `border-left-color` from a stylesheet
changes nothing, because the vendored markup writes it inline as
`var(--diff-border--)` — the seam divider is reachable only through that custom
property, not through a selector.

`patches/@git-diff-view__svelte.patch` was not opened, and `src/` is
byte-identical to Phase 3's. The six diff screenshots stay Phase 3's: no
rendered pixel changed, so re-capturing them would be churn against a 2.5 MB
set.

**Deferred from here, as product decisions rather than spacing ones:**

- **Split wastes half its width on single-sided files.** In [the
  shot](./shots/step2-inspect-split-light.png) the first file is all-add, so the
  entire left pane is an empty placeholder — 50 % of the viewer showing nothing
  while the right pane wraps. Falling back to unified for single-sided files (or
  letting the populated pane take the full width) is a real improvement and a
  real UX fork; it wants its own decision, not a rider on a measurement.
- **Whether `diffWidth: full` should be the default**, given it is worth 21
  columns per pane in split and ~12 % more source rows per screen. That is a
  whole-app default, adjacent to "does not change `:root { font-size: 15px }`"
  below. *(Decided: **yes**. See [the default, decided](#fullwidth-default).)*

---

<a id="fullwidth-default"></a>

## `diffWidth: full` — the default, decided

The fork [item 4](#p3-item4) left open, closed the way it asked to be: on the
measurement, not on taste. `DEFAULTS.diffWidth` in
[`src/lib/settings/settings.ts`](../../src/lib/settings/settings.ts) is now
`'full'`. At 1440x1000 that is **72 columns per split pane against 51**, and
**4.1 % of rows wrapping against 16.2 %** — 72 % of the split-vs-unified density
gap, closed by a setting the app already shipped.

**Only the unset default moved.** `getSettings()` is
`{ ...DEFAULTS, ...coerce(stored) }`, so a stored value is applied last and
wins; anyone who chose `centered` keeps it. Six guards in
`src/components/InspectStep.diffwidth.test.ts` pin that, and all six go red
under the one mutation that matters (swapping the spread order). The Appearance
toggle is untouched.

**Two honest notes, one of them a correction.**

*The known cost of a default change here:* `save()` writes the whole resolved
settings object, so a user who has ever changed any setting already has
`diffWidth: 'centered'` materialised in `localStorage` — chosen or not. The new
default therefore reaches genuinely new profiles, not the existing installed
base, and nothing can tell a deliberate `centered` from a materialised one after
the fact. That is the correct conservative failure: it never overrides a real
preference.

*The accepted consequence, measured — and it is narrower than it was assumed to
be.* Full width was accepted on the understanding that it widens the **prose**
surfaces too, "summary, findings, the outcomes panel". Measured in the built app
at 1440x1000, `/demo`, that is **false for the summary and the outcomes panel
and true only of the findings on step 2**, because the cap is lifted by
`:root[data-diffwidth='full'] .review:has(.inspect-layout)` — scoped to step 2
on purpose, with `app.css` saying so in a comment. Steps 1 and 3 are byte-for-byte
the same width in both modes:

| surface | centered | full |
|---|---|---|
| step 1 summary paragraph (13.5px) | 1025.5px / **126.6ch** | **unchanged** |
| step 3 verdict / cost panel rows (15px) | 1022.5px / **113.6ch** | **unchanged** |
| step 2 `.review` container | 1080px | **1440px** |
| step 2 finding body paragraph (13.5px) | 978.5px / **120.8ch** | 1346px / **166.2ch** |
| step 2 `.skill-finding-body` (12.75px) | 978.5px / **127.9ch** | 1346px / **175.9ch** |
| step 2 secondary findings list (15px) | 1005px / **111.7ch** | 1372.5px / **152.5ch** |

**So one thing does land badly, and it is recorded rather than fixed here.**
[Batch 2C](#b2c-shipped) measured the settings column at **74ch** and called that
already at the top of comfortable measure. The step-2 findings run at
**166–176ch** in full mode — about **2.4x** that — and they were already over at
**111–128ch** in centered, so the default did not create the problem, it
enlarged one that was there. Capping the prose measure while letting the diff
take the room is the real follow-up. It is deliberately NOT in this change:
it is a component decision about the finding cards, it needs its own before/after,
and bundling it would have made a one-line default change unreviewable.

<a id="capture-script"></a>

## The capture script — the recipe, committed

[`scripts/capture-shots.mjs`](../../scripts/capture-shots.mjs) regenerates all
fourteen shots. It exists because the recipe was never written down, so **three
separate agents reverse-engineered it**, each re-validating the guess by
rebuilding `origin/main` and reproducing a committed shot — and the third still
could not re-shoot six of the fourteen.

```
node scripts/capture-shots.mjs                # build, serve, shoot all 14
node scripts/capture-shots.mjs --check        # shoot to a temp dir, compare, write nothing
node scripts/capture-shots.mjs --only landing
node scripts/capture-shots.mjs --base-url http://localhost:4173
```

**The blocker was a false premise, and that is the finding.** Slice 2 deferred
the six review-flow shots because their fixture "exists only inside an e2e spec",
so re-shooting meant inventing one. It never did. The fixture is
[`src/lib/demo/fixture.ts`](../../src/lib/demo/fixture.ts) — a committed, in-app
example PR served at `/demo`, with every AI panel pre-generated into the `done`
state: no spinners, no streaming, no network, no clock.
[`e2e/diff-density.spec.ts`](../../e2e/diff-density.spec.ts) already measured
against it. Nothing had to be factored out of `e2e/`; the six shots were
reachable the whole time. **All six are re-captured, and the set is current.**

**The recipe.** Viewport 1440x1000 at `deviceScaleFactor: 1`; the full settings
object written to `localStorage` before first paint, so no shot inherits a
default; analytics blocked; fonts loaded and two idle frames before the shutter.
Shots are full-page **except** the step-2 diff surfaces, which are clipped to the
viewport. That last rule is not a preference — it is forced by the committed
files: `step1-understand-*.png` is 1440x**1120**, taller than the viewport, so it
can only be full-page, while `step2-inspect-*.png` is exactly 1440x**1000**
against a 2867px document, so it can only be a clip. `/settings` is shot
full-page at 1440 and then downsampled with `sips --resampleWidth 780`, which is
what keeps a ~6000px page to ~550KB (macOS-only; the script says so).

`diffWidth` is pinned to `'centered'` in the script even though the app now
defaults to `'full'`, so this directory's before/after axis stays the token and
component layer — one variable at a time. The width comparison is the table
[above](#fullwidth-default), not a silent change to every diff shot at once.

**Validated before being believed**, the way the earlier slices validated theirs.
Against a build of the current tree, **12 of the 14 reproduce at exactly the
committed dimensions** — including all six that were called stale, and including
`step1-understand-*` at its distinctive 1440x1120. The other two are
`settings-models-*` at 780x**3257** against a committed 780x**3260**: a 3px
drift from real app movement since slice 2 (#264, #265), not a recipe error.
The script also reproduces the set's own quirk — `focus-dim-*` comes out
byte-identical to `step2-inspect-unified-*`, exactly as committed. Total:
**2.5 MB for 14**, the size discipline held.

**One caveat, found by over-claiming and then checking.** The capture is
deterministic *against a given build* — two runs of the same build produce
fourteen byte-identical files — but **six of the fourteen change on every commit
even when nothing visual moves**. `BuildIndicator.svelte` renders `BUILD_SHA` and
`BUILD_TIME`, which Vite bakes in at build time (`build 017a2ef · 2026-09-23`),
and that footer sits inside the captured area on exactly three surfaces:
`landing-*` (footer at y=969 of a 1000px page), `settings-models-*` (y=5983 of
6014) and `step1-understand-*` (y=1089 of 1120 — the footer *is* why that shot is
1120 rather than 1000). The step-2 shots are viewport clips at 1000px and the
footer sits at y=2836, so it never enters them; on `step3-verdict-*` the sticky
draft bar covers it.

So **a byte diff on those six is not evidence that the design moved** — the
dimensions, and the other eight files, are the signal. It also means re-running
the capture always dirties them. The fix, if this ever becomes annoying, is to
neutralise the sha in capture mode rather than to crop the footer out; it is
left alone here because it is a real part of the page.

---

## What this plan deliberately does not do

- **Does not change `:root { font-size: 15px }`.** Whole-app effect; its own decision.
- **Does not re-litigate typefaces.** Settled and shipped (rubric "what does not apply").
- **Does not touch prompts or `PROMPT_VERSIONS`.** No relation to the token layer.
- **Does not redesign the empty states' copy** ([F15](./ui-audit.md#f15)) beyond
  giving them a visual treatment — new copy is a product decision, not a refactor.
- **Does not attempt a mobile pass.** Desktop tool; separate project.

## Gates for every PR in this plan

```
pnpm check                    # svelte-check — 0 errors
pnpm test                     # vitest, FULL suite
pnpm exec playwright test     # e2e
pnpm build                    # clean
```

Plus, from Phase 1 onward, the contrast test of [P1-6](#p1-6) — and for any PR
that changes a rendered pixel, before/after screenshots at the same routes and
viewports as [`./shots/`](./shots/), in the PR body.
