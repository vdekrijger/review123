import { describe, it, expect } from 'vitest'
import { labKey, labName, modelMatches, groupByLab, visibleModels, modelHint, featuredModels, labOptions, FEATURED_LAB } from './modelLabs'
import type { LlmModelDef } from './providers'

const m = (id: string, label: string, extra: Partial<LlmModelDef> = {}): LlmModelDef =>
  ({ id, label, contextWindowTokens: 128_000, ...extra })

describe('labKey / labName', () => {
  it('extracts the slug prefix before the first slash', () => {
    expect(labKey('openai/gpt-5.5')).toBe('openai')
    expect(labKey('meta-llama/llama-3.3-70b-instruct')).toBe('meta-llama')
    expect(labKey('no-slash')).toBe('')
  })

  it('maps known prefixes to friendly names', () => {
    expect(labName('openai/gpt-5.5')).toBe('OpenAI')
    expect(labName('anthropic/claude-opus-4.8')).toBe('Anthropic')
    expect(labName('x-ai/grok-4.3')).toBe('xAI')
    expect(labName('meta-llama/llama-3.3-70b-instruct')).toBe('Meta Llama')
    expect(labName('deepseek/deepseek-chat-v3.1')).toBe('DeepSeek')
  })

  it('title-cases an unknown prefix as a fallback', () => {
    expect(labName('some-new-lab/model-x')).toBe('Some New Lab')
  })

  it('flags ~latest alias namespaces', () => {
    expect(labName('~anthropic/claude-fable-latest')).toBe('Anthropic (latest)')
  })
})

describe('modelMatches', () => {
  const model = m('openai/gpt-5.5', 'OpenAI: GPT-5.5')
  it('matches on slug (case-insensitive)', () => {
    expect(modelMatches(model, 'GPT-5')).toBe(true)
    expect(modelMatches(model, 'openai/')).toBe(true)
  })
  it('matches on label', () => {
    expect(modelMatches(model, 'gpt-5.5')).toBe(true)
  })
  it('an empty query matches everything', () => {
    expect(modelMatches(model, '   ')).toBe(true)
  })
  it('non-matching query returns false', () => {
    expect(modelMatches(model, 'gemini')).toBe(false)
  })
})

describe('groupByLab', () => {
  it('groups models by friendly lab, ordering groups by first appearance', () => {
    const groups = groupByLab([
      m('openai/gpt-5', 'OpenAI: GPT-5'),
      m('anthropic/claude-opus-4.8', 'Anthropic: Claude Opus 4.8'),
      m('openai/gpt-5.5', 'OpenAI: GPT-5.5'),
    ])
    // Group order = first appearance (OpenAI seen before Anthropic).
    expect(groups.map((g) => g.lab)).toEqual(['OpenAI', 'Anthropic'])
    // Within a lab: newest version first (5.5 before 5).
    expect(groups[0].models.map((x) => x.id)).toEqual(['openai/gpt-5.5', 'openai/gpt-5'])
  })

  it('orders a lab newest-version-first, numerically (Qwen 3.7 > 3.6 > 2.5)', () => {
    const groups = groupByLab([
      m('qwen/qwen-2.5-72b', 'Qwen: Qwen2.5 72B'),
      m('qwen/qwen3.7-plus', 'Qwen: Qwen3.7 Plus'),
      m('qwen/qwen3.6', 'Qwen: Qwen3.6'),
      m('qwen/qwen3.10', 'Qwen: Qwen3.10'),
    ])
    // 3.10 sorts above 3.7 numerically (not lexically), then 3.6, then 2.5.
    expect(groups[0].models.map((x) => x.label)).toEqual([
      'Qwen: Qwen3.10',
      'Qwen: Qwen3.7 Plus',
      'Qwen: Qwen3.6',
      'Qwen: Qwen2.5 72B',
    ])
  })
})

describe('visibleModels', () => {
  const list = [
    m('openai/gpt-5.5', 'GPT-5.5', { featured: true }),
    m('openai/gpt-5-mini', 'Mini'),
    m('anthropic/claude-opus-4.8', 'Opus', { featured: true }),
  ]
  it('empty query returns ONLY featured models', () => {
    expect(visibleModels(list, '').map((x) => x.id)).toEqual(['openai/gpt-5.5', 'anthropic/claude-opus-4.8'])
  })
  it('a query returns all matches regardless of featured', () => {
    expect(visibleModels(list, 'gpt-5').map((x) => x.id)).toEqual(['openai/gpt-5.5', 'openai/gpt-5-mini'])
  })
  it('falls back to all models when none are featured', () => {
    const none = [m('a/x', 'X'), m('a/y', 'Y')]
    expect(visibleModels(none, '')).toHaveLength(2)
  })
})

describe('featuredModels / labOptions', () => {
  const list = [
    m('openai/gpt-5.5', 'GPT-5.5', { featured: true }),
    m('openai/gpt-5-mini', 'Mini'),
    m('anthropic/claude-opus-4.8', 'Opus', { featured: true }),
    m('anthropic/claude-haiku-4.5', 'Haiku'),
    m('google/gemini-3.5-flash', 'Gemini'),
  ]
  it('featuredModels returns only the flagged ones, in order', () => {
    expect(featuredModels(list).map((x) => x.id)).toEqual(['openai/gpt-5.5', 'anthropic/claude-opus-4.8'])
  })
  it('labOptions leads with a Featured entry, then one per lab with counts', () => {
    const opts = labOptions(list)
    expect(opts[0]).toMatchObject({ lab: FEATURED_LAB, featured: true })
    expect(opts[0].models).toHaveLength(2)
    const byLab = Object.fromEntries(opts.map((o) => [o.lab, o.models.length]))
    expect(byLab).toMatchObject({ OpenAI: 2, Anthropic: 2, Google: 1 })
    expect(opts.filter((o) => o.featured)).toHaveLength(1)
  })
  it('omits the Featured entry when nothing is flagged', () => {
    const none = [m('a/x', 'X'), m('a/y', 'Y')]
    const opts = labOptions(none)
    expect(opts.some((o) => o.featured)).toBe(false)
    expect(opts[0].lab).not.toBe(FEATURED_LAB)
  })
})

describe('modelHint', () => {
  it('renders context window + per-1M pricing', () => {
    expect(modelHint(m('openai/gpt-5.5', 'GPT', { contextWindowTokens: 1_000_000, pricing: { inputPer1M: 5, outputPer1M: 30 } })))
      .toBe('1M ctx · $5/$30 per 1M')
  })
  it('renders K context for smaller windows', () => {
    expect(modelHint(m('a/b', 'B', { contextWindowTokens: 128_000 }))).toBe('128K ctx')
  })
})
