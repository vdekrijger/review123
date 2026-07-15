/**
 * src/lib/ai/tasks.ts — Prompt builders for the four AI tasks.
 *
 * Each builder returns { system: string; user: string } for use with llmComplete /
 * llmStream / llmJsonWithRepair. Prose quality is a human-checkpoint concern;
 * tests cover structural requirements only.
 *
 * PROMPT_VERSION is exported so the cache keying layer (Task 8) can invalidate
 * cached results when prompts change.
 */

import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { CoachCodeContext } from './coachContext'
import { STORY_LAYERS, STORY_MAX_STEPS, IMPACT_MAX_PER_GROUP, RISK_JUDGE_MAX_SNIPPETS } from './schemas'

// PROMPT_VERSION 25 (LLM risk judge): NEW single-pass task (riskJudgePrompt)
// that judges how much REVIEWER ATTENTION the change deserves — a 0–3 score,
// a one-line rationale, and up to 5 highlighted risky snippets — feeding the
// deterministic "Review effort" score (src/lib/risk) as one more factor
// ("AI judgment"). Adding a task changes the per-task cache universe, so bump
// to keep cache keys unambiguous; all existing task prompts are byte-identical.
// PROMPT_VERSION 23 (verify absence-claims): fail-closed floor against the
// absence/external-evidence false positive ("no test verifies X", "not called",
// "not handled/validated", "missing guard/index", "fails UNLESS a handler not in
// the diff rewrites it"). The shared generator calibration (ANTI_FATIGUE_RULES +
// SHARED_CALIBRATION) now forbids ASSERTING an absence about code outside the
// diff — it must be a question or "couldn't verify". The verifier framing
// (COMPREHENSIVE_VERIFY_FRAMING + buildVerifyPrompt) makes such claims
// REFUTE-by-default: the burden of proof is on the finding, and an absence the
// verifier can't positively confirm from the provided context yields refute/
// uncertain, never confirm. Both generator and verifier prompt bytes change, so
// bump to re-run cached reviews/verifications under the stronger framing.
// PROMPT_VERSION 22 (robust big-PR story): the story task's user payload is now
// a COMPACT structural representation — changed-file paths + per-file add/del
// stats + hunk HEADERS (the `@@ … @@` enclosing-symbol lines) + the import graph
// — instead of the full packed diff (`ctx.text`). Ordering never needed the
// line-level diff bodies, and the full diff overflowed the context window on big
// PRs (the failure this fixes). The story prompt CONTENT changes, so bump to
// recompute old cached story results under the compact input. Only the story
// task's user text changes; all other tasks are byte-identical.
// PROMPT_VERSION 21 (comprehensive verifier): per-lens verification is RETIRED.
// Every verifier now runs ONE comprehensive adversarial prompt weighing ALL five
// dimensions (correctness/security/performance/reproducibility/maintainability) at
// once, so a real defect under ANY dimension is caught instead of being judged
// through one narrow lens. Decorrelation comes from MODEL/PROVIDER diversity. The
// verify-prompt bytes change, so bump to re-run cached lens-based verifications.
// PROMPT_VERSION 20 (Plan P): unified model panel — verifiers now judge through
// diverse LENSES in the 'verify' path too (previously lenses applied only in the
// multi-generator 'generate' fusion path). The lensed verifier prompt differs from
// the plain adversarial prompt, so cached verify-mode results must re-run under the
// new framing. Behavior shift: single-generator + verifiers reviews now get lensed
// cross-verification. Bump invalidates Plan O cached skill/verdict verify results.
// PROMPT_VERSION 19 (Plan O): fusion v2 — multi-generator union + diverse verifier
// lenses. In 'generate' mode every ensemble model generates findings, the union
// is dedup-merged (findings carry `raisedBy`), and cross-confirm uses per-verifier
// lens prompts. The new generator-union + lens framings change cached-result shape
// AND the verify-prompt bytes (cache is per-prompt), so bump to invalidate Plan M/N
// cached skill/verdict results; 'verify'-mode users re-run once to identical output.
// PROMPT_VERSION 18 (Plan M): cross-model verification. Skill-review + verdict
// findings now carry an aggregated cross-model `verification` object (the new
// adversarial verify prompt lives in crossVerify.ts). The bump invalidates
// cached skill/verdict results so they re-run and verify under the new shape.
// PROMPT_VERSION 24 (change-impact / blast-radius): the diagram task's output
// shape changed from the flow-of-execution (GraphResult.flow, retired) to a
// change-impact view (GraphResult.impact) — the CHANGED symbols with their
// 1-hop callers (blast radius / affected) and callees (what they now use). The
// prompt now asks for changed symbols + callers + callees (NOT execution steps),
// instructs the deep mode to find REAL callers via find_references/search_code,
// and auto-suppresses (empty impact) on trivial/no-impact changes. The bump
// invalidates cached diagram results so retired flow payloads don't render; they
// lack `impact` and degrade to the suppressed "no notable call-graph impact" note.
// PROMPT_VERSION 17 (Plan L): the diagram task's output shape was a
// flow-of-execution (GraphResult.flow) — now retired.
export const PROMPT_VERSION = 25

// ---------------------------------------------------------------------------
// Shared anti-fatigue calibration (v10)
//
// Reviewer fatigue is the failure mode this block fights: verbose output,
// moot points, and redundant prose drain attention without adding value.
// Embedded (with task-appropriate adaptations) in every review-output prompt.
// ---------------------------------------------------------------------------

const ANTI_FATIGUE_RULES = `Anti-fatigue calibration (IMPORTANT — the goal is value-add, not mental drain):
- Evidence gate: only flag what you can cite (file and line in the diff) AND where you can \
articulate the concrete harm — what breaks, or who gets hurt. Never write "consider...", \
"might want to...", or "ensure that..." without a stated failure mode. If the harm depends \
on conditions not visible in the diff, say "couldn't verify" or stay silent — never assert.
- Absence/existence claims (CRITICAL — these are the #1 false-positive source): any claim that \
something ELSEWHERE does NOT exist — "no test verifies X", "X is not called anywhere", "this is \
not handled/validated", "missing a guard/index/handler", or "the assertion fails UNLESS some \
handler not visible in the diff rewrites it" — depends on code OUTSIDE the shown diff that you \
CANNOT see. A test, caller, handler, or index that exists in another file makes such a finding \
flat WRONG. Never ASSERT an absence as a defect. Phrase it as a QUESTION ("Does a test exercise \
fooBar?") or explicitly flag it "not visible in this diff — couldn't verify", and DROP it if you \
have no in-diff evidence. The diff not showing something is NOT evidence it is absent.
- Brevity format: each point is one sentence of WHAT + WHERE, one sentence of WHY IT MATTERS, \
and optionally a fix suggestion in at most one sentence or a small code block. Do not restate \
the diff, no praise padding, no methodology narration.
- Silence is a valid answer: finding nothing significant is a GOOD and expected outcome on \
clean code. Do not invent points to fill space.
- Severity honesty: nits are nits — label them "low"; never inflate severity to make a point \
sound important.`

// ---------------------------------------------------------------------------
// Assume-best-intent calibration (v13) — hotspot/attention discipline
//
// The attention task fights over-caution: it must treat the PR author as a
// competent engineer acting in good faith and flag only GENUINE, substantiated
// risk — never style, preference, or speculative "this could maybe break
// something". A clean, well-scoped PR is EXPECTED to produce zero hotspots.
// Embedded in BOTH the single-pass and deep attention prompts (the framing
// helps even without tools; deep mode adds verification on top).
// ---------------------------------------------------------------------------

const ASSUME_BEST_INTENT = `Assume best intent (IMPORTANT — calibration for hotspots):
- Treat the PR author as a competent engineer acting in good faith. A file is NOT a hotspot \
because it is large, or simply because it was touched — assume the author handled the obvious \
cases unless you have concrete evidence otherwise.
- Flag ONLY genuine risk: correctness bugs, blast radius / broad consumer impact, data or \
security exposure, or a broken contract (changed signature/behavior with callers left stale). \
Do NOT flag style, naming, preference, or "this could maybe break something" speculation \
without evidence.
- Evidence gate over alarm: if you cannot substantiate a risk from what you can see (or \
verify), DROP it — couldn't verify means stay silent, never assert. Severity must reflect \
substantiated harm, not worst-case imagination.
- An EMPTY hotspots list is the EXPECTED, GOOD outcome on a clean, well-scoped PR. Do not \
manufacture hotspots to look thorough — silence is the correct answer when nothing is \
genuinely risky.`

// ---------------------------------------------------------------------------
// summarizePrompt — streaming plain-text summary + reading order
// ---------------------------------------------------------------------------

/**
 * Build prompts for the summary task.
 *
 * System persona: code reviewer assistant.
 * Output: a concise plain-language summary of the PR, followed by an exact
 * "Suggested reading order:" section with one file path per line so the
 * consumer (parseReadingOrder) can parse it leniently.
 */
export function summarizePrompt(ctx: PackedContext): { system: string; user: string } {
  const system = `You are an expert code reviewer assistant. Your role is to help engineers \
understand pull requests quickly and accurately.

Given the code changes below, produce output in two parts:

1. A TL;DR — ONE tight paragraph (HARD CAP: 60 words maximum) stating what the PR does and \
why. This is the most important constraint: if your TL;DR exceeds 60 words, cut it down. Lead \
with the change, not the process.
2. After the TL;DR, optionally add bullet points for important details a reviewer should know. \
Keep the whole thing short — the TL;DR plus bullets should not exceed ~120 words.

Discipline (NON-NEGOTIABLE — these are the sentinel tests this output is graded against):
- No methodology narration (never describe how you analyzed — no "this PR appears to", \
"after reviewing", "the changes seem to").
- Do not restate the diff line-by-line — summarize intent, not mechanics.
- No praise padding — never call code "clean", "well-structured", "nicely done", or similar.
Every sentence must tell the reviewer something they need. Do NOT mention reading order \
anywhere in the prose.

At the very end of your response, after all prose, append a reading order block in EXACTLY \
this format (nothing after ===END===):

===READING-ORDER===
path/one
path/two
===END===

List one file path per line between the sentinels, in the order a reviewer should read them — \
most load-bearing or context-setting files first. Only include files that appear in the PR \
changes. Plain paths only — no bullets, numbers, or prefixes.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// attentionPrompt — JSON AttentionResult
// ---------------------------------------------------------------------------

/**
 * Build prompts for the attention/hotspot analysis task.
 *
 * Output must be JSON-only, matching AttentionResult exactly:
 *   {
 *     readingOrder: string[],
 *     hotspots: { path: string; reason: string; level: "high"|"medium"|"low" }[],
 *     testFlags: { path: string; note: string }[]
 *   }
 *
 * NOTE: test mapping is inferred from reading code, not measured coverage.
 */
export function attentionPrompt(
  ctx: PackedContext,
  options?: { deep?: boolean },
): { system: string; user: string } {
  // Deep-attention guidance (PROMPT_VERSION 13): when the agentic harness is on,
  // the model VERIFIES each candidate hotspot with the tools before reporting it
  // — read the changed file and its callers/dependencies (search_code/read_file)
  // to confirm the change is genuinely load-bearing rather than superficially
  // scary. Composes with (never replaces) the assume-best-intent + evidence
  // discipline below; withDeepReviewGuidance() adds the generic tool loop rules.
  const deepHotspotSection = options?.deep
    ? `\n\n## Deep mode — VERIFY each hotspot before reporting it (IMPORTANT)
You have verification tools (read_file / read_file_at_base / search_code). Before marking a \
file a hotspot, substantiate the risk:
- Read the changed file (read_file) to confirm the change is genuinely load-bearing — not \
  superficially scary.
- Find its callers/consumers (search_code for the changed symbol/file) and its dependencies \
  to gauge real blast radius. A completed refactor whose call sites are all updated is NOT a \
  hotspot.
- DROP any hotspot you cannot substantiate with what the tools show. An unverified suspicion \
  must not appear in your answer — not even hedged. Verified hotspots should reflect what you \
  confirmed, briefly.`
    : ''

  const system = `You are an expert code reviewer assistant. Analyze the pull request changes \
and respond with JSON ONLY — no explanation, no markdown, no code fences. Your response must \
be valid JSON that exactly matches this shape:

{
  "readingOrder": ["<file-path>", ...],
  "hotspots": [
    { "path": "<file-path>", "reason": "<concrete reason>", "level": "high" | "medium" | "low" }
  ],
  "testFlags": [
    { "path": "<file-path>", "note": "<why this file changed but no test touched it>" }
  ]
}

Field rules:
- readingOrder: all changed files ordered from most load-bearing / context-setting first.
- hotspots: files that carry the most risk or require the most reviewer attention. Provide \
  concrete, specific reasons referencing the actual change (not generic advice). \
  Each reason: one sentence of WHAT + WHERE plus one sentence of WHY IT MATTERS — no more. \
  level must be exactly one of: "high", "medium", "low" (lowercase strings — never a number \
  or percentage).
- Hard cap: at most 5 hotspots. Report the TOP hotspots ranked by severity × confidence. \
  If you cut lower-confidence candidates, append "(N lower-confidence observations omitted)" \
  to the LAST hotspot's reason — one line, no list of what was cut. An empty hotspots array \
  is a GOOD and expected outcome on clean, low-risk changes — do not invent hotspots.
- testFlags: files where behavior changed but no corresponding test file was added or modified. \
  IMPORTANT: test mapping is inferred by reading the code — it is NOT measured coverage data. \
  Label your notes accordingly. Omit the flag if a test file clearly covers the change.

${ANTI_FATIGUE_RULES}

Evidence discipline (IMPORTANT — apply to every hotspot and testFlag):
- Ground every claim in what you can SEE in the provided context. The diff shows ALL changes \
  in this PR — if a signature/type change comes with updated call sites in the same diff, \
  that is a completed refactor: do NOT flag hypothetical breakage.
- Only flag consumer/breakage risk when (a) a file in the context references the changed symbol \
  WITHOUT being updated, or (b) the "not analyzed" truncation list prevents verification — then \
  SAY THAT explicitly ("couldn't verify consumers outside the provided context") instead of \
  asserting breakage.
- Prefer neutral, factual phrasing over alarm. Severity must reflect evidence, not worst-case \
  speculation.

${ASSUME_BEST_INTENT}${deepHotspotSection}

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// diagramsPrompt — JSON GraphResult.impact (change-impact / blast-radius view)
// ---------------------------------------------------------------------------

// The few-shot marker is intentional so tests can assert its presence.
const FEW_SHOT_EXAMPLE = `/* FEW_SHOT_EXAMPLE_START */
Example: a PR changes the \`useSearch\` hook to debounce + cancel requests. It is referenced \
by the \`SearchBox\` component (a caller), and it now calls \`fetchResults\` and constructs an \
\`AbortController\` (callees).

Example valid output JSON (a change-impact view — note kind:"flow", empty before/after, and \
the impact's changed / callers / callees):
{
  "kind": "flow",
  "before": { "nodes": [], "edges": [] },
  "after": { "nodes": [], "edges": [] },
  "impact": {
    "changed": [
      { "symbol": "useSearch", "file": "src/search/useSearch.ts", "kind": "changed" }
    ],
    "callers": [
      { "symbol": "SearchBox", "file": "src/search/SearchBox.tsx" }
    ],
    "callees": [
      { "symbol": "fetchResults", "file": "src/search/api.ts" },
      { "symbol": "AbortController" }
    ]
  }
}
/* FEW_SHOT_EXAMPLE_END */`

/**
 * Cap on entries PER GROUP (changed / callers / callees) in the change-impact
 * view. Re-exported from schemas as the single source of truth — keeps the blast
 * radius tiny + legible and the structured output short enough to come back
 * intact. Exported for the prompt test.
 */
export const IMPACT_MAX_PER_GROUP_PROMPT = IMPACT_MAX_PER_GROUP

/**
 * Build prompts for the diagram generation task (change-impact / blast-radius).
 *
 * Output must be JSON-only, matching GraphResult with an `impact` field:
 *   {
 *     kind: "flow" | "module",
 *     before: Graph,   // emitted empty — legacy fields kept for the type
 *     after: Graph,
 *     impact: {
 *       changed:  { symbol, file?, kind: added|changed|removed }[],
 *       callers:  { symbol, file? }[],   // 1-hop upstream — the blast radius
 *       callees:  { symbol, file? }[]    // 1-hop downstream — what it now uses
 *     }
 *   }
 *
 * The model identifies the CHANGED symbols and their 1-hop callers (what
 * references them → what's affected / could break) and callees (what they now
 * call/depend on). It NEVER writes Mermaid syntax; the serializer
 * (lib/diagram/mermaid.ts impactToMermaid) converts the impact to Mermaid.
 *
 * Auto-suppress: when the change has no meaningful blast radius (pure
 * data/config/schema/CRUD/dependency change) the model returns an EMPTY impact
 * (changed: []) — the panel then shows an honest note instead of a forced graph.
 *
 * Deep variant (options.deep): the model USES THE TOOLS — find_references /
 * search_code — to find REAL callers across the repo (not guesses) and verify
 * the callees.
 */
export function diagramsPrompt(
  ctx: PackedContext,
  options?: { deep?: boolean },
): { system: string; user: string } {
  const importGraphSection = ctx.importGraph
    ? `\n\n## Module relationships (extracted from code)\n\n${ctx.importGraph}\n\nUse these REAL import/call relationships to infer the callers (which files reference the \
changed symbols) and callees (what the changed code depends on) — prefer entries you can ground \
in this graph over guesses.`
    : ''

  // Deep-impact guidance: when the agentic harness is on, the model finds REAL
  // callers across the repo with the tools instead of guessing from the diff.
  // withDeepReviewGuidance() adds the generic tool-loop discipline on top.
  const deepImpactSection = options?.deep
    ? `\n\n## Deep mode — find REAL callers with the tools (IMPORTANT)
You have verification tools (find_references / search_code / read_file). Find the true blast \
radius instead of guessing:
- For each CHANGED symbol, run find_references (or search_code for the symbol name) to find \
  what ACTUALLY references it across the repo — these are the real callers / blast radius. Do \
  NOT invent callers from the diff alone.
- read_file the changed symbol to verify the callees — what it now calls/constructs/depends on.
- DROP any caller or callee you cannot substantiate from what the tools show — a guessed edge \
  must not appear. A small, REAL blast radius beats a large speculative one.`
    : ''

  const system = `You are an expert code reviewer assistant. Map the CHANGE IMPACT (blast \
radius) of this pull request and respond with JSON ONLY — no explanation, no markdown, no code \
fences, and absolutely NO Mermaid syntax. Your response must be valid JSON matching this shape \
exactly:

{
  "kind": "flow" | "module",
  "before": { "nodes": [], "edges": [] },
  "after": { "nodes": [], "edges": [] },
  "impact": {
    "changed": [
      {
        "symbol": "<changed function/class/method/endpoint>",
        "file": "<path it lives in, optional>",
        "kind": "added" | "changed" | "removed"
      }
    ],
    "callers": [
      { "symbol": "<what references a changed symbol>", "file": "<path, optional>" }
    ],
    "callees": [
      { "symbol": "<what the changed code now calls/depends on>", "file": "<path, optional>" }
    ]
  }
}

What to produce — a TINY graph centred on the CHANGE (NOT the whole call chain):
- changed: the symbols (functions / classes / methods / endpoints) this diff ADDS, CHANGES, or \
  REMOVES. This is the centre of the blast radius. Mark each with "kind": "added" | "changed" | \
  "removed".
- callers: the 1-hop UPSTREAM neighbours — code that CALLS or REFERENCES the changed symbols. \
  This is the blast radius: what is AFFECTED and could break. Prefer FEWER, high-confidence \
  entries over padding.
- callees: the 1-hop DOWNSTREAM neighbours — what the changed code now CALLS or DEPENDS ON. \
  This is what the change reaches into.
- Each entry is a SYMBOL plus (optionally) the file it lives in. Do not include unchanged \
  plumbing that is neither a changed symbol nor a direct caller/callee — keep it tiny.

Choosing kind: keep "kind": "flow" (the legacy field is unused by this view). Use "module" \
only for a purely structural change with no symbols.

AUTO-SUPPRESS (IMPORTANT — do NOT fabricate a graph):
- If this PR has NO meaningful blast radius — a pure data/config/schema/dependency/styling \
  change, a CRUD/data tweak, generated output, or you genuinely cannot identify changed symbols \
  with notable callers/callees — return "impact": { "changed": [], "callers": [], "callees": [] } \
  (an EMPTY impact). The UI renders an honest "no notable call-graph impact" note. An empty \
  impact is a GOOD, expected outcome for such changes — never invent symbols or edges to fill \
  the diagram. OMIT trivial/no-impact changes rather than inventing a graph.

DO NOT write any Mermaid syntax. The downstream serializer converts your impact data to Mermaid.

Size constraints (IMPORTANT):
- At most ${IMPACT_MAX_PER_GROUP} entries in EACH of changed / callers / callees. If there are \
  more, keep the most important by blast radius. Prefer FEWER, high-confidence entries.
- Symbol names are bare identifiers (e.g. "fetchResults", not "calls fetchResults(query)"). \
  Emit NO explanatory prose anywhere — the output is JSON only.

${FEW_SHOT_EXAMPLE}${importGraphSection}${deepImpactSection}

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// testInsightPrompt — JSON TestInsight (D2)
// ---------------------------------------------------------------------------

/**
 * Build prompts for the test insight task.
 *
 * Output must be JSON-only, matching TestInsight:
 *   {
 *     covered: { behavior: string; test: string; file: string }[],
 *     gaps: string[]
 *   }
 *
 * Analyzes the CHANGED TEST FILES in the context and infers:
 * - covered: up to 10 plain-language behaviors with the test name + file
 * - gaps: behavior-changing files that lack corresponding test changes
 *
 * NOTE: coverage is inferred by reading code, not measured instrumentation.
 */
export function testInsightPrompt(ctx: PackedContext): { system: string; user: string } {
  const system = `You are an expert code reviewer assistant. Analyze the changed test files in \
the pull request and respond with JSON ONLY — no explanation, no markdown, no code fences. \
Your response must be valid JSON that exactly matches this shape:

{
  "covered": [
    { "behavior": "<plain-language description of what is tested>", "test": "<test name or describe block>", "file": "<test file path>" }
  ],
  "gaps": ["<plain-language description of a behavior that changed without test coverage>", ...]
}

Field rules (terse output — no prose intro, no narration anywhere):
- covered: list up to 10 behaviors covered by CHANGED test files in this PR. Each behavior is \
  a TERSE bullet, ≤12 words, plain language (not the raw test name); name the test function or \
  describe block and reference the file path. GROUP related cases into one behavior — never \
  list per-assertion. Infer from reading the test code.
- gaps: behaviors in behavior-changing (non-test) files with NO corresponding test change in \
  this PR. Each gap string MUST start with the file path followed by a colon, e.g. \
  "src/lib/cache.ts: cache expiry untested — stale entries served forever on regression". This \
  file path + colon prefix is required so the UI can group gaps by file. If the gap is not \
  specific to a single file, start with "General: " as the prefix. Each gap is ONE line naming \
  the untested behavior AND the concrete harm if it regresses — no padding. \
  Hard cap: at most 5 gaps, ranked by severity × confidence. If you cut lower-confidence \
  candidates, add ONE final gap "General: N lower-confidence observations omitted". \
  An empty gaps array is a GOOD and expected outcome when the changes are well tested — do \
  not invent gaps. \
  IMPORTANT: coverage is inferred by reading the code — it is NOT measured instrumentation data. \
  Do not speculate about behaviors not visible in the diff — if you couldn't verify coverage \
  from the provided context, stay silent rather than assert a gap.

${ANTI_FATIGUE_RULES}

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// coachPrompt — JSON CoachResult (D4)
// ---------------------------------------------------------------------------

/**
 * Options for coachPrompt (v9).
 */
export interface CoachPromptOptions {
  /**
   * The reviewer's currently-selected verdict. When provided, the prompt adds
   * a run-level verdictCoherence check: do the drafts collectively match it?
   */
  verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  /**
   * Packed PR diff context. When provided it is embedded as the payload's
   * prContext field so accuracy/grounded can be assessed against real evidence.
   */
  contextText?: string
  /**
   * Per-comment CODE context (v16): the actual code at each draft's anchor —
   * a hunk excerpt and (when available) a wider file window. Keyed by the same
   * `index` as the drafts. Embedded on each draft as `codeContext` so the
   * accuracy / grounded / specificity dimensions can VERIFY against real code
   * rather than defaulting to "cannot verify against the diff".
   */
  codeContexts?: CoachCodeContext[]
}

/**
 * Build prompts for the comment coach task.
 *
 * Output must be JSON-only, matching CoachResult:
 *   {
 *     reviews: CommentReview[],
 *     verdictCoherence?: { coherent, note }   // only requested when options.verdict given
 *   }
 *
 * Per review comment: clarity 1–5, actionable boolean, tone, optional anti-bias
 * question when the comment states preference as defect, optional suggestion,
 * accuracy assessment against the diff, duplicate detection, specificity
 * (concrete code vs vague vibes), grounded (claims verifiable in the provided
 * context), and a one-line reason per dimension — for passing AND failing grades.
 *
 * When prComments are provided (existing PR comment bodies, capped at 30,
 * truncated to 200ch each), the system prompt instructs duplicate detection.
 */
export function coachPrompt(
  drafts: { index: number; path: string; line: number; body: string }[],
  prComments?: string[],
  options?: CoachPromptOptions,
): { system: string; user: string } {
  const verdictShapeLine = options?.verdict
    ? `,
  "verdictCoherence": { "coherent": <true if the drafts collectively match the chosen verdict, false otherwise>, "note": "<one clearly-worded sentence>" }`
    : ''

  const verdictRules = options?.verdict
    ? `
- verdictCoherence: ONE assessment for the whole run (not per comment). The input's \
  chosenVerdict field is the verdict the reviewer is about to submit. Set coherent=false when \
  the drafts collectively do not match it — e.g. harsh or blocking comments alongside \
  "APPROVE", or unanimous praise alongside "REQUEST_CHANGES". note: one clearly-worded \
  sentence naming the mismatch (or, when coherent, confirming the match).`
    : ''

  const system = `You are a code review coach. Evaluate each draft review comment and respond \
with JSON ONLY — no explanation, no markdown, no code fences. Your response must be valid JSON \
that exactly matches this shape:

{
  "reviews": [
    {
      "index": <integer matching the draft index>,
      "clarity": <integer 1–5 where 1=very unclear, 5=crystal clear>,
      "actionable": <true if the comment tells the author what to do, false otherwise>,
      "tone": "ok" | "blunt" | "harsh",
      "biasQuestion": "<a single probing question to surface reviewer bias, or null>",
      "suggestion": "<a reworded version of the comment that is clearer or kinder, or null>",
      "accuracy": "consistent" | "questionable" | "contradicted",
      "accuracyNote": "<explanation of why the claim is contradicted by the diff, or null>",
      "duplicate": <true if this comment substantially repeats an existing PR comment, false otherwise>,
      "specificity": <true if the comment points at concrete code, false if it is vague>,
      "grounded": <true if every claim the comment makes is verifiable in the provided PR context, false otherwise>,
      "reasons": {
        "clarity": "<one short line>",
        "tone": "<one short line>",
        "actionable": "<one short line>",
        "accuracy": "<one short line>",
        "duplicate": "<one short line>",
        "specificity": "<one short line>",
        "grounded": "<one short line>"
      }
    }
  ]${verdictShapeLine}
}

Field rules:
- index: must exactly match the index from the input draft.
- clarity: integer 1–5 only. 1 = vague or confusing, 5 = clear, specific, and complete.
- actionable: true only if the comment contains a concrete ask or next step for the author.
- tone: "ok" = professional and constructive; "blunt" = abrupt but not hostile; \
  "harsh" = dismissive, condescending, or aggressive.
- biasQuestion: include ONLY when the comment states a preference as if it were a universal \
  defect (e.g. "this is wrong" when it is a style choice). Phrase as a brief, direct question \
  (e.g. "Is this a preference or a defect? Would you block a colleague's PR over this?"). \
  Otherwise null.
- suggestion: include ONLY when a reword would materially improve clarity or tone. \
  Keep it concise. Otherwise null.
- accuracy: assess whether the comment's claim matches what the diff actually shows \
  (the prContext field of the input, when present).
  - "consistent": the comment's claim is supported by the diff (this is the common case).
  - "questionable": the claim may be partially accurate or hard to verify from the diff alone.
  - "contradicted": the diff shows something that directly contradicts what the comment claims.
  When "contradicted", you MUST cite why in accuracyNote (e.g. "The diff shows X returns a \
  number, but the comment says it returns a string."). Be honest: "consistent" is the most \
  frequent outcome and requires no extra explanation.
- accuracyNote: required. A string explaining the contradiction when accuracy is "contradicted". \
  Must be null for "consistent" and "questionable" unless there is a specific note worth adding.
- duplicate: true ONLY when the draft comment substantially repeats an existing PR comment \
  listed in the input. Minor overlap in topic is not enough — the substance must be the same. \
  false otherwise (the common case).
- specificity: true only when the comment names the concrete code it concerns — identifiers, \
  function or file names, or specific lines. false when it gestures at vague qualities \
  ("this feels messy") without pointing at code.
- grounded: true when every factual claim in the comment can be verified against the provided \
  PR context. false when the comment asserts something not visible in the provided context.
- reasons: REQUIRED for every review. One short line (maximum ~12 words) per dimension \
  explaining the grade. Give a reason for passing grades as well as failing ones — e.g. \
  "names the exact function and line" for a passing specificity, or "matches the change \
  shown in the diff" for a consistent accuracy. Keys: clarity, tone, actionable, accuracy, \
  duplicate, specificity, grounded.${verdictRules}

Evidence discipline (IMPORTANT — apply to accuracy, grounded, and specificity):
- Each draft carries a "codeContext" object with the ACTUAL code at the comment's anchor: \
  "excerpt" is a hunk excerpt around path:line, and "fileWindow" (when present) is a wider \
  numbered window of the file's contents around that line. This is the comment's own code — \
  USE IT to verify the comment's claim. Do NOT default to "cannot verify against the diff" or \
  "claims not verifiable" when codeContext shows the relevant code.
- When codeContext is present, VERIFY accuracy and grounded against that concrete code: mark \
  "consistent"/grounded=true when the code supports the claim, "contradicted" when the code \
  shows the opposite. Only say "couldn't verify" (reasons.grounded / accuracy="questionable") \
  when the provided excerpt AND fileWindow genuinely do not contain the code the claim is about.
- specificity: the comment is specific when it names code that is actually present in the \
  provided codeContext (identifier, function, line) — check the excerpt/fileWindow before \
  grading it vague.
- Still ground every assessment only in what you can SEE (codeContext + prContext). Do not \
  speculate about code that is not shown.
- Prefer neutral, factual phrasing over alarm. Grades must reflect evidence, not worst-case \
  speculation.

Be brief and concrete. Do not pad. Do not include any text outside the JSON object.`

  // Cap prComments at 30, truncate each to 200 chars
  const capped = (prComments ?? []).slice(0, 30).map((c) => c.slice(0, 200))

  // Per-comment code context (v16), keyed by draft index.
  const codeByIndex = new Map<number, CoachCodeContext>()
  for (const cc of options?.codeContexts ?? []) codeByIndex.set(cc.index, cc)

  const payload: unknown = {
    drafts: drafts.map((d) => {
      const cc = codeByIndex.get(d.index)
      return {
        index: d.index,
        path: d.path,
        line: d.line,
        body: d.body,
        ...(cc
          ? {
              codeContext: {
                path: cc.path,
                line: cc.line,
                side: cc.side,
                excerpt: cc.excerpt,
                ...(cc.fileWindow ? { fileWindow: cc.fileWindow } : {}),
              },
            }
          : {}),
      }
    }),
    ...(capped.length > 0 ? { existingPrComments: capped } : {}),
    ...(options?.verdict ? { chosenVerdict: options.verdict } : {}),
    ...(options?.contextText ? { prContext: options.contextText } : {}),
  }

  return { system, user: JSON.stringify(payload, null, 2) }
}

// ---------------------------------------------------------------------------
// verdictPrompt — JSON VerdictResult (+ CI failures section when present)
// ---------------------------------------------------------------------------

/**
 * Build prompts for the behavior verdict task.
 *
 * Output must be JSON-only, matching VerdictResult:
 *   {
 *     level: "behavior-preserved" | "minor-changes" | "significant-changes",
 *     evidence: string[],
 *     notAnalyzed: string[]
 *   }
 *
 * When ci has failures, they are appended to the user prompt as a
 * "CI failures:" section (EC-15g).
 */
export function verdictPrompt(
  ctx: PackedContext,
  ci: CiSummary | null,
): { system: string; user: string } {
  const system = `You are an expert code reviewer assistant. Analyze the pull request changes \
and respond with JSON ONLY — no explanation, no markdown, no code fences. Your response must \
be valid JSON that exactly matches this shape:

{
  "level": "behavior-preserved" | "minor-changes" | "significant-changes",
  "evidence": ["<concrete bullet referencing file(s) and what changed>", ...],
  "notAnalyzed": ["<file or concern you could not assess>", ...]
}

Level definitions:
- "behavior-preserved": The changes are purely cosmetic, refactoring, or test-only. \
  Externally observable behavior is unchanged.
- "minor-changes": Small, low-risk behavior changes — e.g. a new optional field, a bug fix \
  that corrects unintentional behavior, a small new feature with limited blast radius.
- "significant-changes": Meaningful behavior changes — new APIs, changed semantics, removed \
  functionality, performance implications, security-relevant changes, or anything that could \
  break callers.

Evidence rules:
- Each evidence bullet must cite observed facts (file + what changed) rather than speculative \
  consequences. Do not write generic descriptions.
- Each evidence bullet is ONE sentence. Hard cap: at most 5 evidence bullets — report the \
  ones that most directly justify the chosen level; do not enumerate every file. \
  Do not restate the diff, no praise padding, no methodology narration.
- List anything you could not assess (missing context, files not provided, etc.) in notAnalyzed.

Evidence discipline (IMPORTANT — apply to every evidence item and level choice):
- Ground every claim in what you can SEE in the provided context. The diff shows ALL changes \
  in this PR — if a signature/type change comes with updated call sites in the same diff, \
  that is a completed refactor: do NOT flag hypothetical breakage.
- Only flag consumer/breakage risk when (a) a file in the context references the changed symbol \
  WITHOUT being updated, or (b) the "not analyzed" truncation list prevents verification — then \
  SAY THAT explicitly ("couldn't verify consumers outside the provided context") instead of \
  asserting breakage.
- Prefer neutral, factual phrasing over alarm. Severity must reflect evidence, not worst-case \
  speculation.

${ANTI_FATIGUE_RULES}

Do not include any text outside the JSON object.`

  // Build user prompt: context text + optional CI failures section (EC-15g)
  let userText = ctx.text

  if (ci !== null && ci.failures.length > 0) {
    const ciLines: string[] = ['\n\nCI failures:']
    for (const failure of ci.failures) {
      ciLines.push(`- ${failure.name}`)
      for (const annotation of failure.annotations) {
        ciLines.push(`  - ${annotation}`)
      }
    }
    userText = userText + ciLines.join('\n')
  }

  return { system, user: userText }
}

// ---------------------------------------------------------------------------
// riskJudgePrompt — JSON RiskJudgeResult (LLM risk judge, PROMPT_VERSION 25)
// ---------------------------------------------------------------------------

/**
 * Build prompts for the risk-judge task.
 *
 * Output must be JSON-only, matching RiskJudgeResult:
 *   {
 *     score: 0 | 1 | 2 | 3,
 *     rationale: string   (one line, ≤140 chars),
 *     snippets: [{ path, line?, reason }]   (≤5 entries)
 *   }
 *
 * Framing contract (mirrors src/lib/risk): the judge estimates the REVIEW
 * ATTENTION the change deserves — never defect probability or code quality.
 * Its score feeds the deterministic review-effort breakdown as ONE factor.
 */
export function riskJudgePrompt(ctx: PackedContext): { system: string; user: string } {
  const system = `You are an expert change-risk assessor for code review triage. Judge how much \
REVIEWER ATTENTION the pull request below deserves — NOT defect probability, NOT code quality, \
NOT whether the author did a good job. Respond with JSON ONLY — no explanation, no markdown, no \
code fences. Your response must be valid JSON that exactly matches this shape:

{
  "score": 0 | 1 | 2 | 3,
  "rationale": "<one line justifying the score>",
  "snippets": [
    { "path": "<file-path>", "line": <line number, optional>, "reason": "<why a reviewer should slow down here>" }
  ]
}

Score definitions (review attention required):
- 0: routine — a careful skim suffices (docs, comments, config toggles, mechanical renames with \
  all call sites updated in this diff).
- 1: standard — an ordinary read; localized changes with clear behavior and limited reach.
- 2: elevated — at least one part warrants a slow, careful read (see the signals below).
- 3: maximal — the change hinges on subtle correctness or has broad behavioral reach; a reviewer \
  should reserve focused time and read line by line.

Weigh these signals — attention drivers, not line counts:
- Behavioral blast radius: changed semantics of widely used functions/APIs/contracts, data shapes, \
  serialization, persisted state, or anything callers rely on.
- Subtle-correctness hazards: concurrency and async ordering, error/exception paths, retries, \
  boundary conditions (off-by-one, empty/null, overflow, timezone), caching/invalidation, and \
  security-adjacent logic (auth, input validation, secrets, injection surfaces).
- Plausible-but-wrong API usage: code that reads naturally but misuses an API's contract \
  (ignored return values, wrong argument order/units, misunderstood defaults, misused options).
Size alone does not raise the score: a large mechanical rename can be 0; a one-line mutex or \
boundary change can be 3.

Output rules:
- rationale: ONE line, at most 140 characters, stating the dominant reason for the score.
- snippets: ONLY places where a reviewer should genuinely slow down — cite the file path (and \
  line in the NEW file when you can) plus a concrete reason. Prefer FEWER, higher-signal \
  snippets over coverage. Hard cap: ${RISK_JUDGE_MAX_SNIPPETS}. An EMPTY snippets array is the \
  expected, GOOD outcome on a routine change — do not invent risk to look thorough.

${ANTI_FATIGUE_RULES}

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// alternativesPrompt — JSON AlternativesResult (Plan F)
// ---------------------------------------------------------------------------

/**
 * Build prompts for the alternatives task.
 *
 * Output must be JSON-only, matching AlternativesResult:
 *   {
 *     problem: string,
 *     alternatives: Alternative[]   (≤3 entries)
 *   }
 *
 * Per alternative:
 *   { approach, tradeoffs, assessment, rationale }
 *
 * assessment must be exactly one of:
 *   "pr-is-better" | "comparable" | "alternative-is-better" | "different-goals"
 *
 * Intellectual honesty rule: "pr-is-better" is always a valid answer.
 * Do not invent spurious alternatives when the approach is obvious or forced.
 */
export function alternativesPrompt(ctx: PackedContext): { system: string; user: string } {
  const system = `You are an expert code reviewer assistant. Analyze the pull request changes \
and respond with JSON ONLY — no explanation, no markdown, no code fences. Your response must \
be valid JSON that exactly matches this shape:

{
  "problem": "<one-sentence statement of the core problem this PR is solving>",
  "alternatives": [
    {
      "approach": "<description of a genuinely different approach to the same problem>",
      "tradeoffs": "<honest tradeoffs vs the PR's approach — what it gains and what it costs>",
      "assessment": "pr-is-better" | "comparable" | "alternative-is-better" | "different-goals",
      "rationale": "<one sentence explaining your assessment>"
    }
  ]
}

Field rules:
- problem: one concise sentence describing the core problem the PR is addressing. Be specific \
  to the actual change — not a generic description.
- alternatives: up to 3 genuinely different approaches to the same problem. Do not list \
  variations of the PR's approach (e.g. "rename the variable differently") — only include \
  alternatives that represent a meaningfully different design or strategy.
  - If the PR's approach is the obvious or only reasonable solution, return an empty array \
    or a single alternative with assessment "pr-is-better".
- approach: name the alternative, then describe it in AT MOST ONE sentence — specific enough \
  that a developer could act on it. No multi-paragraph cards, no methodology narration.
- tradeoffs: AT MOST ONE sentence comparing honestly against the PR — exactly one gain and one \
  cost (e.g. "Gains better test isolation but adds boilerplate"). Do not restate the PR's \
  approach.
- assessment: exactly one of the four enum values:
  - "pr-is-better": the PR's approach is the better choice for this codebase/context
  - "comparable": both approaches have similar merit; team preference should decide
  - "alternative-is-better": this alternative would be meaningfully better
  - "different-goals": this alternative solves a related but different problem
- rationale: a single sentence explaining your assessment choice.

Intellectual honesty: "pr-is-better" is a perfectly valid and often correct answer. Do not \
invent alternatives just to fill the list. Fewer high-quality alternatives are better than \
more low-quality ones. Maximum 3 alternatives total. An empty alternatives array is a GOOD \
and expected outcome when the PR's approach is the natural choice — silence is a valid answer.

${ANTI_FATIGUE_RULES}

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// storyOrderPrompt — JSON StoryOrderResult (Plan H — Story mode)
// ---------------------------------------------------------------------------

/**
 * Build prompts for the story-order task.
 *
 * Output must be JSON-only, matching StoryOrderResult:
 *   { steps: StoryStep[] }   // steps already ordered (index 0..n-1)
 *
 * Per step: { index, files[], caption, layer, relatedTests[] }.
 *
 * Classifies each changed file (or coherent group of files) into one of the
 * STORY_LAYERS, then emits an ORDERED narrative sequence so a reviewer can walk
 * the PR as a story: data model → API/service → business logic → tests → UI,
 * with foundational/config primitives woven in JUST BEFORE the first step that
 * depends on them. Each step pairs its code with the related test file(s) that
 * cover it (grounded in the import graph + the changed test files) so the
 * reviewer can sense-check inline.
 *
 * Deep variant (options.deep): when the agentic harness is on, the model
 * VERIFIES ordering/test-pairing by reading dependencies/imports with the tools
 * before committing to the sequence. withDeepReviewGuidance() adds the generic
 * tool-loop discipline; this section adds the story-specific verification.
 *
 * COMPACT input (PROMPT_VERSION 22): the user payload is a structural summary —
 * changed-file paths + per-file add/del stats + hunk HEADERS + the import graph
 * — NOT the full diff (`ctx.text`). Ordering doesn't need the line-level bodies,
 * and the full diff overflowed big-PR context windows. See buildCompactStoryInput.
 */

// Byte budget for the compact story input. The structural summary is tiny per
// file, but a 5k-file PR could still be large; cap so the story prompt always
// fits. When truncated we keep the FIRST files (input order) + note the cut so
// the model knows coverage is partial (the deterministic fallback still covers
// 100% from the full prFilenames list).
const COMPACT_STORY_BYTE_BUDGET = 60_000
const COMPACT_STORY_MAX_FILES = 600

function buildCompactStoryInput(ctx: PackedContext): string {
  const summaries = ctx.storyFiles
  // Backward-compat: if a caller supplies a PackedContext without storyFiles
  // (older pack), fall back to the full text so the task still runs.
  if (!summaries) return ctx.text

  const lines: string[] = ['## Changed files (path · +adds/-dels · hunk headers)']
  let truncated = false
  let used = 0
  let shown = 0
  for (const f of summaries) {
    if (shown >= COMPACT_STORY_MAX_FILES) {
      truncated = true
      break
    }
    const headers = f.hunkHeaders.length > 0 ? ` :: ${f.hunkHeaders.join(' ')}` : ''
    const line = `- ${f.path} · +${f.additions}/-${f.deletions}${headers}`
    if (used + line.length > COMPACT_STORY_BYTE_BUDGET) {
      truncated = true
      break
    }
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (truncated) {
    lines.push(
      `- … (${summaries.length - shown} more changed files omitted to fit; ` +
        `group the shown layers and the remaining files will be swept into the walkthrough)`,
    )
  }
  return lines.join('\n')
}

export function storyOrderPrompt(
  ctx: PackedContext,
  options?: { deep?: boolean },
): { system: string; user: string } {
  const layerList = STORY_LAYERS.join(', ')

  const importGraphSection = ctx.importGraph
    ? `\n\n## Module relationships (extracted from code)\n\n${ctx.importGraph}\n\nUse these REAL import relationships to (a) order steps so a primitive precedes its first \
consumer and (b) pair each step's code with the test file(s) that import/cover it.`
    : ''

  const deepStorySection = options?.deep
    ? `\n\n## Deep mode — VERIFY ordering and test-pairing before committing (IMPORTANT)
You have verification tools (read_file / read_file_at_base / search_code). Before finalizing the \
sequence:
- Read a changed file's imports (read_file) to confirm which layer it truly belongs to and what it \
  depends on — order dependencies before dependents.
- search_code for a changed symbol to find the test file that actually exercises it, so relatedTests \
  reflects real coverage rather than a name guess.
- DROP a relatedTests entry you cannot substantiate. Keep the sequence honest to what the tools show.`
    : ''

  const system = `You are an expert code reviewer assistant. Turn this pull request into a guided \
NARRATIVE walkthrough — a sequence of steps a reviewer reads in order to understand the change as a \
story. Respond with JSON ONLY — no explanation, no markdown, no code fences. Your response must be \
valid JSON that exactly matches this shape:

{
  "steps": [
    {
      "index": <0-based integer position in reading order>,
      "files": ["<file-path>", ...],
      "caption": "<one-line narrative sentence describing this step>",
      "layer": "data" | "api" | "logic" | "config" | "tests" | "ui" | "foundational",
      "relatedTests": ["<test-file-path>", ...]
    }
  ]
}

Layer taxonomy (use EXACTLY these ids): ${layerList}.
- data: data model, migration, schema, persistence.
- api: API surface, service, transport, routing, network.
- logic: business logic, core algorithms, orchestration.
- config: validation, configuration, build/setup wiring.
- tests: test files.
- ui: UI / frontend / components / styling.
- foundational: shared primitives/utilities depended on by many other layers.

Ordering rule (the sequence is the whole point):
- Emit steps in CHRONOLOGICAL / LOGICAL reading order: data → api → logic → tests → ui.
- Weave config/foundational steps in JUST BEFORE the first step that depends on them (a shared \
  primitive precedes its first consumer; a migration precedes the API that reads the new column).
- Group a layer's steps together; within a layer, most load-bearing first.
- index must be the 0-based position in the FINAL order (steps[0].index = 0, steps[1].index = 1, …).
- GENERATED files (lockfiles, *.min.*, *.map, protobuf/*.pb.* stubs, *.generated.*, snapshot \
  *.snap files, anything under a generated/ dir) are the LOWEST priority: place any step covering \
  them LAST, after the narrative. Never open the story with generated output.

Field rules:
- files: one or more file paths that THIS step covers. Group files into a single step ONLY when they \
  form one coherent change (e.g. a migration + its model). Every path must appear in the PR changes; \
  do not invent paths. A pure test file belongs in its OWN step with layer "tests" unless it is the \
  natural sense-check companion of a code step (then list it in that step's relatedTests instead).
- caption: ONE sentence, plain language, describing what changes here and why it matters in the \
  story (e.g. "The schema gains a \`provider\` column so reviews can target GitLab too."). No \
  methodology narration, no praise padding, no restating the diff line-by-line.
- layer: exactly one of the ids above.
- relatedTests: test file paths (from the PR) that exercise THIS step's code — for inline \
  sense-checking. Empty array when no test in the PR covers it. Ground pairings in the import graph \
  and the test files touched by this PR; do not guess. relatedTests may ONLY list test files that do \
  NOT already appear as a primary \`files\` entry in ANY step.

NO OVERLAP (CRITICAL — adjacent steps must never show the same code):
- Every changed non-test file appears in EXACTLY ONE step's \`files\`. A file in one step's \`files\` \
  MUST NOT also appear in another step's \`files\`, nor in any step's relatedTests. No file is repeated \
  across the walkthrough.

Bound the output (IMPORTANT for large PRs):
- Emit AT MOST ${STORY_MAX_STEPS} steps. Never one step per file. On a large PR, GROUP AGGRESSIVELY: \
  combine files of the same layer/feature into a single coherent step so the whole walkthrough stays \
  within the cap.
- If there are many files, PRIORITIZE the most important ones and group the rest into broader steps — \
  but still cover every changed non-test file in some step (as \`files\` or relatedTests) where it fits \
  within the cap. A tight, bounded story beats an exhaustive one that gets truncated.

Keep the walkthrough tight: prefer FEWER, coherent steps over one-step-per-file.
${importGraphSection}${deepStorySection}

Do not include any text outside the JSON object.`

  // Compact structural input (paths + stats + hunk headers) — NOT the full diff.
  // The import graph is woven into the system prompt above (importGraphSection).
  return { system, user: buildCompactStoryInput(ctx) }
}

// ---------------------------------------------------------------------------
// askPrompt — free-form Q&A grounded in PR context (Ask AI feature)
// ---------------------------------------------------------------------------

/**
 * Optional line-level focus for askPrompt.
 *
 * When provided, the system prompt is augmented to direct the AI to address
 * the specific change at path:line first, then broader context.
 * The excerpt is the hunk snippet around that line (e.g. ±6 lines from
 * excerptAround() in src/lib/diff/excerpt.ts).
 */
export interface AskFocus {
  path: string
  line: number
  excerpt: string
  /**
   * Optional reviewer finding text the question is a follow-up about (Ask AI on
   * a finding card). When present, askPrompt adds a clause directing the model
   * to engage THIS finding's reasoning/tradeoffs directly, grounded in the
   * excerpt. Absent for the plain line-comment Ask AI (no behavior change).
   */
  finding?: string
}

/**
 * Build prompts for the ask task.
 *
 * System persona: senior engineer code explainer, grounded ONLY in the provided
 * context. Answers "I can't see that in the provided context" rather than inventing.
 *
 * User prompt: ctx.text + last ≤3 Q/A pairs from history + the new question.
 *
 * When focus is provided, the system prompt adds a line-level direction clause
 * and the excerpt is included in the user prompt before the question.
 *
 * Contract (inline widget Ask AI): the user's typed comment text IS the
 * question — the system prompt directs the model to answer it directly and to
 * be VERY concise (2-4 sentences unless code is needed).
 *
 * NOTE: No PROMPT_VERSION bump needed — answers are never cached.
 */
export function askPrompt(
  ctx: PackedContext,
  history: { q: string; a: string }[],
  question: string,
  focus?: AskFocus,
): { system: string; user: string } {
  let system = `You are a senior engineer code explainer. Your job is to answer questions \
about a pull request based ONLY on the provided context. You must be grounded only in the \
provided context — do not invent or assume information that is not visible in the context. \
If a question asks about something you cannot see in the provided context, respond: \
"I can't see that in the provided context." Keep answers concise and specific.

Answer the user's question directly — the text after "Question:" is the user's own words and \
is exactly what they want answered; do not substitute a generic explanation of the change. \
Be VERY concise: 2-4 sentences, unless code is needed to illustrate the answer.`

  if (focus) {
    system += `\n\nThe question concerns the specific change at ${focus.path}:${focus.line}. \
Address THIS location first, then broader context only if relevant.`
  }

  if (focus?.finding) {
    system += `\n\nA reviewer left this finding about the focused code: "${focus.finding}". \
The user's question is a follow-up about that finding — engage its reasoning and tradeoffs \
directly (e.g. when it does/doesn't matter, rough thresholds), grounded in the excerpt; say \
so if the excerpt doesn't contain enough to answer.`
  }

  // Take last ≤3 Q/A pairs
  const recentHistory = history.slice(-3)

  const parts: string[] = [ctx.text]

  if (focus) {
    parts.push(
      `\n\nFocused location: ${focus.path}:${focus.line}\nCode excerpt:\n\`\`\`\n${focus.excerpt}\n\`\`\``,
    )
  }

  if (recentHistory.length > 0) {
    parts.push('\n\nPrevious questions and answers:')
    for (const { q, a } of recentHistory) {
      parts.push(`\nQ: ${q}\nA: ${a}`)
    }
  }

  parts.push(`\n\nQuestion: ${question}`)

  return { system, user: parts.join('') }
}

// ---------------------------------------------------------------------------
// skillReviewPrompt — JSON SkillReviewResult per reviewer persona
// ---------------------------------------------------------------------------

/**
 * Build prompts for a skill (persona) review task.
 *
 * system: "You are the reviewer persona defined below" + the skill content
 *         fenced; instructs JSON-only output matching SkillReviewResult.
 * user:   ctx.text (the packed PR context)
 *
 * existingComments: bodies of comments already on the PR (capped at 30,
 * truncated to 200ch each — same policy as coachPrompt). The persona is
 * instructed never to repeat a point an existing comment already makes.
 *
 * v10 anti-fatigue calibration: hard cap of 5 findings (the schema's 15 cap
 * remains as a parse-side backstop only), evidence gate, brevity format,
 * silence-is-valid, severity honesty.
 *
 * NOTE: The orchestrator's cache key combines PROMPT_VERSION with a
 * content-hash (djb2 of skill content), so both prompt and skill edits
 * invalidate the cache.
 */
export function skillReviewPrompt(
  ctx: PackedContext,
  skill: { name: string; content: string },
  existingComments?: string[],
): { system: string; user: string } {
  // Same cap/truncation policy as coachPrompt: ≤30 comments, ≤200 chars each.
  const cappedComments = (existingComments ?? []).slice(0, 30).map((c) => c.slice(0, 200))

  const existingCommentsSection =
    cappedComments.length > 0
      ? `

Existing PR comments (already made by humans or other reviewers):
${cappedComments.map((c) => `- ${c.replace(/\n/g, ' ')}`).join('\n')}

Never repeat a point an existing comment already makes — duplicated feedback wastes the \
author's attention. If your only candidate findings are already covered above, return an \
empty findings array.`
      : ''

  const system = `You are the reviewer persona defined below. Your job is to review the pull \
request in the user message and apply ONLY this persona's priorities, style, and standards. \
Do not adopt any other reviewer perspective.

Persona name: ${skill.name}

Persona definition:
\`\`\`
${skill.content}
\`\`\`

Your findings must be:
- Concrete and anchored to actual files and lines visible in the PR context.
- Hard cap: at most 5 findings total (≤5). Report the TOP findings ranked by \
  severity × confidence. If you cut lower-confidence candidates, append \
  "(N lower-confidence observations omitted)" to the LAST finding's body — one line, \
  no list of what was cut.
- Severity must be rated according to THIS persona's own standards: "high", "medium", or "low".

${ANTI_FATIGUE_RULES}

Silence from this lens: an empty findings array means "No significant issues from this lens." \
That is a GOOD and expected outcome on clean code — never pad the list to look thorough.${existingCommentsSection}

Respond with JSON ONLY — no explanation, no markdown outside the JSON, no code fences. \
Your response must be valid JSON that exactly matches this shape:

{
  "skillName": "${skill.name}",
  "findings": [
    {
      "path": "<file path from the PR context>",
      "line": <line number as integer, or null for file-level findings>,
      "severity": "high" | "medium" | "low",
      "body": "<concrete finding text>"
    }
  ]
}

Field rules:
- skillName: must be exactly "${skill.name}".
- findings: an array of 0–5 findings. Only include findings for files that appear in the PR changes.
- path: must be a file path that actually appears in the PR diff context. Do not invent paths.
- line: the specific line number (integer) the finding applies to, or null if it is a file-level concern.
- severity: exactly one of "high", "medium", "low" — rated by this persona's own standards. \
  Nits are nits: label them "low"; never inflate.
- body: one sentence of WHAT + WHERE, one sentence of WHY IT MATTERS (the concrete harm), \
  optionally a fix suggestion in at most one sentence or a small code block.

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// withDeepReviewGuidance — agentic deep review (Plan G part 2)
// ---------------------------------------------------------------------------

/**
 * Append the deep-review tool discipline to a task's system prompt.
 *
 * Applied ONLY when deep review is enabled (verdict + skill-review tasks) —
 * single-pass prompts are byte-identical to today. Composes with (never
 * replaces) the existing evidence-discipline/calibration blocks above: the
 * same spirit — claims must be grounded — but now the model can GROUND them
 * itself with tools instead of hedging.
 *
 * No PROMPT_VERSION bump: deep-review results are cached under keys that
 * carry a '|deep' marker, so deep and single-pass outputs never collide.
 */
export function withDeepReviewGuidance(system: string, toolNames: string[]): string {
  return `${system}

Deep review mode (IMPORTANT — you have verification tools: ${toolNames.join(', ')}):
- First, form hypotheses from the diff: every claim that depends on code you cannot \
  see (callers of a changed symbol, the rest of a partially-shown file, pre-PR behavior, \
  WHICH test actually covers a behavior, whether an alternative approach is genuinely \
  feasible or better) is a HYPOTHESIS, not a fact.
- USE THE TOOLS to verify each hypothesis before asserting it. Read the file, check the \
  base version, or search for the symbol/test — whichever settles the question. Do not \
  claim a test covers a behavior, a gap exists, or an alternative is better/feasible until \
  the tools confirm it.
- DROP anything you could not verify. An unverified claim must not appear in your \
  answer — not even hedged. If a tool fails (file missing, search unavailable), either \
  verify another way or drop the point.
- Verified claims should cite what you confirmed (file + what you saw), briefly. \
  Severity/assessment must reflect verified evidence, not worst-case speculation.
- Budget: at most 8 tool calls and 150 KB of fetched content per run. Spend them on the \
  highest-impact suspicions first. When the budget is exhausted, answer from what you \
  have verified.
- Your FINAL message must contain ONLY the JSON object in the required shape — no tool \
  commentary.`
}

// ---------------------------------------------------------------------------
// parseReadingOrder — extract file paths from summary text
// ---------------------------------------------------------------------------

/**
 * Extract the reading-order file list from a plain-text summary response.
 *
 * Looks for a line containing "Suggested reading order:" (case-insensitive,
 * tolerant of surrounding whitespace), then collects subsequent non-blank
 * lines, stripping common prefixes: leading bullets (- * •), numbers
 * (1. 2) ), backticks, and surrounding whitespace.
 *
 * Returns [] when the heading is absent.
 *
 * EC-12e (consumer concern): paths not in the PR are filtered by the
 * consuming component, not here.
 */
export function parseReadingOrder(summaryText: string): string[] {
  const lines = summaryText.split('\n')

  // --- Primary: sentinel block ===READING-ORDER=== … ===END=== ---
  const sentinelStart = lines.findIndex((l) => l.trim() === '===READING-ORDER===')
  if (sentinelStart !== -1) {
    const paths: string[] = []
    for (let i = sentinelStart + 1; i < lines.length; i++) {
      const raw = lines[i].trim()
      if (raw === '===END===') break
      if (raw.length > 0) paths.push(raw)
    }
    return paths
  }

  // --- Fallback: legacy "Suggested reading order:" heading (cached v2 outputs) ---
  let headingIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (/suggested reading order\s*:/i.test(lines[i])) {
      headingIndex = i
      break
    }
  }

  if (headingIndex === -1) return []

  const paths: string[] = []
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '') break
    const cleaned = raw
      .trim()
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^`+|`+$/g, '')
      .trim()
    if (cleaned.length > 0) paths.push(cleaned)
  }

  return paths
}

// ---------------------------------------------------------------------------
// stripReadingOrder — remove the "Suggested reading order:" block from display
// ---------------------------------------------------------------------------

/**
 * Strip the reading-order block from a summary string, returning only prose.
 *
 * Three strategies (applied in order, first match wins):
 *  1. Sentinel block: ===READING-ORDER=== … ===END=== (v3 contract)
 *  2. Legacy heading: "Suggested reading order:" + list block (cached v2 fallback)
 *  3. Defensive: strip trailing run of ≥3 consecutive bare file-path lines
 *     (catches prompt-noncompliant models)
 *
 * A "bare file-path line" matches: ^[\w@./-]+\.[\w]+$ or ^[\w@./-]+/[\w@./-]+$
 */
export function stripReadingOrder(summaryText: string): string {
  const lines = summaryText.split('\n')

  // --- Strategy 1: sentinel block ---
  const sentinelStart = lines.findIndex((l) => l.trim() === '===READING-ORDER===')
  if (sentinelStart !== -1) {
    const sentinelEnd = lines.findIndex((l, i) => i > sentinelStart && l.trim() === '===END===')
    const cutEnd = sentinelEnd !== -1 ? sentinelEnd + 1 : lines.length
    const result = [...lines.slice(0, sentinelStart), ...lines.slice(cutEnd)]
    return result.join('\n').trim()
  }

  // --- Strategy 2: legacy heading ---
  let headingIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (/suggested reading order\s*:/i.test(lines[i])) {
      headingIndex = i
      break
    }
  }

  if (headingIndex !== -1) {
    let listEnd = headingIndex + 1
    while (listEnd < lines.length && lines[listEnd].trim() !== '') {
      listEnd++
    }
    const before = lines.slice(0, headingIndex)
    const after = lines.slice(listEnd)
    return [...before, ...after].join('\n').trim()
  }

  // --- Strategy 3: defensive trailing bare-path-run (≥3 lines) ---
  const barePathRe = /^[\w@.\-/]+\.[\w]+$|^[\w@.\-/]+\/[\w@.\-/]+$/
  let trailStart = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue // skip blank lines in tail
    if (barePathRe.test(line)) {
      trailStart = i
    } else {
      break
    }
  }
  const trailingCount = lines.length - trailStart
  if (trailingCount >= 3) {
    return lines.slice(0, trailStart).join('\n').trim()
  }

  return summaryText
}
