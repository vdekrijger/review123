# UI refactor plan — phased, reviewable, revertible

Companion to [`ui-audit.md`](./ui-audit.md) (the findings, `F1`-`F18`) and
[`refactoring-ui-principles.md`](./refactoring-ui-principles.md) (the rubric and
its page refs).

**Status: Phase 1 shipped. Phase 2 in progress — Batch 2C shipped. Phase 3 is
still a proposal.**

Phase 1 landed as one PR — see [Phase 1 — as shipped](#p1-shipped) for what
changed against what this document proposed, and for the measurements taken from
the built app rather than from the token values. Batch 2C followed — see
[Batch 2C — as shipped](#b2c-shipped). The screenshots in [`./shots/`](./shots/)
are the **after** state of the most recent batch to touch each surface; the
pre-Phase-1 state is in git history at commit `38b9e9a`, and the pre-Batch-2C
state of the settings page and the Inspect step at commit `038e6d4`.

Every token value in Phases 2 and 3 remains *proposed and measured*, not applied.

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
4. Style the two unstyled anchors ([F14](./ui-audit.md#f14)) —
   `AiModelsSection.svelte:481`, `StandingRulesSection.svelte:385`.
5. Replace the `0.45` disabled literals with `--disabled-opacity`.

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
- **`Stepper.svelte` and `ContextRail.svelte`** were listed in this batch's files
  and were **not changed**. The stepper is Tier 1 and is already the most
  prominent chrome row on the Inspect step; the context rail is collapsed to a
  27px off-canvas tab and is not one of the seven rows. Neither needed a change
  for items 1-5, and neither got one for its own sake.
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
   width; give it its own decision (p.59).
5. Keep what works: the row grouping (gutter / number / marker / content as one
   group, rubric A3) and the marker + line-number status redundancy (rubric B2)
   are the best-executed parts of the app. Do not regress them.

**Risk note.** Items 1 and 3 touch the patched dependency. The existing patch is
already a behavioural fix to `DiffUnifiedExtendLine.svelte`; adding palette
changes to it increases rebase cost on every upgrade. Prefer CSS custom-property
overrides from `FileDiff.svelte` where the vendored markup allows it, and extend
the patch only where it does not.

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
