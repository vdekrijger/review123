# Review 1-2-3 — Plan A: Foundation + Diff Viewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Svelte 5 SPA where pasting a GitHub PR URL renders the PR's diffs (unified/side-by-side, red/green, word-level highlights) inside the 1-2-3 stepper shell, with settings, analytics, CI, and Vercel config in place.

**Architecture:** Pure static SPA (Vite + Svelte 5 + TS). Browser calls api.github.com directly. `lib/` modules are pure and unit-tested; UI components are thin. Plan B adds review write-back + OAuth; Plan C adds AI.

**Tech Stack:** pnpm (`minimumReleaseAge: 10080`), Vite, Svelte 5 (runes), TypeScript, Vitest + @testing-library/svelte, `@git-diff-view/svelte` + `@git-diff-view/file`, posthog-js, GitHub Actions, Vercel.

**Criteria covered (must-haves):** REQ-01 (EC-01a,b,h,i,j,l,o), REQ-04 partial (EC-04a,c,e,h — PAT storage/use; scope guidance lands in Plan B), REQ-05 (EC-05a,b,c,g,i,j,k), REQ-06 (EC-06b,c,h), REQ-18 (EC-18a–h), REQ-20 partial (EC-20d; rest in Plans B/C as rail content arrives).

---

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `index.html`, `src/main.ts`, `src/App.svelte`, `src/app.css`, `src/vite-env.d.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Verify pnpm ≥ 10.16** (needed for `minimumReleaseAge`)

Run: `pnpm --version`
Expected: `>= 10.16.0`. If missing/old: `corepack enable && corepack prepare pnpm@latest --activate`.

- [ ] **Step 2: Write package.json**

```json
{
  "name": "review123",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 3: Write pnpm-workspace.yaml** (supply-chain gate — the spec's 7-day rule)

```yaml
packages:
  - '.'
minimumReleaseAge: 10080
```

- [ ] **Step 4: Install dependencies**

```bash
pnpm add svelte @git-diff-view/svelte @git-diff-view/file posthog-js
pnpm add -D vite @sveltejs/vite-plugin-svelte typescript svelte-check vitest jsdom @testing-library/svelte @testing-library/jest-dom @tsconfig/svelte
```

Expected: success. If a package is blocked by `minimumReleaseAge`, pin the previous version (this is the gate working, not a bug).

- [ ] **Step 5: Write vite.config.ts**

```ts
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
})
```

Create `src/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

Note: `test` key needs a triple-slash reference; add at top of vite.config.ts:

```ts
/// <reference types="vitest/config" />
```

- [ ] **Step 6: Write tsconfig.json**

```json
{
  "extends": "@tsconfig/svelte/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

- [ ] **Step 7: Write svelte.config.js, index.html, src shell**

`svelte.config.js`:

```js
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
export default { preprocess: vitePreprocess() }
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Review 1-2-3</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/main.ts`:

```ts
import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, { target: document.getElementById('app')! })
export default app
```

`src/App.svelte` (placeholder shell, replaced in Task 9):

```svelte
<main>
  <h1>Review 1-2-3</h1>
</main>
```

`src/app.css`:

```css
:root { font-family: system-ui, sans-serif; color-scheme: light dark; }
body { margin: 0; }
```

`src/vite-env.d.ts`:

```ts
/// <reference types="svelte" />
/// <reference types="vite/client" />
```

Append to `.gitignore`: `dist/`, `.vercel/`, `coverage/`.

- [ ] **Step 8: Verify dev server and build work**

Run: `pnpm build && pnpm check`
Expected: build succeeds to `dist/`, svelte-check passes with 0 errors.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: scaffold Vite + Svelte 5 + TS with pnpm minimumReleaseAge"
```

---

### Task 2: CI workflow + Vercel config

**Files:**
- Create: `.github/workflows/ci.yml`, `vercel.json`

- [ ] **Step 1: Write .github/workflows/ci.yml**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Write vercel.json** (SPA fallback; `/api/*` excluded so the Plan B OAuth function routes normally)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

- [ ] **Step 3: Verify tests run in CI shape locally**

Run: `pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build`
Expected: all pass (vitest exits 0 with "no test files" until Task 3 — pass `--passWithNoTests` in package.json test script: `"test": "vitest run --passWithNoTests"`).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "ci: add GitHub Actions workflow and Vercel SPA config"
```

---

### Task 3: lib/settings — keys + preferences (REQ-04 partial)

**Files:**
- Create: `src/lib/settings/settings.ts`
- Test: `src/lib/settings/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setGithubPat, setDeepseekKey, setDiffMode } from './settings'

describe('settings', () => {
  beforeEach(() => localStorage.clear())

  it('returns defaults when nothing stored', () => {
    expect(getSettings()).toEqual({ githubPat: null, deepseekKey: null, diffMode: 'unified' })
  })

  it('stores and retrieves a PAT', () => {
    setGithubPat('ghp_abc123')
    expect(getSettings().githubPat).toBe('ghp_abc123')
  })

  it('rejects empty PAT (EC-04a)', () => {
    expect(() => setGithubPat('')).toThrow('empty')
    expect(() => setGithubPat('   ')).toThrow('empty')
    expect(getSettings().githubPat).toBeNull()
  })

  it('trims whitespace-padded PAT (EC-04b)', () => {
    setGithubPat('  ghp_x  ')
    expect(getSettings().githubPat).toBe('ghp_x')
  })

  it('clears a PAT via null', () => {
    setGithubPat('ghp_x')
    setGithubPat(null)
    expect(getSettings().githubPat).toBeNull()
  })

  it('persists diff mode preference', () => {
    setDiffMode('split')
    expect(getSettings().diffMode).toBe('split')
  })

  it('survives corrupt stored JSON', () => {
    localStorage.setItem('review123:settings', '{not json')
    expect(getSettings()).toEqual({ githubPat: null, deepseekKey: null, diffMode: 'unified' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/settings`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/lib/settings/settings.ts**

```ts
const KEY = 'review123:settings'

export type DiffMode = 'unified' | 'split'
export interface Settings {
  githubPat: string | null
  deepseekKey: string | null
  diffMode: DiffMode
}

const DEFAULTS: Settings = { githubPat: null, deepseekKey: null, diffMode: 'unified' }

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(patch: Partial<Settings>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...getSettings(), ...patch }))
}

function setToken(field: 'githubPat' | 'deepseekKey', value: string | null): void {
  if (value === null) return save({ [field]: null })
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must not be empty`)
  save({ [field]: trimmed })
}

export const setGithubPat = (v: string | null) => setToken('githubPat', v)
export const setDeepseekKey = (v: string | null) => setToken('deepseekKey', v)
export const setDiffMode = (mode: DiffMode) => save({ diffMode: mode })
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm vitest run src/lib/settings`

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings && git commit -m "feat: settings module with PAT/key storage and validation"
```

---

### Task 4: lib/analytics — PostHog wrapper with privacy choke-point (REQ-18, all musts)

**Files:**
- Create: `src/lib/analytics/analytics.ts`
- Test: `src/lib/analytics/analytics.test.ts`

The wrapper is allowlist-based: events and their permitted properties are declared in a schema; anything else is dropped. This makes EC-18a/b/h structural, not conventional.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { track, _setCaptureForTest } from './analytics'

describe('analytics privacy choke-point', () => {
  const capture = vi.fn()
  beforeEach(() => { capture.mockClear(); _setCaptureForTest(capture) })

  it('sends an allowed event with allowed props (EC-18c)', () => {
    track('pr_loaded', { visibility: 'public', file_count: 12, primary_language: 'ts' })
    expect(capture).toHaveBeenCalledWith('pr_loaded', {
      visibility: 'public', file_count: 12, primary_language: 'ts',
    })
  })

  it('drops disallowed properties (EC-18a, EC-18h)', () => {
    track('pr_loaded', { visibility: 'public', diff_text: 'SECRET', token: 'ghp_x' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).not.toHaveProperty('diff_text')
    expect(props).not.toHaveProperty('token')
  })

  it('never sends repo identifiers for private repos (EC-18b)', () => {
    track('pr_loaded', { visibility: 'private', repo: 'acme/secret' } as never)
    expect(capture.mock.calls[0][1]).not.toHaveProperty('repo')
  })

  it('records key service but never the key value (EC-18d)', () => {
    track('settings_key_added', { service: 'github', key: 'ghp_x' } as never)
    expect(capture.mock.calls[0][1]).toEqual({ service: 'github' })
  })

  it('review_submitted carries verdict and count only (EC-18e)', () => {
    track('review_submitted', { verdict: 'APPROVE', comment_count: 2, body: 'hi' } as never)
    expect(capture.mock.calls[0][1]).toEqual({ verdict: 'APPROVE', comment_count: 2 })
  })

  it('unknown events are dropped entirely', () => {
    track('rogue_event' as never, {} as never)
    expect(capture).not.toHaveBeenCalled()
  })

  it('capture failures do not throw (EC-18g)', () => {
    capture.mockImplementation(() => { throw new Error('blocked') })
    expect(() => track('pr_loaded', { visibility: 'public' })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/analytics` — Expected: FAIL.

- [ ] **Step 3: Implement src/lib/analytics/analytics.ts**

```ts
import posthog from 'posthog-js'

// Allowlist schema: event -> permitted property names. The ONLY path to
// PostHog. Adding a property here is a privacy decision — never allow
// code, diffs, keys, tokens, or private repo identifiers.
const EVENTS = {
  pr_loaded: ['visibility', 'file_count', 'primary_language'],
  signed_in: ['method'],
  ai_task_completed: ['task', 'duration_ms', 'cached'],
  ai_task_failed: ['task', 'reason'],
  diagram_viewed: [],
  hotspot_clicked: [],
  ci_summary_viewed: ['conclusion'],
  comment_drafted: [],
  review_submitted: ['verdict', 'comment_count'],
  settings_key_added: ['service'],
} as const

export type EventName = keyof typeof EVENTS
export type EventProps = Record<string, string | number | boolean>

type CaptureFn = (event: string, props: Record<string, unknown>) => void
let capture: CaptureFn = (e, p) => posthog.capture(e, p)
export function _setCaptureForTest(fn: CaptureFn): void { capture = fn }

export function initAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
  if (!key) return // analytics disabled without a key
  posthog.init(key, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com',
    autocapture: false, // only typed events pass the choke-point
    capture_pageview: true,
  })
}

export function track(event: EventName, props: EventProps = {}): void {
  const allowed = EVENTS[event]
  if (!allowed) return
  const safe: Record<string, unknown> = {}
  for (const k of allowed) if (k in props) safe[k] = props[k]
  try {
    capture(event, safe)
  } catch {
    // analytics must never break the app (EC-18g)
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**, then wire `initAnalytics()` into `src/main.ts` (call before `mount`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/analytics src/main.ts && git commit -m "feat: PostHog wrapper with allowlist privacy choke-point"
```

---

### Task 5: lib/router — minimal path router (REQ-20 EC-20d groundwork)

**Files:**
- Create: `src/lib/router/router.svelte.ts`
- Test: `src/lib/router/router.test.ts`

Two routes only; a dependency is not justified. Svelte 5 runes in a `.svelte.ts` module give reactive route state.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { matchRoute } from './router.svelte'

describe('matchRoute', () => {
  it('matches landing', () => {
    expect(matchRoute('/')).toEqual({ name: 'landing' })
  })
  it('matches review route with params', () => {
    expect(matchRoute('/review/sveltejs/svelte/123')).toEqual({
      name: 'review', owner: 'sveltejs', repo: 'svelte', number: 123,
    })
  })
  it('rejects invalid PR number in deep link (EC-01o)', () => {
    expect(matchRoute('/review/a/b/abc')).toEqual({ name: 'not-found' })
    expect(matchRoute('/review/a/b/-1')).toEqual({ name: 'not-found' })
  })
  it('unknown paths are not-found', () => {
    expect(matchRoute('/nope')).toEqual({ name: 'not-found' })
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/lib/router`

- [ ] **Step 3: Implement src/lib/router/router.svelte.ts**

```ts
export type Route =
  | { name: 'landing' }
  | { name: 'review'; owner: string; repo: string; number: number }
  | { name: 'not-found' }

export function matchRoute(pathname: string): Route {
  if (pathname === '/') return { name: 'landing' }
  const m = pathname.match(/^\/review\/([^/]+)\/([^/]+)\/(\d+)$/)
  if (m) {
    const number = Number(m[3])
    if (Number.isSafeInteger(number) && number >= 1)
      return { name: 'review', owner: m[1], repo: m[2], number }
  }
  return { name: 'not-found' }
}

function currentRoute(): Route {
  return matchRoute(location.pathname)
}

export const router = $state<{ route: Route }>({ route: { name: 'landing' } })

export function startRouter(): void {
  router.route = currentRoute()
  window.addEventListener('popstate', () => { router.route = currentRoute() })
}

export function navigate(path: string): void {
  history.pushState(null, '', path)
  router.route = currentRoute()
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib/router && git commit -m "feat: minimal reactive path router"
```

---

### Task 6: lib/github/parse — PR URL parsing (REQ-01)

**Files:**
- Create: `src/lib/github/parse.ts`
- Test: `src/lib/github/parse.test.ts`

- [ ] **Step 1: Write the failing tests** (every must-have EC of REQ-01, plus the cheap nice-to-haves — they share one code path)

```ts
import { describe, it, expect } from 'vitest'
import { parsePrUrl } from './parse'

const ok = { owner: 'octo-org', repo: 'repo.js', number: 123 }

describe('parsePrUrl', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrUrl('https://github.com/octo-org/repo.js/pull/123')).toEqual({ ok: true, value: ok })
  })
  it('EC-01a: null/undefined input → error, no throw', () => {
    expect(parsePrUrl(null as never).ok).toBe(false)
    expect(parsePrUrl(undefined as never).ok).toBe(false)
  })
  it('EC-01b/EC-01c: empty and whitespace-only → "empty" error', () => {
    for (const u of ['', '   ']) {
      const r = parsePrUrl(u)
      expect(r).toEqual({ ok: false, error: 'empty' })
    }
  })
  it('EC-01h: non-numeric PR segment rejected', () => {
    expect(parsePrUrl('https://github.com/a/b/pull/abc')).toEqual({ ok: false, error: 'not-a-pr-url' })
  })
  it('EC-01i: partial URL, wrong host, issues URL → specific errors', () => {
    expect(parsePrUrl('https://github.com/onlyowner')).toEqual({ ok: false, error: 'not-a-pr-url' })
    expect(parsePrUrl('https://gitlab.com/a/b/pull/1')).toEqual({ ok: false, error: 'not-github' })
    expect(parsePrUrl('https://github.com/a/b/issues/1')).toEqual({ ok: false, error: 'not-a-pr-url' })
  })
  it('EC-01j: trailing path/query/fragment still parse', () => {
    for (const s of ['/files', '#discussion_r1', '?w=1', '/files?w=1#x']) {
      expect(parsePrUrl(`https://github.com/octo-org/repo.js/pull/123${s}`)).toEqual({ ok: true, value: ok })
    }
  })
  it('EC-01l: injection strings in segments are rejected', () => {
    expect(parsePrUrl('https://github.com/<script>/x/pull/1').ok).toBe(false)
    expect(parsePrUrl('https://github.com/a%00b/x/pull/1').ok).toBe(false)
  })
  it('EC-01n: http and protocol-less forms accepted', () => {
    expect(parsePrUrl('http://github.com/octo-org/repo.js/pull/123')).toEqual({ ok: true, value: ok })
    expect(parsePrUrl('github.com/octo-org/repo.js/pull/123')).toEqual({ ok: true, value: ok })
  })
  it('EC-01d/e/g: number boundaries', () => {
    expect(parsePrUrl('https://github.com/a/b/pull/0').ok).toBe(false)
    expect(parsePrUrl('https://github.com/a/b/pull/1').ok).toBe(true)
    expect(parsePrUrl('https://github.com/a/b/pull/-1').ok).toBe(false)
  })
  it('EC-01m: 10k+ char URL rejected without hang', () => {
    expect(parsePrUrl('https://github.com/a/b/pull/1' + 'x'.repeat(10_000)).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/lib/github/parse`

- [ ] **Step 3: Implement src/lib/github/parse.ts**

```ts
export interface PrRef { owner: string; repo: string; number: number }
export type ParseError = 'empty' | 'not-github' | 'not-a-pr-url'
export type ParseResult = { ok: true; value: PrRef } | { ok: false; error: ParseError }

// GitHub owner/repo segment: word chars, hyphens, dots (no leading dot needed here)
const SEGMENT = /^[A-Za-z0-9_.-]+$/

export function parsePrUrl(input: string | null | undefined): ParseResult {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, error: 'empty' }
  const raw = input.trim()
  if (raw.length > 2048) return { ok: false, error: 'not-a-pr-url' }
  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: 'not-a-pr-url' }
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
    return { ok: false, error: 'not-github' }
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/)
  if (!m) return { ok: false, error: 'not-a-pr-url' }
  const [, owner, repo, num] = m
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return { ok: false, error: 'not-a-pr-url' }
  const number = Number(num)
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false, error: 'not-a-pr-url' }
  return { ok: true, value: { owner, repo, number } }
}
```

- [ ] **Step 4: Run tests — expect PASS** (note: `-1` and `0` fail via the regex `\d+` / `number < 1` paths respectively)

- [ ] **Step 5: Commit**

```bash
git add src/lib/github && git commit -m "feat: PR URL parser covering REQ-01 edge cases"
```

---

### Task 7: lib/github/client — fetch wrapper with error mapping (REQ-05 errors, REQ-04 auth use)

**Files:**
- Create: `src/lib/github/client.ts`, `src/lib/github/types.ts`
- Test: `src/lib/github/client.test.ts`

- [ ] **Step 1: Write src/lib/github/types.ts** (no test — types only)

```ts
export interface PrMeta {
  title: string
  state: 'open' | 'closed'
  merged: boolean
  body: string | null
  baseSha: string
  headSha: string
  private: boolean
  changedFiles: number
}

export interface PrFile {
  filename: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  previousFilename?: string
  patch?: string // absent for binary / very large files (EC-05j)
  additions: number
  deletions: number
}

export type GithubError =
  | { kind: 'not-found' }          // 404 — also masks private w/o auth (EC-05b)
  | { kind: 'unauthorized' }       // 401 — bad/expired token (EC-04c/e)
  | { kind: 'rate-limited'; resetAt: Date } // EC-05c
  | { kind: 'forbidden' }          // other 403
  | { kind: 'server'; status: number }
  | { kind: 'network' }

export class GithubApiError extends Error {
  constructor(public readonly detail: GithubError) {
    super(`github: ${detail.kind}`)
  }
}
```

- [ ] **Step 2: Write the failing tests for the fetch wrapper**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ghFetch } from './client'
import { GithubApiError } from './types'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }))
}

describe('ghFetch', () => {
  beforeEach(() => localStorage.clear())

  it('returns parsed JSON on 200 and sends auth header when PAT set', async () => {
    const f = mockFetch(200, { id: 1 })
    vi.stubGlobal('fetch', f)
    localStorage.setItem('review123:settings', JSON.stringify({ githubPat: 'ghp_x' }))
    const data = await ghFetch<{ id: number }>('/repos/a/b')
    expect(data).toEqual({ id: 1 })
    expect(f.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_x')
  })

  it('omits auth header without a token', async () => {
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)
    await ghFetch('/repos/a/b')
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('maps 404 to not-found (EC-05a/EC-05b)', async () => {
    vi.stubGlobal('fetch', mockFetch(404, { message: 'Not Found' }))
    await expect(ghFetch('/x')).rejects.toThrow(GithubApiError)
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'not-found' } })
  })

  it('maps 401 to unauthorized (EC-04c/EC-04e)', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
  })

  it('maps rate-limit 403 with reset time (EC-05c)', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {}, {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1781200000',
    }))
    await expect(ghFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'rate-limited', resetAt: new Date(1781200000 * 1000) },
    })
  })

  it('maps plain 403 to forbidden', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {}, { 'X-RateLimit-Remaining': '42' }))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'forbidden' } })
  })

  it('maps 5xx to server error (EC-05d)', async () => {
    vi.stubGlobal('fetch', mockFetch(502, {}))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'server', status: 502 } })
  })

  it('maps network failure (EC-05e)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'network' } })
  })
})
```

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run src/lib/github/client`

- [ ] **Step 4: Implement src/lib/github/client.ts**

```ts
import { getSettings } from '../settings/settings'
import { GithubApiError, type GithubError } from './types'

const BASE = 'https://api.github.com'

export async function ghFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.headers as Record<string, string> | undefined),
  }
  const pat = getSettings().githubPat
  if (pat) headers.Authorization = `Bearer ${pat}`

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers })
  } catch {
    throw new GithubApiError({ kind: 'network' })
  }
  if (res.ok) return (await res.json()) as T
  throw new GithubApiError(mapError(res))
}

function mapError(res: Response): GithubError {
  if (res.status === 404) return { kind: 'not-found' }
  if (res.status === 401) return { kind: 'unauthorized' }
  if (res.status === 403) {
    if (res.headers.get('X-RateLimit-Remaining') === '0') {
      const reset = Number(res.headers.get('X-RateLimit-Reset') ?? 0)
      return { kind: 'rate-limited', resetAt: new Date(reset * 1000) }
    }
    return { kind: 'forbidden' }
  }
  if (res.status >= 500) return { kind: 'server', status: res.status }
  return { kind: 'server', status: res.status }
}
```

- [ ] **Step 5: Run tests — expect PASS, commit**

```bash
git add src/lib/github && git commit -m "feat: GitHub fetch wrapper with typed error mapping"
```

---

### Task 8: lib/github/api — PR meta, paginated files, file contents (REQ-05)

**Files:**
- Create: `src/lib/github/api.ts`
- Test: `src/lib/github/api.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { getPrMeta, getPrFiles, getFileAtRef } from './api'

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers })
}

const META = {
  title: 'T', state: 'open', merged: false, body: null,
  base: { sha: 'b1' }, head: { sha: 'h1' },
  changed_files: 2,
}

describe('github api', () => {
  it('getPrMeta maps fields incl. repo privacy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...META, base: { ...META.base, repo: { private: true } },
    })))
    const meta = await getPrMeta({ owner: 'a', repo: 'b', number: 1 })
    expect(meta).toEqual({
      title: 'T', state: 'open', merged: false, body: null,
      baseSha: 'b1', headSha: 'h1', private: true, changedFiles: 2,
    })
  })

  it('getPrFiles traverses pagination via Link header (EC-05i)', async () => {
    const page1 = jsonResponse([{ filename: 'a.ts', status: 'modified', patch: '@@', additions: 1, deletions: 0 }], {
      Link: '<https://api.github.com/repos/a/b/pulls/1/files?page=2>; rel="next"',
    })
    const page2 = jsonResponse([{ filename: 'b.bin', status: 'added', additions: 0, deletions: 0 }])
    const f = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)
    vi.stubGlobal('fetch', f)
    const files = await getPrFiles({ owner: 'a', repo: 'b', number: 1 })
    expect(files.map(x => x.filename)).toEqual(['a.ts', 'b.bin'])
    expect(files[1].patch).toBeUndefined() // EC-05j binary has no patch
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('getFileAtRef decodes base64 content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      content: btoa('hello\n'), encoding: 'base64',
    })))
    expect(await getFileAtRef({ owner: 'a', repo: 'b' }, 'src/x.ts', 'h1')).toBe('hello\n')
  })

  it('getFileAtRef returns null for missing file (added/deleted sides, EC-16g groundwork)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))
    expect(await getFileAtRef({ owner: 'a', repo: 'b' }, 'gone.ts', 'b1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/lib/github/api`

- [ ] **Step 3: Implement src/lib/github/api.ts**

```ts
import { ghFetch } from './client'
import { GithubApiError, type PrFile, type PrMeta } from './types'
import type { PrRef } from './parse'

interface RawPr {
  title: string; state: 'open' | 'closed'; merged: boolean; body: string | null
  base: { sha: string; repo?: { private: boolean } }
  head: { sha: string }
  changed_files: number
}

export async function getPrMeta(ref: PrRef): Promise<PrMeta> {
  const pr = await ghFetch<RawPr>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)
  return {
    title: pr.title, state: pr.state, merged: pr.merged, body: pr.body,
    baseSha: pr.base.sha, headSha: pr.head.sha,
    private: pr.base.repo?.private ?? false,
    changedFiles: pr.changed_files,
  }
}

// Traverses all pages (100/page). EC-05i.
export async function getPrFiles(ref: PrRef): Promise<PrFile[]> {
  const all: PrFile[] = []
  let path: string | null = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`
  while (path) {
    // ghFetchPage returns body + next link
    const { body, next } = await ghFetchPage<PrFile[]>(path)
    all.push(...body)
    path = next
  }
  return all
}

export async function getFileAtRef(
  repo: { owner: string; repo: string }, filePath: string, ref: string,
): Promise<string | null> {
  try {
    const data = await ghFetch<{ content: string; encoding: string }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${ref}`,
    )
    if (data.encoding !== 'base64') return null
    return decodeBase64(data.content)
  } catch (e) {
    if (e instanceof GithubApiError && e.detail.kind === 'not-found') return null
    throw e
  }
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
```

Add `ghFetchPage` to `src/lib/github/client.ts` (exported alongside `ghFetch`):

```ts
export async function ghFetchPage<T>(path: string): Promise<{ body: T; next: string | null }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const pat = getSettings().githubPat
  if (pat) headers.Authorization = `Bearer ${pat}`
  let res: Response
  try {
    const url = path.startsWith('http') ? path : `${BASE}${path}`
    res = await fetch(url, { headers })
  } catch {
    throw new GithubApiError({ kind: 'network' })
  }
  if (!res.ok) throw new GithubApiError(mapError(res))
  const link = res.headers.get('Link') ?? ''
  const m = link.match(/<([^>]+)>;\s*rel="next"/)
  return { body: (await res.json()) as T, next: m ? m[1] : null }
}
```

- [ ] **Step 4: Run all tests — expect PASS** — `pnpm test`

- [ ] **Step 5: Commit**

```bash
git add src/lib/github && git commit -m "feat: GitHub API functions for PR meta, paginated files, contents"
```

---

### Task 9: App shell, landing page, settings panel (REQ-01 UI, REQ-04 UI)

**Files:**
- Create: `src/routes/Landing.svelte`, `src/components/SettingsPanel.svelte`
- Modify: `src/App.svelte`, `src/main.ts`
- Test: `src/routes/Landing.test.ts`

- [ ] **Step 1: Write the failing component tests**

```ts
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import Landing from './Landing.svelte'

describe('Landing', () => {
  it('EC-01b: empty submit shows "enter a PR URL", no navigation', async () => {
    render(Landing)
    await userEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/enter a .*PR URL/i)
    expect(location.pathname).toBe('/')
  })

  it('EC-01i: non-PR URL shows specific message', async () => {
    render(Landing)
    await userEvent.type(screen.getByRole('textbox'), 'https://github.com/just-an-owner')
    await userEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/not a .*pull request URL/i)
  })

  it('valid URL navigates to the review route', async () => {
    render(Landing)
    await userEvent.type(screen.getByRole('textbox'), 'https://github.com/a/b/pull/12')
    await userEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(location.pathname).toBe('/review/a/b/12')
  })
})
```

Add dev dep: `pnpm add -D @testing-library/user-event`

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/routes`

- [ ] **Step 3: Implement Landing.svelte**

```svelte
<script lang="ts">
  import { parsePrUrl } from '../lib/github/parse'
  import { navigate } from '../lib/router/router.svelte'

  let input = $state('')
  let error = $state<string | null>(null)

  const MESSAGES: Record<string, string> = {
    empty: 'Please enter a GitHub PR URL.',
    'not-github': 'That URL is not on github.com.',
    'not-a-pr-url': 'That does not look like a pull request URL (expected …/owner/repo/pull/123).',
  }

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const result = parsePrUrl(input)
    if (!result.ok) { error = MESSAGES[result.error]; return }
    error = null
    const { owner, repo, number } = result.value
    navigate(`/review/${owner}/${repo}/${number}`)
  }
</script>

<section class="landing">
  <h1>Review 1‑2‑3</h1>
  <p>Paste a GitHub pull request URL to start a guided review.</p>
  <form onsubmit={submit}>
    <input type="text" bind:value={input} placeholder="https://github.com/owner/repo/pull/123" aria-label="Pull request URL" />
    <button type="submit">Review</button>
  </form>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</section>

<style>
  .landing { max-width: 40rem; margin: 15vh auto 0; padding: 0 1rem; text-align: center; }
  form { display: flex; gap: 0.5rem; }
  input { flex: 1; padding: 0.6rem; font-size: 1rem; }
  button { padding: 0.6rem 1.2rem; }
  .error { color: #c33; }
</style>
```

- [ ] **Step 4: Implement SettingsPanel.svelte** (PAT + DeepSeek key entry; masked inputs — EC-04h; collapsible from a gear button in App)

```svelte
<script lang="ts">
  import { getSettings, setGithubPat, setDeepseekKey } from '../lib/settings/settings'
  import { track } from '../lib/analytics/analytics'

  let { onclose }: { onclose: () => void } = $props()
  const current = getSettings()
  let pat = $state(current.githubPat ?? '')
  let deepseek = $state(current.deepseekKey ?? '')
  let error = $state<string | null>(null)

  function save() {
    try {
      const hadPat = !!current.githubPat
      const hadKey = !!current.deepseekKey
      setGithubPat(pat.trim() === '' ? null : pat)
      setDeepseekKey(deepseek.trim() === '' ? null : deepseek)
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
  <label>GitHub token (PAT)
    <input type="password" bind:value={pat} autocomplete="off" placeholder="github_pat_… (fine-grained, repo-scoped recommended)" />
  </label>
  <label>DeepSeek API key
    <input type="password" bind:value={deepseek} autocomplete="off" placeholder="sk-…" />
  </label>
  <p class="hint">Keys are stored only in this browser (localStorage) and sent only to their own services.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <button onclick={save}>Save</button>
  <button onclick={onclose}>Cancel</button>
</dialog>
```

- [ ] **Step 5: Rewrite App.svelte as the route switch**

```svelte
<script lang="ts">
  import { router, startRouter } from './lib/router/router.svelte'
  import Landing from './routes/Landing.svelte'
  import Review from './routes/Review.svelte'
  import SettingsPanel from './components/SettingsPanel.svelte'

  startRouter()
  let settingsOpen = $state(false)
</script>

<header class="topbar">
  <a href="/">Review 1‑2‑3</a>
  <button aria-label="Settings" onclick={() => (settingsOpen = true)}>⚙</button>
</header>

{#if settingsOpen}<SettingsPanel onclose={() => (settingsOpen = false)} />{/if}

{#if router.route.name === 'landing'}
  <Landing />
{:else if router.route.name === 'review'}
  <Review owner={router.route.owner} repo={router.route.repo} number={router.route.number} />
{:else}
  <section class="landing"><h1>Not found</h1><p>That isn’t a valid review link. <a href="/">Go home</a>.</p></section>
{/if}
```

(`Review.svelte` is created in Task 11; for this commit create it as a minimal component that renders the params — replaced in Task 11:)

```svelte
<script lang="ts">
  let { owner, repo, number }: { owner: string; repo: string; number: number } = $props()
</script>
<p>Loading {owner}/{repo}#{number}…</p>
```

- [ ] **Step 6: Run tests + check — expect PASS** — `pnpm test && pnpm check`

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: app shell, landing page with URL validation, settings panel"
```

---

### Task 10: Diff rendering — lib/diff + FileDiff component (REQ-06)

**Files:**
- Create: `src/lib/diff/diffFile.ts`, `src/components/FileDiff.svelte`
- Test: `src/lib/diff/diffFile.test.ts`

- [ ] **Step 1: Read the package docs**

Read `node_modules/@git-diff-view/svelte/README.md` and `node_modules/@git-diff-view/file/README.md`. The expected API (verify and adapt): `generateDiffFile(oldName, oldContent, newName, newContent, oldLang, newLang)` from `@git-diff-view/file` producing a `DiffFile`, and `<DiffView {diffFile} diffViewMode={...} diffViewHighlight diffViewWrap />` from `@git-diff-view/svelte` with `DiffModeEnum.Split | DiffModeEnum.Unified`. If the real API differs, adapt `lib/diff/diffFile.ts` only — keep the wrapper interface below stable.

- [ ] **Step 2: Write the failing test for the wrapper**

```ts
import { describe, it, expect } from 'vitest'
import { buildDiffFile, classifyFile } from './diffFile'
import type { PrFile } from '../github/types'

const modified: PrFile = {
  filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n unchanged\n',
}

describe('classifyFile', () => {
  it('EC-06c: rename without patch classifies as rename-only', () => {
    expect(classifyFile({ filename: 'b.ts', previousFilename: 'a.ts', status: 'renamed', additions: 0, deletions: 0 })).toBe('rename-only')
  })
  it('EC-05j: no patch and not a rename classifies as binary-or-too-large', () => {
    expect(classifyFile({ filename: 'img.png', status: 'added', additions: 0, deletions: 0 })).toBe('binary-or-too-large')
  })
  it('normal patched file classifies as diff', () => {
    expect(classifyFile(modified)).toBe('diff')
  })
})

describe('buildDiffFile', () => {
  it('builds a renderable DiffFile from a patch (EC-06b groundwork)', () => {
    const df = buildDiffFile(modified)
    expect(df).not.toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify failure**, then implement `src/lib/diff/diffFile.ts`

```ts
import { DiffFile, generateDiffFile } from '@git-diff-view/file'
import type { PrFile } from '../github/types'

export type FileKind = 'diff' | 'rename-only' | 'binary-or-too-large'

export function classifyFile(f: PrFile): FileKind {
  if (f.patch) return 'diff'
  if (f.status === 'renamed' && f.additions === 0 && f.deletions === 0) return 'rename-only'
  return 'binary-or-too-large'
}

const langOf = (name: string) => name.split('.').pop() ?? 'txt'

// Builds a DiffFile from the GitHub per-file patch. Old/new contents are
// not required for hunk-based rendering; Plan C fetches full contents for
// AI context, not for diff display.
export function buildDiffFile(f: PrFile): DiffFile | null {
  if (!f.patch) return null
  const oldName = f.previousFilename ?? f.filename
  try {
    const df = generateDiffFile(oldName, '', f.filename, '', langOf(oldName), langOf(f.filename))
    // hunk-only construction — verify exact call against the package README
    // (DiffFile.createInstance({ oldFile, newFile, hunks }) is the documented
    // alternative if generateDiffFile requires full contents)
    df.initRaw()
    return df
  } catch {
    return null
  }
}
```

**Important:** the exact construction call MUST be validated against the README in Step 1 — if `generateDiffFile` with empty contents doesn't render hunks, use `DiffFile.createInstance({ oldFile: { fileName: oldName }, newFile: { fileName: f.filename }, hunks: [f.patch] })` from `@git-diff-view/core`. The test in Step 2 plus a manual `pnpm dev` render against a real patch is the acceptance check. Adjust implementation, keep the exported signature.

- [ ] **Step 4: Implement FileDiff.svelte**

```svelte
<script lang="ts">
  import { DiffView, DiffModeEnum } from '@git-diff-view/svelte'
  import '@git-diff-view/svelte/styles/diff-view.css'
  import { buildDiffFile, classifyFile } from '../lib/diff/diffFile'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'

  let { file, mode }: { file: PrFile; mode: DiffMode } = $props()
  const kind = classifyFile(file)
  const diffFile = kind === 'diff' ? buildDiffFile(file) : null
</script>

<article class="file-diff">
  <header>
    <code>{file.previousFilename ? `${file.previousFilename} → ` : ''}{file.filename}</code>
    <span class="stats">+{file.additions} −{file.deletions}</span>
  </header>
  {#if kind === 'rename-only'}
    <p class="note">Rename only — no content changes.</p>
  {:else if kind === 'binary-or-too-large' || !diffFile}
    <p class="note">Binary or too large to display.</p>
  {:else}
    <DiffView {diffFile} diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified} diffViewHighlight={true} diffViewWrap={true} />
  {/if}
</article>

<style>
  .file-diff { border: 1px solid #8884; border-radius: 6px; margin-bottom: 1rem; overflow: hidden; }
  header { display: flex; justify-content: space-between; padding: 0.4rem 0.8rem; background: #8881; }
  .note { padding: 0.8rem; opacity: 0.7; }
</style>
```

- [ ] **Step 5: Verify with a real patch in dev** (manual check — REQ-06 visual proof comes in verify-and-prove)

Run: `pnpm dev`, temporarily render `<FileDiff>` with the `modified` fixture from the test in `App.svelte`, confirm red/green + word highlights, then remove the temporary render.

- [ ] **Step 6: Run all tests + check, commit**

```bash
pnpm test && pnpm check
git add -A && git commit -m "feat: diff rendering via @git-diff-view with rename/binary handling"
```

---

### Task 11: Review route — fetch orchestration + stepper shell (REQ-05, REQ-06h, REQ-20 partial)

**Files:**
- Create: `src/routes/Review.svelte` (replace stub), `src/lib/review/loadPr.svelte.ts`, `src/components/Stepper.svelte`
- Test: `src/lib/review/loadPr.test.ts`

- [ ] **Step 1: Write the failing test for the loader state machine**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createPrLoad } from './loadPr.svelte'
import { GithubApiError } from '../github/types'

const REF = { owner: 'a', repo: 'b', number: 1 }
const META = {
  title: 'T', state: 'open' as const, merged: false, body: null,
  baseSha: 'b1', headSha: 'h1', private: false, changedFiles: 1,
}
const FILES = [{ filename: 'a.ts', status: 'modified' as const, patch: '@@', additions: 1, deletions: 0 }]

describe('createPrLoad', () => {
  it('loads meta and files in parallel into ready state', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockResolvedValue(META),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state.status).toBe('ready')
    expect(load.state.status === 'ready' && load.state.files).toEqual(FILES)
  })

  it('maps not-found to a specific error state (EC-05a)', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockRejectedValue(new GithubApiError({ kind: 'not-found' })),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state).toEqual({ status: 'error', error: 'not-found' })
  })

  it('maps rate limit with reset time (EC-05c)', async () => {
    const resetAt = new Date(1781200000000)
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockRejectedValue(new GithubApiError({ kind: 'rate-limited', resetAt })),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state).toEqual({ status: 'error', error: 'rate-limited', resetAt })
  })

  it('zero changed files → ready with empty list (EC-05g)', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockResolvedValue({ ...META, changedFiles: 0 }),
      getPrFiles: vi.fn().mockResolvedValue([]),
    })
    await load.promise
    expect(load.state.status).toBe('ready')
  })
})
```

- [ ] **Step 2: Run to verify failure**, then implement `src/lib/review/loadPr.svelte.ts`

```ts
import { getPrMeta as defaultGetPrMeta, getPrFiles as defaultGetPrFiles } from '../github/api'
import { GithubApiError, type PrFile, type PrMeta } from '../github/types'
import type { PrRef } from '../github/parse'
import { track } from '../analytics/analytics'

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; meta: PrMeta; files: PrFile[] }
  | { status: 'error'; error: 'not-found' | 'unauthorized' | 'forbidden' | 'network' | 'server' }
  | { status: 'error'; error: 'rate-limited'; resetAt: Date }

interface Deps {
  getPrMeta: typeof defaultGetPrMeta
  getPrFiles: typeof defaultGetPrFiles
}

export function createPrLoad(ref: PrRef, deps: Deps = { getPrMeta: defaultGetPrMeta, getPrFiles: defaultGetPrFiles }) {
  const holder = $state<{ state: LoadState }>({ state: { status: 'loading' } })
  const promise = (async () => {
    try {
      const [meta, files] = await Promise.all([deps.getPrMeta(ref), deps.getPrFiles(ref)])
      holder.state = { status: 'ready', meta, files }
      track('pr_loaded', {
        visibility: meta.private ? 'private' : 'public',
        file_count: files.length,
        primary_language: files[0]?.filename.split('.').pop() ?? 'unknown',
      })
    } catch (e) {
      if (e instanceof GithubApiError) {
        holder.state = e.detail.kind === 'rate-limited'
          ? { status: 'error', error: 'rate-limited', resetAt: e.detail.resetAt }
          : { status: 'error', error: e.detail.kind === 'server' ? 'server' : e.detail.kind }
      } else {
        holder.state = { status: 'error', error: 'network' }
      }
    }
  })()
  return { get state() { return holder.state }, promise }
}
```

- [ ] **Step 3: Implement Stepper.svelte**

```svelte
<script lang="ts">
  export type Step = 1 | 2 | 3
  let { step, onstep }: { step: Step; onstep: (s: Step) => void } = $props()
  const labels: Record<Step, string> = { 1: 'Understand', 2: 'Inspect', 3: 'Verdict' }
</script>

<nav class="stepper" aria-label="Review steps">
  {#each [1, 2, 3] as const as s}
    <button class:active={s === step} onclick={() => onstep(s)} aria-current={s === step ? 'step' : undefined}>
      {s} · {labels[s]}
    </button>
  {/each}
</nav>

<style>
  .stepper { display: flex; gap: 0.5rem; padding: 0.5rem 0; }
  button.active { font-weight: 700; border-bottom: 2px solid currentColor; }
</style>
```

- [ ] **Step 4: Implement Review.svelte** (replaces Task 9 stub)

```svelte
<script lang="ts">
  import { createPrLoad } from '../lib/review/loadPr.svelte'
  import Stepper from '../components/Stepper.svelte'
  import FileDiff from '../components/FileDiff.svelte'
  import { getSettings, setDiffMode, type DiffMode } from '../lib/settings/settings'

  let { owner, repo, number }: { owner: string; repo: string; number: number } = $props()
  const load = createPrLoad({ owner, repo, number })
  let step = $state<1 | 2 | 3>(1)
  let mode = $state<DiffMode>(getSettings().diffMode)
  function setMode(m: DiffMode) { mode = m; setDiffMode(m) }
</script>

<section class="review">
  {#if load.state.status === 'loading'}
    <p>Loading {owner}/{repo}#{number}…</p>
  {:else if load.state.status === 'error'}
    {#if load.state.error === 'not-found'}
      <p role="alert">PR not found. If this repo is private, add a GitHub token in Settings (sign-in arrives soon).</p>
    {:else if load.state.error === 'rate-limited'}
      <p role="alert">GitHub rate limit reached. Resets at {load.state.resetAt.toLocaleTimeString()}. Add a token in Settings to raise the limit.</p>
    {:else if load.state.error === 'unauthorized'}
      <p role="alert">Your GitHub token was rejected. Update it in Settings.</p>
    {:else}
      <p role="alert">Could not load the PR ({load.state.error}). Try again.</p>
    {/if}
  {:else}
    <h1>{load.state.meta.title} <small>{owner}/{repo}#{number}</small></h1>
    <Stepper {step} onstep={(s) => (step = s)} />
    {#if step === 1}
      <p>{load.state.meta.body ?? 'No description.'}</p>
      <p class="muted">AI summary, behavior verdict, diagrams and CI signals arrive in upcoming milestones.</p>
    {:else if step === 2}
      <div class="mode-toggle" role="group" aria-label="Diff mode">
        <button class:active={mode === 'unified'} onclick={() => setMode('unified')}>Unified</button>
        <button class:active={mode === 'split'} onclick={() => setMode('split')}>Side-by-side</button>
      </div>
      {#if load.state.files.length === 0}
        <p>This PR has no changed files.</p>
      {:else}
        {#each load.state.files as file (file.filename)}
          <FileDiff {file} {mode} />
        {/each}
      {/if}
    {:else}
      <p class="muted">Review submission arrives in the next milestone. For now, submit on GitHub.</p>
    {/if}
  {/if}
</section>

<style>
  .review { max-width: 70rem; margin: 0 auto; padding: 1rem; }
  .muted { opacity: 0.6; }
  .mode-toggle button.active { font-weight: 700; }
</style>
```

- [ ] **Step 5: Run everything, manual smoke, commit**

```bash
pnpm test && pnpm check && pnpm build
pnpm dev  # open /, paste a real public PR URL, verify diff renders in both modes
git add -A && git commit -m "feat: review route with PR loading, stepper shell, diff modes"
```

---

### Task 12: README + final wiring

**Files:**
- Modify: `README.md`, `src/main.ts`

- [ ] **Step 1: Write README.md** — sections: what it is (one paragraph), local dev (`pnpm install && pnpm dev`), env vars (`VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` — optional, analytics off without them), deploy (Vercel: import repo, framework Vite, build `pnpm build`, output `dist/`; OAuth env vars documented in Plan B when the function lands), supply-chain note (pnpm `minimumReleaseAge` 7 days + emergency override `pnpm install --config.minimumReleaseAge=0` for a vetted security patch), test commands.

- [ ] **Step 2: Confirm `initAnalytics()` is called in main.ts** (from Task 4) and `.env.local` is gitignored (Vite default — verify `.gitignore` includes `*.local`; add if not).

- [ ] **Step 3: Full local CI parity run**

Run: `pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: README with setup, env, deploy, supply-chain notes"
```

---

## Plan A definition of done

- All tasks committed on a feature branch (`feat/plan-a-foundation`), branched before Task 1.
- `pnpm check && pnpm test && pnpm build` green locally and in CI.
- Manual smoke: real public PR renders diffs in both modes; bad URLs produce the right messages; rate-limit path message verified by exhausting tokenless quota or stubbing.
- Covered criteria recorded for verify-and-prove: REQ-01 (musts), REQ-04 (storage subset), REQ-05 (musts), REQ-06 (EC-06b/c/h), REQ-18 (all musts), REQ-20 (EC-20d).
- NOT in Plan A (deliberately): OAuth (Plan B), review submission (Plan B), drafts/editor (Plan B), all AI + cache + consent + CI signals (Plan C), context rail (fills in Plan C).
