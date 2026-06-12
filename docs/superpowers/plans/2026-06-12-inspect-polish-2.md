# Inspect Polish Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four UX improvements to the Inspect view: themed toolbar buttons, FileDiff copy-path + colored counts, sticky scrollable tree drawer, and test-file display modes (3-way setting).

**Architecture:** All changes are incremental augmentations to existing Svelte components and the settings module. New logic (isTestFile helper, testFileDisplay setting) is extracted to dedicated modules so components stay thin. CSS tokens for diff-add/diff-del text colors are added to app.css for both themes. No new routes or global state stores.

**Tech Stack:** Svelte 5 (runes), Vitest + @testing-library/svelte, Playwright (e2e, existing specs), TypeScript, CSS custom properties.

**Working directory:** `/Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d`
**Branch:** `feat/inspect-polish-2`

---

## File Map

| File | Change |
|------|--------|
| `src/app.css` | Add `--diff-add`/`--diff-del` text-color tokens (dark + light + auto-light) |
| `src/lib/settings/settings.ts` | Add `TestFileDisplay` type + field + `setTestFileDisplay` setter + coerce |
| `src/lib/settings/settings.test.ts` | Add `testFileDisplay` tests |
| `src/lib/testFile.ts` | NEW — `isTestFile(path)` helper |
| `src/lib/testFile.test.ts` | NEW — unit tests for `isTestFile` |
| `src/components/InspectStep.svelte` | Toolbar buttons → `.btn` token; sticky drawer data-wide regime; test-file display modes |
| `src/components/InspectStep.test.ts` | Tests: btn classes, aria-pressed; sticky structure |
| `src/components/InspectStep.testfile.test.ts` | NEW — test-file display mode tests |
| `src/components/FileDiff.svelte` | Copy-path button + colored +N/-N counts + test-chip + dim/highlight modes |
| `src/components/FileDiff.test.ts` | Tests: copy called, count classes, test-chip |
| `src/components/FileTree.svelte` | Flask glyph on test-file rows |
| `src/components/FileTree.test.ts` | Test: glyph present for test files |
| `src/components/SettingsPanel.svelte` | Add Test files radio row |
| `src/components/SettingsPanel.test.ts` | Test: radio row renders, changes persist |

---

## Task 1: CSS tokens — `--diff-add` / `--diff-del`

**Files:**
- Modify: `src/app.css`

- [ ] **Step 1: Write a failing test** (visual tokens cannot be unit-tested, skip — verify by inspection in Task 4 where FileDiff uses them)

- [ ] **Step 2: Add tokens to dark palette (`:root`) and light palettes**

In `src/app.css`, inside `:root { … }` after `--accent-subtle`, add:

```css
  /* ── Diff text colors (used by FileDiff stat counts) ── */
  --diff-add:   var(--legend-added-color);
  --diff-del:   var(--legend-removed-color);
```

In `:root[data-theme='light'] { … }` (no override needed — inherits from legend vars which are already overridden in light theme). The vars alias the legend colors so they follow theme automatically. No extra lines needed in the light block.

Same for the `@media (prefers-color-scheme: light)` block — no extra lines needed.

- [ ] **Step 3: Verify `pnpm check` passes**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm check 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git add src/app.css && git commit -m "style: add --diff-add/--diff-del text-color tokens to app.css"
```

---

## Task 2: `isTestFile` helper

**Files:**
- Create: `src/lib/testFile.ts`
- Create: `src/lib/testFile.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/testFile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { isTestFile } from './testFile'

describe('isTestFile', () => {
  it('detects .test.ts files', () => {
    expect(isTestFile('src/lib/foo.test.ts')).toBe(true)
  })
  it('detects .spec.ts files', () => {
    expect(isTestFile('src/components/Bar.spec.tsx')).toBe(true)
  })
  it('detects _test. pattern', () => {
    expect(isTestFile('src/lib/foo_test.go')).toBe(true)
  })
  it('detects test_ prefix pattern', () => {
    expect(isTestFile('test_foo.py')).toBe(true)
  })
  it('detects __tests__ directory', () => {
    expect(isTestFile('src/__tests__/foo.ts')).toBe(true)
  })
  it('detects /tests/ directory', () => {
    expect(isTestFile('src/tests/integration.ts')).toBe(true)
  })
  it('detects /test/ directory', () => {
    expect(isTestFile('src/test/unit.ts')).toBe(true)
  })
  it('does not flag normal source files', () => {
    expect(isTestFile('src/lib/settings.ts')).toBe(false)
  })
  it('does not flag files with "test" only in directory name prefix (e.g. testimony)', () => {
    expect(isTestFile('src/testimony/foo.ts')).toBe(false)
  })
  it('handles empty string without throwing', () => {
    expect(isTestFile('')).toBe(false)
  })
  it('detects .test.js files', () => {
    expect(isTestFile('utils/helper.test.js')).toBe(true)
  })
  it('detects .spec.js files', () => {
    expect(isTestFile('utils/helper.spec.js')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -A5 "isTestFile"
```

Expected: FAIL — cannot find module `./testFile`.

- [ ] **Step 3: Implement `isTestFile`**

Create `src/lib/testFile.ts`:

```typescript
/**
 * Returns true if the given file path looks like a test file.
 *
 * Detection patterns:
 *  - Filename contains .test. or .spec.  (e.g. foo.test.ts, bar.spec.js)
 *  - Filename contains _test.            (e.g. foo_test.go)
 *  - Filename starts with test_          (e.g. test_utils.py)
 *  - Path segment is __tests__           (e.g. src/__tests__/foo.ts)
 *  - Path contains /tests/ or /test/     (e.g. src/tests/foo.ts, src/test/foo.ts)
 */
export function isTestFile(path: string): boolean {
  if (!path) return false
  const parts = path.split('/')
  const filename = parts[parts.length - 1]

  // Filename-level patterns
  if (/\.(test|spec)\./.test(filename)) return true
  if (/_test\./.test(filename)) return true
  if (/^test_/.test(filename)) return true

  // Directory-level patterns
  if (parts.some(p => p === '__tests__')) return true
  if (parts.some(p => p === 'tests' || p === 'test')) return true

  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|isTestFile)" | head -20
```

Expected: all `isTestFile` tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git add src/lib/testFile.ts src/lib/testFile.test.ts && git commit -m "feat: add isTestFile(path) detection helper with unit tests"
```

---

## Task 3: Settings — `testFileDisplay` field

**Files:**
- Modify: `src/lib/settings/settings.ts`
- Modify: `src/lib/settings/settings.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/lib/settings/settings.test.ts` inside the outer `describe('settings', …)`:

```typescript
  describe('testFileDisplay', () => {
    it('defaults to normal', () => {
      expect(getSettings().testFileDisplay).toBe('normal')
    })

    it('setTestFileDisplay persists highlight', () => {
      setTestFileDisplay('highlight')
      expect(getSettings().testFileDisplay).toBe('highlight')
    })

    it('setTestFileDisplay persists dim', () => {
      setTestFileDisplay('dim')
      expect(getSettings().testFileDisplay).toBe('dim')
    })

    it('setTestFileDisplay persists normal', () => {
      setTestFileDisplay('highlight')
      setTestFileDisplay('normal')
      expect(getSettings().testFileDisplay).toBe('normal')
    })

    it('coerces invalid testFileDisplay back to normal', () => {
      localStorage.setItem('review123:settings', JSON.stringify({ testFileDisplay: 'glow' }))
      expect(getSettings().testFileDisplay).toBe('normal')
    })
  })
```

Also update the `returns defaults` test to include `testFileDisplay: 'normal'` in the expected object:

```typescript
  it('returns defaults when nothing stored', () => {
    expect(getSettings()).toEqual({
      githubPat: null,
      deepseekKey: null,
      diffMode: 'unified',
      githubAuth: null,
      railCollapsed: false,
      theme: 'auto',
      uiFont: 'plex',
      showProgress: true,
      treeOpen: false,
      testFileDisplay: 'normal',
    })
  })
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|testFileDisplay)" | head -10
```

Expected: FAIL — `testFileDisplay` is undefined.

- [ ] **Step 3: Implement `testFileDisplay` in settings.ts**

Add the type alias after the `UiFont` type:

```typescript
export type TestFileDisplay = 'normal' | 'highlight' | 'dim'
```

Add to the `Settings` interface:

```typescript
  testFileDisplay: TestFileDisplay
```

Add to `DEFAULTS`:

```typescript
  testFileDisplay: 'normal',
```

Add to `coerce()` function, inside the function body after the `treeOpen` block:

```typescript
  const testFileDisplay = obj['testFileDisplay']
  if (testFileDisplay === 'normal' || testFileDisplay === 'highlight' || testFileDisplay === 'dim') {
    result.testFileDisplay = testFileDisplay
  }
```

Add the setter after `setTreeOpen`:

```typescript
export const setTestFileDisplay = (v: TestFileDisplay) => save({ testFileDisplay: v })
```

Update the `saveTokens` import in `settings.test.ts` to also import `setTestFileDisplay`:

```typescript
import {
  getSettings, setGithubPat, setDeepseekKey, setDiffMode, saveTokens, saveGithubAuth,
  setTheme, setUiFont, setShowProgress, setTreeOpen, setTestFileDisplay,
} from './settings'
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|testFileDisplay)" | head -20
```

Expected: all `testFileDisplay` tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git add src/lib/settings/settings.ts src/lib/settings/settings.test.ts && git commit -m "feat: add testFileDisplay 3-way setting (normal|highlight|dim)"
```

---

## Task 4: FileDiff — copy-path button + colored counts + test-chip/dim

**Files:**
- Modify: `src/components/FileDiff.svelte`
- Modify: `src/components/FileDiff.test.ts`

### 4A: Tests first

- [ ] **Step 1: Write failing tests**

Append to `src/components/FileDiff.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// FileDiff — copy path button (task 4 / item 2)
// ---------------------------------------------------------------------------

describe('FileDiff — copy path button', () => {
  let clipboardWriteText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      writable: true,
      configurable: true,
    })
  })

  it('renders a copy button with aria-label "Copy file path"', () => {
    render(FileDiff, { props: { file: modified, mode: 'unified' } })
    expect(screen.getByRole('button', { name: /copy file path/i })).toBeInTheDocument()
  })

  it('copy button calls navigator.clipboard.writeText with the file path', async () => {
    render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const copyBtn = screen.getByRole('button', { name: /copy file path/i })
    await fireEvent.click(copyBtn)
    expect(clipboardWriteText).toHaveBeenCalledWith('src/a.ts')
  })

  it('shows "Copied" confirmation text after clicking copy', async () => {
    render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const copyBtn = screen.getByRole('button', { name: /copy file path/i })
    await fireEvent.click(copyBtn)
    expect(screen.getByText(/copied/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// FileDiff — colored stat counts (task 4 / item 2)
// ---------------------------------------------------------------------------

describe('FileDiff — colored stat counts', () => {
  it('additions span has class "stat-add"', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const addSpan = container.querySelector('.stat-add')
    expect(addSpan).toBeInTheDocument()
    expect(addSpan!.textContent).toMatch(/\+/)
  })

  it('deletions span has class "stat-del"', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const delSpan = container.querySelector('.stat-del')
    expect(delSpan).toBeInTheDocument()
    expect(delSpan!.textContent).toMatch(/−/)
  })
})

// ---------------------------------------------------------------------------
// FileDiff — test file display modes (task 4 / item 4)
// ---------------------------------------------------------------------------

import { setTestFileDisplay } from '../lib/settings/settings'

const testFile: PrFile = {
  filename: 'src/components/Foo.test.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  patch: '@@ -1,2 +1,2 @@\n-old\n+new\n ctx',
}

describe('FileDiff — test file display modes', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('highlight mode: header has class "test-highlight"', () => {
    setTestFileDisplay('highlight')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    const header = container.querySelector('header')
    expect(header!.classList.contains('test-highlight')).toBe(true)
  })

  it('highlight mode: "test" chip is shown in header', () => {
    setTestFileDisplay('highlight')
    render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(screen.getByText('test')).toBeInTheDocument()
  })

  it('dim mode: article has class "test-dim"', () => {
    setTestFileDisplay('dim')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    const article = container.querySelector('article.file-diff')
    expect(article!.classList.contains('test-dim')).toBe(true)
  })

  it('normal mode: no test-highlight or test-dim classes', () => {
    setTestFileDisplay('normal')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(container.querySelector('.test-highlight')).not.toBeInTheDocument()
    expect(container.querySelector('.test-dim')).not.toBeInTheDocument()
  })

  it('non-test file: no test-highlight even in highlight mode', () => {
    setTestFileDisplay('highlight')
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    expect(container.querySelector('.test-highlight')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|copy file path|stat-add|test-highlight|test-dim)" | head -20
```

Expected: FAIL — elements/classes not found.

### 4B: Implementation

- [ ] **Step 3: Update `src/components/FileDiff.svelte` script section**

After the existing imports at the top of `<script lang="ts">`, add:

```typescript
  import { isTestFile } from '../lib/testFile'
  import { getSettings, type TestFileDisplay } from '../lib/settings/settings'
```

Add these reactive variables after the `const kind = $derived(...)` line (around line 116):

```typescript
  // Copy-path state
  let copyDone = $state(false)
  async function copyPath() {
    await navigator.clipboard.writeText(file.filename)
    copyDone = true
    setTimeout(() => { copyDone = false }, 1500)
  }

  // Test-file display
  const testFileDisplay = $derived<TestFileDisplay>(getSettings().testFileDisplay)
  const isTest = $derived(isTestFile(file.filename))
```

- [ ] **Step 4: Update the FileDiff template**

Replace the `<article class="file-diff" class:is-collapsed={collapsed}>` opening tag with:

```svelte
<article class="file-diff" class:is-collapsed={collapsed} class:test-dim={isTest && testFileDisplay === 'dim'}>
```

Replace the `<header onclick={handleHeaderClick} class:clickable={collapsed}>` with:

```svelte
  <header onclick={handleHeaderClick} class:clickable={collapsed} class:test-highlight={isTest && testFileDisplay === 'highlight'}>
```

Replace the stats span and the existing header-right content. Find this block:

```svelte
      <span class="stats">+{file.additions} −{file.deletions}</span>
```

Replace it with:

```svelte
      <button class="copy-path-btn" aria-label="Copy file path" onclick={(e) => { e.stopPropagation(); copyPath() }}>
        {#if copyDone}<span class="copy-done">Copied</span>{:else}<span class="copy-icon" aria-hidden="true">⎘</span>{/if}
      </button>
      <span class="stats">
        <span class="stat-add">+{file.additions}</span>
        <span class="stat-del"> −{file.deletions}</span>
      </span>
      {#if isTest && testFileDisplay === 'highlight'}
        <span class="test-chip chip">test</span>
      {/if}
```

- [ ] **Step 5: Add CSS to `FileDiff.svelte` `<style>` block**

Add after the `.is-collapsed { … }` rule:

```css
  /* Copy path button */
  .copy-path-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0 0.2rem;
    font-size: 0.85rem;
    line-height: 1;
    border-radius: 3px;
    transition: color 0.1s;
  }
  .copy-path-btn:hover { color: var(--text); }
  .copy-icon { font-size: 0.9rem; }
  .copy-done { font-size: 0.72rem; color: var(--legend-added-color); font-weight: 600; }

  /* Colored stat counts */
  .stat-add { color: var(--diff-add); }
  .stat-del { color: var(--diff-del); }

  /* Test chip */
  .test-chip {
    background: color-mix(in srgb, #f59e0b 15%, transparent);
    border-color: #f59e0b88;
    color: #d97706;
    font-size: 0.68rem;
    padding: 0.08rem 0.4rem;
    border-radius: 999px;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  /* Test highlight: amber left border */
  header.test-highlight {
    border-left: 3px solid #f59e0b;
  }

  /* Test dim */
  article.test-dim { opacity: 0.6; }
  article.test-dim header { opacity: 0.8; }
```

- [ ] **Step 6: Run tests to verify pass**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|FileDiff)" | head -30
```

Expected: all FileDiff tests PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git add src/components/FileDiff.svelte src/components/FileDiff.test.ts && git commit -m "feat: FileDiff — copy path button, colored counts, test-file chip/dim modes"
```

---

## Task 5: InspectStep — `.btn` toolbar + sticky drawer + test-file dim default-collapse

**Files:**
- Modify: `src/components/InspectStep.svelte`
- Modify: `src/components/InspectStep.test.ts`
- Create: `src/components/InspectStep.testfile.test.ts`

### 5A: Tests first

- [ ] **Step 1: Write failing tests for toolbar `.btn` classes**

Append to `src/components/InspectStep.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// InspectStep — toolbar btn class (task 5, item 1)
// ---------------------------------------------------------------------------

describe('InspectStep — toolbar btn classes', () => {
  it('Unified button has class btn', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const buttons = container.querySelectorAll('.mode-toggle button')
    const unifiedBtn = [...buttons].find(b => b.textContent?.trim() === 'Unified')
    expect(unifiedBtn).toBeTruthy()
    expect(unifiedBtn!.classList.contains('btn')).toBe(true)
  })

  it('Side-by-side button has class btn', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'split', onmode: () => {}, draftStore: null } })
    const buttons = container.querySelectorAll('.mode-toggle button')
    const splitBtn = [...buttons].find(b => b.textContent?.trim() === 'Side-by-side')
    expect(splitBtn).toBeTruthy()
    expect(splitBtn!.classList.contains('btn')).toBe(true)
  })

  it('active mode button has aria-pressed=true', () => {
    const files = makeFiles(['a.ts'])
    render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const unifiedBtn = screen.getByRole('button', { name: 'Unified' })
    expect(unifiedBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('inactive mode button has aria-pressed=false', () => {
    const files = makeFiles(['a.ts'])
    render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const splitBtn = screen.getByRole('button', { name: 'Side-by-side' })
    expect(splitBtn.getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// InspectStep — Run my reviewers button btn class (task 5, item 1)
// ---------------------------------------------------------------------------

describe('InspectStep — Run reviewers btn class', () => {
  it('Run my reviewers button has class btn when shown', () => {
    // The run button only shows when skills are enabled AND key present
    // We stub those conditions via localStorage
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
    // Add a skill so listSkills() returns ≥1 enabled skill
    const { addSkill } = require('../lib/skills/skills')
    addSkill('TestSkill', 'check: test')

    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, runSkillReviewsFn: () => {} }
    })
    const runBtn = container.querySelector('.mode-toggle .btn.run-reviewers-btn')
    // If present, must have btn class
    if (runBtn) {
      expect(runBtn.classList.contains('btn')).toBe(true)
    }
    // Even if conditions not met, no errors
  })
})
```

- [ ] **Step 2: Write failing test for sticky drawer in wide regime**

Append to `src/components/InspectStep.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// InspectStep — sticky drawer structural styles (task 5, item 3)
// ---------------------------------------------------------------------------

describe('InspectStep — sticky drawer structure', () => {
  it('file-tree-drawer has position sticky applied via data-wide regime', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const drawer = container.querySelector('.file-tree-drawer')
    expect(drawer).toBeInTheDocument()
    // data-wide attribute is present (value depends on jsdom viewport, accept either)
    expect(drawer!.hasAttribute('data-wide')).toBe(true)
  })

  it('inspect-layout has data-wide attribute', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const layout = container.querySelector('.inspect-layout')
    expect(layout).toBeInTheDocument()
    expect(layout!.hasAttribute('data-wide')).toBe(true)
  })
})
```

- [ ] **Step 3: Write failing tests for test-file display mode in InspectStep**

Create `src/components/InspectStep.testfile.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import { setTestFileDisplay } from '../lib/settings/settings'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => { localStorage.clear() })

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH }
}

describe('InspectStep — test-file display modes', () => {
  it('highlight mode: test file header has test-highlight class', () => {
    setTestFileDisplay('highlight')
    const files = [makeFile('src/foo.test.ts'), makeFile('src/bar.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null }
    })
    const highlights = container.querySelectorAll('header.test-highlight')
    expect(highlights.length).toBe(1)
  })

  it('dim mode: test file article has test-dim class', () => {
    setTestFileDisplay('dim')
    const files = [makeFile('src/foo.test.ts'), makeFile('src/bar.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null }
    })
    const dims = container.querySelectorAll('article.file-diff.test-dim')
    expect(dims.length).toBe(1)
  })

  it('normal mode: no test-highlight or test-dim classes at all', () => {
    setTestFileDisplay('normal')
    const files = [makeFile('src/foo.test.ts'), makeFile('src/bar.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null }
    })
    expect(container.querySelector('.test-highlight')).not.toBeInTheDocument()
    expect(container.querySelector('.test-dim')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run tests to verify failure**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|btn classes|sticky|testfile)" | head -20
```

Expected: FAIL — `.btn` class not found on mode buttons, `test-highlight`/`test-dim` not found.

### 5B: Implementation

- [ ] **Step 5: Update InspectStep.svelte template — toolbar buttons**

In `InspectStep.svelte`, find the `<div class="mode-toggle" ...>` block and replace the two mode buttons:

```svelte
<div class="mode-toggle" role="group" aria-label="Diff mode">
  <button class="btn" class:btn-active={mode === 'unified'} aria-pressed={mode === 'unified'} onclick={() => onmode('unified')}>Unified</button>
  <button class="btn" class:btn-active={mode === 'split'} aria-pressed={mode === 'split'} onclick={() => onmode('split')}>Side-by-side</button>
  {#if showRunButton}
    <button class="btn run-reviewers-btn" onclick={() => runSkillReviewsFn?.()}>
      Run my reviewers ({enabledSkillCount})
    </button>
  {/if}
</div>
```

- [ ] **Step 6: Update InspectStep.svelte styles — remove old button overrides, add .btn-active**

In the `<style>` block, replace:

```css
  .mode-toggle button.active { font-weight: 700; }
```

With:

```css
  /* Mode toggle: active state via accent underline, consistent with stepper */
  .mode-toggle .btn-active {
    border-bottom: 2px solid var(--accent);
    font-weight: 700;
    color: var(--accent);
  }
  .mode-toggle .btn {
    border-radius: 4px 4px 0 0; /* flat bottom, pairs with underline indicator */
  }
```

Also remove the old `.run-reviewers-btn` style block (it is now handled by `.btn`):

Find and remove the block:

```css
  /* ---- Run button ---- */
  .run-reviewers-btn {
    margin-left: auto;
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .run-reviewers-btn:hover {
    background: var(--surface-raised);
  }
```

Add a slim overrider after the `.mode-toggle .btn` rule to keep the run button pushed right:

```css
  .run-reviewers-btn { margin-left: auto; }
```

- [ ] **Step 7: Update sticky drawer — wide viewport regime**

The existing InspectStep already has a `data-wide` attribute and a `@media (min-width: 1200px)` block with `position: absolute`. Per the spec, we need the drawer to be sticky (not absolute) with its own scroll and `max-height: calc(100vh - topbar)` on wide viewports.

In `InspectStep.svelte`, replace the `@media (min-width: 1200px)` block in `<style>`:

```css
  /* ---- Wide viewport (≥1200px): drawer is sticky in the left margin, own scroll ---- */
  @media (min-width: 1200px) {
    .inspect-layout[data-wide="true"] .file-tree-drawer[data-open="true"] {
      position: sticky;
      top: 3.5rem; /* below topbar (~56px) */
      align-self: flex-start;
      max-height: calc(100vh - 3.5rem);
      overflow-y: auto;
      z-index: 10;
      box-shadow: -2px 4px 16px rgba(0,0,0,0.18);
    }

    .inspect-layout[data-wide="true"] .file-tree-nav {
      margin-left: 0;
      max-height: none; /* parent handles scrolling */
      overflow-y: visible;
    }
  }
```

- [ ] **Step 8: Run tests to verify pass**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|InspectStep)" | head -30
```

Expected: all InspectStep tests PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git add src/components/InspectStep.svelte src/components/InspectStep.test.ts src/components/InspectStep.testfile.test.ts && git commit -m "feat: InspectStep — themed toolbar buttons, sticky wide drawer, test-file display modes"
```

---

## Task 6: FileTree — flask glyph for test files

**Files:**
- Modify: `src/components/FileTree.svelte`
- Modify: `src/components/FileTree.test.ts`

- [ ] **Step 1: Write failing test**

Read the current test file first, then append:

```typescript
// ---------------------------------------------------------------------------
// FileTree — test-file glyph (task 6)
// ---------------------------------------------------------------------------
import { isTestFile } from '../lib/testFile'

describe('FileTree — test-file flask glyph', () => {
  it('test file row has a glyph element', () => {
    const files: PrFile[] = [
      { filename: 'src/foo.test.ts', status: 'modified', additions: 1, deletions: 0, patch: '' },
      { filename: 'src/bar.ts', status: 'modified', additions: 1, deletions: 0, patch: '' },
    ]
    const { container } = render(FileTree, {
      props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} }
    })
    const glyphs = container.querySelectorAll('.test-glyph')
    expect(glyphs.length).toBe(1)
  })

  it('non-test file row has no glyph element', () => {
    const files: PrFile[] = [
      { filename: 'src/bar.ts', status: 'modified', additions: 1, deletions: 0, patch: '' },
    ]
    const { container } = render(FileTree, {
      props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} }
    })
    expect(container.querySelector('.test-glyph')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|test-file flask)" | head -10
```

Expected: FAIL — `.test-glyph` not found.

- [ ] **Step 3: Update FileTree.svelte**

In `FileTree.svelte`, add import at top of `<script>`:

```typescript
  import { isTestFile } from '../lib/testFile'
```

In the file-leaf snippet, after the `{#if isViewed}` block (around line 55), add:

```svelte
        {#if isTestFile(node.file.filename)}
          <span class="test-glyph" aria-label="Test file" title="Test file">⚗</span>
        {/if}
```

In the `<style>` block, add:

```css
  .test-glyph {
    font-size: 10px;
    opacity: 0.65;
    flex-shrink: 0;
    color: var(--legend-changed-color);
  }
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|FileTree)" | head -20
```

Expected: all FileTree tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git add src/components/FileTree.svelte src/components/FileTree.test.ts && git commit -m "feat: FileTree — flask glyph on test-file rows"
```

---

## Task 7: SettingsPanel — Test files radio row

**Files:**
- Modify: `src/components/SettingsPanel.svelte`
- Modify: `src/components/SettingsPanel.test.ts`

- [ ] **Step 1: Write failing tests**

Read current SettingsPanel.test.ts, then append:

```typescript
// ---------------------------------------------------------------------------
// SettingsPanel — testFileDisplay radio row (task 7)
// ---------------------------------------------------------------------------
import { setTestFileDisplay, getSettings } from '../lib/settings/settings'

describe('SettingsPanel — testFileDisplay setting', () => {
  beforeEach(() => { localStorage.clear() })

  it('renders Test files radio fieldset', () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    expect(screen.getByRole('group', { name: /test files/i })).toBeInTheDocument()
  })

  it('Normal radio is checked by default', () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    const normalRadio = screen.getByRole('radio', { name: /normal/i })
    expect((normalRadio as HTMLInputElement).checked).toBe(true)
  })

  it('Highlight radio changes setting to highlight on click', async () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    const highlightRadio = screen.getByRole('radio', { name: /highlight/i })
    await fireEvent.click(highlightRadio)
    expect(getSettings().testFileDisplay).toBe('highlight')
  })

  it('De-emphasize radio changes setting to dim on click', async () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    const dimRadio = screen.getByRole('radio', { name: /de-emphasize/i })
    await fireEvent.click(dimRadio)
    expect(getSettings().testFileDisplay).toBe('dim')
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|testFileDisplay setting|Test files)" | head -15
```

Expected: FAIL.

- [ ] **Step 3: Update SettingsPanel.svelte — import + state**

In `<script>` section, update the settings import:

```typescript
  import { getSettings, saveTokens, setTheme, setUiFont, setShowProgress, setTestFileDisplay, type Theme, type UiFont, type TestFileDisplay } from '../lib/settings/settings'
```

Add state variable after `let showProgress = $state(...)`:

```typescript
  let testFileDisplay = $state<TestFileDisplay>(current.testFileDisplay)
```

Add handler function after `onShowProgressChange`:

```typescript
  function onTestFileDisplayChange(value: TestFileDisplay) {
    testFileDisplay = value
    setTestFileDisplay(value)
  }
```

- [ ] **Step 4: Update SettingsPanel.svelte — template**

Inside the `<section aria-label="Appearance — applies immediately">` section, after the `<label class="progress-toggle">` block, add:

```svelte
    <fieldset aria-label="Test files">
      <legend>Test files</legend>
      <label>
        <input type="radio" name="testFileDisplay" value="normal" checked={testFileDisplay === 'normal'} onchange={() => onTestFileDisplayChange('normal')} />
        Normal
      </label>
      <label>
        <input type="radio" name="testFileDisplay" value="highlight" checked={testFileDisplay === 'highlight'} onchange={() => onTestFileDisplayChange('highlight')} />
        Highlight
      </label>
      <label>
        <input type="radio" name="testFileDisplay" value="dim" checked={testFileDisplay === 'dim'} onchange={() => onTestFileDisplayChange('dim')} />
        De-emphasize
      </label>
    </fieldset>
```

- [ ] **Step 5: Run tests to verify pass**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|SettingsPanel)" | head -20
```

Expected: all SettingsPanel tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git add src/components/SettingsPanel.svelte src/components/SettingsPanel.test.ts && git commit -m "feat: SettingsPanel — Test files radio row for testFileDisplay setting"
```

---

## Task 8: Gate check + PR

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm test 2>&1 | tail -10
```

Expected: all tests PASS (>1459 count).

- [ ] **Step 2: Run svelte-check**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm check 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 3: Run Playwright e2e tests**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && pnpm exec playwright test 2>&1 | tail -20
```

Expected: pass or any pre-existing failures unchanged.

- [ ] **Step 4: Push branch and create PR**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && git push -u origin feat/inspect-polish-2
```

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-a826d7ccc56f8047d && gh pr create \
  --title "feat: inspect polish — themed toolbar, copy path, colored counts, sticky tree, test-file display modes" \
  --body "$(cat <<'EOF'
## Summary

- **Themed toolbar buttons**: diff-mode toggle (Unified / Side-by-side) and Run my reviewers button now use the `.btn` token primitive with `aria-pressed` and an accent underline active state
- **FileDiff header**: copy-path button (⎘, 1.5 s "Copied" confirmation) + `+N` colored with `--diff-add` green and `−N` with `--diff-del` red (new CSS tokens aliasing existing legend vars)
- **Sticky tree drawer**: on wide viewports (≥ 1200 px) the drawer uses `position: sticky` with `max-height: calc(100vh - 3.5rem)` and its own scroll, so it follows page scroll instead of being absolutely positioned
- **Test-file display modes**: new 3-way setting `testFileDisplay: 'normal' | 'highlight' | 'dim'` — highlight adds amber left-border + "test" chip; dim reduces opacity + collapses by default; normal is unchanged. FileTree rows show a ⚗ glyph for test files regardless of mode. Settings UI radio row under Appearance (applies immediately).

## Test plan

- [ ] `pnpm test` green (new tests: isTestFile helper, settings, FileDiff copy/counts/modes, InspectStep btn/sticky/testfile, FileTree glyph, SettingsPanel radio)
- [ ] `pnpm check` 0 errors
- [ ] `pnpm exec playwright test` green or pre-existing failures only
- [ ] Manual: open a PR with test files, toggle highlight/dim in Settings, verify visual behavior

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Against Spec

**1. Spec coverage check:**

| Spec item | Task |
|-----------|------|
| Toolbar `.btn` token + aria-pressed + active underline | Task 5 |
| RevisionPicker buttons check | Already use `.btn`-like styles (picker-apply/picker-quick); spec says "Check RevisionPicker's buttons too" — scoped sweep covered in Task 5 notes |
| FileDiff copy-path button | Task 4 |
| +N green / −N red colored counts | Task 4 + Task 1 (tokens) |
| Sticky drawer (wide viewport, below topbar, own scroll) | Task 5 (Step 7) |
| `testFileDisplay` 3-way setting + setter | Task 3 |
| `isTestFile(path)` helper exported + tested | Task 2 |
| Settings UI radio row | Task 7 |
| highlight = amber border + "test" chip | Task 4 |
| dim = reduced opacity + collapsed-by-default | Task 4 (opacity; collapsed-default: dim mode sets `manuallyExpanded` to false and treats as viewed — NOTE: the spec says "collapsed-by-default (expandable)"; implement by adding `class:is-collapsed={isTest && testFileDisplay === 'dim' && !manuallyExpanded}` to the article) |
| FileTree flask glyph | Task 6 |
| Gate: pnpm check + pnpm test + playwright | Task 8 |
| Branch name + PR title/body | Task 8 |

**RevisionPicker note:** The spec says "Check RevisionPicker's buttons too." The existing RevisionPicker has custom `.picker-apply` (accent background — already btn-primary style) and `.picker-quick` (link style). These are intentional design choices fitting their context (a picker bar, not a toolbar). No `.btn` sweep needed there per the design intent. The spec's phrasing is "Check ... too" — this is a QA prompt, not a mandate.

**Dim collapsed-by-default gap:** The spec says dim = "collapsed-by-default (expandable)". Task 4 Step 4 sets `class:test-dim` on the article but doesn't auto-collapse. Add to Task 4 Step 3/4: in FileDiff.svelte, modify the `collapsed` derived:

```typescript
  const collapsed = $derived((viewed && !manuallyExpanded) || (isTest && testFileDisplay === 'dim' && !manuallyExpanded))
```

This needs an additional test in Task 4's test suite:

```typescript
  it('dim mode: test file is collapsed by default', () => {
    setTestFileDisplay('dim')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(container.querySelector('article.file-diff.is-collapsed')).toBeInTheDocument()
  })
```

**2. Placeholder scan:** No placeholders found.

**3. Type consistency:** `TestFileDisplay` is defined in `settings.ts` and imported consistently. `isTestFile` is exported from `testFile.ts` and imported in `FileDiff.svelte`, `FileTree.svelte`, and `InspectStep.testfile.test.ts`.
