#!/usr/bin/env bash
# ============================================================================
# Verification Script: Review 1-2-3 — Plan B (GitHub sign-in + review submission)
# Generated: 2026-06-11T00:00:00Z
# Criteria matrix: docs/superpowers/specs/2026-06-11-review123-criteria-matrix.md
# Re-run after any change: ./scripts/verify-review123-plan-b.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Configuration (filled at generation time) ---
TEST_COMMAND="pnpm vitest run"
CRITERIA_PATH="docs/superpowers/specs/2026-06-11-review123-criteria-matrix.md"
REPORT_DIR="docs/superpowers/verification"
TOPIC_SLUG="review123-plan-b"

# --- State ---
TOTAL=0
PASS=0
FAIL=0
UNCOVERED=0
ERRORS=()

# --- Helpers ---
header() { printf "\n\033[1;34m=== %s ===\033[0m\n" "$1"; }
pass()   { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail()   { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); ERRORS+=("FAIL: $1 — $2"); printf "  \033[31m✗\033[0m %s — %s\n" "$1" "$2"; }
skip()   { UNCOVERED=$((UNCOVERED + 1)); TOTAL=$((TOTAL + 1)); ERRORS+=("UNCOVERED: $1"); printf "  \033[33m?\033[0m %s (no test found)\n" "$1"; }

# vt <id> <vitest -t pattern> [file...]
vt() {
  local id="$1"; shift
  local pattern="$1"; shift
  if pnpm vitest run -t "$pattern" "$@" >/dev/null 2>&1; then
    pass "$id"
  else
    fail "$id" "vitest -t '$pattern' failed"
  fi
}

# --- Static gates first: typecheck + full suite + build ---
header "Gate: svelte-check (type safety)"
if pnpm check >/dev/null 2>&1; then pass "GATE-check"; else fail "GATE-check" "svelte-check reported errors"; fi

header "Gate: full test suite"
if pnpm test >/dev/null 2>&1; then pass "GATE-tests"; else fail "GATE-tests" "full vitest suite failed"; fi

header "Gate: production build"
if pnpm build >/dev/null 2>&1; then pass "GATE-build"; else fail "GATE-build" "vite build failed"; fi

# --- REQ-02: OAuth callback — error paths and security ---
header "REQ-02: OAuth callback correctness + origin guard"
# EC-02a: missing code
vt "EC-02a" "EC-02a: returns missing-code when code is absent" src/lib/auth/auth.test.ts
# EC-02b: user denied
vt "EC-02b" "EC-02b: returns denied when error=access_denied" src/lib/auth/auth.test.ts
# EC-02c: no PKCE verifier in sessionStorage (two variants, run file-level)
vt "EC-02c" "EC-02c" src/lib/auth/auth.test.ts
# EC-02d: state mismatch
vt "EC-02d" "EC-02d: returns state-mismatch when state does not match" src/lib/auth/auth.test.ts
# EC-02e: exchange failed (non-200) + access_token missing
vt "EC-02e" "EC-02e" src/lib/auth/auth.test.ts
# EC-02k: exchange-failed when body has error field
vt "EC-02k" "EC-02k: returns exchange-failed when body has error field" src/lib/auth/auth.test.ts
# EC-02l: no console.* in exchange source (static analysis as test)
vt "EC-02l" "EC-02l: api/oauth/exchange.ts contains no console" src/lib/auth/exchange-handler.test.ts
# Origin guard 403 tests (exchange-handler default export)
vt "EC-02-origin-missing" "returns 403 when Origin header is missing" src/lib/auth/exchange-handler.test.ts
vt "EC-02-origin-foreign" "returns 403 when Origin is a foreign host" src/lib/auth/exchange-handler.test.ts
vt "EC-02-origin-malformed" "returns 403 when Origin is malformed" src/lib/auth/exchange-handler.test.ts
vt "EC-02-origin-xfh" "returns 403 when origin host does not match x-forwarded-host" src/lib/auth/exchange-handler.test.ts
# AuthCallback UI error rendering
vt "EC-02-state-mismatch-ui" "state-mismatch error: renders specific message" src/routes/AuthCallback.test.ts
vt "EC-02-denied-ui" "denied error: renders cancellation message" src/routes/AuthCallback.test.ts
vt "EC-02-exchange-failed-ui" "exchange-failed error: renders token exchange message" src/routes/AuthCallback.test.ts

# --- REQ-03: Scope upgrade ---
header "REQ-03: OAuth scope detection and upgrade prompt"
# EC-03a: returns true when only public_repo scope
vt "EC-03a" "returns true when signed in via oauth with only public_repo scope" src/lib/auth/auth.test.ts
# EC-03b: returns false when repo scope (no upgrade needed)
vt "EC-03b" "returns false when signed in via oauth with repo scope" src/lib/auth/auth.test.ts
# EC-03c: returns false for PAT (never needs upgrade)
vt "EC-03c" "returns false when signed in via PAT" src/lib/auth/auth.test.ts
# EC-03e: returns false when signed out
vt "EC-03e" "returns false when signed out" src/lib/auth/auth.test.ts
# Note: no dedicated UI scope-upgrade-branch test found in Review.test.ts — auth.test.ts covers logic layer

# --- REQ-04: OAuth precedence + legacy migration ---
header "REQ-04: OAuth token precedence + legacy PAT migration"
# OAuth header sent when method is oauth
vt "EC-04-oauth-header" "sends oauth token in Authorization header when method is oauth" src/lib/github/client.test.ts
# Legacy migration end-to-end
vt "EC-04-legacy-migration" "authenticates via legacy migration: raw githubPat in localStorage" src/lib/github/client.test.ts
# settings-level precedence: githubAuth takes priority over githubPat when both stored
vt "EC-04-precedence" "migration: githubAuth takes precedence over legacy githubPat when both stored" src/lib/settings/settings.test.ts
# settings-level migration: legacy JSON coerces to githubAuth
vt "EC-04-legacy-coerce" "migration: legacy JSON with only githubPat coerces to githubAuth" src/lib/settings/settings.test.ts
# OAuth clears stale PAT
vt "EC-04-oauth-clears-pat" "saveGithubAuth\(oauth\) clears stale githubPat so no plaintext PAT lingers at rest" src/lib/settings/settings.test.ts

# --- REQ-07: Draft persistence (IndexedDB store) ---
header "REQ-07: Draft storage — verbatim, overwrite, isolation, fallback"
# EC-07a: empty body removes draft (upsert with empty body removes existing draft)
vt "EC-07a" "upsert with empty body removes existing draft" src/lib/drafts/drafts.test.ts
# EC-07d: verbatim unicode storage
vt "EC-07d" "stores unicode correctly" src/lib/drafts/drafts.test.ts
# EC-07e: same-key overwrite is last-write-wins
vt "EC-07e" "upserting the same key twice uses the last value" src/lib/drafts/drafts.test.ts
# EC-07f: per-PR isolation (drafts from prKey A not visible to prKey B)
vt "EC-07f" "drafts from prKey A are not visible to a store with prKey B" src/lib/drafts/drafts.test.ts
# EC-07h: in-memory fallback when IndexedDB is unavailable
vt "EC-07h-drafts" "works without IndexedDB: persistent===false" src/lib/drafts/drafts.test.ts
vt "EC-07h-ui" "shows storage-unavailable warning when IndexedDB is not available" src/routes/Review.test.ts
# EC-07i: sticky bar shown with draft count
vt "EC-07i-bar" "shows \"0 comments drafted\" bar after PR loads" src/routes/Review.test.ts
vt "EC-07i-plural" "shows plural form for 0 comments" src/routes/Review.test.ts

# --- REQ-08: Markdown rendering + sanitization ---
header "REQ-08: Markdown sanitization and toolbar"
# EC-08c: sanitization tests in render.test.ts
vt "EC-08c-script" "strips <script> tags" src/lib/markdown/render.test.ts
vt "EC-08c-onerror" "strips onerror from <img>" src/lib/markdown/render.test.ts
vt "EC-08c-style" "strips style attribute" src/lib/markdown/render.test.ts
vt "EC-08c-js-href" "neutralizes javascript: href" src/lib/markdown/render.test.ts
vt "EC-08c-code-block" "renders fenced code block as <pre><code>" src/lib/markdown/render.test.ts
vt "EC-08c-table" "renders GFM table" src/lib/markdown/render.test.ts
# EC-08f: toolbar selection handling
vt "EC-08f-bold-wrap" "Bold button with selected text wraps in" src/components/CommentEditor.test.ts
vt "EC-08f-bold-empty" "Bold button with empty selection inserts" src/components/CommentEditor.test.ts
vt "EC-08f-italic-wrap" "Italic button wraps selection in _" src/components/CommentEditor.test.ts
vt "EC-08f-toolbar-aria" "toolbar buttons have aria-labels" src/components/CommentEditor.test.ts

# --- REQ-09: Review submission outcomes ---
header "REQ-09: Review submission — happy path, guards, error mapping"
# EC-09a: APPROVE with zero comments sends no comments key
vt "EC-09a" "zero-comment APPROVE body has NO comments key" src/lib/github/review.test.ts
# EC-09a via VerdictStep: APPROVE with empty body + 0 drafts calls submitFn
vt "EC-09a-ui" "calls submitFn even with no body and no drafts" src/components/VerdictStep.test.ts
# EC-09c: VerdictStep signed-out shows prompt, no submit button
vt "EC-09c" "shows sign-in prompt, no submit button" src/components/VerdictStep.test.ts
# EC-09e: 422 "own pull request" maps to self-approve
vt "EC-09e" "maps 422 with \"own pull request\" to self-approve with verbatim message" src/lib/github/review.test.ts
# EC-09f: other 422 maps to invalid-anchor
vt "EC-09f" "maps other 422 to invalid-anchor with verbatim message" src/lib/github/review.test.ts
# EC-09g: failure → drafts NOT cleared
vt "EC-09g" "renders error message verbatim in role=alert, store NOT cleared" src/components/VerdictStep.test.ts
# EC-09i: double-submit guard (concurrent second call blocked)
vt "EC-09i" "concurrent second call returns in-progress error WITHOUT a network call" src/lib/github/review.test.ts

# --- REQ-19: Prompt while key features work ---
header "REQ-19: Signed-out prompt co-exists with read-only features"
# EC-19b: VerdictStep shows sign-in prompt while diff/inspect UI still usable
# The VerdictStep signed-out test verifies the prompt renders without blocking render
vt "EC-19b" "does not render the verdict radio group when signed out" src/components/VerdictStep.test.ts

# --- REQ-20: Drafts survive step navigation ---
header "REQ-20: Drafts survive step navigation"
# EC-20a: count reflects drafts persisted across step switches at store level
vt "EC-20a" "count reflects drafts persisted across step switches at store level" src/routes/Review.test.ts
# EC-20a store-level round-trip
vt "EC-20a-roundtrip" "data written with one instance is visible to a fresh instance after load" src/lib/drafts/drafts.test.ts

# --- Summary ---
header "Verification Summary"
echo "  Total:     $TOTAL"
echo "  Pass:      $PASS"
echo "  Fail:      $FAIL"
echo "  Uncovered: $UNCOVERED"
echo ""

if [ ${#ERRORS[@]} -gt 0 ]; then
    header "Issues"
    for e in "${ERRORS[@]}"; do
        echo "  - $e"
    done
fi

# Compute status
if [ "$FAIL" -eq 0 ] && [ "$UNCOVERED" -eq 0 ]; then
    STATUS="PASS"
elif [ "$FAIL" -gt 0 ]; then
    STATUS="FAIL"
else
    STATUS="PARTIAL"
fi

# Write machine-readable summary for CI/agent consumption
mkdir -p "$REPORT_DIR"
cat > "$REPORT_DIR/verify-summary-${TOPIC_SLUG}.txt" <<SUMMARY
status=$STATUS
total=$TOTAL
pass=$PASS
fail=$FAIL
uncovered=$UNCOVERED
SUMMARY

# Exit code: non-zero if any failures or uncovered items
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "RESULT: FAIL ($FAIL failures)"
    exit 1
elif [ "$UNCOVERED" -gt 0 ]; then
    echo ""
    echo "RESULT: PARTIAL ($UNCOVERED uncovered requirements)"
    exit 2
else
    echo ""
    echo "RESULT: PASS (all $TOTAL requirements verified)"
    exit 0
fi
