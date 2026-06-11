# UnderstandStep V2 — User Feedback Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four screenshot-confirmed UX issues in UnderstandStep: markdown rendering for PR description/summary, robust reading-order parsing, mermaid dark-theme and size fixes, and a new "at a glance" card layout.

**Architecture:** Four independent work streams that build on each other: (1) `MarkdownView.svelte` + `mermaidInit.ts` shared utilities, (2) tasks.ts prompt/parse hardening, (3) DiagramPanel overlay size, (4) UnderstandStep glance-card restructure wiring it all together. Tests-first via vitest; e2e selectors updated for new layout.

**Tech Stack:** Svelte 5, TypeScript, Vitest + @testing-library/svelte, Playwright, mermaid (lazy-loaded), marked + DOMPurify (existing renderMarkdown), pnpm

---

## Branch Setup

- [ ] **Step 0: Create branch**

```bash
cd /Users/admin/Developing/review123
git checkout main && git pull && git checkout -b feat/understand-v2
```

---

## Task 1: Extract `mermaidInit.ts` shared helper

**Files:**
- Create: `src/lib/diagram/mermaidInit.ts`
- Modify: `src/components/DiagramPanel.svelte` (use the new helper)
- Test: `src/lib/diagram/mermaidInit.test.ts`

### Motivation
DiagramPanel and the upcoming MarkdownView both need mermaid. Extract a `getMermaid()` helper that: lazy-imports mermaid ONCE, initializes ONCE with `securityLevel:'strict'`, `startOnLoad:false`, `theme:'dark'` when the OS prefers dark, `themeVariables:{fontSize:'14px'}`, and `flowchart:{useMaxWidth:true}`.

### Step 1.1 — Write failing test for mermaidInit

- [ ] Create `src/lib/diagram/mermaidInit.test.ts`:

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
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    await getMermaid()
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledOnce()
  })

  it('includes themeVariables with fontSize 14px', async () => {
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({ fontSize: '14px' }),
      })
    )
  })

  it('includes flowchart useMaxWidth true', async () => {
    const { getMermaid } = await import('./mermaidInit')
    await getMermaid()
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        flowchart: expect.objectContaining({ useMaxWidth: true }),
      })
    )
  })

  it('returns the mermaid default export', async () => {
    const { getMermaid } = await import('./mermaidInit')
    const m = await getMermaid()
    expect(m).toBeDefined()
    expect(typeof m.render).toBe('function')
  })
})
```

- [ ] Run test to confirm it fails:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/lib/diagram/mermaidInit.test.ts 2>&1 | tail -20
```

Expected: FAIL (module not found)

### Step 1.2 — Create `src/lib/diagram/mermaidInit.ts`

- [ ] Create the file:

```typescript
/**
 * mermaidInit.ts — shared mermaid lazy-loader + initializer.
 *
 * Exports getMermaid() which lazy-imports mermaid and initializes it ONCE
 * with the shared config: securityLevel strict, dark theme when OS prefers
 * dark, 14px fonts, and useMaxWidth for flowcharts.
 *
 * Security: securityLevel:'strict' prevents mermaid from injecting arbitrary
 * HTML/JS from diagram source strings.
 */

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
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches

    m.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: prefersDark ? 'dark' : 'default',
      themeVariables: { fontSize: '14px' },
      flowchart: { useMaxWidth: true },
    })
    mermaidInitialized = true
  }
  return m
}
```

- [ ] Run test to confirm it passes:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/lib/diagram/mermaidInit.test.ts 2>&1 | tail -20
```

Expected: PASS (5 tests)

### Step 1.3 — Update DiagramPanel to use getMermaid from mermaidInit

- [ ] Edit `src/components/DiagramPanel.svelte`. Replace the inline `getMermaid` function and module-level state with an import of the shared helper.

In the `<script lang="ts">` block, replace:

```typescript
  // Mermaid module (lazy-loaded once)
  let mermaidMod: typeof import('mermaid') | null = null
  let mermaidInitialized = false

  async function getMermaid(): Promise<typeof import('mermaid')['default']> {
    if (!mermaidMod) {
      mermaidMod = await import('mermaid')
    }
    const m = mermaidMod.default
    if (!mermaidInitialized) {
      // EC-14j: strict security level, no autostart
      m.initialize({ securityLevel: 'strict', startOnLoad: false })
      mermaidInitialized = true
    }
    return m
  }
```

with:

```typescript
  import { getMermaid } from '../lib/diagram/mermaidInit'
```

(Remove the two `let mermaidMod` / `let mermaidInitialized` lines and the local `getMermaid` function; keep `import { getMermaid }` at the top of the script block.)

- [ ] Run DiagramPanel tests to confirm still passing:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/components/DiagramPanel.test.ts 2>&1 | tail -20
```

Expected: same pass count as before (no regressions)

### Step 1.4 — DiagramPanel overlay resize (92vw / 88vh)

- [ ] In DiagramPanel.svelte's `<style>` section, find `.overlay-content` and change `max-width: 90vw` / `max-height: 90vh` to:

```css
  .overlay-content {
    background: #fff;
    border-radius: 8px;
    padding: 2rem;
    width: 92vw;
    height: 88vh;
    max-width: 92vw;
    max-height: 88vh;
    overflow: auto;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .overlay-content :global(svg) {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    flex: 1 1 auto;
  }
```

- [ ] Run all tests:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/components/DiagramPanel.test.ts 2>&1 | tail -10
```

Expected: PASS

### Step 1.5 — Commit Task 1

```bash
cd /Users/admin/Developing/review123 && git add src/lib/diagram/mermaidInit.ts src/lib/diagram/mermaidInit.test.ts src/components/DiagramPanel.svelte && git commit -m "feat: extract mermaidInit helper; dark theme, 14px fonts, 92vw overlay"
```

---

## Task 2: Create `MarkdownView.svelte` with mermaid fence post-processing

**Files:**
- Create: `src/components/MarkdownView.svelte`
- Create: `src/components/MarkdownView.test.ts`

### Motivation
PR descriptions and summaries contain raw markdown. `MarkdownView` renders via `renderMarkdown(source)` (already sanitized) and post-processes mermaid fences: finds `pre > code.language-mermaid` elements and replaces them with rendered SVGs. Falls back gracefully to leaving the code block if mermaid fails.

### Step 2.1 — Write failing tests for MarkdownView

- [ ] Create `src/components/MarkdownView.test.ts`:

```typescript
/**
 * MarkdownView component tests.
 *
 * Mermaid is mocked; renderMarkdown output is real (uses marked+DOMPurify).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/svelte'
import MarkdownView from './MarkdownView.svelte'

// ---------------------------------------------------------------------------
// Mock mermaid via the shared mermaidInit helper
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn()
const mockRender = vi.fn().mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"/>' })

vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"/>' })
})

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

describe('MarkdownView — markdown rendering', () => {
  it('renders ## heading as h2 element', () => {
    const { container } = render(MarkdownView, { props: { source: '## Hello World' } })
    expect(container.querySelector('h2')).not.toBeNull()
    expect(container.querySelector('h2')?.textContent).toContain('Hello World')
  })

  it('renders **bold** as strong', () => {
    const { container } = render(MarkdownView, { props: { source: '**bold text**' } })
    expect(container.querySelector('strong')).not.toBeNull()
  })

  it('strips <script> tags (XSS)', () => {
    const { container } = render(MarkdownView, { props: { source: 'Text <script>alert(1)<\/script>' } })
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('alert(1)')
  })

  it('renders plain text without errors', () => {
    const { container } = render(MarkdownView, { props: { source: 'just some text' } })
    expect(container.textContent).toContain('just some text')
  })

  it('handles empty source without error', () => {
    expect(() => render(MarkdownView, { props: { source: '' } })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Mermaid fence replacement
// ---------------------------------------------------------------------------

describe('MarkdownView — mermaid fence replacement', () => {
  it('replaces pre>code.language-mermaid with SVG container when mermaid.render resolves', async () => {
    const source = '```mermaid\nflowchart TD\n  A --> B\n```'
    const { container } = render(MarkdownView, { props: { source } })

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled()
    })

    // The SVG container should be in the DOM
    await waitFor(() => {
      expect(container.querySelector('[data-mermaid-container]')).not.toBeNull()
    })
  })

  it('calls mermaid.render with the fence content', async () => {
    const fenceContent = 'flowchart TD\n  A --> B'
    const source = `\`\`\`mermaid\n${fenceContent}\n\`\`\``
    render(MarkdownView, { props: { source } })

    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled()
    })

    // The second arg to mermaid.render should contain the fence content
    const callArg = mockRender.mock.calls[0][1] as string
    expect(callArg).toContain('flowchart TD')
  })

  it('leaves code block as-is when mermaid.render rejects', async () => {
    mockRender.mockRejectedValueOnce(new Error('parse error'))
    const source = '```mermaid\ninvalid\n```'
    const { container } = render(MarkdownView, { props: { source } })

    // Give async effect time to run
    await new Promise((r) => setTimeout(r, 100))

    // code block should still be in the DOM
    const codeEl = container.querySelector('code.language-mermaid')
    expect(codeEl).not.toBeNull()
    // No mermaid container added
    expect(container.querySelector('[data-mermaid-container]')).toBeNull()
  })

  it('does NOT call mermaid.render for non-mermaid fenced code blocks', async () => {
    const source = '```js\nconsole.log("hi")\n```'
    render(MarkdownView, { props: { source } })

    // Give async time to run
    await new Promise((r) => setTimeout(r, 100))
    expect(mockRender).not.toHaveBeenCalled()
  })
})
```

- [ ] Run to confirm failure:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/components/MarkdownView.test.ts 2>&1 | tail -15
```

Expected: FAIL (module not found)

### Step 2.2 — Create `src/components/MarkdownView.svelte`

- [ ] Create the file:

```svelte
<script lang="ts">
  /**
   * MarkdownView — renders Markdown source to sanitized HTML.
   *
   * Security: uses {@html} ONLY with output of renderMarkdown() which runs
   * marked → DOMPurify. This is the ONLY acceptable use of {@html} here,
   * following the CommentEditor / UnderstandStep precedent.
   *
   * Post-processing: after mount, finds pre>code.language-mermaid blocks
   * (marked emits that class for ```mermaid fences) and replaces each with
   * a rendered SVG container. On mermaid render error the code block is left
   * as-is. Uses the shared getMermaid() helper (initialized once, dark theme).
   */
  import { onMount } from 'svelte'
  import { renderMarkdown } from '../lib/markdown/render'
  import { getMermaid } from '../lib/diagram/mermaidInit'

  interface Props {
    source: string
  }

  let { source }: Props = $props()

  // Container div for post-processing mermaid fences
  let container = $state<HTMLDivElement | null>(null)

  // Rendered HTML (sanitized)
  const html = $derived(renderMarkdown(source))

  // After each render, post-process mermaid fences
  let mermaidCounter = 0
  $effect(() => {
    // Depend on html so this re-runs when source changes
    void html
    const el = container
    if (!el) return

    // Run asynchronously so the DOM is settled after {@html} update
    const handle = setTimeout(() => postProcessMermaid(el), 0)
    return () => clearTimeout(handle)
  })

  async function postProcessMermaid(el: HTMLDivElement) {
    const codeBlocks = el.querySelectorAll<HTMLElement>('pre > code.language-mermaid')
    if (codeBlocks.length === 0) return

    let m: Awaited<ReturnType<typeof getMermaid>>
    try {
      m = await getMermaid()
    } catch {
      return // mermaid failed to load — leave blocks as-is
    }

    for (const codeEl of Array.from(codeBlocks)) {
      const pre = codeEl.parentElement
      if (!pre) continue

      const diagramText = codeEl.textContent ?? ''
      const id = `mermaid-view-${++mermaidCounter}`

      try {
        const { svg } = await m.render(id, diagramText)
        const wrapper = document.createElement('div')
        wrapper.setAttribute('data-mermaid-container', '')
        wrapper.innerHTML = svg
        pre.replaceWith(wrapper)
      } catch {
        // Leave the code block as-is on parse/render error
      }
    }
  }
</script>

<div class="markdown-view" bind:this={container}>
  <!-- {@html} is acceptable ONLY with renderMarkdown() output (sanitization boundary) -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html html}
</div>

<style>
  .markdown-view {
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .markdown-view :global(h1),
  .markdown-view :global(h2),
  .markdown-view :global(h3),
  .markdown-view :global(h4) {
    margin: 0.75em 0 0.25em;
    font-size: 1em;
    font-weight: 600;
  }

  .markdown-view :global(p) { margin: 0 0 0.5em; }
  .markdown-view :global(p:last-child) { margin-bottom: 0; }
  .markdown-view :global(ul),
  .markdown-view :global(ol) { margin: 0 0 0.5em; padding-left: 1.5em; }
  .markdown-view :global(li) { margin: 0.15em 0; }
  .markdown-view :global(pre) { background: #8882; padding: 0.5rem; border-radius: 4px; overflow-x: auto; }
  .markdown-view :global(code) { font-size: 0.85em; background: #8881; padding: 0.1em 0.3em; border-radius: 3px; }
  .markdown-view :global(pre code) { background: none; padding: 0; }

  /* Mermaid SVG containers */
  .markdown-view :global([data-mermaid-container]) {
    overflow-x: auto;
    margin: 0.5em 0;
  }

  .markdown-view :global([data-mermaid-container] svg) {
    max-width: 100%;
    height: auto;
  }
</style>
```

- [ ] Run tests to confirm they pass:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/components/MarkdownView.test.ts 2>&1 | tail -20
```

Expected: PASS (all tests)

### Step 2.3 — Commit Task 2

```bash
cd /Users/admin/Developing/review123 && git add src/components/MarkdownView.svelte src/components/MarkdownView.test.ts && git commit -m "feat: add MarkdownView with mermaid fence post-processing"
```

---

## Task 3: Harden reading-order contract in tasks.ts (sentinel blocks)

**Files:**
- Modify: `src/lib/ai/tasks.ts`
- Modify: `src/lib/ai/tasks.test.ts`

### Motivation
The model didn't emit the exact heading text, so the legacy heading-based strip/parse missed it and the raw path list rendered in the UI. Fix by instructing the model to use an exact sentinel block format `===READING-ORDER===` … `===END===`, updating parse/strip to handle both formats, and adding a defensive trailing-path-run strip.

### Step 3.1 — Write failing tests first

- [ ] Open `src/lib/ai/tasks.test.ts` and add these new test cases to the end of the file:

```typescript
// ---------------------------------------------------------------------------
// PROMPT_VERSION ≥ 3 (bumped for sentinel contract)
// ---------------------------------------------------------------------------

describe('PROMPT_VERSION v3', () => {
  it('is at least 3 (bumped for sentinel reading-order contract)', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// summarizePrompt — sentinel instructions
// ---------------------------------------------------------------------------

describe('summarizePrompt v3 sentinel contract', () => {
  it('system prompt instructs ending with ===READING-ORDER=== sentinel', () => {
    const { system } = summarizePrompt(makeCtx())
    expect(system).toContain('===READING-ORDER===')
    expect(system).toContain('===END===')
  })

  it('system prompt instructs NOT mentioning reading order in prose', () => {
    const { system } = summarizePrompt(makeCtx())
    // Should explicitly tell the model not to mention reading order in prose
    expect(system.toLowerCase()).toMatch(/do not mention reading order|not.*mention.*reading order|no.*reading order.*prose/i)
  })
})

// ---------------------------------------------------------------------------
// parseReadingOrder — sentinel block
// ---------------------------------------------------------------------------

describe('parseReadingOrder — sentinel block', () => {
  it('parses sentinel block correctly', () => {
    const text = `Summary prose here.

===READING-ORDER===
src/lib/router/router.ts
src/lib/router/parse.ts
src/App.svelte
===END===`
    expect(parseReadingOrder(text)).toEqual([
      'src/lib/router/router.ts',
      'src/lib/router/parse.ts',
      'src/App.svelte',
    ])
  })

  it('sentinel parse returns [] when sentinel absent', () => {
    const text = 'This is prose without any reading order block.'
    expect(parseReadingOrder(text)).toEqual([])
  })

  it('sentinel parse handles empty block between sentinels', () => {
    const text = '===READING-ORDER===\n===END==='
    expect(parseReadingOrder(text)).toEqual([])
  })

  it('legacy heading fallback still works for cached v2 outputs', () => {
    const text = `Prose.\n\nSuggested reading order:\nsrc/a.ts\nsrc/b.ts`
    expect(parseReadingOrder(text)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

// ---------------------------------------------------------------------------
// stripReadingOrder — sentinel block
// ---------------------------------------------------------------------------

describe('stripReadingOrder — sentinel block', () => {
  it('strips sentinel block from summary', () => {
    const text = `This PR adds caching.

===READING-ORDER===
src/lib/cache/cache.ts
src/routes/Review.svelte
===END===`
    const result = stripReadingOrder(text)
    expect(result).toBe('This PR adds caching.')
    expect(result).not.toContain('===READING-ORDER===')
    expect(result).not.toContain('===END===')
    expect(result).not.toContain('src/lib/cache/cache.ts')
  })

  it('sentinel strip: prose before sentinel is preserved', () => {
    const text = `Important context.\n\nMore prose.\n\n===READING-ORDER===\nsrc/a.ts\n===END===`
    const result = stripReadingOrder(text)
    expect(result).toContain('Important context.')
    expect(result).toContain('More prose.')
  })

  it('legacy heading strip still works for cached v2 outputs', () => {
    const text = `Summary.\n\nSuggested reading order:\nsrc/a.ts\nsrc/b.ts`
    const result = stripReadingOrder(text)
    expect(result).toBe('Summary.')
  })

  it('strips trailing bare-path-run (≥3 consecutive lines) defensively', () => {
    const text = `This PR refactors routing.\n\nsrc/lib/router.ts\nsrc/App.svelte\nsrc/index.ts`
    const result = stripReadingOrder(text)
    expect(result).not.toContain('src/lib/router.ts')
    expect(result).not.toContain('src/App.svelte')
    expect(result).not.toContain('src/index.ts')
    expect(result).toContain('This PR refactors routing.')
  })

  it('does NOT strip trailing section with only 2 bare paths (not ≥3)', () => {
    const text = `This PR refactors routing.\n\nsrc/lib/router.ts\nsrc/App.svelte`
    const result = stripReadingOrder(text)
    // Only 2 lines — should NOT be stripped defensively
    expect(result).toContain('src/lib/router.ts')
  })

  it('prose lines with spaces are NOT stripped by trailing-path heuristic', () => {
    const text = `This PR is great.\n\nIt has many features.\nAnd some more text.\nWith three lines.`
    const result = stripReadingOrder(text)
    // Prose lines with spaces do not match the bare-path regex
    expect(result).toContain('It has many features.')
    expect(result).toContain('And some more text.')
  })
})
```

- [ ] Run to confirm failures:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/lib/ai/tasks.test.ts 2>&1 | tail -30
```

Expected: Several tests FAIL (PROMPT_VERSION < 3, sentinel methods not yet implemented)

### Step 3.2 — Update `src/lib/ai/tasks.ts`

- [ ] Change `PROMPT_VERSION` from `2` to `3`:

```typescript
export const PROMPT_VERSION = 3
```

- [ ] Update `summarizePrompt` system prompt. Replace the current system string with:

```typescript
  const system = `You are an expert code reviewer assistant. Your role is to help engineers \
understand pull requests quickly and accurately.

Given the code changes below, produce a concise prose summary: lead with what the PR does \
and why in one sentence, then use bullet points for any important details a reviewer should \
know. Keep the prose summary to ~120 words maximum — shorter is better. Do NOT mention \
reading order anywhere in the prose.

At the very end of your response, after all prose, append a reading order block in EXACTLY \
this format (nothing after ===END===):

===READING-ORDER===
path/one
path/two
===END===

List one file path per line between the sentinels, in the order a reviewer should read them — \
most load-bearing or context-setting files first. Only include files that appear in the PR \
changes. Plain paths only — no bullets, numbers, or prefixes.`
```

- [ ] Update `parseReadingOrder` to handle sentinel format (keep legacy heading as fallback):

Replace the entire `parseReadingOrder` function with:

```typescript
export function parseReadingOrder(summaryText: string): string[] {
  const lines = summaryText.split('\n')

  // --- Primary: sentinel block ===READING-ORDER=== … ===END=== ---
  const sentinelStart = lines.findIndex((l) => l.trim() === '===READING-ORDER===')
  if (sentinelStart !== -1) {
    const paths: string[] = []
    for (let i = sentinelStart + 1; i < lines.length; i++) {
      const raw = lines[i].trim()
      if (raw === '===END===') break
      if (raw.length > 0) paths.push(raw)
    }
    return paths
  }

  // --- Fallback: legacy "Suggested reading order:" heading (cached v2 outputs) ---
  let headingIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (/suggested reading order\s*:/i.test(lines[i])) {
      headingIndex = i
      break
    }
  }

  if (headingIndex === -1) return []

  const paths: string[] = []
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '') break
    const cleaned = raw
      .trim()
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^`+|`+$/g, '')
      .trim()
    if (cleaned.length > 0) paths.push(cleaned)
  }

  return paths
}
```

- [ ] Update `stripReadingOrder` to handle sentinel format with defensive trailing-path-run strip. Replace the entire function with:

```typescript
/**
 * Strip the reading-order block from a summary string, returning only prose.
 *
 * Three strategies (applied in order, first match wins):
 *  1. Sentinel block: ===READING-ORDER=== … ===END=== (v3 contract)
 *  2. Legacy heading: "Suggested reading order:" + list block (cached v2 fallback)
 *  3. Defensive: strip trailing run of ≥3 consecutive bare file-path lines
 *     (catches prompt-noncompliant models)
 *
 * A "bare file-path line" matches: ^[\w@./-]+\.[\w]+$ or ^[\w@./-]+/[\w@./-]+$
 */
export function stripReadingOrder(summaryText: string): string {
  const lines = summaryText.split('\n')

  // --- Strategy 1: sentinel block ---
  const sentinelStart = lines.findIndex((l) => l.trim() === '===READING-ORDER===')
  if (sentinelStart !== -1) {
    const sentinelEnd = lines.findIndex((l, i) => i > sentinelStart && l.trim() === '===END===')
    const cutEnd = sentinelEnd !== -1 ? sentinelEnd + 1 : lines.length
    const result = [...lines.slice(0, sentinelStart), ...lines.slice(cutEnd)]
    return result.join('\n').trim()
  }

  // --- Strategy 2: legacy heading ---
  let headingIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (/suggested reading order\s*:/i.test(lines[i])) {
      headingIndex = i
      break
    }
  }

  if (headingIndex !== -1) {
    let listEnd = headingIndex + 1
    while (listEnd < lines.length && lines[listEnd].trim() !== '') {
      listEnd++
    }
    const before = lines.slice(0, headingIndex)
    const after = lines.slice(listEnd)
    return [...before, ...after].join('\n').trim()
  }

  // --- Strategy 3: defensive trailing bare-path-run (≥3 lines) ---
  const barePathRe = /^[\w@.\-/]+\.[\w]+$|^[\w@.\-/]+\/[\w@.\-/]+$/
  // Find the index from which trailing bare paths start
  let trailStart = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue // skip blank lines in tail
    if (barePathRe.test(line)) {
      trailStart = i
    } else {
      break
    }
  }
  const trailingCount = lines.length - trailStart
  if (trailingCount >= 3) {
    return lines.slice(0, trailStart).join('\n').trim()
  }

  return summaryText
}
```

- [ ] Run tasks tests to confirm passing:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/lib/ai/tasks.test.ts 2>&1 | tail -30
```

Expected: ALL PASS (including new tests and all legacy tests)

### Step 3.3 — Update e2e fixture to use sentinel format

The e2e `SUMMARY_TEXT` constant uses the legacy `Suggested reading order:` format. Update `e2e/review-flow.spec.ts`:

- [ ] Find `const SUMMARY_TEXT = ...` and change to sentinel format:

```typescript
const SUMMARY_TEXT =
  'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\nsrc/old-utils.ts\n===END==='
```

### Step 3.4 — Commit Task 3

```bash
cd /Users/admin/Developing/review123 && git add src/lib/ai/tasks.ts src/lib/ai/tasks.test.ts e2e/review-flow.spec.ts && git commit -m "feat: sentinel reading-order contract (v3), defensive trailing-path strip"
```

---

## Task 4: diagramsPrompt node constraints

**Files:**
- Modify: `src/lib/ai/tasks.ts` (diagramsPrompt system prompt)
- Modify: `src/lib/ai/tasks.test.ts`

### Step 4.1 — Write failing test

- [ ] Add to tasks.test.ts `describe('diagramsPrompt', ...)` block:

```typescript
  it('system prompt instructs max 12 nodes per graph', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toMatch(/12\s+nodes|12 nodes/i)
  })

  it('system prompt instructs labels ≤ 3 words', () => {
    const { system } = diagramsPrompt(makeCtx())
    expect(system).toMatch(/3 words|three words/i)
  })
```

- [ ] Run to confirm they fail:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/lib/ai/tasks.test.ts 2>&1 | grep "12\|words\|FAIL\|PASS" | tail -10
```

### Step 4.2 — Update diagramsPrompt in `src/lib/ai/tasks.ts`

- [ ] In the `diagramsPrompt` system prompt, add a constraints section before the FEW_SHOT_EXAMPLE. After the `"Choosing kind:"` paragraph and before `${FEW_SHOT_EXAMPLE}`, insert:

```
Graph size constraints (IMPORTANT):
- At most 12 nodes per graph (before and after combined). If more files are touched, \
  only include nodes whose relationships CHANGED or are needed for context.
- Node labels must be ≤ 3 words — prefer module/file names over sentences (e.g. \
  "router.ts" not "The router module that handles requests").
- Edges: only include edges that represent CHANGED or newly-added relationships.
```

(This means in the full `system` template string, after `...do not reference ids \
that do not exist in the same graph's nodes array.\n\n` and before `${FEW_SHOT_EXAMPLE}`, add the constraints paragraph.)

- [ ] Run to confirm tests pass:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/lib/ai/tasks.test.ts 2>&1 | tail -10
```

Expected: ALL PASS

### Step 4.3 — Commit Task 4

```bash
cd /Users/admin/Developing/review123 && git add src/lib/ai/tasks.ts src/lib/ai/tasks.test.ts && git commit -m "feat: diagramsPrompt node constraints (max 12, labels ≤3 words)"
```

---

## Task 5: Restructure UnderstandStep — "At a Glance" card + collapsed panels

**Files:**
- Modify: `src/components/UnderstandStep.svelte` (major restructure)
- Modify: `src/components/UnderstandStep.test.ts` (adapt tests)
- Modify: `src/routes/Review.svelte` (pass `files` prop, wire `onhotspot`)

### Motivation
Replace the current flat layout with: (1) a permanent glance card at top (verdict pill, CI badge, file/line counts, TL;DR, top-3 hotspot chips, mini churn chart), (2) all detail panels in closed `<details>` below it.

### Step 5.1 — Update UnderstandStep interface in Review.svelte

- [ ] In `src/routes/Review.svelte`, update the UnderstandStep props:

1. Add `files={load.state.files}` and `onhotspot={handleHotspot}` to the `<UnderstandStep ...>` element.

Find:
```svelte
      <UnderstandStep
        meta={load.state.meta}
        ci={ciData}
        {ciError}
        run={aiRun ?? { summary: {status:'idle'}, attention: {status:'idle'}, diagrams: {status:'idle'}, verdict: {status:'idle'}, start: async()=>{}, retry: async()=>{} } as any}
      />
```

Replace with:
```svelte
      <UnderstandStep
        meta={load.state.meta}
        files={load.state.files}
        ci={ciData}
        {ciError}
        run={aiRun ?? { summary: {status:'idle'}, attention: {status:'idle'}, diagrams: {status:'idle'}, verdict: {status:'idle'}, start: async()=>{}, retry: async()=>{} } as any}
        onhotspot={handleHotspot}
      />
```

### Step 5.2 — Rewrite `src/components/UnderstandStep.svelte`

This is a large replacement. Write the complete new file:

```svelte
<script lang="ts">
  /**
   * UnderstandStep — "At a Glance" redesign (v2 user feedback round 2).
   *
   * Layout:
   *  GLANCE CARD (always visible, no expander):
   *    Row 1: verdict pill + CI badge + file count + total +/- lines
   *    Row 2: TL;DR (first sentence / 200 chars of stripped summary)
   *    Row 3: top-3 high/medium hotspot chips (clickable → jump to file)
   *    Row 4: mini churn chart (top 8 files by additions+deletions)
   *
   *  DETAILS PANELS (all collapsed by default):
   *    • Full summary     (MarkdownView of stripped summary)
   *    • Diagrams         (DiagramPanel)
   *    • Verdict evidence (evidence + notAnalyzed)
   *    • CI details       (CiSummary)
   *    • Original PR desc (MarkdownView)
   *
   * Security: MarkdownView uses renderMarkdown() internally — the ONLY
   * acceptable use of {@html} in this codebase.
   */
  import CiSummary from './CiSummary.svelte'
  import AiPanel from './AiPanel.svelte'
  import DiagramPanel from './DiagramPanel.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import { stripReadingOrder } from '../lib/ai/tasks'
  import type { PrMeta, PrFile } from '../lib/github/types'
  import type { CiSummary as CiSummaryType } from '../lib/github/checks'
  import type { AiRun } from '../lib/ai/run.svelte'
  import type { AttentionResult, GraphResult, VerdictResult } from '../lib/ai/schemas'

  interface Props {
    meta: PrMeta
    files: PrFile[]
    ci: CiSummaryType | null
    ciError: boolean
    run: AiRun
    onhotspot?: (path: string) => void
  }

  let { meta, files, ci, ciError, run, onhotspot }: Props = $props()

  // --- Derived: stripped summary ---
  const summaryText = $derived.by(() => {
    if (run.summary.status === 'done' || run.summary.status === 'streaming') {
      const raw = run.summary.value as string
      return run.summary.status === 'done' ? stripReadingOrder(raw) : raw
    }
    return ''
  })

  // --- TL;DR: first sentence / first 200 chars to sentence boundary ---
  const tldr = $derived.by(() => {
    const text = summaryText
    if (!text) return ''
    // Find first sentence boundary (. ! ?) within 200 chars
    const slice = text.slice(0, 200)
    const match = slice.match(/^.*?[.!?](?:\s|$)/)
    if (match) return match[0].trim()
    // No sentence boundary found — use the slice as-is
    return slice.trim()
  })

  // --- Attention / hotspots ---
  const attention = $derived(
    run.attention.status === 'done' ? (run.attention.value as AttentionResult) : null
  )

  const topHotspots = $derived.by(() => {
    if (!attention) return []
    return attention.hotspots
      .filter((h) => h.level === 'high' || h.level === 'medium')
      .slice(0, 3)
  })

  // --- Verdict ---
  const verdict = $derived(
    run.verdict.status === 'done' ? (run.verdict.value as VerdictResult) : null
  )

  // --- File/line stats ---
  const totalAdditions = $derived(files.reduce((s, f) => s + f.additions, 0))
  const totalDeletions = $derived(files.reduce((s, f) => s + f.deletions, 0))

  // --- Churn chart: top 8 files by additions+deletions ---
  const churns = $derived.by(() => {
    const sorted = [...files]
      .map((f) => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        churn: f.additions + f.deletions,
        // Derive attention level from attention result
        level: attention?.hotspots.find((h) => h.path === f.filename)?.level ?? null,
      }))
      .sort((a, b) => b.churn - a.churn)
      .slice(0, 8)

    const maxChurn = sorted.reduce((m, f) => Math.max(m, f.churn), 1)
    return sorted.map((f) => ({ ...f, maxChurn }))
  })

  // --- CI badge text ---
  const ciBadge = $derived.by(() => {
    if (ciError) return null
    if (!ci) return '⏳ CI loading'
    if (ci.total === 0) return null
    if (ci.pending > 0) return `⏳ ${ci.pending} pending`
    if (ci.failed === 0) return `✓ ${ci.passed} passed`
    return `✗ ${ci.failed} failed`
  })

  function handleHotspotClick(path: string) {
    onhotspot?.(path)
  }

  function truncatePath(path: string, max = 40): string {
    if (path.length <= max) return path
    const parts = path.split('/')
    const filename = parts[parts.length - 1]
    if (filename.length >= max) return '…/' + filename.slice(-max)
    return '…/' + parts.slice(-2).join('/')
  }
</script>

<div class="understand-step">

  <!-- ===== GLANCE CARD (always visible) ===== -->
  <section class="glance-card" aria-label="PR at a glance">

    <!-- Row 1: Verdict pill + CI badge + file/line counts -->
    <div class="glance-row glance-row-stats">
      {#if verdict}
        <span class="verdict-level level-{verdict.level}" aria-label="Verdict: {verdict.level}">
          {verdict.level}
        </span>
      {:else if run.verdict.status === 'loading'}
        <span class="glance-loading-pill" aria-label="Verdict loading">⏳ verdict…</span>
      {/if}

      {#if ciBadge}
        <span
          class="ci-badge"
          class:ci-pass={ci && ci.failed === 0 && ci.pending === 0 && ci.total > 0}
          class:ci-fail={ci && ci.failed > 0}
          class:ci-pending={ci && ci.pending > 0}
        >
          {ciBadge}
        </span>
      {/if}

      <span class="file-count">{files.length} file{files.length === 1 ? '' : 's'}</span>
      <span class="line-counts">
        <span class="additions">+{totalAdditions}</span>
        <span class="deletions">−{totalDeletions}</span>
      </span>
    </div>

    <!-- Row 2: TL;DR -->
    <div class="glance-row glance-row-tldr">
      {#if run.summary.status === 'streaming'}
        <!-- While streaming: show streaming text, line-clamped -->
        <p class="tldr-text tldr-streaming">{summaryText}</p>
      {:else if run.summary.status === 'loading'}
        <span class="glance-loading-inline" aria-busy="true">
          <span class="spinner-sm" aria-hidden="true"></span>
          Summarizing…
        </span>
      {:else if run.summary.status === 'no-key'}
        <span class="glance-nokey">
          <a href="#settings">Add a DeepSeek key</a> for AI summary
        </span>
      {:else if run.summary.status === 'error'}
        <span class="glance-error">
          Summary error —
          <button class="inline-retry" onclick={() => run.retry('summary')}>Retry</button>
        </span>
      {:else if tldr}
        <p class="tldr-text">{tldr}</p>
      {/if}
    </div>

    <!-- Row 3: Top-3 hotspot chips -->
    {#if topHotspots.length > 0}
      <div class="glance-row glance-row-hotspots" role="list" aria-label="Top hotspots">
        {#each topHotspots as hs (hs.path)}
          <button
            class="hotspot-chip level-{hs.level}"
            role="listitem"
            onclick={() => handleHotspotClick(hs.path)}
            title="{hs.path} — {hs.reason}"
            aria-label="{hs.path}: {hs.reason}"
          >
            <span class="chip-path">{truncatePath(hs.path, 30)}</span>
            <span class="chip-reason">{hs.reason.slice(0, 40)}{hs.reason.length > 40 ? '…' : ''}</span>
          </button>
        {/each}
      </div>
    {:else if run.attention.status === 'loading'}
      <div class="glance-row">
        <span class="glance-loading-inline" aria-busy="true">
          <span class="spinner-sm" aria-hidden="true"></span>
          Analyzing hotspots…
        </span>
      </div>
    {/if}

    <!-- Row 4: Mini churn chart (pure HTML/CSS, no dep) -->
    {#if churns.length > 0}
      <div class="glance-row glance-row-chart" aria-label="File churn chart">
        {#each churns as file (file.path)}
          <button
            class="churn-row"
            class:border-high={file.level === 'high'}
            class:border-medium={file.level === 'medium'}
            onclick={() => handleHotspotClick(file.path)}
            aria-label="{file.path}: +{file.additions} −{file.deletions}"
          >
            <span class="churn-path">{truncatePath(file.path, 35)}</span>
            <span class="churn-bar-wrap" aria-hidden="true">
              <span
                class="churn-bar churn-add"
                style="width: {(file.additions / file.maxChurn) * 100}%"
              ></span>
              <span
                class="churn-bar churn-del"
                style="width: {(file.deletions / file.maxChurn) * 100}%"
              ></span>
            </span>
            <span class="churn-nums">
              <span class="additions">+{file.additions}</span>
              <span class="deletions">−{file.deletions}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}

  </section>

  <!-- ===== COLLAPSED DETAIL PANELS ===== -->

  <!-- Full summary -->
  <details class="detail-panel summary-panel">
    <summary class="detail-summary">Full summary</summary>
    <div class="detail-body">
      <AiPanel title="Summary" state={run.summary} onretry={() => run.retry('summary')}>
        {#if run.summary.status === 'streaming'}
          <pre class="prose">{summaryText}</pre>
        {:else if run.summary.status === 'done'}
          <MarkdownView source={summaryText} />
        {/if}
      </AiPanel>
    </div>
  </details>

  <!-- Diagrams -->
  <details class="detail-panel diagrams-panel">
    <summary class="detail-summary">Diagrams</summary>
    <div class="detail-body">
      <AiPanel title="Diagrams" state={run.diagrams} onretry={() => run.retry('diagrams')}>
        {#if run.diagrams.status === 'done'}
          <DiagramPanel result={run.diagrams.value as GraphResult} panelState="idle" />
        {/if}
      </AiPanel>
    </div>
  </details>

  <!-- Verdict evidence -->
  <details class="detail-panel verdict-panel">
    <summary class="detail-summary">Verdict evidence</summary>
    <div class="detail-body">
      <AiPanel title="Verdict" state={run.verdict} onretry={() => run.retry('verdict')}>
        {#if verdict}
          {#if verdict.evidence.length > 0}
            <ul class="verdict-evidence">
              {#each verdict.evidence as item}
                <li>{item}</li>
              {/each}
            </ul>
          {/if}
          {#if verdict.notAnalyzed.length > 0}
            <div class="not-analyzed">
              <h4>Not analyzed</h4>
              <ul>
                {#each verdict.notAnalyzed as path}
                  <li>{path}</li>
                {/each}
              </ul>
            </div>
          {/if}
        {/if}
      </AiPanel>
    </div>
  </details>

  <!-- CI details -->
  <details class="detail-panel ci-panel">
    <summary class="detail-summary">CI details</summary>
    <div class="detail-body">
      <CiSummary {ci} error={ciError} />
    </div>
  </details>

  <!-- Original PR description -->
  <details class="detail-panel pr-description-details">
    <summary class="detail-summary">Original PR description</summary>
    <div class="detail-body pr-description-body">
      {#if meta.body}
        <MarkdownView source={meta.body} />
      {:else}
        <p class="no-desc">No description.</p>
      {/if}
    </div>
  </details>

</div>

<style>
  .understand-step {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* ===== Glance Card ===== */

  .glance-card {
    background: #8880;
    border: 1px solid #8882;
    border-radius: 8px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .glance-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Row 1 — stats */

  .verdict-level {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 12px;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    white-space: nowrap;
  }

  .verdict-level.level-behavior-preserved {
    color: #1a7f37;
    background: #1a7f3715;
  }

  .verdict-level.level-minor-changes {
    color: #9a6700;
    background: #9a670015;
  }

  .verdict-level.level-significant-changes {
    color: #cf222e;
    background: #cf222e15;
  }

  .glance-loading-pill {
    font-size: 0.8rem;
    opacity: 0.6;
    padding: 0.2rem 0.6rem;
    border: 1px solid #8884;
    border-radius: 12px;
  }

  .ci-badge {
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.2rem 0.5rem;
    border-radius: 10px;
    background: #8882;
    white-space: nowrap;
  }

  .ci-badge.ci-pass { color: #1a7f37; background: #1a7f3715; }
  .ci-badge.ci-fail { color: #cf222e; background: #cf222e15; }
  .ci-badge.ci-pending { color: #9a6700; background: #9a670015; }

  .file-count {
    font-size: 0.85rem;
    opacity: 0.7;
    white-space: nowrap;
  }

  .line-counts {
    font-size: 0.85rem;
    display: flex;
    gap: 0.3rem;
    white-space: nowrap;
  }

  .additions { color: #1a7f37; font-weight: 500; }
  .deletions { color: #cf222e; font-weight: 500; }

  /* Row 2 — TL;DR */

  .glance-row-tldr {
    align-items: flex-start;
  }

  .tldr-text {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
    line-height: 1.45;
  }

  .tldr-streaming {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-weight: 400;
    font-size: 0.9rem;
    opacity: 0.8;
  }

  .glance-loading-inline {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    opacity: 0.65;
  }

  .glance-nokey,
  .glance-error {
    font-size: 0.85rem;
    opacity: 0.8;
  }

  .inline-retry {
    font-size: inherit;
    background: none;
    border: none;
    cursor: pointer;
    color: #2563eb;
    padding: 0;
    text-decoration: underline;
  }

  .spinner-sm {
    display: inline-block;
    width: 0.75em;
    height: 0.75em;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Row 3 — hotspot chips */

  .glance-row-hotspots {
    gap: 0.4rem;
  }

  .hotspot-chip {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    border: 1px solid #8883;
    background: none;
    cursor: pointer;
    font-size: 0.75rem;
    text-align: left;
    max-width: 200px;
    transition: background 0.1s;
  }

  .hotspot-chip:hover { background: #8881; }

  .hotspot-chip.level-high { border-color: #cf222e55; }
  .hotspot-chip.level-medium { border-color: #9a670055; }

  .chip-path {
    font-family: monospace;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .chip-reason {
    opacity: 0.65;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  /* Row 4 — mini churn chart */

  .glance-row-chart {
    flex-direction: column;
    align-items: stretch;
    gap: 0.15rem;
  }

  .churn-row {
    display: grid;
    grid-template-columns: 1fr 3fr auto;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.4rem;
    border: none;
    border-left: 3px solid transparent;
    background: none;
    cursor: pointer;
    border-radius: 0 4px 4px 0;
    font-size: 0.78rem;
    text-align: left;
    transition: background 0.1s;
    width: 100%;
  }

  .churn-row:hover { background: #8881; }

  .churn-row.border-high { border-left-color: #cf222e; }
  .churn-row.border-medium { border-left-color: #9a6700; }

  .churn-path {
    font-family: monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.85;
  }

  .churn-bar-wrap {
    display: flex;
    height: 8px;
    border-radius: 3px;
    overflow: hidden;
    background: #8882;
    gap: 1px;
  }

  .churn-bar {
    height: 100%;
    min-width: 1px;
    border-radius: 2px;
  }

  .churn-add { background: #1a7f37; }
  .churn-del { background: #cf222e; }

  .churn-nums {
    display: flex;
    gap: 0.25rem;
    font-size: 0.7rem;
    white-space: nowrap;
  }

  /* ===== Detail panels ===== */

  .detail-panel {
    border: 1px solid #8882;
    border-radius: 6px;
    overflow: hidden;
  }

  .detail-summary {
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    list-style: none;
    user-select: none;
    background: #8880;
  }

  .detail-summary::-webkit-details-marker { display: none; }
  .detail-summary::before { content: '▶ '; font-size: 0.7em; opacity: 0.6; }
  details[open] > .detail-summary::before { content: '▼ '; }

  .detail-body {
    padding: 0.75rem;
    border-top: 1px solid #8882;
  }

  /* Summary panel prose styles */
  .detail-body .prose {
    font-family: inherit;
    white-space: pre-wrap;
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
  }

  /* ===== Verdict evidence ===== */

  .verdict-evidence {
    margin: 0 0 0.5rem 0;
    padding-left: 1.5em;
    font-size: 0.9rem;
  }

  .not-analyzed {
    margin-top: 0.5rem;
  }

  .not-analyzed h4 {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
    font-weight: 600;
    opacity: 0.75;
  }

  .not-analyzed ul {
    margin: 0;
    padding-left: 1.5em;
    font-size: 0.85rem;
    font-family: monospace;
    opacity: 0.8;
  }

  .no-desc {
    margin: 0;
    font-style: italic;
    opacity: 0.6;
    font-size: 0.9rem;
  }
</style>
```

### Step 5.3 — Run unit tests (expect failures due to test restructure)

- [ ] Run UnderstandStep tests to see what needs updating:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/components/UnderstandStep.test.ts 2>&1 | tail -40
```

### Step 5.4 — Update UnderstandStep tests

The existing tests look for the old structure (`.pr-description-details` with `open=false`, `.diagrams-details` with `open=true`, `pre.prose`, etc.). Update them for the new structure where everything is in `<details>` with `open=false` by default.

- [ ] Replace `src/components/UnderstandStep.test.ts` with:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import UnderstandStep from './UnderstandStep.svelte'
import type { AiRun } from '../lib/ai/run.svelte'
import type { VerdictResult, AttentionResult } from '../lib/ai/schemas'
import type { PrMeta, PrFile } from '../lib/github/types'

// Mock mermaid for MarkdownView
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg/>' }),
  },
}))

const meta: PrMeta = {
  title: 'Test PR',
  state: 'open',
  merged: false,
  body: 'PR desc with ## Heading',
  baseSha: 'base',
  headSha: 'head',
  private: false,
  changedFiles: 2,
}

const files: PrFile[] = [
  { filename: 'src/a.ts', status: 'modified', additions: 10, deletions: 5 },
  { filename: 'src/b.ts', status: 'added', additions: 20, deletions: 0 },
]

function makeRun(overrides: Partial<AiRun>): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    start: async () => {},
    retry: async () => {},
    ...overrides,
  }
}

/** Open all <details> elements so their content is queryable. */
function openAllDetails() {
  document.querySelectorAll('details').forEach((d) => { d.open = true })
}

// ---------------------------------------------------------------------------
// EC-15c/d — notAnalyzed shown/hidden
// ---------------------------------------------------------------------------

describe('UnderstandStep verdict notAnalyzed (EC-15c/d)', () => {
  it('hides notAnalyzed section when empty', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['clean'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.queryByText('Not analyzed')).not.toBeInTheDocument()
  })

  it('shows notAnalyzed section when non-empty', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['e1'],
      notAnalyzed: ['skipped.ts'],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
    expect(screen.getByText('skipped.ts')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Glance card — verdict pill
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — verdict pill', () => {
  it('shows verdict pill in glance card when verdict is done', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: [],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    expect(container.querySelector('.verdict-level')).not.toBeNull()
    expect(container.querySelector('.verdict-level')?.textContent).toContain('minor-changes')
  })

  it('shows loading pill while verdict is loading', () => {
    const run = makeRun({ verdict: { status: 'loading' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(screen.getByLabelText(/verdict loading/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Glance card — file/line counts
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — file/line counts', () => {
  it('shows file count', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    expect(screen.getByText(/2 files/i)).toBeInTheDocument()
  })

  it('shows total additions from files', () => {
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run: makeRun({}) },
    })
    // +30 total additions
    expect(container.textContent).toContain('+30')
  })

  it('shows total deletions from files', () => {
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run: makeRun({}) },
    })
    // −5 total deletions
    expect(container.textContent).toContain('−5')
  })
})

// ---------------------------------------------------------------------------
// Glance card — TL;DR
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — TL;DR', () => {
  it('shows first sentence of stripped summary as TL;DR', () => {
    const summaryWithOrder =
      'This PR adds caching. More detail here.\n\n===READING-ORDER===\nsrc/a.ts\n===END==='
    const run = makeRun({ summary: { status: 'done', value: summaryWithOrder } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(screen.getByText('This PR adds caching.')).toBeInTheDocument()
  })

  it('shows streaming text (clamped) while streaming', () => {
    const run = makeRun({ summary: { status: 'streaming', value: 'Streaming summary text' } })
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    expect(container.querySelector('.tldr-streaming')).not.toBeNull()
  })

  it('shows "Add a DeepSeek key" link for no-key status', () => {
    const run = makeRun({ summary: { status: 'no-key' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Glance card — hotspot chips (EC-06h)
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — hotspot chips', () => {
  it('shows top-3 high/medium hotspot chips', () => {
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [
        { path: 'src/a.ts', reason: 'Critical change', level: 'high' },
        { path: 'src/b.ts', reason: 'Medium risk', level: 'medium' },
        { path: 'src/c.ts', reason: 'Also medium', level: 'medium' },
        { path: 'src/d.ts', reason: 'Low concern', level: 'low' }, // should be excluded
      ],
      testFlags: [],
    }
    const run = makeRun({ attention: { status: 'done', value: attention } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    // Should show 3 chips (top-3 high/medium, excluding low)
    const chips = document.querySelectorAll('.hotspot-chip')
    expect(chips.length).toBe(3)
  })

  it('calls onhotspot when chip is clicked', async () => {
    const onhotspot = vi.fn()
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/a.ts', reason: 'Risk', level: 'high' }],
      testFlags: [],
    }
    const run = makeRun({ attention: { status: 'done', value: attention } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run, onhotspot } })
    const chip = document.querySelector('.hotspot-chip') as HTMLButtonElement
    chip?.click()
    expect(onhotspot).toHaveBeenCalledWith('src/a.ts')
  })
})

// ---------------------------------------------------------------------------
// Glance card — mini churn chart
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — churn chart', () => {
  it('shows churn chart rows for files', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const rows = document.querySelectorAll('.churn-row')
    expect(rows.length).toBe(2) // two files in fixtures
  })

  it('each churn row has aria-label', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const rows = document.querySelectorAll('.churn-row[aria-label]')
    expect(rows.length).toBe(2)
  })

  it('calls onhotspot when churn row clicked', () => {
    const onhotspot = vi.fn()
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}), onhotspot } })
    const firstRow = document.querySelector('.churn-row') as HTMLButtonElement
    firstRow?.click()
    expect(onhotspot).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Detail panels — all collapsed by default
// ---------------------------------------------------------------------------

describe('UnderstandStep detail panels', () => {
  it('all detail panels are collapsed by default', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const details = document.querySelectorAll('details')
    details.forEach((d) => {
      expect(d.open).toBe(false)
    })
  })

  it('PR description is inside a collapsed <details> with "Original PR description" summary', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const prDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/original pr description/i)
    )
    expect(prDetails).not.toBeUndefined()
    expect((prDetails as HTMLDetailsElement).open).toBe(false)
  })

  it('PR description renders ## heading as h2 when opened (MarkdownView)', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const prDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/original pr description/i)
    ) as HTMLDetailsElement
    prDetails.open = true
    // MarkdownView renders ## as h2
    expect(prDetails.querySelector('h2')).not.toBeNull()
  })

  it('diagrams panel is a <details> with "Diagrams" summary', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const diagramsDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/diagrams/i)
    )
    expect(diagramsDetails).not.toBeUndefined()
  })

  it('done-state summary renders markdown when "Full summary" panel opened', () => {
    const summaryWithHeading = '## What\nThis PR adds caching.\n\n===READING-ORDER===\nsrc/a.ts\n===END==='
    const run = makeRun({ summary: { status: 'done', value: summaryWithHeading } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    // MarkdownView inside full-summary panel renders h2 from ## heading
    expect(container.querySelector('h2')).not.toBeNull()
  })

  it('done-state summary: <script> is stripped (XSS)', () => {
    const summaryWithScript = 'Good PR. <script>alert(1)<\/script>'
    const run = makeRun({ summary: { status: 'done', value: summaryWithScript } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(container.querySelector('script')).toBeNull()
  })

  it('done-state summary: strips reading-order sentinel from display', () => {
    const summaryWithOrder = 'This PR refactors routing.\n\n===READING-ORDER===\nsrc/router.ts\nsrc/app.ts\n===END==='
    const run = makeRun({ summary: { status: 'done', value: summaryWithOrder } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(container.textContent).not.toContain('===READING-ORDER===')
    expect(container.textContent).not.toContain('src/router.ts')
    expect(container.textContent).toContain('This PR refactors routing.')
  })
})

// ---------------------------------------------------------------------------
// Panel states via AiPanel (still shown in collapsed panels)
// ---------------------------------------------------------------------------

describe('UnderstandStep panel states via AiPanel', () => {
  it('shows Retry button on summary error', () => {
    const run = makeRun({ summary: { status: 'error', error: 'something went wrong' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('shows "AI analysis declined" for declined status', () => {
    const run = makeRun({ summary: { status: 'declined' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText(/AI analysis declined/i)).toBeInTheDocument()
  })
})
```

- [ ] Run tests to confirm they pass:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run src/components/UnderstandStep.test.ts 2>&1 | tail -40
```

Expected: ALL PASS

### Step 5.5 — Run full unit test suite

- [ ] Run all unit tests to confirm no regressions:

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run 2>&1 | tail -20
```

Expected: ≥623 tests passing, no regressions

### Step 5.6 — Commit Task 5

```bash
cd /Users/admin/Developing/review123 && git add src/components/UnderstandStep.svelte src/components/UnderstandStep.test.ts src/routes/Review.svelte && git commit -m "feat: UnderstandStep at-a-glance card, all details collapsed, MarkdownView for PR desc"
```

---

## Task 6: Update e2e selectors for new layout

**Files:**
- Modify: `e2e/review-flow.spec.ts`

### Motivation
The e2e flow spec asserts visibility of summary/verdict/diagram content by selectors like `.verdict-level`, `.understand-step`, and checks that PR description details is collapsed. With the new layout, all detail panels are collapsed, the verdict level is in the glance card (not inside a `<details>`), and the CI check is shown inline as the CI badge.

### Step 6.1 — Update test 2 in `e2e/review-flow.spec.ts`

The key changes needed:
- The PR description check previously opened `.pr-description-details` — it's now `details.pr-description-details` still (class name preserved).
- Verdict level `.understand-step .verdict-level` still works (it's now in the glance card, not nested).
- The `CI: Integration tests` text was from the CiSummary panel — now CI is in the CI badge in the glance card (and in the CI details panel). Need to open the CI details panel OR check the badge.
- Diagrams: just assert the diagrams panel exists (it's collapsed by default).

- [ ] In `e2e/review-flow.spec.ts`, in "Test 2", update the CI check from:

```typescript
  // CI: should show failure (Integration tests failed)
  await expect(page.getByText(/Integration tests/i)).toBeVisible({ timeout: 10_000 })
```

to:

```typescript
  // CI badge in glance card should show failure
  await expect(page.locator('.ci-badge.ci-fail')).toBeVisible({ timeout: 10_000 })
```

- [ ] Update the PR description check from:

```typescript
  // PR description is inside a collapsed <details> — open it first to check
  const prDescDetails = page.locator('.pr-description-details')
  await prDescDetails.evaluate((el: HTMLDetailsElement) => { el.open = true })
  await expect(page.getByText('This PR adds a new feature for testing.')).toBeVisible()
```

to:

```typescript
  // PR description is inside a collapsed <details> — open it first to check
  const prDescDetails = page.locator('details.pr-description-details')
  await prDescDetails.evaluate((el: HTMLDetailsElement) => { el.open = true })
  await expect(page.getByText('This PR adds a new feature for testing.')).toBeVisible()
```

- [ ] Run e2e tests:

```bash
cd /Users/admin/Developing/review123 && pnpm exec playwright test 2>&1 | tail -30
```

Expected: all e2e tests pass. If tests fail with selector issues, examine the error and adjust selectors accordingly.

### Step 6.2 — Commit Task 6

```bash
cd /Users/admin/Developing/review123 && git add e2e/review-flow.spec.ts && git commit -m "fix(e2e): update selectors for new UnderstandStep glance-card layout"
```

---

## Task 7: Final gate

- [ ] **pnpm check:**

```bash
cd /Users/admin/Developing/review123 && pnpm check 2>&1 | tail -20
```

Expected: No type errors.

- [ ] **pnpm test:**

```bash
cd /Users/admin/Developing/review123 && pnpm test -- --run 2>&1 | tail -20
```

Expected: All tests passing (≥623 + new tests added).

- [ ] **pnpm build:**

```bash
cd /Users/admin/Developing/review123 && pnpm build 2>&1 | tail -20
```

Expected: Build succeeds.

- [ ] **pnpm exec playwright test:**

```bash
cd /Users/admin/Developing/review123 && pnpm exec playwright test 2>&1 | tail -30
```

Expected: All e2e tests pass.

---

## Self-Review Against Spec

### Spec Coverage Check

| Spec Requirement | Task | Status |
|---|---|---|
| 1. MarkdownView component renders renderMarkdown() via @html | Task 2 | ✓ |
| 1. MarkdownView: post-processes mermaid fences, lazy-imports mermaid | Task 2 | ✓ |
| 1. MarkdownView: error leaves code block as-is | Task 2 | ✓ |
| 1. MarkdownView tests: h2 from ##, script stripped, mermaid fence replaced, render reject fallback | Task 2 | ✓ |
| 1. Used for PR description AND summary panel | Task 5 | ✓ |
| 2. summarizePrompt: sentinel block format | Task 3 | ✓ |
| 2. parseReadingOrder: sentinel parse + legacy fallback | Task 3 | ✓ |
| 2. stripReadingOrder: sentinel + legacy + defensive trailing-path-run (≥3) | Task 3 | ✓ |
| 2. PROMPT_VERSION bumped to 3 | Task 3 | ✓ |
| 2. Tests: sentinel parse/strip; legacy fallback; trailing bare-path-run stripped; prose untouched | Task 3 | ✓ |
| 3. mermaidInit.ts: getMermaid() singleton helper | Task 1 | ✓ |
| 3. theme: dark when prefers-color-scheme: dark | Task 1 | ✓ |
| 3. themeVariables: fontSize 14px | Task 1 | ✓ |
| 3. flowchart: useMaxWidth true | Task 1 | ✓ |
| 3. DiagramPanel uses mermaidInit | Task 1 | ✓ |
| 3. diagramsPrompt: max 12 nodes, labels ≤ 3 words | Task 4 | ✓ |
| 3. DiagramPanel overlay ~92vw/88vh | Task 1 | ✓ |
| 3. Tests: mermaidInit called once, theme passed | Task 1 | ✓ |
| 4. Glance card: Row 1 verdict pill + CI badge + file count + +/- lines | Task 5 | ✓ |
| 4. Glance card: Row 2 TL;DR (first sentence) | Task 5 | ✓ |
| 4. Glance card: Row 3 top-3 hotspot chips, clickable | Task 5 | ✓ |
| 4. Glance card: Row 4 mini churn chart, stacked bar, attention border | Task 5 | ✓ |
| 4. All details panels collapsed by default | Task 5 | ✓ |
| 4. Full summary, Diagrams, Verdict evidence, CI details, PR description panels | Task 5 | ✓ |
| 4. While streaming: TL;DR shows streaming text line-clamped | Task 5 | ✓ |
| 4. EC-15c/d (notAnalyzed shown/hidden) intact | Task 5 | ✓ |
| 4. EC-06h (hotspot click) intact | Task 5 | ✓ |
| 4. `files: PrFile[]` prop passed from Review.svelte | Task 5 | ✓ |
| 4. `onhotspot` prop wired from Review.svelte | Task 5 | ✓ |
| e2e: flow spec updated for new layout | Task 6 | ✓ |
| Gate: pnpm check + test + build + playwright green | Task 7 | ✓ |

### Potential Issues / Judgment Calls

1. **MarkdownView `$effect` timing**: The mermaid post-processing runs via `setTimeout(0)` after `{@html}` renders. In JSDOM tests this is synchronous via `waitFor`. In the real browser this works correctly.

2. **mermaidInit singleton reset**: The `vi.resetModules()` in the mermaidInit test resets the module singleton between tests. This is required for the "initialized only once" test to work correctly.

3. **Defensive trailing-path-run**: The regex `^[\w@.\-/]+\.[\w]+$|^[\w@.\-/]+\/[\w@.\-/]+$` will match `src/index.ts` but NOT `This is prose with spaces.` — correct behavior.

4. **Churn chart aria-label**: Each `.churn-row` gets `aria-label="{path}: +{add} −{del}"` — covers accessibility requirement.

5. **e2e CI badge selector**: The e2e test now checks `.ci-badge.ci-fail` instead of text content "Integration tests" — this is more robust as CiSummary details are now in a collapsed panel.

6. **ContextRail unchanged**: The spec says "ContextRail unchanged" — we do not touch ContextRail.svelte.
