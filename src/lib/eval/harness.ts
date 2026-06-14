/**
 * src/lib/eval/harness.ts — eval-harness core (LLM-agnostic).
 *
 * Turns a golden case + an injectable "complete" function into a flat list of
 * normalized findings, then scores them with scorer.ts. Reuses the REAL review
 * code paths:
 *   - prompt builders from src/lib/ai/tasks.ts (skillReviewPrompt, verdictPrompt,
 *     attentionPrompt) — so a prompt/calibration change is exercised here, and
 *   - the REAL validators from src/lib/ai/schemas.ts.
 *
 * The LLM itself is injected as `CompleteFn` so the SAME harness runs under:
 *   --mock  (scripted stub returning fixture responses — deterministic, CI-safe)
 *   --live  (a real provider call wired by eval/run-eval.ts)
 *
 * This file is pure (no Node, no DOM, no settings) so it runs under vitest.
 */

import {
  skillReviewPrompt,
  verdictPrompt,
  attentionPrompt,
  withDeepReviewGuidance,
} from '../ai/tasks'
import {
  validateSkillReviewResult,
  validateVerdict,
  validateAttention,
} from '../ai/schemas'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import {
  scoreCase,
  type CaseExpectation,
  type CaseScore,
  type ProducedFinding,
  type MatchConfig,
  DEFAULT_MATCH_CONFIG,
} from './scorer'

// ---------------------------------------------------------------------------
// Golden-case shapes (mirrors eval/golden/<case>/*.json — see eval/README.md)
// ---------------------------------------------------------------------------

/** One changed file in a golden fixture — same fields the app's pack consumes. */
export interface GoldenFile {
  path: string
  /** Unified-diff patch for the change (the `@@` hunks). */
  patch: string
  /** Full file contents AFTER the change (head). null if deleted. */
  contentAfter: string | null
  /** Full file contents BEFORE the change (base). null if added. */
  contentBefore?: string | null
}

/** A golden PR fixture: changed files + the persona(s) to review with. */
export interface GoldenFixture {
  name: string
  files: GoldenFile[]
  /** Optional reviewer personas (skill content) to run skill review with. */
  skills?: { name: string; content: string }[]
}

/** Hand-labeled expectations for a golden case (expected.json). */
export interface GoldenExpected {
  /** Findings a good reviewer SHOULD flag. */
  real: { file: string; line: number | null; description: string }[]
  /** Findings a good reviewer should NOT flag (nits, moot, unchanged code). */
  noise: { file: string; line: number | null; description: string }[]
}

/** A fully-loaded golden case: fixture + expectations. */
export interface GoldenCase {
  name: string
  fixture: GoldenFixture
  expected: GoldenExpected
}

// ---------------------------------------------------------------------------
// LLM injection
// ---------------------------------------------------------------------------

/**
 * Minimal completion contract the harness needs. Returns the raw assistant
 * text (expected to be JSON for these tasks). `taskKey` lets a mock stub return
 * different scripted responses per task; a live impl can ignore it.
 */
export type CompleteFn = (args: {
  system: string
  user: string
  /** "verdict" | "attention" | `skill:<name>` — lets the mock pick a response. */
  taskKey: string
}) => Promise<string>

export interface RunCaseOptions {
  /** When true, append the deep-review guidance to each task's system prompt. */
  deep?: boolean
  match?: MatchConfig
}

// ---------------------------------------------------------------------------
// Context packing for a fixture
// ---------------------------------------------------------------------------

/**
 * Assemble a PackedContext-shaped text payload from a golden fixture. This is a
 * small, self-contained packer (the app's real packer fetches from a live VCS
 * provider); it mirrors the shape the prompt builders consume: each file's path,
 * its patch, and its full after-contents.
 */
export function packFixture(fixture: GoldenFixture): PackedContext {
  const blocks: string[] = []
  for (const f of fixture.files) {
    blocks.push(`### File: ${f.path}`)
    blocks.push('```diff')
    blocks.push(f.patch.trimEnd())
    blocks.push('```')
    if (f.contentAfter !== null) {
      blocks.push(`Full contents of ${f.path} after the change:`)
      blocks.push('```')
      blocks.push(f.contentAfter.trimEnd())
      blocks.push('```')
    }
    blocks.push('')
  }
  return {
    text: blocks.join('\n'),
    notAnalyzed: [],
    includedFiles: fixture.files.map((f) => f.path),
    importGraph: '',
  }
}

// ---------------------------------------------------------------------------
// Output → ProducedFinding normalization
// ---------------------------------------------------------------------------

/**
 * Reduce the three review tasks' outputs to a flat finding list. A finding =
 * {file, line, description}. Verdict evidence and attention hotspots carry a
 * file path in their text where possible; we keep them file-level (line null)
 * since those tasks are file/PR-scoped, while skill findings carry real lines.
 */
function skillFindings(raw: unknown): ProducedFinding[] {
  const valid = validateSkillReviewResult(raw)
  if (valid === null) return []
  return valid.findings.map((f) => ({
    file: f.path,
    line: f.line,
    description: f.body,
  }))
}

function attentionFindings(raw: unknown): ProducedFinding[] {
  const valid = validateAttention(raw)
  if (valid === null) return []
  return valid.hotspots.map((h) => ({
    file: h.path,
    line: null,
    description: h.reason,
  }))
}

/**
 * Verdict has no per-file findings shape; we map each evidence bullet to a
 * file-level finding by extracting a `path/like/this.ext` token from the bullet
 * (best-effort). Bullets without a recognizable path are dropped — verdict
 * mostly contributes to attention/skill recall, not as standalone findings.
 */
function verdictFindings(raw: unknown): ProducedFinding[] {
  const valid = validateVerdict(raw)
  if (valid === null) return []
  const out: ProducedFinding[] = []
  for (const bullet of valid.evidence) {
    const path = extractPath(bullet)
    if (path) out.push({ file: path, line: null, description: bullet })
  }
  return out
}

const PATH_RE = /[\w@.\-/]+\.[A-Za-z0-9]+/

export function extractPath(text: string): string | null {
  const m = PATH_RE.exec(text)
  if (!m) return null
  // Require at least one slash OR a known-ish source extension to avoid matching
  // prose like "e.g." — a path either has a directory or a multi-char extension.
  const token = m[0]
  if (token.includes('/')) return token
  if (/\.(ts|tsx|js|jsx|svelte|py|go|rs|java|rb|json|css)$/i.test(token)) return token
  return null
}

// ---------------------------------------------------------------------------
// runCase
// ---------------------------------------------------------------------------

export interface CaseRunResult {
  score: CaseScore
  produced: ProducedFinding[]
  /** Raw per-task outputs, for debugging / JSON emission. */
  rawByTask: Record<string, string>
}

/**
 * Run all three review tasks for a golden case against the injected `complete`
 * function, normalize their outputs to findings, and score against the case's
 * expectations.
 */
export async function runCase(
  goldenCase: GoldenCase,
  complete: CompleteFn,
  ci: CiSummary | null = null,
  options: RunCaseOptions = {},
): Promise<CaseRunResult> {
  const ctx = packFixture(goldenCase.fixture)
  const match = options.match ?? DEFAULT_MATCH_CONFIG
  const rawByTask: Record<string, string> = {}
  const produced: ProducedFinding[] = []

  const maybeDeep = (system: string): string =>
    options.deep ? withDeepReviewGuidance(system, ['read_file', 'search_code']) : system

  // --- Verdict ---
  {
    const prompts = verdictPrompt(ctx, ci)
    const raw = await complete({ system: maybeDeep(prompts.system), user: prompts.user, taskKey: 'verdict' })
    rawByTask['verdict'] = raw
    produced.push(...verdictFindings(safeParse(raw)))
  }

  // --- Attention ---
  {
    const prompts = attentionPrompt(ctx, { deep: options.deep })
    const raw = await complete({ system: prompts.system, user: prompts.user, taskKey: 'attention' })
    rawByTask['attention'] = raw
    produced.push(...attentionFindings(safeParse(raw)))
  }

  // --- Skill reviews (one per persona) ---
  for (const skill of goldenCase.fixture.skills ?? []) {
    const prompts = skillReviewPrompt(ctx, skill)
    const taskKey = `skill:${skill.name}`
    const raw = await complete({ system: maybeDeep(prompts.system), user: prompts.user, taskKey })
    rawByTask[taskKey] = raw
    produced.push(...skillFindings(safeParse(raw)))
  }

  const expectation: CaseExpectation = {
    real: goldenCase.expected.real,
    noise: goldenCase.expected.noise,
  }
  const score = scoreCase(goldenCase.name, produced, expectation, match)

  return { score, produced, rawByTask }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(stripFences(raw))
  } catch {
    return null
  }
}

/** Strip ```json fences a model may wrap JSON in, mirroring the app's leniency. */
function stripFences(raw: string): string {
  const trimmed = raw.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  return fence ? fence[1] : trimmed
}
