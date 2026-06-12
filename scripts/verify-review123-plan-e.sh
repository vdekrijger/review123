#!/usr/bin/env bash
# ============================================================================
# Verification Script: Review 1-2-3 — Plan E (Multi-Provider Support)
# Features: GitLab adapter, Bitbucket adapter, provider registry, settings UI,
#           VerdictStep non-atomic copy, e2e provider flows
# Re-run after any change: ./scripts/verify-review123-plan-e.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Configuration ---
REPORT_DIR="docs/superpowers/verification"
TOPIC_SLUG="review123-plan-e"

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
# E1 — Provider registry + URL parsing
# ===========================================================================

header "E1-registry: providerFor + parseAnyUrl"

vt "E1-registry-github"     "returns the github provider for .github."           src/lib/provider/registry.test.ts
vt "E1-registry-gitlab"     "returns the gitlab provider for .gitlab."            src/lib/provider/registry.test.ts
vt "E1-registry-bitbucket"  "returns the bitbucket provider for .bitbucket."     src/lib/provider/registry.test.ts
vt "E1-registry-unknown"    "throws for an unknown provider id"                   src/lib/provider/registry.test.ts
vt "E1-parseany-github"     "parses a valid GitHub PR URL"                        src/lib/provider/registry.test.ts
vt "E1-parseany-gitlab"     "parses a gitlab.com MR URL now that GitLab is registered" src/lib/provider/registry.test.ts
vt "E1-parseany-bitbucket"  "parses a valid Bitbucket PR URL"                    src/lib/provider/registry.test.ts
vt "E1-parseany-null"       "returns null for an unrecognized URL"                src/lib/provider/registry.test.ts

# ===========================================================================
# E2 — Store key migration (provider-qualified keys)
# ===========================================================================

header "E2-storekeys: provider-qualified key helpers + migration"

vt "E2-storekeys-qualified-github"   "returns true for qualified github key"            src/lib/provider/storeKeys.test.ts
vt "E2-storekeys-qualified-gitlab"   "returns true for qualified gitlab key"            src/lib/provider/storeKeys.test.ts
vt "E2-storekeys-qualified-bitbucket" "returns true for qualified bitbucket key"        src/lib/provider/storeKeys.test.ts
vt "E2-storekeys-legacy-false"       "returns false for legacy key"                     src/lib/provider/storeKeys.test.ts
vt "E2-storekeys-migrate-visits"     "copies legacy keys to qualified keys"             src/lib/provider/storeKeys.test.ts
vt "E2-storekeys-idempotent"         "is idempotent — safe to call multiple times"      src/lib/provider/storeKeys.test.ts
vt "E2-storekeys-migrate-viewed"     "copies legacy viewed keys to qualified keys"      src/lib/provider/storeKeys.test.ts

# ===========================================================================
# E3 — GitLab adapter: URL parsing
# ===========================================================================

header "E3-gitlab-parse: GitLab URL parsing"

vt "E3-gitlab-parse-simple"    "parses a simple group/project MR URL"           src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-subgroup"  "parses subgroup URL .one level deep."           src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-deep"      "parses deeply nested subgroup .3 levels."       src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-trailing"  "strips trailing slash"                           src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-query"     "strips query string"                             src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-fragment"  "strips fragment .#."                             src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-reject-gh" "rejects a GitHub PR URL"                         src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-reject-no-infix" "rejects a GitLab URL without /-/ infix"   src/lib/provider/gitlab.test.ts
vt "E3-gitlab-parse-reject-bb" "rejects a Bitbucket PR URL"                     src/lib/provider/gitlab.test.ts

# ===========================================================================
# E4 — GitLab adapter: data mapping
# ===========================================================================

header "E4-gitlab-mapping: GitLab API → canonical model"

vt "E4-gitlab-meta-open"      "maps an open MR to PrMeta"                       src/lib/provider/gitlab.test.ts
vt "E4-gitlab-meta-merged"    "maps a merged MR correctly"                      src/lib/provider/gitlab.test.ts
vt "E4-gitlab-meta-null-refs" "handles null diff_refs .draft MR not yet diffed." src/lib/provider/gitlab.test.ts
vt "E4-gitlab-files-modified" "maps a modified file"                            src/lib/provider/gitlab.test.ts
vt "E4-gitlab-files-added"    "maps a new file .added."                         src/lib/provider/gitlab.test.ts
vt "E4-gitlab-files-deleted"  "maps a deleted file"                             src/lib/provider/gitlab.test.ts
vt "E4-gitlab-files-renamed"  "maps a renamed file with previousFilename"       src/lib/provider/gitlab.test.ts
vt "E4-gitlab-files-paginate" "paginates across multiple pages"                 src/lib/provider/gitlab.test.ts
vt "E4-gitlab-ci-empty"       "returns empty summary when no pipelines"         src/lib/provider/gitlab.test.ts
vt "E4-gitlab-ci-jobs"        "maps passed/failed/pending jobs from the latest pipeline" src/lib/provider/gitlab.test.ts
vt "E4-gitlab-comments-body"  "maps a non-positioned .body-level. note"         src/lib/provider/gitlab.test.ts
vt "E4-gitlab-comments-right" "maps an inline note on the RIGHT side .new_line." src/lib/provider/gitlab.test.ts
vt "E4-gitlab-comments-left"  "maps an inline note on the LEFT side .old_line." src/lib/provider/gitlab.test.ts
vt "E4-gitlab-resolved-empty" "returns empty set when no gitlabToken"           src/lib/provider/gitlab.test.ts
vt "E4-gitlab-resolved-ids"   "returns ids from resolved discussions when token is present" src/lib/provider/gitlab.test.ts
vt "E4-gitlab-commits"        "maps GitLab commits to PrCommit shape"           src/lib/provider/gitlab.test.ts
vt "E4-gitlab-compare-files"  "maps compare diffs to PrFile"                   src/lib/provider/gitlab.test.ts

# ===========================================================================
# E5 — GitLab adapter: submission + partial failure
# ===========================================================================

header "E5-gitlab-submit: GitLab submission semantics"

vt "E5-gitlab-submit-right"    "submits a RIGHT-side .new_line. positioned discussion" src/lib/provider/gitlab.test.ts
vt "E5-gitlab-submit-left"     "submits a LEFT-side .old_line. positioned discussion"  src/lib/provider/gitlab.test.ts
vt "E5-gitlab-submit-note"     "posts body as a note .not as a discussion."            src/lib/provider/gitlab.test.ts
vt "E5-gitlab-submit-rc-prefix" "prefixes body with .Changes requested:. when verdict is REQUEST_CHANGES" src/lib/provider/gitlab.test.ts
vt "E5-gitlab-submit-approve"  "calls /approve when verdict is APPROVE"               src/lib/provider/gitlab.test.ts
vt "E5-gitlab-submit-partial"  "returns partial failure outcome enumerating failed drafts" src/lib/provider/gitlab.test.ts
vt "E5-gitlab-submit-meta-err" "returns error when MR meta fetch fails"                src/lib/provider/gitlab.test.ts

# ===========================================================================
# E6 — GitLab adapter: capabilities + auth state
# ===========================================================================

header "E6-gitlab-capabilities: GitLab capability flags + auth"

vt "E6-gitlab-auth-no-token"  "returns configured:false when no token"           src/lib/provider/gitlab.test.ts
vt "E6-gitlab-auth-has-token" "returns configured:true when token is set"        src/lib/provider/gitlab.test.ts
vt "E6-gitlab-caps"           "has the expected capability flags"                 src/lib/provider/gitlab.test.ts
vt "E6-gitlab-suggestion"     "produces GitLab-flavoured suggestion fence with :-0+0 modifier" src/lib/provider/gitlab.test.ts

# ===========================================================================
# E7 — Bitbucket adapter: diff splitting
# ===========================================================================

header "E7-bitbucket-diff: splitUnifiedDiff helper"

vt "E7-bb-diff-empty"         "returns empty map for empty string"               src/lib/provider/bitbucket.test.ts
vt "E7-bb-diff-single"        "parses a single-file diff"                        src/lib/provider/bitbucket.test.ts
vt "E7-bb-diff-multi"         "parses a multi-file diff correctly"               src/lib/provider/bitbucket.test.ts
vt "E7-bb-diff-rename"        "handles rename headers using b/ path as the key"  src/lib/provider/bitbucket.test.ts
vt "E7-bb-diff-binary"        "skips binary files .no patch entry."              src/lib/provider/bitbucket.test.ts
vt "E7-bb-diff-deleted"       "handles deleted file .--- /dev/null path."        src/lib/provider/bitbucket.test.ts

# ===========================================================================
# E8 — Bitbucket adapter: URL parsing
# ===========================================================================

header "E8-bitbucket-parse: Bitbucket URL parsing"

vt "E8-bb-parse-standard"     "parses standard bitbucket PR URL"                 src/lib/provider/bitbucket.test.ts
vt "E8-bb-parse-trailing"     "parses URL with trailing slash"                   src/lib/provider/bitbucket.test.ts
vt "E8-bb-parse-query"        "parses URL with query string"                     src/lib/provider/bitbucket.test.ts
vt "E8-bb-parse-reject-gh"    "rejects github.com URL"                           src/lib/provider/bitbucket.test.ts
vt "E8-bb-parse-reject-gl"    "rejects gitlab.com URL"                           src/lib/provider/bitbucket.test.ts
vt "E8-bb-parse-reject-no-pr" "rejects bitbucket.org URL without pull-requests segment" src/lib/provider/bitbucket.test.ts
vt "E8-bb-parse-provider"     "has provider = bitbucket in parsed result"        src/lib/provider/bitbucket.test.ts

# ===========================================================================
# E9 — Bitbucket adapter: data mapping
# ===========================================================================

header "E9-bitbucket-mapping: Bitbucket API → canonical model"

vt "E9-bb-meta-open"          "maps OPEN state to open"                          src/lib/provider/bitbucket.test.ts
vt "E9-bb-meta-merged"        "maps MERGED state to closed + merged=true"        src/lib/provider/bitbucket.test.ts
vt "E9-bb-meta-declined"      "maps DECLINED state to closed + merged=false"     src/lib/provider/bitbucket.test.ts
vt "E9-bb-meta-short-hash"    "preserves short 12-char commit hashes as-is"      src/lib/provider/bitbucket.test.ts
vt "E9-bb-files-status"       "returns files with correct status mapping"        src/lib/provider/bitbucket.test.ts
vt "E9-bb-files-patch"        "attaches patch from the diff for files that have it" src/lib/provider/bitbucket.test.ts
vt "E9-bb-files-no-patch"     "files without diff section have no patch property" src/lib/provider/bitbucket.test.ts
vt "E9-bb-ci-successful"      "maps SUCCESSFUL → passed"                         src/lib/provider/bitbucket.test.ts
vt "E9-bb-ci-failed"          "maps FAILED → failed with name in failures"       src/lib/provider/bitbucket.test.ts
vt "E9-bb-comments-right"     "maps inline.to → line=to, side=RIGHT"             src/lib/provider/bitbucket.test.ts
vt "E9-bb-comments-left"      "maps inline.from → line=from, side=LEFT"          src/lib/provider/bitbucket.test.ts
vt "E9-bb-comments-general"   "maps general comment .no inline. to path/line/side=null" src/lib/provider/bitbucket.test.ts
vt "E9-bb-commits"            "maps hash, shortSha .7 chars., and first message line" src/lib/provider/bitbucket.test.ts
vt "E9-bb-compare-unsupported" "throws because compare is unsupported"           src/lib/provider/bitbucket.test.ts

# ===========================================================================
# E10 — Bitbucket adapter: submission + partial failure
# ===========================================================================

header "E10-bitbucket-submit: Bitbucket submission semantics"

vt "E10-bb-submit-right"      "posts inline draft comments with correct payload .RIGHT → to." src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-left"       "posts inline draft comments with LEFT → from"     src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-body"       "posts general body comment when body is non-empty" src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-no-body"    "does NOT post body comment when body is empty/whitespace" src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-approve"    "calls APPROVE endpoint for APPROVE verdict"        src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-rc"         "calls request-changes endpoint for REQUEST_CHANGES verdict" src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-ok"         "returns ok:true on full success"                   src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-partial"    "returns partial failure outcome when one draft fails" src/lib/provider/bitbucket.test.ts
vt "E10-bb-submit-comment-verdict" "COMMENT verdict does not call approve or request-changes endpoint" src/lib/provider/bitbucket.test.ts

# ===========================================================================
# E11 — Bitbucket adapter: capabilities + auth state
# ===========================================================================

header "E11-bitbucket-capabilities: Bitbucket capability flags + auth"

vt "E11-bb-auth-configured"   "returns configured=true when bitbucketAuth is set" src/lib/provider/bitbucket.test.ts
vt "E11-bb-auth-not-configured" "returns configured=false when bitbucketAuth is null" src/lib/provider/bitbucket.test.ts
vt "E11-bb-caps"              "has correct capability flags"                       src/lib/provider/bitbucket.test.ts
vt "E11-bb-id"                "id is bitbucket"                                   src/lib/provider/bitbucket.test.ts
vt "E11-bb-displayname"       "displayName is Bitbucket"                          src/lib/provider/bitbucket.test.ts

# ===========================================================================
# E12 — Settings UI: Bitbucket fields
# ===========================================================================

# NOTE (Plan F): SettingsPanel.svelte was retired in favour of the /settings
# page; these tests moved to the decomposed ProvidersSection component.
header "E12-settings-bitbucket: ProvidersSection Bitbucket auth fields"

vt "E12-settings-bb-masked"   "Bitbucket email and token inputs are type=password .masked." src/components/settings/ProvidersSection.test.ts
vt "E12-settings-bb-save"     "saving Bitbucket credentials stores them via saveBitbucketAuth" src/components/settings/ProvidersSection.test.ts
vt "E12-settings-bb-hint"     "Bitbucket hint text is present in the Advanced section" src/components/settings/ProvidersSection.test.ts
vt "E12-settings-bb-partial"  "saving with email but empty token shows error, does not store" src/components/settings/ProvidersSection.test.ts
vt "E12-settings-bb-clear"    "clearing previously stored credentials saves null for bitbucketAuth" src/components/settings/ProvidersSection.test.ts

# ===========================================================================
# E13 — Landing: multi-provider copy + history
# ===========================================================================

header "E13-landing: multi-provider copy + provider-qualified history links"

vt "E13-landing-copy"         "description copy and placeholder mention github and gitlab; description also mentions bitbucket" src/routes/Landing.test.ts
vt "E13-landing-gitlab-hist"  "gitlab history entry navigates to /review/gitlab route" src/routes/Landing.test.ts

# ===========================================================================
# E14 — VerdictStep: non-atomic copy + partial failure
# ===========================================================================

header "E14-verdict-non-atomic: VerdictStep non-atomic copy + partial failure"

vt "E14-verdict-non-atomic-shown"   "non-atomic note: shown when provider.capabilities.atomicReview is false" src/components/VerdictStep.test.ts
vt "E14-verdict-non-atomic-hidden-true"  "non-atomic note: NOT shown when provider.capabilities.atomicReview is true" src/components/VerdictStep.test.ts
vt "E14-verdict-non-atomic-hidden-absent" "non-atomic note: NOT shown when provider prop is absent" src/components/VerdictStep.test.ts
vt "E14-verdict-partial-fail"       "partial-failure: drafts NOT cleared, error message shown in alert" src/components/VerdictStep.test.ts

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
