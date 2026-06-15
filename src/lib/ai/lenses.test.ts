import { describe, it, expect } from 'vitest'
import { assignLenses, lensFraming, LENSES, type Lens } from './lenses'

describe('assignLenses', () => {
  it('K ≤ 5 verifiers get K distinct lenses', () => {
    const three = assignLenses(3)
    expect(three).toEqual(['correctness', 'security', 'performance'])
    expect(new Set(three).size).toBe(3)

    const five = assignLenses(5)
    expect(new Set(five).size).toBe(5)
    expect(five).toEqual([...LENSES])
  })

  it('cycles when > 5 verifiers', () => {
    const seven = assignLenses(7)
    expect(seven.length).toBe(7)
    expect(seven[5]).toBe('correctness') // wraps
    expect(seven[6]).toBe('security')
  })

  it('zero verifiers → empty', () => {
    expect(assignLenses(0)).toEqual([])
  })
})

describe('lensFraming', () => {
  it('each lens has distinct, non-empty framing naming its concern', () => {
    const seen = new Set<string>()
    for (const lens of LENSES) {
      const text = lensFraming(lens as Lens)
      expect(text.length).toBeGreaterThan(20)
      expect(text.toUpperCase()).toContain(lens.toUpperCase())
      seen.add(text)
    }
    expect(seen.size).toBe(LENSES.length) // all distinct
  })
})
