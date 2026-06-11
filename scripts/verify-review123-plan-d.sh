#!/usr/bin/env bash
# ============================================================================
# Verification Script: Review 1-2-3 — Plan D (review intelligence)
# Features: D1 status-aware change-map, D2 test-insight panel,
#           D3 since-last-visit interdiff, D4 comment coach
# Re-run after any change: ./scripts/verify-review123-plan-d.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Configuration ---
REPORT_DIR="docs/superpowers/verification"
TOPIC_SLUG="review123-plan-d"

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

# ===========================================================================
# D1 — Status-aware change-map diagrams
# ===========================================================================

# --- Schemas v4: GraphResult status enums + changeMap backward compat ---
header "D1-schemas: GraphResult status enums + changeMap backward compat"

vt "D1-schema-status-valid-node" "accepts nodes with valid status" src/lib/ai/schemas.test.ts
vt "D1-schema-status-valid-edge" "accepts edges with valid status" src/lib/ai/schemas.test.ts
vt "D1-schema-status-all-four" "accepts all four status enum values on nodes" src/lib/ai/schemas.test.ts
vt "D1-schema-status-invalid-node" "returns null for invalid node status enum value" src/lib/ai/schemas.test.ts
vt "D1-schema-status-invalid-edge" "returns null for invalid edge status enum value" src/lib/ai/schemas.test.ts
vt "D1-schema-changemap-valid" "accepts a valid changeMap .D1." src/lib/ai/schemas.test.ts
vt "D1-schema-changemap-invalid-status" "returns null when changeMap has invalid node status" src/lib/ai/schemas.test.ts
vt "D1-schema-backward-compat-no-status" "accepts nodes and edges without status .backward compat with cached v3." src/lib/ai/schemas.test.ts
vt "D1-schema-backward-compat-no-changemap" "accepts result without changeMap .backward compat with cached v3." src/lib/ai/schemas.test.ts

# --- Prompts: few-shot status + changeMap instructions ---
header "D1-prompts: diagramsPrompt changeMap / status few-shot embedding"

vt "D1-prompt-few-shot-marker" "system prompt contains the few-shot example .FEW_SHOT_EXAMPLE_START marker." src/lib/ai/tasks.test.ts
vt "D1-prompt-changemap-field" "system prompt mentions changeMap field .D1." src/lib/ai/tasks.test.ts
vt "D1-prompt-status-enum-values" "system prompt mentions all four status enum values .D1." src/lib/ai/tasks.test.ts
vt "D1-prompt-status-required" "system prompt instructs that every node and edge in changeMap must carry a status .D1." src/lib/ai/tasks.test.ts
vt "D1-prompt-few-shot-status-node" "few-shot example contains status field on a node .D1." src/lib/ai/tasks.test.ts
vt "D1-prompt-max-14-nodes" "system prompt instructs max 14 nodes for changeMap .D1." src/lib/ai/tasks.test.ts
vt "D1-prompt-version-v4" "is at least 4 .bumped for changeMap, testInsight, and coach prompts." src/lib/ai/tasks.test.ts

# --- Serializer: classDefs + dashed/thick edge syntax ---
header "D1-serializer: mermaid classDefs, dashed/thick arrows, statusless backward compat"

vt "D1-serializer-statusless-no-classdefs" "statusless graph emits NO classDefs .backward compat." src/lib/diagram/mermaid.test.ts
vt "D1-serializer-classdefs-present" "status graph emits classDefs for statuses present" src/lib/diagram/mermaid.test.ts
vt "D1-serializer-all-four-classdefs" "emits all four classDefs when all statuses present" src/lib/diagram/mermaid.test.ts
vt "D1-serializer-class-assignment" "emits class assignment lines for nodes with status" src/lib/diagram/mermaid.test.ts
vt "D1-serializer-dashed-removed" "removed edge uses dashed arrow syntax" src/lib/diagram/mermaid.test.ts
vt "D1-serializer-thick-added" "added edge uses thick arrow syntax" src/lib/diagram/mermaid.test.ts
vt "D1-serializer-mixed-statuses" "mixed statuses: nodes and edges all correctly emitted" src/lib/diagram/mermaid.test.ts
vt "D1-serializer-classdefs-order" "classDefs emitted in deterministic order: added, removed, changed, unchanged" src/lib/diagram/mermaid.test.ts

# --- UI: DiagramPanel change-map rendering + legend ---
header "D1-ui: DiagramPanel change-map + legend chips + before/after toggle"

vt "D1-ui-changemap-section" "renders Change Map section when result.changeMap is present" src/components/DiagramPanel.test.ts
vt "D1-ui-legend-chips" "renders legend chips: Added, Removed, Changed, Unchanged" src/components/DiagramPanel.test.ts
vt "D1-ui-before-after-toggle" "renders .Before \/ After. toggle button when changeMap is present" src/components/DiagramPanel.test.ts
vt "D1-ui-v3-fallback" "v3 fallback: no changeMap → shows before.after layout without legend or toggle" src/components/DiagramPanel.test.ts

# ===========================================================================
# D2 — Test-insight panel
# ===========================================================================

# --- Schemas v4: validateTestInsight ---
header "D2-schemas: validateTestInsight"

vt "D2-schema-valid" "accepts a valid TestInsight" src/lib/ai/schemas.test.ts
vt "D2-schema-missing-covered" "returns null when covered is missing" src/lib/ai/schemas.test.ts
vt "D2-schema-missing-gaps" "returns null when gaps is missing" src/lib/ai/schemas.test.ts

# --- Prompts: testInsightPrompt ---
header "D2-prompts: testInsightPrompt structure"

vt "D2-prompt-json-output" "system prompt instructs JSON output" src/lib/ai/tasks.test.ts
vt "D2-prompt-covered-field" "system prompt mentions covered field" src/lib/ai/tasks.test.ts
vt "D2-prompt-gaps-field" "system prompt mentions gaps field" src/lib/ai/tasks.test.ts
vt "D2-prompt-inferred-not-measured" "system prompt states test mapping is inferred not measured" src/lib/ai/tasks.test.ts
vt "D2-prompt-up-to-10" "system prompt instructs up to 10 behaviors in covered" src/lib/ai/tasks.test.ts

# --- Orchestrator: tests panel isolation + cache ---
header "D2-orchestrator: tests panel cache + isolation"

vt "D2-orch-tests-cache-hit" "tests cache hit: done + track cached:true, no llmJsonWithRepair call for tests" src/lib/ai/run.test.ts
vt "D2-orch-tests-isolation" "tests failure does not affect summary, attention, diagrams, or verdict" src/lib/ai/run.test.ts
vt "D2-orch-tests-retry" "retry.tests. re-runs only tests, other panels unaffected" src/lib/ai/run.test.ts

# --- UI: tests chip + AI-inferred wording + panel ---
header "D2-ui: UnderstandStep tests chip + AI-inferred panel"

vt "D2-ui-tests-chip-covered" "renders tests chip with covered count when tests is done" src/components/UnderstandStep.test.ts
vt "D2-ui-tests-chip-gaps" "renders gaps chip in amber when gaps > 0" src/components/UnderstandStep.test.ts
vt "D2-ui-tests-chip-no-gaps" "does not render gaps chip when gaps is empty" src/components/UnderstandStep.test.ts
vt "D2-ui-tests-chip-idle" "does not show tests chip when tests is idle" src/components/UnderstandStep.test.ts
vt "D2-ui-ai-inferred-wording" "uses .AI-inferred. wording in panel .EC-13d." src/components/UnderstandStep.test.ts
vt "D2-ui-panel-summary" "renders .Test coverage .AI-inferred.. panel summary" src/components/UnderstandStep.test.ts

# ===========================================================================
# D3 — Since-last-visit interdiff (viewed state + visits + compare)
# ===========================================================================

# --- Viewed lib ---
header "D3-viewed-lib: viewed state persistence + hash-mismatch unview"

vt "D3-viewed-toggle" "toggle marks a file as viewed" src/lib/viewed/viewed.test.ts
vt "D3-viewed-collapse" "viewed file has is-collapsed article" src/components/InspectStep.test.ts
vt "D3-viewed-unview" "unviewed file is NOT collapsed" src/components/InspectStep.test.ts
vt "D3-viewed-persist" "persists viewed state across store instances" src/lib/viewed/viewed.test.ts
vt "D3-viewed-hash-mismatch-unview" "isViewed is false when hash mismatches" src/lib/viewed/viewed.test.ts
vt "D3-viewed-changed-badge" "changedSinceViewed is true when patch changed after viewing" src/lib/viewed/viewed.test.ts

# --- FileDiff viewed rendering ---
header "D3-file-diff: viewed checkbox + collapse rendering"

vt "D3-filediff-checkbox" "renders a .Viewed. checkbox with correct aria-label" src/components/FileDiff.test.ts
vt "D3-filediff-collapsed" "viewed=true: checkbox is checked and diff body is collapsed" src/components/FileDiff.test.ts
vt "D3-filediff-not-collapsed" "viewed=false: article is not collapsed" src/components/FileDiff.test.ts
vt "D3-filediff-changed-badge" "changedSinceViewed=true: amber badge is shown" src/components/FileDiff.test.ts
vt "D3-filediff-toggle-called" "onToggleViewed is called when checkbox changes" src/components/FileDiff.test.ts

# --- Visits lib ---
header "D3-visits-lib: lastVisit + recordVisit"

vt "D3-visits-null-unknown" "returns null when PR has never been visited" src/lib/visits/visits.test.ts
vt "D3-visits-round-trip" "round-trips headSha and visitedAt" src/lib/visits/visits.test.ts
vt "D3-visits-overwrite" "overwrites previous visit when called again" src/lib/visits/visits.test.ts

# --- Compare lib ---
header "D3-compare-lib: compareCommits API"

vt "D3-compare-files-map" "maps files including previousFilename from previous_filename" src/lib/github/compare.test.ts
vt "D3-compare-404" "propagates 404 as GithubApiError with not-found kind" src/lib/github/compare.test.ts
vt "D3-compare-url-format" "uses the correct GitHub compare URL format .base...head." src/lib/github/compare.test.ts

# --- Review route: banner + compare swap + 404 fallback ---
header "D3-ui: since-last-visit banner + compare mode + 404 fallback"

vt "D3-ui-no-banner-first-visit" "does NOT show banner on first visit .no prior visit recorded." src/routes/Review.test.ts
vt "D3-ui-no-banner-same-sha" "does NOT show banner when headSha is the same as last visit" src/routes/Review.test.ts
vt "D3-ui-banner-step2-sha-differs" "shows banner in step 2 when headSha differs from last visit" src/routes/Review.test.ts
vt "D3-ui-banner-not-step1" "banner is NOT shown on step 1 even when sha differs" src/routes/Review.test.ts
vt "D3-ui-compare-swap" "clicking .Show only changes since then. fetches compare and shows compare files" src/routes/Review.test.ts
vt "D3-ui-compare-exit" "clicking .Show full diff. exits compare mode" src/routes/Review.test.ts
vt "D3-ui-compare-404-fallback" "shows force-push error message when compare returns 404" src/routes/Review.test.ts

# --- Visit recording ---
header "D3-visit-recording: Review records visit on load"

vt "D3-visit-records-on-load" "records a visit with the current headSha when the PR loads" src/routes/Review.test.ts

# ===========================================================================
# D4 — Comment coach
# ===========================================================================

# --- Schemas v4: validateCoachResult ---
header "D4-schemas: validateCoachResult"

vt "D4-schema-valid" "accepts a valid CoachResult" src/lib/ai/schemas.test.ts
vt "D4-schema-clarity-bounds" "returns null for clarity = 0 .out of range." src/lib/ai/schemas.test.ts
vt "D4-schema-clarity-6" "returns null for clarity = 6 .out of range." src/lib/ai/schemas.test.ts
vt "D4-schema-clarity-float" "returns null for clarity = 2.5 .non-integer." src/lib/ai/schemas.test.ts
vt "D4-schema-tone-invalid" "returns null for invalid tone string" src/lib/ai/schemas.test.ts
vt "D4-schema-bias-required" "returns null when biasQuestion is absent .required field." src/lib/ai/schemas.test.ts
vt "D4-schema-suggestion-required" "returns null when suggestion is absent .required field." src/lib/ai/schemas.test.ts

# --- Prompts: coachPrompt embedding ---
header "D4-prompts: coachPrompt structure"

vt "D4-prompt-embeds-draft-bodies" "user prompt embeds the draft bodies" src/lib/ai/tasks.test.ts
vt "D4-prompt-json-output" "system prompt instructs JSON output" src/lib/ai/tasks.test.ts
vt "D4-prompt-reviews-field" "system prompt mentions reviews field" src/lib/ai/tasks.test.ts
vt "D4-prompt-clarity-range" "system prompt mentions clarity field with 1.5 range" src/lib/ai/tasks.test.ts
vt "D4-prompt-tone-values" "system prompt mentions tone enum values" src/lib/ai/tasks.test.ts
vt "D4-prompt-bias-question" "system prompt mentions biasQuestion field" src/lib/ai/tasks.test.ts
vt "D4-prompt-suggestion-field" "system prompt mentions suggestion field" src/lib/ai/tasks.test.ts

# --- Orchestrator: coach gating + never cached ---
header "D4-orchestrator: coach gating + never-cached"

vt "D4-orch-no-key" "no-key: coach returns error message without calling gateAi or llm" src/lib/ai/run.test.ts
vt "D4-orch-declined" "declined: coach returns declined error message without calling llm" src/lib/ai/run.test.ts
vt "D4-orch-success" "returns CoachResult on success, maps drafts to index=array-position" src/lib/ai/run.test.ts
vt "D4-orch-never-cached" "coach does not call getCached or setCached" src/lib/ai/run.test.ts

# --- UI: VerdictStep coach button + apply ---
header "D4-ui: VerdictStep coach gating + apply suggestion + recap"

vt "D4-ui-coach-btn-visible" "Coach button is visible when signed in .+ drafts > 0 .+ key .+ coachFn" src/components/VerdictStep.test.ts
vt "D4-ui-coach-btn-no-drafts" "Coach button is hidden when there are 0 drafts" src/components/VerdictStep.test.ts
vt "D4-ui-coach-btn-no-key" "Coach button is hidden when no deepseek key" src/components/VerdictStep.test.ts
vt "D4-ui-coach-btn-signed-out" "Coach button is hidden when signed out" src/components/VerdictStep.test.ts
vt "D4-ui-coach-apply" "Apply suggestion replaces the draft body in the store" src/components/VerdictStep.test.ts
vt "D4-ui-coach-dismiss" "Dismiss hides the suggestion card without mutating the store" src/components/VerdictStep.test.ts
vt "D4-ui-coach-error" "renders error message in role=alert on coachFn error" src/components/VerdictStep.test.ts

# ===========================================================================
# Summary
# ===========================================================================
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
