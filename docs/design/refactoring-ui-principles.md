# Refactoring UI — principles checklist (Review 1-2-3's rubric)

A working rubric for auditing this app — the landing page, the three review steps
(Understand / Inspect / Verdict), the diff viewer, the context rail, and a settings
page with six long sections.

Every bullet is phrased as a check that can be answered **pass / fail / n.a.** against
a real screen. Page numbers point back to *Refactoring UI* v1.0.2 by Adam Wathan &
Steve Schoger so any rule can be traced to its source.

**Provenance.** This file is adapted from the sister project's committed distillation
at `churchfamily/docs/design/refactoring-ui-principles.md` — their own paraphrase of
the book, written in their words, not copied text. It has been re-cut for this app:
rules about photography, user-uploaded imagery and avatar treatment are dropped
(§"What does not apply"), and four sections are added for the things this app has and
they do not — dense code surfaces, diff rendering, long-running async state, and a
settings page with many sections. No text is reproduced from the book, and the book
itself is a purchased copy that is deliberately not committed anywhere in this repo.

---

## Starting from Scratch

- Design a concrete feature before deciding shell, nav or container width — the shell follows from real features (p.7-9).
- Sketch in low fidelity first; don't settle typefaces, shadows or icons at idea stage (p.10).
- Design in greyscale first so spacing, size and contrast carry the hierarchy; colour is enhancement, not the fix (p.10-11).
- Never imply functionality you are not shipping now — ship the smallest genuinely useful version (p.15-16).
- Every surface carries a personality; decide it deliberately via font, colour, radius and tone of voice (p.17, p.19-23).
- Pick a border-radius stance and hold it: small = neutral, large = playful, none = formal — never mix square and rounded corners in one interface (p.21-22).
- **Never hand-pick one-off values** (12px vs 13px, 10% vs 15% opacity): choose from a pre-defined system so every decision is a short list (p.24-25).
- Pick a candidate value, then compare against its neighbours on the scale; if an outer value wins, re-centre and compare again (p.26-27).
- Systematise every recurring dimension: font size, weight, line height, colour, margin, padding, width, height, shadow, radius, border width, **opacity** (p.27-28).

## Hierarchy is Everything

- No screen presents everything at equal emphasis; rank primary, secondary and tertiary on every surface (p.30-31).
- Fix a noisy screen by de-emphasising the secondary, not by enlarging the important (p.30-31).
- Don't lean on font size alone for hierarchy — it yields oversized primaries and unreadably small secondaries (p.32).
- Use weight and colour to promote: a bolder 24px title beats a thin 30px one (p.32-33).
- **Limit text colours to three**: dark for primary, grey for secondary, lighter grey for tertiary (p.34).
- **Limit UI font weights to two**: normal (400/500) for body, heavier (600/700) for emphasis (p.34).
- Never use weights below 400 for UI text; de-emphasise with a lighter colour or smaller size (p.34-35).
- Secondary text on a coloured background must be a hand-picked shade of that background's hue — never grey, never white-at-reduced-opacity (p.36-38).
- When an element won't stand out, soften its competitors instead of shouting louder (p.39-40).
- Don't render fields as "Label: value" rows — that flattens all hierarchy (p.41).
- Drop the label when format or context already identifies the value (p.41-42); fold it into the value when it can't be dropped (p.42-43).
- When a label is genuinely needed for scanning, **style it as support — smaller, softer, lighter — and let the data dominate** (p.44). Invert only on spec-sheet pages where users scan for the label itself (p.44-45).
- Choose heading tags for semantics, then style them for the visual hierarchy you actually want (p.46-47). Section titles usually act as labels: keep them modest so the content leads (p.47).
- Balance icon weight against text: lower an icon's contrast so it doesn't outrank its label (p.48-49).
- When a 1px border is too faint but a darker colour looks harsh, thicken to 2px and keep the soft colour (p.50-51).
- **Rank actions by importance, not by semantics**: one obvious primary (solid, high contrast), quiet secondaries (outline / low-contrast fill), link-styled tertiaries (p.52-53).
- A destructive action is not automatically a big red button — reserve the loud red for the confirmation dialog (p.54).

## Layout and Spacing

- Give every element more breathing room than feels necessary; white space is the cheapest cleanup available (p.56).
- Start with far too much space and remove until it looks right (p.57-58). What feels excessive in isolation usually reads as "just enough" in a full screen (p.59).
- **Dense layouts are allowed — but only as a deliberate decision for information-heavy screens, not as the default** (p.59). *(This app has genuinely information-heavy screens; the rule is that density must be chosen, and chosen consistently.)*
- Never nudge sizes 1px at a time; choose from a pre-defined spacing scale (p.60).
- Reject linear scales (all multiples of 4): adjacent values must differ by ~25% or more or the choice stays arbitrary (p.61-62).
- Build the scale from a 16px base, packed tightly at the small end and progressively wider at the large end (p.62-63).
- **Reference spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256px** (p.63).
- When a gap is not quite right, take the next value up the scale rather than inventing an in-between number (p.64).
- Don't stretch content to fill the viewport; don't force one section to match another's width for symmetry (p.65-67).
- When a narrow component looks lost in a wide area, split its content into columns instead of stretching it (p.68-70). Equally, don't cram content into a small area to look compact (p.71).
- Give sidebars and fixed-purpose rails fixed widths and let the main region flex (p.72-75). Use a percentage only when you genuinely want the thing to scale with the viewport (p.75).
- Size forms and cards by max-width and let them shrink only when the screen is narrower (p.76-78).
- Don't encode headline size as a multiple of body size (em); the desktop ratio is wrong on mobile (p.79-81). Large elements shrink faster than small ones (p.80-81).
- Let padding scale independently of font size (p.81-82).
- **Never leave spacing ambiguous: the space around a group must always exceed the space inside it** (p.83, p.86).
- In stacked forms, the gap under the input must be larger than the gap between the label and its own input (p.84).
- Give section headings clearly more space above than below so they attach to what they introduce (p.85).
- Apply the rule horizontally too: an icon (or a control) must sit closer to its own group than to the next group in the row (p.86).

## Designing Text

- Fix the type scale up front; a UI where every size between 10 and 24px appears somewhere is inconsistent and slow to work in (p.88).
- Prefer a hand-picked scale over a modular/ratio scale — ratios yield fractional pixel values and too-coarse jumps (p.89-90).
- **Reference type scale: 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72px** (p.91-92).
- **Define sizes in px or rem, never em — nested em compounds into values that aren't on the scale at all** (p.92-93). *(The single highest-yield rule for this codebase.)*
- For UI, a neutral sans-serif (or the system stack) is the safe default (p.94); choose faces built for legibility — taller x-height, wider built-in letter-spacing (p.96).
- Keep paragraphs between 45 and 75 characters per line (~20-35em max-width) (p.99-100), even when the container is wider (p.100-101).
- Align mixed font sizes on one line by **baseline**, not centre (p.102-104).
- Match line-height to line length (~1.5 narrow, up to 2 wide) (p.105-106) and inversely to font size — small text ~1.75, large headlines fine at 1 (p.107-108).
- Don't give every link an accent colour; in link-dense UIs emphasise with weight or a darker colour (p.109-110). Ancillary links can carry no emphasis until hover (p.110).
- Left-align text by default; centre only headlines and blocks of two or three lines (p.111-112).
- **Right-align numbers in tables** so digits and decimals compare at a glance (p.113).
- Leave letter-spacing at the default in running text (p.115); tighten large headlines ~-0.05em (p.116); **increase all-caps ~+0.05em** (p.117).

## Working with Colour

- Express colours in HSL so related shades look related and can be reasoned about (p.119-121).
- Reject five-swatch palette-generator schemes; a real interface needs far more (p.123-124).
- Build the palette in three groups: greys, one or two primaries, and accents (p.124-126).
- **Greys carry almost the whole UI — you need 8-10 shades, starting from a very dark grey rather than pure black** (p.124-125).
- Provide 5-10 shades of each primary (p.126) and accent colours for semantic states — red destructive, yellow warning, green positive — each with multiple shades (p.126-128).
- Define all shades up front; never generate them on the fly (p.129).
- Pick the base shade first (one that works as a button background), then the edges by use case — darkest = text on light, lightest = a tinted panel (p.129-131), then fill the gaps to nine (p.131).
- Build greys the same way: darkest grey = darkest body text, lightest = a subtle off-white background (p.132).
- Increase saturation as shades move away from 50% lightness (p.133-134); remember perceived brightness differs per hue (p.134-135).
- Brighten by rotating hue toward 60/180/300°, darken toward 0/120/240°; never rotate more than 20-30° (p.136-138).
- Saturate greys deliberately — a little blue for cool, a little yellow for warm; pure 0% grey is rarely what UIs use (p.139-141).
- **Meet WCAG contrast: at least 4.5:1 for normal text (under ~18px) and 3:1 for large text** (p.142).
- When white-on-colour fails contrast, flip it — dark coloured text on a light tint of the same colour (p.143-144).
- For secondary text inside a dark coloured panel, rotate the hue toward a brighter hue rather than going near white (p.144-145).
- **Never let colour be the only carrier of meaning**: add an icon, arrow or label (p.146-147). In category colours, differentiate by lightness/contrast, not hue alone (p.147-148).

## Creating Depth

- Simulate a single light source from above — that is the whole basis of raised and inset effects (p.150-152).
- For a raised element reveal the top edge and hide the bottom (p.153-154); hand-pick the lighter edge colour rather than overlaying semi-transparent white (p.154).
- Add a small dark shadow with a slight downward offset and a tight blur (p.154-155). For an inset element (a well, an input) do the reverse (p.155-156).
- **Treat shadows as a z-axis position** — tight small shadows sit barely off the page, large blurred shadows pull focus (p.158).
- **Match elevation to purpose**: small for buttons, medium for dropdowns/popovers, large for modals (p.159-160).
- **Define a fixed elevation scale of about five shadows** (p.160-161). Reference: `0 1px 3px`, `0 4px 6px`, `0 5px 15px`, `0 10px 24px`, `0 15px 35px` at `hsla(0,0%,0%,.2)` (p.161).
- Use shadows as interaction feedback — raise a dragged item, drop a pressed button (p.161-162).
- Compose polished shadows from two parts: a large soft one (direct light) plus a tighter darker one (ambient occlusion) (p.163-165); fade the tight one out as elevation rises (p.165-166).
- **Flat designs still need depth: make an element lighter than its background to bring it forward, darker to push it back** (p.167-168).
- Solid shadows (short vertical offset, zero blur) add flat-friendly lift (p.169).
- Overlap elements across a background transition so the layout reads as layers rather than stacked bands (p.170-171).

## Finishing Touches

- Upgrade the defaults you already have instead of adding new elements — meaningful icons in place of bullets (p.192).
- Give in-body links real styling — a colour and weight change, or a thick coloured underline (p.193).
- Style checkboxes and radios with a brand colour instead of browser defaults (p.194).
- Add coloured accent borders to bland surfaces — across a card top, under the active nav item, along an alert's side (p.195-197).
- Break up plain sections with a background-colour shift or a subtle two-hue gradient (p.198-199).
- **Design the empty state as a priority, never an afterthought — a bare "no results" line is a failure** (p.203-204). Give it an illustration or icon plus an emphasised call to action (p.204), and **hide supporting UI (tabs, filters, toolbars) while the surface is empty** (p.205).
- **Resist adding a border every time two things need separating — too many borders read as clutter** (p.206). Separate with a box shadow (p.207), a background-colour shift (p.208), or simply more space (p.209).
- Challenge component clichés — a dropdown can be multi-column with icons, descriptions and grouped sections (p.210-211).
- Combine related table columns into one cell with internal hierarchy; enrich cells with status pills (p.212-213).
- Replace an important radio group with selectable cards when the choice matters to the flow (p.213-214).

## Levelling Up

- When a design impresses you, name the specific decision you would never have thought of (p.216-217).
- Rebuild interfaces you admire without opening devtools; the gap is where the real details live (p.217-218).

---

# Additions for this app

The book predates the surfaces below. These rules are **derived** from its principles
(each cites the principle it extends) and are binding for this audit.

## A. Dense code surfaces

Code is the content here, so the "dense layouts are a deliberate decision" escape
hatch (p.59) is taken — but it has to be *taken*, not defaulted into.

- **A1.** Density is a decision per surface, declared once: the diff body and the file tree are dense; toolbars, settings and prose are not. A surface may not be dense merely because it inherited tight padding (p.59).
- **A2.** Monospace code sets its own measure; the 45-75 character rule (p.99-100) does **not** apply to code, which must never be re-wrapped for prose comfort. It still applies to every prose block in the app — AI summaries, findings, hints, PR descriptions.
- **A3.** A dense surface still obeys the grouping rule (p.83, p.86): gutter, line number, marker and content are one group and must be spaced as one, distinct from the next row's group.
- **A4.** Syntax highlighting is a **categorical colour set** and falls under p.147-148: tokens must differ by lightness as well as hue, and every token must clear 4.5:1 on **every** ground it can land on (context, added, removed, highlighted), not just the default one.
- **A5.** Code surfaces inherit the app's greys and ink (p.124-125). A third-party viewer that ships its own palette is a palette fork and must be re-pointed at the app's tokens, not left to paint its own.

## B. Diff rendering

- **B1.** Added / removed / context grounds are semantic status colours (p.126-128) and must come from the same scale as every other status colour in the app. The legend chip and the diff row must not be two different greens.
- **B2.** Status must never be carried by the row's background colour alone (p.146-147): the `+` / `-` marker and the line-number column carry it too. *(This app does this correctly today.)*
- **B3.** Row backgrounds are a **tint**, not a fill: the ink on them stays the ink, and the tint must be light enough that every syntax token still clears 4.5:1 (p.143-144).
- **B4.** De-emphasising a row (focus mode, hunk attention) is a hierarchy move (p.30-31, p.39-40), so it is systematised like any other recurring dimension (p.27-28): there is **one** recede token, not a literal repeated per call site.
- **B5.** A receded row must stay above 3:1 on its own ground. Opacity is a poor de-emphasis tool over *coloured* text, because it collapses every hue toward the ground at once — prefer receding by substituting a single muted ink for the syntax set, or accept that the recede token is theme-specific.

## C. Long-running async states

The review pipeline runs many model calls; a step can be busy for a minute or more.

- **C1.** A loading state is a designed state, not an absent one — the same standard the book sets for empty states (p.203-204). Content-shaped skeletons that match the eventual layout beat spinners.
- **C2.** A pending section is *secondary* while it is pending and must be de-emphasised, not highlighted (p.30-31). Progress chrome must never outrank finished content.
- **C3.** Partial results are the primary content the moment they exist; the remaining progress indicator drops to tertiary (p.52-53).
- **C4.** A failed / off / skipped task is a status and obeys p.146-147 — a label or icon, never colour alone.
- **C5.** Nothing may reflow under the reader when a late result lands: reserve the space in the skeleton (p.83 — spacing communicates structure, and structure must not move).

## D. A settings page with many sections

- **D1.** Section titles are semantic headings styled down (p.46-47), never `<p>` elements that merely look like headings. The document outline is part of the hierarchy.
- **D2.** Every section heading gets clearly more space above than below (p.85).
- **D3.** Form labels are support, not content: smaller, softer and lighter than the value they label (p.44). A label must never be larger or stronger than its own field.
- **D4.** Stacked fields obey p.84 — label-to-input gap strictly smaller than input-to-next-field gap — and the whole field group is separated from the next group by more space than lives inside it (p.83).
- **D5.** A control's boundary must be distinguishable from its surroundings (3:1, the non-text companion to p.142); a hairline tuned for decorative separation is not automatically a usable control boundary.
- **D6.** Long pages separate sections with space and background shifts before adding another border (p.206-209).
- **D7.** One primary action per section at most, and the page's own primary must be unambiguous (p.52-53).

---

## Audit quick-scan

The 25 highest-leverage checks for this app, in priority order.

1. Text contrast meets 4.5:1 (3:1 for large text), in **both** themes, on every ground the text actually lands on (p.142).
2. Text on a coloured fill is defined, not defaulted — every `--on-*` token exists and is measured against its own fill (p.142-144).
3. Text colours reduce to three tiers and weights to two (p.34).
4. Font sizes come only from the 12/14/16/18/20/24/30/36/48/60/72 scale, declared in **px or rem, never em** (p.91-93).
5. Spacing comes only from the 4/8/12/16/24/32/48/64/96/128 scale (p.62-63).
6. Group spacing is unambiguous everywhere: more space around a group than inside it — toolbars, form fields, list rows, diff rows (p.83-86).
7. Every screen has one obvious primary action; secondaries are quiet, tertiaries link-like (p.52-53).
8. Nothing is presented at equal emphasis — stacks of identical rows/panels are ranked or grouped (p.30-31).
9. Separation uses space, background shifts or shadow **before** another border (p.206-209).
10. An elevation scale exists and is used: buttons small, popovers medium, modals large (p.158-161).
11. In a flat/borderless region, forward elements are lighter than their ground and receded ones darker (p.167-168).
12. Recurring opacity values come from a named token, not repeated literals (p.27-28).
13. A receded/dimmed row still clears 3:1 on its own ground, in both themes (p.142, B5).
14. The diff viewer draws its greys, inks and status colours from the app's palette, not a vendored one (A5, B1).
15. Syntax tokens clear 4.5:1 on context, added and removed grounds alike (A4).
16. Status is never colour alone — marker, icon or label carries it too (p.146-147).
17. Form labels are smaller/softer than their own values (p.44, D3).
18. Stacked fields: label→input gap < input→next-field gap (p.84).
19. Control boundaries (inputs, selects, checkboxes) clear 3:1 against their surroundings (D5).
20. Section titles are real headings, styled for hierarchy (p.46-47, D1), with more space above than below (p.85).
21. Every link is deliberately styled — no browser-default blue anywhere (p.193, p.109-110).
22. All-caps runs carry ~0.05em tracking (p.117).
23. Prose blocks stay within 45-75 characters even in wide containers; code is exempt (p.99-101, A2).
24. Empty states have an icon/illustration, a next step, and hide their useless toolbars (p.203-205).
25. Loading states are content-shaped, de-emphasised, and reserve their final space (C1, C2, C5).

---

## What does not apply to this app

Recorded so future passes don't go looking for these:

- **Working with Images, in full (p.174-190).** The app ships no photography, no hero
  images, no user uploads, no illustrations and no avatars of its own. The only
  remote images are GitHub-hosted author avatars rendered at their intended size.
  Nothing here needs overlays, colorize treatments, `background-size: cover` crops or
  inset-shadow bleed protection.
- **Icon scaling rules (p.181-186).** Iconography is text glyphs and inline SVG, never
  scaled bitmaps; there are no favicon-downscaling decisions.
- **Personality / typeface selection (p.17-23, p.94-98).** Settled and shipped:
  IBM Plex Sans / Plex Mono / Newsreader, with user-selectable system and serif UI
  stacks. Re-litigating it is out of scope for a refactor pass.
- **Mobile-first canvas work (p.67-68, p.79-81).** This is a desktop code-review tool;
  a phone pass is a separate project, not part of this refactor.
- **Charts and categorical data colour (p.147-148)** applies only in its A4 form
  (syntax highlighting); there are no charts beyond the per-file add/remove stat bars.
- **Quotes, bullets and editorial finishing touches (p.192-193, p.198-202).** There is
  no marketing or long-form editorial surface to decorate.
