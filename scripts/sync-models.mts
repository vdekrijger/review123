/**
 * scripts/sync-models.mts — keep the LLM model catalog current against
 * OpenRouter's PUBLIC models API (no auth).
 *
 * Usage (run directly, like eval/*.mts; Node runs .mts in this repo's CI):
 *   node scripts/sync-models.mts
 *
 * Structure: a PURE, TESTABLE core (`computeCatalogSync`) + a thin IO shell.
 * The core is unit-tested in scripts/sync-models.test.ts (no network). The
 * shell fetches upstream, calls the core, and — only when something drifted —
 * rewrites src/lib/llm/modelCatalog.ts and writes a markdown change summary to
 * stdout AND model-sync-changes.md (consumed as the PR body by the workflow).
 *
 * Loading note: like eval/run-eval.mts, this imports app code with
 * extensionless bundler-style relative imports, so MODEL_CATALOG is loaded
 * through a throwaway Vite SSR server (Node's native TS type-stripping cannot
 * resolve those). No app runtime behavior is touched — dev/CI tool only.
 */

// NOTE: keep this type local (structurally identical to LlmModelDef in
// src/lib/llm/providers.ts) so the PURE core + its tests never need to load app
// code through Vite. The IO shell loads the real MODEL_CATALOG at runtime.
export interface ModelDef {
  id: string
  label: string
  contextWindowTokens: number
  supportsTools?: boolean
  pricing?: { inputPer1M: number; outputPer1M: number }
}

export type ProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini'
export type Catalog = Record<ProviderId, ModelDef[]>

/** Raw shape of an OpenRouter /api/v1/models entry (only the fields we use). */
export interface OpenRouterModel {
  id: string
  context_length?: number | null
  pricing?: { prompt?: string | null; completion?: string | null } | null
  /** Unix SECONDS the model was added upstream — gates auto-additions. */
  created?: number | null
}

/**
 * Auto-add window. OpenRouter lists EVERY historical model (gpt-3.5, claude-2,
 * …), so "add everything we don't already list" would bulk-import ~100 obsolete
 * models. We keep a CURATED lineup: only models CREATED within this window are
 * auto-added — that captures genuinely-new releases fast (so we don't wait to
 * support them) without dragging in the back-catalog. Older upstream models we
 * don't list are deliberately skipped (curation is a human call). Pricing
 * updates and removal-flagging are independent of this window.
 */
export const ADD_RECENCY_DAYS = 60
const ADD_RECENCY_MS = ADD_RECENCY_DAYS * 24 * 60 * 60 * 1000

/** Our provider id → the OpenRouter model-id prefix that namespaces it. */
export const PROVIDER_PREFIX: Record<ProviderId, string> = {
  openai: 'openai/',
  deepseek: 'deepseek/',
  anthropic: 'anthropic/',
  gemini: 'google/',
}

/** Relative tolerance below which a pricing delta is treated as float noise. */
export const PRICING_TOLERANCE = 0.01

const PER_TOKEN_TO_PER_1M = 1_000_000

export interface PricingUpdate {
  providerId: ProviderId
  id: string
  oldPricing?: { inputPer1M: number; outputPer1M: number }
  newPricing: { inputPer1M: number; outputPer1M: number }
}

export interface AddedModel {
  providerId: ProviderId
  model: ModelDef
}

export interface MaybeRemoved {
  providerId: ProviderId
  id: string
}

export interface CatalogChanges {
  added: AddedModel[]
  pricingUpdated: PricingUpdate[]
  maybeRemoved: MaybeRemoved[]
}

export interface SyncResult {
  nextCatalog: Catalog
  changes: CatalogChanges
}

/** True when the changes object carries no actual drift. */
export function isEmptyChanges(c: CatalogChanges): boolean {
  return c.added.length === 0 && c.pricingUpdated.length === 0 && c.maybeRemoved.length === 0
}

/**
 * The bare model id of an upstream entry for a given provider prefix, or null
 * if it does not belong to that provider. Strips upstream variant suffixes
 * (e.g. `:free`, `:thinking`) so e.g. `openai/gpt-5.4:free` matches our
 * `gpt-5.4`.
 */
export function upstreamSuffixFor(prefix: string, upstreamId: string): string | null {
  if (!upstreamId.startsWith(prefix)) return null
  const afterPrefix = upstreamId.slice(prefix.length)
  // Drop a trailing `:variant` (OpenRouter routing variant), keep the model id.
  const colon = afterPrefix.indexOf(':')
  return colon === -1 ? afterPrefix : afterPrefix.slice(0, colon)
}

/** Convert an OpenRouter per-token decimal string to USD-per-1M, or null. */
function perTokenToPer1M(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return n * PER_TOKEN_TO_PER_1M
}

/** Upstream pricing → our pricing shape, or null when either side is missing. */
export function pricingFromUpstream(
  m: OpenRouterModel,
): { inputPer1M: number; outputPer1M: number } | null {
  const inputPer1M = perTokenToPer1M(m.pricing?.prompt)
  const outputPer1M = perTokenToPer1M(m.pricing?.completion)
  if (inputPer1M == null || outputPer1M == null) return null
  // Round to 4 decimals to keep emitted TS stable and human-readable.
  return { inputPer1M: round4(inputPer1M), outputPer1M: round4(outputPer1M) }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

/** True when two prices differ by more than the relative tolerance. */
function priceChanged(oldV: number, newV: number): boolean {
  if (oldV === newV) return false
  const denom = Math.max(Math.abs(oldV), Math.abs(newV), Number.EPSILON)
  return Math.abs(newV - oldV) / denom > PRICING_TOLERANCE
}

function pricingDrifted(
  oldP: { inputPer1M: number; outputPer1M: number } | undefined,
  newP: { inputPer1M: number; outputPer1M: number },
): boolean {
  if (!oldP) return true
  return priceChanged(oldP.inputPer1M, newP.inputPer1M) || priceChanged(oldP.outputPer1M, newP.outputPer1M)
}

/** Humanize a bare model id into a display label (best-effort, for new models). */
export function humanizeId(id: string): string {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) || part.length <= 2 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

const PROVIDER_IDS: ProviderId[] = ['deepseek', 'openai', 'anthropic', 'gemini']

/**
 * PURE core: given OpenRouter's `data[]` and the current catalog, compute the
 * next catalog + the set of changes. Deterministic and idempotent — the same
 * inputs always yield an identical nextCatalog (stable ordering: existing
 * models keep their position, additions append in upstream order) and empty
 * `changes` when nothing drifted.
 */
export function computeCatalogSync(
  openrouterModels: OpenRouterModel[],
  currentCatalog: Catalog,
  nowMs: number,
): SyncResult {
  const addCutoffSec = (nowMs - ADD_RECENCY_MS) / 1000
  const added: AddedModel[] = []
  const pricingUpdated: PricingUpdate[] = []
  const maybeRemoved: MaybeRemoved[] = []
  const nextCatalog = {} as Catalog

  for (const providerId of PROVIDER_IDS) {
    const prefix = PROVIDER_PREFIX[providerId]
    const current = currentCatalog[providerId] ?? []

    // Index upstream models that belong to this provider by their bare id.
    // First occurrence wins → deterministic regardless of upstream duplicates.
    const upstreamByBareId = new Map<string, OpenRouterModel>()
    for (const m of openrouterModels) {
      const bare = upstreamSuffixFor(prefix, m.id)
      if (bare != null && !upstreamByBareId.has(bare)) upstreamByBareId.set(bare, m)
    }

    const nextModels: ModelDef[] = []
    const seenIds = new Set<string>()

    // 1) Existing models keep their order; update pricing on drift.
    for (const model of current) {
      seenIds.add(model.id)
      const upstream = upstreamByBareId.get(model.id)
      if (!upstream) {
        maybeRemoved.push({ providerId, id: model.id })
        nextModels.push(model) // DO NOT delete — flapping is worse.
        continue
      }
      const newPricing = pricingFromUpstream(upstream)
      if (newPricing && pricingDrifted(model.pricing, newPricing)) {
        pricingUpdated.push({ providerId, id: model.id, oldPricing: model.pricing, newPricing })
        nextModels.push({ ...model, pricing: newPricing })
      } else {
        nextModels.push(model)
      }
    }

    // 2) New upstream models we don't list → ADD, but ONLY when recently
    //    created (see ADD_RECENCY_DAYS). This avoids importing OpenRouter's
    //    entire historical back-catalog while still picking up fresh releases.
    for (const m of openrouterModels) {
      const bare = upstreamSuffixFor(prefix, m.id)
      if (bare == null || seenIds.has(bare)) continue
      // Skip models with no created timestamp or older than the window.
      if (m.created == null || m.created < addCutoffSec) continue
      seenIds.add(bare)
      const newModel: ModelDef = {
        id: bare,
        label: humanizeId(bare),
        contextWindowTokens: m.context_length ?? 0,
      }
      const pricing = pricingFromUpstream(m)
      if (pricing) newModel.pricing = pricing
      added.push({ providerId, model: newModel })
      nextModels.push(newModel)
    }

    nextCatalog[providerId] = nextModels
  }

  return { nextCatalog, changes: { added, pricingUpdated, maybeRemoved } }
}

/** Render a markdown summary of the changes for the PR body / stdout. */
export function renderChangesMarkdown(changes: CatalogChanges): string {
  const lines: string[] = ['## Model catalog sync', '']
  const money = (p: { inputPer1M: number; outputPer1M: number }) => `$${p.inputPer1M}/$${p.outputPer1M} per 1M`

  if (changes.added.length) {
    lines.push(`### Added (${changes.added.length})`, '')
    for (const a of changes.added) {
      const price = a.model.pricing ? ` — ${money(a.model.pricing)}` : ''
      lines.push(`- \`${a.providerId}\` / \`${a.model.id}\` (${a.model.contextWindowTokens} ctx)${price}`)
    }
    lines.push('')
  }
  if (changes.pricingUpdated.length) {
    lines.push(`### Pricing updated (${changes.pricingUpdated.length})`, '')
    for (const u of changes.pricingUpdated) {
      const oldStr = u.oldPricing ? money(u.oldPricing) : '(none)'
      lines.push(`- \`${u.providerId}\` / \`${u.id}\`: ${oldStr} → ${money(u.newPricing)}`)
    }
    lines.push('')
  }
  if (changes.maybeRemoved.length) {
    lines.push(`### Maybe removed — absent upstream, KEPT for human review (${changes.maybeRemoved.length})`, '')
    for (const r of changes.maybeRemoved) {
      lines.push(`- \`${r.providerId}\` / \`${r.id}\``)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// TS emission — rewrite src/lib/llm/modelCatalog.ts from a computed catalog.
// Matches the hand-authored format (one model per line, omitted optional
// fields stay omitted) so diffs are minimal and human-readable.
// ---------------------------------------------------------------------------

/** Render a single LlmModelDef entry as a one-line TS object literal. */
export function serializeModel(m: ModelDef): string {
  const parts = [`id: ${JSON.stringify(m.id)}`, `label: ${JSON.stringify(m.label)}`, `contextWindowTokens: ${m.contextWindowTokens}`]
  if (m.supportsTools !== undefined) parts.push(`supportsTools: ${m.supportsTools}`)
  if (m.pricing) parts.push(`pricing: { inputPer1M: ${m.pricing.inputPer1M}, outputPer1M: ${m.pricing.outputPer1M} }`)
  return `    { ${parts.join(', ')} },`
}

const CATALOG_PROVIDER_ORDER: ProviderId[] = ['deepseek', 'openai', 'anthropic', 'gemini']

/** Render the full modelCatalog.ts source from a computed catalog. */
export function serializeCatalog(catalog: Catalog): string {
  const header = `/**
 * Model catalog — the per-provider MODEL LIST, extracted from providers.ts so a
 * sync script (scripts/sync-models.mts) can regenerate it deterministically
 * against OpenRouter's public models API.
 *
 * This file is the SINGLE SOURCE OF TRUTH for model ids / labels / context
 * windows / pricing / tool-support. providers.ts wires each provider's \`models\`
 * from MODEL_CATALOG[id] and authors everything else (id, displayName,
 * transport, baseUrl, defaultModel, keyHint, maxTokensParam) itself — those
 * provider-level fields NEVER live here and are out of scope for the sync.
 *
 * Human-readable TS (not JSON) on purpose: the typing and the pricing-source /
 * deprecation comments are load-bearing context. The sync script rewrites this
 * file from a computed catalog when upstream drifts; hand-edited comments on
 * existing entries are NOT preserved across an automated rewrite.
 *
 * AUTO-GENERATED region: the MODEL_CATALOG below is regenerated by
 * scripts/sync-models.mts. Prefer editing via that script.
 */

import type { LlmModelDef, LlmProviderId } from './providers'

export const MODEL_CATALOG: Record<LlmProviderId, LlmModelDef[]> = {`

  const blocks = CATALOG_PROVIDER_ORDER.map((id) => {
    const rows = (catalog[id] ?? []).map(serializeModel).join('\n')
    return `  ${id}: [\n${rows}\n  ],`
  })

  return `${header}\n${blocks.join('\n')}\n}\n`
}

// ---------------------------------------------------------------------------
// IO shell — only runs when executed directly (not when imported by tests).
// ---------------------------------------------------------------------------

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const NO_CHANGES_MARKER = 'MODEL_SYNC_NO_CHANGES'

async function main(): Promise<void> {
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const { writeFileSync } = await import('node:fs')
  const { createServer } = await import('vite')

  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..')
  const catalogPath = join(repoRoot, 'src/lib/llm/modelCatalog.ts')
  const changesPath = join(repoRoot, 'model-sync-changes.md')

  // Load the real MODEL_CATALOG through a throwaway Vite SSR server so the
  // extensionless app imports resolve (Node's type-stripping cannot).
  const server = await createServer({ root: repoRoot, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
  let currentCatalog: Catalog
  try {
    const mod = (await server.ssrLoadModule('/src/lib/llm/modelCatalog.ts')) as { MODEL_CATALOG: Catalog }
    currentCatalog = mod.MODEL_CATALOG
  } finally {
    await server.close()
  }

  console.log(`Fetching ${OPENROUTER_MODELS_URL} …`)
  const res = await fetch(OPENROUTER_MODELS_URL)
  if (!res.ok) {
    console.error(`OpenRouter request failed: ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  const body = (await res.json()) as { data?: OpenRouterModel[] }
  const upstream = Array.isArray(body.data) ? body.data : []
  console.log(`Received ${upstream.length} upstream models.`)

  const { nextCatalog, changes } = computeCatalogSync(upstream, currentCatalog, Date.now())

  if (isEmptyChanges(changes)) {
    console.log(`${NO_CHANGES_MARKER}: catalog already current — no drift.`)
    writeFileSync(changesPath, `## Model catalog sync\n\nNo drift — catalog already current.\n`)
    process.exit(0)
  }

  const markdown = renderChangesMarkdown(changes)
  writeFileSync(catalogPath, serializeCatalog(nextCatalog))
  writeFileSync(changesPath, `${markdown}\n`)
  console.log(markdown)
  console.log(`\nRewrote ${catalogPath}`)
  process.exit(0)
}

// Run only when executed as a script (import.meta.main is true), not on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
