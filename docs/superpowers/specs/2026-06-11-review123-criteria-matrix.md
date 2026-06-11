# Review 1-2-3 — Criteria Matrix

```yaml
CRITERIA_MATRIX:
  source_spec: docs/superpowers/specs/2026-06-11-review123-design.md
  generated_at: 2026-06-11
  triage: proposed by Claude (rules: must = security/privacy, data loss,
    token cost, deterministic core logic, common failure paths;
    nice = a11y polish, exotic inputs, rare races, speculative failures),
    pending user review — flip any item by editing `priority`.

REQUIREMENTS:
  - id: REQ-01
    description: Parse GitHub PR URLs (public and private) into owner/repo/number for routing
    happy_path: Pasting https://github.com/owner/repo/pull/123 parses to owner, repo, number=123 and navigates to /review/owner/repo/123
    proof_type: [test]
    edge_cases:
      - { id: EC-01a, priority: must-have, proof_type: [test], description: "Null/undefined URL input passed to parser returns a structured 'invalid URL' error, not a throw" }
      - { id: EC-01b, priority: must-have, proof_type: [test, visual], description: "Empty string URL produces inline 'enter a PR URL' message on landing, no navigation" }
      - { id: EC-01c, priority: nice-to-have, proof_type: [test], description: "Whitespace-only URL ('   ') is treated as empty/invalid, not parsed" }
      - { id: EC-01d, priority: nice-to-have, proof_type: [test], description: "PR number boundary 0 (.../pull/0) is rejected as invalid" }
      - { id: EC-01e, priority: nice-to-have, proof_type: [test], description: "PR number minimum valid (.../pull/1) parses successfully" }
      - { id: EC-01f, priority: nice-to-have, proof_type: [test], description: "Extremely large PR number (.../pull/999999999999) parses without integer overflow or is rejected cleanly" }
      - { id: EC-01g, priority: nice-to-have, proof_type: [test], description: "Negative PR number (.../pull/-1) is rejected as invalid" }
      - { id: EC-01h, priority: must-have, proof_type: [test], description: "Non-numeric PR segment (.../pull/abc) is rejected as invalid" }
      - { id: EC-01i, priority: must-have, proof_type: [test], description: "Malformed URL — partial (github.com/owner), wrong host (gitlab.com/...), issue URL (/issues/123) — each yields specific inline 'not a PR URL' message" }
      - { id: EC-01j, priority: must-have, proof_type: [test], description: "URL with trailing path/query/fragment (.../pull/123/files, #discussion, ?w=1) still parses to number 123" }
      - { id: EC-01k, priority: nice-to-have, proof_type: [test], description: "Owner/repo containing valid special chars (hyphen, dot, underscore) parses correctly" }
      - { id: EC-01l, priority: must-have, proof_type: [test], description: "Unicode/emoji or script-injection string in owner/repo segment is not executed and is rejected or safely encoded" }
      - { id: EC-01m, priority: nice-to-have, proof_type: [test], description: "Extremely long URL (10k+ chars) is rejected or handled without hang" }
      - { id: EC-01n, priority: nice-to-have, proof_type: [test], description: "http:// and protocol-less URL forms are normalized or accepted consistently" }
      - { id: EC-01o, priority: must-have, proof_type: [test, visual], description: "Deep-link directly to /review/:owner/:repo/:number with invalid number renders landing-style error, not a broken stepper" }

  - id: REQ-02
    description: GitHub OAuth sign-in via PKCE with serverless code-exchange function; token stored client-side only
    happy_path: Sign in → GitHub authorize → redirect with code → /api/oauth/exchange swaps code+verifier for token → token in localStorage → GitHub calls authenticated
    proof_type: [test, visual-flow]
    edge_cases:
      - { id: EC-02a, priority: must-have, proof_type: [test], description: "Redirect returns with missing/empty code param → return to landing with OAuth error message" }
      - { id: EC-02b, priority: must-have, proof_type: [test, visual], description: "User denies authorization (error=access_denied) → landing message, PAT fallback offered" }
      - { id: EC-02c, priority: must-have, proof_type: [test], description: "PKCE verifier missing from client state (localStorage cleared mid-flow) → exchange aborts with clear error" }
      - { id: EC-02d, priority: must-have, proof_type: [test], description: "State/CSRF param mismatch between authorize request and callback → exchange rejected" }
      - { id: EC-02e, priority: must-have, proof_type: [test], description: "Exchange function returns 4xx (bad/expired code) → landing message, no token stored" }
      - { id: EC-02f, priority: nice-to-have, proof_type: [test], description: "Exchange function returns 5xx (GitHub token endpoint down) → landing message, retry/PAT path available" }
      - { id: EC-02g, priority: nice-to-have, proof_type: [test], description: "Network timeout/disconnect during exchange → no infinite spinner; error surfaced" }
      - { id: EC-02h, priority: nice-to-have, proof_type: [test], description: "Exchange returns unexpected shape (missing access_token) → handled as failure, not stored as undefined" }
      - { id: EC-02i, priority: nice-to-have, proof_type: [test], description: "Rapid double-click sign-in / double callback does not double-consume code or store conflicting tokens" }
      - { id: EC-02j, priority: nice-to-have, proof_type: [test], description: "Response arrives after user navigated away from callback page → no state write to unmounted view" }
      - { id: EC-02k, priority: must-have, proof_type: [test], description: "Token endpoint returns error JSON body ({error: bad_verification_code}) → surfaced, not treated as success" }
      - { id: EC-02l, priority: must-have, proof_type: [test], description: "Exchange function does not log or persist the user token (stateless guarantee) verifiable in function tests" }
      - { id: EC-02m, priority: nice-to-have, proof_type: [manual], description: "Sign-in flow keyboard-navigable and announced to screen reader" }

  - id: REQ-03
    description: Incremental OAuth scopes — public_repo at sign-in; re-authorization for repo scope on first private PR
    happy_path: First sign-in requests public_repo; opening a private PR triggers re-auth requesting repo; after grant, private PR loads
    proof_type: [test, visual-flow]
    edge_cases:
      - { id: EC-03a, priority: must-have, proof_type: [test, visual], description: "Private PR opened with only public_repo scope → re-auth prompt shown, not a silent 404" }
      - { id: EC-03b, priority: must-have, proof_type: [test], description: "User declines repo re-authorization → private PR inaccessible with clear message, public flows unaffected" }
      - { id: EC-03c, priority: must-have, proof_type: [test], description: "User already holds repo scope → opening private PR does not re-prompt" }
      - { id: EC-03d, priority: nice-to-have, proof_type: [test], description: "Scope revoked on GitHub after page load → fetch 403/404 handled, re-auth offered" }
      - { id: EC-03e, priority: must-have, proof_type: [test], description: "PAT-authenticated user opening private PR uses PAT scope directly, no re-auth flow triggered" }

  - id: REQ-04
    description: PAT fallback auth — enter PAT in Settings as alternative to OAuth
    happy_path: Valid PAT pasted in Settings → stored in localStorage → GitHub calls use it, unlocking private/write
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-04a, priority: must-have, proof_type: [test], description: "Empty PAT field saved → rejected with validation message, not stored as empty token" }
      - { id: EC-04b, priority: nice-to-have, proof_type: [test], description: "Whitespace-padded PAT is trimmed before storage/use" }
      - { id: EC-04c, priority: must-have, proof_type: [test], description: "Malformed PAT → GitHub 401 on first use → surfaced as 'invalid token' prompt" }
      - { id: EC-04d, priority: must-have, proof_type: [test], description: "PAT with insufficient scope on private PR → 404/403 surfaced as permission/scope guidance" }
      - { id: EC-04e, priority: must-have, proof_type: [test], description: "Expired/revoked PAT → 401 surfaced, settings prompt to re-enter" }
      - { id: EC-04f, priority: nice-to-have, proof_type: [test], description: "Both OAuth token and PAT present — precedence is deterministic" }
      - { id: EC-04g, priority: nice-to-have, proof_type: [test], description: "Extremely long string pasted into PAT field handled without crash" }
      - { id: EC-04h, priority: must-have, proof_type: [test, visual], description: "PAT input masks the value and is never sent to PostHog or any host other than GitHub" }

  - id: REQ-05
    description: Fetch PR data from GitHub REST — metadata, per-file patches, before/after contents at base/head SHAs
    happy_path: Parallel fetches return meta, patches, contents; Step 1 skeleton renders immediately
    proof_type: [test]
    edge_cases:
      - { id: EC-05a, priority: must-have, proof_type: [test, visual], description: "PR not found (404) → specific inline 'PR not found' message" }
      - { id: EC-05b, priority: must-have, proof_type: [test, visual], description: "Private PR fetched without auth (404 masking 403) → 'private — sign in' message" }
      - { id: EC-05c, priority: must-have, proof_type: [test, visual], description: "Rate limit: 403 + X-RateLimit-Remaining 0 → show reset time, suggest signing in" }
      - { id: EC-05d, priority: nice-to-have, proof_type: [test], description: "5xx from GitHub → retryable error state, not blank screen" }
      - { id: EC-05e, priority: nice-to-have, proof_type: [test], description: "Network timeout/disconnect mid-fetch → error surfaced, partial data not rendered as complete" }
      - { id: EC-05f, priority: nice-to-have, proof_type: [test], description: "Partial success — meta succeeds, patches fail → Step 1 shows what loaded, flags failed part" }
      - { id: EC-05g, priority: must-have, proof_type: [test, visual], description: "Empty PR (zero changed files) → 'no changes' state, no crash" }
      - { id: EC-05h, priority: nice-to-have, proof_type: [test], description: "PR with exactly one changed file renders single-file flow correctly" }
      - { id: EC-05i, priority: must-have, proof_type: [test], description: "Very large PR (paginated file list) — pagination fully traversed, partial last page handled" }
      - { id: EC-05j, priority: must-have, proof_type: [test], description: "Binary files / files with no patch (too large, generated) handled without rendering garbage" }
      - { id: EC-05k, priority: must-have, proof_type: [test], description: "Closed/merged PR loads and renders without assuming open state" }
      - { id: EC-05l, priority: nice-to-have, proof_type: [test], description: "Response shape missing expected fields (null patch, missing base SHA) handled defensively" }
      - { id: EC-05m, priority: nice-to-have, proof_type: [test], description: "Stale head SHA — PR updated after initial fetch; no mixing SHAs in one render" }

  - id: REQ-06
    description: Diff view — unified and side-by-side, GitHub-style red/green, word-level intra-line highlights
    happy_path: Diff renders immediately with correct coloring; mode toggle switches layout; changed words highlighted
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-06a, priority: nice-to-have, proof_type: [test], description: "Rapid unified↔side-by-side toggling keeps consistent rendered state" }
      - { id: EC-06b, priority: must-have, proof_type: [test, visual], description: "File with only additions / only deletions colors correctly" }
      - { id: EC-06c, priority: must-have, proof_type: [test, visual], description: "Pure rename / mode-change renders a 'rename only' indicator, not an empty diff" }
      - { id: EC-06d, priority: nice-to-have, proof_type: [test, visual], description: "Extremely long single line (minified file) does not break layout; word-highlight degrades gracefully" }
      - { id: EC-06e, priority: nice-to-have, proof_type: [test, visual], description: "Unicode/emoji/RTL and CRLF vs LF render correctly, highlight at correct boundaries" }
      - { id: EC-06f, priority: nice-to-have, proof_type: [test], description: "Whitespace-only changes shown/colored correctly" }
      - { id: EC-06g, priority: nice-to-have, proof_type: [visual], description: "Side-by-side on narrow mobile viewport falls back or remains usable" }
      - { id: EC-06h, priority: must-have, proof_type: [test, visual], description: "Diff renders fully before any AI stream completes (never blocks on AI)" }
      - { id: EC-06i, priority: nice-to-have, proof_type: [manual], description: "Keyboard navigation through hunks and mode toggle; screen-reader labels present" }

  - id: REQ-07
    description: Per-line comment drafting attached to file+line, persisted in-memory + IndexedDB, survives tab close
    happy_path: Comment affordance on a line → draft attached to file+line, held in memory and IndexedDB, survives reload
    proof_type: [test, visual-flow]
    edge_cases:
      - { id: EC-07a, priority: must-have, proof_type: [test], description: "Empty draft comment is not persisted/submittable" }
      - { id: EC-07b, priority: nice-to-have, proof_type: [test], description: "Whitespace-only draft treated as empty" }
      - { id: EC-07c, priority: nice-to-have, proof_type: [test], description: "Extremely long comment body persisted and submitted without truncation/crash" }
      - { id: EC-07d, priority: must-have, proof_type: [test], description: "Unicode/emoji and markdown/HTML/script-injection text stored and rendered safely (no XSS on preview)" }
      - { id: EC-07e, priority: must-have, proof_type: [test], description: "Multiple drafts on same file+line — last-write/edit behavior deterministic" }
      - { id: EC-07f, priority: must-have, proof_type: [test, visual-flow], description: "Draft created, tab closed mid-typing → reload restores draft from IndexedDB" }
      - { id: EC-07g, priority: nice-to-have, proof_type: [test], description: "Draft on a line whose head SHA changed (line gone) handled gracefully on restore" }
      - { id: EC-07h, priority: must-have, proof_type: [test], description: "IndexedDB unavailable/quota exceeded → in-memory drafting still works; user warned persistence is off" }
      - { id: EC-07i, priority: must-have, proof_type: [test, visual], description: "Drafted-comment count in sticky bar updates as drafts are added/removed" }
      - { id: EC-07j, priority: nice-to-have, proof_type: [test, visual], description: "Zero drafts state — count shows 0 / hidden appropriately" }

  - id: REQ-08
    description: WYSIWYG markdown comment editor — toolbar + live preview
    happy_path: Typing/toolbar produces markdown; live preview renders GitHub-flavored markdown
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-08a, priority: nice-to-have, proof_type: [test, visual], description: "Empty editor shows placeholder and empty preview, no error" }
      - { id: EC-08b, priority: nice-to-have, proof_type: [test], description: "Malformed/unbalanced markdown previews without breaking the page" }
      - { id: EC-08c, priority: must-have, proof_type: [test], description: "HTML/script in markdown is sanitized in preview (no XSS)" }
      - { id: EC-08d, priority: nice-to-have, proof_type: [test, visual], description: "Unicode/emoji/RTL render correctly in editor and preview" }
      - { id: EC-08e, priority: nice-to-have, proof_type: [test], description: "Very large markdown body keeps preview responsive" }
      - { id: EC-08f, priority: must-have, proof_type: [test, visual], description: "Toolbar actions (bold, code, list) on selection and empty selection behave sanely" }
      - { id: EC-08g, priority: nice-to-have, proof_type: [manual], description: "Editor keyboard-operable; toolbar buttons screen-reader labeled" }

  - id: REQ-09
    description: Submit GitHub review — line comments + APPROVE / REQUEST_CHANGES / COMMENT as one real review
    happy_path: Step 3: pick verdict → drafts bundled into one review → submitted; on success drafts cleared
    proof_type: [test, visual-flow]
    edge_cases:
      - { id: EC-09a, priority: must-have, proof_type: [test], description: "Submit with zero comments and a verdict succeeds as comment-less review" }
      - { id: EC-09b, priority: nice-to-have, proof_type: [test], description: "Submit with exactly one comment bundles correctly" }
      - { id: EC-09c, priority: must-have, proof_type: [test, visual], description: "Unauthenticated user attempts submission → prompted to sign in, submission blocked" }
      - { id: EC-09d, priority: must-have, proof_type: [test], description: "User lacks write permission (403) → GitHub error verbatim, drafts preserved" }
      - { id: EC-09e, priority: must-have, proof_type: [test], description: "APPROVE own PR (GitHub 422) → error verbatim, drafts preserved" }
      - { id: EC-09f, priority: must-have, proof_type: [test], description: "Draft references line/file invalid at head (422) → error surfaced, drafts not lost" }
      - { id: EC-09g, priority: must-have, proof_type: [test], description: "Network failure during submit → drafts preserved until GitHub confirms; safe retry without duplicate review" }
      - { id: EC-09h, priority: nice-to-have, proof_type: [test], description: "5xx on submit → retryable, drafts preserved" }
      - { id: EC-09i, priority: must-have, proof_type: [test], description: "Rapid double-submit does not create two reviews" }
      - { id: EC-09j, priority: nice-to-have, proof_type: [test], description: "Expired token at submit (401) → re-auth prompt, drafts preserved" }
      - { id: EC-09k, priority: nice-to-have, proof_type: [test], description: "PR closed/merged between load and submit → GitHub error verbatim, drafts preserved" }
      - { id: EC-09l, priority: nice-to-have, proof_type: [test], description: "Token scope downgraded between load and submit → 403 handled, drafts preserved" }
      - { id: EC-09m, priority: nice-to-have, proof_type: [test], description: "Response after navigation during submit does not write to dead component" }

  - id: REQ-10
    description: CI signals — fetch check runs + annotations for head SHA, pass/fail summary in Understand
    happy_path: Check runs + annotations fetched; Step 1 shows pass/fail counts, failed names + annotation messages
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-10a, priority: must-have, proof_type: [test, visual], description: "Zero check runs → 'no CI configured' state, not an error" }
      - { id: EC-10b, priority: must-have, proof_type: [test, visual], description: "Checks pending/in-progress → pending state, not false pass/fail" }
      - { id: EC-10c, priority: must-have, proof_type: [test, visual], description: "All checks pass → green summary with correct counts" }
      - { id: EC-10d, priority: must-have, proof_type: [test, visual], description: "Mixed results with one failing check → failing name + its annotations rendered" }
      - { id: EC-10e, priority: nice-to-have, proof_type: [test], description: "Check-runs fetch fails → CI panel error, rest of Step 1 unaffected" }
      - { id: EC-10f, priority: nice-to-have, proof_type: [test], description: "Annotations paginated/large count — fully fetched or bounded, partial last page handled" }
      - { id: EC-10g, priority: must-have, proof_type: [test], description: "Annotation message with HTML/script/unicode rendered safely" }
      - { id: EC-10h, priority: nice-to-have, proof_type: [test], description: "Head SHA changed since load — CI shown tied to a single SHA, not mixed" }

  - id: REQ-11
    description: Private-code consent gate — explicit one-time per-repo confirmation before private content reaches DeepSeek
    happy_path: First AI action on private repo → consent dialog; accept remembered per repo; public repos never gated
    proof_type: [test, visual-flow]
    edge_cases:
      - { id: EC-11a, priority: must-have, proof_type: [test], description: "Public repo never triggers the gate (AI runs immediately)" }
      - { id: EC-11b, priority: must-have, proof_type: [test], description: "Private repo first AI action blocks until consent; no DeepSeek request fires before accept" }
      - { id: EC-11c, priority: must-have, proof_type: [test, visual], description: "User declines → no private content sent, AI panels show declined state, manual review works" }
      - { id: EC-11d, priority: must-have, proof_type: [test], description: "Consent remembered per repo — same repo no re-prompt; different private repo prompts" }
      - { id: EC-11e, priority: must-have, proof_type: [test], description: "Consent record cleared → gate reappears (fails safe toward asking)" }
      - { id: EC-11f, priority: must-have, proof_type: [test], description: "Repo visibility unknown at decision time → treated as private (fail-safe), gate shown" }
      - { id: EC-11g, priority: must-have, proof_type: [test], description: "Four parallel AI tasks share one consent decision (gate shown once, not four times)" }

  - id: REQ-12
    description: AI PR summary + walkthrough — plain summary + file reading order (DeepSeek, BYO key)
    happy_path: With key present, summarize streams summary + reading order used to stack files in Step 2
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-12a, priority: must-have, proof_type: [test, visual], description: "No DeepSeek key → 'add a key' prompt instead of summary; rest of app works" }
      - { id: EC-12b, priority: must-have, proof_type: [test], description: "Invalid DeepSeek key (401) → settings prompt, panel fails independently" }
      - { id: EC-12c, priority: must-have, proof_type: [test], description: "DeepSeek 429/timeout → panel-level failure with retry, other panels unaffected" }
      - { id: EC-12d, priority: nice-to-have, proof_type: [test], description: "DeepSeek CORS regression → graceful per-panel failure, review flow usable" }
      - { id: EC-12e, priority: must-have, proof_type: [test], description: "Reading-order names a file not in PR / omits files → sane fallback order, no crash" }
      - { id: EC-12f, priority: must-have, proof_type: [test], description: "Stream interrupted mid-completion → partial summary not cached as complete; retry available" }
      - { id: EC-12g, priority: nice-to-have, proof_type: [test], description: "Response after navigating away → no write to unmounted slot" }
      - { id: EC-12h, priority: nice-to-have, proof_type: [test], description: "Empty-diff PR → summarize handles gracefully ('nothing to summarize')" }

  - id: REQ-13
    description: AI attention highlighting — hotspots with reasons, AI-inferred test mapping, "behavior changed but no test touched" flags
    happy_path: analyzeAttention returns hotspots; Step 2 expands high-attention files with reasons, collapses low-attention; test warnings labeled AI-inferred
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-13a, priority: nice-to-have, proof_type: [test, visual], description: "All files low-attention → none force-expanded; list usable" }
      - { id: EC-13b, priority: nice-to-have, proof_type: [test, visual], description: "Exactly one high-attention file expands with its reason" }
      - { id: EC-13c, priority: must-have, proof_type: [test], description: "Attention references file/hunk not in PR → ignored safely, no crash" }
      - { id: EC-13d, priority: must-have, proof_type: [test, visual], description: "Test-coverage warning always visibly labeled 'AI-inferred, not measured'" }
      - { id: EC-13e, priority: must-have, proof_type: [test], description: "Schema-invalid attention JSON → one repair retry, then 'couldn't generate' state" }
      - { id: EC-13f, priority: nice-to-have, proof_type: [test], description: "No DeepSeek key → attention panel add-key prompt; files render in default order" }
      - { id: EC-13g, priority: must-have, proof_type: [test], description: "DeepSeek failure isolated to attention panel with retry" }
      - { id: EC-13h, priority: nice-to-have, proof_type: [test], description: "Stream after unmount/navigation does not update dead UI" }

  - id: REQ-14
    description: Mermaid before/after diagrams — LLM emits schema-validated graph JSON; deterministic Mermaid serialization; sandboxed render
    happy_path: generateDiagrams returns valid nodes/edges JSON → serializer produces valid Mermaid for base vs PR state → rendered with securityLevel strict
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-14a, priority: must-have, proof_type: [test], description: "Empty graph (no nodes) → valid 'empty' Mermaid or clean 'no diagram' state, never invalid syntax" }
      - { id: EC-14b, priority: must-have, proof_type: [test], description: "Single node, no edges → valid Mermaid" }
      - { id: EC-14c, priority: must-have, proof_type: [test], description: "Labels with Mermaid-reserved chars, quotes, newlines, unicode escaped — output always valid Mermaid" }
      - { id: EC-14d, priority: must-have, proof_type: [test], description: "Cyclic graph and self-loop serialize without infinite loop or invalid output" }
      - { id: EC-14e, priority: must-have, proof_type: [test], description: "Edge referencing non-existent node id → serializer rejects or repairs deterministically" }
      - { id: EC-14f, priority: nice-to-have, proof_type: [test], description: "Very large graph serializes within bounds; render does not hang" }
      - { id: EC-14g, priority: must-have, proof_type: [test], description: "Schema-invalid LLM graph JSON → one repair retry, then graceful 'couldn't generate diagram'" }
      - { id: EC-14h, priority: nice-to-have, proof_type: [test], description: "Wrong type in JSON (edges as object, missing id) caught by schema validation" }
      - { id: EC-14i, priority: nice-to-have, proof_type: [test], description: "Diagram-type selection covers both shapes (flow vs class/module) per change shape" }
      - { id: EC-14j, priority: must-have, proof_type: [test], description: "Injection attempt smuggled in a label cannot escape strict sandbox" }
      - { id: EC-14k, priority: must-have, proof_type: [test, visual-flow], description: "Full-screen overlay opens/closes on click; correct base vs PR pairing displayed" }
      - { id: EC-14l, priority: must-have, proof_type: [test], description: "No DeepSeek key → diagram panel add-key prompt" }

  - id: REQ-15
    description: Behavior-change verdict — categorical 3-level + evidence bullets + explicit "not analyzed" list; no percentages
    happy_path: assessBehavior returns one of three levels with evidence and not-analyzed list; rail shows verdict + evidence expander
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-15a, priority: must-have, proof_type: [test], description: "Verdict outside the three allowed levels (or a percentage) rejected by schema; never rendered as a number" }
      - { id: EC-15b, priority: nice-to-have, proof_type: [test, visual], description: "Empty evidence list still renders verdict cleanly" }
      - { id: EC-15c, priority: must-have, proof_type: [test, visual], description: "Not-analyzed list populated when files truncated for token budget; shown explicitly" }
      - { id: EC-15d, priority: nice-to-have, proof_type: [test, visual], description: "Not-analyzed list empty → section hidden, no placeholder noise" }
      - { id: EC-15e, priority: must-have, proof_type: [test], description: "Evidence/not-analyzed strings with HTML/unicode rendered safely" }
      - { id: EC-15f, priority: must-have, proof_type: [test], description: "Schema-invalid verdict JSON → one repair retry, then 'couldn't generate' state" }
      - { id: EC-15g, priority: must-have, proof_type: [test], description: "Failed CI checks/annotations fed into verdict prompt context" }
      - { id: EC-15h, priority: nice-to-have, proof_type: [test], description: "No DeepSeek key → verdict panel add-key prompt" }
      - { id: EC-15i, priority: nice-to-have, proof_type: [test], description: "DeepSeek failure isolated to verdict panel with retry" }

  - id: REQ-16
    description: Context packing — select files, trim lock/generated, pack before/after within token budget, chunk oversized PRs, include CI failures
    happy_path: lib/context produces context fitting the budget, excluding lock/generated files, including CI failures, recording truncations
    proof_type: [test]
    edge_cases:
      - { id: EC-16a, priority: must-have, proof_type: [test], description: "Zero changed files → empty but valid context, no crash" }
      - { id: EC-16b, priority: must-have, proof_type: [test], description: "Exactly one file under budget packs whole; nothing truncated" }
      - { id: EC-16c, priority: must-have, proof_type: [test], description: "Single file larger than entire budget → truncated/chunked and recorded in not-analyzed" }
      - { id: EC-16d, priority: must-have, proof_type: [test], description: "Total content at budget boundary (budget, ±1) → deterministic include/exclude at the edge" }
      - { id: EC-16e, priority: must-have, proof_type: [test], description: "Lock files (package-lock, pnpm-lock) and known generated files trimmed out" }
      - { id: EC-16f, priority: nice-to-have, proof_type: [test], description: "All files are lock/generated → effectively empty context; downstream AI handles gracefully" }
      - { id: EC-16g, priority: must-have, proof_type: [test], description: "Missing before-content (added file) or after-content (deleted file) packed correctly" }
      - { id: EC-16h, priority: nice-to-have, proof_type: [test], description: "Binary/non-text file excluded from packed text context" }
      - { id: EC-16i, priority: must-have, proof_type: [test], description: "CI failures + annotations included when present; absent when none" }
      - { id: EC-16j, priority: nice-to-have, proof_type: [test], description: "Unicode/multibyte content counted correctly against token budget" }
      - { id: EC-16k, priority: must-have, proof_type: [test], description: "Truncation always produces a populated not-analyzed list consumed by the verdict" }

  - id: REQ-17
    description: Client-side AI-output cache keyed by repo#pr@headSHA + task + prompt version
    happy_path: AI result cached on completion; revisiting same PR loads from cache with no DeepSeek call
    proof_type: [test]
    edge_cases:
      - { id: EC-17a, priority: must-have, proof_type: [test], description: "Cache miss on first visit → DeepSeek called; cache hit on revisit → no DeepSeek call" }
      - { id: EC-17b, priority: must-have, proof_type: [test], description: "Head SHA change → key changes → cache miss → fresh fetch (no stale result)" }
      - { id: EC-17c, priority: must-have, proof_type: [test], description: "Prompt-version bump → cache miss → recompute" }
      - { id: EC-17d, priority: must-have, proof_type: [test], description: "Only completed results cached; failed/partial streams not cached" }
      - { id: EC-17e, priority: must-have, proof_type: [test], description: "IndexedDB unavailable (private mode) → app works, no caching, no crash" }
      - { id: EC-17f, priority: nice-to-have, proof_type: [test], description: "Quota exceeded on cache write → handled, result still shown in-session" }
      - { id: EC-17g, priority: nice-to-have, proof_type: [test], description: "Concurrent writes for four tasks to same PR key do not corrupt each other" }
      - { id: EC-17h, priority: nice-to-have, proof_type: [test], description: "Corrupt cached entry → treated as miss, recomputed, no crash" }
      - { id: EC-17i, priority: must-have, proof_type: [test], description: "Cache key distinguishes per-task (four tasks don't collide)" }

  - id: REQ-18
    description: PostHog analytics with strict privacy rule enforced in lib/analytics
    happy_path: Typed events fire through lib/analytics with only allowed coarse fields
    proof_type: [test]
    edge_cases:
      - { id: EC-18a, priority: must-have, proof_type: [test], description: "No event payload ever contains code, diff text, keys, or tokens (enforced at choke-point)" }
      - { id: EC-18b, priority: must-have, proof_type: [test], description: "Private repo identifier never included (visibility=private without owner/repo name)" }
      - { id: EC-18c, priority: must-have, proof_type: [test], description: "Public repo events include only allowed coarse metadata (visibility, file count, primary language)" }
      - { id: EC-18d, priority: must-have, proof_type: [test], description: "settings_key_added records which service, never the key value" }
      - { id: EC-18e, priority: must-have, proof_type: [test], description: "review_submitted carries verdict type + comment count only, no bodies" }
      - { id: EC-18f, priority: must-have, proof_type: [test], description: "ai_task_completed/failed carry task/duration/cached flag, no prompt or output content" }
      - { id: EC-18g, priority: must-have, proof_type: [test], description: "PostHog unreachable/blocked → analytics failure does not break the app" }
      - { id: EC-18h, priority: must-have, proof_type: [test], description: "Attempt to log a disallowed field is dropped/blocked by the wrapper" }

  - id: REQ-19
    description: Degraded/optional-key states — browsing works without keys; AI prompts for key; submission prompts sign-in
    happy_path: No DeepSeek key → diff + manual flow work, AI panels prompt; signed out → public PRs readable, submission prompts sign-in
    proof_type: [test, visual]
    edge_cases:
      - { id: EC-19a, priority: must-have, proof_type: [test, visual], description: "No key + no auth on public PR → diff renders, AI panels show add-key, submission prompts sign-in" }
      - { id: EC-19b, priority: must-have, proof_type: [test], description: "DeepSeek key present but signed out → AI runs on public PR, submission still prompts sign-in" }
      - { id: EC-19c, priority: must-have, proof_type: [test], description: "Signed in, no DeepSeek key → full review flow works, only AI panels prompt" }
      - { id: EC-19d, priority: must-have, proof_type: [test], description: "Tokenless 60 req/h limit hit → rate-limit message suggests sign-in" }
      - { id: EC-19e, priority: must-have, proof_type: [test, visual-flow], description: "Manual drafting and up-to-submission flow fully usable with zero AI panels populated" }

  - id: REQ-20
    description: 1-2-3 stepper with pinnable/collapsible context rail in all steps, sticky bar with nav + draft count
    happy_path: Understand→Inspect→Verdict navigation; rail available with pin/collapse everywhere; bottom bar shows nav + count
    proof_type: [test, visual-flow]
    edge_cases:
      - { id: EC-20a, priority: must-have, proof_type: [test], description: "Forward/back step navigation preserves drafts and loaded data (no reset)" }
      - { id: EC-20b, priority: nice-to-have, proof_type: [test, visual], description: "Rail pin/collapse toggles persist across step changes" }
      - { id: EC-20c, priority: nice-to-have, proof_type: [test], description: "Navigation while AI panels still streaming → rail shows in-progress, steps navigable" }
      - { id: EC-20d, priority: must-have, proof_type: [test], description: "Browser back/forward and refresh on deep link restore the correct step/PR" }
      - { id: EC-20e, priority: must-have, proof_type: [test, visual-flow], description: "Hotspot click jumps to file in Inspect; diagram click opens full-screen overlay" }
      - { id: EC-20f, priority: nice-to-have, proof_type: [visual, manual], description: "Rail/stepper usable on mobile/tablet/desktop; keyboard navigable" }
      - { id: EC-20g, priority: nice-to-have, proof_type: [test], description: "Multiple tabs on same PR keep drafts consistent without clobbering" }
      - { id: EC-20h, priority: nice-to-have, proof_type: [test, visual], description: "First-use state (no rail content, AI not run) renders without broken affordances" }

CHALLENGE:
  # Inverse pass against the spec itself — assumptions that could be wrong.
  # Not implementation requirements; human may promote any to REQ.
  - id: CH-01
    assumption: "Parallel before/after content fetches for every changed file are fine under GitHub rate limits"
    challenge: "GitHub secondary rate limits punish bursts of concurrent requests even when the hourly quota is fine. A 100-file PR fires ~200 content requests. Needs a concurrency cap / request queue in lib/github."
    status: open
  - id: CH-02
    assumption: "Drafts can be bundled into one review submission losslessly"
    challenge: "GitHub review-comment anchoring (line/side params, multi-line ranges, deleted-line comments) has sharp semantics; comments on context lines or outdated hunks 422 more often than the spec assumes. Needs explicit anchoring rules in lib/github."
    status: open
  - id: CH-03
    assumption: "All four AI tasks 'stream into their UI slots'"
    challenge: "Three of the four tasks return schema-validated JSON, which can only be validated when the stream completes. Only the summary is meaningfully streamable; the others are spinner-then-result. UI design should not promise token-level streaming for JSON tasks."
    status: open
  - id: CH-04
    assumption: "Four DeepSeek calls run in parallel"
    challenge: "Per-key rate/concurrency limits on DeepSeek may serialize them; UX must tolerate staggered completion (it does — but don't build timing assumptions into tests)."
    status: open
  - id: CH-05
    assumption: "minimumReleaseAge 7d only blocks attacks"
    challenge: "It also delays urgent security PATCHES by 7 days. Accepted trade-off; document an override path (pnpm --config flag) for emergencies."
    status: open
  - id: CH-06
    assumption: "Token budget in lib/context matches the model's context window"
    challenge: "Budget must be derived from lib/llm model config, not hard-coded — a model switch (planned future) silently breaks packing otherwise."
    status: open
  - id: CH-07
    assumption: "public_repo scope suffices for all public repos"
    challenge: "SSO-protected org repos can require authorization of the token for the org even when 'public' to members; OAuth token may fail where the UI expects success. Error path must not dead-end."
    status: open
  - id: CH-08
    assumption: "localStorage persistence is durable"
    challenge: "Safari ITP and browser cleanups can wipe localStorage (keys, consent records) after periods of disuse → users silently signed out, consent gates reappear. Acceptable, but the app must degrade to the signed-out state cleanly from any page."
    status: open

SUMMARY:
  total_requirements: 20
  total_edge_cases: 186
  must_have: 113
  nice_to_have: 73
  challenge_items: 8
  proof_types:
    test_only: 142
    visual: 37
    visual_flow: 4
    manual: 5
  # counts verified by grep against entries; an edge case with multiple
  # proof types is counted once per type except test_only (= exactly [test])
```
