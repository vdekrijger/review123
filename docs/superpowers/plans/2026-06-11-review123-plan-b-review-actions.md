# Review 1-2-3 — Plan B: Auth + Review Actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in with GitHub (OAuth PKCE, incremental scopes, one serverless exchange function, PAT fallback), draft line comments in a WYSIWYG markdown editor, and submit real reviews (APPROVE / REQUEST_CHANGES / COMMENT) from Step 3.

**Architecture:** Static SPA + ONE serverless function (`api/oauth/exchange.ts`, holds only the app client secret). Tokens live client-side. Drafts in IndexedDB. All new lib modules follow Plan A patterns: pure, typed, TDD'd; UI thin. Existing `ghFetch`/`buildHeaders` gains OAuth-token precedence.

**Tech stack additions:** `fake-indexeddb` (dev), `marked` + `dompurify` (markdown preview — deterministic, no heavyweight editor dep; toolbar is ~6 buttons of our own), Vercel Node serverless function.

**Criteria covered (must-haves):** REQ-02 (EC-02a,b,c,d,e,k,l), REQ-03 (EC-03a,b,c,e), REQ-04 (EC-04d scope guidance, integration), REQ-07 (EC-07a,d,e,f,h,i), REQ-08 (EC-08c,f), REQ-09 (EC-09a,c,d,e,f,g,i), REQ-19 (EC-19b), REQ-20 (EC-20a). CH-02 (anchoring) addressed in Task 7.

**Branch:** `feat/plan-b-review-actions` off main. Commit per task.

---

### Task 1: lib/auth — PKCE/state machinery + token model (REQ-02, REQ-03 core)

**Files:** Create `src/lib/auth/auth.ts`, `src/lib/auth/pkce.ts`; modify `src/lib/settings/settings.ts`; Test: `src/lib/auth/*.test.ts`, extend settings tests.

- [ ] Settings gains `githubAuth: { token: string; method: 'oauth' | 'pat'; scopes: string[] } | null` replacing bare `githubPat` (migration: on read, legacy `githubPat` string coerces to `{token, method:'pat', scopes:[]}`; keep `setGithubPat` working). All existing tests must stay green; add migration test.
- [ ] `pkce.ts`: `generateVerifier()` (43-128 char URL-safe random via crypto.getRandomValues), `challengeFromVerifier(v)` (S256: base64url(SHA-256)) — async, WebCrypto. Tests: verifier charset/length; challenge matches a known RFC 7636 test vector (verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`).
- [ ] `auth.ts`:
  - `beginSignIn(scope: 'public_repo' | 'repo'): Promise<string>` — generates state + verifier, stores both in sessionStorage (`review123:oauth`), returns the authorize URL: `https://github.com/login/oauth/authorize?client_id=<VITE_GITHUB_CLIENT_ID>&redirect_uri=<origin>/auth/callback&scope=<scope>&state=<state>&code_challenge=<S256>&code_challenge_method=S256` (PKCE params sent; GitHub may ignore them for OAuth apps — state is the load-bearing CSRF defense, EC-02d).
  - `completeSignIn(params: URLSearchParams): Promise<Result>` — validates `state` against sessionStorage (mismatch → `{ok:false, error:'state-mismatch'}` EC-02d), missing code → `'missing-code'` (EC-02a), `error=access_denied` → `'denied'` (EC-02b), missing stored verifier → `'no-verifier'` (EC-02c); POSTs `{code, code_verifier}` to `/api/oauth/exchange`; non-200 or `{error}` body → `'exchange-failed'` (EC-02e/k); missing `access_token` in body → `'exchange-failed'`; success → saves `{token, method:'oauth', scopes: scope.split(',')}` via settings, clears sessionStorage, returns `{ok:true}`.
  - `needsScopeUpgrade(): boolean` — true when signed in via oauth without `repo` scope (REQ-03; PAT method never needs upgrade — EC-03e/EC-03c).
  - Tests (vi.stubGlobal fetch + sessionStorage): every EC above with exact error discriminants; success path stores token and clears the verifier; `repo`-scoped completion records scopes.

### Task 2: api/oauth/exchange — the serverless function (REQ-02, EC-02l)

**Files:** Create `api/oauth/exchange.ts`; Test: `src/lib/auth/exchange-handler.test.ts` (handler logic extracted pure); modify `README.md`, `vite.config.ts` (dev proxy note).

- [ ] Pure handler in `api/oauth/exchange.ts` exported as `exchangeHandler(body, env, fetchFn)` plus the Vercel default export wiring `(req, res)`:
  - Validates body has `code` (string) → else 400 `{error:'missing-code'}`.
  - POSTs to `https://github.com/login/oauth/access_token` with `{client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, code, code_verifier}` and `Accept: application/json`.
  - GitHub error body (`{error:'bad_verification_code'}`) → 400 with that error passed through (EC-02k). Success → 200 `{access_token, scope}` ONLY (never echo the secret; never log the token — no console calls in the file at all, EC-02l).
  - Same-origin only: reject when `req.headers.origin` is present and its host ≠ `req.headers.host` (CSRF hardening) → 403.
- [ ] Tests: missing code → 400; GitHub error passthrough; success returns only access_token+scope; foreign-origin → 403; no `console.*` in file (test greps the source — cheap EC-02l proof).
- [ ] README: new "GitHub OAuth setup" section — register OAuth app (callback `https://<domain>/auth/callback`), set `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET` in Vercel env and `VITE_GITHUB_CLIENT_ID` (build-time, public); local dev = PAT fallback or `vercel dev`.

### Task 3: Sign-in UI + callback route + incremental scope prompts (REQ-03, REQ-19)

**Files:** Create `src/routes/AuthCallback.svelte`; modify `src/lib/router/router.svelte.ts` (add `/auth/callback` route), `src/App.svelte` (SignIn/avatar button), `src/routes/Review.svelte` (private-repo re-auth prompt), `src/components/SettingsPanel.svelte` (show auth method/state). Tests: router, callback component, Review re-auth branch.

- [ ] Router: `/auth/callback` → `{name:'auth-callback'}` route + test.
- [ ] `AuthCallback.svelte`: on mount calls `completeSignIn(new URLSearchParams(location.search))`; success → `track('signed_in', {method:'oauth'})`, navigate to `/` (or sessionStorage-recorded return path); each error discriminant renders a specific message with "try again" → landing (EC-02a/b/d/e). Component test with stubbed completeSignIn covering success + one error.
- [ ] App topbar: when signed out → "Sign in with GitHub" button → `location.assign(await beginSignIn('public_repo'))`; signed in → method badge + sign-out (clears auth).
- [ ] Review route: when load fails `not-found` AND signed in via oauth without `repo` scope → render "This may be a private repo — grant access to private repositories" button → `beginSignIn('repo')` (EC-03a). Decline path = user simply doesn't click; message also offers PAT via Settings (EC-03b). When `needsScopeUpgrade()` is false and method is oauth+repo, do not re-prompt (EC-03c).
- [ ] Submission gate moves into VerdictStep (Task 8) but the shared `requireAuth()` helper lands here: returns `{ok:true}` if any token, else `{ok:false}` so callers render sign-in prompt (EC-09c, EC-19b).

### Task 4: lib/drafts — IndexedDB draft store (REQ-07)

**Files:** Create `src/lib/drafts/drafts.svelte.ts`; Test: `src/lib/drafts/drafts.test.ts`. Dev dep: `fake-indexeddb`.

- [ ] API (reactive store + async persistence):
  ```ts
  export interface Draft { prKey: string; path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; updatedAt: number }
  export function draftKey(d: Pick<Draft,'prKey'|'path'|'line'|'side'>): string   // `${prKey}|${path}|${line}|${side}`
  export function createDraftStore(prKey: string)  // returns { drafts: Draft[] ($state-backed), load(): Promise<void>, upsert(d): Promise<void>, remove(key): Promise<void>, clearAll(): Promise<void>, count (getter) }
  ```
  Raw IndexedDB (open db `review123-drafts`, store `drafts`, keyPath derived key) behind ~60-line promisified helper in the same file. No new runtime dep.
- [ ] Behavior: `upsert` with empty/whitespace body removes instead of saving (EC-07a); same key overwrites (EC-07e last-write); bodies stored verbatim (unicode/markdown/HTML — sanitization is render-side, EC-07d); IndexedDB unavailable (`indexedDB` undefined or open rejects) → store works in-memory and exposes `persistent: false` for the UI warning (EC-07h).
- [ ] Tests with fake-indexeddb: load round-trip (simulated tab close = new store instance reads same data, EC-07f); empty-body removal; overwrite; per-PR isolation (different prKey sees nothing); in-memory fallback when indexedDB is deleted from globalThis; count reactivity.

### Task 5: CommentEditor — markdown editor with toolbar + sanitized live preview (REQ-08)

**Files:** Create `src/components/CommentEditor.svelte`, `src/lib/markdown/render.ts`; Tests for both. Deps: `marked`, `dompurify`.

- [ ] `render.ts`: `renderMarkdown(src: string): string` — marked (gfm: true, breaks: true) piped through DOMPurify with a conservative allowlist (no `style`, no event handlers, links get `rel="noopener nofollow"`). Tests: `<script>alert(1)</script>` stripped; `<img onerror=...>` attribute stripped; ``` fences render `<pre><code>`; `[x](javascript:...)` href neutralized (EC-08c).
- [ ] `CommentEditor.svelte`: props `{ value: string, onchange: (v: string) => void, onsubmit?: () => void }`. Textarea + toolbar buttons (bold **, italic _, code `` ` ``, code block, link, list) operating on the current selection via `selectionStart/End` (insert markers around selection; empty selection inserts markers with cursor between — EC-08f); tab toggle Write/Preview where Preview sets `innerHTML = renderMarkdown(value)` (already sanitized). Buttons have `aria-label`s.
- [ ] Component tests: typing fires onchange; bold button wraps selection (`**sel**`) and empty-selection inserts `****` with cursor centered (assert via value + selection where jsdom allows, else value shape only); preview renders sanitized HTML (script stripped); EC-08c regression via the render.ts tests.

### Task 6: Line-comment affordance in the diff + drafts wiring (REQ-07 UI, REQ-20a)

**Files:** Modify `src/components/FileDiff.svelte`, `src/routes/Review.svelte`; create `src/components/DraftThread.svelte`. Tests: component-level for DraftThread; integration test in Review.test.

- [ ] **Research step (required first):** read `node_modules/@git-diff-view/svelte` README + d.ts for the widget/extend API — the React package exposes `onAddWidgetClick` + `renderWidgetLine` (slot) and `extendData` for per-line annotations; find the Svelte equivalents (likely `onAddWidgetClick` prop + `widget` snippet/slot). If the Svelte wrapper lacks widget support entirely, fallback: render DraftThread blocks BELOW each FileDiff listing that file's drafts with line numbers + an "add comment at line N" numeric input — degraded but functional; record the limitation in the task report.
- [ ] FileDiff: new props `{ drafts: Draft[], onDraft: (line: number, side: 'LEFT'|'RIGHT') => void }`; widget click opens DraftThread anchored at the line; existing drafts render as annotation rows.
- [ ] `DraftThread.svelte`: shows existing draft body (rendered via renderMarkdown) + CommentEditor; save → `upsert`, delete → `remove`.
- [ ] Review.svelte: instantiate `createDraftStore(`${owner}/${repo}#${number}@${headSha}`)` on ready; pass drafts per file; sticky bottom bar shows `{store.count} comment(s) drafted` (EC-07i) and persists across step navigation (EC-20a — test: draft in step 2, go step 3, back to 2, draft still shown; count test).
- [ ] When `store.persistent === false` show the one-line warning (EC-07h).

### Task 7: lib/github/review — submission with correct anchoring (REQ-09, CH-02)

**Files:** Create `src/lib/github/review.ts`; Test: `src/lib/github/review.test.ts`.

- [ ] API:
  ```ts
  export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  export interface SubmitResult { ok: true } 
  export type SubmitError = { ok: false; kind: 'unauthorized' | 'forbidden' | 'self-approve' | 'invalid-anchor'; message: string } | { ok: false; kind: 'other'; message: string }
  export async function submitReview(ref: PrRef, verdict: Verdict, bodyText: string, drafts: Draft[], commitId: string): Promise<SubmitResult | SubmitError>
  ```
  POST `/repos/{owner}/{repo}/pulls/{number}/reviews` via `ghFetch` with `{ commit_id, body, event, comments: drafts.map(d => ({ path: d.path, line: d.line, side: d.side, body: d.body })) }` — modern `line`/`side` anchoring, NOT the deprecated `position` (CH-02). Map errors: 401→unauthorized, 403→forbidden, 422 with message matching /own pull request/i → self-approve (EC-09e), other 422 → invalid-anchor with GitHub's message verbatim (EC-09f), else other with verbatim message (errors must surface verbatim — spec).
- [ ] In-flight guard: module keeps a `submitting` flag per prKey; second call while in-flight returns `{ok:false, kind:'other', message:'already submitting'}` without a network call (EC-09i).
- [ ] Tests: zero-comment APPROVE posts without comments key or with empty array (EC-09a — assert request body); comment mapping includes path/line/side/body; each error mapping incl. 422 variants asserted on the parsed body message; double-submit fires exactly one fetch (EC-09i); network failure → other + drafts untouched (caller owns clearing — EC-09g is enforced in Task 8).

### Task 8: VerdictStep — recap, submit, clear-on-success-only (REQ-09 UI, REQ-19)

**Files:** Create `src/components/VerdictStep.svelte`; modify `src/routes/Review.svelte` (step 3 renders it). Tests: component test with stubbed submitReview.

- [ ] Renders: drafted comments grouped by file (body via renderMarkdown), overall-comment CommentEditor, verdict radio (Comment / Approve / Request changes), Submit button.
- [ ] Signed out → no form; sign-in prompt via `requireAuth()` (EC-09c, EC-19b).
- [ ] Submit flow: disable button while in-flight; on `{ok:true}` → `store.clearAll()`, `track('review_submitted', {verdict, comment_count})`, success state with link to the PR on GitHub; on error → render `message` verbatim, drafts NOT cleared (EC-09g/d/e/f — test asserts drafts survive a failed submit and are cleared only on success).
- [ ] REQUEST_CHANGES/COMMENT with empty body and zero drafts → client-side hint (GitHub 422s on empty REQUEST_CHANGES; surface before the round-trip; APPROVE allows empty — EC-09a).

### Task 9: Auth precedence in the GitHub client (REQ-04 integration)

**Files:** Modify `src/lib/github/client.ts`, `src/lib/settings/settings.ts` consumers; tests.

- [ ] `buildHeaders` reads the unified `githubAuth` (Task 1 model): OAuth token or PAT — whichever is stored (single slot resolves EC-04f by construction). 401 responses keep mapping to `unauthorized`; Review route's unauthorized message now offers BOTH "sign in again" and Settings/PAT (EC-04e/d).
- [ ] Tests: header uses oauth token when method oauth; legacy PAT-only storage still authenticates (migration); 401 with oauth token → unauthorized error unchanged.

### Task 10: Verify script + README + final wiring

**Files:** Modify `scripts/verify-review123-plan-a.sh`→ keep; create `scripts/verify-review123-plan-b.sh` (same pattern: gates + per-EC vitest filters for every must-have EC listed in this plan's header); README sections (OAuth setup from Task 2, drafts/privacy note: drafts stay in your browser); `pnpm check && pnpm test && pnpm build` CI-parity run.

---

## Execution notes

- Wave structure: Task 1 → {2, 4, 5} parallel → {3, 9} parallel → {6, 7} parallel → 8 → 10. Spec+quality reviews per wave, same as Plan A.
- New deps (`marked`, `dompurify`, `fake-indexeddb`) may hit the 7-day `minimumReleaseAge` gate — pin back a version when blocked; note pins.
- `VITE_GITHUB_CLIENT_ID` absent → Sign-in button hidden, PAT-only mode (graceful: tests cover the hidden state). This keeps local dev and forks working with zero OAuth setup.

## Definition of done

- All must-have ECs in the header green via `./scripts/verify-review123-plan-b.sh`; full suite + check + build green.
- Manual checkpoint: real OAuth round-trip on the Vercel preview (needs the OAuth app registered — user action), drafted comment submitted to a real test PR.
- NOT in Plan B: AI features, cache, consent gate, CI signals (Plan C); interdiff (nice-to-have backlog).
