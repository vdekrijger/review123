/**
 * Lab grouping + filtering helpers for the searchable OpenRouter model picker.
 *
 * OpenRouter slugs are vendor-namespaced (`lab/model`). We group the picker by
 * the prefix before the first `/`, mapped to a friendly lab name. Pure +
 * unit-tested so the combobox component stays thin.
 */

import type { LlmModelDef } from './providers'

/** Known prefix → friendly lab name. Fallback = title-cased prefix. */
const LAB_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'x-ai': 'xAI',
  'meta-llama': 'Meta Llama',
  mistralai: 'Mistral',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  'z-ai': 'Z.ai',
  nvidia: 'NVIDIA',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot AI',
  amazon: 'Amazon',
  perplexity: 'Perplexity',
  cohere: 'Cohere',
  microsoft: 'Microsoft',
  'arcee-ai': 'Arcee AI',
  'aion-labs': 'AION Labs',
  nousresearch: 'Nous Research',
  'bytedance-seed': 'ByteDance Seed',
  bytedance: 'ByteDance',
  inclusionai: 'Inclusion AI',
  xiaomi: 'Xiaomi',
  liquid: 'Liquid',
  stepfun: 'StepFun',
  'ibm-granite': 'IBM Granite',
  tencent: 'Tencent',
  rekaai: 'Reka AI',
  inflection: 'Inflection',
  ai21: 'AI21',
  baidu: 'Baidu',
  openrouter: 'OpenRouter',
  thedrummer: 'TheDrummer',
  sao10k: 'Sao10K',
  cognitivecomputations: 'Cognitive Computations',
  allenai: 'Allen AI',
}

/** The slug prefix before the first `/` (the lab key), or '' if none. */
export function labKey(modelId: string): string {
  const slash = modelId.indexOf('/')
  return slash === -1 ? '' : modelId.slice(0, slash)
}

/** Title-case a hyphenated/underscored prefix as a fallback lab name. */
function titleCase(prefix: string): string {
  return prefix
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** Friendly lab name for a slug (mapped, else title-cased prefix, else "Other"). */
export function labName(modelId: string): string {
  const key = labKey(modelId)
  if (!key) return 'Other'
  // Strip a leading `~` (OpenRouter "latest"-alias namespaces) for the lookup.
  const bare = key.startsWith('~') ? key.slice(1) : key
  const mapped = LAB_NAMES[bare]
  if (mapped) return key.startsWith('~') ? `${mapped} (latest)` : mapped
  return titleCase(key)
}

/** Case-insensitive match of a query against a model's slug AND label. */
export function modelMatches(model: LlmModelDef, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return model.id.toLowerCase().includes(q) || model.label.toLowerCase().includes(q)
}

export interface ModelGroup {
  lab: string
  models: LlmModelDef[]
}

/**
 * Group models by lab, preserving each model's incoming order within its group
 * and ordering groups by first appearance. Stable + deterministic.
 */
export function groupByLab(models: LlmModelDef[]): ModelGroup[] {
  const order: string[] = []
  const byLab = new Map<string, LlmModelDef[]>()
  for (const m of models) {
    const lab = labName(m.id)
    if (!byLab.has(lab)) {
      byLab.set(lab, [])
      order.push(lab)
    }
    byLab.get(lab)!.push(m)
  }
  return order.map((lab) => ({ lab, models: byLab.get(lab)! }))
}

/**
 * The list the combobox shows for a query: empty query → featured models (in
 * catalog order); otherwise every model matching the query (slug OR label).
 * Falls back to all models when nothing is flagged featured.
 */
export function visibleModels(models: LlmModelDef[], query: string): LlmModelDef[] {
  if (query.trim()) return models.filter((m) => modelMatches(m, query))
  const featured = models.filter((m) => m.featured)
  return featured.length ? featured : models
}

/** The models flagged `featured` (in catalog order). Empty if none are flagged. */
export function featuredModels(models: LlmModelDef[]): LlmModelDef[] {
  return models.filter((m) => m.featured)
}

/** The synthetic key the two-column picker uses for its "Featured" pseudo-lab. */
export const FEATURED_LAB = 'Featured'

export interface LabOption {
  /** The lab name (or FEATURED_LAB for the leading "Featured" entry). */
  lab: string
  /** Models in this lab (the featured set for FEATURED_LAB). */
  models: LlmModelDef[]
  /** True for the synthetic "Featured" entry. */
  featured: boolean
}

/**
 * The left-column entries for the two-column browse view: a leading "Featured"
 * entry (only when some models are flagged), then one entry per real lab in
 * `groupByLab` order. Each carries its model count for the count badge.
 */
export function labOptions(models: LlmModelDef[]): LabOption[] {
  const out: LabOption[] = []
  const featured = featuredModels(models)
  if (featured.length) out.push({ lab: FEATURED_LAB, models: featured, featured: true })
  for (const g of groupByLab(models)) out.push({ lab: g.lab, models: g.models, featured: false })
  return out
}

/** Compact muted hint for an option: context window + $in/$out per 1M. */
export function modelHint(model: LlmModelDef): string {
  const parts: string[] = []
  if (model.contextWindowTokens > 0) {
    const k = Math.round(model.contextWindowTokens / 1000)
    parts.push(k >= 1000 ? `${(k / 1000).toFixed(k % 1000 === 0 ? 0 : 1)}M ctx` : `${k}K ctx`)
  }
  if (model.pricing) parts.push(`$${model.pricing.inputPer1M}/$${model.pricing.outputPer1M} per 1M`)
  return parts.join(' · ')
}
