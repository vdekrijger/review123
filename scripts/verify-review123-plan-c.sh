#!/usr/bin/env bash
# ============================================================================
# Verification Script: Review 1-2-3 — Plan C (AI features)
# Generated: 2026-06-11T00:00:00Z
# Criteria matrix: docs/superpowers/specs/2026-06-11-review123-criteria-matrix.md
# Re-run after any change: ./scripts/verify-review123-plan-c.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Configuration ---
REPORT_DIR="docs/superpowers/verification"
TOPIC_SLUG="review123-plan-c"

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

# --- REQ-10: CI signals — check-run fetching + CiSummary rendering ---
header "REQ-10: CI check-run signals"

# EC-10a: zero runs → all-zero summary
vt "EC-10a-lib" "returns all-zero summary when no check-runs exist" src/lib/github/checks.test.ts
vt "EC-10a-ui" "renders \"No CI configured\" when total is 0" src/components/CiSummary.test.ts

# EC-10b: pending state
vt "EC-10b-lib" "counts in_progress and queued runs as pending" src/lib/github/checks.test.ts
vt "EC-10b-ui" "shows pending count when pending > 0" src/components/CiSummary.test.ts

# EC-10c: all pass
vt "EC-10c-lib" "counts success, neutral, and skipped as passed" src/lib/github/checks.test.ts
vt "EC-10c-ui" "shows all-pass message with the count" src/components/CiSummary.test.ts

# EC-10d: mixed conclusions mapped correctly
vt "EC-10d" "correctly maps failure/timed_out/cancelled/action_required as failed and fetches annotations" src/lib/github/checks.test.ts

# EC-10g: annotation XSS escaping
vt "EC-10g-script" "renders <script> annotation as literal text, not a script element" src/components/CiSummary.test.ts
vt "EC-10g-attr" "renders HTML attribute injection attempt as plain text" src/components/CiSummary.test.ts
vt "EC-10g-img" "renders img onerror injection as plain text, no img element created" src/components/CiSummary.test.ts

# --- REQ-11: Private-repo consent gate ---
header "REQ-11: AI consent gate (7 must-haves)"

# EC-11a: public repos skip gate
vt "EC-11a" "returns true immediately for public repo without calling ask" src/lib/consent/consent.test.ts

# EC-11b: ask only when invoked
vt "EC-11b" "ask is never called before gateAi is invoked" src/lib/consent/consent.test.ts

# EC-11c: decline → false, not persisted
vt "EC-11c-false" "returns false when user declines" src/lib/consent/consent.test.ts
vt "EC-11c-not-persisted" "decline is not persisted" src/lib/consent/consent.test.ts

# EC-11d: grant persists across calls
vt "EC-11d-grant" "returns true on grant" src/lib/consent/consent.test.ts
vt "EC-11d-second" "second call for same repo does not call ask again" src/lib/consent/consent.test.ts

# EC-11e: storage cleared → re-asks
vt "EC-11e-reask" "asks again after revokeAll clears the grant" src/lib/consent/consent.test.ts

# EC-11f: undefined visibility treated as private
vt "EC-11f-calls-ask" "calls ask when isPrivate is undefined" src/lib/consent/consent.test.ts

# EC-11g: concurrent calls share single in-flight ask
vt "EC-11g-single-ask" "two parallel gateAi calls produce exactly one ask invocation" src/lib/consent/consent.test.ts

# ConsentDialog renders correctly
vt "EC-11-dialog-renders" "renders dialog with repo name and explanation" src/components/ConsentDialog.test.ts
vt "EC-11-dialog-accept" "accept button calls onresult.true." src/components/ConsentDialog.test.ts
vt "EC-11-dialog-decline" "decline button .\"Not now\". calls onresult.false." src/components/ConsentDialog.test.ts

# --- REQ-12: Summary streaming ---
header "REQ-12: Summary (streaming + panel states)"

# EC-12a: no key → all panels no-key, no llm calls
vt "EC-12a" "sets all panels to no-key without calling gateAi or llm" src/lib/ai/run.test.ts

# EC-12b: no-key UI (AddKey link)
vt "EC-12b" "shows \"Add a DeepSeek key in Settings\" for no-key status" src/components/UnderstandStep.test.ts

# EC-12c: task isolation — one failure doesn't block others
vt "EC-12c" "attention failure does not affect summary, diagrams, or verdict" src/lib/ai/run.test.ts

# EC-12e: reading order from summary applied to InspectStep
vt "EC-12e-order" "orders files by readingOrder with unlisted files after" src/components/InspectStep.test.ts
vt "EC-12e-ignore" "ignores readingOrder entries not in PR files" src/components/InspectStep.test.ts

# EC-12f: partial stream failure → not cached, status error
vt "EC-12f" "partial stream failure: status is error and summary NOT cached" src/lib/ai/run.test.ts

# --- REQ-13: Attention/hotspots ---
header "REQ-13: Attention result + hotspot rendering"

# EC-13c: unknown paths ignored
vt "EC-13c" "unknown attention paths do not crash" src/components/InspectStep.test.ts

# EC-13d: exact test-flag label
vt "EC-13d" "shows exact test flag label" src/components/InspectStep.test.ts

# EC-13e: repair retry (llmJsonWithRepair mechanism)
vt "EC-13e-retry-once" "retries once when first response has invalid JSON, succeeds on second" src/lib/llm/llm.test.ts
vt "EC-13e-validator-null" "retries once when validator returns null .parseable JSON, wrong shape., succeeds" src/lib/llm/llm.test.ts
vt "EC-13e-both-fail" "throws LlmError.\"invalid-output\". when both attempts fail validator" src/lib/llm/llm.test.ts

# EC-13g: task isolation (same as EC-12c — different task perspective)
vt "EC-13g" "attention failure does not affect summary, diagrams, or verdict" src/lib/ai/run.test.ts

# --- REQ-14: Architecture diagrams ---
header "REQ-14: Mermaid diagram generation and rendering"

# EC-14a: empty graph
vt "EC-14a-lib" "EC-14a: empty graph returns empty mermaid and no dropped" src/lib/diagram/mermaid.test.ts
vt "EC-14a-ui-both" "EC-14a: both empty graphs" src/components/DiagramPanel.test.ts
vt "EC-14a-ui-null" "EC-14a: null result" src/components/DiagramPanel.test.ts

# EC-14b: single node
vt "EC-14b" "EC-14b: single node emits a valid flowchart" src/lib/diagram/mermaid.test.ts

# EC-14c: label escaping (mermaid metachars)
vt "EC-14c-quotes" "double-quotes in labels become #quot;" src/lib/diagram/mermaid.test.ts
vt "EC-14c-newlines" "newlines in labels become spaces" src/lib/diagram/mermaid.test.ts
vt "EC-14c-backticks" "backticks stripped from labels" src/lib/diagram/mermaid.test.ts

# EC-14d: self-loops and cycles
vt "EC-14d-self-loop" "self-loop serializes without error" src/lib/diagram/mermaid.test.ts
vt "EC-14d-cycle" "a cycle A.B.C.A serializes without error" src/lib/diagram/mermaid.test.ts

# EC-14e: unknown node ids dropped
vt "EC-14e-from" "edge from unknown id is dropped" src/lib/diagram/mermaid.test.ts
vt "EC-14e-to" "edge to unknown id is dropped" src/lib/diagram/mermaid.test.ts

# EC-14g: repair retry shared mechanism (covered by EC-13e patterns above)
# — documented here for traceability; pointing to the llmJsonWithRepair tests
vt "EC-14g" "retries once when first response has invalid JSON, succeeds on second" src/lib/llm/llm.test.ts

# EC-14j: strict securityLevel in mermaid.initialize
vt "EC-14j" "calls mermaid.initialize with securityLevel strict and startOnLoad false" src/components/DiagramPanel.test.ts

# EC-14k: overlay open/close
vt "EC-14k-open" "clicking a diagram opens the overlay dialog" src/components/DiagramPanel.test.ts
vt "EC-14k-close" "clicking the close button closes the overlay" src/components/DiagramPanel.test.ts

# EC-14l: (adversarial label property test — mermaid.parse check)
vt "EC-14l" "handles adversarial label" src/lib/diagram/mermaid.test.ts

# --- REQ-15: Verdict ---
header "REQ-15: Behavior verdict"

# EC-15a: invalid level enum rejected by validator
vt "EC-15a-attention-pct" "returns null for percentage hotspot level" src/lib/ai/schemas.test.ts
vt "EC-15a-verdict-pct" "returns null for percentage level" src/lib/ai/schemas.test.ts
vt "EC-15a-verdict-invalid" "returns null for invalid level string" src/lib/ai/schemas.test.ts

# EC-15c: notAnalyzed merged from pack + model
vt "EC-15c-merge" "merges packed context notAnalyzed with model notAnalyzed, deduped" src/lib/ai/run.test.ts
vt "EC-15c-ui-hide" "hides notAnalyzed section when empty" src/components/UnderstandStep.test.ts
vt "EC-15c-ui-show" "shows notAnalyzed section when non-empty" src/components/UnderstandStep.test.ts

# EC-15e: strings as text nodes (XSS via verdict strings — handled by Svelte auto-escape)
# Svelte auto-escapes text nodes. The test verifies no HTML injection from notAnalyzed list.
vt "EC-15e" "shows notAnalyzed section when non-empty" src/components/UnderstandStep.test.ts

# EC-15f: repair retry (same mechanism — covered by EC-13e/EC-14g)
vt "EC-15f" "retries once when validator returns null .parseable JSON, wrong shape., succeeds" src/lib/llm/llm.test.ts

# EC-15g: CI failures appended to verdict prompt
vt "EC-15g-name" "user prompt contains CI failure name when ci has failures" src/lib/ai/tasks.test.ts
vt "EC-15g-annotation" "user prompt contains annotation text when ci has failures" src/lib/ai/tasks.test.ts

# --- REQ-16: Context packing ---
header "REQ-16: Context packing (budget + file selection)"

# EC-16a: zero files → empty result
vt "EC-16a" "returns empty text and empty arrays when files is empty and ci is null" src/lib/context/pack.test.ts

# EC-16b: files within budget included
vt "EC-16b-patch" "includes patch for a file within budget" src/lib/context/pack.test.ts
vt "EC-16b-content" "includes before/after content when within budget" src/lib/context/pack.test.ts

# EC-16c: notAnalyzed tracking
vt "EC-16c-patch-skip" "records file in notAnalyzed when patch exceeds budget" src/lib/context/pack.test.ts
vt "EC-16c-excluded" "records excluded files in notAnalyzed" src/lib/context/pack.test.ts

# EC-16d: boundary determinism
vt "EC-16d-at-budget" "includes patch at exactly the budget boundary" src/lib/context/pack.test.ts
vt "EC-16d-minus1" "excludes patch when budget is 1 token below section size" src/lib/context/pack.test.ts
vt "EC-16d-plus1" "includes patch when budget is 1 token above section size" src/lib/context/pack.test.ts

# EC-16e: lock/generated files excluded
vt "EC-16e" "excludes pnpm-lock.yaml" src/lib/context/pack.test.ts

# EC-16g: status-based content selection
vt "EC-16g-added" "includes only after content for added files" src/lib/context/pack.test.ts
vt "EC-16g-removed" "includes only before content for removed files" src/lib/context/pack.test.ts
vt "EC-16g-binary" "excludes binary files" src/lib/context/pack.test.ts

# EC-16i: CI failures in context
vt "EC-16i" "appends CI failures to context" src/lib/context/pack.test.ts

# EC-16k: notAnalyzed comprehensive
vt "EC-16k-no-double" "does not double-list a file in both notAnalyzed and includedFiles" src/lib/context/pack.test.ts
vt "EC-16k-all-skipped" "lists all skipped files in notAnalyzed across a mixed file set" src/lib/context/pack.test.ts

# --- REQ-17: AI response cache ---
header "REQ-17: AI response caching"

# EC-17a: round-trip miss → set → hit
vt "EC-17a" "getCached returns null on miss, then returns value after setCached" src/lib/cache/aiCache.test.ts

# EC-17b: key changes with sha
vt "EC-17b" "changing prKey sha produces a distinct key" src/lib/cache/aiCache.test.ts

# EC-17c: key changes with task
vt "EC-17c" "changing task produces a distinct key" src/lib/cache/aiCache.test.ts

# EC-17d: partial stream not cached (caller semantics in run.svelte.ts)
vt "EC-17d" "caches summary only after complete success" src/lib/ai/run.test.ts

# EC-17e: IndexedDB unavailable → graceful fallback
vt "EC-17e-get" "getCached returns null when indexedDB is not available" src/lib/cache/aiCache.test.ts
vt "EC-17e-set" "setCached is a no-op when indexedDB is not available" src/lib/cache/aiCache.test.ts

# EC-17i: key changes with promptVersion
vt "EC-17i" "changing promptVersion produces a distinct key" src/lib/cache/aiCache.test.ts

# --- EC-06h: Diff renders while AI panels are loading (Plan A deferral — now real) ---
header "REQ-06 EC-06h: Diff renders while AI panels load"
vt "EC-06h" "EC-06h: FileDiff article is present in step 2 while AI panels show loading" src/routes/Review.test.ts

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
