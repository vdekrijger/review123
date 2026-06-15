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
  normalizeExpectation,
  type CaseScore,
  type ProducedFinding,
  type MatchConfig,
  type RawExpectation,
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

/**
 * Hand-labeled expectations for a golden case (expected.json). Either the
 * hand-authored `{ real, noise }` shape or the capture-tool's labeled
 * `{ findings: [{ ..., label }] }` shape — both are accepted (see
 * normalizeExpectation in scorer.ts; UNLABELED entries are skipped).
 */
export type GoldenExpected = RawExpectation

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

/**
 * A verify pass over produced findings (Plan M eval integration). Mirrors
 * CompleteFn's injectability: a mock scripts per-finding verdicts; a live impl
 * calls the real verifier providers. Returns, per finding (by 0-based index in
 * the produced array), whether it SURVIVED cross-model verification (surfaced).
 * Findings the verify pass demotes are dropped before scoring, so precision /
 * recall / noise-rate are measured WITH cross-model verification.
 */
export type VerifyFn = (
  findings: ProducedFinding[],
) => Promise<{ surfaced: boolean[] }>

export interface RunCaseOptions {
  /** When true, append the deep-review guidance to each task's system prompt. */
  deep?: boolean
  match?: MatchConfig
  /**
   * Cross-model verification (Plan M). When `verify` is provided AND this is
   * true, produced findings are verified and demoted ones dropped before
   * scoring — so the score reflects post-verification precision/recall.
   */
  crossVerify?: boolean
  verify?: VerifyFn
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

  // Cross-model verification (Plan M): drop demoted findings before scoring so
  // the metrics reflect post-verification precision/recall/noise-rate.
  let scored = produced
  if (options.crossVerify && options.verify && produced.length > 0) {
    const { surfaced } = await options.verify(produced)
    scored = produced.filter((_, i) => surfaced[i] !== false)
  }

  const expectation = normalizeExpectation(goldenCase.expected)
  const score = scoreCase(goldenCase.name, scored, expectation, match)

  return { score, produced: scored, rawByTask }
}

/**
 * A finding produced by a single review task, tagged with the task that
 * produced it (and a severity when the task carries one). This is what the
 * capture tool feeds to scaffoldCase() to rebuild a replayable mock + the
 * UNLABELED expected.json.
 */
export interface TaggedFinding {
  taskKey: string
  file: string
  line: number | null
  description: string
  severity?: string
}

/**
 * Run the three review tasks LIVE over a fixture (no scoring) and return every
 * produced finding tagged with its task key + severity. Used by the capture
 * tool (eval/capture-case.mts) to turn a real PR review into a golden case.
 *
 * Mirrors runCase's task wiring exactly so the captured findings match what the
 * app/harness would produce — but it keeps the per-task provenance the mock
 * scaffold needs (which runCase flattens away).
 */
export async function captureFindings(
  fixture: GoldenFixture,
  complete: CompleteFn,
  ci: CiSummary | null = null,
  options: { deep?: boolean } = {},
): Promise<TaggedFinding[]> {
  const ctx = packFixture(fixture)
  const out: TaggedFinding[] = []
  const maybeDeep = (system: string): string =>
    options.deep ? withDeepReviewGuidance(system, ['read_file', 'search_code']) : system

  // --- Verdict ---
  {
    const prompts = verdictPrompt(ctx, ci)
    const raw = await complete({ system: maybeDeep(prompts.system), user: prompts.user, taskKey: 'verdict' })
    for (const f of verdictFindings(safeParse(raw))) {
      out.push({ taskKey: 'verdict', file: f.file, line: f.line, description: f.description })
    }
  }

  // --- Attention ---
  {
    const prompts = attentionPrompt(ctx, { deep: options.deep })
    const raw = await complete({ system: prompts.system, user: prompts.user, taskKey: 'attention' })
    const valid = validateAttention(safeParse(raw))
    for (const h of valid?.hotspots ?? []) {
      out.push({ taskKey: 'attention', file: h.path, line: null, description: h.reason, severity: h.level })
    }
  }

  // --- Skill reviews (one per persona) ---
  for (const skill of fixture.skills ?? []) {
    const prompts = skillReviewPrompt(ctx, skill)
    const taskKey = `skill:${skill.name}`
    const raw = await complete({ system: maybeDeep(prompts.system), user: prompts.user, taskKey })
    const valid = validateSkillReviewResult(safeParse(raw))
    for (const f of valid?.findings ?? []) {
      out.push({ taskKey, file: f.path, line: f.line, description: f.body, severity: f.severity })
    }
  }

  return out
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
