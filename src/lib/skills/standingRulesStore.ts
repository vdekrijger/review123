/**
 * src/lib/skills/standingRulesStore.ts — persistence + export for the
 * standing-rules knowledge base.
 *
 * THE DESIGN CONSTRAINT THIS FILE EXISTS TO ENFORCE: propose, never
 * auto-apply. A distilled rule is a CANDIDATE. The user accepts it, edits it,
 * or rejects it — one at a time, with the evidence that produced it in front
 * of them — and nothing is ever written into a file on their machine. Silent
 * persona drift ("a reviewer that changed its mind and you don't know why") is
 * the failure mode; the #230 calibration ledger is the precedent: visible,
 * per-entry, clearable.
 *
 * Storage (localStorage, corrupt-tolerant, LRU-bounded — the
 * `review123:prepared-reviews` / `review123:finding-anchors` idioms):
 *   `review123:standing-rules`           — the last distillation (one record)
 *   `review123:standing-rule-decisions`  — { [ruleId]: DecisionEntry }
 *
 * The two are deliberately SEPARATE keys. Decisions outlive any single
 * distillation: a re-run three months later must still know which rules the
 * user already rejected, so it can honour "a rejected rule is never
 * re-proposed verbatim" without the old proposal still being on disk.
 *
 * Rule identity is `djb2(normalized rule text)`, not a model-supplied id. A
 * model id is not stable across runs; the text is the rule. Normalization
 * (lowercase, collapsed whitespace, no trailing period) means a re-run that
 * rephrases only the punctuation is recognised as the same rule.
 */

import { djb2 } from '../viewed/viewed.svelte'
import type { StandingRule, StandingRuleKind } from '../ai/schemas'
import type { CorpusCounts } from './standingRulesCorpus'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const STANDING_RULES_KEY = 'review123:standing-rules'
export const STANDING_RULE_DECISIONS_KEY = 'review123:standing-rule-decisions'

/**
 * Max decisions kept — oldest (by decidedAt) evicted beyond this.
 *
 * Generous relative to STANDING_RULES_MAX (12 per run) because the re-propose
 * guard is only as good as its memory: evicting a rejection means the next
 * distillation may propose that exact rule again, which is the one behaviour
 * the user asked us never to do.
 */
export const STANDING_RULE_DECISIONS_MAX = 200

/** Where the distillation actually ran. Surfaced to the user, never inferred. */
export type DistillSource = 'bridge' | 'api'

export type RuleStatus = 'accepted' | 'rejected'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecisionEntry {
  status: RuleStatus
  /**
   * The text as it stands: the proposed rule, or the user's edit of it.
   * Exported verbatim — the user's words win over the model's.
   */
  text: string
  kind: StandingRuleKind
  /** True when `text` differs from the rule as proposed. */
  edited: boolean
  decidedAt: number
}

export type Decisions = Record<string, DecisionEntry>

export interface StandingRulesRecord {
  /** PROMPT_VERSIONS.standingRules at distillation time — staleness check. */
  promptVersion: number
  /** Epoch ms when the distillation settled. */
  distilledAt: number
  source: DistillSource
  /** Human label for the source ("Claude Code on this machine" / "DeepSeek"). */
  sourceLabel: string
  counts: CorpusCounts
  rules: StandingRule[]
}

// ---------------------------------------------------------------------------
// Rule identity
// ---------------------------------------------------------------------------

/**
 * Normalize a rule for identity: lowercase, collapsed whitespace, no trailing
 * sentence punctuation. Two proposals that differ only in casing or a final
 * period are the SAME rule — which is exactly what the re-propose guard needs.
 */
export function normalizeRule(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.!;,]+$/, '')
}

/** Stable identity for a rule — a function of its text, never of the model. */
export function ruleId(text: string): string {
  return djb2(normalizeRule(text))
}

// ---------------------------------------------------------------------------
// Storage helpers — corrupt-tolerant on read, best-effort on write
// ---------------------------------------------------------------------------

function isDecisionEntry(x: unknown): x is DecisionEntry {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const e = x as Record<string, unknown>
  if (e['status'] !== 'accepted' && e['status'] !== 'rejected') return false
  if (typeof e['text'] !== 'string' || e['text'].trim() === '') return false
  if (e['kind'] !== 'do' && e['kind'] !== 'avoid') return false
  if (typeof e['edited'] !== 'boolean') return false
  if (typeof e['decidedAt'] !== 'number') return false
  return true
}

function isStandingRule(x: unknown): x is StandingRule {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const r = x as Record<string, unknown>
  if (typeof r['rule'] !== 'string' || r['rule'].trim() === '') return false
  if (r['kind'] !== 'do' && r['kind'] !== 'avoid') return false
  if (typeof r['occurrences'] !== 'number') return false
  if (!Array.isArray(r['evidence'])) return false
  return true
}

function isCounts(x: unknown): x is CorpusCounts {
  if (typeof x !== 'object' || x === null) return false
  const c = x as Record<string, unknown>
  return (
    typeof c['reviewComments'] === 'number' &&
    typeof c['dismissals'] === 'number' &&
    typeof c['drafts'] === 'number' &&
    typeof c['acceptedFindings'] === 'number'
  )
}

// ---------------------------------------------------------------------------
// Decisions CRUD
// ---------------------------------------------------------------------------

/** Every decision, validated; corrupt entries skipped. `{}` when unreadable. */
export function loadDecisions(): Decisions {
  try {
    const raw = localStorage.getItem(STANDING_RULE_DECISIONS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Decisions = {}
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isDecisionEntry(entry)) out[id] = entry
    }
    return out
  } catch {
    return {}
  }
}

function saveDecisions(decisions: Decisions): void {
  const entries = Object.entries(decisions)
  const kept =
    entries.length > STANDING_RULE_DECISIONS_MAX
      ? entries.sort((a, b) => b[1].decidedAt - a[1].decidedAt).slice(0, STANDING_RULE_DECISIONS_MAX)
      : entries
  try {
    localStorage.setItem(STANDING_RULE_DECISIONS_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // storage unavailable/full — persistence is best-effort
  }
}

/**
 * Record a decision on ONE rule. `text` is the accepted wording: the rule as
 * proposed, or the user's edit of it. Re-deciding the same rule overwrites the
 * previous entry and refreshes its LRU position.
 */
export function decideRule(
  rule: Pick<StandingRule, 'rule' | 'kind'>,
  status: RuleStatus,
  text?: string,
): DecisionEntry {
  const finalText = (text ?? rule.rule).replace(/\s+/g, ' ').trim() || rule.rule
  const entry: DecisionEntry = {
    status,
    text: finalText,
    kind: rule.kind,
    edited: normalizeRule(finalText) !== normalizeRule(rule.rule),
    decidedAt: Date.now(),
  }
  const decisions = loadDecisions()
  decisions[ruleId(rule.rule)] = entry
  saveDecisions(decisions)
  return entry
}

/** Undo a decision (back to undecided). No-op when there was none. */
export function clearDecision(id: string): void {
  const decisions = loadDecisions()
  if (!(id in decisions)) return
  delete decisions[id]
  saveDecisions(decisions)
}

/** Forget every decision — the ledger's "clear" affordance. */
export function clearAllDecisions(): void {
  try {
    localStorage.removeItem(STANDING_RULE_DECISIONS_KEY)
  } catch {
    // best effort
  }
}

/**
 * Drop rules the user already REJECTED — the "never re-proposed verbatim"
 * guarantee. Matching is on normalized text, so a re-run that returns the same
 * rule with different casing or a trailing period is still recognised.
 *
 * ACCEPTED rules are deliberately NOT dropped: they come back with their
 * decision attached so the list stays a complete picture of the corpus, and
 * fresh evidence counts can update.
 */
export function withoutRejected(rules: readonly StandingRule[], decisions: Decisions): StandingRule[] {
  return rules.filter((r) => decisions[ruleId(r.rule)]?.status !== 'rejected')
}

// ---------------------------------------------------------------------------
// Distillation record
// ---------------------------------------------------------------------------

/** The stored distillation, or null when absent/corrupt. */
export function loadStandingRules(): StandingRulesRecord | null {
  try {
    const raw = localStorage.getItem(STANDING_RULES_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const r = parsed as Record<string, unknown>
    if (typeof r['promptVersion'] !== 'number') return null
    if (typeof r['distilledAt'] !== 'number') return null
    if (r['source'] !== 'bridge' && r['source'] !== 'api') return null
    if (typeof r['sourceLabel'] !== 'string') return null
    if (!isCounts(r['counts'])) return null
    if (!Array.isArray(r['rules'])) return null
    return {
      promptVersion: r['promptVersion'],
      distilledAt: r['distilledAt'],
      source: r['source'],
      sourceLabel: r['sourceLabel'],
      counts: r['counts'],
      // Element-level tolerance: one garbled rule does not discard the run.
      rules: r['rules'].filter(isStandingRule),
    }
  } catch {
    return null
  }
}

export function saveStandingRules(record: StandingRulesRecord): void {
  try {
    localStorage.setItem(STANDING_RULES_KEY, JSON.stringify(record))
  } catch {
    // best effort
  }
}

export function clearStandingRules(): void {
  try {
    localStorage.removeItem(STANDING_RULES_KEY)
  } catch {
    // best effort
  }
}

/**
 * Whether a stored record was produced by an older prompt than the one
 * shipping now. Stale does NOT mean discard — the rules are still the user's
 * to accept. It means the UI says so and offers a re-run.
 */
export function isRecordStale(record: StandingRulesRecord, currentVersion: number): boolean {
  return record.promptVersion !== currentVersion
}

// ---------------------------------------------------------------------------
// Export — clipboard + download
//
// THE HARD RULE: this module produces a STRING. It never writes to a file on
// the user's machine — not through the bridge, not with --allow-write, not
// ever. Where their authoring policy lives is their decision, and a tool that
// edits CLAUDE.md behind their back is the same silent-drift failure the
// accept/reject flow exists to prevent.
// ---------------------------------------------------------------------------

export const STANDING_RULES_HEADING = '## Standing rules'
export const STANDING_RULES_FILENAME = 'standing-rules.md'

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The one-line provenance header. Deliberately a visible markdown line, not an
 * HTML comment: the human pasting this into CLAUDE.md should see where it came
 * from and that it is theirs to edit.
 */
export function provenanceLine(record: Pick<StandingRulesRecord, 'distilledAt' | 'counts'>): string {
  const c = record.counts
  const sources = [
    plural(c.reviewComments, 'review comment'),
    plural(c.dismissals, 'dismissal'),
    plural(c.drafts, 'draft'),
  ].join(', ')
  return `_Distilled by review123 on ${isoDate(record.distilledAt)} from ${sources}. These are proposals the repo owner accepted — edit them freely._`
}

/**
 * Render the ACCEPTED rules as a section to paste into CLAUDE.md / AGENTS.md.
 *
 * Accepted rules only: a proposal the user never acted on is not their policy.
 * The two kinds get their own subsections because they read differently — one
 * says what to do, the other says what this codebase does not care about.
 */
export function exportStandingRules(
  decisions: Decisions,
  record: Pick<StandingRulesRecord, 'distilledAt' | 'counts'>,
): string {
  const accepted = Object.values(decisions)
    .filter((d) => d.status === 'accepted')
    .sort((a, b) => a.decidedAt - b.decidedAt)

  const lines: string[] = [STANDING_RULES_HEADING, '', provenanceLine(record), '']

  if (accepted.length === 0) {
    lines.push('_No rules accepted yet._')
    return `${lines.join('\n')}\n`
  }

  const dos = accepted.filter((d) => d.kind === 'do')
  const avoids = accepted.filter((d) => d.kind === 'avoid')

  if (dos.length > 0) {
    lines.push('### Always', '')
    for (const d of dos) lines.push(`- ${d.text}`)
    lines.push('')
  }
  if (avoids.length > 0) {
    lines.push('### Never', '')
    for (const d of avoids) lines.push(`- ${d.text}`)
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** Count of accepted rules — the export button's label and its analytics prop. */
export function acceptedCount(decisions: Decisions): number {
  return Object.values(decisions).filter((d) => d.status === 'accepted').length
}
