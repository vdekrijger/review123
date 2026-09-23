# UI refactor plan — phased, reviewable, revertible

Companion to [`ui-audit.md`](./ui-audit.md) (the findings, `F1`-`F18`) and
[`refactoring-ui-principles.md`](./refactoring-ui-principles.md) (the rubric and
its page refs).

**Status: proposal.** Every token value in this document is *proposed and
measured*, not applied. Nothing in the PR that introduces this plan changes a
rendered pixel.

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
