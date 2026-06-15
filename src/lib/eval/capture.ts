/**
 * src/lib/eval/capture.ts — pure scaffolding for the eval capture tool.
 *
 * The capture CLI (eval/capture-case.mts) does the IO — fetch a real PR via
 * GitHub's REST API, run the real review tasks live — but the *shaping* of the
 * three golden-case files lives here so it is dependency-free and unit-tested
 * under `pnpm test`.
 *
 * Given a fetched PR (already normalized to GoldenFile[]) and the AI's produced
 * findings, this builds the exact JSON shapes the harness consumes:
 *   - fixture.json        (GoldenFixture)
 *   - expected.json       ({ findings: [{ file, line, description, label }] })
 *   - mock/responses.json (task key → scripted response object)
 *
 * The expected.json starts every finding as UNLABELED *unless* the user already
 * accepted/dismissed it during their real review: a recorded ACCEPT pre-labels
 * the entry "real", a DISMISS pre-labels it "noise" (see decisions.ts + the
 * "Auto-labeling from your accept/dismiss decisions" section in eval/README.md).
 * Findings with no decision stay UNLABELED. The user then resolves any remaining
 * labels (and may add real findings the AI missed). The scorer SKIPS UNLABELED
 * entries (see normalizeExpectation in scorer.ts) so a half-labeled case never
 * scores garbage.
 */

import type { GoldenFile, GoldenFixture } from './harness'
import type { ExpectedLabel } from './scorer'
import { findingMatchTail, type FindingDecision } from './decisions'

/** A finding the live review produced, normalized for scaffolding. */
export interface CapturedFinding {
  /** The review task that produced it: "verdict" | "attention" | `skill:<name>`. */
  taskKey: string
  file: string
  /** 1-based line, or null for a file-level finding. */
  line: number | null
  description: string
  /** Optional severity carried through into the mock skill response. */
  severity?: string
}

/** A labeled expectation entry as written to expected.json. */
export interface ExpectedEntry {
  file: string
  line: number | null
  description: string
  label: ExpectedLabel
}

/** The expected.json shape the capture tool scaffolds. */
export interface ExpectedFile {
  /** Each captured finding, pre-labeled UNLABELED for the user to resolve. */
  findings: ExpectedEntry[]
}

/** The three files a captured case is made of. */
export interface ScaffoldedCase {
  fixture: GoldenFixture
  expected: ExpectedFile
  mockResponses: Record<string, unknown>
}

/** PR metadata + files needed to build a fixture. */
export interface CapturedPr {
  name: string
  files: GoldenFile[]
  skills?: { name: string; content: string }[]
}

/**
 * Build the fixture.json object from a fetched PR. Pure pass-through of the
 * already-normalized files + reviewer personas (the IO of fetching/normalizing
 * lives in the CLI).
 */
export function buildFixture(pr: CapturedPr): GoldenFixture {
  return {
    name: pr.name,
    files: pr.files,
    ...(pr.skills && pr.skills.length > 0 ? { skills: pr.skills } : {}),
  }
}

/**
 * Build the expected.json object: every captured finding listed once.
 *
 * Each entry is pre-labeled from the user's REAL accept/dismiss decisions when
 * `decisionLabels` is supplied: a finding whose match-tail (path:line:bodyPrefix)
 * was ACCEPTED → "real", DISMISSED → "noise". Findings with no decision (and the
 * whole array when no decisions are passed) stay "UNLABELED" — the prior default.
 *
 * Findings are de-duplicated by (file, line, description) so two tasks surfacing
 * the same issue produce a single entry to label.
 *
 * @param decisionLabels match-tail → 'accepted'|'dismissed' (see
 *   decisionLabelsByTail in decisions.ts). Omit for the all-UNLABELED behavior.
 */
export function buildExpected(
  findings: CapturedFinding[],
  decisionLabels?: Map<string, FindingDecision>,
): ExpectedFile {
  const seen = new Set<string>()
  const entries: ExpectedEntry[] = []
  for (const f of findings) {
    const key = `${f.file}::${f.line ?? 'null'}::${f.description}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      file: f.file,
      line: f.line,
      description: f.description,
      label: labelFor(f, decisionLabels),
    })
  }
  return { findings: entries }
}

/**
 * Resolve a captured finding's pre-label from the recorded decisions:
 * accepted → 'real', dismissed → 'noise', no decision (or no map) → 'UNLABELED'.
 */
function labelFor(
  f: CapturedFinding,
  decisionLabels: Map<string, FindingDecision> | undefined,
): ExpectedLabel {
  if (!decisionLabels) return 'UNLABELED'
  const decision = decisionLabels.get(findingMatchTail(f.file, f.line, f.description))
  if (decision === 'accepted') return 'real'
  if (decision === 'dismissed') return 'noise'
  return 'UNLABELED'
}

/**
 * Build mock/responses.json: reconstruct, per task key, the scripted response
 * object the harness's --mock path replays. Skill findings carry path/line/body
 * (+ severity); attention findings become hotspots; verdict findings become
 * evidence bullets. This makes the captured case replayable offline.
 */
export function buildMockResponses(findings: CapturedFinding[]): Record<string, unknown> {
  const skillFindings = new Map<string, CapturedFinding[]>()
  const attentionHotspots: { path: string; level: string; reason: string }[] = []
  const verdictEvidence: string[] = []

  for (const f of findings) {
    if (f.taskKey.startsWith('skill:')) {
      const list = skillFindings.get(f.taskKey) ?? []
      list.push(f)
      skillFindings.set(f.taskKey, list)
    } else if (f.taskKey === 'attention') {
      attentionHotspots.push({
        path: f.file,
        level: f.severity ?? 'medium',
        reason: f.description,
      })
    } else if (f.taskKey === 'verdict') {
      verdictEvidence.push(
        f.description.includes(f.file) ? f.description : `${f.file}: ${f.description}`,
      )
    }
  }

  const out: Record<string, unknown> = {}

  for (const [taskKey, list] of skillFindings) {
    out[taskKey] = {
      skillName: taskKey.slice('skill:'.length),
      findings: list.map((f) => ({
        path: f.file,
        line: f.line,
        severity: f.severity ?? 'medium',
        body: f.description,
      })),
    }
  }

  out.attention = {
    readingOrder: uniquePaths(findings),
    hotspots: attentionHotspots,
    testFlags: [],
  }

  out.verdict = {
    level: verdictEvidence.length > 0 || skillFindings.size > 0 ? 'significant-changes' : 'behavior-preserved',
    evidence: verdictEvidence,
    notAnalyzed: [],
  }

  return out
}

function uniquePaths(findings: CapturedFinding[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of findings) {
    if (!seen.has(f.file)) {
      seen.add(f.file)
      out.push(f.file)
    }
  }
  return out
}

/**
 * Scaffold a complete golden case from a fetched PR + its captured findings.
 * The single entry point the CLI calls; returns the three file objects ready to
 * be JSON-serialized to disk.
 *
 * When `decisionLabels` is provided (the user reviewed this PR and their
 * accept/dismiss decisions were read from the local decision store), each
 * captured finding's expected entry is PRE-LABELED accepted→real / dismissed→noise.
 */
export function scaffoldCase(
  pr: CapturedPr,
  findings: CapturedFinding[],
  decisionLabels?: Map<string, FindingDecision>,
): ScaffoldedCase {
  return {
    fixture: buildFixture(pr),
    expected: buildExpected(findings, decisionLabels),
    mockResponses: buildMockResponses(findings),
  }
}
