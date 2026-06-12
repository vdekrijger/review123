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

export const PROMPT_VERSION = 6

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

Given the code changes below, produce a concise prose summary: lead with what the PR does \
and why in one sentence, then use bullet points for any important details a reviewer should \
know. Keep the prose summary to ~120 words maximum — shorter is better. Do NOT mention \
reading order anywhere in the prose.

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
  level must be exactly one of: "high", "medium", "low" (lowercase strings — never a number \
  or percentage).
- testFlags: files where behavior changed but no corresponding test file was added or modified. \
  IMPORTANT: test mapping is inferred by reading the code — it is NOT measured coverage data. \
  Label your notes accordingly. Omit the flag if a test file clearly covers the change.

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
export function diagramsPrompt(ctx: PackedContext): { system: string; user: string } {
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
    "nodes": [{ "id": "<unique-id>", "label": "<display-label>", "status": "added"|"removed"|"changed"|"unchanged" }, ...],
    "edges": [{ "from": "<node-id>", "to": "<node-id>", "label": "<optional-label>", "status": "added"|"removed"|"changed"|"unchanged" }, ...]
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
  "unchanged" — present in both, unaffected by this PR.
- Statuses must reflect this PR's actual effect, not guesses.
- before and after remain for the toggle view (compact is fine — mirror the changeMap nodes).

DO NOT write any Mermaid syntax. The downstream serializer converts your graph data to Mermaid.

Graph size constraints (IMPORTANT):
- changeMap: at most 14 nodes total. If more files are touched, \
  only include nodes whose relationships CHANGED or are needed for context.
- Node labels must be ≤ 3 words — prefer module/file names over sentences (e.g. \
  "router.ts" not "The router module that handles requests").
- Edges: only include edges that represent CHANGED or newly-added relationships.

${FEW_SHOT_EXAMPLE}

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

Field rules:
- covered: list up to 10 behaviors actually covered by CHANGED test files in this PR. \
  Each entry must describe the behavior in plain language (not just the test name), name the \
  test function or describe block, and reference the file path. Infer from reading the test code.
- gaps: behaviors in behavior-changing (non-test) files that have NO corresponding test change \
  in this PR. Be specific — name the file and describe the untested behavior. \
  IMPORTANT: coverage is inferred by reading the code — it is NOT measured instrumentation data. \
  Do not speculate about behaviors not visible in the diff.

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// coachPrompt — JSON CoachResult (D4)
// ---------------------------------------------------------------------------

/**
 * Build prompts for the comment coach task.
 *
 * Output must be JSON-only, matching CoachResult:
 *   {
 *     reviews: CommentReview[]
 *   }
 *
 * Per review comment: clarity 1–5, actionable boolean, tone, optional anti-bias
 * question when the comment states preference as defect, optional suggestion.
 */
export function coachPrompt(
  drafts: { index: number; path: string; line: number; body: string }[],
): { system: string; user: string } {
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
      "suggestion": "<a reworded version of the comment that is clearer or kinder, or null>"
    }
  ]
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

Be brief and concrete. Do not pad. Do not include any text outside the JSON object.`

  const draftsJson = JSON.stringify(
    drafts.map((d) => ({ index: d.index, path: d.path, line: d.line, body: d.body })),
    null,
    2,
  )

  return { system, user: draftsJson }
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
- approach: a concrete description of the alternative approach. Be specific enough that a \
  developer could act on it.
- tradeoffs: compare honestly against what the PR does. Name what the alternative gains \
  (e.g. "better test isolation") and what it costs (e.g. "more boilerplate").
- assessment: exactly one of the four enum values:
  - "pr-is-better": the PR's approach is the better choice for this codebase/context
  - "comparable": both approaches have similar merit; team preference should decide
  - "alternative-is-better": this alternative would be meaningfully better
  - "different-goals": this alternative solves a related but different problem
- rationale: a single sentence explaining your assessment choice.

Intellectual honesty: "pr-is-better" is a perfectly valid and often correct answer. Do not \
invent alternatives just to fill the list. Fewer high-quality alternatives are better than \
more low-quality ones. Maximum 3 alternatives total.

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
"I can't see that in the provided context." Keep answers concise and specific.`

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
 * NOTE: No PROMPT_VERSION participation — the orchestrator uses a content-hash
 * cache key (djb2 of skill content) so editing a skill invalidates its cache.
 */
export function skillReviewPrompt(
  ctx: PackedContext,
  skill: { name: string; content: string },
): { system: string; user: string } {
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
- At most 15 findings total (≤15). If you have more candidates, keep only the most important ones.
- Severity must be rated according to THIS persona's own standards: "high", "medium", or "low".

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
- findings: an array of 0–15 findings. Only include findings for files that appear in the PR changes.
- path: must be a file path that actually appears in the PR diff context. Do not invent paths.
- line: the specific line number (integer) the finding applies to, or null if it is a file-level concern.
- severity: exactly one of "high", "medium", "low" — rated by this persona's own standards.
- body: a clear, actionable description of the finding.

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
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
