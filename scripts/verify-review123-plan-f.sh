#!/usr/bin/env bash
# ============================================================================
# Verification Script: Review 1-2-3 — Plan F (Multi-LLM BYOK + Settings Page)
# Features: transport adapters (openai-compat / anthropic / gemini), provider
#           defs, per-provider key settings, OpenAI serverless proxy, cache key
#           model component, /settings page, model picker UX, Save & test,
#           active-provider no-key hints
# Re-run after any change: ./scripts/verify-review123-plan-f.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Configuration ---
REPORT_DIR="docs/superpowers/verification"
TOPIC_SLUG="review123-plan-f"

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

# fgrep_check <id> <pattern> <file> — static content check
fgrep_check() {
  local id="$1"; local pattern="$2"; local file="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    pass "$id"
  else
    fail "$id" "pattern '$pattern' not found in $file"
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
# F1 — Provider definitions (single source of truth)
# ===========================================================================

header "F1-providers: provider defs structure"

vt "F1-providers-four"        "exports exactly 4 providers: deepseek, openai, anthropic, gemini" src/lib/llm/transports.test.ts
vt "F1-providers-deepseek"    "deepseek has transport openai-compat and default model deepseek-chat" src/lib/llm/transports.test.ts
vt "F1-providers-openai"      "openai has transport openai-compat and default model gpt-5.2" src/lib/llm/transports.test.ts
vt "F1-providers-anthropic"   "anthropic has transport anthropic and default model claude-sonnet-4-6" src/lib/llm/transports.test.ts
vt "F1-providers-gemini"      "gemini has transport gemini and default model gemini-2.5-flash" src/lib/llm/transports.test.ts
vt "F1-providers-default-in-list" "each provider defaultModel is in its models list" src/lib/llm/transports.test.ts

# ===========================================================================
# F1 — Transport adapters behind unchanged llmComplete/llmStream signatures
# ===========================================================================

header "F1-transports: openai-compat / anthropic / gemini adapters"

vt "F1-deepseek-regression"   "posts to api.deepseek.com/chat/completions with Bearer auth" src/lib/llm/transports.test.ts
vt "F1-deepseek-stream"       "llmStream accumulates deltas and returns full content" src/lib/llm/transports.test.ts
vt "F1-anthropic-headers"     "posts to api.anthropic.com/v1/messages with correct headers" src/lib/llm/transports.test.ts
vt "F1-anthropic-no-respfmt"  "json flag does NOT add response_format field" src/lib/llm/transports.test.ts
vt "F1-anthropic-sse"         "accumulates text from content_block_delta events" src/lib/llm/transports.test.ts
vt "F1-anthropic-usage"       "llmStreamWithUsage captures input . output tokens from Anthropic events" src/lib/llm/transports.test.ts
vt "F1-gemini-headers"        "posts to generateContent endpoint with x-goog-api-key header" src/lib/llm/transports.test.ts
vt "F1-gemini-json"           "sends responseMimeType: application/json when json:true" src/lib/llm/transports.test.ts
vt "F1-gemini-usage"          "llmStreamWithUsage captures Gemini usageMetadata from final chunk" src/lib/llm/transports.test.ts
vt "F1-openai-proxy-path"     "posts to /api/llm/openai/chat/completions .local proxy path." src/lib/llm/transports.test.ts
vt "F1-openai-proxy-header"   "sends x-user-openai-key header for proxy passthrough" src/lib/llm/transports.test.ts
vt "F1-key-gating"            "no-key" src/lib/llm/transports.test.ts

# ===========================================================================
# F1 — Settings fields + validation
# ===========================================================================

header "F1-settings: aiProvider/aiModel + per-provider key fields"

vt "F1-settings-provider-default" "aiProvider defaults to deepseek" src/lib/settings/settings.test.ts
vt "F1-settings-provider-persist" "setAiProvider persists anthropic" src/lib/settings/settings.test.ts
vt "F1-settings-provider-coerce"  "coerces invalid aiProvider to default .deepseek." src/lib/settings/settings.test.ts
vt "F1-settings-model-default"    "aiModel defaults to empty string" src/lib/settings/settings.test.ts
vt "F1-settings-model-persist"    "setAiModel persists the model id" src/lib/settings/settings.test.ts
vt "F1-settings-openai-key"       "setOpenaiKey rejects empty string" src/lib/settings/settings.test.ts
vt "F1-settings-anthropic-key"    "setAnthropicKey rejects empty string" src/lib/settings/settings.test.ts

# ===========================================================================
# F1 — OpenAI serverless proxy (no-log discipline) + cache key model id
# ===========================================================================

header "F1-proxy: api/llm/openai.ts forwarding + no-log"

vt "F1-proxy-forward"   "forwards request to OpenAI with Authorization: Bearer header" api/llm/openai.test.ts
vt "F1-proxy-401"       "relays upstream 401 status verbatim .bad key." api/llm/openai.test.ts
vt "F1-proxy-stream"    "relays content-type from upstream .text/event-stream for streaming." api/llm/openai.test.ts
vt "F1-proxy-no-log"    "openai.ts source does not contain any console.log/warn/error/info calls" api/llm/openai.test.ts

header "F1-cache: cache key gains the model id"

vt "F1-cache-model-seg"    "with modelId appends m:<model> segment" src/lib/llm/transports.test.ts
vt "F1-cache-model-diff"   "different models produce different keys for same prKey.task.version" src/lib/llm/transports.test.ts
vt "F1-budget-active"      "budgetTokens from active model" src/lib/llm/transports.test.ts

# ===========================================================================
# F2 — /settings page (dedicated route, decomposed sections)
# ===========================================================================

header "F2-settings-page: route + section composition"

vt "F2-route-settings"     "/settings . settings route without section" src/lib/router/router.test.ts
vt "F2-route-section"      "/settings/ai-models . settings route with section=ai-models" src/lib/router/router.test.ts
vt "F2-page-heading"       "renders the settings page heading" src/routes/SettingsPage.test.ts
vt "F2-page-back"          "Back button navigates to returnTo path from sessionStorage" src/routes/SettingsPage.test.ts
vt "F2-page-appearance"    "renders the Appearance section" src/routes/SettingsPage.test.ts
vt "F2-page-providers"     "renders the Providers . access section" src/routes/SettingsPage.test.ts
vt "F2-page-ai-models"     "renders the AI models section" src/routes/SettingsPage.test.ts
vt "F2-page-skills"        "renders the Reviewer skills section" src/routes/SettingsPage.test.ts

# SettingsPanel modal is fully retired — the component must be gone
header "F2-retired: SettingsPanel.svelte removed"
if [ ! -f src/components/SettingsPanel.svelte ]; then
  pass "F2-settingspanel-deleted"
else
  fail "F2-settingspanel-deleted" "src/components/SettingsPanel.svelte still exists"
fi
if ! grep -rq "from './SettingsPanel.svelte'" src/ 2>/dev/null; then
  pass "F2-settingspanel-unreferenced"
else
  fail "F2-settingspanel-unreferenced" "something still imports SettingsPanel.svelte"
fi

# ===========================================================================
# F3 — Model picker UX (AiModelsSection)
# ===========================================================================

header "F3-picker: provider radio + model dropdown + key fields"

vt "F3-picker-radios"        "renders a radio per provider from PROVIDERS defs" src/components/settings/AiModelsSection.test.ts
vt "F3-picker-switch"        "selecting Anthropic persists aiProvider immediately and resets aiModel to default" src/components/settings/AiModelsSection.test.ts
vt "F3-picker-models"        "lists the active provider models with the provider default selected" src/components/settings/AiModelsSection.test.ts
vt "F3-picker-repopulate"    "switching provider repopulates the dropdown with that provider models" src/components/settings/AiModelsSection.test.ts
vt "F3-picker-model-save"    "choosing a model persists aiModel" src/components/settings/AiModelsSection.test.ts
vt "F3-keys-masked-hint"     "renders a masked key input per provider with the provider keyHint placeholder" src/components/settings/AiModelsSection.test.ts
vt "F3-keys-active-emph"     "the ACTIVE provider key row is emphasized .data-active." src/components/settings/AiModelsSection.test.ts
vt "F3-keys-atomic-save"     "Save stores all provider keys atomically" src/components/settings/AiModelsSection.test.ts
vt "F3-privacy-note"         "shows the .what.s sent where. privacy note including the OpenAI proxy" src/components/settings/AiModelsSection.test.ts

header "F3-test-button: per-provider Save & test connection"

vt "F3-test-per-provider"    "renders a Save . test button per provider" src/components/settings/AiModelsSection.test.ts
vt "F3-test-saves-first"     "saves the entered key FIRST, then pings that provider through the transport" src/components/settings/AiModelsSection.test.ts
vt "F3-test-ok"              "shows ok state on success" src/components/settings/AiModelsSection.test.ts
vt "F3-test-error"           "shows the error message inline on failure" src/components/settings/AiModelsSection.test.ts
vt "F3-test-inflight"        "disables the button while the test is in flight" src/components/settings/AiModelsSection.test.ts
vt "F3-ping-minimal"         "deepseek: posts a max_tokens:1 ping to api.deepseek.com/chat/completions with Bearer auth" src/lib/llm/llmTestConnection.test.ts
vt "F3-ping-given-provider"  "tests the GIVEN provider even when a different provider is active" src/lib/llm/llmTestConnection.test.ts
vt "F3-ping-gemini-no-cap"   "gemini: pings generateContent with x-goog-api-key .no 1-token cap . thinking models." src/lib/llm/llmTestConnection.test.ts

# llmTestConnection must never touch the AI cache (static check: llm.ts has no cache import)
header "F3-test-never-cached: llm.ts has no cache dependency"
if ! grep -q "aiCache" src/lib/llm/llm.ts; then
  pass "F3-ping-no-cache"
else
  fail "F3-ping-no-cache" "llm.ts references aiCache — ping could hit the cache"
fi

# ===========================================================================
# F3 — No-key hints name the ACTIVE provider
# ===========================================================================

header "F3-hints: active-provider no-key hints"

vt "F3-hint-default"       "names DeepSeek by default" src/components/AiPanel.test.ts
vt "F3-hint-anthropic"     "names Anthropic when aiProvider=anthropic" src/components/AiPanel.test.ts
vt "F3-hint-settings-link" "links to the /settings page" src/components/AiPanel.test.ts
vt "F3-gate-active-key"    "start.. proceeds when aiProvider=anthropic and only anthropicKey is set" src/lib/ai/run.test.ts
vt "F3-gate-wrong-key"     "start.. sets no-key when aiProvider=anthropic and only deepseekKey is set" src/lib/ai/run.test.ts
vt "F3-msg-provider"       "coach.. no-key error names the ACTIVE provider .Gemini." src/lib/ai/run.test.ts
vt "F3-err-provider"       "stream error copy names the ACTIVE provider .Anthropic." src/lib/ai/run.test.ts

# ===========================================================================
# F3 — README + e2e coverage present
# ===========================================================================

header "F3-docs: README per-provider setup + privacy table"

fgrep_check "F3-readme-providers"   "Choose your AI provider (BYOK)" README.md
fgrep_check "F3-readme-proxy-note"  "OpenAI proxy note" README.md
fgrep_check "F3-readme-privacy"     "Privacy implications per provider" README.md
fgrep_check "F3-readme-anthropic"   "console.anthropic.com" README.md
fgrep_check "F3-readme-gemini"      "aistudio.google.com" README.md

header "F3-e2e: provider-switch flow (fixture-backed openai-compat endpoint)"
if pnpm exec playwright test e2e/settings.spec.ts >/dev/null 2>&1; then
  pass "F3-e2e-settings"
else
  fail "F3-e2e-settings" "playwright e2e/settings.spec.ts failed"
fi

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
