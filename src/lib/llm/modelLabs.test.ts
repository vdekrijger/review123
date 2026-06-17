import { describe, it, expect } from 'vitest'
import { labKey, labName, modelMatches, groupByLab, visibleModels, modelHint } from './modelLabs'
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
  it('groups models by friendly lab, preserving first-appearance order', () => {
    const groups = groupByLab([
      m('openai/gpt-5.5', 'GPT-5.5'),
      m('anthropic/claude-opus-4.8', 'Opus'),
      m('openai/gpt-5-mini', 'Mini'),
    ])
    expect(groups.map((g) => g.lab)).toEqual(['OpenAI', 'Anthropic'])
    expect(groups[0].models.map((x) => x.id)).toEqual(['openai/gpt-5.5', 'openai/gpt-5-mini'])
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

describe('modelHint', () => {
  it('renders context window + per-1M pricing', () => {
    expect(modelHint(m('openai/gpt-5.5', 'GPT', { contextWindowTokens: 1_000_000, pricing: { inputPer1M: 5, outputPer1M: 30 } })))
      .toBe('1M ctx · $5/$30 per 1M')
  })
  it('renders K context for smaller windows', () => {
    expect(modelHint(m('a/b', 'B', { contextWindowTokens: 128_000 }))).toBe('128K ctx')
  })
})
