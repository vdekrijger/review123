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

export const PROMPT_VERSION = 2

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

Given the code changes below, produce TWO sections in Markdown:

1. A concise prose summary: lead with what the PR does and why in one sentence, then use \
bullet points for any important details a reviewer should know. Keep the prose summary to \
~120 words maximum — shorter is better.

2. A section headed EXACTLY (including the colon):

Suggested reading order:

List one file path per line, in the order a reviewer should read them — most load-bearing or \
context-setting files first. Only include files that appear in the PR changes. Do not add \
bullet points, numbers, or any other prefix to the file paths. Stop the list at a blank line \
or the end of your response.`

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

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
}

// ---------------------------------------------------------------------------
// diagramsPrompt — JSON GraphResult with few-shot example
// ---------------------------------------------------------------------------

// The few-shot marker is intentional so tests can assert its presence.
// DIAGRAMS_FEW_SHOT_MARKER is not exported but the string appears verbatim.
const FEW_SHOT_EXAMPLE = `/* FEW_SHOT_EXAMPLE_START */
Example input sketch (three files touched: api.ts, router.ts, handler.ts):

Example valid output JSON:
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

DO NOT write any Mermaid syntax. The downstream serializer converts your graph data to Mermaid.

${FEW_SHOT_EXAMPLE}

Do not include any text outside the JSON object.`

  return { system, user: ctx.text }
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
- Each evidence bullet must be concrete and reference specific files or code. \
  Do not write generic descriptions.
- List anything you could not assess (missing context, files not provided, etc.) in notAnalyzed.

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

  // Find the heading line
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

    // Stop at blank line
    if (raw.trim() === '') break

    // Strip bullet/number prefixes and backticks
    const cleaned = raw
      .trim()
      // Remove leading list markers: "- ", "* ", "• ", "1. ", "2) ", etc.
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      // Remove surrounding backticks
      .replace(/^`+|`+$/g, '')
      .trim()

    if (cleaned.length > 0) {
      paths.push(cleaned)
    }
  }

  return paths
}

// ---------------------------------------------------------------------------
// stripReadingOrder — remove the "Suggested reading order:" block from display
// ---------------------------------------------------------------------------

/**
 * Strip the "Suggested reading order:" heading and its file-list block from
 * a summary string, returning only the prose portion.
 *
 * The heading is matched case-insensitively and tolerantly (surrounding
 * whitespace). The list block that follows — non-blank lines until the first
 * blank line or end of input — is also removed.
 *
 * Use this before displaying the summary; parsing/ordering logic still uses
 * parseReadingOrder on the original text.
 *
 * Returns the trimmed prose portion, or the original string if no heading is found.
 */
export function stripReadingOrder(summaryText: string): string {
  const lines = summaryText.split('\n')

  // Find the heading line
  let headingIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (/suggested reading order\s*:/i.test(lines[i])) {
      headingIndex = i
      break
    }
  }

  if (headingIndex === -1) return summaryText

  // Find the end of the list block: first blank line after heading, or end
  let listEnd = headingIndex + 1
  while (listEnd < lines.length && lines[listEnd].trim() !== '') {
    listEnd++
  }

  // Remove heading + list lines and rejoin
  const before = lines.slice(0, headingIndex)
  const after = lines.slice(listEnd)
  return [...before, ...after].join('\n').trim()
}
