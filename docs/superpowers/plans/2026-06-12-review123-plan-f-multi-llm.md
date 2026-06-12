# Review 1-2-3 — Plan F: Multi-LLM BYOK + Settings Page

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Established patterns are law. Contracts binding.

**Goal:** Choose your AI: DeepSeek (today), Anthropic, Gemini — direct from the browser; OpenAI via a minimal proxy (no browser CORS). Settings outgrows its modal → dedicated `/settings` page with sections.

**Provider facts (verified knowledge, encode in comments):**
- **Anthropic:** browser CORS supported WITH header `anthropic-dangerous-direct-browser-access: true`; Messages API (`/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`); SSE streaming (`content_block_delta`); JSON mode = prompt-enforced (no response_format) → llmJsonWithRepair already handles repair. Default model `claude-sonnet-4-6`; context 200k.
- **Gemini:** browser CORS supported; `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` + `:streamGenerateContent?alt=sse`, key via `x-goog-api-key` header; JSON via `generationConfig.responseMimeType: application/json`. Default `gemini-2.5-flash`; context 1M.
- **OpenAI:** NO browser CORS → new serverless `api/llm/openai.ts` forwarding POST to `api.openai.com/v1/chat/completions`, streaming passthrough, user key in `x-user-openai-key` request header (never stored/logged server-side — same discipline as oauth exchange; origin-guard reuse). Default `gpt-5.2`; chat-completions shape = DeepSeek shape (OpenAI-compatible).
- **DeepSeek:** current code IS the OpenAI shape — becomes the `openai-compat` base adapter with per-provider baseUrl/headers.

## Architecture

`src/lib/llm/providers.ts`:
```ts
export interface LlmProviderDef { id: 'deepseek' | 'openai' | 'anthropic' | 'gemini'; displayName: string; models: { id: string; label: string; contextWindowTokens: number }[]; defaultModel: string; keyHint: string; transport: 'openai-compat' | 'anthropic' | 'gemini'; baseUrl: string }
```
`llm.ts` refactors to transport adapters (`openai-compat` covers deepseek+openai-proxy; `anthropic`; `gemini`) behind the EXISTING `llmComplete/llmStream/llmJsonWithRepair(+WithUsage)` signatures — zero changes to callers (run.svelte.ts, mineSkill, coach...). Active selection from settings: `aiProvider` (default 'deepseek') + `aiModel` (default per provider) + per-provider keys (`deepseekKey` stays; add `openaiKey`, `anthropicKey`, `geminiKey` — same validation/atomic patterns). Token budget in pack() derives from the ACTIVE model's contextWindowTokens (replaces LLM_CONFIG constant — keep a getter `activeLlmConfig()`). Usage capture per transport (OpenAI-compat: usage field; Anthropic: `usage` in message_delta; Gemini: `usageMetadata`). Cache keys gain the model id (cacheKey extension — different models = different cached results).

## Tasks

### Task F1: Transport adapters + provider defs + key settings (the meat)
llm.ts transport split (TDD per transport with realistic fixture SSE/JSON shapes incl. usage); providers.ts defs; settings fields (aiProvider/aiModel/keys) + validation; `api/llm/openai.ts` proxy (origin guard, header passthrough, streaming pipe, no-log test like exchange's); aiCache key gains model id (migration: old keys just miss — acceptable, comment); pack budget from activeLlmConfig(). All existing tests green (deepseek default path byte-identical).

### Task F2: /settings page
New route `/settings` (router + App link replacing modal trigger; the gear navigates). Page sections (anchors): **Appearance** (theme/font/diff width/test files/progress), **Providers & access** (GitHub sign-in+PAT, GitLab OAuth/PAT/host, Bitbucket), **AI models** (provider select + model select per provider + key fields + "what's sent where" privacy note), **Reviewer skills** (list/edit/builtins/mining). CONTENT MOVES from SettingsPanel.svelte (decompose into `src/components/settings/*.svelte` section components; the modal is RETIRED — all entry points navigate; AuthCallback returnTo etc. unaffected). Keep every existing behavior/test (tests retarget the page render). e2e settings specs updated.

### Task F3: Model picker UX + integration polish + verify
AI models section: provider radio + model dropdown (from defs), active provider's key field emphasized, connection "Test" button per provider (1-token ping, shows ok/error — never cached); glance/AiPanel no-key hints name the ACTIVE provider. verify-f script; README (per-provider setup incl. OpenAI proxy note + privacy implications table); e2e: switch provider to a fixture-backed openai-compat endpoint and run the flow.

## Done
All gates + verify A–F green; checkpoint: user runs a real PR with Anthropic or Gemini key and judges quality parity.
