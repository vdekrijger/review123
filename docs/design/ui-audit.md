# UI audit — Review 1-2-3 against the Refactoring UI rubric

Audited against [`refactoring-ui-principles.md`](./refactoring-ui-principles.md);
every finding cites the principle it violates and its page reference in
*Refactoring UI* v1.0.2. Rules added for this app are cited by their letter
(A1-A5, B1-B5, C1-C5, D1-D7) from the same file.

**Audited commit:** `ba573a1` · **Date:** 2026-09-23 · **Themes:** both

> This document changes nothing. It records what is there.

---

## How the evidence was gathered

Three independent sources, in decreasing order of authority:

1. **Computed styles from the running app.** A Playwright script drove the real
   dev server (`vite`, port 5199) through `/`, `/demo` (steps 1, 2 unified, 2
   side-by-side, 3) and `/settings/*` in **both** themes, walked every painted
   element and harvested its resolved `font-size`, `font-weight`, `line-height`,
   `color`, `background-color`, paddings, margins, gaps, radii, opacities and
   shadows — then measured specific geometry (toolbar gaps, label→input gaps,
   container widths). This is where the scale counts and the spacing measurements
   come from; they are what the browser actually computed, not what the source
   suggests.
2. **WCAG 2.1 contrast computed from the token values.** Relative luminance and
   contrast ratio, with alpha compositing for `rgba()` tints and for
   `opacity`-dimmed content (an `opacity` on text is arithmetically the same as
   blending the ink toward its ground, so the effective colour is computable).
   Every ratio quoted below is measured, not estimated. Full tables in
   [Appendix A](#appendix-a).
3. **Screenshots**, in [`./shots/`](./shots/) — 14 PNGs, both themes: landing,
   the three review steps, the diff viewer unified and side-by-side, the settings
   page, and the focus-mode / hunk-attention dimming. Downsampled deliberately:
   they exist to show a hierarchy or density problem at a glance, not to be read.
   Where a finding needs a number, the number is in the finding, not the picture.

The `/demo` route was used throughout — it needs no auth and no API key, and it
mounts the *real* display components with pre-generated output, so what was
measured is the production UI.

**Not gathered:** no live PR was reviewed (no key), so states that only occur
mid-run — streaming AI progress, partial results, error banners — were audited
from source rather than from a screenshot. Those findings are marked *(source
only)*.

---

## Summary — findings ranked by impact

| # | Finding | Rubric | Theme |
|---|---|---|---|
| [F1](#f1) | `--on-accent` is undefined; white-on-accent measures **2.47:1** in dark, 4.13:1 in light | p.142 | both |
| [F2](#f2) | Four different inks are used on the *same* accent fill; two of them fail | p.24-25, p.142 | both |
| [F3](#f3) | `--accent` fails as text in light (3.66-4.13:1) — and makes *selected* items less legible than unselected | p.142, p.30-31 | light |
| [F4](#f4) | `opacity: 0.45` recedes 26% harder in light; receded syntax falls to **1.83:1** | p.27-28, p.142, B5 | light |
| [F5](#f5) | The diff viewer ships GitHub's palette, not the app's — 3 dark greys, 2 greens, 2 reds, a second accent | p.124-128, A4, A5, B1 | both |
| [F6](#f6) | No type scale: **21 distinct font sizes** on one page, from 142 `em` declarations | p.88-93 | both |
| [F7](#f7) | No spacing scale: **40 distinct rem values**, adjacent steps 7-12% apart | p.60-63 | both |
| [F8](#f8) | The Inspect toolbar's gaps invert the grouping rule (4px inside a pair, 3px between unrelated controls) | p.83, p.86 | both |
| [F9](#f9) | Seven control rows before any content on Inspect; ten identical panels on Understand | p.30-31 | both |
| [F10](#f10) | No elevation scale — 8 bespoke shadows on 8 overlays, **none** on cards or the modal | p.158-161, p.206-209 | both |
| [F11](#f11) | Form controls have no perceivable boundary: **1.33:1** on white | WCAG 1.4.11, D5 | light |
| [F12](#f12) | Form labels outrank their own fields (15px/400 primary label, 13.5px value) | p.44, D3 | both |
| [F13](#f13) | The settings page exposes exactly **one** heading for six sections | p.46-47, D1 | both |
| [F14](#f14) | A browser-default blue link ships in production | p.193 | both |
| [F15](#f15) | Empty states are bare one-liners with no next step | p.203-205 | both |
| [F16](#f16) | The "changed" legend chip fails contrast in light only (4.45:1) | p.142 | light |
| [F17](#f17) | The light palette is duplicated verbatim in two blocks | structural | — |
| [F18](#f18) | Four font weights in use | p.34 | both |

**The shape of it:** dark mode is in good health — every text token clears AA
comfortably (Appendix A). Nearly every colour failure below is light-only, and
that is not a coincidence: the palette was authored against `#14161a` and
re-derived for light, so light inherited values that were never verified on
white. That is the case for the Phase 1 inversion in
[`ui-refactor-plan.md`](./ui-refactor-plan.md).

---

## Colour and contrast

<a id="f1"></a>

### F1 — `--on-accent` is undefined, and its fallback fails in both themes

`--on-accent` is **never declared** anywhere in the codebase. Six call sites
reference it with a white fallback, painted on an `--accent` fill:

- `src/components/settings/ModelCombobox.svelte:511, 528, 586, 609`
- `src/components/settings/AiModelsSection.svelte:1029, 1162`

```css
.mode-option.selected {
  background: var(--accent);
  color: var(--on-accent, #fff);   /* --on-accent is never defined */
}
```

So every one of these resolves to `#ffffff`:

| theme | fill | ink | measured | 4.5 floor |
|---|---|---|---|---|
| dark | `#4db6a0` | `#ffffff` | **2.47:1** | **FAIL** (also below the 3:1 large-text floor) |
| light | `#2e8b78` | `#ffffff` | **4.13:1** | **FAIL** |

Violates p.142. Worth stating plainly: the common assumption that this "happens
to be readable" is false — in **dark** mode, where the app spends most of its
life, it is the worst contrast measurement in the entire audit at 2.47:1. These
are the AI-models mode segmented control and the model-combobox's selected lab
row, i.e. live, frequently-used controls.

Defining `--on-accent` is therefore not merely a prerequisite for a light-first
palette — it is an outstanding contrast bug in the palette that exists today.

<a id="f2"></a>

### F2 — four different inks on the same accent fill

There is no single answer in this codebase to "what colour is text on the accent":

| # | mechanism | value | where |
|---|---|---|---|
| 1 | hardcoded literal | `#0a1410` | `src/app.css:283` (`.btn-primary`) |
| 2 | hardcoded literal | `#0a1410` | `src/routes/Landing.svelte:762` (`.demo-cta-btn:hover`) |
| 3 | `var(--accent-contrast)` | `#0a1410` dark / `#ffffff` light | `src/app.css:17, 132, 169`; used at `src/app.css:391` (checkbox tick) and `src/components/AgentFixPanel.svelte:602` |
| 4 | `var(--on-accent, #fff)` | `#ffffff` always | the six sites in [F1](#f1) |

In **light** mode this means the identical `#2e8b78` fill carries `#0a1410` on the
primary button (4.53:1, passes) and `#ffffff` on the checkbox tick and the
segmented controls (4.13:1, fails) — on the same screen. Violates p.24-25 (never
hand-pick one-off values; choose from a system) and p.142.

Two token names exist for one role (`--accent-contrast`, `--on-accent`), one of
them undefined, and two components bypass both with a literal.

<a id="f3"></a>

### F3 — `--accent` is not a legal text colour in light mode

| ground | measured | 4.5 floor |
|---|---|---|
| `--surface` `#ffffff` | **4.13:1** | FAIL |
| `--bg` `#faf8f4` | **3.90:1** | FAIL |
| `--surface-raised` `#f4f1ea` | **3.66:1** | FAIL |
| `--accent-subtle` over `--bg` (`#e6ede8`) | **3.47:1** | FAIL |

Dark mode passes everywhere (6.16-7.34:1). Where this lands in light:

- **The landing page's secondary CTA.** `src/routes/Landing.svelte:750-756` —
  `.demo-cta-btn { background: transparent; color: var(--accent) }` on the page
  ground: **3.90:1**. This is the primary onboarding path for a cold-start
  visitor. See [`shots/landing-light.png`](./shots/landing-light.png).
- **The Inspect toolbar's active toggles** (`Focus: imports`, `Hunk focus: on`) —
  accent text on `--surface-raised`: **3.66:1**.
- **The settings nav — with the emphasis inverted.** `src/routes/SettingsPage.svelte:238-241`:

  ```css
  .nav-link          { color: var(--text-muted); }      /* inactive */
  .nav-link.active   { color: var(--accent); background: var(--accent-subtle); }
  ```

  | state | measured (light) |
  |---|---|
  | **active** (accent on the subtle tint) | **3.47:1** |
  | inactive (`--text-muted` on `--bg`) | 5.08:1 |

  The *selected* section is the least legible item in the nav — 1.46× worse than
  the five items it is meant to stand out from. This violates p.142 and p.30-31
  simultaneously: it is not that the active item fails to stand out, it is that
  the hierarchy runs backwards. (Dark: 6.09 active vs 6.27 inactive — level, and
  both pass.) Visible in [`shots/settings-models-light.png`](./shots/settings-models-light.png).

<a id="f4"></a>

### F4 — `opacity: 0.45` was tuned on a dark ground and is 26% harsher on white

The same `0.45` recedes content for **two** different features, by design — one
visual language, as the source comments say:

- `src/components/FileDiff.svelte:1685` — focus mode (`.dimmed-noise`: imports,
  comments, whole generated files)
- `src/components/FileDiff.svelte:1704` — per-hunk attention (`.hunk-receded`:
  mechanical hunks, PR #241)

It is also the disabled-state opacity at `src/app.css:276` (`.btn:disabled`),
`:345` (`select:disabled`) and `:430` (checkbox/radio `:disabled`), plus eight
further literal `0.45`s across `SkillsSection`, `BridgeSection`,
`AiModelsSection`, `AskBox`, `GroundingIndicator` and `CommentThread`. Thirteen
occurrences of a bare literal, for a recurring dimension the rubric says to
systematise (p.27-28).

Measured on the diff's **real** grounds (the values the viewer actually paints,
not `--surface`):

| ground | dark @0.45 | light @0.45 | Δ |
|---|---|---|---|
| context line | **4.53:1** (passes AA) | **3.35:1** (fails AA) | −26% |
| added line | 4.29:1 | 3.30:1 | −23% |
| removed line | 4.44:1 | 3.28:1 | −26% |

Dark keeps receded code above the AA floor; light drops it below. Worse, opacity
dims the *syntax colours* too, and those collapse much further in light:

| token | dark @0.45 | light @0.45 |
|---|---|---|
| comment | 2.18:1 | **1.83:1** |
| keyword | 2.39:1 | **1.97:1** |
| type/title | 2.85:1 | 2.09:1 |
| number | 2.86:1 | 2.12:1 |

Visible in [`shots/focus-dim-light.png`](./shots/focus-dim-light.png) — the
`import type { Result } from './types'` row and the `/** Optional signal … */`
comment wash out to pastel while their dark-mode counterparts stay readable.

These are the fastest-scanned surfaces in the product, so the cost of getting
this wrong is high. Two separate problems are stacked here, and they need
separate answers (both in [the plan](./ui-refactor-plan.md#p1-4)):

1. **The alpha is theme-dependent.** Parity with dark's 4.53:1 needs **0.55** in
   light (measured: 0.54 gives 4.55:1; 0.55 gives 4.76:1 on context, 4.64:1 on
   added, 4.60:1 on removed — all above AA).
2. **Alpha is the wrong tool over coloured text** (rubric B5). Even at 0.70 the
   light comment token only reaches 2.74:1, because opacity collapses every hue
   toward the ground at once. No alpha that still reads as "receded" can hold 3:1
   for coloured syntax.

<a id="f5"></a>

### F5 — the diff viewer ships GitHub's palette, not the app's

The densest surface in the product draws almost none of its colour from the app's
tokens. Harvested from the live DOM:

| role | diff viewer paints | the app's token | same? |
|---|---|---|---|
| context ground (dark) | `#0d1117` | `--surface` `#1b1e24` | **no** — and `--bg` is a third grey, `#14161a` |
| body ink (dark) | `#ffffff` (278 elements) | `--text` `#e8e6e1` | **no** |
| body ink (light) | `#000000` (200 elements) | `--text` `#1f2328` | **no** |
| added ground (light) | `#dafbe1` | `--legend-added-bg` `#dcffe4` | **no** — two greens for one meaning |
| removed ground (light) | `#ffebe9` | `--legend-removed-bg` `#ffe5e5` | **no** — two reds for one meaning |
| add-comment widget | `#0969da` (78 instances) | `--accent` `#2e8b78` | **no** — a second, unrelated accent |
| syntax set | GitHub light/dark themes | — | not tokenised at all |

Violates p.124-128 (build *one* palette; never generate colours ad hoc) and
rubric A5 (a third-party viewer that ships its own palette is a palette fork).
In dark mode three unrelated dark greys — `#14161a`, `#1b1e24`, `#0d1117` — meet
within a few pixels of each other.

The syntax set also breaks rubric A4 (every token must clear 4.5:1 on *every*
ground it can land on). Measured in light:

| token | on context `#ffffff` | on added `#dafbe1` |
|---|---|---|
| keyword `#d73a49` | 4.57:1 | **4.11:1 FAIL** |
| comment `#6a737d` | 4.82:1 | **4.33:1 FAIL** |
| built-in `#e36209` | **3.49:1 FAIL** | **3.14:1 FAIL** |

Dark passes on every ground (5.06-12.31:1). The added/removed tints are light
enough in dark mode to leave the ink alone; in light they eat the margin that
was never there.

This is why the diff viewer is sequenced **last** in the plan: it is a pnpm-patched
dependency (`patches/@git-diff-view__svelte.patch`), it carries the dimming from
[F4](#f4), and re-pointing its palette touches every colour decision the other
phases make.

<a id="f16"></a>

### F16 — the "changed" legend chip fails in light only

`src/app.css:150-152` — `--legend-changed-color: #9a6700` on
`--legend-changed-bg: #fff5cc` measures **4.45:1**, just under the 4.5 floor
(p.142). Its dark counterpart is 8.14:1. The neighbouring chips pass narrowly:
added 4.71:1, removed 4.59:1, unchanged 5.04:1 — the whole light chip set sits on
the edge, which is the signature of values derived rather than verified.

`#8f5f00` on the same tint measures 5.04:1 and reads as the same colour.

---

## Hierarchy and emphasis

<a id="f9"></a>

### F9 — everything at equal emphasis on both content steps

**Inspect (step 2).** Measured vertical positions at 1440×1000 —
seven control rows, ~250px of chrome, before the first line of content:

| y | row |
|---|---|
| 150 | stepper (`1 · Understand` / `2 · Inspect` / `3 · Verdict`) |
| 192 | `Story` / `Files` |
| 222 | `Unified` / `Side-by-side` / `Hide whitespace` / `Focus: imports` / `Hunk focus: on` |
| 258 | four reviewer chips |
| 288 | "Showing 1 of 2 findings…" + `Show all` |
| 324 | `Implementation 5` / `Tests 1` + phase note + verdict chip |
| 372 | `Narrative` / `Risk first` + "0 of 5 attention files reviewed" |
| **402** | **first file header** |

Every row is the same height, weight and colour family; nothing ranks them.
Violates p.30-31 (no screen presents everything at equal emphasis) and p.52-53
(rank by importance, not semantics). The fix the rubric prescribes is to
de-emphasise the secondary rows, not to enlarge anything (p.30-31, p.39-40).
See [`shots/step2-inspect-unified-light.png`](./shots/step2-inspect-unified-light.png).

**Understand (step 1).** Ten collapsed `<details>` panels — `FULL SUMMARY`,
`INTENT CHECK (AI)`, `EXPECTED OUTCOMES (AI)`, `CHANGE IMPACT`,
`CHANGED FILES — STRUCTURE`, `TEST COVERAGE (AI-INFERRED)`,
`ALTERNATIVE APPROACHES (AI)`, `WHY THIS VERDICT`, `CI DETAILS`,
`ORIGINAL PR DESCRIPTION` — identical in size, weight, border, background and
spacing. Nothing signals which to open first, and the one genuinely primary line
on the page ("This PR fixes a race condition in the search box.") sits above them
at a similar weight. Violates p.30-31; the ten identical borders also violate
p.206-209. See [`shots/step1-understand-light.png`](./shots/step1-understand-light.png).

*Positive:* the panel titles themselves are correctly handled — `src/app.css:479-493`
styles `details > summary` as muted, uppercase, tracked support so the content
leads (p.47), and the landing page ranks its actions textbook-correctly
([F-positives](#what-passes)).

<a id="f18"></a>

### F18 — four font weights

400, 500, 600 and 700 all appear on every surface measured (settings: 400×232,
500×9, 600×44, 700×20). p.34 asks for two — a body weight and an emphasis
weight. The 500/600 pair in particular does almost no perceptual work at the
sizes in use, while costing a decision at every call site.

---

## Type and spacing scales

<a id="f6"></a>

### F6 — no type scale: 21 distinct sizes on a single page

`src/app.css:51` sets `:root { font-size: 15px }`. Components then size text in
**`em`**, which compounds through every nesting level — exactly what p.92-93
forbids ("define sizes in px or rem, never em — nested em compounds into values
that aren't on the scale at all").

Repo-wide count of `font-size` declarations in `src/**/*.svelte`:

| unit | declarations | distinct values |
|---|---|---|
| **`em`** | **142** | 16 (`0.68, 0.7, 0.74, 0.75, 0.76, 0.78, 0.8, 0.82, 0.84, 0.85, 0.88, 0.9, 0.92, 0.95, 1, 1.1em`) |
| `rem` | 439 | — |
| `px` | 7 | — |

What the browser computes on `/settings/models` — **21 distinct sizes**:

```
9.72  10.2  10.56  10.8  11.1  11.22  11.25  11.4  11.475  11.7  12
12.1125  12.15  12.3  12.75  13.125  13.2  13.5  14.25  15  21 px
```

`12.1125px` and `11.475px` are not roundings — they are three levels of `em`
multiplied together. The rubric's reference scale has 11 values for an entire
product; this page has 21, none of which a designer chose. `/demo` step 1 shows
20; step 2 shows 17. **21 distinct `line-height` values** accompany them.

Violates p.88 (fix the scale up front), p.89-90 (a UI where every size between 10
and 24px appears somewhere is inconsistent and slow to work in) and p.92-93.

<a id="f7"></a>

### F7 — no spacing scale: 40 distinct values, steps of 7-12%

**1,221** `padding` / `margin` / `gap` declarations across `src/`, using **40
distinct `rem` values**. p.61-62 requires adjacent values to differ by roughly
25% or more, or the choice stays arbitrary. Measured (at the 15px root):

| step | px | Δ |
|---|---|---|
| `0.4rem` → `0.45rem` | 6 → 6.75 | +12.5% |
| `0.45rem` → `0.5rem` | 6.75 → 7.5 | +11.1% |
| `0.5rem` → `0.55rem` | 7.5 → 8.25 | +10.0% |
| `0.55rem` → `0.6rem` | 8.25 → 9 | +9.1% |
| `0.6rem` → `0.65rem` | 9 → 9.75 | +8.3% |
| `0.65rem` → `0.7rem` | 9.75 → 10.5 | +7.7% |
| `0.7rem` → `0.75rem` | 10.5 → 11.25 | +7.1% |

No step in the busiest part of the range reaches half the required minimum. There
are also true one-offs, used once or twice each — `0.02`, `0.12`, `0.22`, `0.28`,
`0.32`, `0.38`, `1.4`, `1.7`, `1.75`, `2.1rem` — which is the "never hand-pick
one-off values" rule (p.24-25) and "never nudge sizes 1px at a time" (p.60).

Because the root is 15px rather than 16px, most of these land on non-integer
pixels (`0.45rem` = 6.75px, `0.85rem` = 12.75px), so even the `rem`-based values
are off any grid. The computed harvest confirms it: 25 distinct padding values on
the settings page, including `0.57px`, `0.605625px` and `3.63375px` — em-derived
paddings inside em-sized text.

<a id="f8"></a>

### F8 — the Inspect toolbar's spacing inverts the grouping rule

`src/components/InspectStep.svelte:1640-1641` renders `Unified` and
`Side-by-side` as one mutually-exclusive view-mode control; `Hide whitespace`,
`Focus: imports` and `Hunk focus: on` are three independent toggles. All five are
identical `.btn` elements in one row. Measured horizontal gaps in the rendered
row:

| between | gap | relationship |
|---|---|---|
| `Unified` ↔ `Side-by-side` | **4px** | *same control* |
| `Side-by-side` ↔ `Hide whitespace` | **3px** | unrelated |
| `Hide whitespace` ↔ `Focus: imports` | **3px** | unrelated |
| `Focus: imports` ↔ `Hunk focus: on` | **3px** | unrelated |

The space *inside* the group (4px) is larger than the space *between* unrelated
groups (3px) — the relationship is inverted, which is precisely what p.83 and
p.86 forbid ("the space around a group must always exceed the space inside it").
At these magnitudes the row reads as five peer buttons, so a reader cannot tell
that the first two are one choice. Compounding it, all five carry equal visual
weight despite two of them being a mode selector and three being toggles (p.52-53).

---

## Depth and elevation

<a id="f10"></a>

### F10 — no elevation scale; separation is borders-only; the hairline is invisible

**There is no scale.** 16 non-focus-ring `box-shadow` declarations exist, with
**8 distinct hand-picked values** — effectively one bespoke shadow per component:

| value | component |
|---|---|
| `0 4px 14px rgba(0,0,0,.25)` | `CommentEditor.svelte:389` |
| `0 4px 14px rgba(0,0,0,.18)` | `CommentThread.svelte:305` |
| `0 10px 30px rgba(0,0,0,.28)` | `ModelCombobox.svelte:440`, `VerdictStep.svelte:1259` |
| `-4px 0 16px rgba(0,0,0,.4)` | `ContextRail.svelte:313` |
| `-8px 0 24px rgba(0,0,0,.35)` | `PreviewPanel.svelte:160` |
| `-2px 4px 20px rgba(0,0,0,.22)` | `InspectStep.svelte:2392` |
| `0 4px 20px rgba(0,0,0,.22)` | `InspectStep.svelte:2959` |
| `0 8px 28px rgba(0,0,0,.25)` | `SymbolPopover.svelte:394` |

p.160-161 asks for a fixed scale of about five shadows, chosen by purpose. Here
elevation is a per-component improvisation. Every alpha (0.18-0.40 black) was
picked against the dark ground; on a white page those same values read
considerably heavier.

**Cards and the modal have no elevation at all.** `src/app.css:452-457` (`.card`)
and `src/app.css:517-525` (`dialog`) declare background, border and radius — no
shadow. A modal dialog with no shadow is exactly the case p.159-160 names
("large for modals"), and it is the one place the book treats as non-negotiable.

**And the only separator is near-invisible.** Separation throughout the app is a
1px `--hairline` border. Measured:

| ground | light `#e3dfd6` | dark `#2e333b` |
|---|---|---|
| on `--surface` | **1.33:1** | 1.31:1 |
| on `--bg` | **1.25:1** | 1.43:1 |
| on `--surface-raised` | **1.18:1** | 1.19:1 |

So the app leans on a single separation mechanism (p.206 warns against reaching
for a border every time), declines the three alternatives the book offers —
shadow (p.207), a background-colour shift (p.208), more space (p.209) — and the
one mechanism it does use is below the threshold of comfortable perception. On
the settings page this produces long runs of bordered boxes that read as a grey
mass rather than as sections. See [`shots/settings-models-light.png`](./shots/settings-models-light.png).

There is also no use of the flat-design depth cue (p.167-168, rubric quick-scan
11): `--surface` (#ffffff) is lighter than `--bg` (#faf8f4) in light, which is
correct, but `--surface-raised` (#f4f1ea) is *darker* than both while being used
for raised things like `.btn` — the name and the optical direction disagree.

---

## Form design

<a id="f11"></a>

### F11 — form controls have no perceivable boundary

`src/app.css:306-317` gives every `input`, `textarea` and `select` a
`1px solid var(--hairline)` border. Measured against the ground they sit on:

| theme | border on `--surface` |
|---|---|
| light | **1.33:1** |
| dark | 1.31:1 |

WCAG 2.1 SC 1.4.11 (non-text contrast) requires **3:1** for the visual boundary of
a control — the non-text companion to p.142, recorded as rubric D5. A hairline
tuned for decorative separation is not automatically a usable control boundary,
and here one token serves both roles.

This is the reason the settings screenshots read as floating text: the fields are
there, but their edges are at the limit of perception. No warm grey light enough
to work as a decorative hairline reaches 3:1 — the roles genuinely need two
tokens (measured ramp in [Appendix A](#appendix-a)).

<a id="f12"></a>

### F12 — labels outrank the fields they label

The settings form pattern wraps the control in its label
(`src/components/settings/ProvidersSection.svelte:199-225`, and the same shape in
`AiModelsSection`, `BridgeSection`):

```svelte
<label>GitHub token (PAT)
  <input type="password" … />
</label>
```

Measured on `/settings/models`:

| | computed |
|---|---|
| label text | **15px / weight 400 / `#1f2328`** (full-strength primary ink) |
| the input's own text | **13.5px** |

The label is larger than, and exactly as dark as, the value it labels. p.44 is
explicit that a label needed for scanning must be styled as *support* — smaller,
softer, lighter — with the data dominating; the inversion is only correct on
spec-sheet pages where users scan for the label itself (p.44-45), which a
credentials form is not. Recorded as rubric D3.

Measured stacked-field gaps (p.84 — label→input must be strictly smaller than
input→next field):

| field | label→input | input→next field | |
|---|---|---|---|
| `DeepSeek model` | 3.7px | 7.5px | direction correct, both far too tight |
| `DeepSeek API key` | **0px** | 119.5px | label touches its input |
| `OpenAI model` | 3.7px | 7.5px | |
| `Gemini API key` | **0px** | 177.4px | |

The direction is right, but a 3.7px vs 7.5px pair does not communicate grouping
at a glance (p.83), and a 0px label→input gap leaves the label visually fused to
its field.

<a id="f13"></a>

### F13 — six sections, one heading

The entire `/settings` page exposes exactly one heading element to the document
outline: `<h1>Settings</h1>`. The six section titles — *Appearance*,
*Providers & access*, *Local bridge*, *AI models*, *Standing rules*,
*Reviewer skills* — are paragraphs:

```svelte
<!-- src/components/settings/ProvidersSection.svelte:154 -->
<p class="section-label">Providers &amp; access</p>
```

p.46-47 says to choose heading tags for *semantics* and then style them for the
visual hierarchy you want — including styling them small. What happened here is
the opposite: the visual treatment was chosen and the semantics dropped. A ~6,000px
page with six top-level sections has no navigable outline (rubric D1), and the
nav on the left is the only structure a reader gets.

Sub-section titles inside `AI models` ("What runs (and how deep)", "Model panel")
are likewise non-headings.

<a id="f14"></a>

### F14 — a browser-default blue link in production

`src/components/settings/AiModelsSection.svelte:481`:

```svelte
No bridge paired yet. Set one up in <a href="#bridge">Local bridge</a> below.
```

This anchor has no styling rule in the component, so it renders in the UA default:
**`#0000EE`** in light mode, `#9e9eff` in dark. Confirmed from computed styles —
it is the single element on the page whose colour is in neither palette. The
identical construction at
`src/components/settings/StandingRulesSection.svelte:385` has the same problem.
Meanwhile `BridgeSection`'s links render correctly as `--text-muted` + underline.

Violates p.193 (give in-body links real styling) and the rubric quick-scan's
"no browser-default blue anywhere". It also lands a saturated blue next to a teal
accent, which is the only place in the app where two unrelated hues compete —
except the diff viewer's `#0969da`, [F5](#f5).

---

## Empty and loading states

<a id="f15"></a>

### F15 — empty states are bare one-liners

Every empty state found is a single sentence with no icon, no illustration and no
call to action, with the surrounding toolbars left in place:

| location | copy |
|---|---|
| `src/components/CommentEditor.svelte:277` | "Nothing to preview." |
| `src/components/DiagramPanel.svelte:472, 490, 512, 530` | "No structural changes detected." (×4) |
| `src/components/VerdictStep.svelte:646` | "No line comments drafted yet. You can still leave an overall comment below." |
| `src/components/PreviewPanel.svelte:130` | "Nothing to show here yet." |

p.203-204 is unusually direct that this is a failure: the empty state is a
priority, not an afterthought, and needs an image or icon plus an emphasised next
step. p.205 adds that supporting UI (tabs, filters, toolbars) should be hidden
while the surface is empty, since none of it does anything yet — here the
diagram panel's controls and the comment editor's toolbar remain.

The `VerdictStep` line is the best of them: it states the situation *and* the
next step. It still has no visual treatment.

### Loading states — mostly a pass *(source only)*

`src/components/Skeleton.svelte` is genuinely good and worth protecting: three
content-shaped variants (`text` with varying line widths, `block`, `cards`)
chosen per section, so the placeholder matches the eventual layout rather than
spinning. That satisfies rubric C1 and C5.

Two gaps, from source:

- **C2/C3 not verified.** Whether a pending section is de-emphasised relative to
  finished content, and whether progress chrome drops to tertiary once partial
  results exist, could not be observed — the demo route ships every panel already
  `done`, and no live run was possible without a key. `AiProgress.svelte`,
  `ReviewProgress.svelte` and `GroundingIndicator.svelte` are the surfaces to
  check during Phase 2.
- **C4 is handled.** Off / skipped tasks carry an explicit `OFF` label rather than
  colour alone (visible on step 1), which satisfies p.146-147.

---

## Density of the review surfaces

Density here is legitimate — this is an information-heavy tool, and p.59 permits
a dense layout *as a deliberate decision*. The finding is that it is not
deliberate, and not consistent.

- **The diff body is correctly dense** and correctly grouped: gutter, line number,
  `+`/`-` marker and content read as one row (rubric A3), and status is carried by
  the marker *and* the line-number column, not by background colour alone
  (rubric B2 / p.146-147). This is the best-executed surface in the app.
- **The chrome around it is dense by inheritance, not by choice** — the seven
  control rows of [F9](#f9) are compressed to 3-4px gaps ([F8](#f8)) with no
  grouping, which is what makes step 2 feel busy. The content is not the problem;
  the 250px of undifferentiated toolbar above it is.
- **Side-by-side mode** ([`shots/step2-inspect-split-light.png`](./shots/step2-inspect-split-light.png))
  inherits the same padding as unified at half the column width, so each pane's
  code sits tighter against its gutter. The density decision was made once, for
  unified, and side-by-side took it unchanged.
- **Settings is dense without cause.** It is a 663px column in a 1440px viewport
  running ~6,000px tall, with 13.5px controls and 7.5px gaps between fields
  ([F12](#f12)). p.71 is the applicable rule — don't cram content into a small
  area to look compact; take the space when the content needs it. There is
  horizontal room here that is not being used.
- **Prose is handled correctly.** `src/app.css:235-241` caps `.prose` at `72ch`,
  inside the 45-75 character target (p.99-100), and code is correctly exempt from
  that cap (rubric A2).

---

<a id="what-passes"></a>

## What passes

Recorded honestly, because a refactor should not break these:

- **The landing page ranks its actions correctly** (p.52-53): one solid primary
  (`Review`), one outline secondary (`Try a live demo`), tertiary links below,
  with supporting copy in muted text. Structurally textbook — only the secondary
  CTA's contrast fails ([F3](#f3)).
- **Dark mode contrast is good.** Every text token clears AA with margin
  (5.25-14.52:1); the legend chips clear on their own tints (5.25-8.14:1); banner
  and draft surfaces clear at 9.65:1 and 11.62:1.
- **Status is never colour alone** in the diff or on step 1 — markers, labels and
  `OFF` badges carry it (p.146-147).
- **Custom checkbox and radio controls** (`src/app.css:356-446`) are token-styled
  rather than native-blue (p.194), with a `forced-colors` escape hatch that hands
  back to the OS — a thoughtful touch the book doesn't cover.
- **`details > summary`** (`src/app.css:479-493`) is styled as quiet uppercase
  support with `0.04em` tracking, so section titles act as labels and the content
  leads (p.47, p.117 — which suggests ~0.05em; 0.04 is within tolerance).
- **`Skeleton.svelte`** — content-shaped loading per section (rubric C1).
- **Prose width** capped at 72ch (p.99-100).
- **The diff's row grouping and status redundancy** (rubric A3, B2).

---

## Bugs and hazards found while auditing — recorded, not fixed

Per this pass's scope, nothing below was changed.

1. **`--on-accent` is undefined** ([F1](#f1)) — a live 2.47:1 contrast failure in
   dark mode, not merely a light-mode prerequisite. **Highest-priority repair.**
2. **A browser-default blue link ships in production** ([F14](#f14)) —
   `AiModelsSection.svelte:481`, `StandingRulesSection.svelte:385`.
3. **The light palette is duplicated verbatim** <a id="f17"></a> — `src/app.css:123-156`
   and `src/app.css:159-194` contain **30 byte-identical declarations**. Verified
   identical by diff. Any token added to one block and not the other will silently
   diverge between an explicit `data-theme="light"` and the `auto` +
   `prefers-color-scheme: light` path — the two ways a user can arrive at the same
   palette. This is the single most likely way Phase 1 goes wrong, so it is the
   first item in the plan. *(Not a rubric finding; a structural hazard.)*
4. **`--surface-raised` is darker than `--surface` and `--bg` in light** while
   being used for raised elements (`.btn`, `--surface-overlay`). The optical
   direction contradicts the name and p.167-168. Worth resolving during Phase 1
   naming rather than carrying the confusion forward.
5. **`.btn-primary` and `.demo-cta-btn:hover` hardcode `#0a1410`**
   (`src/app.css:283`, `src/routes/Landing.svelte:762`) rather than referencing any
   token, so they will not follow a palette change at all.
6. **13 bare `opacity: 0.45` literals** for what are three distinct semantic states
   (receded content, disabled control, de-emphasised chrome) — they cannot be
   tuned independently today ([F4](#f4)).

---

<a id="appendix-a"></a>

## Appendix A — measured contrast tables

WCAG 2.1 relative luminance; `rgba()` tints and `opacity` values composited over
their real ground before measuring. Floors: **4.5:1** normal text, **3:1** large
text and non-text UI boundaries (p.142, SC 1.4.11).

### A.1 Core tokens

| pair | dark | light |
|---|---|---|
| `--text` on `--bg` | 14.52 | 14.89 |
| `--text` on `--surface` | 13.39 | 15.80 |
| `--text` on `--surface-raised` | 12.17 | 14.00 |
| `--text-muted` on `--bg` | 6.27 | 5.08 |
| `--text-muted` on `--surface` | 5.78 | 5.39 |
| `--text-muted` on `--surface-raised` | 5.25 | 4.78 |
| `--accent` as text on `--bg` | 7.34 | **3.90 FAIL** |
| `--accent` as text on `--surface` | 6.77 | **4.13 FAIL** |
| `--accent` as text on `--surface-raised` | 6.16 | **3.66 FAIL** |
| `--accent` on `--accent-subtle` | 5.55 | **3.47 FAIL** |
| `--hairline` on `--surface` (3:1 floor) | **1.31 FAIL** | **1.33 FAIL** |
| `--hairline` on `--bg` (3:1 floor) | **1.43 FAIL** | **1.25 FAIL** |

### A.2 Ink on the accent fill

| ink | dark (`#4db6a0`) | light (`#2e8b78`) |
|---|---|---|
| `#0a1410` (hardcoded `.btn-primary`) | 7.60 | 4.53 |
| `var(--accent-contrast)` | 7.60 | **4.13 FAIL** |
| `var(--on-accent, #fff)` — **undefined** | **2.47 FAIL** | **4.13 FAIL** |

### A.3 Status chips on their own tint

| chip | dark | light |
|---|---|---|
| added | 6.87 | 4.71 |
| removed | 6.98 | 4.59 |
| changed | 8.14 | **4.45 FAIL** |
| unchanged | 5.25 | 5.04 |

### A.4 `opacity: 0.45` on the diff's real grounds

| ground | dark | light |
|---|---|---|
| context line | 4.53 | **3.35** |
| added line | **4.29** | **3.30** |
| removed line | **4.44** | **3.28** |
| comment token | **2.18** | **1.83** |
| keyword token | **2.39** | **1.97** |

Alpha required in light for parity with dark's 4.53:1 → **0.54**; at **0.55**:
context 4.76, added 4.64, removed 4.60.

### A.5 Syntax tokens (rubric A4)

| token | light on `#ffffff` | light on `#dafbe1` | dark on `#0d1117` | dark on `#18271f` |
|---|---|---|---|---|
| keyword | 4.57 | **4.11 FAIL** | 7.51 | 6.17 |
| string | 13.23 | 11.89 | 12.31 | 10.13 |
| type/title | 6.51 | 5.85 | 9.72 | 8.00 |
| number | 6.29 | 5.65 | 9.73 | 8.00 |
| built-in | **3.49 FAIL** | **3.14 FAIL** | 9.77 | 8.04 |
| comment | 4.82 | **4.33 FAIL** | 6.15 | 5.06 |

### A.6 Ramps measured for the plan's proposals

**Warm grey, for a control boundary (3:1 floor, light):**

| value | on `#ffffff` | on `#faf8f4` |
|---|---|---|
| `#e3dfd6` *(today)* | 1.33 | 1.25 |
| `#c9c3b6` | 1.76 | 1.65 |
| `#a39a89` | 2.78 | 2.63 |
| `#948a78` | 3.41 | 3.21 |
| **`#8d8370`** | **3.74** | **3.53** |

No warm grey light enough to read as a decorative hairline reaches 3:1 — the
decorative and control-boundary roles need two separate tokens.

**Light accent candidates (must work as text on white *and* carry an ink):**

| value | as text on `#ffffff` | on `#faf8f4` | white on it | `#0a1410` on it |
|---|---|---|---|---|
| `#2e8b78` *(today)* | **4.13** | **3.90** | **4.13** | 4.53 |
| `#24806c` | 4.80 | 4.52 | 4.80 | **3.91** |
| **`#1f7a66`** | **5.21** | **4.91** | **5.21** | 3.60 |
| `#176b59` | 6.40 | 6.03 | 6.40 | 2.93 |

`#1f7a66` is the only candidate that clears 4.5:1 with margin both as text on the
light grounds **and** as a fill carrying white — it fixes [F3](#f3) and
[F1](#f1) with one value.

---

## Appendix B — reproducing these numbers

The harvest and contrast scripts were run from a scratch directory and are not
committed (they are throwaway measurement tools, not project code). To reproduce:

1. `pnpm install && pnpm dev`
2. Drive `/`, `/demo` and `/settings/*` with Playwright in both themes, setting
   `localStorage['review123:settings'] = '{"theme":"light"}'` (or `"dark"`) in an
   init script, and walk `document.querySelectorAll('body *')` collecting
   `getComputedStyle` values.
3. Compute WCAG ratios from the collected colours, compositing `rgba()` and
   `opacity` over the element's real background first.

The plan proposes making step 3 permanent as a unit test
([`ui-refactor-plan.md` §P1-6](./ui-refactor-plan.md#p1-6)), so these ratios stop
being a one-off audit and become a gate.
