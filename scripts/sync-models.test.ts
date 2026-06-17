import { describe, it, expect } from 'vitest'
import {
  computeCatalogSync,
  isEmptyChanges,
  serializeModel,
  serializeCatalog,
  serializeOpenrouterCatalog,
  computeOpenrouterCatalog,
  isChatModel,
  supportsToolsFromUpstream,
  humanizeId,
  upstreamSuffixFor,
  type Catalog,
  type OpenRouterModel,
} from './sync-models.mts'

// A small, self-contained catalog so the tests never touch the real one or the
// network. Mirrors the LlmModelDef shape exactly.
function baseCatalog(): Catalog {
  return {
    deepseek: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } }],
    openai: [{ id: 'gpt-5.4', label: 'GPT-5.4', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 2.5, outputPer1M: 15 } }],
    anthropic: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 3, outputPer1M: 15 } }],
    gemini: [{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 1.5, outputPer1M: 9 } }],
  }
}

// Per-token decimal strings, as OpenRouter returns them. price1M / 1e6.
function perToken(per1M: number): string {
  return String(per1M / 1_000_000)
}

// Fixed clock so recency-gated additions are deterministic.
const NOW_MS = 1_781_000_000_000
const DAY_SEC = 24 * 60 * 60
const RECENT_CREATED = Math.floor(NOW_MS / 1000) - 5 * DAY_SEC // within the 60-day add window
const OLD_CREATED = Math.floor(NOW_MS / 1000) - 200 * DAY_SEC // outside the window

/** Upstream entry that exactly matches a catalog model's current pricing. */
function upstreamMatching(id: string, inPer1M: number, outPer1M: number, ctx = 1_000_000): OpenRouterModel {
  return { id, context_length: ctx, created: RECENT_CREATED, pricing: { prompt: perToken(inPer1M), completion: perToken(outPer1M) } }
}

/** A full upstream list that matches baseCatalog() with no drift. */
function upstreamNoDrift(): OpenRouterModel[] {
  return [
    upstreamMatching('deepseek/deepseek-v4-flash', 0.14, 0.28),
    upstreamMatching('openai/gpt-5.4', 2.5, 15),
    upstreamMatching('anthropic/claude-sonnet-4-6', 3, 15),
    upstreamMatching('google/gemini-3.5-flash', 1.5, 9, 1_048_576),
  ]
}

describe('computeCatalogSync — additions', () => {
  it('adds a new upstream model not in the catalog', () => {
    const upstream = [...upstreamNoDrift(), upstreamMatching('openai/gpt-6', 10, 40, 2_000_000)]
    const { nextCatalog, changes } = computeCatalogSync(upstream, baseCatalog(), NOW_MS)

    expect(changes.added).toHaveLength(1)
    expect(changes.added[0]).toMatchObject({ providerId: 'openai', model: { id: 'gpt-6', contextWindowTokens: 2_000_000, pricing: { inputPer1M: 10, outputPer1M: 40 } } })
    expect(changes.pricingUpdated).toHaveLength(0)
    expect(changes.maybeRemoved).toHaveLength(0)
    // Present in nextCatalog, appended after the existing model.
    expect(nextCatalog.openai.map((m) => m.id)).toEqual(['gpt-5.4', 'gpt-6'])
  })

  it('matches suffix-variant upstream ids (ignores :free) when adding', () => {
    const upstream = [...upstreamNoDrift(), { id: 'deepseek/deepseek-v4-pro:free', context_length: 1_000_000, created: RECENT_CREATED, pricing: { prompt: '0', completion: '0' } }]
    const { changes } = computeCatalogSync(upstream, baseCatalog(), NOW_MS)
    expect(changes.added.map((a) => a.model.id)).toContain('deepseek-v4-pro')
  })

  it('does NOT add an upstream model created before the recency window (avoids back-catalog bloat)', () => {
    const oldModel: OpenRouterModel = { id: 'openai/gpt-3.5-turbo', context_length: 16_000, created: OLD_CREATED, pricing: { prompt: '0.0000005', completion: '0.0000015' } }
    const { nextCatalog, changes } = computeCatalogSync([...upstreamNoDrift(), oldModel], baseCatalog(), NOW_MS)
    expect(changes.added).toHaveLength(0)
    expect(nextCatalog.openai.map((m) => m.id)).toEqual(['gpt-5.4'])
  })

  it('does NOT add an upstream model with no created timestamp', () => {
    const noTs: OpenRouterModel = { id: 'openai/mystery-model', context_length: 16_000, pricing: { prompt: '0.000001', completion: '0.000002' } }
    const { changes } = computeCatalogSync([...upstreamNoDrift(), noTs], baseCatalog(), NOW_MS)
    expect(changes.added).toHaveLength(0)
  })
})

describe('computeCatalogSync — pricing', () => {
  it('flags pricing drift beyond tolerance as pricingUpdated', () => {
    const upstream = upstreamNoDrift()
    // openai gpt-5.4: bump input 2.5 -> 5 (100% > 1%).
    upstream[1] = upstreamMatching('openai/gpt-5.4', 5, 15)
    const { nextCatalog, changes } = computeCatalogSync(upstream, baseCatalog(), NOW_MS)

    expect(changes.pricingUpdated).toHaveLength(1)
    expect(changes.pricingUpdated[0]).toMatchObject({ id: 'gpt-5.4', oldPricing: { inputPer1M: 2.5, outputPer1M: 15 }, newPricing: { inputPer1M: 5, outputPer1M: 15 } })
    expect(nextCatalog.openai[0].pricing).toEqual({ inputPer1M: 5, outputPer1M: 15 })
    expect(changes.added).toHaveLength(0)
  })

  it('ignores sub-tolerance pricing wobble (<= 1%)', () => {
    const upstream = upstreamNoDrift()
    // gpt-5.4 input 2.5 -> 2.51 (0.4% < 1%).
    upstream[1] = upstreamMatching('openai/gpt-5.4', 2.51, 15)
    const { changes } = computeCatalogSync(upstream, baseCatalog(), NOW_MS)
    expect(changes.pricingUpdated).toHaveLength(0)
  })
})

describe('computeCatalogSync — maybeRemoved', () => {
  it('flags catalog models absent upstream but KEEPS them in nextCatalog', () => {
    const upstream = upstreamNoDrift().filter((m) => m.id !== 'anthropic/claude-sonnet-4-6')
    const { nextCatalog, changes } = computeCatalogSync(upstream, baseCatalog(), NOW_MS)

    expect(changes.maybeRemoved).toEqual([{ providerId: 'anthropic', id: 'claude-sonnet-4-6' }])
    // Still present — we never delete (flapping is worse).
    expect(nextCatalog.anthropic.map((m) => m.id)).toContain('claude-sonnet-4-6')
    expect(nextCatalog.anthropic[0]).toEqual(baseCatalog().anthropic[0])
  })
})

describe('computeCatalogSync — idempotence & scope', () => {
  it('no drift → empty changes and nextCatalog deep-equals input', () => {
    const input = baseCatalog()
    const { nextCatalog, changes } = computeCatalogSync(upstreamNoDrift(), input, NOW_MS)
    expect(isEmptyChanges(changes)).toBe(true)
    expect(nextCatalog).toEqual(input)
  })

  it('is idempotent: feeding nextCatalog back yields no further changes', () => {
    const upstream = [...upstreamNoDrift(), upstreamMatching('openai/gpt-6', 10, 40, 2_000_000)]
    const first = computeCatalogSync(upstream, baseCatalog(), NOW_MS)
    const second = computeCatalogSync(upstream, first.nextCatalog, NOW_MS)
    expect(isEmptyChanges(second.changes)).toBe(true)
    expect(second.nextCatalog).toEqual(first.nextCatalog)
  })

  it('never touches provider-level fields (catalog only carries models)', () => {
    // The core operates purely on model arrays — there is no defaultModel /
    // baseUrl key to mutate. Guard that no extra keys leak in.
    const { nextCatalog } = computeCatalogSync(upstreamNoDrift(), baseCatalog(), NOW_MS)
    expect(Object.keys(nextCatalog).sort()).toEqual(['anthropic', 'deepseek', 'gemini', 'openai'])
    for (const models of Object.values(nextCatalog)) {
      for (const m of models) {
        expect(Object.keys(m).every((k) => ['id', 'label', 'contextWindowTokens', 'supportsTools', 'pricing'].includes(k))).toBe(true)
      }
    }
  })

  it('preserves supports: false flags on existing models', () => {
    const catalog = baseCatalog()
    catalog.deepseek.push({ id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (legacy)', contextWindowTokens: 1_000_000, supportsTools: false })
    const upstream = [...upstreamNoDrift(), upstreamMatching('deepseek/deepseek-reasoner', 0.5, 1.5)]
    const { nextCatalog } = computeCatalogSync(upstream, catalog, NOW_MS)
    const reasoner = nextCatalog.deepseek.find((m) => m.id === 'deepseek-reasoner')
    // Pricing was absent before; gets added. supportsTools:false survives.
    expect(reasoner?.supportsTools).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// OpenRouter FULL catalog generation (the searchable picker's data source).
// ---------------------------------------------------------------------------

/** An upstream chat entry (text in, text out) with explicit fields. */
function orModel(id: string, opts: Partial<OpenRouterModel> & { in?: number; out?: number; tools?: boolean } = {}): OpenRouterModel {
  const { in: inP = 1, out: outP = 2, tools = true, ...rest } = opts
  return {
    id,
    name: rest.name ?? id,
    context_length: rest.context_length ?? 128_000,
    architecture: rest.architecture ?? { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: rest.supported_parameters ?? (tools ? ['tools', 'temperature'] : ['temperature']),
    pricing: rest.pricing ?? { prompt: perToken(inP), completion: perToken(outP) },
    ...rest,
  }
}

describe('computeOpenrouterCatalog — full lineup', () => {
  it('includes the FULL upstream chat lineup (NOT recency-gated)', () => {
    // Even an ancient model (no created timestamp / old) is included — the
    // recency gate is for the curated providers only.
    const upstream = [
      orModel('openai/gpt-5.5', { name: 'OpenAI: GPT-5.5' }),
      orModel('anthropic/claude-opus-4.8', { name: 'Anthropic: Claude Opus 4.8' }),
      orModel('meta-llama/llama-2-70b', { name: 'Meta: Llama 2 70B', created: 0 }),
    ]
    const { models } = computeOpenrouterCatalog(upstream, [])
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-5.5', 'anthropic/claude-opus-4.8', 'meta-llama/llama-2-70b'])
  })

  it('uses upstream name as the label and converts per-token pricing to per-1M', () => {
    const upstream = [orModel('openai/gpt-5.5', { name: 'OpenAI: GPT-5.5', in: 5, out: 30, context_length: 400_000 })]
    const { models } = computeOpenrouterCatalog(upstream, [])
    expect(models[0]).toMatchObject({
      id: 'openai/gpt-5.5',
      label: 'OpenAI: GPT-5.5',
      contextWindowTokens: 400_000,
      pricing: { inputPer1M: 5, outputPer1M: 30 },
    })
  })

  it('sets supportsTools from upstream supported_parameters', () => {
    const upstream = [
      orModel('a/with-tools', { tools: true }),
      orModel('b/no-tools', { tools: false }),
    ]
    const { models } = computeOpenrouterCatalog(upstream, [])
    expect(models.find((m) => m.id === 'a/with-tools')!.supportsTools).toBe(true)
    expect(models.find((m) => m.id === 'b/no-tools')!.supportsTools).toBe(false)
  })

  it('preserves featured flags from the stable featured-id list', () => {
    const upstream = [
      orModel('openai/gpt-5.5'),
      orModel('openai/gpt-5-mini'),
      orModel('anthropic/claude-opus-4.8'),
    ]
    const { models, foundFeatured, missingFeatured } = computeOpenrouterCatalog(upstream, ['openai/gpt-5.5', 'anthropic/claude-opus-4.8'])
    expect(models.find((m) => m.id === 'openai/gpt-5.5')!.featured).toBe(true)
    expect(models.find((m) => m.id === 'anthropic/claude-opus-4.8')!.featured).toBe(true)
    expect(models.find((m) => m.id === 'openai/gpt-5-mini')!.featured).toBeUndefined()
    expect(foundFeatured).toEqual(['openai/gpt-5.5', 'anthropic/claude-opus-4.8'])
    expect(missingFeatured).toEqual([])
  })

  it('featured survives a regen (idempotent re-application)', () => {
    const upstream = [orModel('openai/gpt-5.5'), orModel('x/y')]
    const featured = ['openai/gpt-5.5']
    const first = computeOpenrouterCatalog(upstream, featured)
    const second = computeOpenrouterCatalog(upstream, featured)
    expect(first.models).toEqual(second.models)
    expect(second.models.find((m) => m.id === 'openai/gpt-5.5')!.featured).toBe(true)
  })

  it('drops a featured slug that disappeared upstream and reports it', () => {
    const upstream = [orModel('openai/gpt-5.5')]
    const { foundFeatured, missingFeatured } = computeOpenrouterCatalog(upstream, ['openai/gpt-5.5', 'gone/model'])
    expect(foundFeatured).toEqual(['openai/gpt-5.5'])
    expect(missingFeatured).toEqual(['gone/model'])
  })

  it('skips non-chat models (image/audio output) and negative-priced router meta-models', () => {
    const upstream = [
      orModel('openai/gpt-5.5'),
      orModel('media/image-gen', { architecture: { modality: 'text->image', input_modalities: ['text'], output_modalities: ['image'] } }),
      orModel('embed/only', { architecture: { modality: 'text->embedding', input_modalities: ['text'], output_modalities: ['embedding'] } }),
      orModel('openrouter/auto', { pricing: { prompt: '-1', completion: '-1' } }),
    ]
    const { models } = computeOpenrouterCatalog(upstream, [])
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-5.5'])
  })

  it('dedupes upstream duplicates (first occurrence wins)', () => {
    const upstream = [orModel('openai/gpt-5.5', { in: 5 }), orModel('openai/gpt-5.5', { in: 99 })]
    const { models } = computeOpenrouterCatalog(upstream, [])
    expect(models).toHaveLength(1)
    expect(models[0].pricing).toEqual({ inputPer1M: 5, outputPer1M: 2 })
  })
})

describe('isChatModel / supportsToolsFromUpstream', () => {
  it('keeps text->text and drops non-text-output models', () => {
    expect(isChatModel(orModel('a/b'))).toBe(true)
    expect(isChatModel(orModel('a/img', { architecture: { output_modalities: ['image'], input_modalities: ['text'] } }))).toBe(false)
  })
  it('treats missing architecture as chat', () => {
    expect(isChatModel({ id: 'a/b', pricing: { prompt: '1', completion: '1' } })).toBe(true)
  })
  it('rejects negative (dynamic) pricing', () => {
    expect(isChatModel(orModel('openrouter/auto', { pricing: { prompt: '-1', completion: '0' } }))).toBe(false)
  })
  it('reads tools from supported_parameters', () => {
    expect(supportsToolsFromUpstream(orModel('a/b', { tools: true }))).toBe(true)
    expect(supportsToolsFromUpstream(orModel('a/b', { tools: false }))).toBe(false)
  })
})

describe('serializeOpenrouterCatalog', () => {
  it('emits the AUTO-GENERATED header + OPENROUTER_MODELS export with featured flag', () => {
    const { models } = computeOpenrouterCatalog([orModel('openai/gpt-5.5', { name: 'OpenAI: GPT-5.5' })], ['openai/gpt-5.5'])
    const out = serializeOpenrouterCatalog(models)
    expect(out).toContain('AUTO-GENERATED by scripts/sync-models.mts')
    expect(out).toContain("import type { LlmModelDef } from './providers'")
    expect(out).toContain('export const OPENROUTER_MODELS: LlmModelDef[] = [')
    expect(out).toContain('id: "openai/gpt-5.5"')
    expect(out).toContain('featured: true')
  })
})

describe('serializeCatalog — openrouter reference', () => {
  it('references the imported OPENROUTER_MODELS rather than inlining the lineup', () => {
    const out = serializeCatalog(baseCatalog())
    expect(out).toContain("import { OPENROUTER_MODELS } from './openrouterCatalog.generated'")
    expect(out).toContain('openrouter: OPENROUTER_MODELS,')
  })
})

describe('serializeModel — featured', () => {
  it('emits featured: true only when set', () => {
    expect(serializeModel({ id: 'a', label: 'A', contextWindowTokens: 1, featured: true })).toContain('featured: true')
    expect(serializeModel({ id: 'a', label: 'A', contextWindowTokens: 1 })).not.toContain('featured')
  })
})

describe('helpers', () => {
  it('upstreamSuffixFor strips prefix and :variant', () => {
    expect(upstreamSuffixFor('openai/', 'openai/gpt-5.4')).toBe('gpt-5.4')
    expect(upstreamSuffixFor('openai/', 'openai/gpt-5.4:free')).toBe('gpt-5.4')
    expect(upstreamSuffixFor('openai/', 'google/gemini-3.5-flash')).toBeNull()
  })

  it('humanizeId produces a readable label', () => {
    expect(humanizeId('gpt-6')).toBe('Gpt 6')
    expect(humanizeId('claude-opus-4-8')).toBe('Claude Opus 4 8')
  })

  it('serializeModel emits a one-line TS literal, omitting absent optionals', () => {
    expect(serializeModel({ id: 'x', label: 'X', contextWindowTokens: 100 })).toBe('    { id: "x", label: "X", contextWindowTokens: 100 },')
    expect(serializeModel({ id: 'x', label: 'X', contextWindowTokens: 100, supportsTools: false, pricing: { inputPer1M: 1, outputPer1M: 2 } })).toBe('    { id: "x", label: "X", contextWindowTokens: 100, supportsTools: false, pricing: { inputPer1M: 1, outputPer1M: 2 } },')
  })

  it('serializeCatalog round-trips a catalog into valid TS with all provider keys', () => {
    const out = serializeCatalog(baseCatalog())
    expect(out).toContain("import type { LlmModelDef, LlmProviderId } from './providers'")
    expect(out).toContain('export const MODEL_CATALOG: Record<LlmProviderId, LlmModelDef[]> = {')
    for (const id of ['deepseek', 'openai', 'anthropic', 'gemini']) expect(out).toContain(`  ${id}: [`)
    expect(out).toContain('id: "gpt-5.4"')
  })
})
