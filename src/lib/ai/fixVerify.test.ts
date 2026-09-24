import { describe, it, expect, vi } from 'vitest'
import {
  FIX_VERIFY_EVIDENCE_CAVEAT,
  FIX_VERIFY_MAX_CALLS,
  aggregateFixFinding,
  buildFixVerifyPrompt,
  describeFixFinding,
  describeNewProblems,
  describeVerificationUnder,
  fixOutcomeLabel,
  mergeNewProblems,
  runFixVerification,
  stillOpenFindingIds,
  stopReasonOutranksVerification,
  validateFixVerifyResponse,
  type FixReReadVote,
  type FixVerifyParticipant,
  type FixVerifySubject,
} from './fixVerify'
import type { ProviderConfig } from '../llm/llm'

const cfg = (id: string): ProviderConfig =>
  ({ providerId: 'openai', model: { id }, key: 'k' }) as unknown as ProviderConfig

const participant = (provider: string, model: string): FixVerifyParticipant => ({
  provider,
  model,
  cfg: cfg(model),
})

const subject = (id: string, over: Partial<FixVerifySubject> = {}): FixVerifySubject => ({
  id,
  path: 'src/a.ts',
  line: 10,
  body: 'Unescaped input reaches the DOM',
  suggestedFix: 'Escape it',
  intent: 'Escaped the value before insertion.',
  diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10 +10 @@\n-raw\n+escaped\n',
  truncated: false,
  ...over,
})

const vote = (verdict: FixReReadVote['verdict'], provider = 'OpenAI'): FixReReadVote => ({
  provider,
  model: 'gpt',
  verdict,
  reason: 'because',
})

describe('aggregateFixFinding — ties and uncertainty keep a finding OPEN', () => {
  it('closes a finding only on positive agreement that it went quiet', () => {
    const v = aggregateFixFinding('f1', 'Security', [vote('not-raised-again')])
    expect(v.outcome).toBe('not-raised-again')
    expect(v.agreeing).toBe(1)
    expect(v.polledModels).toBe(1)
  })

  it('keeps a finding open on a single UNSURE vote (0.5 >= 0.5)', () => {
    // The whole asymmetry in one case: a shrug must never close a finding.
    const v = aggregateFixFinding('f1', 'Security', [vote('unsure')])
    expect(v.outcome).toBe('could-not-tell')
  })

  it('keeps a finding open when it still stands', () => {
    expect(aggregateFixFinding('f1', 'Security', [vote('still-standing')]).outcome).toBe(
      'still-standing',
    )
  })

  it('a 1-1 tie goes to STILL STANDING, never to resolved', () => {
    const v = aggregateFixFinding('f1', 'Security', [
      vote('still-standing', 'OpenAI'),
      vote('not-raised-again', 'Anthropic'),
    ])
    expect(v.outcome).toBe('still-standing')
    expect(v.agreeing).toBe(1)
    expect(v.polledModels).toBe(2)
  })

  it('closes only when the quiet side outweighs the standing side', () => {
    const v = aggregateFixFinding('f1', 'Security', [
      vote('not-raised-again', 'OpenAI'),
      vote('not-raised-again', 'Anthropic'),
      vote('still-standing', 'Gemini'),
    ])
    // score = 1 (one still-standing), polled = 3 → 1 >= 1.5 is false.
    expect(v.outcome).toBe('not-raised-again')
    expect(v.agreeing).toBe(2)
  })

  it('distinguishes "everyone shrugged" from "someone still raises it"', () => {
    const all = aggregateFixFinding('f1', 'Security', [vote('unsure'), vote('unsure', 'B')])
    expect(all.outcome).toBe('could-not-tell')
    const mixed = aggregateFixFinding('f1', 'Security', [vote('unsure'), vote('still-standing', 'B')])
    expect(mixed.outcome).toBe('still-standing')
  })

  it('reports NO votes as not-re-read, never as resolved', () => {
    const v = aggregateFixFinding('f1', 'Security', [])
    expect(v.outcome).toBe('not-re-read')
    expect(v.polledModels).toBe(0)
  })
})

describe('the words never claim the defect is gone', () => {
  it('has no label that says fixed, resolved or passed', () => {
    const labels = (['not-raised-again', 'still-standing', 'could-not-tell', 'not-re-read'] as const).map(
      fixOutcomeLabel,
    )
    expect(labels).toEqual(['not raised again', 'still raised', 'could not tell', 'not re-read'])
    for (const l of labels) expect(l).not.toMatch(/fixed|resolved|passed|verified|clean/i)
  })

  it('words a quiet finding as an observation about the REVIEWER', () => {
    const sentence = describeFixFinding(
      aggregateFixFinding('f1', 'Security reviewer', [vote('not-raised-again')]),
    )
    expect(sentence).toBe(
      "Security reviewer re-read this against the agent's diff and did not raise it again (1 of 1 model).",
    )
    // The load-bearing property: it reports who looked, not what is true.
    expect(sentence).not.toMatch(/\bfixed\b|\bresolved\b|no longer (?:a problem|present)/i)
  })

  it('names how many models looked, in the plural, when more than one did', () => {
    const sentence = describeFixFinding(
      aggregateFixFinding('f1', 'Security', [vote('not-raised-again'), vote('not-raised-again', 'B')]),
    )
    expect(sentence).toContain('(2 of 2 models)')
  })

  it('says plainly when nothing was checked', () => {
    expect(describeFixFinding(aggregateFixFinding('f1', 'Security', []))).toContain(
      'Nothing was checked',
    )
  })

  it('states the measured variance in the caveat, and that no person has read it', () => {
    expect(FIX_VERIFY_EVIDENCE_CAVEAT).toContain('1/3')
    expect(FIX_VERIFY_EVIDENCE_CAVEAT).toContain('3/3')
    expect(FIX_VERIFY_EVIDENCE_CAVEAT).toMatch(/not that the defect is gone/i)
    expect(FIX_VERIFY_EVIDENCE_CAVEAT).toMatch(/read by a person/i)
  })
})

describe('the loop’s own stop reason outranks any re-read', () => {
  it('refuses to let a quiet re-read soften round-cap', () => {
    const under = describeVerificationUnder('round-cap')
    expect(under).toMatch(/tests are still failing/i)
    expect(under).toMatch(/does not make them pass/i)
    expect(stopReasonOutranksVerification('round-cap')).toBe(true)
  })

  it('surfaces no-progress and repeat-diff as the signals they are', () => {
    expect(describeVerificationUnder('no-progress')).toMatch(/where it gave up/i)
    expect(describeVerificationUnder('repeat-diff')).toMatch(/oscillating/i)
    expect(stopReasonOutranksVerification('no-progress')).toBe(true)
    expect(stopReasonOutranksVerification('repeat-diff')).toBe(true)
  })

  it('has nothing to argue with when the loop finished cleanly', () => {
    expect(describeVerificationUnder('all-addressed')).toBeNull()
    expect(describeVerificationUnder('budget-exhausted')).toBeNull()
    expect(stopReasonOutranksVerification('all-addressed')).toBe(false)
  })
})

describe('validateFixVerifyResponse', () => {
  it('reads a well-formed answer', () => {
    const r = validateFixVerifyResponse({
      reReads: [{ id: 'a', verdict: 'still-standing', reason: 'still there' }],
      newProblems: [
        { path: 'src/x.ts', line: 3, severity: 'high', body: 'null deref', suggestedFix: 'guard' },
      ],
    })
    expect(r?.reReads).toHaveLength(1)
    expect(r?.newProblems[0]).toMatchObject({ path: 'src/x.ts', severity: 'high' })
  })

  it('rejects a response with no reReads array at all', () => {
    expect(validateFixVerifyResponse({ newProblems: [] })).toBeNull()
    expect(validateFixVerifyResponse(null)).toBeNull()
    expect(validateFixVerifyResponse('nope')).toBeNull()
  })

  it('DROPS an unreadable verdict rather than inventing one', () => {
    const r = validateFixVerifyResponse({
      reReads: [
        { id: 'a', verdict: 'fixed', reason: '' },
        { id: 'b', verdict: 'unsure', reason: '' },
      ],
    })
    // 'fixed' is not in the vocabulary — the finding simply gets no vote, which
    // aggregates to not-re-read, never to resolved.
    expect(r?.reReads.map((x) => x.id)).toEqual(['b'])
  })

  it('keeps the verdicts when newProblems is garbage', () => {
    const r = validateFixVerifyResponse({
      reReads: [{ id: 'a', verdict: 'unsure', reason: '' }],
      newProblems: [{ path: '', body: 'x' }, { path: 'ok.ts', body: '' }, 'junk'],
    })
    expect(r?.reReads).toHaveLength(1)
    expect(r?.newProblems).toEqual([])
  })

  it('defaults a missing severity to medium instead of dropping the problem', () => {
    const r = validateFixVerifyResponse({
      reReads: [],
      newProblems: [{ path: 'a.ts', body: 'something', line: 'x' }],
    })
    expect(r?.newProblems[0]).toMatchObject({ severity: 'medium', line: null, suggestedFix: '' })
  })
})

describe('mergeNewProblems', () => {
  it('fuses the same problem reported by two models and credits both', () => {
    const merged = mergeNewProblems(
      [
        {
          raisedBy: 'Security · OpenAI',
          problem: { path: 'a.ts', line: 5, severity: 'medium', body: 'leaks the handle on error', suggestedFix: 'close it' },
        },
        {
          raisedBy: 'Security · Anthropic',
          problem: { path: 'a.ts', line: 5, severity: 'high', body: 'leaks the handle on error paths', suggestedFix: 'close it' },
        },
      ],
      2,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].raisedBy).toEqual(['Security · OpenAI', 'Security · Anthropic'])
    // The representative is the higher-severity telling.
    expect(merged[0].severity).toBe('high')
    expect(merged[0].polledModels).toBe(2)
  })

  it('keeps genuinely different problems apart and sorts by severity', () => {
    const merged = mergeNewProblems(
      [
        { raisedBy: 'A', problem: { path: 'a.ts', line: 5, severity: 'low', body: 'naming is off here', suggestedFix: '' } },
        { raisedBy: 'A', problem: { path: 'b.ts', line: 90, severity: 'high', body: 'unbounded recursion added', suggestedFix: '' } },
      ],
      1,
    )
    expect(merged.map((m) => m.severity)).toEqual(['high', 'low'])
    expect(merged.map((m) => m.key)).toHaveLength(2)
  })

  it('says so when the models were asked and reported nothing', () => {
    expect(describeNewProblems(0, 2)).toMatch(/No new problems were reported by the 2 models/)
    expect(describeNewProblems(0, 2)).toMatch(/They were asked for them/)
    expect(describeNewProblems(0, 0)).toMatch(/No model looked/)
    expect(describeNewProblems(1, 2)).toMatch(/One problem was raised about the agent/)
  })
})

describe('buildFixVerifyPrompt', () => {
  it('carries the persona verbatim, so the criterion is the raiser’s own', () => {
    const { system } = buildFixVerifyPrompt(
      { name: 'Security', content: 'YOU CARE ABOUT INJECTION.' },
      [subject('f1')],
    )
    expect(system).toContain('YOU CARE ABOUT INJECTION.')
    expect(system).toContain('still-standing')
    expect(system).toContain('not-raised-again')
  })

  it('asks for new problems the fix introduced, as a separate job', () => {
    const { system } = buildFixVerifyPrompt({ name: 'S', content: 'x' }, [subject('f1')])
    expect(system).toMatch(/JOB 2/)
    expect(system).toMatch(/THE FIX ITSELF INTRODUCED/)
    expect(system).toMatch(/Do NOT repeat your original findings/)
  })

  it('tells the model when the diff it is reading was truncated', () => {
    const { user } = buildFixVerifyPrompt({ name: 'S', content: 'x' }, [
      subject('f1', { truncated: true }),
    ])
    expect(user).toMatch(/TRUNCATED/)
    expect(user).toMatch(/answer "unsure"/)
  })

  it('includes the finding, the agent’s intent and the diff', () => {
    const { user } = buildFixVerifyPrompt({ name: 'S', content: 'x' }, [subject('f1')])
    expect(user).toContain('Unescaped input reaches the DOM')
    expect(user).toContain('Escaped the value before insertion.')
    expect(user).toContain('+escaped')
  })
})

describe('runFixVerification', () => {
  const persona = { name: 'Security', content: 'persona' }

  it('polls every participant and aggregates their votes', async () => {
    const verify = vi.fn(async (c: ProviderConfig) => ({
      result: {
        reReads: [
          {
            id: 'f1',
            verdict: (c.model.id === 'm1' ? 'not-raised-again' : 'still-standing') as const,
            reason: 'r',
          },
        ],
        newProblems: [],
      },
    }))
    const report = await runFixVerification(
      [{ persona, subjects: [subject('f1')] }],
      [participant('OpenAI', 'm1'), participant('Anthropic', 'm2')],
      verify,
    )
    expect(verify).toHaveBeenCalledTimes(2)
    // 1-1 tie → still standing.
    expect(report.byFinding[0].outcome).toBe('still-standing')
    expect(report.byFinding[0].polledModels).toBe(2)
    expect(report.witnesses).toEqual(['Security · OpenAI', 'Security · Anthropic'])
  })

  it('skips a failing call instead of failing the pass', async () => {
    const verify = vi.fn(async (c: ProviderConfig) => {
      if (c.model.id === 'm2') throw new Error('rate limited')
      return {
        result: { reReads: [{ id: 'f1', verdict: 'not-raised-again' as const, reason: '' }], newProblems: [] },
      }
    })
    const report = await runFixVerification(
      [{ persona, subjects: [subject('f1')] }],
      [participant('OpenAI', 'm1'), participant('Anthropic', 'm2')],
      verify,
    )
    expect(report.failedCalls).toBe(1)
    expect(report.byFinding[0].outcome).toBe('not-raised-again')
    expect(report.byFinding[0].polledModels).toBe(1)
  })

  it('reports every finding as not-re-read when EVERY call fails', async () => {
    const report = await runFixVerification(
      [{ persona, subjects: [subject('f1'), subject('f2')] }],
      [participant('OpenAI', 'm1')],
      async () => {
        throw new Error('down')
      },
    )
    expect(report.byFinding.map((f) => f.outcome)).toEqual(['not-re-read', 'not-re-read'])
    expect(report.failedCalls).toBe(1)
  })

  it('reports every finding as not-re-read when there is no model to ask', async () => {
    const report = await runFixVerification(
      [{ persona, subjects: [subject('f1')] }],
      [],
      async () => {
        throw new Error('never called')
      },
    )
    expect(report.byFinding[0].outcome).toBe('not-re-read')
    expect(report.calls).toBe(0)
  })

  it('discards a verdict for an id that was never sent', async () => {
    // A model inventing a finding id must not be able to close one.
    const report = await runFixVerification(
      [{ persona, subjects: [subject('f1')] }],
      [participant('OpenAI', 'm1')],
      async () => ({
        result: {
          reReads: [
            { id: 'f1', verdict: 'still-standing' as const, reason: '' },
            { id: 'ghost', verdict: 'not-raised-again' as const, reason: '' },
          ],
          newProblems: [],
        },
      }),
    )
    expect(report.byFinding).toHaveLength(1)
    expect(report.byFinding[0].findingId).toBe('f1')
    expect(report.byFinding[0].outcome).toBe('still-standing')
  })

  it('collects the new problems every model raised, attributed', async () => {
    const report = await runFixVerification(
      [{ persona, subjects: [subject('f1')] }],
      [participant('OpenAI', 'm1')],
      async () => ({
        result: {
          reReads: [{ id: 'f1', verdict: 'not-raised-again' as const, reason: '' }],
          newProblems: [
            { path: 'src/a.ts', line: 12, severity: 'high' as const, body: 'the escape breaks unicode', suggestedFix: 'use the helper' },
          ],
        },
      }),
    )
    expect(report.newProblems).toHaveLength(1)
    expect(report.newProblems[0].raisedBy).toEqual(['Security · OpenAI'])
    // The most valuable output: a finding can go quiet AND the fix still be bad.
    expect(report.byFinding[0].outcome).toBe('not-raised-again')
  })

  it('caps the number of model calls', async () => {
    const verify = vi.fn(async () => ({ result: { reReads: [], newProblems: [] } }))
    const batches = Array.from({ length: 5 }, (_, i) => ({
      persona: { name: `P${i}`, content: 'c' },
      subjects: [subject(`f${i}`)],
    }))
    await runFixVerification(
      batches,
      [participant('A', 'm1'), participant('B', 'm2'), participant('C', 'm3')],
      verify,
    )
    expect(verify).toHaveBeenCalledTimes(FIX_VERIFY_MAX_CALLS)
  })

  it('lists exactly the findings worth another round', async () => {
    const report = await runFixVerification(
      [
        {
          persona,
          subjects: [subject('quiet'), subject('standing'), subject('shrug')],
        },
      ],
      [participant('OpenAI', 'm1')],
      async () => ({
        result: {
          reReads: [
            { id: 'quiet', verdict: 'not-raised-again' as const, reason: '' },
            { id: 'standing', verdict: 'still-standing' as const, reason: '' },
            { id: 'shrug', verdict: 'unsure' as const, reason: '' },
          ],
          newProblems: [],
        },
      }),
    )
    expect(stillOpenFindingIds(report)).toEqual(['standing', 'shrug'])
  })
})
