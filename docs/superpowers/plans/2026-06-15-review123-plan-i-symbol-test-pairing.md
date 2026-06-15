# Review 1-2-3 — Plan I: Function↔Test Pairing (symbol-level)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development. Established patterns
> are law. Files mode + existing story behavior stay byte-identical unless explicitly extended. Conservative
> pairing: a missing pair beats a wrong one — false pairings erode trust.

**Goal:** Tie a *changed function* to the *specific test* that exercises it, so the implementation and its
test are visible together. Primary surface: **Story mode** — deepen its file-level `relatedTests` to
**symbol-level**: beneath a changed function's diff, an unobtrusive collapsible "Tested by `test_title`"
affordance reveals THAT test block (rendered from already-fetched test-file content). Requested by a PostHog
engineer.

This is a **deterministic parsing engine + one story-mode affordance + an optional deep-mode prune** — NOT a
diff rewrite, NOT a new AI task. The engine is pure parsing (no LLM), so it's available in classic Files mode
eventually too. It reuses existing infra: `langForFilename` (diff lang helper), `isTestFile`, the
patch/hunk parsing in `patchLines.ts`, the story `contentsMap` (full file contents already fetched for
expand-context/story), and the `FileDiff` syntax highlighting.

## The deterministic engine (works WITHOUT an LLM)

Two new pure modules under `src/lib/diff/`, fully unit-tested before any UI:

### 1. Changed-symbol extraction — `src/lib/diff/symbols.ts`

`extractChangedSymbols(file: PrFile): ChangedSymbol[]` — from a PrFile's `patch`, extract confident
changed-symbol names, each associated with the file + the changed line range (RIGHT/new side).

```
interface ChangedSymbol {
  symbol: string          // confident enclosing/defined name, e.g. send_slack_ai_subscription_report
  file: string            // PrFile.filename
  lineRange: { start: number; end: number }  // new-side (RIGHT) line span of the change
}
```

**STRONG signal — hunk-header enclosing context.** Git's unified-diff hunk header carries the enclosing
function/class on its trailing context:
`@@ -318,7 +324,7 @@ async def send_slack_ai_subscription_report(` → `send_slack_ai_subscription_report`.
This works across many languages because git's `xfuncname` picks the enclosing def line. Parse the text
*after* the closing `@@` and pull the symbol name with a per-language regex (keyed off `langForFilename`).

**PLUS added/changed definition lines** (lines with `+` in the hunk that declare a symbol), per language:
- **JS/TS** (`js`): `function foo`, `const foo = (…) =>`, `class Foo`, `foo(…) {` method, `export function foo`.
- **Python** (`python`): `def foo`, `async def foo`, `class Foo`.
- **Go** (`go`): `func foo`, `func (r R) foo`.
- **Java/Kotlin** (`java`/`kotlin`): `class Foo`, method `returnType foo(…) {` / `fun foo`.
- **Rust** (`rust`): `fn foo`, `pub fn foo`, `impl Foo`.
- **Ruby** (`ruby`): `def foo`, `class Foo`, `module Foo`.

**Conservative rules:** only emit names we're confident about (must match a real def/decl shape); dedupe by
symbol name within a file; skip when `langForFilename` is null. Prefer a missed symbol over a wrong one. The
line range is the union of changed (`+`) new-side line numbers in the enclosing hunk (reuse the hunk-walk
shape from `patchLines.ts`).

### 2. Test-reference matching — `src/lib/diff/symbolTests.ts`

`pairSymbolsWithTests(symbols, testFiles)` where each `testFile` is `{ path, content }` (content = the
already-fetched test-file body from `contentsMap`; `isTestFile(path)` decides which PR files are tests).

For each changed symbol, find which test file(s) reference it BY NAME and capture the SPECIFIC enclosing
test block:
- **named** (high confidence): the symbol appears in a test *title* —
  `describe('foo', …)` / `it('… foo …', …)` / `test('foo', …)` (JS), or a `def test_*foo*` name (Python).
- **referenced** (lower confidence): the symbol is called/imported only — `foo(`, `import { foo }`,
  `from module import foo`, `new Foo(`.

Capture the enclosing block's line range best-effort (brace/indent scan from the reference line). Output:

```
interface SymbolTestPairing {
  symbol: string
  implFile: string
  implLineRange: { start: number; end: number }
  tests: Array<{
    testFile: string
    lineRange: { start: number; end: number }
    title?: string
    confidence: 'named' | 'referenced'
  }>
}
```

**Conservative:** never pair on weak/ambiguous matches (e.g. a 2-char symbol, a symbol that is a common word
when only `referenced`). No pairing found → that symbol yields `tests: []` (the UI shows nothing). Empty,
graceful everywhere.

A small orchestrator `pairStepTests(step, files, contentsMap)` ties it together for a story step: extract
symbols from the step's `files`, gather the step's `relatedTests` (and any PR test files matched) contents
from `contentsMap`, run the matcher, return `SymbolTestPairing[]` (only those with ≥1 test).

## Story-mode integration (primary deliverable)

In `StorySlideshow.svelte`, for each changed file in the current step, compute `pairStepTests` (derived,
memoized per step). Beneath that file's `FileDiff`, render a **collapsed** affordance per paired symbol:

```
▸ Tested by `test_title`  (likely)        2 tests
```

- **Collapsed by default**, showing the symbol, a count ("2 tests"), and a confidence label —
  `referenced`-only pairings are labeled **"likely"**; `named` pairings are shown plainly.
- **Expand** → a read-only, syntax-highlighted snippet of THAT test block, sliced from the test file
  content (`contentsMap`). Render via a simple highlighted `<pre>` (reuse the existing highlight path where
  cheap; a plain `<pre>` with the lang class is acceptable for a read-only excerpt) — do NOT spin up a full
  `FileDiff` per snippet.
- Unobtrusive: sits below/beside the function diff, does not disturb per-slide comment/draft/viewed widgets,
  does not duplicate the existing file-level "Related tests" section (which stays).
- No pairing → nothing renders (no empty headers).

New small component `SymbolTestPairing.svelte` (or inline block) owns the collapsible + `<pre>` snippet.

## Deep-mode refinement (optional, must not regress #94 budgets)

When `aiDeepReview` is on, the existing `runStoryOrderTask` deep pass already has `search_code` / `read_file`.
The deterministic pairing stays the BASE (always runs). Deep mode is used only to **PRUNE** unsubstantiated
pairs / raise confidence — the prompt already tells the model to "search_code for a changed symbol to find
the test that exercises it … DROP a relatedTests entry you cannot substantiate." If wiring a verification of
symbol↔test cleanly fits the existing loop budget, do it; if it bloats the step-cap/budget work from #94,
keep deterministic pairing as the base and skip. Bump `PROMPT_VERSION` ONLY if the storyOrder prompt text
changes (note cache invalidation in the PR body if so). Default plan: **no prompt change, no PROMPT_VERSION
bump** — deterministic engine is the deliverable; deep mode prunes opportunistically only if free.

## Optional — Files-mode affordance (only if it fits cleanly)

A small "tested by" indicator on a changed function header in classic Files mode that peeks the paired test.
The engine is already provider-agnostic and LLM-free, so this is feasible — but it is NOT the primary
deliverable. If it doesn't drop in cleanly within scope, note it as a follow-up in the PR body.

## Analytics

If interaction tracking is added (e.g. expanding a paired test), add an allowlisted event carrying IDS ONLY
— e.g. `symbol_test_expanded: ['confidence']` (a `'named'|'referenced'` label) — never symbol names, titles,
file paths, or content. Mirror the privacy-decision comment style in `analytics.ts`.

## TDD

- **symbols.ts**: hunk-header enclosing symbol across langs (py/js/ts/go/java/rust/ruby); added-def lines per
  lang; negatives (comment-only, whitespace-only, ambiguous → nothing); line-range union correctness.
- **symbolTests.ts**: named-in-title → high confidence; referenced-only → lower; ambiguous/short → no pair;
  enclosing block-range capture (brace + indent); empty when no test content.
- **StorySlideshow**: paired test renders inline, collapsed by default, expand reveals snippet; no pair →
  nothing; existing per-slide comment/diff behavior unaffected.
- **deep-prune** (only if wired): a deterministic pair the tools contradict is dropped.
- **e2e**: extend `e2e/story-mode.spec.ts` — a changed function with a named test shows the inline "tested by"
  snippet on expand.

## Gates (ALL FOUR, capture playwright's own exit code)

`pnpm check && pnpm test && E2E_PORT=4687 pnpm exec playwright test && pnpm build`

Merge-seam warning: appended test files run individually afterward — re-merge main + rerun gates if it moves.

## Files

- NEW `src/lib/diff/symbols.ts` (+ `.test.ts`)
- NEW `src/lib/diff/symbolTests.ts` (+ `.test.ts`)
- NEW `src/components/SymbolTestPairing.svelte` (collapsible snippet)
- EDIT `src/components/StorySlideshow.svelte` (compute + render pairings; `.test.ts` extended)
- EDIT `e2e/story-mode.spec.ts` (named-test snippet)
- EDIT `src/lib/analytics/analytics.ts` (only if interaction tracking added)
- REUSE `langForFilename`, `isTestFile`, `patchLines` hunk-walk, `contentsMap`, FileDiff highlighting
