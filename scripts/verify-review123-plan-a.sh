#!/usr/bin/env bash
# ============================================================================
# Verification Script: Review 1-2-3 — Plan A (foundation + diff viewer)
# Generated: 2026-06-11T14:50:00Z
# Criteria matrix: docs/superpowers/specs/2026-06-11-review123-criteria-matrix.md
# Re-run after any change: ./scripts/verify-review123-plan-a.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Configuration (filled at generation time) ---
TEST_COMMAND="pnpm vitest run"
CRITERIA_PATH="docs/superpowers/specs/2026-06-11-review123-criteria-matrix.md"
REPORT_DIR="docs/superpowers/verification"
TOPIC_SLUG="review123-plan-a"

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

# vt <id> <reason-on-fail> <vitest -t pattern> [file...]
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

# --- REQ-01: PR URL parsing ---
header "REQ-01: Parse GitHub PR URLs into owner/repo/number"
vt "REQ-01-happy" "parses a canonical PR URL" src/lib/github/parse.test.ts
vt "EC-01a" "EC-01a" src/lib/github/parse.test.ts
vt "EC-01b" "EC-01b" src/lib/github/parse.test.ts src/routes/Landing.test.ts
vt "EC-01h" "EC-01h" src/lib/github/parse.test.ts
vt "EC-01i" "EC-01i" src/lib/github/parse.test.ts src/routes/Landing.test.ts
vt "EC-01j" "EC-01j" src/lib/github/parse.test.ts
vt "EC-01l" "EC-01l" src/lib/github/parse.test.ts
vt "EC-01o" "EC-01o" src/lib/router/router.test.ts

# --- REQ-04 (Plan A subset): PAT storage + use ---
header "REQ-04 (subset): PAT storage, validation, masking"
vt "EC-04a" "EC-04a" src/lib/settings/settings.test.ts
vt "EC-04c" "EC-04c/EC-04e" src/lib/github/client.test.ts
vt "EC-04e" "EC-04c/EC-04e" src/lib/github/client.test.ts
# NOTE (Plan F): SettingsPanel.svelte retired — EC-04h moved to ProvidersSection
vt "EC-04h" "EC-04h" src/components/settings/ProvidersSection.test.ts
vt "EC-04h-no-leak" "records key service but never the key value" src/lib/analytics/analytics.test.ts

# --- REQ-05: PR data fetching ---
header "REQ-05: Fetch PR meta, paginated files, contents"
vt "REQ-05-happy" "loads meta and files in parallel into ready state" src/lib/review/loadPr.test.ts
vt "EC-05a" "EC-05a" src/lib/github/client.test.ts src/lib/review/loadPr.test.ts
vt "EC-05b" "maps 404 to not-found" src/lib/github/client.test.ts
vt "EC-05c" "EC-05c" src/lib/github/client.test.ts src/lib/review/loadPr.test.ts
vt "EC-05g" "EC-05g" src/lib/review/loadPr.test.ts
vt "EC-05i" "EC-05i" src/lib/github/api.test.ts
vt "EC-05i-cap" "stops at MAX_PAGES" src/lib/github/api.test.ts
vt "EC-05j" "EC-05j" src/lib/diff/diffFile.test.ts
vt "EC-05k" "EC-05k" src/lib/review/loadPr.test.ts src/App.test.ts

# --- REQ-06: Diff view ---
header "REQ-06: Diff rendering (modes, rename, binary)"
vt "EC-06b" "EC-06b" src/lib/diff/diffFile.test.ts
vt "EC-06b-bare-patch" "bare GitHub patch produces nonzero parsed diff lines" src/lib/diff/diffFile.test.ts
vt "EC-06c" "EC-06c" src/lib/diff/diffFile.test.ts
vt "EC-06c-ui" "rename-only fixture shows the rename note" src/components/FileDiff.test.ts
vt "REQ-06-binary-ui" "no-patch fixture shows the binary note" src/components/FileDiff.test.ts
vt "REQ-06-smoke" "smoke: renders modified file" src/components/FileDiff.test.ts
vt "EC-06h" "EC-06h: FileDiff article is present in step 2 while AI panels show loading" src/routes/Review.test.ts

# --- REQ-18: Analytics privacy (all musts) ---
header "REQ-18: PostHog allowlist privacy choke-point"
vt "EC-18a" "EC-18a" src/lib/analytics/analytics.test.ts
vt "EC-18b" "EC-18b" src/lib/analytics/analytics.test.ts
vt "EC-18c" "EC-18c" src/lib/analytics/analytics.test.ts
vt "EC-18d" "EC-18d" src/lib/analytics/analytics.test.ts
vt "EC-18e" "EC-18e" src/lib/analytics/analytics.test.ts
vt "EC-18f" "EC-18f" src/lib/analytics/analytics.test.ts
vt "EC-18g" "EC-18g" src/lib/analytics/analytics.test.ts
vt "EC-18h" "EC-18h" src/lib/analytics/analytics.test.ts
vt "EC-18-compile" "rejects unknown props at compile time" src/lib/analytics/analytics.test.ts

# --- REQ-20 (Plan A subset): deep links + history navigation ---
header "REQ-20 (subset): deep links, back/forward restore"
vt "EC-20d-title" "shows the new PR title after navigating" src/App.test.ts
vt "EC-20d-remount" "resets step to 1 when navigating" src/App.test.ts
vt "EC-20d-deeplink" "matches review route with params" src/lib/router/router.test.ts

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
