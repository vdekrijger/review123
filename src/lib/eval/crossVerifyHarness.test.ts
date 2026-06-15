/**
 * Tests for the cross-model verification path of the eval harness (Plan M).
 * A verify pass that demotes a noise finding raises precision; the produced
 * list reflects only surfaced findings.
 */
import { describe, it, expect } from 'vitest'
import { runCase, type GoldenCase, type VerifyFn } from './harness'
import { mockComplete } from './mock'

const goldenCase: GoldenCase = {
  name: 'verify-case',
  fixture: {
    name: 'verify-case',
    files: [{ path: 'src/pay.ts', patch: '@@ -1 +1 @@', contentAfter: 'x' }],
    skills: [{ name: 'bug-hunter', content: 'Find bugs.' }],
  },
  expected: {
    real: [{ file: 'src/pay.ts', line: 10, description: 'off-by-one reads items[length]' }],
    noise: [{ file: 'src/pay.ts', line: 9, description: 'prefer const over let' }],
  },
}

const responses = {
  'skill:bug-hunter': JSON.stringify({
    skillName: 'bug-hunter',
    findings: [
      { path: 'src/pay.ts', line: 10, severity: 'high', body: 'off-by-one reads items[length] which is undefined' },
      { path: 'src/pay.ts', line: 9, severity: 'low', body: 'prefer const over let here' },
    ],
  }),
}

describe('runCase — cross-verify', () => {
  it('without cross-verify: the noise nit is flagged → noise-rate 1', async () => {
    const r = await runCase(goldenCase, mockComplete(responses))
    expect(r.score.noiseFlagged).toBe(1)
    expect(r.score.noiseRate).toBe(1)
  })

  it('cross-verify demotes the noise finding → it is dropped, noise-rate 0', async () => {
    // verify surfaces the bug, demotes the style nit.
    const verify: VerifyFn = async (findings) => ({
      surfaced: findings.map((f) => !/prefer const/.test(f.description)),
    })
    const r = await runCase(goldenCase, mockComplete(responses), null, { crossVerify: true, verify })
    expect(r.produced.length).toBe(1)
    expect(r.score.noiseFlagged).toBe(0)
    expect(r.score.noiseRate).toBe(0)
    expect(r.score.recall).toBe(1) // the real bug still surfaced
  })

  it('crossVerify flag without a verify fn is a no-op (findings unchanged)', async () => {
    const r = await runCase(goldenCase, mockComplete(responses), null, { crossVerify: true })
    expect(r.produced.length).toBe(2)
  })

  it('verify present but crossVerify false → not applied', async () => {
    const verify: VerifyFn = async (findings) => ({ surfaced: findings.map(() => false) })
    const r = await runCase(goldenCase, mockComplete(responses), null, { crossVerify: false, verify })
    expect(r.produced.length).toBe(2)
  })
})
