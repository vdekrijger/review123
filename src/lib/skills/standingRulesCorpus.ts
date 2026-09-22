/**
 * src/lib/skills/standingRulesCorpus.ts — assembling the corpus the
 * standing-rules distillation reads.
 *
 * THERE IS NO SECOND HARVEST. mineSkill already fetches the user's own review
 * comments from the provider (`getMyAccountReviewComments`, account-wide,
 * author-filtered, capped, long code fences stripped). This module reuses that
 * exact path and adds the two streams mineSkill has no use for:
 *
 *   dismissals — the #230 per-reviewer calibration ledger. Findings the user
 *     judged "not real" or "not worth flagging". To a reviewer that is "stop
 *     raising X"; to an author it is "this codebase does not care about X".
 *     Negative standing rules, and the single highest-density signal we have.
 *
 *   drafts + acceptedFindings — comment bodies from the user's own IndexedDB
 *     draft store. `aiAuthored` splits them (#200): a draft the user TYPED is
 *     their own words (highest signal); one they accepted from an AI reviewer
 *     is an endorsement of the point, not of the phrasing.
 *
 * Draft bodies are read through a read-only cursor here rather than through
 * drafts.svelte.ts, which exposes bodies only per-PR through a rune-backed
 * store. The DB and store names are duplicated deliberately and pinned by a
 * CONTRACT TEST that writes through createDraftStore and reads back through
 * this module — if the names ever diverge, that test fails rather than this
 * silently harvesting nothing.
 */

import type { Draft } from '../drafts/drafts.svelte'
import { listAllCalibration, type DismissReason } from './calibration'
import { MINE_COMMENTS_CAP } from './mineSkill'
import { providerFor } from '../provider/registry'
import { githubProvider } from '../provider/github'
import { gitlabProvider } from '../provider/gitlab'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Draft bodies harvested, newest first. A cost bound, like MINE_COMMENTS_CAP. */
export const DRAFT_CORPUS_CAP = 120

/**
 * Corpus items below which we refuse to distil.
 *
 * Not arbitrary: a standing rule must appear at least twice to be a pattern,
 * and a handful of comments cannot separate a pattern from a coincidence. The
 * honest answer under this line is "not enough signal yet", not a cheap LLM
 * call that invents plausible-sounding rules from four comments.
 */
export const STANDING_RULES_MIN_CORPUS = 12

/** Chars per token, for the cost preview. The usual rough industry divisor. */
const CHARS_PER_TOKEN = 4

/** Mirrors the drafts store's own private constants (pinned by contract test). */
const DRAFTS_DB_NAME = 'review123-drafts'
const DRAFTS_STORE_NAME = 'drafts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorpusCounts {
  reviewComments: number
  dismissals: number
  drafts: number
  acceptedFindings: number
}

export interface StandingRulesCorpus {
  reviewComments: string[]
  dismissals: { pattern: string; reason: DismissReason }[]
  drafts: string[]
  acceptedFindings: string[]
}

export function countCorpus(corpus: StandingRulesCorpus): CorpusCounts {
  return {
    reviewComments: corpus.reviewComments.length,
    dismissals: corpus.dismissals.length,
    drafts: corpus.drafts.length,
    acceptedFindings: corpus.acceptedFindings.length,
  }
}

export function corpusTotal(counts: CorpusCounts): number {
  return counts.reviewComments + counts.dismissals + counts.drafts + counts.acceptedFindings
}

// ---------------------------------------------------------------------------
// Readiness — the honest answer when there is nothing to distil
// ---------------------------------------------------------------------------

export type CorpusReadiness =
  | { ready: true; counts: CorpusCounts }
  | { ready: false; reason: 'empty' | 'thin'; message: string; counts: CorpusCounts }

/**
 * Whether this corpus can support standing rules — and, when it cannot, a
 * sentence that says so plainly instead of an LLM call that invents rules.
 */
export function assessCorpus(counts: CorpusCounts): CorpusReadiness {
  const total = corpusTotal(counts)
  if (total === 0) {
    return {
      ready: false,
      reason: 'empty',
      counts,
      message:
        'Nothing to distil yet. Standing rules come from your own review history — review a few pull requests, write some comments, and run this again.',
    }
  }
  if (total < STANDING_RULES_MIN_CORPUS) {
    return {
      ready: false,
      reason: 'thin',
      counts,
      message: `Not enough signal yet — ${total} comments. A standing rule has to show up at least twice to be a pattern rather than a one-off, so this needs at least ${STANDING_RULES_MIN_CORPUS} before it can tell the difference.`,
    }
  }
  return { ready: true, counts }
}

/**
 * Rough input-token estimate for the cost preview. Prompt overhead is included
 * as a flat allowance so the number the user sees is not an undercount they
 * discover later on their bill.
 */
export function estimateCorpusTokens(corpus: StandingRulesCorpus): number {
  let chars = 0
  for (const c of corpus.reviewComments) chars += c.length
  for (const d of corpus.dismissals) chars += d.pattern.length + d.reason.length
  for (const d of corpus.drafts) chars += d.length
  for (const f of corpus.acceptedFindings) chars += f.length
  // ~900 tokens of system prompt + JSON scaffolding around the items.
  return Math.ceil(chars / CHARS_PER_TOKEN) + 900
}

// ---------------------------------------------------------------------------
// Dismissal stream — the #230 ledger, flattened across reviewers
// ---------------------------------------------------------------------------

/**
 * Every dismissed pattern across every reviewer, newest last.
 *
 * Flattened on purpose: WHICH persona raised a finding is a reviewer-side
 * concern. What matters to an author is that the user judged this class of
 * finding not worth acting on, whoever raised it.
 */
export function collectDismissals(): { pattern: string; reason: DismissReason }[] {
  const ledgers = listAllCalibration()
  const out: { pattern: string; reason: DismissReason; addedAt: number }[] = []
  for (const entries of Object.values(ledgers)) {
    for (const e of entries) out.push({ pattern: e.pattern, reason: e.reason, addedAt: e.addedAt })
  }
  out.sort((a, b) => a.addedAt - b.addedAt)
  return out.map(({ pattern, reason }) => ({ pattern, reason }))
}

// ---------------------------------------------------------------------------
// Draft stream — the user's own words
// ---------------------------------------------------------------------------

export interface DraftCorpus {
  /** Bodies the user typed themselves. */
  own: string[]
  /** Bodies accepted from an AI reviewer (aiAuthored). */
  accepted: string[]
}

function openDraftsDb(dbName: string): Promise<IDBDatabase | null> {
  const idb = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB
  if (!idb) return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = idb.open(dbName)
    } catch {
      resolve(null)
      return
    }
    // READ-ONLY harvest: never create or upgrade the schema. When the store is
    // missing (no draft was ever written) the result is an empty corpus, not a
    // database this module invented.
    req.onupgradeneeded = () => {
      try {
        req.transaction?.abort()
      } catch {
        // the abort itself failing still lands on onerror below
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/**
 * Every draft body on this machine, split by authorship, newest first and
 * capped at DRAFT_CORPUS_CAP.
 *
 * Returns empty streams when IndexedDB is unavailable or the store has never
 * been created — this is one input among several, never a hard failure.
 */
export async function collectDrafts(dbName = DRAFTS_DB_NAME): Promise<DraftCorpus> {
  const empty: DraftCorpus = { own: [], accepted: [] }
  const db = await openDraftsDb(dbName)
  if (!db) return empty
  if (!db.objectStoreNames.contains(DRAFTS_STORE_NAME)) return empty

  const rows: { body: string; aiAuthored: boolean; updatedAt: number }[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFTS_STORE_NAME, 'readonly')
      const req = tx.objectStore(DRAFTS_STORE_NAME).openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve()
          return
        }
        const value = cursor.value as Draft | undefined
        const body = typeof value?.body === 'string' ? value.body.trim() : ''
        if (body.length > 0) {
          rows.push({
            body,
            aiAuthored: value?.aiAuthored === true,
            updatedAt: typeof value?.updatedAt === 'number' ? value.updatedAt : 0,
          })
        }
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return empty
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  const own: string[] = []
  const accepted: string[] = []
  for (const row of rows) {
    const bucket = row.aiAuthored ? accepted : own
    if (bucket.length < DRAFT_CORPUS_CAP) bucket.push(row.body)
  }
  return { own, accepted }
}

// ---------------------------------------------------------------------------
// Full corpus assembly
// ---------------------------------------------------------------------------

/**
 * Which SCM account to harvest review comments from: the first configured
 * mining-capable provider, else GitHub.
 *
 * The same order and the same honest gap as mineSkill's own selector —
 * Bitbucket is absent because it has no account-scoped harvest, not because it
 * was forgotten. Note this is the REVIEW provider (where the comments live),
 * never the AI provider (which runs the distillation).
 */
export function harvestProviderId(): 'github' | 'gitlab' {
  if (githubProvider.authState().configured) return 'github'
  if (gitlabProvider.authState().configured) return 'gitlab'
  return 'github'
}

export interface CollectCorpusDeps {
  /** Override the resolved provider (tests). Defaults to the registry. */
  provider?: {
    id: string
    displayName: string
    authState(): { configured: boolean; hint: string }
    getMyAccountReviewComments?(cap: number, repoFilter?: { owner: string; repo: string }): Promise<string[]>
  }
  /** Override the draft harvest (tests). */
  collectDrafts?: () => Promise<DraftCorpus>
  /** Override the dismissal harvest (tests). */
  collectDismissals?: () => { pattern: string; reason: DismissReason }[]
}

export type CollectCorpusResult =
  | { ok: true; corpus: StandingRulesCorpus; counts: CorpusCounts; commentsError?: string }
  | { ok: false; error: string }

/**
 * Assemble the whole corpus.
 *
 * The review-comment harvest is BEST-EFFORT, not fatal: an unauthenticated or
 * rate-limited provider still leaves the dismissal ledger and the user's own
 * drafts, which are entirely local and often the better signal. The failure is
 * reported alongside the corpus (`commentsError`) so the UI can say the rules
 * were distilled from a partial history rather than pretending otherwise.
 *
 * It fails outright only when NOTHING could be gathered and the provider is
 * the reason — otherwise `assessCorpus` gives the honest empty/thin answer.
 */
export async function collectCorpus(
  providerId: string = harvestProviderId(),
  deps: CollectCorpusDeps = {},
): Promise<CollectCorpusResult> {
  const dismissals = (deps.collectDismissals ?? collectDismissals)()
  const drafts = await (deps.collectDrafts ?? collectDrafts)()

  let reviewComments: string[] = []
  let commentsError: string | undefined

  const provider = deps.provider ?? providerFor(providerId)
  if (typeof provider.getMyAccountReviewComments !== 'function') {
    commentsError = `Review comments aren't available for ${provider.displayName} yet — using your dismissals and drafts only.`
  } else {
    const auth = provider.authState()
    if (!auth.configured) {
      commentsError = auth.hint
    } else {
      try {
        reviewComments = await provider.getMyAccountReviewComments(MINE_COMMENTS_CAP)
      } catch (err) {
        commentsError = err instanceof Error ? err.message : 'Failed to fetch review comments.'
      }
    }
  }

  const corpus: StandingRulesCorpus = {
    reviewComments,
    dismissals,
    drafts: drafts.own,
    acceptedFindings: drafts.accepted,
  }
  return {
    ok: true,
    corpus,
    counts: countCorpus(corpus),
    ...(commentsError ? { commentsError } : {}),
  }
}
