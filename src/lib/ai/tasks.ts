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

export const PROMPT_VERSION = 12

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
- Brevity format: each point is one sentence of WHAT + WHERE, one sentence of WHY IT MATTERS, \
and optionally a fix suggestion in at most one sentence or a small code block. Do not restate \
the diff, no praise padding, no methodology narration.
- Silence is a valid answer: finding nothing significant is a GOOD and expected outcome on \
clean code. Do not invent points to fill space.
- Severity honesty: nits are nits — label them "low"; never inflate severity to make a point \
sound important.`

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
export function attentionPrompt(ctx: PackedContext): { system: string; user: string } {
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

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// diagramsPrompt — JSON GraphResult with few-shot example
// ---------------------------------------------------------------------------

// The few-shot marker is intentional so tests can assert its presence.
// DIAGRAMS_FEW_SHOT_MARKER is not exported but the string appears verbatim.
const FEW_SHOT_EXAMPLE = `/* FEW_SHOT_EXAMPLE_START */
Example input sketch (three files touched: api.ts, router.ts, handler.ts — handler.ts is new):

Example valid output JSON (note status fields on every node and edge in changeMap):
{
  "kind": "flow",
  "before": {
    "nodes": [
      { "id": "api", "label": "api.ts" },
      { "id": "router", "label": "router.ts" }
    ],
    "edges": [
      { "from": "router", "to": "api", "label": "calls" }
    ]
  },
  "after": {
    "nodes": [
      { "id": "api", "label": "api.ts" },
      { "id": "router", "label": "router.ts" },
      { "id": "handler", "label": "handler.ts" }
    ],
    "edges": [
      { "from": "router", "to": "handler", "label": "calls" },
      { "from": "handler", "to": "api", "label": "delegates" }
    ]
  },
  "changeMap": {
    "nodes": [
      { "id": "api", "label": "api.ts", "status": "unchanged" },
      { "id": "router", "label": "router.ts", "status": "changed" },
      { "id": "handler", "label": "handler.ts", "status": "added" }
    ],
    "edges": [
      { "from": "router", "to": "api", "label": "calls", "status": "removed" },
      { "from": "router", "to": "handler", "label": "calls", "status": "added" },
      { "from": "handler", "to": "api", "label": "delegates", "status": "added" }
    ]
  }
}
/* FEW_SHOT_EXAMPLE_END */`

/**
 * Build prompts for the diagram generation task.
 *
 * Output must be JSON-only, matching GraphResult:
 *   {
 *     kind: "flow" | "module",
 *     before: Graph,
 *     after: Graph
 *   }
 *
 * The model NEVER writes Mermaid syntax — it emits graph data that the
 * serializer (Task 7 lib/diagram/mermaid.ts) converts to Mermaid.
 *
 * A compact few-shot example is embedded in the system prompt so the model
 * learns the exact shape by demonstration.
 */
/**
 * Cap on `context` (one-hop neighborhood) nodes in deep-diagram mode. The
 * model is told to keep the most-connected neighbors and drop the rest so a
 * large neighborhood cannot explode the diagram. Exported for the prompt test.
 */
export const DEEP_DIAGRAM_CONTEXT_NODE_CAP = 8

export function diagramsPrompt(
  ctx: PackedContext,
  options?: { deep?: boolean },
): { system: string; user: string } {
  const importGraphSection = ctx.importGraph
    ? `\n\n## Module relationships (extracted from code)\n\n${ctx.importGraph}\n\nGround your nodes and edges in these REAL import relationships. Prefer files and modules \
that appear in the import graph above. Statuses (added/removed/changed/unchanged) are still \
required on every node and edge in changeMap.`
    : ''

  // Deep-diagram guidance (PROMPT_VERSION 12): when the agentic harness is on,
  // the model situates the changed files inside the BROADER architecture by
  // walking one hop out (importers/callers + direct dependencies) with the
  // verification tools, then tagging those neighbors with status "context".
  const deepContextSection = options?.deep
    ? `\n\n## Deep mode — situate the change in the broader architecture (IMPORTANT)
You have verification tools (search_code / read_file). After forming the changed-file graph as \
described above, use them to find the IMMEDIATE architectural neighborhood — ONE HOP OUT, not \
the whole repo:
- Direct IMPORTERS / CALLERS of the changed modules (search_code for the changed symbol/file).
- Direct DEPENDENCIES the changed modules import (read the changed file's imports).
Add the highest-signal of these neighbors as nodes with status "context" so the diagram shows \
WHERE the change sits in the system. Context nodes appear in before/after/changeMap where \
relevant. Edges between a context node and a changed node carry status "context" and a \
"uses"/"calls" verb label so they read as ambient relationships (the serializer de-emphasizes \
them visually). The five change statuses still apply to the changed nodes/edges themselves.

Budget & cap discipline:
- Stay within the tool budget: prefer the most-connected, highest-signal neighbors. Do NOT \
  enumerate the whole repo or chase second-hop neighbors.
- At most ${DEEP_DIAGRAM_CONTEXT_NODE_CAP} context nodes. If more neighbors exist, keep the \
  most-connected ones and drop the rest silently (do NOT add a placeholder "+N more" node — \
  changeMap's 14-node total cap still holds).
- "context" is the ONLY new status — never invent others.`
    : ''

  const system = `You are an expert code reviewer assistant. Analyze the pull request changes \
and respond with JSON ONLY — no explanation, no markdown, no code fences, and absolutely NO \
Mermaid syntax. Your response must be valid JSON matching this shape exactly:

{
  "kind": "flow" | "module",
  "before": {
    "nodes": [{ "id": "<unique-id>", "label": "<display-label>" }, ...],
    "edges": [{ "from": "<node-id>", "to": "<node-id>", "label": "<optional-label>" }, ...]
  },
  "after": {
    "nodes": [{ "id": "<unique-id>", "label": "<display-label>" }, ...],
    "edges": [{ "from": "<node-id>", "to": "<node-id>", "label": "<optional-label>" }, ...]
  },
  "changeMap": {
    "nodes": [{ "id": "<unique-id>", "label": "<display-label>", "status": "added"|"removed"|"changed"|"unchanged"|"context" }, ...],
    "edges": [{ "from": "<node-id>", "to": "<node-id>", "label": "<optional-label>", "status": "added"|"removed"|"changed"|"unchanged"|"context" }, ...]
  }
}

Choosing kind:
- "flow": use when the PR changes control flow, call chains, request/response paths, or \
  event handling (behavior-oriented changes).
- "module": use when the PR changes module structure, imports, package boundaries, or file \
  organization (structure-oriented changes).

Nodes and edges must describe the structure of the TOUCHED CODE only — before the PR (before) \
and after the PR (after). Node ids must be unique strings without spaces. Labels are \
human-readable display names. Edges reference node ids in the same graph; do not reference ids \
that do not exist in the same graph's nodes array.

changeMap (PRIMARY OUTPUT — this is what the UI renders first):
- Emit a SINGLE merged graph combining all nodes from before and after.
- Every node and every edge in changeMap MUST carry a status field:
  "added" — present only in after; "removed" — present only in before;
  "changed" — present in both but behavior/signature changed;
  "unchanged" — present in both, unaffected by this PR;
  "context" — a surrounding architectural neighbor (NOT touched by this PR) included only to \
  situate the change; emit these ONLY in deep mode (see below) — never invent them otherwise.
- Statuses must reflect this PR's actual effect, not guesses.
- before and after remain for the toggle view (compact is fine — mirror the changeMap nodes).

DO NOT write any Mermaid syntax. The downstream serializer converts your graph data to Mermaid.

Graph size constraints (IMPORTANT):
- changeMap: at most 14 nodes total. If more files are touched, \
  only include nodes whose relationships CHANGED or are needed for context.
- Node labels must be ≤ 3 words — prefer module/file names over sentences (e.g. \
  "router.ts" not "The router module that handles requests").
- Edge labels must be ≤ 2 words (a verb is enough, e.g. "calls", "delegates") — never a \
  sentence. The graph speaks for itself; emit NO explanatory prose anywhere (the output is \
  JSON graph data only — any captioning happens in ≤2 sentences downstream, not here).
- Edges: only include edges that represent CHANGED or newly-added relationships.

${FEW_SHOT_EXAMPLE}${importGraphSection}${deepContextSection}

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

Evidence discipline (IMPORTANT — apply to accuracy and grounded):
- Ground every assessment in what you can SEE in the provided PR context. Do not speculate \
  about code that is not shown.
- When you cannot verify a claim because the relevant code is not in the provided context, \
  say that in reasons.grounded ("couldn't verify against the provided context") instead of \
  asserting the comment is wrong.
- Prefer neutral, factual phrasing over alarm. Grades must reflect evidence, not worst-case \
  speculation.

Be brief and concrete. Do not pad. Do not include any text outside the JSON object.`

  // Cap prComments at 30, truncate each to 200 chars
  const capped = (prComments ?? []).slice(0, 30).map((c) => c.slice(0, 200))

  const payload: unknown = {
    drafts: drafts.map((d) => ({ index: d.index, path: d.path, line: d.line, body: d.body })),
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
