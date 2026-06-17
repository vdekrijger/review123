import { describe, it, expect, vi } from 'vitest'
import {
  aggregateFinding,
  crossVerify,
  isDecisiveVote,
  validateVerifierResponse,
  buildVerifyPrompt,
  classifyClaim,
  COMPREHENSIVE_VERIFY_FRAMING,
  type VerifyFn,
  type ToolCheckFn,
  type VerifiableFinding,
} from './crossVerify'
import type { ProviderConfig } from '../llm/llm'
import { getModelDef, getProvider } from '../llm/providers'

function cfg(providerId: 'openai' | 'anthropic' | 'gemini' | 'deepseek'): ProviderConfig {
  const provider = getProvider(providerId)!
  return { providerId, model: getModelDef(provider, provider.defaultModel)!, key: `key-${providerId}` }
}

/** A same-provider config pinned to a specific model id (Plan N multi-model). */
function modelCfg(providerId: 'anthropic', modelId: string): ProviderConfig {
  const provider = getProvider(providerId)!
  return { providerId, model: getModelDef(provider, modelId)!, key: `key-${providerId}` }
}

function finding(id: string): VerifiableFinding {
  return { id, path: 'src/a.ts', line: 10, severity: 'high', body: `body ${id}` }
}

describe('aggregateFinding — threshold', () => {
  it('all-confirm → surfaced, confirmedBy counts generator + verifiers', () => {
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'confirm', reason: 'real' },
      { provider: 'anthropic', verdict: 'confirm', reason: 'real' },
    ])
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(3)
    expect(v.polledModels).toBe(3)
    expect(v.perModel[0]).toEqual({ provider: 'deepseek', verdict: 'confirm', reason: '', raised: true })
  })

  it('single verifier refutes a generator-only finding → tie at half → still surfaced', () => {
    // score = 1 (generator), polled = 2, half = 1, 1 >= 1 → surface
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'refute', reason: 'not real' },
    ])
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(1)
    expect(v.polledModels).toBe(2)
  })

  it('two verifiers refute → score 1 / polled 3 < 1.5 → demoted', () => {
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'refute', reason: 'no' },
      { provider: 'anthropic', verdict: 'refute', reason: 'no' },
    ])
    expect(v.surfaced).toBe(false)
    expect(v.confirmedBy).toBe(1)
    expect(v.polledModels).toBe(3)
  })

  it('uncertain counts as a neutral half-vote', () => {
    // generator(1) + uncertain(0.5) = 1.5, polled 2, half 1 → surfaced
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'uncertain', reason: 'cannot tell' },
    ])
    expect(v.surfaced).toBe(true)
    // one confirm refuted into uncertain still keeps confirmedBy=1 (generator only)
    expect(v.confirmedBy).toBe(1)
  })

  it('one confirm + one refute among two verifiers → score 2/polled 3 >= 1.5 → surfaced', () => {
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'confirm', reason: 'yes' },
      { provider: 'anthropic', verdict: 'refute', reason: 'no' },
    ])
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(2)
  })

  it('absence floor: a needs-external finding that votes would surface is DEMOTED unless tool-confirmed', () => {
    const votes = [{ provider: 'openai', verdict: 'confirm' as const, reason: 'yes' }]
    // Vote threshold alone surfaces (generator + confirm).
    expect(aggregateFinding('deepseek', votes).surfaced).toBe(true)
    // needs-external + NOT tool-confirmed → demoted.
    expect(
      aggregateFinding('deepseek', votes, undefined, { claimType: 'needs-external', toolConfirmed: false }).surfaced,
    ).toBe(false)
    // needs-external + tool-confirmed → surfaces (absence positively verified).
    expect(
      aggregateFinding('deepseek', votes, undefined, { claimType: 'needs-external', toolConfirmed: true }).surfaced,
    ).toBe(true)
    // in-diff claimType is a pure no-op (votes decide).
    expect(
      aggregateFinding('deepseek', votes, undefined, { claimType: 'in-diff', toolConfirmed: false }).surfaced,
    ).toBe(true)
  })
})

describe('validateVerifierResponse', () => {
  it('accepts a well-formed response', () => {
    const r = validateVerifierResponse({
      verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'ok' }],
    })
    expect(r).not.toBeNull()
    expect(r!.verdicts[0].id).toBe('f1')
  })

  it('defaults a missing reason to empty string', () => {
    const r = validateVerifierResponse({ verdicts: [{ id: 'f1', verdict: 'refute' }] })
    expect(r!.verdicts[0].reason).toBe('')
  })

  it('rejects an unknown verdict value', () => {
    expect(validateVerifierResponse({ verdicts: [{ id: 'f1', verdict: 'maybe' }] })).toBeNull()
  })

  it('rejects a non-array verdicts', () => {
    expect(validateVerifierResponse({ verdicts: 'nope' })).toBeNull()
  })
})

describe('buildVerifyPrompt', () => {
  it('embeds finding ids + code context and asks for adversarial JSON verdicts', () => {
    const { system, user } = buildVerifyPrompt([
      { ...finding('f1'), excerpt: 'EXCERPT-A', fileWindow: 'WINDOW-A' },
    ])
    expect(system).toMatch(/adversarial/i)
    expect(system).toContain('"verdicts"')
    expect(user).toContain('f1')
    expect(user).toContain('EXCERPT-A')
    expect(user).toContain('WINDOW-A')
  })
})

describe('crossVerify — orchestration', () => {
  const generator = 'deepseek'

  it('no-op when no findings or no verifiers', async () => {
    const verify: VerifyFn = vi.fn()
    const a = await crossVerify([], generator, [cfg('openai')], verify)
    expect(a.byId.size).toBe(0)
    const b = await crossVerify([finding('f1')], generator, [], verify)
    expect(b.byId.size).toBe(0)
    expect(verify).not.toHaveBeenCalled()
  })

  it('aggregates two verifiers and sums usage', async () => {
    const verify: VerifyFn = async (c) => ({
      result: {
        verdicts: [{ id: 'f1', verdict: 'confirm', reason: `${c.providerId} yes` }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const out = await crossVerify([finding('f1')], generator, [cfg('openai'), cfg('anthropic')], verify)
    const v = out.byId.get('f1')!
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(3)
    expect(v.polledModels).toBe(3)
    expect(out.usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 })
    expect(out.respondedProviders).toEqual(['openai', 'anthropic'])
  })

  it('a refuted finding is demoted when both verifiers refute', async () => {
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'f1', verdict: 'refute', reason: 'noise' }] },
    })
    const out = await crossVerify([finding('f1')], generator, [cfg('openai'), cfg('anthropic')], verify)
    expect(out.byId.get('f1')!.surfaced).toBe(false)
  })

  it('a failing verifier is skipped (its vote omitted), others still count', async () => {
    const verify: VerifyFn = async (c) => {
      if (c.providerId === 'openai') throw new Error('rate limited')
      return { result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'yes' }] } }
    }
    const out = await crossVerify([finding('f1')], generator, [cfg('openai'), cfg('anthropic')], verify)
    const v = out.byId.get('f1')!
    expect(out.respondedProviders).toEqual(['anthropic'])
    expect(v.polledModels).toBe(2) // generator + the one responder
    expect(v.surfaced).toBe(true)
  })

  it('ALL verifiers failing → empty byId (findings left unverified)', async () => {
    const verify: VerifyFn = async () => {
      throw new Error('down')
    }
    const out = await crossVerify([finding('f1')], generator, [cfg('openai')], verify)
    expect(out.byId.size).toBe(0)
    expect(out.usage).toBeUndefined()
  })

  it('a verifier that omits a finding id treats it as neutral uncertain', async () => {
    const verify: VerifyFn = async () => ({
      result: { verdicts: [] }, // returns nothing for f1
    })
    const out = await crossVerify([finding('f1')], generator, [cfg('openai')], verify)
    const v = out.byId.get('f1')!
    // generator(1) + uncertain(0.5) = 1.5 >= polled/2 (1) → surfaced
    expect(v.surfaced).toBe(true)
    expect(v.perModel[1].verdict).toBe('uncertain')
  })

  it('perModel carries MODEL per verifier and NO lens; the generator row is marked raised', async () => {
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'real' }] },
    })
    const out = await crossVerify(
      [finding('f1')],
      'deepseek',
      [modelCfg('anthropic', 'claude-sonnet-4-6'), modelCfg('anthropic', 'claude-haiku-4-5')],
      verify,
      'deepseek-v4-flash',
    )
    const v = out.byId.get('f1')!
    // Generator/raiser row: model present, marked raised, no lens.
    expect(v.perModel[0]).toEqual({
      provider: 'deepseek',
      verdict: 'confirm',
      reason: '',
      raised: true,
      model: 'deepseek-v4-flash',
    })
    expect(v.perModel[0]).not.toHaveProperty('lens')
    // Verifier rows: each carries its model id, no lens, not marked raised.
    expect(v.perModel[1].model).toBe('claude-sonnet-4-6')
    expect(v.perModel[1]).not.toHaveProperty('lens')
    expect(v.perModel[1].raised).toBeUndefined()
    expect(v.perModel[2].model).toBe('claude-haiku-4-5')
    expect(v.perModel[2]).not.toHaveProperty('lens')
  })
})

describe('isDecisiveVote — Plan N decisiveness', () => {
  it('a refute that flips surface→demote IS decisive', () => {
    // votes: [refute, refute] → without the 2nd: [refute] → surfaced(true) vs both → demoted(false)
    const votes = [{ verdict: 'refute' as const }, { verdict: 'refute' as const }]
    expect(isDecisiveVote(votes, 0)).toBe(true)
    expect(isDecisiveVote(votes, 1)).toBe(true)
  })

  it('a redundant confirm on an already-surfacing finding is NOT decisive', () => {
    // [confirm, confirm] → removing either still surfaces → not decisive
    const votes = [{ verdict: 'confirm' as const }, { verdict: 'confirm' as const }]
    expect(isDecisiveVote(votes, 0)).toBe(false)
    expect(isDecisiveVote(votes, 1)).toBe(false)
  })

  it('the single refute among confirms is decisive only when it tips the tally', () => {
    // [refute, refute, confirm]: all → score 1+0+0+1=2, polled 4, 2>=2 → surfaced
    // remove the confirm → [refute,refute] score 1, polled 3, 1<1.5 → demoted → DECISIVE
    const votes = [
      { verdict: 'refute' as const },
      { verdict: 'refute' as const },
      { verdict: 'confirm' as const },
    ]
    expect(isDecisiveVote(votes, 2)).toBe(true)
    // removing one refute → [refute, confirm] score 2, polled 3, surfaced → no flip
    expect(isDecisiveVote(votes, 0)).toBe(false)
  })
})

describe('crossVerify — per-model usage + impact (Plan N)', () => {
  const generator = 'anthropic'

  it('attributes usage per verifier MODEL (same provider, different models stay distinct)', async () => {
    const verify: VerifyFn = async (c) => ({
      result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'yes' }] },
      usage: { prompt_tokens: c.model.id === 'claude-sonnet-4-6' ? 10 : 20, completion_tokens: 5, total_tokens: c.model.id === 'claude-sonnet-4-6' ? 15 : 25 },
    })
    const out = await crossVerify(
      [finding('f1')],
      generator,
      [modelCfg('anthropic', 'claude-sonnet-4-6'), modelCfg('anthropic', 'claude-haiku-4-5')],
      verify,
    )
    expect(out.perModelUsage).toEqual([
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ])
  })

  it('reports per-verifier impact: a decisive refute that removes a finding', async () => {
    // Two verifiers both refute f1 → demoted; each refute is decisive (removing
    // one tips it back to surfaced). f2 both confirm → surfaced, redundant confirms.
    const verify: VerifyFn = async () => ({
      result: {
        verdicts: [
          { id: 'f1', verdict: 'refute', reason: 'noise' },
          { id: 'f2', verdict: 'confirm', reason: 'real' },
        ],
      },
    })
    const out = await crossVerify(
      [finding('f1'), finding('f2')],
      generator,
      [modelCfg('anthropic', 'claude-sonnet-4-6'), modelCfg('anthropic', 'claude-haiku-4-5')],
      verify,
    )
    expect(out.verifierImpact).toEqual([
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', confirms: 1, refutes: 1, uncertains: 0, decisive: 1 },
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', confirms: 1, refutes: 1, uncertains: 0, decisive: 1 },
    ])
    expect(out.byId.get('f1')!.surfaced).toBe(false)
    expect(out.byId.get('f2')!.surfaced).toBe(true)
  })

  it('a rubber-stamp verifier (all confirms, no flips) shows 0 decisive', async () => {
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'yes' }, { id: 'f2', verdict: 'confirm', reason: 'yes' }] },
    })
    const out = await crossVerify(
      [finding('f1'), finding('f2')],
      generator,
      [modelCfg('anthropic', 'claude-sonnet-4-6')],
      verify,
    )
    expect(out.verifierImpact[0].confirms).toBe(2)
    expect(out.verifierImpact[0].decisive).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Plan O — Part A: multi-raiser aggregation + merge/dedup + fusion
// ---------------------------------------------------------------------------

import {
  aggregateMultiRaiser,
  mergeGeneratorFindings,
  fuseConfirm,
  type GeneratorFindings,
} from './crossVerify'

function vf(id: string, file: string, line: number | null, body: string, severity: 'high' | 'medium' | 'low' = 'medium'): VerifiableFinding {
  return { id, path: file, line, severity, body }
}

describe('aggregateMultiRaiser', () => {
  it('1 raiser reduces to aggregateFinding', () => {
    const multi = aggregateMultiRaiser(['A'], [{ provider: 'B', verdict: 'refute', reason: 'no' }], 2)
    const single = aggregateFinding('A', [{ provider: 'B', verdict: 'refute', reason: 'no' }])
    expect(multi.surfaced).toBe(single.surfaced)
    expect(multi.confirmedBy).toBe(single.confirmedBy)
    expect(multi.polledModels).toBe(single.polledModels)
  })

  it('finding raised by ONE, others CONFIRM → surfaces (recall win)', () => {
    // raiser(1) + 2 confirms = 3, polled 3, half 1.5 → surface
    const v = aggregateMultiRaiser(
      ['B'],
      [
        { provider: 'A', verdict: 'confirm', reason: 'agree' },
        { provider: 'C', verdict: 'confirm', reason: 'agree' },
      ],
      3,
    )
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(3)
    expect(v.polledModels).toBe(3)
  })

  it('finding raised by ONE, others REFUTE → demotes', () => {
    // raiser(1) + 2 refutes(0) = 1, polled 3, half 1.5 → demote
    const v = aggregateMultiRaiser(
      ['B'],
      [
        { provider: 'A', verdict: 'refute', reason: 'no' },
        { provider: 'C', verdict: 'refute', reason: 'no' },
      ],
      3,
    )
    expect(v.surfaced).toBe(false)
  })

  it('finding raised by TWO of three surfaces regardless of the third', () => {
    const v = aggregateMultiRaiser(['A', 'B'], [{ provider: 'C', verdict: 'refute', reason: 'no' }], 3)
    // raisers(2) + refute(0) = 2 >= 1.5 → surface
    expect(v.surfaced).toBe(true)
    expect(v.perModel.filter((p) => p.verdict === 'confirm').length).toBe(2)
  })
})

describe('mergeGeneratorFindings', () => {
  const cfgA = cfg('openai')
  const cfgB = cfg('anthropic')

  it('two generators raising the SAME issue merge with raisedBy=[A,B]', () => {
    const gens: GeneratorFindings[] = [
      { generator: 'A', cfg: cfgA, findings: [vf('a1', 'src/x.ts', 10, 'off-by-one in pagination loop')] },
      { generator: 'B', cfg: cfgB, findings: [vf('b1', 'src/x.ts', 11, 'off-by-one error in the pagination loop')] },
    ]
    const merged = mergeGeneratorFindings(gens)
    expect(merged.length).toBe(1)
    expect(merged[0].raisedBy.sort()).toEqual(['A', 'B'])
  })

  it('distinct issues stay separate', () => {
    const gens: GeneratorFindings[] = [
      { generator: 'A', cfg: cfgA, findings: [vf('a1', 'src/x.ts', 10, 'SQL injection in query builder')] },
      { generator: 'B', cfg: cfgB, findings: [vf('b1', 'src/y.ts', 5, 'unbounded loop allocation')] },
    ]
    const merged = mergeGeneratorFindings(gens)
    expect(merged.length).toBe(2)
    for (const m of merged) expect(m.raisedBy.length).toBe(1)
  })

  it('representative is the highest-severity finding in the group', () => {
    const gens: GeneratorFindings[] = [
      { generator: 'A', cfg: cfgA, findings: [vf('a1', 'src/x.ts', 10, 'null pointer dereference risk', 'low')] },
      { generator: 'B', cfg: cfgB, findings: [vf('b1', 'src/x.ts', 10, 'null pointer dereference risk here', 'high')] },
    ]
    const merged = mergeGeneratorFindings(gens)
    expect(merged.length).toBe(1)
    expect(merged[0].finding.severity).toBe('high')
  })
})

describe('fuseConfirm — recall + unique catch', () => {
  const cfgA = cfg('openai')
  const cfgB = cfg('anthropic')

  it('a finding model B raised alone, A confirms → surfaces with uniqueCatch on B', async () => {
    const merged = mergeGeneratorFindings([
      { generator: 'A', cfg: cfgA, findings: [vf('a1', 'src/x.ts', 5, 'shared issue both see')] },
      { generator: 'B', cfg: cfgB, findings: [
        vf('b1', 'src/x.ts', 5, 'shared issue both see'),
        vf('b2', 'src/y.ts', 20, 'race condition only B caught'),
      ] },
    ])
    // Verify: A confirms B's unique finding; B's verdict on A's findings is implicit.
    const verify: VerifyFn = async (c) => ({
      result: {
        verdicts: merged.map((m) => ({ id: m.id, verdict: 'confirm' as const, reason: 'agree' })),
      },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    const out = await fuseConfirm(
      merged,
      [{ generator: 'A', cfg: cfgA }, { generator: 'B', cfg: cfgB }],
      verify,
    )
    const unique = out.merged.find((m) => m.merged.finding.id === 'b2')!
    expect(unique.verification.surfaced).toBe(true)
    const impB = out.generatorImpact.find((g) => g.generator === 'B')!
    expect(impB.uniqueCatch).toBe(1)
    const impA = out.generatorImpact.find((g) => g.generator === 'A')!
    expect(impA.uniqueCatch).toBe(0)
  })

  it('fuseConfirm perModel carries raiser model (marked raised) + verifier model, no lens', async () => {
    const merged = mergeGeneratorFindings([
      { generator: 'A', cfg: cfgA, findings: [vf('a1', 'src/x.ts', 5, 'B did not catch this one')] },
    ])
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'a1', verdict: 'refute' as const, reason: 'noise' }] },
    })
    const out = await fuseConfirm(
      merged,
      [{ generator: 'A', cfg: cfgA }, { generator: 'B', cfg: cfgB }],
      verify,
    )
    const v = out.merged[0].verification
    // Raiser row: provider is the generator NAME ('A'); model = A's config model, marked raised, no lens.
    const raiser = v.perModel.find((p) => p.provider === 'A')!
    expect(raiser.model).toBe(cfgA.model.id)
    expect(raiser.raised).toBe(true)
    expect(raiser).not.toHaveProperty('lens')
    // Verifier row (B / anthropic): provider is the providerId; model present, no lens, not raised.
    const verifier = v.perModel.find((p) => p.provider === 'anthropic')!
    expect(verifier.model).toBe(cfgB.model.id)
    expect(verifier).not.toHaveProperty('lens')
    expect(verifier.raised).toBeUndefined()
  })

  it("a finding one model raised alone that others REFUTE demotes", async () => {
    const merged = mergeGeneratorFindings([
      { generator: 'A', cfg: cfgA, findings: [vf('a1', 'src/z.ts', 9, 'speculative concern A alone raised')] },
    ])
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'a1', verdict: 'refute' as const, reason: 'not real' }] },
    })
    const out = await fuseConfirm(
      merged,
      [{ generator: 'A', cfg: cfgA }, { generator: 'B', cfg: cfgB }],
      verify,
    )
    // raiser(1) + refute(0) = 1, polled 2, half 1 → ties surface? 1 >= 1 → surfaces.
    // Make it demote: two non-raisers refute.
    const out2 = await fuseConfirm(
      merged,
      [
        { generator: 'A', cfg: cfgA },
        { generator: 'B', cfg: cfgB },
        { generator: 'C', cfg: cfg('gemini') },
      ],
      verify,
    )
    expect(out2.merged[0].verification.surfaced).toBe(false)
  })
})

describe('buildVerifyPrompt — comprehensive framing', () => {
  it('does not vary by lens — one prompt for all verifiers', () => {
    // Single-arg signature (no lens param) — calling twice yields identical bytes.
    const a = buildVerifyPrompt([finding('f1')])
    const b = buildVerifyPrompt([finding('f1')])
    expect(a.system).toBe(b.system)
  })

  it('the single prompt weighs ALL review dimensions at once', () => {
    const { system } = buildVerifyPrompt([finding('f1')])
    // One comprehensive prompt references every dimension — no per-lens narrowing.
    expect(system).toContain('CORRECTNESS')
    expect(system).toContain('SECURITY')
    expect(system).toContain('PERFORMANCE')
    expect(system).toContain('REPRODUCIBILITY')
    expect(system).toContain('MAINTAINABILITY')
  })

  it('crossVerify runs every verifier through the same prompt (no lens threading)', async () => {
    const seenFindingCounts: number[] = []
    const verify: VerifyFn = async (_cfg, findings) => {
      seenFindingCounts.push(findings.length)
      return { result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'ok' }] } }
    }
    const out = await crossVerify(
      [finding('f1')],
      'deepseek',
      [modelCfg('anthropic', 'claude-sonnet-4-6'), modelCfg('anthropic', 'claude-haiku-4-5')],
      verify,
    )
    // Both verifiers were invoked with the same finding set; no per-verifier lens.
    expect(seenFindingCounts).toEqual([1, 1])
    expect(out.verifierImpact[0]).not.toHaveProperty('lens')
    expect(out.verifierImpact[1]).not.toHaveProperty('lens')
  })
})

// ---------------------------------------------------------------------------
// Part A — absence/external-evidence verifier framing (refute-by-default)
// ---------------------------------------------------------------------------

describe('buildVerifyPrompt — absence-claim refute-by-default (Part A)', () => {
  it('the comprehensive framing makes absence/external-evidence claims refute-by-default', () => {
    expect(COMPREHENSIVE_VERIFY_FRAMING).toMatch(/ABSENCE \/ EXTERNAL-EVIDENCE CLAIMS/i)
    expect(COMPREHENSIVE_VERIFY_FRAMING).toMatch(/REFUTE-BY-DEFAULT/i)
    expect(COMPREHENSIVE_VERIFY_FRAMING).toMatch(/burden of proof is on the finding/i)
    expect(COMPREHENSIVE_VERIFY_FRAMING).toMatch(/NEVER "confirm"/i)
  })

  it('the verify system prompt lists the absence case as NOT confirmable', () => {
    const { system } = buildVerifyPrompt([finding('f1')])
    expect(system).toMatch(/asserts an ABSENCE/i)
    expect(system).toMatch(/no test, not called, not handled\/validated/i)
    expect(system).toMatch(/never "confirm"/i)
  })

  it('an unverifiable absence claim with no supporting context yields refute (mocked verifier)', async () => {
    // A verifier that READS the framing returns refute for an absence claim with
    // no supporting context — modelled by the mock honouring the refute-by-default
    // instruction. Two refutes demote the finding.
    const absence: VerifiableFinding = {
      id: 'a1',
      path: 'src/foo.ts',
      line: 10,
      severity: 'high',
      body: 'no test verifies fooBar — coverage is missing',
    }
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'a1', verdict: 'refute', reason: 'cannot confirm absence from the diff' }] },
    })
    const out = await crossVerify([absence], 'deepseek', [cfg('openai'), cfg('anthropic')], verify)
    expect(out.byId.get('a1')!.surfaced).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Part B — claim classification
// ---------------------------------------------------------------------------

describe('classifyClaim — needs-external vs in-diff', () => {
  it.each([
    'no test verifies fooBar',
    'fooBar is not tested anywhere',
    'this branch is untested',
    'missing a unit test for the error path',
    'no test covers the rejection case',
    'helper() is not called anywhere',
    'this export is never used',
    'the unused parameter foo',
    'no callers of this function remain',
    'the error is not handled',
    'input is not validated before use',
    'missing a guard for the null case',
    'missing an index on user_id',
    'the assertion will fail unless a custom exception handler not visible in the diff rewrites it',
  ])('classifies %j as needs-external', (body) => {
    expect(classifyClaim(body)).toBe('needs-external')
  })

  it.each([
    'off-by-one: reads items[length] which is undefined',
    'this validates the input and handles null correctly',
    'the test asserts the returned value',
    'renames the variable for clarity',
    'this handler processes the request body',
  ])('classifies ordinary diff-local finding %j as in-diff', (body) => {
    expect(classifyClaim(body)).toBe('in-diff')
  })
})

// ---------------------------------------------------------------------------
// Part B — tool-backed verification + demotion in crossVerify
// ---------------------------------------------------------------------------

describe('crossVerify — tool-backed absence verification + demotion', () => {
  const generator = 'deepseek'
  const confirmAll: VerifyFn = async () => ({
    result: { verdicts: [{ id: 'a1', verdict: 'confirm', reason: 'looks real' }] },
  })

  function absenceFinding(): VerifiableFinding {
    return { id: 'a1', path: 'src/foo.ts', line: 10, severity: 'high', body: 'no test covers fooBar' }
  }

  it('needs-external finding NOT tool-confirmed is DEMOTED even when verifiers confirm', async () => {
    // No toolCheck → the absence is never positively verified → demoted (Part A floor).
    const out = await crossVerify([absenceFinding()], generator, [cfg('openai'), cfg('anthropic')], confirmAll)
    expect(out.byId.get('a1')!.surfaced).toBe(false)
  })

  it('tool check that FINDS a matching test → REFUTED/demoted', async () => {
    const toolCheck: ToolCheckFn = vi.fn(async (): Promise<'refute'> => 'refute')
    const out = await crossVerify(
      [absenceFinding()],
      generator,
      [cfg('openai'), cfg('anthropic')],
      confirmAll,
      undefined,
      toolCheck,
    )
    expect(toolCheck).toHaveBeenCalledTimes(1)
    expect(out.byId.get('a1')!.surfaced).toBe(false)
  })

  it('tool check that finds NOTHING (confirm) → absence verified → surfaces', async () => {
    const toolCheck: ToolCheckFn = vi.fn(async (): Promise<'confirm'> => 'confirm')
    const out = await crossVerify(
      [absenceFinding()],
      generator,
      [cfg('openai'), cfg('anthropic')],
      confirmAll,
      undefined,
      toolCheck,
    )
    expect(out.byId.get('a1')!.surfaced).toBe(true)
  })

  it('a throwing tool check is treated as uncertain → demoted (never blocks)', async () => {
    const toolCheck: ToolCheckFn = vi.fn(async () => {
      throw new Error('budget gone')
    })
    const out = await crossVerify(
      [absenceFinding()],
      generator,
      [cfg('openai'), cfg('anthropic')],
      confirmAll,
      undefined,
      toolCheck,
    )
    expect(out.byId.get('a1')!.surfaced).toBe(false)
  })

  it('an in-diff finding never invokes the tool check and still surfaces when confirmed', async () => {
    const inDiff: VerifiableFinding = { id: 'a1', path: 'src/foo.ts', line: 10, severity: 'high', body: 'off-by-one reads items[length]' }
    const toolCheck: ToolCheckFn = vi.fn(async (): Promise<'refute'> => 'refute')
    const out = await crossVerify([inDiff], generator, [cfg('openai'), cfg('anthropic')], confirmAll, undefined, toolCheck)
    expect(toolCheck).not.toHaveBeenCalled()
    expect(out.byId.get('a1')!.surfaced).toBe(true)
  })

  it('honours an explicit claimType tag over body heuristics', async () => {
    // Body looks in-diff, but the generator (or caller) tagged it needs-external.
    const tagged: VerifiableFinding = {
      id: 'a1', path: 'src/foo.ts', line: 10, severity: 'high',
      body: 'this looks ordinary', claimType: 'needs-external',
    }
    const out = await crossVerify([tagged], generator, [cfg('openai'), cfg('anthropic')], confirmAll)
    // needs-external + no tool confirm → demoted.
    expect(out.byId.get('a1')!.surfaced).toBe(false)
  })
})
