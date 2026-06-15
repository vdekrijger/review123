import { describe, it, expect } from 'vitest'
import { formatGeneratorImpact, formatVerifierImpact } from './modelImpact'

describe('formatGeneratorImpact', () => {
  it('pluralizes surfaced findings', () => {
    expect(formatGeneratorImpact(0)).toBe('0 surfaced findings')
    expect(formatGeneratorImpact(1)).toBe('1 surfaced finding')
    expect(formatGeneratorImpact(4)).toBe('4 surfaced findings')
  })
})

describe('formatVerifierImpact — leads with decisiveness', () => {
  it('a single decisive refute reads as removing a finding', () => {
    expect(formatVerifierImpact({ confirms: 1, refutes: 1, uncertains: 0, decisive: 1 }))
      .toBe('1 decisive refute (removed a finding) · 1c/1r')
  })

  it('a rubber-stamp verifier (confirms, no decisive) reads low-impact', () => {
    expect(formatVerifierImpact({ confirms: 4, refutes: 0, uncertains: 0, decisive: 0 }))
      .toBe('rubber-stamped · 4c/0r')
  })

  it('multiple decisive votes', () => {
    expect(formatVerifierImpact({ confirms: 2, refutes: 2, uncertains: 0, decisive: 2 }))
      .toBe('2 decisive votes · 2c/2r')
  })

  it('no findings to verify', () => {
    expect(formatVerifierImpact({ confirms: 0, refutes: 0, uncertains: 0, decisive: 0 }))
      .toBe('no findings')
  })
})
