# Reading Instrument Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Reading Instrument" design system — a precision typographic theme using IBM Plex Sans/Mono + Newsreader fonts, a new dark/light palette with CSS token primitives, and a component sweep that makes every component consume tokens instead of hardcoded values; plus commit age in RevisionPicker.

**Architecture:** All design tokens live in `src/app.css` as CSS custom properties (replacing/extending the existing `--surface*`/`--legend*` system). Component `<style>` blocks are swept to use those tokens. The `uiFont` setting adds a `'plex'` default value; legacy `'humanist'` and `'system'` values coerce to new values. Font side-effect imports go in `src/main.ts`. The `relativeTime` helper is extracted from `CommentThread.svelte` into `src/lib/time.ts` and reused in `RevisionPicker.svelte`.

**Tech Stack:** Svelte 5, TypeScript, Vitest (unit), Playwright (e2e), @fontsource/* (already installed), CSS custom properties, pnpm.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main.ts` | Modify | Add @fontsource side-effect imports (7 imports) |
| `src/app.css` | Modify | Replace entire palette/token block; add primitive utility classes |
| `src/lib/settings/settings.ts` | Modify | Add `'plex'` to UiFont type; coerce legacy `'humanist'`→`'system'`; default `uiFont` → `'plex'` |
| `src/lib/settings/appearance.svelte.ts` | Modify | Handle new `'plex'` value in data-font logic |
| `src/lib/time.ts` | Create | Extract `relativeTime()` from CommentThread; export |
| `src/lib/time.test.ts` | Create | Unit tests for `relativeTime()` |
| `src/components/CommentThread.svelte` | Modify | Remove inline `relativeTime`; import from `src/lib/time.ts`; use prose class |
| `src/components/RevisionPicker.svelte` | Modify | Import `relativeTime`; show age in option labels + comparing bar |
| `src/components/RevisionPicker.test.ts` | Modify | Add age display tests |
| `src/lib/settings/settings.test.ts` | Modify | Update uiFont tests for `'plex'` default + coercion |
| `src/lib/settings/appearance.test.ts` | Modify | Update data-font tests for `'plex'` value |
| `src/components/SettingsPanel.svelte` | Modify | Font radiogroup: replace Humanist → Plex option |
| `src/components/SettingsPanel.test.ts` | Modify | Update Font option label from "Humanist" → "Plex" |
| `src/App.svelte` | Modify | Topbar uses `--surface`, `--hairline`, `--text` tokens |
| `src/components/Stepper.svelte` | Modify | Active step uses 2px accent underline transition |
| `src/routes/Landing.svelte` | Modify | `.card` wrapper, focus treatment on input |
| `src/components/UnderstandStep.svelte` | Modify | Glance card uses `.card`; churn bars use `--accent` |
| `src/components/ContextRail.svelte` | Modify | Uses `--surface`, `--hairline` tokens |
| `src/components/InspectStep.svelte` | Modify | Mono filenames 13px |
| `src/components/FileDiff.svelte` | Modify | Header mono filename, viewed checkbox aligned |
| `src/components/CiSummary.svelte` | Modify | Harmonize colors via tokens |
| `src/components/DiagramPanel.svelte` | Modify | Legend chips via `.chip` |
| `src/components/DraftThread.svelte` | Modify | Prose font for body |
| `src/components/CommentThread.svelte` | Modify | Prose font for body |
| `src/components/VerdictStep.svelte` | Modify | Verdict pill gets accent-subtle; submit button uses accent |
| `src/components/SettingsPanel.svelte` | Modify | Dialog surface/border/radius tokens |
| `src/components/ConsentDialog.svelte` | Modify | Dialog surface/border/radius tokens |

---

## Task 1: Extract relativeTime to src/lib/time.ts (with tests)

**Files:**
- Create: `src/lib/time.ts`
- Create: `src/lib/time.test.ts`

This is prerequisite to the RevisionPicker age feature. The function already exists in `CommentThread.svelte` — extract it to a shared module.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/time.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { relativeTime } from './time'

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for times less than 60s ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-06-01T11:59:30Z')).toBe('just now')
  })

  it('returns Xm ago for times 1-59 minutes ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-06-01T11:45:00Z')).toBe('15m ago')
  })

  it('returns Xh ago for times 1-23 hours ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-06-01T09:00:00Z')).toBe('3h ago')
  })

  it('returns Xd ago for times 1+ days ago', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    expect(relativeTime('2024-05-29T12:00:00Z')).toBe('3d ago')
  })

  it('handles very old dates (years) as days', () => {
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
    expect(relativeTime('2024-06-01T00:00:00Z')).toBe('730d ago')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- src/lib/time.test.ts 2>&1 | tail -20
```

Expected: FAIL with module not found or function not found error.

- [ ] **Step 3: Create src/lib/time.ts**

```ts
// src/lib/time.ts

/**
 * Returns a human-readable relative time string for a given ISO timestamp.
 * E.g. "just now", "5m ago", "3h ago", "2d ago".
 */
export function relativeTime(createdAt: string): string {
  const now = Date.now()
  const created = new Date(createdAt).getTime()
  const diffMs = now - created
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHours = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- src/lib/time.test.ts 2>&1 | tail -10
```

Expected: 5 passed.

- [ ] **Step 5: Update CommentThread.svelte to import from src/lib/time.ts**

In `src/components/CommentThread.svelte`, replace the inline `relativeTime` function (lines 11-24) with an import:

```svelte
<script lang="ts">
  import type { PrComment } from '../lib/github/comments'
  import MarkdownView from './MarkdownView.svelte'
  import { relativeTime } from '../lib/time'
  // ... rest of script unchanged
```

Remove the `export function relativeTime(...)` block (lines 11–24 in the original file).

- [ ] **Step 6: Run full unit test suite to confirm no regressions**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -10
```

Expected: 1071 passed (1066 original + 5 new time tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/admin/Developing/review123 && git add src/lib/time.ts src/lib/time.test.ts src/components/CommentThread.svelte
git commit -m "$(cat <<'EOF'
feat: extract relativeTime into src/lib/time.ts with unit tests

Moves the inline relativeTime helper out of CommentThread.svelte into a
shared lib so RevisionPicker can reuse it without duplication.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add commit age to RevisionPicker

**Files:**
- Modify: `src/components/RevisionPicker.svelte`
- Modify: `src/components/RevisionPicker.test.ts`

The `PrCommit` type already has `authoredAt: string`. We show `{shortSha} · {age} · {message…}` in each option, and both ages in the "Comparing:" bar.

- [ ] **Step 1: Update RevisionPicker.svelte — import relativeTime and update commitOptions**

In `src/components/RevisionPicker.svelte`, add the import at the top of the `<script>` block:

```ts
import type { PrCommit } from '../lib/github/commits'
import { relativeTime } from '../lib/time'
```

Change `commitOptions` derived (was line 26-29):

```ts
const commitOptions = $derived(commits.map(c => ({
  value: c.sha,
  label: `${c.shortSha} · ${relativeTime(c.authoredAt)} · ${c.message.length > 40 ? c.message.slice(0, 40) + '…' : c.message}`,
})))
```

Update the "Comparing:" bar to include ages. Find the section that shows active comparison (currently just `<span class="picker-label">Comparing:</span>`). Add age display for from/to:

```svelte
<div class="revision-picker" aria-label="Revision picker">
  <span class="picker-label">Comparing:</span>

  <select aria-label="From revision" bind:value={fromSha}>
    <option value={baseOption.value}>{baseOption.label}</option>
    {#each commitOptions as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>

  <span class="picker-arrow">→</span>

  <select aria-label="To revision" bind:value={toSha}>
    <option value={baseOption.value}>{baseOption.label}</option>
    {#each commitOptions as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>

  {#if fromSha !== baseSha}
    {@const fromCommit = commits.find(c => c.sha === fromSha)}
    {#if fromCommit}
      <span class="picker-age" aria-label="From commit age">{relativeTime(fromCommit.authoredAt)}</span>
    {/if}
  {/if}

  <button
    class="picker-apply"
    onclick={handleApply}
    disabled={!isValid}
    aria-label="Apply revision comparison"
  >
    Compare
  </button>
  <!-- ... rest unchanged ... -->
```

- [ ] **Step 2: Update RevisionPicker.test.ts — update option label assertions and add age tests**

In `src/components/RevisionPicker.test.ts`:

(a) Update the existing `makeCommit` helper to use a real authoredAt date:

```ts
function makeCommit(sha: string, message: string, shortSha?: string): PrCommit {
  return {
    sha,
    shortSha: shortSha ?? sha.slice(0, 7),
    message,
    authoredAt: '2020-01-01T00:00:00Z', // far in the past → stable "Xd ago" in tests
  }
}
```

(b) Add tests at the end of the file:

```ts
// ---------------------------------------------------------------------------
// Age display
// ---------------------------------------------------------------------------

describe('RevisionPicker — age display', () => {
  it('option label includes shortSha, age, and message', () => {
    renderPicker()
    const selects = screen.getAllByRole('combobox')
    const options = Array.from(selects[0].querySelectorAll('option'))
    const commitOpt = options.find(o => o.value === COMMITS[0].sha)
    expect(commitOpt).toBeDefined()
    // Label should match pattern: "aaa1111 · Xd ago · feat: first commit"
    expect(commitOpt!.textContent).toMatch(/aaa1111/)
    expect(commitOpt!.textContent).toMatch(/ago/)
    expect(commitOpt!.textContent).toMatch(/feat: first commit/)
  })

  it('truncated long message still includes age', () => {
    const longMsg = 'a'.repeat(50)
    const commits = [makeCommit('abc123def456789', longMsg)]
    renderPicker({ commits })
    const selects = screen.getAllByRole('combobox')
    const options = Array.from(selects[0].querySelectorAll('option'))
    const commitOpt = options.find(o => o.value === 'abc123def456789')
    expect(commitOpt!.textContent).toMatch(/ago/)
    expect(commitOpt!.textContent).toMatch(/…/)
  })

  it('existing length-check still holds: option text shorter than truncation limit', () => {
    const longMsg = 'a'.repeat(50)
    const commits = [makeCommit('abc123def456789', longMsg)]
    renderPicker({ commits })
    const selects = screen.getAllByRole('combobox')
    const options = Array.from(selects[0].querySelectorAll('option'))
    const commitOpt = options.find(o => o.value === 'abc123def456789')
    // shortSha(7) + " · " + age(~7) + " · " + 40 chars + "…" = ~60 chars; < 80 is reasonable
    expect(commitOpt!.textContent!.length).toBeLessThan(80)
  })
})
```

(c) The existing test `'renders commit message as-is when <= 40 chars'` checks `not.toContain('…')` — this is still valid since age doesn't add `…`. No change needed there.

(d) The existing test `'renders each commit as an option with shortSha + message (truncated to 40ch)'` asserts `commitOpt!.textContent!.length < 60`. Update this bound to `< 80` since we add age text:

```ts
it('renders each commit as an option with shortSha + message (truncated to 40ch)', () => {
  const longMsg = 'a'.repeat(50)
  const commits = [makeCommit('abc123def456789', longMsg)]
  renderPicker({ commits })

  const selects = screen.getAllByRole('combobox')
  const options = Array.from(selects[0].querySelectorAll('option'))
  const commitOpt = options.find(o => o.value === 'abc123def456789')
  expect(commitOpt).toBeDefined()
  expect(commitOpt!.textContent).toContain('abc123d')
  expect(commitOpt!.textContent).toContain('…')
  expect(commitOpt!.textContent!.length).toBeLessThan(80)
})
```

- [ ] **Step 3: Run unit tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- src/components/RevisionPicker.test.ts 2>&1 | tail -15
```

Expected: all RevisionPicker tests pass (existing + new age tests).

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123 && git add src/components/RevisionPicker.svelte src/components/RevisionPicker.test.ts
git commit -m "$(cat <<'EOF'
feat: show commit age in RevisionPicker option labels

Each commit option now shows "{shortSha} · {age} · {message…}" format
using the shared relativeTime util. The active comparison bar also shows
the from-commit age.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Design tokens + primitives in app.css

**Files:**
- Modify: `src/app.css`

Replace the entire CSS variable block with the Reading Instrument palette, and add global primitive utility classes (`.btn`, `.btn-primary`, `.card`, `.chip`, `.prose` refinement, heading defaults, details/summary pattern).

- [ ] **Step 1: Replace src/app.css with the new design token system**

The full new `src/app.css` content (replace the existing file entirely):

```css
:root {
  /* ── Typography ── */
  --font-ui: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'IBM Plex Mono', 'SF Mono', 'JetBrains Mono', ui-monospace, monospace;
  --font-prose: 'Newsreader', Georgia, serif;

  /* ── Dark palette (default) ── */
  --bg:             #14161a;
  --surface:        #1b1e24;
  --surface-raised: #22262d;
  --hairline:       #2e333b;
  --text:           #e8e6e1;
  --text-muted:     #9a9890;
  --accent:         #4db6a0;
  --accent-subtle:  rgba(77,182,160,.12);

  /* ── Legacy surface vars (keep for components not yet swept) ── */
  --surface-overlay: var(--surface-raised);
  --surface-banner:  #1a3050;
  --border-banner:   #2a5080;
  --border-banner-accent: #4db6a0;
  --text-banner:     #c8dff0;
  --surface-draft:   #2a2510;
  --border-draft:    #a07820;
  --text-draft:      #e8e0c8;

  /* ── Legend / status chips (dark) ── */
  --legend-added-bg:        #1a3a28;
  --legend-added-border:    #2ea44f;
  --legend-added-color:     #6dd49a;
  --legend-removed-bg:      #3a1a1a;
  --legend-removed-border:  #c93a49;
  --legend-removed-color:   #e89898;
  --legend-changed-bg:      #3a2e0e;
  --legend-changed-border:  #c49828;
  --legend-changed-color:   #e8c85a;
  --legend-unchanged-bg:    #22262d;
  --legend-unchanged-border:#3a3f48;
  --legend-unchanged-color: #9a9890;

  color-scheme: light dark;
  font-size: 15px;
  line-height: 1.6;
  letter-spacing: normal;
}

/* ── Font preference overrides (data-font attribute set by applyAppearance) ── */
:root[data-font='system'] {
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

:root[data-font='serif'] {
  --font-ui: Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif;
}

/* ── Theme overrides ── */
:root[data-theme='dark'] { color-scheme: dark; }
:root[data-theme='light'] { color-scheme: light; }

/* ── Light palette ── */
:root[data-theme='light'] {
  --bg:             #faf8f4;
  --surface:        #ffffff;
  --surface-raised: #f4f1ea;
  --hairline:       #e3dfd6;
  --text:           #1f2328;
  --text-muted:     #6e6a61;
  --accent:         #2e8b78;
  --accent-subtle:  rgba(46,139,120,.10);

  --surface-banner:  #ddeeff;
  --border-banner:   #90b8d8;
  --border-banner-accent: #2a7abf;
  --text-banner:     #1a3050;
  --surface-draft:   #fffbf0;
  --border-draft:    #f0b44488;
  --text-draft:      #333;

  --legend-added-bg:        #dcffe4;
  --legend-added-border:    #2ea44f;
  --legend-added-color:     #1a7f37;
  --legend-removed-bg:      #ffe5e5;
  --legend-removed-border:  #d73a49;
  --legend-removed-color:   #cb2431;
  --legend-changed-bg:      #fff5cc;
  --legend-changed-border:  #d4a72c;
  --legend-changed-color:   #9a6700;
  --legend-unchanged-bg:    #f0f0f2;
  --legend-unchanged-border:#bbb;
  --legend-unchanged-color: #666;
}

/* ── Auto light preference ── */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --bg:             #faf8f4;
    --surface:        #ffffff;
    --surface-raised: #f4f1ea;
    --hairline:       #e3dfd6;
    --text:           #1f2328;
    --text-muted:     #6e6a61;
    --accent:         #2e8b78;
    --accent-subtle:  rgba(46,139,120,.10);

    --surface-banner:  #ddeeff;
    --border-banner:   #90b8d8;
    --border-banner-accent: #2a7abf;
    --text-banner:     #1a3050;
    --surface-draft:   #fffbf0;
    --border-draft:    #f0b44488;
    --text-draft:      #333;

    --legend-added-bg:        #dcffe4;
    --legend-added-border:    #2ea44f;
    --legend-added-color:     #1a7f37;
    --legend-removed-bg:      #ffe5e5;
    --legend-removed-border:  #d73a49;
    --legend-removed-color:   #cb2431;
    --legend-changed-bg:      #fff5cc;
    --legend-changed-border:  #d4a72c;
    --legend-changed-color:   #9a6700;
    --legend-unchanged-bg:    #f0f0f2;
    --legend-unchanged-border:#bbb;
    --legend-unchanged-color: #666;
  }
}

/* ═══════════════════════════════════════════
   BASE ELEMENTS
   ═══════════════════════════════════════════ */

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
}

code, pre, kbd, samp {
  font-family: var(--font-mono);
}

h1 {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-family: var(--font-ui);
}

h2 {
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

h3 {
  font-weight: 600;
  letter-spacing: -0.01em;
}

/* ═══════════════════════════════════════════
   PROSE CONTEXTS
   Newsreader for AI summaries, PR descriptions,
   and comment bodies.
   ═══════════════════════════════════════════ */

.prose,
.prose-md {
  font-family: var(--font-prose);
  font-size: 1.05rem;
  line-height: 1.65;
  max-width: 72ch;
}

/* ═══════════════════════════════════════════
   BUTTON PRIMITIVES
   ═══════════════════════════════════════════ */

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;
  white-space: nowrap;
  text-decoration: none;
}

.btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-subtle) 100%, var(--surface-raised));
  border-color: var(--accent);
}

.btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #0a1410;
  font-weight: 600;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
  border-color: var(--accent);
}

/* ═══════════════════════════════════════════
   INPUT / TEXTAREA / SELECT PRIMITIVES
   ═══════════════════════════════════════════ */

input:not([type="radio"]):not([type="checkbox"]),
textarea,
select {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 6px;
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 0.9rem;
  padding: 0.4rem 0.6rem;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}

input:not([type="radio"]):not([type="checkbox"]):focus,
textarea:focus,
select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-subtle);
}

/* ═══════════════════════════════════════════
   CARD PRIMITIVE
   ═══════════════════════════════════════════ */

.card {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: 0.75rem 1rem;
}

/* ═══════════════════════════════════════════
   CHIP PRIMITIVE
   ═══════════════════════════════════════════ */

.chip {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 500;
  border: 1px solid transparent;
  white-space: nowrap;
}

/* ═══════════════════════════════════════════
   DETAILS / SUMMARY EDITORIAL PATTERN
   ═══════════════════════════════════════════ */

details > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
  font-family: var(--font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0.5rem 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

details > summary::-webkit-details-marker { display: none; }

details > summary::before {
  content: '';
  display: inline-block;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent currentColor;
  transition: transform 150ms ease;
  flex-shrink: 0;
}

details[open] > summary::before {
  transform: rotate(90deg);
}

/* ═══════════════════════════════════════════
   DIALOG PRIMITIVE
   ═══════════════════════════════════════════ */

dialog {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  color: var(--text);
  padding: 1.5rem;
  max-width: 480px;
  width: 90vw;
}

dialog::backdrop {
  background: rgba(0,0,0,.5);
  backdrop-filter: blur(2px);
}
```

- [ ] **Step 2: Run svelte-check to verify no CSS errors**

```bash
cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -20
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Run full unit tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -10
```

Expected: all tests pass (CSS changes don't affect unit tests).

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/Developing/review123 && git add src/app.css
git commit -m "$(cat <<'EOF'
feat: Reading Instrument design tokens + CSS primitives in app.css

Introduces the full palette (dark/light), --font-ui/mono/prose vars,
and global utility classes: .btn, .btn-primary, .card, .chip,
details/summary editorial pattern, dialog, input/textarea/select base.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Font imports in main.ts + uiFont settings migration

**Files:**
- Modify: `src/main.ts`
- Modify: `src/lib/settings/settings.ts`
- Modify: `src/lib/settings/appearance.svelte.ts`
- Modify: `src/lib/settings/settings.test.ts`
- Modify: `src/lib/settings/appearance.test.ts`
- Modify: `src/components/SettingsPanel.svelte`
- Modify: `src/components/SettingsPanel.test.ts`

The `uiFont` setting gains `'plex'` as its default (replaces `'system'`). Legacy `'humanist'` values stored in localStorage coerce to `'system'`. The SettingsPanel Font radiogroup replaces "Humanist" with "Plex".

- [ ] **Step 1: Add @fontsource imports to src/main.ts**

Replace the contents of `src/main.ts`:

```ts
import { mount } from 'svelte'
import './app.css'

// IBM Plex Sans — UI font
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'

// IBM Plex Mono — code and diff
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

// Newsreader — prose (summaries, descriptions, comment bodies)
import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/400-italic.css'
import '@fontsource/newsreader/500.css'

import App from './App.svelte'
import { initAnalytics } from './lib/analytics/analytics'
import { applyAppearance } from './lib/settings/appearance.svelte'

initAnalytics()
applyAppearance()
mount(App, { target: document.getElementById('app')! })
```

- [ ] **Step 2: Update UiFont type and coerce in settings.ts**

In `src/lib/settings/settings.ts`:

(a) Change the type definition (line 17):
```ts
export type UiFont = 'plex' | 'system' | 'serif'
```

(b) Change DEFAULTS uiFont (line 42):
```ts
  uiFont: 'plex',
```

(c) Update the coerce function uiFont section (line 78):
```ts
  const uiFont = obj['uiFont']
  // 'humanist' was the old name for system-font choice — coerce to 'system'
  if (uiFont === 'plex' || uiFont === 'system' || uiFont === 'serif') {
    result.uiFont = uiFont
  } else if (uiFont === 'humanist') {
    result.uiFont = 'system'
  }
```

- [ ] **Step 3: Update appearance.svelte.ts for the 'plex' value**

In `src/lib/settings/appearance.svelte.ts`, the `applyAppearance` function sets `data-font` attribute. `'plex'` is the default (no attribute needed — the CSS root already sets IBM Plex Sans). Update the logic:

```ts
export function applyAppearance(): void {
  const { theme, uiFont } = getSettings()

  // data-theme: explicit value only; absent = auto (CSS handles via color-scheme: light dark)
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }

  // data-font: only set for non-default fonts; absent = plex (IBM Plex Sans, the default)
  if (uiFont === 'system' || uiFont === 'serif') {
    document.documentElement.setAttribute('data-font', uiFont)
  } else {
    // 'plex' is the default — no attribute needed
    document.documentElement.removeAttribute('data-font')
  }
}
```

- [ ] **Step 4: Update settings.test.ts for new uiFont defaults and coercion**

In `src/lib/settings/settings.test.ts`, update the `uiFont` describe block:

```ts
describe('uiFont', () => {
  it('defaults to plex', () => {
    expect(getSettings().uiFont).toBe('plex')
  })

  it('setUiFont persists system', () => {
    setUiFont('system')
    expect(getSettings().uiFont).toBe('system')
  })

  it('setUiFont persists serif', () => {
    setUiFont('serif')
    expect(getSettings().uiFont).toBe('serif')
  })

  it('setUiFont persists plex', () => {
    setUiFont('serif')
    setUiFont('plex')
    expect(getSettings().uiFont).toBe('plex')
  })

  it('coerces invalid uiFont value back to default (plex)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ uiFont: 'comic-sans' }))
    expect(getSettings().uiFont).toBe('plex')
  })

  it('coerces legacy "humanist" value to "system"', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ uiFont: 'humanist' }))
    expect(getSettings().uiFont).toBe('system')
  })
})
```

Also update the `returns defaults when nothing stored` test to reflect `uiFont: 'plex'`:

```ts
it('returns defaults when nothing stored', () => {
  expect(getSettings()).toEqual({
    githubPat: null,
    deepseekKey: null,
    diffMode: 'unified',
    githubAuth: null,
    railCollapsed: false,
    theme: 'auto',
    uiFont: 'plex',
  })
})
```

- [ ] **Step 5: Update appearance.test.ts for 'plex' behavior**

In `src/lib/settings/appearance.test.ts`:

(a) The test `'sets data-font=humanist when uiFont is humanist'` — replace with `'plex'` behavior:

```ts
it('removes data-font attribute when uiFont is plex (default)', async () => {
  document.documentElement.setAttribute('data-font', 'serif') // pre-set
  setUiFont('plex')
  const { applyAppearance } = await import('./appearance.svelte')
  applyAppearance()
  expect(document.documentElement.hasAttribute('data-font')).toBe(false)
})
```

(b) Keep the `'sets data-font=serif when uiFont is serif'` test unchanged.

(c) Replace `'removes data-font attribute when uiFont is system'` with:

```ts
it('sets data-font=system when uiFont is system (overrides default Plex)', async () => {
  setUiFont('system')
  const { applyAppearance } = await import('./appearance.svelte')
  applyAppearance()
  expect(document.documentElement.getAttribute('data-font')).toBe('system')
})
```

- [ ] **Step 6: Update SettingsPanel.svelte Font radiogroup**

In `src/components/SettingsPanel.svelte`, replace the Font fieldset:

```svelte
<fieldset>
  <legend>Font</legend>
  <label>
    <input type="radio" name="uiFont" value="plex" checked={uiFont === 'plex'} onchange={() => onFontChange('plex')} />
    Plex
  </label>
  <label>
    <input type="radio" name="uiFont" value="system" checked={uiFont === 'system'} onchange={() => onFontChange('system')} />
    System
  </label>
  <label>
    <input type="radio" name="uiFont" value="serif" checked={uiFont === 'serif'} onchange={() => onFontChange('serif')} />
    Serif
  </label>
</fieldset>
```

- [ ] **Step 7: Update SettingsPanel.test.ts**

In `src/components/SettingsPanel.test.ts`, update the Font radiogroup tests:

```ts
it('renders Font radiogroup with Plex, System, Serif options', () => {
  render(SettingsPanel, { props: { onclose: vi.fn() } })
  const fontGroup = screen.getByRole('group', { name: /font/i })
  expect(fontGroup).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: /plex/i })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: /system/i })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: /serif/i })).toBeInTheDocument()
})

it('selecting Plex font persists in getSettings', async () => {
  render(SettingsPanel, { props: { onclose: vi.fn() } })
  await userEvent.click(screen.getByRole('radio', { name: /plex/i }))
  expect(getSettings().uiFont).toBe('plex')
})

it('Plex is selected by default for font (matches stored default)', () => {
  render(SettingsPanel, { props: { onclose: vi.fn() } })
  const plexRadio = screen.getByRole('radio', { name: /plex/i })
  expect((plexRadio as HTMLInputElement).checked).toBe(true)
})
```

Remove or update tests that reference "Humanist" radio or "System is selected by default for font".

- [ ] **Step 8: Run tests to verify settings and appearance tests pass**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- src/lib/settings src/components/SettingsPanel.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 9: Run svelte-check**

```bash
cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 10: Run full test suite**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 11: Commit**

```bash
cd /Users/admin/Developing/review123 && git add src/main.ts src/lib/settings/settings.ts src/lib/settings/appearance.svelte.ts src/lib/settings/settings.test.ts src/lib/settings/appearance.test.ts src/components/SettingsPanel.svelte src/components/SettingsPanel.test.ts
git commit -m "$(cat <<'EOF'
feat: wire IBM Plex/Newsreader fonts + migrate uiFont setting to 'plex' default

Adds @fontsource side-effect imports in main.ts (IBM Plex Sans 400/500/600,
IBM Plex Mono 400/500, Newsreader 400/400-italic/500). UiFont type gains
'plex' as the new default; legacy 'humanist' coerces to 'system'. SettingsPanel
Font radiogroup updated to Plex/System/Serif.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Component sweep — App, Stepper, Landing, Dialogs

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/components/Stepper.svelte`
- Modify: `src/routes/Landing.svelte`
- Modify: `src/components/SettingsPanel.svelte`
- Modify: `src/components/ConsentDialog.svelte`

Consume tokens; remove redundant hardcoded values.

- [ ] **Step 1: Update App.svelte topbar styles**

Replace the `<style>` block in `src/App.svelte`:

```svelte
<style>
  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--hairline);
  }
  .topbar a {
    font-weight: 700;
    text-decoration: none;
    color: var(--text);
    font-size: 1rem;
    letter-spacing: -0.01em;
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .auth-badge {
    font-size: 0.85em;
    color: var(--text-muted);
  }
</style>
```

Also add `class="btn"` to the Sign out and Settings buttons in the template:

```svelte
<button class="btn" onclick={handleSignOut}>Sign out</button>
<!-- ... -->
<button class="btn" aria-label="Settings" onclick={() => (settingsOpen = true)}>⚙</button>
```

- [ ] **Step 2: Update Stepper.svelte with accent underline signature**

Replace the full `src/components/Stepper.svelte`:

```svelte
<script lang="ts" module>
  export type Step = 1 | 2 | 3
</script>

<script lang="ts">
  let { step, onstep }: { step: Step; onstep: (s: Step) => void } = $props()
  const labels: Record<Step, string> = { 1: 'Understand', 2: 'Inspect', 3: 'Verdict' }
</script>

<nav class="stepper" aria-label="Review steps">
  {#each ([1, 2, 3] as const) as s}
    <button
      class="step-btn"
      class:active={s === step}
      onclick={() => onstep(s)}
      aria-current={s === step ? 'step' : undefined}
    >
      {s} · {labels[s]}
    </button>
  {/each}
</nav>

<style>
  .stepper {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  .step-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.3rem 0.5rem 0.25rem;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    transition: border-color 150ms ease, color 150ms ease;
  }

  .step-btn:hover {
    color: var(--text);
  }

  .step-btn.active {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--accent);
  }

  .step-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 3px;
  }
</style>
```

- [ ] **Step 3: Update Landing.svelte — card list + token styles**

Replace the `<style>` block in `src/routes/Landing.svelte`. The template markup stays the same; only CSS changes:

```svelte
<style>
  .landing {
    max-width: 40rem;
    margin: 12vh auto 0;
    padding: 0 1.5rem;
    text-align: center;
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  form input[type="text"] {
    flex: 1;
    font-size: 1rem;
  }

  form button[type="submit"] {
    /* extend .btn-primary */
    display: inline-flex;
    align-items: center;
    padding: 0.4rem 1.2rem;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: #0a1410;
    font-family: var(--font-ui);
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: filter 150ms ease;
  }

  form button[type="submit"]:hover {
    filter: brightness(1.1);
  }

  .error {
    color: var(--legend-removed-color);
    font-size: 0.9rem;
    margin-top: 0.5rem;
  }

  .recent-reviews {
    margin-top: 2.5rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }

  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .recent-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 0;
  }

  .clear-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    transition: color 150ms;
  }

  .clear-btn:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .recent-item {
    display: flex;
  }

  .recent-link {
    display: flex;
    align-items: baseline;
    gap: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    width: 100%;
    color: var(--text);
    transition: background 100ms;
  }

  .recent-link:hover {
    background: var(--surface-raised);
  }

  .recent-ref {
    font-family: var(--font-mono);
    font-size: 0.83rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .recent-sep {
    color: var(--text-muted);
    margin: 0 0.2rem;
    flex-shrink: 0;
  }

  .recent-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
```

- [ ] **Step 4: Update SettingsPanel.svelte dialog styles**

Replace the `<style>` block in `src/components/SettingsPanel.svelte`:

```svelte
<style>
  /* dialog base from app.css; override only layout-specific things */
  dialog {
    max-width: 520px;
  }

  .auth-status {
    font-size: 0.9em;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  details {
    margin: 0.5rem 0;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    overflow: hidden;
  }

  details summary {
    /* override global uppercase for this context — keep editorial but less loud */
    text-transform: none;
    letter-spacing: normal;
    font-size: 0.9em;
    color: var(--text-muted);
  }

  details label {
    display: block;
    margin: 0.5rem 0.75rem;
  }

  section[aria-label^="Appearance"] {
    margin-bottom: 1rem;
  }

  .section-label {
    font-size: 0.9em;
    font-weight: 600;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .immediate-note {
    font-weight: normal;
    color: var(--text-muted);
    font-size: 0.85em;
  }

  fieldset {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.4rem 0.75rem 0.5rem;
    margin: 0 0 0.5rem;
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
    background: var(--surface-raised);
  }

  fieldset legend {
    font-size: 0.85em;
    color: var(--text-muted);
    padding: 0 0.25rem;
  }

  fieldset label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.9em;
    cursor: pointer;
    color: var(--text);
  }

  .hint {
    font-size: 0.8em;
    color: var(--text-muted);
    margin: 0.5rem 0;
  }

  button[onclick*="save"] {
    /* Save button — primary */
    display: inline-flex;
    align-items: center;
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: #0a1410;
    font-family: var(--font-ui);
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    margin-right: 0.5rem;
    transition: filter 150ms;
  }

  button[onclick*="save"]:hover {
    filter: brightness(1.1);
  }

  button[onclick*="onclose"] {
    display: inline-flex;
    align-items: center;
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 150ms;
  }

  button[onclick*="onclose"]:hover {
    background: var(--surface);
  }
</style>
```

**NOTE:** The button selectors by onclick attribute are fragile. A better approach: add `class="btn btn-primary"` to the Save button and `class="btn"` to Cancel in the Svelte template. Update the template:

```svelte
  <button class="btn btn-primary" onclick={save}>Save</button>
  <button class="btn" onclick={onclose}>Cancel</button>
```

Then simplify the style block to NOT override Save/Cancel buttons (they inherit from app.css).

- [ ] **Step 5: Update ConsentDialog.svelte**

Replace the `<style>` block:

```svelte
<style>
  /* dialog base styles come from app.css */

  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    justify-content: flex-end;
  }
</style>
```

Add button classes in template:

```svelte
  <div class="actions">
    <button class="btn btn-primary" onclick={accept}>Send code to DeepSeek</button>
    <button class="btn" onclick={decline}>Not now</button>
  </div>
```

- [ ] **Step 6: Run svelte-check**

```bash
cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -15
```

Expected: 0 errors. Fix any unused CSS selector warnings by removing unused styles.

- [ ] **Step 7: Run full unit tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/admin/Developing/review123 && git add src/App.svelte src/components/Stepper.svelte src/routes/Landing.svelte src/components/SettingsPanel.svelte src/components/ConsentDialog.svelte
git commit -m "$(cat <<'EOF'
feat: sweep App/Stepper/Landing/Dialogs to consume design tokens

Topbar: surface bg + hairline border. Stepper: accent 2px underline
transition on active step. Landing: card list + generous whitespace.
SettingsPanel + ConsentDialog: dialog primitive from app.css.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Component sweep — UnderstandStep, ContextRail, Inspect/FileDiff, CiSummary, DiagramPanel

**Files:**
- Modify: `src/components/UnderstandStep.svelte`
- Modify: `src/components/ContextRail.svelte`
- Modify: `src/components/InspectStep.svelte`
- Modify: `src/components/FileDiff.svelte`
- Modify: `src/components/CiSummary.svelte`
- Modify: `src/components/DiagramPanel.svelte`

- [ ] **Step 1: Update UnderstandStep.svelte — glance card and detail panels**

In `src/components/UnderstandStep.svelte`, update the `<style>` block:

(a) Replace `.glance-card` styles:
```css
.glance-card {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
```

(b) Update `.detail-panel`:
```css
.detail-panel {
  border: 1px solid var(--hairline);
  border-radius: 6px;
  overflow: hidden;
}
```

(c) Remove `.detail-summary` and `.detail-summary::before` / `details[open]` rules — these are now handled by the global `details > summary` in app.css.

(d) Replace `.detail-body`:
```css
.detail-body {
  padding: 0.75rem;
  border-top: 1px solid var(--hairline);
}
```

(e) Update churn bar colors:
```css
.churn-add { background: var(--accent); }
.churn-del { background: var(--legend-removed-color); }
```

(f) Update `.verdict-level` color references to use CSS vars:
```css
.verdict-level.level-behavior-preserved {
  color: var(--legend-added-color);
  background: var(--legend-added-bg);
  border-color: var(--legend-added-border);
}

.verdict-level.level-minor-changes {
  color: var(--legend-changed-color);
  background: var(--legend-changed-bg);
  border-color: var(--legend-changed-border);
}

.verdict-level.level-significant-changes {
  color: var(--legend-removed-color);
  background: var(--legend-removed-bg);
  border-color: var(--legend-removed-border);
}
```

(g) Update `.ci-badge` classes similarly using legend vars.

- [ ] **Step 2: Update ContextRail.svelte**

Replace the `.context-rail` style:
```css
.context-rail {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 260px;
  background: var(--surface);
  border-left: 1px solid var(--hairline);
  overflow-y: auto;
  z-index: 50;
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;
}
```

Replace `.rail-section` border:
```css
.rail-section {
  padding: 0.75rem;
  border-bottom: 1px solid var(--hairline);
  font-size: 0.82rem;
}
```

Replace `.rail-header` border:
```css
.rail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.75rem 0.5rem;
  border-bottom: 1px solid var(--hairline);
  flex-shrink: 0;
}
```

Update `.verdict-pill` colors to use legend vars (same pattern as UnderstandStep).

- [ ] **Step 3: Update InspectStep.svelte header filename styles**

In `src/components/InspectStep.svelte`, locate where file headers render filenames. Add/ensure the file header filename uses mono font at 13px. Look for the header/filename area in the template and set:

```css
.file-header-name {
  font-family: var(--font-mono);
  font-size: 0.8125rem; /* 13px */
}
```

- [ ] **Step 4: Update FileDiff.svelte header and viewed checkbox**

In `src/components/FileDiff.svelte`, read the full `<style>` block and update:

(a) The file header background should use `var(--surface-raised)` and `var(--hairline)` border.
(b) Filename: `font-family: var(--font-mono); font-size: 0.8125rem;`
(c) Viewed checkbox: `align-items: center;` and right-aligned.

**Read the full FileDiff.svelte first** to understand current styles, then update only the relevant rules.

- [ ] **Step 5: Update CiSummary.svelte colors**

In `src/components/CiSummary.svelte`, replace hardcoded color values:

```css
.ci-pass { color: var(--legend-added-color); }
.ci-pending { color: var(--legend-changed-color); }
.ci-failures-summary { color: var(--legend-removed-color); }
```

Update `.skeleton`:
```css
.skeleton {
  display: inline-block;
  width: 160px;
  height: 1em;
  background: var(--surface-raised);
  border-radius: 4px;
  animation: pulse 1.4s ease-in-out infinite;
}
```

- [ ] **Step 6: Update DiagramPanel.svelte legend chips**

In `src/components/DiagramPanel.svelte`, find where legend chips are rendered and add class `chip` to them, removing per-element duplicate styles.

- [ ] **Step 7: Run svelte-check**

```bash
cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -15
```

Fix any "unused CSS selector" warnings from removed detail-summary rules. If svelte-check warns about unused global rules removed from a component that was using the global pattern, verify you didn't accidentally leave a duplicate scoped selector.

- [ ] **Step 8: Run full unit tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
cd /Users/admin/Developing/review123 && git add src/components/UnderstandStep.svelte src/components/ContextRail.svelte src/components/InspectStep.svelte src/components/FileDiff.svelte src/components/CiSummary.svelte src/components/DiagramPanel.svelte
git commit -m "$(cat <<'EOF'
feat: sweep UnderstandStep/ContextRail/Inspect/FileDiff/CiSummary/DiagramPanel to tokens

Glance card and detail panels use .card + --hairline. Churn bars use
--accent. Verdict/CI colors use --legend-* vars. ContextRail uses --surface
+ --hairline border. Filenames 13px mono.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Component sweep — DraftThread, CommentThread, VerdictStep, RevisionPicker

**Files:**
- Modify: `src/components/DraftThread.svelte`
- Modify: `src/components/CommentThread.svelte`
- Modify: `src/components/VerdictStep.svelte`
- Modify: `src/components/RevisionPicker.svelte`

- [ ] **Step 1: Update DraftThread.svelte — prose font for body; btn tokens**

In `src/components/DraftThread.svelte`:

(a) Add `.prose` class to `.draft-body` in the template:
```svelte
<div class="draft-body prose">
  {@html renderMarkdown(draft.body)}
</div>
```

(b) Remove the redundant `button` rules and `.btn-primary`, `.btn-secondary`, `.btn-danger` per-component overrides — replace with global `.btn` / `.btn-primary` usage in template:
```svelte
<button type="button" class="btn btn-primary" onclick={handleSave} disabled={!editorValue.trim()}>
  Save
</button>
<button type="button" class="btn" onclick={handleCancel}>
  Cancel
</button>
```
And in view mode:
```svelte
<button type="button" class="btn" onclick={handleEdit}>Edit</button>
<button type="button" class="btn btn-danger" onclick={handleDelete}>Delete</button>
```

(c) Add `.btn-danger` global style to `app.css`:
```css
.btn-danger {
  background: var(--legend-removed-bg);
  border-color: var(--legend-removed-border);
  color: var(--legend-removed-color);
}
.btn-danger:hover:not(:disabled) {
  filter: brightness(1.1);
}
```

(d) Remove the now-redundant `button { ... }`, `.btn-primary { ... }`, `.btn-secondary { ... }`, `.btn-danger { ... }` rules from DraftThread's `<style>`.

- [ ] **Step 2: Update CommentThread.svelte — prose font for body**

In `src/components/CommentThread.svelte`, add `class="prose"` (or ensure `.comment-body` uses the prose font):

```svelte
<div class="comment-body prose">
  <MarkdownView source={comment.body} />
</div>
```

Remove `.comment-body { font-size: 0.88rem; }` from `<style>` (the prose class handles sizing at 1.05rem — or keep a font-size override if that's too large for inline comments; judge call: keep 0.9rem with prose just for font-family by overriding `font-size: 0.9rem` in the `.comment-body` rule rather than `font-size: 1.05rem`).

**Judgment call:** Use Newsreader font-family but keep 0.9rem font-size for comment bodies since they're in narrow threads:

```css
.comment-body {
  font-family: var(--font-prose);
  font-size: 0.9rem;
  line-height: 1.5;
}
```

Do NOT add `class="prose"` — instead set the family directly. This avoids the `max-width: 72ch` constraint from `.prose`.

- [ ] **Step 3: Update VerdictStep.svelte — verdict pill + submit button tokens**

In `src/components/VerdictStep.svelte`:

(a) Update `.submit-btn`:
```css
.submit-btn {
  align-self: flex-start;
  padding: 0.5rem 1.25rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #0a1410;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: filter 150ms;
}

.submit-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
```

(b) The verdict group and coach cards use `var(--hairline)` for borders:
```css
.verdict-group {
  border: 1px solid var(--hairline);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  /* ... */
}

.coach-card {
  border: 1px solid var(--hairline);
  /* ... */
}

.file-group {
  border: 1px solid var(--hairline);
  border-radius: 6px;
  margin-bottom: 0.75rem;
}
```

(c) Update tone chip colors to use legend vars:
```css
.tone-blunt {
  background: var(--legend-changed-bg);
  border-color: var(--legend-changed-border);
  color: var(--legend-changed-color);
}

.tone-harsh {
  background: var(--legend-removed-bg);
  border-color: var(--legend-removed-border);
  color: var(--legend-removed-color);
}

.actionable-true {
  background: var(--legend-added-bg);
  border-color: var(--legend-added-border);
  color: var(--legend-added-color);
}
```

(d) Success panel: update `.success-msg` and `.view-link` to use accent:
```css
.success-msg {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--legend-added-color);
  margin: 0;
}

.view-link {
  display: inline-block;
  padding: 0.4rem 1rem;
  border-radius: 6px;
  background: var(--accent);
  color: #0a1410;
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 600;
}
```

- [ ] **Step 4: Update RevisionPicker.svelte styles**

In `src/components/RevisionPicker.svelte`, update `<style>`:

```css
.revision-picker {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
  color: var(--text);
}

.picker-label {
  font-weight: 500;
  white-space: nowrap;
  color: var(--text-muted);
}

.picker-apply {
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: #0a1410;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
  padding: 0.15rem 0.6rem;
  white-space: nowrap;
  transition: filter 150ms;
}

.picker-apply:disabled { opacity: 0.4; cursor: not-allowed; }
.picker-apply:not(:disabled):hover { filter: brightness(1.1); }

.picker-quick {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.82rem;
  text-decoration: underline;
  padding: 0;
  white-space: nowrap;
}

.picker-quick:disabled { opacity: 0.4; cursor: not-allowed; }
.picker-quick:not(:disabled):hover { opacity: 0.75; }

.picker-age {
  font-size: 0.78rem;
  color: var(--text-muted);
  white-space: nowrap;
}
```

- [ ] **Step 5: Run svelte-check**

```bash
cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -15
```

Fix unused CSS selector warnings. Common cause: a rule for a class that no longer exists in the template after adding global classes.

- [ ] **Step 6: Run full unit tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/admin/Developing/review123 && git add src/app.css src/components/DraftThread.svelte src/components/CommentThread.svelte src/components/VerdictStep.svelte src/components/RevisionPicker.svelte
git commit -m "$(cat <<'EOF'
feat: sweep DraftThread/CommentThread/VerdictStep/RevisionPicker to tokens

Prose font (Newsreader) for comment/draft bodies. Verdict pill and submit
button use --accent. Tone chips use --legend-* vars. RevisionPicker accent
left border + --hairline. Adds .btn-danger global primitive.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Gate verification — check + test + build + e2e

- [ ] **Step 1: svelte-check**

```bash
cd /Users/admin/Developing/review123 && pnpm check 2>&1
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 2: Unit tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test 2>&1 | tail -15
```

Expected: all 1071+ tests pass (original 1066 + new time tests + new RevisionPicker age tests + updated settings/appearance tests).

- [ ] **Step 3: Build**

```bash
cd /Users/admin/Developing/review123 && pnpm build 2>&1 | tail -20
```

Expected: successful build. Check that the dist/ output contains woff2 files:

```bash
find /Users/admin/Developing/review123/dist -name "*.woff2" | wc -l
```

Expected: >0 (font files present in dist).

Verify index.html/CSS references are local (no external CDN URLs):
```bash
grep -r "fonts.googleapis\|fonts.gstatic\|cdn\." /Users/admin/Developing/review123/dist/assets/ 2>/dev/null | head -5
```

Expected: no output (no external font requests).

- [ ] **Step 4: E2E tests**

```bash
cd /Users/admin/Developing/review123 && pnpm exec playwright test 2>&1 | tail -20
```

Expected: all 15 e2e tests pass.

- [ ] **Step 5: Push branch**

```bash
cd /Users/admin/Developing/review123 && git push -u origin feat/reading-instrument-theme
```

---

## Self-Review Checklist

After writing, checking spec coverage:

**Spec Requirements → Task Coverage:**
- [x] Font imports in main.ts → Task 4, Step 1
- [x] `uiFont: 'plex'` default + `'humanist'` coercion → Task 4, Steps 2-5
- [x] Prose font (Newsreader) for .prose/.prose-md/MarkdownView contexts → app.css (Task 3) + CommentThread/DraftThread sweep (Task 7)
- [x] IBM Plex Mono via --font-mono → app.css (Task 3)
- [x] Dark palette tokens → Task 3
- [x] Light palette tokens → Task 3
- [x] --legend-* harmonization → Task 3 (values modestly adjusted for verdigris surfaces)
- [x] Button primitive (.btn, .btn-primary) → Task 3
- [x] Input/textarea/select primitive → Task 3
- [x] Card primitive (.card) → Task 3
- [x] details/summary editorial pattern → Task 3
- [x] Chip primitive (.chip) → Task 3
- [x] Dialog primitive → Task 3
- [x] Headings: 600, -0.01em, h1 1.5rem → Task 3
- [x] App topbar → Task 5
- [x] Stepper accent underline transition → Task 5
- [x] Landing card list + whitespace → Task 5
- [x] UnderstandStep glance card + churn bars → Task 6
- [x] ContextRail surface + hairline left border → Task 6
- [x] InspectStep/FileDiff mono filenames 13px → Task 6
- [x] CiSummary → Task 6
- [x] DiagramPanel legend chips → Task 6
- [x] DraftThread/CommentThread prose font → Task 7
- [x] VerdictStep verdict pill + accent → Task 7
- [x] SettingsPanel/ConsentDialog dialogs → Task 5
- [x] RevisionPicker styles → Task 7
- [x] Commit age in RevisionPicker → Task 2
- [x] relativeTime extracted to src/lib/time.ts → Task 1
- [x] SettingsPanel tests updated → Task 4
- [x] settings/appearance tests updated → Task 4
- [x] RevisionPicker tests updated → Task 2
- [x] NO external font requests (bundled) → Task 8, Step 3
- [x] pnpm build green → Task 8
- [x] pnpm exec playwright test green → Task 8
- [x] pnpm check 0 errors → every task

**Gap:** The `MarkdownView` component isn't listed as directly touched — but it renders inside CommentThread and DraftThread which get the prose font applied to their container. That's sufficient; MarkdownView doesn't need its own prose override since its content inherits from the container font.

**Judgment calls documented:**
1. `comment-body` in CommentThread uses Newsreader font-family but keeps 0.9rem size (not the 1.05rem from `.prose`) to fit narrow thread layouts — explicit override in component style.
2. `.btn-danger` added to `app.css` since DraftThread needs it and it's a legitimate primitive.
3. SettingsPanel Save/Cancel buttons get `class="btn btn-primary"` / `class="btn"` in template rather than targeting by `onclick` attribute in CSS.
4. DiagramPanel legend chip styling: add `.chip` class in template rather than heavy CSS rewrite; per-chip tint stays in component.
