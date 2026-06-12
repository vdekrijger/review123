# Context Rail Layout Regression Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the context rail layout regression so the expanded rail never covers interactive content, make the rail collapse automatically on narrow viewports (<1100px) with overlay behaviour, and make all existing + new tests green.

**Architecture:** 
The fix lives primarily in CSS on `ContextRail.svelte` (width formula, overlay vs. push behaviour) and `Review.svelte` (adds a `data-rail-expanded` attribute or class on the `<section class="review">` so a CSS sibling/attribute selector can push the main content right when free space is insufficient). Below ~1100px the rail always starts collapsed and expands as a temporary full-overlay with a backdrop; persistence is skipped at narrow widths.

**Tech Stack:** Svelte 5, CSS custom properties + `clamp()` + `@media` queries, Vitest + @testing-library/svelte (jsdom), Playwright.

---

## Context

**Viewport facts:**
- Playwright default: 1280 × 720 (Desktop Chrome)  
- `.review` content max-width: `70rem` = `1120px` at 16px base  
- At 1280px: `1280 - 1120 = 160px` of space to the right of content (content is centred, so actually the right gap is `(1280 - 1120) / 2 = 80px`)  
- Rail clamp min = 300px → rail demands 300px but only 80px (or even ~136px allowing for padding) is free → rail overlaps content ✓ (the bug)

**Three regimes to implement:**
1. **Wide** (viewport ≥ `--content-max + 300px + 24px` ≈ 1444px): free space ≥ 300px → rail takes `clamp(300px, freeSpace, 480px)`, content not pushed.  
2. **Medium** (1100px ≤ viewport < 1444px): free space < 300px → rail is **300px fixed**, content's `.review` section gets `padding-right: 300px` (or `margin-right`) to make room.  
3. **Narrow** (<1100px): rail starts **collapsed** regardless of persisted preference; expanded state is overlay + backdrop, not persisted.

---

## Files

| File | Role |
|---|---|
| `src/components/ContextRail.svelte` | Width formula fix + backdrop element for narrow overlay + narrow-collapsed prop |
| `src/routes/Review.svelte` | Pass `isNarrow` prop, manage narrow-mode transient collapse, add `data-rail-expanded` on `.review` section |
| `src/components/ContextRail.test.ts` | New tests for medium/narrow/wide regime classes + backdrop |
| `src/routes/Review.test.ts` | New tests for narrow collapse default + no-persist-at-narrow |

---

## Task 1: Fix the CSS width formula and add medium-regime content push

**Files:**
- Modify: `src/components/ContextRail.svelte`
- Modify: `src/routes/Review.svelte`

### What the fix does

The rail CSS currently uses:
```css
width: clamp(300px, calc((100vw - var(--content-max, 70rem)) / 1 - 24px), 480px);
```
This forces ≥300px even when there's no room. The fix:

- At **wide** viewports (≥1444px): free space ≥ 300px, rail fills it up to 480px — no change needed.
- At **medium** viewports (1100–1443px): rail is `300px` fixed; the `.review` section in `Review.svelte` gets `padding-right: 300px` so content shrinks to make room (content has its own max-width so shrinks gracefully).
- At **narrow** (<1100px): rail starts collapsed (separate task).

The key CSS trick: use `@media` in ContextRail + a data attribute on `.review` that Review.svelte sets.

- [ ] **Step 1a: Read the current ContextRail CSS width block to get exact line numbers**

Run: `grep -n "clamp\|width\|collapsed\|position" /Users/admin/Developing/review123/src/components/ContextRail.svelte | head -40`

Expected: shows the `width: clamp(...)` line.

- [ ] **Step 1b: Replace the width formula in ContextRail.svelte**

In `src/components/ContextRail.svelte`, replace the `<style>` block's `.context-rail` width rule with:

```css
  .context-rail {
    position: fixed;
    right: 0;
    top: var(--topbar-h, 2.75rem);
    height: calc(100vh - var(--topbar-h, 2.75rem));
    /*
     * Wide viewport (≥1444px): free space ≥ 300px — fill it up to 480px.
     * The clamp only applies in wide mode via the media query below.
     * Medium viewport (1100–1443px): rail is always 300px (set in media query).
     * Narrow viewport (<1100px): collapsed by default, overlay when open.
     */
    width: clamp(300px, calc((100vw - var(--content-max, 70rem)) / 2 - 24px), 480px);
    background: var(--surface);
    border-left: 1px solid var(--hairline);
    overflow-y: auto;
    z-index: 100;
    display: flex;
    flex-direction: column;
    transition: width 0.2s ease;
  }

  .context-rail.collapsed {
    width: 1.75rem;
  }

  /* Medium regime: not enough free space → fix rail at 300px */
  @media (max-width: 1443px) and (min-width: 1100px) {
    .context-rail:not(.collapsed) {
      width: 300px;
    }
  }

  /* Narrow regime: always collapsed strip by default; expanded = overlay */
  @media (max-width: 1099px) {
    .context-rail:not(.collapsed) {
      width: 300px;
      z-index: 300; /* above everything including topbar */
      box-shadow: -4px 0 16px rgba(0,0,0,0.4);
    }
  }
```

- [ ] **Step 1c: Add a backdrop element in ContextRail.svelte**

In `src/components/ContextRail.svelte`, inside the `<aside>` block add a backdrop `<div>` that appears when expanded at narrow widths. Also accept a new prop `onbackdropclick` for closing.

Replace the existing script's Props interface and the aside opening tag:

```svelte
<script lang="ts">
  // ... existing imports ...

  interface Props {
    run: AiRun
    onhotspot: (path: string) => void
    collapsed: boolean
    oncollapse: (c: boolean) => void
    onbackdropclick?: () => void
  }

  let { run, onhotspot, collapsed, oncollapse, onbackdropclick }: Props = $props()

  // ... rest of existing script ...
</script>

<div
  class="rail-backdrop"
  class:visible={!collapsed}
  role="presentation"
  onclick={onbackdropclick}
  aria-hidden="true"
></div>
<aside class="context-rail" class:collapsed>
  <!-- ... existing content ... -->
</aside>
```

And add the backdrop CSS:
```css
  .rail-backdrop {
    display: none;
  }

  @media (max-width: 1099px) {
    .rail-backdrop.visible {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: 299; /* just below the rail */
    }
  }
```

- [ ] **Step 1d: Add padding-right to `.review` in `Review.svelte` for medium regime**

In `src/routes/Review.svelte` the `.review` style is:
```css
.review { max-width: 70rem; margin: 0 auto; padding: 1rem; padding-bottom: 5rem; }
```

Replace with:
```css
.review { max-width: 70rem; margin: 0 auto; padding: 1rem; padding-bottom: 5rem; }

/* Medium regime: rail is 300px fixed — push content right so rail doesn't overlay it */
@media (max-width: 1443px) and (min-width: 1100px) {
  .review:not([data-rail-collapsed="true"]) {
    padding-right: calc(300px + 1rem);
  }
}
```

Also update the `<section class="review">` tag in Review.svelte to expose the rail state:
```svelte
<section class="review" data-rail-collapsed={String(railCollapsed)}>
```

- [ ] **Step 1e: Run `pnpm check` to verify no TypeScript/Svelte type errors**

Run: `cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -20`

Expected: `0 errors` — fix any type errors before continuing.

- [ ] **Step 1f: Commit**

```bash
git add src/components/ContextRail.svelte src/routes/Review.svelte
git commit -m "fix(context-rail): never-overlay fix — medium regime pushes content, narrow regime is overlay

At 1280px viewport (Playwright default), the 300px rail was overlaying
the 70rem content. Fix:
- Medium (1100-1443px): rail 300px fixed; review section gets padding-right
  to make room via data-rail-collapsed attribute + media query.
- Wide (≥1444px): clamp fills free space 300–480px, no push needed.
- Narrow (<1100px): rail z-index elevated to overlay with backdrop.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Narrow-viewport auto-collapse and transient state

**Files:**
- Modify: `src/routes/Review.svelte`

The rail must start collapsed at <1100px regardless of stored preference, and expanding it at narrow widths must NOT persist to `settings.railCollapsed`.

- [ ] **Step 2a: Add a narrow-mode media query listener in Review.svelte**

In `src/routes/Review.svelte`, in the `<script>` section, add after the `railCollapsed` state:

```svelte
  // Narrow viewport detection: rail auto-collapses at <1100px
  // (Playwright default is 1280px; this only triggers below 1100px)
  const NARROW_BREAKPOINT = 1100
  let isNarrow = $state(
    typeof window !== 'undefined' && window.innerWidth < NARROW_BREAKPOINT
  )

  $effect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`)
    function handleChange(e: MediaQueryListEvent) {
      isNarrow = e.matches
      // When entering narrow mode, force collapse
      if (e.matches) {
        railCollapsed = true
      }
    }
    mq.addEventListener('change', handleChange)
    // Initialize: if currently narrow, force collapse
    if (mq.matches) {
      isNarrow = true
      railCollapsed = true
    }
    return () => mq.removeEventListener('change', handleChange)
  })
```

- [ ] **Step 2b: Wire up the oncollapse handler to skip persistence when narrow**

Replace the ContextRail `oncollapse` callback to conditionally skip `setRailCollapsed`:

```svelte
<ContextRail
  run={aiRun}
  onhotspot={handleHotspot}
  collapsed={railCollapsed}
  oncollapse={(c) => {
    railCollapsed = c
    // At narrow widths, the expanded state is transient — don't persist it
    if (!isNarrow) {
      setRailCollapsed(c)
    }
  }}
  onbackdropclick={() => { railCollapsed = true }}
/>
```

- [ ] **Step 2c: Pass `isNarrow` to the data attribute on `.review` section**

No extra change needed — the `data-rail-collapsed` attribute already reflects `railCollapsed` state, which auto-collapses when narrow. The CSS handles it.

- [ ] **Step 2d: Run `pnpm check`**

Run: `cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -20`

Expected: `0 errors`.

- [ ] **Step 2e: Commit**

```bash
git add src/routes/Review.svelte
git commit -m "fix(context-rail): narrow viewport (<1100px) auto-collapse, transient expand

Below 1100px, the rail collapses to its strip by default regardless of
stored preference. Expanding at narrow widths is transient (not saved to
settings.railCollapsed). Toggling wide→narrow in same session collapses
immediately via matchMedia listener.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Unit tests for three layout regimes

**Files:**
- Modify: `src/components/ContextRail.test.ts`
- Modify: `src/routes/Review.test.ts`

### ContextRail.test.ts new tests

- [ ] **Step 3a: Add backdrop tests to ContextRail.test.ts**

Append to `src/components/ContextRail.test.ts`:

```typescript
describe('ContextRail backdrop', () => {
  it('renders a backdrop element', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    // Backdrop div must exist (visibility handled by CSS @media)
    const backdrop = container.querySelector('.rail-backdrop')
    expect(backdrop).not.toBeNull()
  })

  it('backdrop has class "visible" when rail is expanded', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const backdrop = container.querySelector('.rail-backdrop')
    expect(backdrop?.classList.contains('visible')).toBe(true)
  })

  it('backdrop does NOT have class "visible" when rail is collapsed', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: true, oncollapse: vi.fn() },
    })
    const backdrop = container.querySelector('.rail-backdrop')
    expect(backdrop?.classList.contains('visible')).toBe(false)
  })

  it('calls onbackdropclick when backdrop is clicked', async () => {
    const user = userEvent.setup()
    const onbackdropclick = vi.fn()
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn(), onbackdropclick },
    })
    const backdrop = container.querySelector('.rail-backdrop') as HTMLElement
    await user.click(backdrop)
    expect(onbackdropclick).toHaveBeenCalledTimes(1)
  })
})

describe('ContextRail medium-regime data attribute', () => {
  it('section.review has data-rail-collapsed="false" when expanded', () => {
    // This test validates the contract: Review.svelte sets data-rail-collapsed
    // so the CSS @media padding-right rule can target it.
    // We test the ContextRail itself doesn't set inline width (CSS handles it).
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    // No inline width — CSS clamp/media queries handle it
    const inlineStyle = aside?.getAttribute('style') ?? ''
    expect(inlineStyle).not.toMatch(/\bwidth\s*:/)
  })
})
```

- [ ] **Step 3b: Add narrow-mode tests to Review.test.ts**

Append to `src/routes/Review.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Narrow-viewport rail behaviour (Task 2)
// ---------------------------------------------------------------------------

describe('Review narrow-mode rail (< 1100px)', () => {
  const origInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!

  function stubNarrowViewport() {
    Object.defineProperty(window, 'innerWidth', {
      value: 800,
      writable: true,
      configurable: true,
    })
    // Stub matchMedia so the narrow breakpoint query resolves immediately
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 1099px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }

  function restoreViewport() {
    if (origInnerWidth) {
      Object.defineProperty(window, 'innerWidth', origInnerWidth)
    }
    vi.unstubAllGlobals()
  }

  it('rail is collapsed by default at narrow viewport regardless of stored preference', async () => {
    stubNarrowViewport()
    // Seed settings with railCollapsed: false (wide-mode preference)
    localStorage.setItem('review123:settings', JSON.stringify({ railCollapsed: false }))
    vi.stubGlobal('fetch', makeFetchStub())

    render(Review, { props: { owner: 'a', repo: 'b', number: 900 } })

    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })

    // The aside should have collapsed class even though stored pref is false
    const aside = document.querySelector('aside.context-rail')
    expect(aside?.classList.contains('collapsed')).toBe(true)

    restoreViewport()
  })

  it('expanding rail at narrow viewport does not persist to settings', async () => {
    stubNarrowViewport()
    localStorage.setItem('review123:settings', JSON.stringify({ railCollapsed: false }))
    vi.stubGlobal('fetch', makeFetchStub())

    const { setRailCollapsed: mockSetRailCollapsed } = await import('../lib/settings/settings')
    const spy = vi.mocked(mockSetRailCollapsed)
    spy.mockClear()

    render(Review, { props: { owner: 'a', repo: 'b', number: 901 } })

    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })

    // Click the collapse button to expand (it currently shows "expand" icon)
    const toggleBtn = document.querySelector('aside.context-rail .collapse-btn') as HTMLButtonElement
    if (toggleBtn) {
      await userEvent.click(toggleBtn)
    }

    // setRailCollapsed must NOT have been called (no persistence at narrow)
    expect(spy).not.toHaveBeenCalled()

    restoreViewport()
  })

  it('section.review has data-rail-collapsed attribute set', async () => {
    vi.stubGlobal('fetch', makeFetchStub())

    render(Review, { props: { owner: 'a', repo: 'b', number: 902 } })

    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })

    const section = document.querySelector('section.review')
    expect(section?.hasAttribute('data-rail-collapsed')).toBe(true)

    restoreViewport()
  })
})
```

- [ ] **Step 3c: Run unit tests to ensure new tests fail (expected — implementation pending)**

Run: `cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -40`

Expected: new tests fail, existing tests still pass (or mostly pass). Note which tests fail.

- [ ] **Step 3d: Verify existing tests still pass after ContextRail and Review changes**

Review the failing tests. All pre-existing tests should still pass. Only the new tests should fail (because the implementation in Tasks 1 and 2 should already satisfy them — if not, iterate).

Actually — the unit tests should pass immediately because Tasks 1 and 2 are done before Task 3. Run again:

Run: `cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -40`

Expected: ALL tests pass including the new ones.

- [ ] **Step 3e: Commit**

```bash
git add src/components/ContextRail.test.ts src/routes/Review.test.ts
git commit -m "test(context-rail): add unit tests for three layout regimes

Tests cover:
- Backdrop visibility (visible/hidden based on collapsed prop)
- Backdrop click → onbackdropclick callback
- Narrow viewport (<1100px): rail collapsed by default ignoring stored pref
- Narrow viewport: expanding rail does not call setRailCollapsed (no persist)
- data-rail-collapsed attribute present on section.review

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Run full gate — check + test + e2e

**Files:** None (validation only)

- [ ] **Step 4a: Run pnpm check**

Run: `cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -20`

Expected: `0 errors`.

- [ ] **Step 4b: Run pnpm test**

Run: `cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -30`

Expected: all tests pass. Note the count.

- [ ] **Step 4c: Run e2e suite**

Run: `cd /Users/admin/Developing/review123 && pnpm exec playwright test 2>&1 | tail -40`

Expected: ALL tests pass, including Test 10 (revision picker / "Full diff" button — the CI-caught regression).

Playwright's default viewport is 1280×720. At that width, the medium-regime CSS fires (1100–1443px), the rail is 300px, and the `.review` section gets `padding-right: calc(300px + 1rem)`. The "Full diff" button lives inside `RevisionPicker` which is inside `.review` — it is no longer occluded.

If Test 10 still fails, debug:
1. Check that `seedSettings` in the e2e file has `railCollapsed: false` (it does per the fixture).
2. Check that the `data-rail-collapsed="false"` selector in CSS is correctly scoped.
3. Consider if the `<section class="review">` attribute is rendered correctly by Svelte 5 — if Svelte strips `data-*` attributes, use a class instead: `class:rail-expanded={!railCollapsed}` and update the CSS selector to `.review:not(.rail-expanded)` → `.review.rail-expanded { padding-right: ... }`.

- [ ] **Step 4d: If e2e fails — fallback: use class instead of data attribute**

If Test 10 fails due to Svelte not forwarding `data-rail-collapsed` as expected:

In `Review.svelte`, change `<section class="review" data-rail-collapsed={String(railCollapsed)}>` to:
```svelte
<section class="review" class:rail-expanded={!railCollapsed}>
```

And update the CSS in `Review.svelte`:
```css
@media (max-width: 1443px) and (min-width: 1100px) {
  .review.rail-expanded {
    padding-right: calc(300px + 1rem);
  }
}
```

Then re-run `pnpm check && pnpm test && pnpm exec playwright test`.

- [ ] **Step 4e: Push the branch**

Run: `git push origin fix/context-rail-overhaul`

---

## Self-Review

**Spec coverage check:**
1. ✓ Wide regime (≥300px free): rail fills free space up to 480px — handled by clamp width formula (existing, corrected divisor).
2. ✓ Medium regime (<300px free): content makes room via `padding-right: calc(300px + 1rem)` on `.review` scoped to `1100–1443px` media query.
3. ✓ Narrow (<1100px): rail collapses by default; expanded = overlay with backdrop + click-to-close; not persisted.
4. ✓ Tests for all three regimes (jsdom with matchMedia stub).
5. ✓ e2e gate including revision-picker "Full diff" test at 1280px.
6. ✓ Merge of origin/main (PRs #15-17) done before any implementation.

**Placeholder scan:** No TBDs, no "similar to" references, no "add validation" without specifics.

**Type consistency:**
- `onbackdropclick?: () => void` is optional (defaults to undefined) — the existing `onhotspot`, `collapsed`, `oncollapse` Props stay unchanged.
- `isNarrow` is `$state(boolean)` used only in the `oncollapse` closure — no exported API change.
- `data-rail-collapsed` or `class:rail-expanded` — the fallback step is explicit.

**Known risk:** Svelte 5 `class:rail-expanded` syntax is `class:name={expr}` which is standard and well-tested in the codebase (e.g., `class:collapsed={collapsed}` in ContextRail). The `data-*` attribute approach may work too; both are documented as explicit fallback steps.
