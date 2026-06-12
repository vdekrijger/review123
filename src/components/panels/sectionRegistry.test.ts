import { describe, it, expect } from 'vitest'
import { SECTION_REGISTRY } from './sectionRegistry'
import type { SectionId } from './sectionRegistry'

// ---------------------------------------------------------------------------
// Registry structure
// ---------------------------------------------------------------------------

describe('SECTION_REGISTRY — structure', () => {
  it('is a non-empty array', () => {
    expect(SECTION_REGISTRY.length).toBeGreaterThan(0)
  })

  it('every section has required fields', () => {
    for (const s of SECTION_REGISTRY) {
      expect(typeof s.id).toBe('string')
      expect(typeof s.title).toBe('string')
      expect(typeof s.defaultOpen.page).toBe('boolean')
      expect(typeof s.defaultOpen.rail).toBe('boolean')
      expect(typeof s.show.page).toBe('boolean')
      expect(typeof s.show.rail).toBe('boolean')
    }
  })

  it('ids are unique', () => {
    const ids = SECTION_REGISTRY.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ---------------------------------------------------------------------------
// Required sections present
// ---------------------------------------------------------------------------

describe('SECTION_REGISTRY — required sections present', () => {
  const required: SectionId[] = [
    'summary',
    'diagrams',
    'file-structure',
    'test-insight',
    'alternatives',
    'verdict-evidence',
    'ci-details',
    'pr-description',
  ]

  for (const id of required) {
    it(`includes "${id}" section`, () => {
      expect(SECTION_REGISTRY.find((s) => s.id === id)).not.toBeUndefined()
    })
  }
})

// ---------------------------------------------------------------------------
// ORDER: canonical order enforced
// ---------------------------------------------------------------------------

describe('SECTION_REGISTRY — canonical order', () => {
  const ids = SECTION_REGISTRY.map((s) => s.id)

  it('summary comes before diagrams', () => {
    expect(ids.indexOf('summary')).toBeLessThan(ids.indexOf('diagrams'))
  })

  it('diagrams comes before file-structure', () => {
    expect(ids.indexOf('diagrams')).toBeLessThan(ids.indexOf('file-structure'))
  })

  it('file-structure comes before test-insight', () => {
    expect(ids.indexOf('file-structure')).toBeLessThan(ids.indexOf('test-insight'))
  })

  it('test-insight comes before alternatives', () => {
    expect(ids.indexOf('test-insight')).toBeLessThan(ids.indexOf('alternatives'))
  })

  it('alternatives comes before verdict-evidence', () => {
    expect(ids.indexOf('alternatives')).toBeLessThan(ids.indexOf('verdict-evidence'))
  })

  it('verdict-evidence comes before ci-details', () => {
    expect(ids.indexOf('verdict-evidence')).toBeLessThan(ids.indexOf('ci-details'))
  })

  it('ci-details comes before pr-description', () => {
    expect(ids.indexOf('ci-details')).toBeLessThan(ids.indexOf('pr-description'))
  })
})

// ---------------------------------------------------------------------------
// show flags
// ---------------------------------------------------------------------------

describe('SECTION_REGISTRY — show flags', () => {
  it('all sections show on page', () => {
    for (const s of SECTION_REGISTRY) {
      expect(s.show.page).toBe(true)
    }
  })

  it('file-structure is page-only (show.rail false)', () => {
    const fs = SECTION_REGISTRY.find((s) => s.id === 'file-structure')!
    expect(fs.show.rail).toBe(false)
  })

  const railSections: SectionId[] = [
    'summary',
    'diagrams',
    'test-insight',
    'alternatives',
    'verdict-evidence',
    'ci-details',
    'pr-description',
  ]

  for (const id of railSections) {
    it(`"${id}" shows in rail`, () => {
      const s = SECTION_REGISTRY.find((sec) => sec.id === id)!
      expect(s.show.rail).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// defaultOpen flags
// ---------------------------------------------------------------------------

describe('SECTION_REGISTRY — defaultOpen flags', () => {
  it('summary is open in rail by default', () => {
    const s = SECTION_REGISTRY.find((s) => s.id === 'summary')!
    expect(s.defaultOpen.rail).toBe(true)
  })

  it('all other sections are collapsed by default on page', () => {
    for (const s of SECTION_REGISTRY) {
      expect(s.defaultOpen.page).toBe(false)
    }
  })

  it('all sections except summary are closed in rail by default', () => {
    for (const s of SECTION_REGISTRY.filter((s) => s.id !== 'summary')) {
      expect(s.defaultOpen.rail).toBe(false)
    }
  })
})
