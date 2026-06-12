# Settings Bugs Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three settings bugs: (1) OAuth logout on save, (2) read-once settings (testFileDisplay/showProgress don't update live), (3) wrong copy in mine-skill gate text.

**Architecture:** The fix uses the existing `_register…` hook pattern from `authState.svelte.ts` to create `settingsState.svelte.ts` — a reactive Svelte 5 `$state` facade over `Settings`. `FileDiff.svelte` and `Review.svelte` derive from `settingsState.current` instead of calling `getSettings()` point-in-time. The OAuth logout bug is fixed in `settings.ts` (guard `saveTokens`) and in `SettingsPanel.svelte` (omit `githubPat` from patch when method is oauth). The copy fix is a one-line change in `SettingsPanel.svelte`.

**Tech Stack:** Svelte 5, TypeScript, Vitest, @testing-library/svelte, pnpm

**Working directory:** `/Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1`
(This is the existing worktree for `feat/plan-e-integration`. All file paths and commands below are relative to this directory.)

**Gate after each task:** `pnpm test` (run from worktree dir)
**Final gate:** `pnpm check && pnpm test && pnpm exec playwright test && pnpm build`

---

## Context summary

### Bug 1 — OAuth logout on save

**Mechanism confirmed:** `SettingsPanel.save()` always calls:
```ts
saveTokens({ githubPat: pat.trim() === '' ? null : pat, deepseekKey: ... })
```
When the user is signed in via OAuth the `pat` state variable is `''` (empty), so this passes `githubPat: null`.

In `settings.ts`, `saveTokens` runs:
```ts
if ('githubPat' in update) {
  update.githubAuth = update.githubPat
    ? { token: update.githubPat, method: 'pat', scopes: [] }
    : null   // ← wipes OAuth token
}
```
Because `'githubPat' in update` is true and the value is `null`, `githubAuth` is set to `null` — logging the user out.

**Fix locations:**
- `src/lib/settings/settings.ts`: In `saveTokens`, when the patch sets `githubPat` to `null` AND current `githubAuth?.method === 'oauth'`, preserve `githubAuth` (skip the sync entirely).
- `src/components/SettingsPanel.svelte`: In `save()`, omit `githubPat` from the patch entirely when `pat.trim() === ''` AND `authState.auth?.method === 'oauth'` (belt-and-braces).

### Bug 2 — Read-once settings

**Mechanism:** `FileDiff.svelte` uses:
```ts
const testFileDisplay = $derived<TestFileDisplay>(getSettings().testFileDisplay)
```
`$derived` re-runs when its reactive dependencies change — but `getSettings()` reads from `localStorage` and returns a plain object. Nothing in Svelte's reactivity graph knows `localStorage` changed, so `$derived` never re-runs. Same issue in `Review.svelte` with `showProgress` and `railCollapsed` (though `railCollapsed` has additional local mutation).

**Fix:**
1. Create `src/lib/settings/settingsState.svelte.ts` — mirrors `authState.svelte.ts` exactly but for `Settings`.
2. Register a notify hook in `settings.ts` (same `_register…` pattern as `_registerAuthRefresh`).
3. Call `notifySettingsMutated()` from every write function in `settings.ts` that changes a setting consumers care about (`save`, `saveTokens`, `saveGithubAuth`, etc. — every public write path).
4. In `FileDiff.svelte`: change `$derived(getSettings().testFileDisplay)` → `$derived(settingsState.current.testFileDisplay)`.
5. In `Review.svelte`: change `let showProgress = $state(getSettings().showProgress)` → derive from `settingsState.current.showProgress`.

**Note:** `railCollapsed` has complex local mutation (narrow-viewport auto-collapse, user toggle) — it is NOT a candidate for settingsState derivation. Keep it as `$state` initialized from `getSettings()` (current behavior is intentional — it's a session-local overlay).

**Sweep list for #2 (getSettings() calls in components, non-point-in-time contexts):**
- `src/components/FileDiff.svelte:113` — `testFileDisplay` → settingsState ✅ (must fix)
- `src/components/InspectStep.svelte:128` — `diffWidth` — already `$derived` but same read-once problem; however per spec only `testFileDisplay` and `showProgress` are in scope. Leave `diffWidth` for now unless it has a failing test.
- `src/routes/Review.svelte:315` — `showProgress` → settingsState ✅ (must fix)
- `src/components/SettingsPanel.svelte:91` — `hasDeepseekKey` inside `$derived` (but `getSettings()` is called inside derived, same issue) → settingsState
- `src/routes/Review.svelte:282` — `railCollapsed` — intentionally read-once (local session overlay), leave as-is
- `src/components/InspectStep.svelte:124` — `treeOpen` — local state, user-driven, leave as-is
- `src/components/InspectStep.svelte:306` — `hasKey` inside `$derived` — same read-once issue but out of spec scope; leave

### Bug 3 — Wrong copy

Line 467 in `src/components/SettingsPanel.svelte`:
```
Sign in with GitHub (above) to use this feature.
```
Change to:
```
Sign in with GitHub from the top bar to use this feature.
```

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/settings/settings.ts` | Modify | Add `_registerSettingsRefresh` hook; add `notifySettingsMutated()` call to every write path |
| `src/lib/settings/settingsState.svelte.ts` | **Create** | Reactive `$state` facade for `Settings`; mirrors `authState.svelte.ts` |
| `src/lib/settings/settings.test.ts` | Modify | Add regression tests for OAuth-logout bug |
| `src/components/SettingsPanel.svelte` | Modify | Guard `githubPat` in `save()`; fix mine-gate copy |
| `src/components/SettingsPanel.test.ts` | Modify | Add regression tests for OAuth-logout via SettingsPanel |
| `src/components/FileDiff.svelte` | Modify | Derive `testFileDisplay` from `settingsState.current` |
| `src/components/FileDiff.test.ts` | Modify | Add live-reactivity test for `testFileDisplay` |
| `src/routes/Review.svelte` | Modify | Derive `showProgress` from `settingsState.current` |

---

## Task 1: Failing tests for Bug 1 (OAuth logout)

**Files:**
- Modify: `src/lib/settings/settings.test.ts`
- Modify: `src/components/SettingsPanel.test.ts`

- [ ] **Step 1.1: Add failing unit tests in settings.test.ts**

Open `src/lib/settings/settings.test.ts`. After the existing `saveGithubAuth` tests (around line 133), add this new `describe` block:

```typescript
describe('saveTokens — OAuth preservation (Bug 1 regression)', () => {
  it('saveTokens with githubPat: null does NOT clear githubAuth when method is oauth', () => {
    // Seed OAuth auth
    saveGithubAuth({ token: 'gho_oauth_token', method: 'oauth', scopes: ['repo'] })
    expect(getSettings().githubAuth?.method).toBe('oauth')

    // Simulate SettingsPanel.save() with empty PAT field while oauth is active
    saveTokens({ githubPat: null, deepseekKey: null })

    // githubAuth must be preserved
    expect(getSettings().githubAuth).toEqual({ token: 'gho_oauth_token', method: 'oauth', scopes: ['repo'] })
  })

  it('saveTokens with githubPat: null DOES clear githubAuth when method is pat', () => {
    saveGithubAuth({ token: 'ghp_pat', method: 'pat', scopes: [] })
    expect(getSettings().githubAuth?.method).toBe('pat')

    saveTokens({ githubPat: null, deepseekKey: null })

    expect(getSettings().githubAuth).toBeNull()
  })

  it('saveTokens with a non-empty githubPat while method is oauth switches to pat method', () => {
    saveGithubAuth({ token: 'gho_oauth', method: 'oauth', scopes: ['repo'] })

    saveTokens({ githubPat: 'ghp_newpat', deepseekKey: null })

    const s = getSettings()
    expect(s.githubAuth).toEqual({ token: 'ghp_newpat', method: 'pat', scopes: [] })
    expect(s.githubPat).toBe('ghp_newpat')
  })
})
```

- [ ] **Step 1.2: Add failing SettingsPanel integration test**

Open `src/components/SettingsPanel.test.ts`. After the last `describe` block (around line 310), add:

```typescript
// ---------------------------------------------------------------------------
// SettingsPanel — OAuth logout regression (Bug 1)
// ---------------------------------------------------------------------------

describe('SettingsPanel — save does not log out OAuth user', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetAuthStateForTest()
  })

  it('saving with empty PAT field while signed in via OAuth preserves githubAuth', async () => {
    // Seed OAuth auth
    saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['repo'] })
    _resetAuthStateForTest()

    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // PAT field is empty (user did not type anything)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // OAuth auth must be untouched
    expect(getSettings().githubAuth).toEqual({ token: 'gho_oauth123', method: 'oauth', scopes: ['repo'] })
  })

  it('PAT user clearing the PAT field still clears githubAuth', async () => {
    saveGithubAuth({ token: 'ghp_existing', method: 'pat', scopes: [] })
    _resetAuthStateForTest()

    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const patInput = screen.getByLabelText(/github token/i)
    await userEvent.clear(patInput)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(getSettings().githubAuth).toBeNull()
  })
})
```

- [ ] **Step 1.3: Verify tests FAIL**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test -- --reporter=verbose src/lib/settings/settings.test.ts src/components/SettingsPanel.test.ts 2>&1 | tail -30
```

Expected: The three new `saveTokens` tests fail; the two SettingsPanel OAuth tests fail. All existing tests still pass.

---

## Task 2: Fix Bug 1 in settings.ts

**Files:**
- Modify: `src/lib/settings/settings.ts:165-180`

- [ ] **Step 2.1: Guard githubAuth sync in saveTokens**

The current `saveTokens` body (lines 165–180):
```typescript
export function saveTokens(patch: { githubPat?: string | null; deepseekKey?: string | null }): void {
  const update: Partial<Settings> = {}
  if ('githubPat' in patch) update.githubPat = validateToken('githubPat', patch.githubPat ?? null)
  if ('deepseekKey' in patch) update.deepseekKey = validateToken('deepseekKey', patch.deepseekKey ?? null)

  // Also maintain githubAuth in sync with githubPat changes
  if ('githubPat' in update) {
    update.githubAuth = update.githubPat
      ? { token: update.githubPat, method: 'pat', scopes: [] }
      : null
  }

  save(update)
  if ('githubPat' in update) notifyAuthMutated()
}
```

Replace with:
```typescript
export function saveTokens(patch: { githubPat?: string | null; deepseekKey?: string | null }): void {
  // Validate all first (atomic — throw before writing anything)
  const update: Partial<Settings> = {}
  if ('githubPat' in patch) update.githubPat = validateToken('githubPat', patch.githubPat ?? null)
  if ('deepseekKey' in patch) update.deepseekKey = validateToken('deepseekKey', patch.deepseekKey ?? null)

  // Sync githubAuth with githubPat changes — but preserve OAuth tokens:
  // clearing the PAT field while signed in via OAuth must not wipe the OAuth token.
  if ('githubPat' in update) {
    if (update.githubPat) {
      // Explicit non-empty PAT write → switch to PAT method
      update.githubAuth = { token: update.githubPat, method: 'pat', scopes: [] }
    } else {
      // githubPat cleared — only wipe githubAuth if the current method is 'pat' (or null)
      const currentMethod = getSettings().githubAuth?.method
      if (currentMethod !== 'oauth') {
        update.githubAuth = null
      }
      // If method === 'oauth', githubAuth is intentionally left untouched
    }
  }

  save(update)
  if ('githubPat' in update) notifyAuthMutated()
}
```

- [ ] **Step 2.2: Verify settings.ts unit tests pass**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test -- --reporter=verbose src/lib/settings/settings.test.ts 2>&1 | tail -20
```

Expected: all settings tests pass including the three new regression tests.

---

## Task 3: Fix Bug 1 in SettingsPanel.svelte (belt-and-braces)

**Files:**
- Modify: `src/components/SettingsPanel.svelte:204-213`

- [ ] **Step 3.1: Guard githubPat in save()**

The current `save()` function (lines 204–231):
```typescript
function save() {
  try {
    const hadPat = !!current.githubPat
    ...
    saveTokens({
      githubPat: pat.trim() === '' ? null : pat,
      deepseekKey: deepseek.trim() === '' ? null : deepseek,
    })
```

Replace just the `saveTokens` call to omit `githubPat` when the PAT field is empty AND the current method is OAuth:

```typescript
function save() {
  try {
    const hadPat = !!current.githubPat
    const hadKey = !!current.deepseekKey
    const hadGitlab = !!current.gitlabToken
    const hadBitbucket = !!current.bitbucketAuth

    // Belt-and-braces: when the user is signed in via OAuth and left the PAT
    // field empty, do NOT send githubPat: null — that would trigger the
    // githubAuth → null sync in saveTokens and log the user out.
    const patTrimmed = pat.trim()
    const isOauth = authState.auth?.method === 'oauth'
    const tokensPatch: { githubPat?: string | null; deepseekKey?: string | null } = {
      deepseekKey: deepseek.trim() === '' ? null : deepseek,
    }
    if (patTrimmed !== '' || !isOauth) {
      tokensPatch.githubPat = patTrimmed === '' ? null : pat
    }
    saveTokens(tokensPatch)
    setGitlabToken(gitlabTokenInput.trim() === '' ? null : gitlabTokenInput)
```

**Important:** preserve the remaining lines (`saveBitbucketAuth`, `track(...)`, `onclose()`, `catch`). Only the `saveTokens` call and the variable declarations above it change.

The full replacement for the `save()` function body (lines 204–231):

```typescript
  function save() {
    try {
      const hadPat = !!current.githubPat
      const hadKey = !!current.deepseekKey
      const hadGitlab = !!current.gitlabToken
      const hadBitbucket = !!current.bitbucketAuth

      // Belt-and-braces: when signed in via OAuth and PAT field is empty,
      // omit githubPat from the patch so saveTokens does not clear githubAuth.
      const patTrimmed = pat.trim()
      const isOauth = authState.auth?.method === 'oauth'
      const tokensPatch: { githubPat?: string | null; deepseekKey?: string | null } = {
        deepseekKey: deepseek.trim() === '' ? null : deepseek,
      }
      if (patTrimmed !== '' || !isOauth) {
        tokensPatch.githubPat = patTrimmed === '' ? null : pat
      }
      saveTokens(tokensPatch)

      setGitlabToken(gitlabTokenInput.trim() === '' ? null : gitlabTokenInput)
      const emailTrimmed = bitbucketEmail.trim()
      const tokenTrimmed = bitbucketToken.trim()
      if (emailTrimmed === '' && tokenTrimmed === '') {
        saveBitbucketAuth(null)
      } else {
        saveBitbucketAuth({ email: emailTrimmed, token: tokenTrimmed })
      }
      if (!hadPat && patTrimmed) track('settings_key_added', { service: 'github' })
      if (!hadKey && deepseek.trim()) track('settings_key_added', { service: 'deepseek' })
      if (!hadGitlab && gitlabTokenInput.trim()) track('settings_key_added', { service: 'gitlab' })
      if (!hadBitbucket && emailTrimmed && tokenTrimmed) track('settings_key_added', { service: 'bitbucket' })
      onclose()
    } catch (e) {
      error = (e as Error).message
    }
  }
```

- [ ] **Step 3.2: Verify all Bug 1 tests pass**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test -- --reporter=verbose src/lib/settings/settings.test.ts src/components/SettingsPanel.test.ts 2>&1 | tail -30
```

Expected: all 5 new regression tests pass; all existing tests still pass.

- [ ] **Step 3.3: Run full test suite to confirm nothing regressed**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test 2>&1 | tail -10
```

Expected: all 1923+ tests pass.

- [ ] **Step 3.4: Commit Bug 1 fix**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
git add src/lib/settings/settings.ts src/components/SettingsPanel.svelte src/lib/settings/settings.test.ts src/components/SettingsPanel.test.ts
git commit -m "$(cat <<'EOF'
fix: preserve OAuth token when saving Settings with empty PAT field

saveTokens now skips the githubAuth→null sync when the current auth
method is 'oauth' and githubPat is being cleared (empty field). SettingsPanel
also omits githubPat from the patch entirely when signed in via OAuth and
the PAT field is empty (belt-and-braces). Regression tests added for all
three scenarios: oauth-preserve, pat-clear, and oauth→pat switch.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Failing tests for Bug 2 (read-once settings)

**Files:**
- Modify: `src/components/FileDiff.test.ts`

The key test for Bug 2 must prove that an already-mounted component responds to a settings change without remounting. Because `FileDiff` is rendered inside `InspectStep`, we use `FileDiff` directly.

- [ ] **Step 4.1: Read FileDiff.test.ts to understand existing structure**

Read `src/components/FileDiff.test.ts` — the existing tests pass a `testFileDisplay` prop or call `setTestFileDisplay`. Note the import pattern and test helpers.

- [ ] **Step 4.2: Add failing live-reactivity test to FileDiff.test.ts**

At the top of `src/components/FileDiff.test.ts`, ensure `setTestFileDisplay` is imported (it may already be). Then add this describe block at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// Bug 2 regression: testFileDisplay must react live (no remount needed)
// ---------------------------------------------------------------------------
describe('FileDiff — testFileDisplay live reactivity (Bug 2 regression)', () => {
  beforeEach(() => { localStorage.clear() })

  it('switching testFileDisplay from normal→highlight adds test-highlight class without remounting', async () => {
    setTestFileDisplay('normal')
    const patch = '@@ -1 +1 @@\n-old\n+new'
    const file: PrFile = {
      filename: 'src/utils.test.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch,
    }
    const { container } = render(FileDiff, {
      props: {
        file,
        mode: 'unified',
        draftStore: null,
        prComments: [],
        resolvedCommentIds: new Set(),
        contentsMap: null,
        skillFindings: [],
        onAddDraft: () => {},
        onRemoveDraft: () => {},
        onDismissFinding: () => {},
        onAddFindingAsDraft: () => {},
      },
    })

    // Initially: no highlight
    expect(container.querySelector('header.test-highlight')).not.toBeInTheDocument()

    // Change setting — no remount
    setTestFileDisplay('highlight')
    await tick()

    // After: should have highlight class
    expect(container.querySelector('header.test-highlight')).toBeInTheDocument()
  })
})
```

Note: `tick` must be imported from `svelte`. Add `import { tick } from 'svelte'` to the imports at the top of FileDiff.test.ts if not already present.

- [ ] **Step 4.3: Verify test FAILS**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test -- --reporter=verbose src/components/FileDiff.test.ts 2>&1 | tail -20
```

Expected: the new live-reactivity test fails (class is not present after `setTestFileDisplay('highlight')` because `$derived` doesn't re-run). All other FileDiff tests pass.

---

## Task 5: Create settingsState.svelte.ts

**Files:**
- Create: `src/lib/settings/settingsState.svelte.ts`
- Modify: `src/lib/settings/settings.ts`

- [ ] **Step 5.1: Add notify hook to settings.ts**

In `settings.ts`, after the existing `_onAuthMutated` / `_registerAuthRefresh` / `notifyAuthMutated` block (lines 7–13), add:

```typescript
let _onSettingsMutated: (() => void) | null = null
export function _registerSettingsRefresh(fn: () => void): void {
  _onSettingsMutated = fn
}
function notifySettingsMutated(): void {
  _onSettingsMutated?.()
}
```

Then call `notifySettingsMutated()` from the private `save()` function (line 155–156), right after `localStorage.setItem`:

```typescript
function save(patch: Partial<Settings>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...getSettings(), ...patch }))
  notifySettingsMutated()
}
```

This ensures every write path (`setTheme`, `setTestFileDisplay`, `saveTokens`, `saveGithubAuth`, etc.) triggers the notification because they all call the private `save()`.

**Exception:** `saveGithubAuth` calls `save()` directly and also calls `notifyAuthMutated()` — no extra work needed.

- [ ] **Step 5.2: Create settingsState.svelte.ts**

Create `src/lib/settings/settingsState.svelte.ts`:

```typescript
import { getSettings, _registerSettingsRefresh, type Settings } from './settings'

/**
 * Reactive settings state backed by a Svelte 5 $state rune.
 * settingsState.current always reflects the most recently saved Settings.
 *
 * Wiring: settings.ts exposes _registerSettingsRefresh(fn) — fired after every
 * write to localStorage. We register refreshSettingsState here so components
 * that derive from settingsState.current re-render automatically when any
 * setting changes, without a static import cycle.
 */
const holder = $state<{ current: Settings }>({ current: getSettings() })

export const settingsState = {
  get current(): Settings {
    return holder.current
  },
}

export function refreshSettingsState(): void {
  holder.current = getSettings()
}

// Register so settings.ts notifies us after every mutation.
_registerSettingsRefresh(refreshSettingsState)

/**
 * FOR TESTS ONLY: reset module-level state so each test starts clean.
 * Call this in beforeEach alongside localStorage.clear().
 */
export function _resetSettingsStateForTest(): void {
  holder.current = getSettings()
}
```

- [ ] **Step 5.3: Verify no TypeScript errors**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm check 2>&1 | tail -20
```

Expected: 0 errors.

---

## Task 6: Wire FileDiff.svelte to settingsState

**Files:**
- Modify: `src/components/FileDiff.svelte:7` (import) and `src/components/FileDiff.svelte:113` ($derived)

- [ ] **Step 6.1: Update FileDiff.svelte**

In `src/components/FileDiff.svelte`, line 7 currently reads:
```typescript
  import { getSettings, type TestFileDisplay } from '../lib/settings/settings'
```

Replace with:
```typescript
  import { type TestFileDisplay } from '../lib/settings/settings'
  import { settingsState } from '../lib/settings/settingsState.svelte'
```

Then at line 113, replace:
```typescript
  const testFileDisplay = $derived<TestFileDisplay>(getSettings().testFileDisplay)
```
with:
```typescript
  const testFileDisplay = $derived<TestFileDisplay>(settingsState.current.testFileDisplay)
```

- [ ] **Step 6.2: Run the live-reactivity test**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test -- --reporter=verbose src/components/FileDiff.test.ts 2>&1 | tail -20
```

Expected: ALL FileDiff tests pass including the new live-reactivity test.

- [ ] **Step 6.3: Run full test suite**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

---

## Task 7: Failing test for showProgress live-reactivity, then fix Review.svelte

**Files:**
- Modify: `src/routes/Review.svelte:315`

The `Review.svelte` component is complex and does not have a unit test for `showProgress` reactivity, so we add one first, then fix.

Note: `Review.svelte` is a full route component — its test file may not exist. We add the test to an appropriate existing test file. Check if `src/routes/Review.test.ts` exists:

```bash
ls /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1/src/routes/
```

If no Review test file exists, the `showProgress` live-reactivity test belongs in a new `src/routes/Review.showprogress.test.ts`. However, given the complexity of mounting `Review.svelte`, a simpler approach is to test the behavior at the `settingsState` layer and document the `Review.svelte` change as structural (the existing InspectStep testfile tests already cover the settingsState mechanism end-to-end via `FileDiff`).

- [ ] **Step 7.1: Check for existing Review route tests**

```bash
ls /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1/src/routes/ 2>&1
find /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1/src/routes -name "*.test.*" 2>&1
```

- [ ] **Step 7.2: Add settingsState reactivity unit test in settingsState.test.ts**

Create `src/lib/settings/settingsState.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setShowProgress, setTestFileDisplay } from './settings'
import { settingsState, _resetSettingsStateForTest } from './settingsState.svelte'

describe('settingsState — reactive facade', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetSettingsStateForTest()
  })

  it('settingsState.current reflects default settings on init', () => {
    expect(settingsState.current.showProgress).toBe(true)
    expect(settingsState.current.testFileDisplay).toBe('normal')
  })

  it('settingsState.current updates after setShowProgress(false) without remount', () => {
    expect(settingsState.current.showProgress).toBe(true)
    setShowProgress(false)
    expect(settingsState.current.showProgress).toBe(false)
  })

  it('settingsState.current updates after setTestFileDisplay("highlight") without remount', () => {
    expect(settingsState.current.testFileDisplay).toBe('normal')
    setTestFileDisplay('highlight')
    expect(settingsState.current.testFileDisplay).toBe('highlight')
  })

  it('settingsState.current remains consistent with getSettings()', () => {
    setShowProgress(false)
    setTestFileDisplay('dim')
    const direct = getSettings()
    expect(settingsState.current.showProgress).toBe(direct.showProgress)
    expect(settingsState.current.testFileDisplay).toBe(direct.testFileDisplay)
  })
})
```

- [ ] **Step 7.3: Verify the settingsState tests FAIL first (before Task 5 is implemented)**

Wait — if Task 5 was already implemented (Tasks 5 and 6 completed), these should PASS. The failing test requirement was met by the FileDiff live-reactivity test in Task 4. These settingsState unit tests are confirmatory; they should pass once Task 5 is done.

Run:
```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test -- --reporter=verbose src/lib/settings/settingsState.test.ts 2>&1 | tail -20
```

Expected: all 4 tests pass.

- [ ] **Step 7.4: Fix showProgress in Review.svelte**

In `src/routes/Review.svelte`, find the import block at the top. Add `settingsState` import. Then:

Find line ~315:
```typescript
  let showProgress = $state(getSettings().showProgress)
```

Replace with:
```typescript
  const showProgress = $derived(settingsState.current.showProgress)
```

Also add the import. Find the existing settings import (likely `import { getSettings, ... } from '../lib/settings/settings'`). Add a new import line after it:
```typescript
  import { settingsState } from '../lib/settings/settingsState.svelte'
```

If `getSettings` is no longer needed after this change, check if it's used elsewhere in Review.svelte before removing it (it likely still is for `railCollapsed` init and other uses — leave it).

- [ ] **Step 7.5: Run full test suite**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 7.6: TypeScript check**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm check 2>&1 | tail -20
```

Expected: 0 errors.

- [ ] **Step 7.7: Commit Bug 2 fix**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
git add src/lib/settings/settings.ts src/lib/settings/settingsState.svelte.ts src/lib/settings/settingsState.test.ts src/components/FileDiff.svelte src/components/FileDiff.test.ts src/routes/Review.svelte
git commit -m "$(cat <<'EOF'
fix: make testFileDisplay and showProgress settings reactive (no remount needed)

Adds settingsState.svelte.ts — a $state-backed facade over Settings, wired
via a _registerSettingsRefresh hook in settings.ts (same pattern as authState).
FileDiff.svelte now derives testFileDisplay from settingsState.current so the
test-highlight/test-dim classes update live. Review.svelte derives showProgress
the same way. Regression tests added for live reactivity in FileDiff and for
the settingsState facade itself.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Fix Bug 3 (copy)

**Files:**
- Modify: `src/components/SettingsPanel.svelte:467`

- [ ] **Step 8.1: Change the copy**

In `src/components/SettingsPanel.svelte`, find line 467:
```svelte
        <p class="mine-gate-hint">Sign in with GitHub (above) to use this feature.</p>
```

Replace with:
```svelte
        <p class="mine-gate-hint">Sign in with GitHub from the top bar to use this feature.</p>
```

- [ ] **Step 8.2: Add test for the new copy text**

In `src/components/SettingsPanel.skills.test.ts` (or create a new inline `describe` in `SettingsPanel.test.ts` if that file doesn't have a mine-gate section), add:

```typescript
describe('SettingsPanel — mine-skill gate copy (Bug 3 regression)', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetAuthStateForTest()
  })

  it('mine-gate hint says "from the top bar" not "(above)"', async () => {
    // No auth seeded → gate hint should show
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const hint = screen.getByText(/sign in with github from the top bar to use this feature/i)
    expect(hint).toBeInTheDocument()
    expect(screen.queryByText(/sign in with github \(above\)/i)).not.toBeInTheDocument()
  })
})
```

Note: check if `SettingsPanel.skills.test.ts` imports `_resetAuthStateForTest` — read it first to understand its import set.

- [ ] **Step 8.3: Run test to confirm it passes**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test -- --reporter=verbose src/components/SettingsPanel.test.ts src/components/SettingsPanel.skills.test.ts 2>&1 | tail -20
```

Expected: new copy test passes; all other tests pass.

- [ ] **Step 8.4: Run full test suite**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 8.5: Commit Bug 3 fix**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
git add src/components/SettingsPanel.svelte src/components/SettingsPanel.test.ts
git commit -m "$(cat <<'EOF'
fix: correct mine-skill gate hint text to reference the top bar

The sign-in button is in the top bar, not "above" in the modal.
Updated copy: "Sign in with GitHub from the top bar to use this feature."
Regression test added.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final gate and push

- [ ] **Step 9.1: Run full gate**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
pnpm check && pnpm test && pnpm exec playwright test && pnpm build 2>&1 | tail -40
```

Expected: all commands succeed.

- [ ] **Step 9.2: Push**

```bash
cd /Users/admin/Developing/review123/.claude/worktrees/agent-ad8dedbaf01a6e5f1
git push origin feat/plan-e-integration
```

---

## Self-review

**Spec coverage check:**

| Requirement | Task |
|-------------|------|
| Bug 1: saveTokens preserves OAuth when githubPat→null | Task 2 |
| Bug 1: SettingsPanel.save() omits githubPat when oauth+empty | Task 3 |
| Bug 1: Regression test (oauth seed → save empty → auth unchanged) | Task 1 |
| Bug 1: PAT user clearing still clears | Task 1 |
| Bug 1: oauth user entering PAT switches method | Task 1 |
| Bug 2: settingsState.svelte.ts reactive facade | Task 5 |
| Bug 2: _registerSettingsRefresh hook in settings.ts | Task 5 |
| Bug 2: FileDiff.svelte derives from settingsState | Task 6 |
| Bug 2: Review.svelte derives showProgress from settingsState | Task 7 |
| Bug 2: Failing test first (live-reactivity FileDiff) | Task 4 |
| Bug 3: Copy fix in SettingsPanel | Task 8 |
| Gate: pnpm check && pnpm test && playwright && build | Task 9 |

**Placeholder scan:** No TBD/TODO/placeholder patterns found. All code blocks are complete.

**Type consistency:** `settingsState.current` typed as `Settings` throughout. `_resetSettingsStateForTest` matches the function exported by the new module. `_registerSettingsRefresh` matches the export in settings.ts.
