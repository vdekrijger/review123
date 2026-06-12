# Review 1-2-3 — Plan G (part 2): Agentic Deep Review

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Established patterns are law. Contracts binding.

**Goal:** Single-pass reviewers flag unverified suspicions. Give the model TOOLS to verify each suspicion before flagging — improving precision on the two precision-critical paths: skill-reviewer runs and the verdict/why-this-verdict task. Opt-in (`aiDeepReview`, default **false**) because the loop costs more tokens. Toggle off = byte-identical behavior to today.

**Provider facts (verified 2026-06-13, encode in comments):**
- **DeepSeek:** function calling supported via the OpenAI-compatible `tools` / `tool_calls` wire format on `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-chat` (api-docs.deepseek.com/guides/function_calling). Legacy `deepseek-reasoner` historically does NOT support function calling → capability-flag it (`supportsTools: false`); deep review falls back to single-pass with an honest UI note.
- **OpenAI (proxy):** same chat/completions `tools`/`tool_calls` shape — one openai-compat adapter covers both.
- **Anthropic:** `tools` (name/description/input_schema) + `tool_use` content blocks; results return as `user` messages with `tool_result` blocks (`is_error` for failures); `tool_choice: {type:'none'}` forces the final answer.
- **Gemini:** `tools: [{functionDeclarations}]` + `functionCall` parts; results return as `functionResponse` parts; `toolConfig.functionCallingConfig.mode: 'NONE'` forces the final answer.
- **GitHub code search:** `GET /search/code?q=<query>+repo:owner/repo` (requires auth). GitLab/Bitbucket: capability-gated off in v1 (tool simply not offered).

## Architecture

```
src/lib/llm/llmToolLoop.ts   llmToolLoop(opts) — sends tool defs, executes calls,
                             appends results, repeats until final text or budget
                             exhausts. Per-transport adapters mirror llm.ts.
                             Usage summed across iterations.
src/lib/ai/deepReview.ts     Tool definitions + budgeted executor toolkit +
                             availability gate + humanized activity strings.
src/lib/ai/tasks.ts          withDeepReviewGuidance(system, toolNames) — appends
                             the hypothesis→verify→drop-unverified discipline
                             block; composes with (never replaces) the existing
                             evidence-discipline/calibration blocks.
src/lib/ai/run.svelte.ts     Verdict + skill-review tasks branch to the loop when
                             deep review is enabled; cache keys gain a '|deep'
                             marker; PanelState gains activity/toolCallsUsed/note.
```

**Tools (3, browser-feasible via the existing provider layer):**
1. `read_file(path)` — file contents at the PR **head** ref via `provider.getFileAtRef`. Cap 50 KB/file, truncate with an explicit marker.
2. `read_file_at_base(path)` — same at the **base** ref.
3. `search_code(query)` — GitHub code-search scoped to the repo (`ReviewProvider.searchCode?` — capability by method presence, GitHub-only in v1).

**Budgets (hard, enforced in the toolkit + loop):** max **8 tool calls**, max **150 KB** fetched per run. On exhaustion the loop disables tools (`tool_choice: none` / mode `NONE`) and demands the final schema'd answer. Tool errors (404, rate limit, budget) feed back as tool-result errors — the model proceeds without; transport failures mid-loop surface the existing error rendering (never a spinner hang).

**Loop contract (`llmToolLoop`):**
- Input: `{ system, user, tools, executeTool, onToolEvent?, maxToolCalls?, json?, signal? }`.
- Output: `{ content, usage? (summed), toolCallsUsed }`.
- Non-streaming rounds (tool calls don't stream); fresh 60 s timeout per round.
- `onToolEvent({ name, detail })` drives the run-indicator activity lines ("Reading src/foo.ts…", "Searching: createPrLoad…").

**Where it applies (v1):** `runVerdictTask` + `runSkillReviews` only. Summary/attention/diagrams/tests/alternatives/coach/ask stay single-pass.

**Caching:** deep results cache like skill reviews (content hash for skills), but the key gains a `|deep` marker on the task segment + PROMPT_VERSION as before — deep and single-pass results never collide. Partial loops are NEVER cached (same EC-17d discipline: setCached only after validation).

**Fallback honesty:** toggle on but active model `supportsTools === false` → run single-pass and set `PanelState.note` ("Deep review unavailable for <model> — ran standard review."). Toggle off → no new code paths execute.

**Settings + UI:**
- `aiDeepReview: boolean` (default false) + coerce + `setAiDeepReview`.
- AI models section toggle: "Deep review (agentic) — lets the AI read extra files before flagging; slower, uses more tokens."
- While the loop runs: activity lines under the existing skeleton (AiPanel) and in the skill run-status bar.
- Finished cards show "Deep review: verified with N tool calls" footer.

**Analytics:** `ai_task_completed` keeps `tokens` (summed loop usage — PostHog token events unchanged) and gains `tool_calls` when deep.

## Tasks

### Task G2.1: llmToolLoop + transport tool wiring (TDD)
Per-transport tests with realistic fixture JSON shapes for tool-call rounds (mirroring transports.test.ts): request body shape (tools/tool defs), multi-call rounds, result append shape, usage summing, budget exhaustion (`tool_choice` none + forced final), tool-error feedback, transport error propagation. `supportsTools` flag on LlmModelDef (default true; explicit false on `deepseek-reasoner`).

### Task G2.2: deepReview toolkit + provider searchCode
Toolkit tests: 50 KB truncation marker, 150 KB run budget → error results, 404 → error result, search_code omitted when provider lacks it, humanized strings, availability gate (setting off / no source / model unsupported). `searchCode` on the GitHub provider via `/search/code` with text-match fragments.

### Task G2.3: run.svelte.ts deep paths + settings + UI
Deep verdict/skill paths behind the gate; `|deep` cache keys; activity/toolCallsUsed/note on PanelState; settings field + toggle; AiPanel activity lines + footer; InspectStep status-bar activity. Tests: toggle-off byte-identical (loop never invoked, keys unchanged), deep cache hit/miss, fallback note, partial-loop-never-cached.

### Task G2.4: e2e + gates
Fixture-backed deep-review flow: intercept a 2-round tool conversation (round 1 → `tool_calls: read_file`, round 2 after `role:'tool'` message → final verdict JSON; GitHub contents route serves the file) → verdict renders with the tool-activity footer. All four gates: `pnpm check && pnpm test && playwright test && pnpm build`.

## Done
Gates green; toggle off → all existing tests untouched and green; checkpoint: user runs a real PR with deep review on and judges precision vs single-pass.
