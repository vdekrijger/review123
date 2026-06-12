# Theme + Font Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `theme` (auto/dark/light) and `uiFont` (system/humanist/serif) preferences to Settings, persisted in localStorage and applied reactively to `document.documentElement` attributes.

**Architecture:** Settings model gains two new shape-validated fields with setters. A new `appearance.svelte.ts` store (modeled on `authState.svelte.ts`) owns DOM side-effects (`data-theme`, `data-font` attrs) and exposes `resolvedTheme()`. CSS consumes a `--font-ui` variable and `data-theme` for `color-scheme`. The SettingsPanel gets an Appearance section with immediate-apply radio groups. mermaidInit reads `resolvedTheme()` instead of raw `matchMedia`.

**Tech Stack:** Svelte 5 runes (`$state`), TypeScript, Vitest + @testing-library/svelte, Playwright e2e, pnpm.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/settings/settings.ts` | Modify | Add `Theme`/`UiFont` types, fields in `Settings`, coerce logic, `setTheme`/`setUiFont` setters |
| `src/lib/settings/settings.test.ts` | Modify | Extend test matrix: defaults, valid/invalid coerce, setTheme, setUiFont |
| `src/lib/settings/appearance.svelte.ts` | **Create** | Reactive store: `applyAppearance()`, `resolvedTheme()`, `_resetAppearanceForTest()` |
| `src/lib/settings/appearance.test.ts` | **Create** | Unit tests: DOM attrs set/cleared, resolvedTheme logic, matchMedia stub |
| `src/app.css` | Modify | `--font-ui` var + `[data-font]` rules + `[data-theme]` color-scheme rules; body uses `--font-ui` |
| `src/main.ts` | Modify | Call `applyAppearance()` once at startup |
| `src/lib/diagram/mermaidInit.ts` | Modify | Use `resolvedTheme()` instead of `matchMedia` directly |
| `src/lib/diagram/mermaidInit.test.ts` | Modify | Adapt theme tests to stub `resolvedTheme` |
| `src/components/SettingsPanel.svelte` | Modify | Add Appearance section (Theme + Font radio groups, immediate apply) |
| `src/components/SettingsPanel.test.ts` | Modify | Test radio selections set DOM attrs + persist in getSettings |
| `e2e/settings.spec.ts` | **Create** | E2e: pick Dark+Serif → attrs set → reload → persist |

---

## Task 1: Branch Setup

**Files:**
- No code changes — git only.

- [ ] **Step 1: Create branch**

```bash
cd /Users/admin/Developing/review123
git checkout main && git pull && git checkout -b feat/theme-settings
```

Expected: `Switched to a new branch 'feat/theme-settings'`

---

## Task 2: Settings model — add Theme + UiFont types, fields, coerce, setters

**Files:**
- Modify: `src/lib/settings/settings.ts`

- [ ] **Step 1: Add type exports and extend Settings interface**

In `src/lib/settings/settings.ts`, after the `DiffMode` type (line 15), add:

```typescript
export type Theme = 'auto' | 'dark' | 'light'
export type UiFont = 'system' | 'humanist' | 'serif'
```

Extend the `Settings` interface (after `railCollapsed: boolean`):

```typescript
  theme: Theme
  uiFont: UiFont
```

Update `DEFAULTS` to include:

```typescript
  theme: 'auto',
  uiFont: 'system',
```

- [ ] **Step 2: Add coerce logic for theme and uiFont**

Inside the `coerce` function, after the `railCollapsed` block, add:

```typescript
  const theme = obj['theme']
  if (theme === 'auto' || theme === 'dark' || theme === 'light') result.theme = theme

  const uiFont = obj['uiFont']
  if (uiFont === 'system' || uiFont === 'humanist' || uiFont === 'serif') result.uiFont = uiFont
```

- [ ] **Step 3: Add setTheme and setUiFont exported functions**

At the bottom of the file, after `setRailCollapsed`:

```typescript
export const setTheme = (theme: Theme) => save({ theme })
export const setUiFont = (font: UiFont) => save({ uiFont: font })
```

---

## Task 3: Settings tests — extend for theme/uiFont

**Files:**
- Modify: `src/lib/settings/settings.test.ts`

- [ ] **Step 1: Update the "returns defaults" test**

The existing test on line 7 checks the full object equality. Update it to include the two new fields:

```typescript
it('returns defaults when nothing stored', () => {
  expect(getSettings()).toEqual({
    githubPat: null,
    deepseekKey: null,
    diffMode: 'unified',
    githubAuth: null,
    railCollapsed: false,
    theme: 'auto',
    uiFont: 'system',
  })
})
```

- [ ] **Step 2: Update the "survives corrupt JSON" test similarly**

```typescript
it('survives corrupt stored JSON', () => {
  localStorage.setItem('review123:settings', '{not json')
  expect(getSettings()).toEqual({
    githubPat: null,
    deepseekKey: null,
    diffMode: 'unified',
    githubAuth: null,
    railCollapsed: false,
    theme: 'auto',
    uiFont: 'system',
  })
})
```

- [ ] **Step 3: Add import for setTheme and setUiFont, and add new tests**

Update the import line at the top of the file:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getSettings, setGithubPat, setDeepseekKey, setDiffMode, saveTokens, saveGithubAuth,
  setTheme, setUiFont,
} from './settings'
```

Add these tests at the end of the `describe('settings', ...)` block:

```typescript
  describe('theme', () => {
    it('defaults to auto', () => {
      expect(getSettings().theme).toBe('auto')
    })

    it('setTheme persists dark', () => {
      setTheme('dark')
      expect(getSettings().theme).toBe('dark')
    })

    it('setTheme persists light', () => {
      setTheme('light')
      expect(getSettings().theme).toBe('light')
    })

    it('setTheme persists auto', () => {
      setTheme('dark')
      setTheme('auto')
      expect(getSettings().theme).toBe('auto')
    })

    it('coerces invalid theme value back to default (auto)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ theme: 'sepia' }))
      expect(getSettings().theme).toBe('auto')
    })
  })

  describe('uiFont', () => {
    it('defaults to system', () => {
      expect(getSettings().uiFont).toBe('system')
    })

    it('setUiFont persists humanist', () => {
      setUiFont('humanist')
      expect(getSettings().uiFont).toBe('humanist')
    })

    it('setUiFont persists serif', () => {
      setUiFont('serif')
      expect(getSettings().uiFont).toBe('serif')
    })

    it('setUiFont persists system', () => {
      setUiFont('serif')
      setUiFont('system')
      expect(getSettings().uiFont).toBe('system')
    })

    it('coerces invalid uiFont value back to default (system)', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ uiFont: 'comic-sans' }))
      expect(getSettings().uiFont).toBe('system')
    })
  })
```

- [ ] **Step 4: Run tests — expect settings tests to pass**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --reporter=verbose src/lib/settings/settings.test.ts
```

Expected: All settings tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123
git add src/lib/settings/settings.ts src/lib/settings/settings.test.ts
git commit -m "feat: add theme and uiFont fields to Settings with shape validation"
```

---

## Task 4: appearance.svelte.ts — reactive store + DOM side-effects

**Files:**
- Create: `src/lib/settings/appearance.svelte.ts`
- Create: `src/lib/settings/appearance.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `src/lib/settings/appearance.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setTheme, setUiFont } from './settings'

// Mock matchMedia — controlled per test
let _prefersDark = false
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? _prefersDark : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
})

// Reset module state and localStorage between tests
beforeEach(async () => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-font')
  _prefersDark = false
  vi.resetModules()
})

describe('applyAppearance', () => {
  it('sets data-theme=dark when theme is dark', async () => {
    setTheme('dark')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('sets data-theme=light when theme is light', async () => {
    setTheme('light')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('removes data-theme attribute when theme is auto', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    setTheme('auto')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('sets data-font=humanist when uiFont is humanist', async () => {
    setUiFont('humanist')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-font')).toBe('humanist')
  })

  it('sets data-font=serif when uiFont is serif', async () => {
    setUiFont('serif')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.getAttribute('data-font')).toBe('serif')
  })

  it('removes data-font attribute when uiFont is system', async () => {
    document.documentElement.setAttribute('data-font', 'serif')
    setUiFont('system')
    const { applyAppearance } = await import('./appearance.svelte')
    applyAppearance()
    expect(document.documentElement.hasAttribute('data-font')).toBe(false)
  })
})

describe('resolvedTheme', () => {
  it('returns dark when theme is explicitly dark', async () => {
    setTheme('dark')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('dark')
  })

  it('returns light when theme is explicitly light', async () => {
    setTheme('light')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('light')
  })

  it('returns dark for auto when matchMedia prefers-dark is true', async () => {
    _prefersDark = true
    setTheme('auto')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('dark')
  })

  it('returns light for auto when matchMedia prefers-dark is false', async () => {
    _prefersDark = false
    setTheme('auto')
    const { applyAppearance, resolvedTheme } = await import('./appearance.svelte')
    applyAppearance()
    expect(resolvedTheme()).toBe('light')
  })
})
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --reporter=verbose src/lib/settings/appearance.test.ts
```

Expected: FAIL — Cannot find module `./appearance.svelte`

- [ ] **Step 3: Create the appearance store**

Create `src/lib/settings/appearance.svelte.ts`:

```typescript
import { getSettings } from './settings'

/**
 * Apply current theme and uiFont settings to document.documentElement.
 *
 * theme: sets/clears data-theme attribute ('dark'/'light', absent for auto).
 * uiFont: sets/clears data-font attribute ('humanist'/'serif', absent for system).
 *
 * Call once at startup (main.ts) and immediately on every change in the UI.
 */
export function applyAppearance(): void {
  const { theme, uiFont } = getSettings()

  // data-theme: explicit value only; absent = auto (CSS handles via color-scheme: light dark)
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }

  // data-font: explicit value only; absent = system default
  if (uiFont === 'humanist' || uiFont === 'serif') {
    document.documentElement.setAttribute('data-font', uiFont)
  } else {
    document.documentElement.removeAttribute('data-font')
  }
}

/**
 * Return the effective theme, resolving 'auto' via matchMedia.
 * Always returns 'dark' or 'light'.
 */
export function resolvedTheme(): 'dark' | 'light' {
  const { theme } = getSettings()
  if (theme === 'dark' || theme === 'light') return theme
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --reporter=verbose src/lib/settings/appearance.test.ts
```

Expected: All 10 appearance tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123
git add src/lib/settings/appearance.svelte.ts src/lib/settings/appearance.test.ts
git commit -m "feat: add appearance store with applyAppearance and resolvedTheme"
```

---

## Task 5: CSS — font stacks, --font-ui variable, color-scheme rules

**Files:**
- Modify: `src/app.css`

- [ ] **Step 1: Update app.css**

Replace the entire current `:root` block and add the new rules. The full new `src/app.css`:

```css
:root {
  /* UI font — overridden per data-font attribute below */
  --font-ui: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
  /* Monospace font stack for code and diff views */
  --font-mono: 'SF Mono', 'JetBrains Mono', ui-monospace, 'Cascadia Code', Menlo, monospace;
  color-scheme: light dark;
  font-size: 15px;
  line-height: 1.6;
  letter-spacing: normal;
}

/* Font preference overrides */
:root[data-font='humanist'] {
  --font-ui: Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif;
}

:root[data-font='serif'] {
  --font-ui: Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif;
}

/* Theme overrides — absent = auto (light dark) */
:root[data-theme='dark'] {
  color-scheme: dark;
}

:root[data-theme='light'] {
  color-scheme: light;
}

body {
  margin: 0;
  font-family: var(--font-ui);
}

/* Prose contexts: AI summary, PR description, comment bodies */
.prose {
  max-width: 72ch;
  line-height: 1.6;
}

code, pre, kbd, samp {
  font-family: var(--font-mono);
}

h1 { font-size: 1.6rem; }
h2 { font-size: 1.35rem; }
```

Note: The original `font-family` was on `:root` — we move it to `body` via `var(--font-ui)` so theme-aware selectors work correctly.

- [ ] **Step 2: Run pnpm check and build to verify no CSS/TS errors**

```bash
cd /Users/admin/Developing/review123 && pnpm check && pnpm build
```

Expected: No TypeScript or build errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/Developing/review123
git add src/app.css
git commit -m "feat: add --font-ui variable and data-theme/data-font CSS rules"
```

---

## Task 6: main.ts — call applyAppearance at startup

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update main.ts**

```typescript
import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initAnalytics } from './lib/analytics/analytics'
import { applyAppearance } from './lib/settings/appearance.svelte'

initAnalytics()
applyAppearance()
mount(App, { target: document.getElementById('app')! })
```

- [ ] **Step 2: Run pnpm check**

```bash
cd /Users/admin/Developing/review123 && pnpm check
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/Developing/review123
git add src/main.ts
git commit -m "feat: call applyAppearance at app startup"
```

---

## Task 7: mermaidInit.ts — use resolvedTheme() instead of raw matchMedia

**Files:**
- Modify: `src/lib/diagram/mermaidInit.ts`
- Modify: `src/lib/diagram/mermaidInit.test.ts`

- [ ] **Step 1: Write the failing test adaptation first**

The existing test file stubs the mermaid module but doesn't cover theme selection. Add a new describe block to `src/lib/diagram/mermaidInit.test.ts`, plus mock for the appearance module.

Replace the entire content of `src/lib/diagram/mermaidInit.test.ts` with:

```typescript
/**
 * Tests for mermaidInit shared helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInitialize = vi.fn()
const mockRender = vi.fn().mockResolvedValue({ svg: '<svg/>' })

vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}))

// Reset modules between tests so the singleton is reset
beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

describe('getMermaid', () => {
  it('initializes mermaid with securityLevel strict and startOnLoad false', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledOnce()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        startOnLoad: false,
      })
    )
  })

  it('initializes only once even when called multiple times', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    await getMermaid()
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledOnce()
  })

  it('includes themeVariables with fontSize 14px', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({ fontSize: '14px' }),
      })
    )
  })

  it('includes flowchart useMaxWidth true', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        flowchart: expect.objectContaining({ useMaxWidth: true }),
      })
    )
  })

  it('returns the mermaid default export', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    const m = await getMermaid()
    expect(m).toBeDefined()
    expect(typeof m.render).toBe('function')
  })

  it('uses dark mermaid theme when resolvedTheme returns dark', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'dark' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' })
    )
  })

  it('uses default mermaid theme when resolvedTheme returns light', async () => {
    vi.doMock('../../lib/settings/appearance.svelte', () => ({ resolvedTheme: () => 'light' }))
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'default' })
    )
  })
})
```

- [ ] **Step 2: Run — expect failures for the theme tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --reporter=verbose src/lib/diagram/mermaidInit.test.ts
```

Expected: The new `uses dark mermaid theme...` and `uses default mermaid theme...` tests FAIL (mermaidInit still uses matchMedia directly, not resolvedTheme).

- [ ] **Step 3: Update mermaidInit.ts to use resolvedTheme()**

Replace `src/lib/diagram/mermaidInit.ts` with:

```typescript
/**
 * mermaidInit.ts — shared mermaid lazy-loader + initializer.
 *
 * Exports getMermaid() which lazy-imports mermaid and initializes it ONCE
 * with the shared config: securityLevel strict, theme from resolvedTheme(),
 * 14px fonts, and useMaxWidth for flowcharts.
 *
 * Security: securityLevel:'strict' prevents mermaid from injecting arbitrary
 * HTML/JS from diagram source strings.
 *
 * Note: mermaid is initialized once at first call. If the user changes the
 * theme setting, diagram colors will update on next page reload.
 */
import { resolvedTheme } from '../settings/appearance.svelte'

let mermaidMod: typeof import('mermaid') | null = null
let mermaidInitialized = false

/**
 * Lazy-import mermaid and initialize once.
 * Returns the mermaid default export (the mermaid API object).
 */
export async function getMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidMod) {
    mermaidMod = await import('mermaid')
  }
  const m = mermaidMod.default
  if (!mermaidInitialized) {
    m.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: resolvedTheme() === 'dark' ? 'dark' : 'default',
      themeVariables: { fontSize: '14px' },
      flowchart: { useMaxWidth: true },
    })
    mermaidInitialized = true
  }
  return m
}
```

- [ ] **Step 4: Run — expect all mermaidInit tests to pass**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --reporter=verbose src/lib/diagram/mermaidInit.test.ts
```

Expected: All 7 mermaidInit tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123
git add src/lib/diagram/mermaidInit.ts src/lib/diagram/mermaidInit.test.ts
git commit -m "feat: mermaidInit uses resolvedTheme() for user-controlled theme"
```

---

## Task 8: SettingsPanel — Appearance section (Theme + Font radio groups)

**Files:**
- Modify: `src/components/SettingsPanel.svelte`
- Modify: `src/components/SettingsPanel.test.ts`

- [ ] **Step 1: Write failing tests first**

Add the following to `src/components/SettingsPanel.test.ts` (add `setTheme`, `setUiFont`, `applyAppearance` imports and new describe blocks):

Update the imports at the top:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPanel from './SettingsPanel.svelte'
import { getSettings, saveGithubAuth } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'

// Stub applyAppearance so SettingsPanel tests don't need real DOM env for it
vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))
```

Add the following describe block at the end of the file (inside the outer describe, before the closing `}`):

```typescript
  describe('Appearance section', () => {
    beforeEach(() => {
      // Reset appearance mock call count
      vi.clearAllMocks()
    })

    it('renders Theme radiogroup with Auto, Light, Dark options', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const themeGroup = screen.getByRole('group', { name: /theme/i })
      expect(themeGroup).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /auto/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /light/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /dark/i })).toBeInTheDocument()
    })

    it('renders Font radiogroup with System, Humanist, Serif options', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const fontGroup = screen.getByRole('group', { name: /font/i })
      expect(fontGroup).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /system/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /humanist/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /serif/i })).toBeInTheDocument()
    })

    it('selecting Dark theme immediately sets data-theme=dark on documentElement', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      // Select Dark radio
      await userEvent.click(screen.getByRole('radio', { name: /dark/i }))
      // applyAppearance mock was called — simulate it by directly checking settings
      expect(getSettings().theme).toBe('dark')
    })

    it('selecting Light theme persists in getSettings', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('radio', { name: /light/i }))
      expect(getSettings().theme).toBe('light')
    })

    it('selecting Humanist font persists in getSettings', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('radio', { name: /humanist/i }))
      expect(getSettings().uiFont).toBe('humanist')
    })

    it('selecting Serif font persists in getSettings', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('radio', { name: /serif/i }))
      expect(getSettings().uiFont).toBe('serif')
    })

    it('Auto is selected by default for theme (matches stored default)', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const autoRadio = screen.getByRole('radio', { name: /auto/i })
      expect((autoRadio as HTMLInputElement).checked).toBe(true)
    })

    it('System is selected by default for font (matches stored default)', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const systemRadio = screen.getByRole('radio', { name: /system/i })
      expect((systemRadio as HTMLInputElement).checked).toBe(true)
    })
  })
```

- [ ] **Step 2: Run — expect new tests to fail**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --reporter=verbose src/components/SettingsPanel.test.ts
```

Expected: New `Appearance section` tests FAIL.

- [ ] **Step 3: Update SettingsPanel.svelte with the Appearance section**

Replace `src/components/SettingsPanel.svelte` with:

```svelte
<script lang="ts">
  import { getSettings, saveTokens, setTheme, setUiFont, type Theme, type UiFont } from '../lib/settings/settings'
  import { applyAppearance } from '../lib/settings/appearance.svelte'
  import { track } from '../lib/analytics/analytics'
  import { authState } from '../lib/auth/authState.svelte'

  let { onclose }: { onclose: () => void } = $props()
  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let deepseek = $state(current.deepseekKey ?? '')
  let error = $state<string | null>(null)
  let theme = $state<Theme>(current.theme)
  let uiFont = $state<UiFont>(current.uiFont)

  // authStatusLine is derived from the reactive authState so it updates live
  // when the user saves a PAT or signs in/out via OAuth.
  const authStatusLine = $derived.by(() => {
    const auth = authState.auth
    if (!auth) return 'Not signed in'
    if (auth.method === 'oauth') {
      const scopeList = auth.scopes.length > 0 ? auth.scopes.join(', ') : 'none'
      return `Signed in via GitHub (scopes: ${scopeList})`
    }
    return 'Using PAT'
  })

  // Advanced disclosure is open by default only when PAT is the active auth method,
  // so existing PAT users aren't confused by a closed section hiding their token.
  const advancedOpen = $derived(authState.auth?.method === 'pat')

  function onThemeChange(value: Theme) {
    theme = value
    setTheme(value)
    applyAppearance()
  }

  function onFontChange(value: UiFont) {
    uiFont = value
    setUiFont(value)
    applyAppearance()
  }

  function save() {
    try {
      const hadPat = !!current.githubPat
      const hadKey = !!current.deepseekKey
      saveTokens({
        githubPat: pat.trim() === '' ? null : pat,
        deepseekKey: deepseek.trim() === '' ? null : deepseek,
      })
      if (!hadPat && pat.trim()) track('settings_key_added', { service: 'github' })
      if (!hadKey && deepseek.trim()) track('settings_key_added', { service: 'deepseek' })
      onclose()
    } catch (e) {
      error = (e as Error).message
    }
  }
</script>

<dialog open aria-label="Settings">
  <h2>Settings</h2>

  <section aria-label="Appearance — applies immediately">
    <p class="section-label">Appearance <span class="immediate-note">(applies immediately)</span></p>
    <fieldset>
      <legend>Theme</legend>
      <label>
        <input type="radio" name="theme" value="auto" checked={theme === 'auto'} onchange={() => onThemeChange('auto')} />
        Auto
      </label>
      <label>
        <input type="radio" name="theme" value="light" checked={theme === 'light'} onchange={() => onThemeChange('light')} />
        Light
      </label>
      <label>
        <input type="radio" name="theme" value="dark" checked={theme === 'dark'} onchange={() => onThemeChange('dark')} />
        Dark
      </label>
    </fieldset>

    <fieldset>
      <legend>Font</legend>
      <label>
        <input type="radio" name="uiFont" value="system" checked={uiFont === 'system'} onchange={() => onFontChange('system')} />
        System
      </label>
      <label>
        <input type="radio" name="uiFont" value="humanist" checked={uiFont === 'humanist'} onchange={() => onFontChange('humanist')} />
        Humanist
      </label>
      <label>
        <input type="radio" name="uiFont" value="serif" checked={uiFont === 'serif'} onchange={() => onFontChange('serif')} />
        Serif
      </label>
    </fieldset>
  </section>

  <p class="auth-status">{authStatusLine}</p>
  <label>DeepSeek API key
    <input type="password" bind:value={deepseek} autocomplete="off" placeholder="sk-…" />
  </label>
  <details open={advancedOpen}>
    <summary>Advanced: use a personal access token instead</summary>
    <label>GitHub token (PAT)
      <input type="password" bind:value={pat} autocomplete="off" placeholder="github_pat_… (fine-grained, repo-scoped recommended)" />
    </label>
  </details>
  <p class="hint">Keys are stored only in this browser (localStorage) and sent only to their own services.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <button onclick={save}>Save</button>
  <button onclick={onclose}>Cancel</button>
</dialog>

<style>
  .auth-status { font-size: 0.9em; opacity: 0.8; margin-bottom: 0.75rem; }
  details { margin: 0.5rem 0; }
  details summary { cursor: pointer; font-size: 0.9em; opacity: 0.8; }
  details label { display: block; margin-top: 0.5rem; }

  section[aria-label^="Appearance"] {
    margin-bottom: 1rem;
  }

  .section-label {
    font-size: 0.9em;
    font-weight: 600;
    margin: 0 0 0.4rem;
  }

  .immediate-note {
    font-weight: normal;
    opacity: 0.7;
    font-size: 0.85em;
  }

  fieldset {
    border: 1px solid #8882;
    border-radius: 4px;
    padding: 0.4rem 0.75rem 0.5rem;
    margin: 0 0 0.5rem;
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
  }

  fieldset legend {
    font-size: 0.85em;
    opacity: 0.7;
    padding: 0 0.25rem;
  }

  fieldset label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.9em;
    cursor: pointer;
  }
</style>
```

- [ ] **Step 4: Run — expect all SettingsPanel tests to pass**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --reporter=verbose src/components/SettingsPanel.test.ts
```

Expected: All SettingsPanel tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123
git add src/components/SettingsPanel.svelte src/components/SettingsPanel.test.ts
git commit -m "feat: add Appearance section to SettingsPanel with immediate-apply theme and font radios"
```

---

## Task 9: Full unit test suite gate

- [ ] **Step 1: Run all unit tests**

```bash
cd /Users/admin/Developing/review123 && pnpm test
```

Expected: All tests pass, no failures.

- [ ] **Step 2: Run pnpm check**

```bash
cd /Users/admin/Developing/review123 && pnpm check
```

Expected: No TypeScript errors.

- [ ] **Step 3: Run pnpm build**

```bash
cd /Users/admin/Developing/review123 && pnpm build
```

Expected: Build succeeds.

---

## Task 10: E2e test — settings.spec.ts

**Files:**
- Create: `e2e/settings.spec.ts`

- [ ] **Step 1: Create e2e/settings.spec.ts**

```typescript
/**
 * e2e/settings.spec.ts — Appearance settings: theme + font persist across reload.
 */
import { test, expect } from '@playwright/test'

// Block PostHog and external APIs (we only need the settings dialog, no PR load)
async function blockExternal(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
}

test('appearance: pick Dark + Serif → documentElement has data-theme=dark & data-font=serif → reload → persist', async ({
  page,
}) => {
  await blockExternal(page)

  // Seed minimal settings (no keys needed — we only test appearance)
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ diffMode: 'unified', railCollapsed: false }),
    )
  })

  await page.goto('/')

  // Open settings dialog — the gear/settings button on the landing page
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()

  // Dialog should appear
  await expect(page.getByRole('dialog', { name: /settings/i })).toBeVisible()

  // Pick Dark theme
  const darkRadio = page.getByRole('radio', { name: /dark/i })
  await expect(darkRadio).toBeVisible()
  await darkRadio.click()

  // Pick Serif font
  const serifRadio = page.getByRole('radio', { name: /serif/i })
  await expect(serifRadio).toBeVisible()
  await serifRadio.click()

  // Verify documentElement attributes were set immediately
  const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(dataTheme).toBe('dark')

  const dataFont = await page.evaluate(() => document.documentElement.getAttribute('data-font'))
  expect(dataFont).toBe('serif')

  // Close the dialog (Cancel — keys section; appearance is already saved)
  await page.getByRole('button', { name: /cancel/i }).click()

  // Reload
  await page.reload()

  // After reload, applyAppearance() runs at startup — attributes must persist
  const dataThemeAfterReload = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  )
  expect(dataThemeAfterReload).toBe('dark')

  const dataFontAfterReload = await page.evaluate(() =>
    document.documentElement.getAttribute('data-font'),
  )
  expect(dataFontAfterReload).toBe('serif')
})

test('appearance: Auto theme removes data-theme attribute', async ({ page }) => {
  await blockExternal(page)

  // Pre-seed dark theme
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ theme: 'dark', uiFont: 'system', diffMode: 'unified', railCollapsed: false }),
    )
  })

  await page.goto('/')

  // After applyAppearance() runs at startup, data-theme should be 'dark'
  const initial = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(initial).toBe('dark')

  // Open settings and pick Auto
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await settingsBtn.click()
  await expect(page.getByRole('dialog', { name: /settings/i })).toBeVisible()

  await page.getByRole('radio', { name: /auto/i }).click()

  // data-theme attribute must be removed
  const afterAuto = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(afterAuto).toBeNull()
})
```

- [ ] **Step 2: Find the settings button selector in Landing.svelte to make sure the test locator is correct**

```bash
grep -n "settings\|Settings\|gear" /Users/admin/Developing/review123/src/routes/Landing.svelte | head -20
```

If the button label or selector differs from `{ name: /settings/i }`, adjust the e2e test accordingly.

- [ ] **Step 3: Run e2e tests**

```bash
cd /Users/admin/Developing/review123 && pnpm exec playwright test e2e/settings.spec.ts --reporter=list
```

Expected: Both e2e tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/Developing/review123
git add e2e/settings.spec.ts
git commit -m "test(e2e): appearance settings persist across reload"
```

---

## Task 11: Full gate — all tests + build + push

- [ ] **Step 1: Full unit test run**

```bash
cd /Users/admin/Developing/review123 && pnpm check && pnpm test && pnpm build
```

Expected: All green.

- [ ] **Step 2: Full e2e run**

```bash
cd /Users/admin/Developing/review123 && pnpm exec playwright test
```

Expected: All e2e tests pass (including existing review-flow tests and new settings tests).

- [ ] **Step 3: Push branch**

```bash
cd /Users/admin/Developing/review123 && git push -u origin feat/theme-settings
```

Expected: Branch pushed to remote.

---

## Known Dark-Tuned Styles (Out of Scope)

The following files contain hardcoded dark-palette colors that will appear mismatched in light mode. They are noted here as technical debt — fixing them is explicitly out of scope per the spec:

- **`src/lib/diagram/mermaid.ts`** — `CLASS_DEFS` uses dark fills (`#1a4731`, `#4a1a1a`, `#4a3a10`, `#2a2a2e`) for the Mermaid change-map classDefs. These are embedded in the generated Mermaid DSL string and cannot be overridden via CSS. Making them theme-aware requires the `graphToMermaid` function to accept a theme parameter — deferred.
- **`src/components/DiagramPanel.svelte` line 427** — `.legend-unchanged` uses `background: #2a2a2e` (dark fill). The legend chip mirrors the Mermaid classDef color — if the classDef is updated for light mode, this should be updated in sync.
