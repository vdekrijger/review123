import { describe, it, expect } from 'vitest'
import { SECTION_REGISTRY, resolveUnderstandSections } from './sectionRegistry'
import type { SectionId } from './sectionRegistry'

const PAGE_IDS = SECTION_REGISTRY.filter((s) => s.show.page).map((s) => s.id)

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
    'intent',
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
// verdict-evidence title
// ---------------------------------------------------------------------------

describe('SECTION_REGISTRY — verdict-evidence title', () => {
  it('verdict-evidence section title is "Why this verdict"', () => {
    const verdictSection = SECTION_REGISTRY.find((s) => s.id === 'verdict-evidence')!
    expect(verdictSection.title).toBe('Why this verdict')
  })
})

// ---------------------------------------------------------------------------
// ORDER: canonical order enforced
// ---------------------------------------------------------------------------

describe('SECTION_REGISTRY — canonical order', () => {
  const ids = SECTION_REGISTRY.map((s) => s.id)

  it('summary comes before diagrams', () => {
    expect(ids.indexOf('summary')).toBeLessThan(ids.indexOf('diagrams'))
  })

  it('intent sits between summary and diagrams', () => {
    expect(ids.indexOf('summary')).toBeLessThan(ids.indexOf('intent'))
    expect(ids.indexOf('intent')).toBeLessThan(ids.indexOf('diagrams'))
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

  it('intent is page-only in v1 (show.rail false — ContextRail keeps its section set)', () => {
    const intent = SECTION_REGISTRY.find((s) => s.id === 'intent')!
    expect(intent.show.rail).toBe(false)
    expect(intent.title).toBe('Intent check (AI)')
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
  it('all sections are collapsed by default on page', () => {
    for (const s of SECTION_REGISTRY) {
      expect(s.defaultOpen.page).toBe(false)
    }
  })

  it('carries NO rail default — rail open state is per-browser persisted, collapsed by default (src/lib/rail/collapse.ts)', () => {
    for (const s of SECTION_REGISTRY) {
      expect('rail' in s.defaultOpen).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// resolveUnderstandSections — order + enable/disable + forward-compat merge
// ---------------------------------------------------------------------------

describe('resolveUnderstandSections', () => {
  it('undefined → registry page order, all enabled (byte-identical to default)', () => {
    const resolved = resolveUnderstandSections(undefined)
    expect(resolved.map((r) => r.descriptor.id)).toEqual(PAGE_IDS)
    expect(resolved.every((r) => r.enabled)).toBe(true)
  })

  it('null behaves like undefined → registry order, all enabled', () => {
    const resolved = resolveUnderstandSections(null)
    expect(resolved.map((r) => r.descriptor.id)).toEqual(PAGE_IDS)
    expect(resolved.every((r) => r.enabled)).toBe(true)
  })

  it('a custom order reorders the page sections accordingly', () => {
    const stored = [
      { id: 'pr-description', enabled: true },
      { id: 'summary', enabled: true },
    ]
    const resolved = resolveUnderstandSections(stored)
    // The two explicitly-ordered sections come first, in stored order.
    expect(resolved[0].descriptor.id).toBe('pr-description')
    expect(resolved[1].descriptor.id).toBe('summary')
  })

  it('disabled entries carry enabled:false', () => {
    const stored = PAGE_IDS.map((id) => ({ id, enabled: id !== 'ci-details' }))
    const resolved = resolveUnderstandSections(stored)
    const ci = resolved.find((r) => r.descriptor.id === 'ci-details')!
    expect(ci.enabled).toBe(false)
    expect(resolved.filter((r) => !r.enabled)).toHaveLength(1)
  })

  it('unknown / removed ids in the stored list are dropped', () => {
    const stored = [
      { id: 'summary', enabled: true },
      { id: 'does-not-exist', enabled: true },
      { id: 'diagrams', enabled: true },
    ]
    const resolved = resolveUnderstandSections(stored)
    expect(resolved.map((r) => r.descriptor.id)).not.toContain('does-not-exist')
    // All resolved ids are valid page ids.
    expect(resolved.every((r) => PAGE_IDS.includes(r.descriptor.id))).toBe(true)
  })

  it('a registry page section missing from stored is appended (forward-compat), enabled', () => {
    // Store only the first two; the rest must be merged back in, enabled.
    const stored = [
      { id: 'summary', enabled: false },
      { id: 'diagrams', enabled: true },
    ]
    const resolved = resolveUnderstandSections(stored)
    // Every page section is present.
    expect(resolved.map((r) => r.descriptor.id).sort()).toEqual([...PAGE_IDS].sort())
    // Stored ones keep their enabled state; merged-in ones default enabled.
    expect(resolved.find((r) => r.descriptor.id === 'summary')!.enabled).toBe(false)
    expect(resolved.find((r) => r.descriptor.id === 'file-structure')!.enabled).toBe(true)
  })

  it('forward-compat merge inserts a missing section in its registry-relative position', () => {
    // Omit 'diagrams'. The remaining stored sections are in registry order, so
    // diagrams should land back right after its registry predecessor (intent)
    // and before file-structure.
    const stored = PAGE_IDS.filter((id) => id !== 'diagrams').map((id) => ({ id, enabled: true }))
    const resolved = resolveUnderstandSections(stored).map((r) => r.descriptor.id)
    const intentIdx = resolved.indexOf('intent')
    const diagramsIdx = resolved.indexOf('diagrams')
    const fileStructureIdx = resolved.indexOf('file-structure')
    expect(diagramsIdx).toBe(intentIdx + 1)
    expect(diagramsIdx).toBeLessThan(fileStructureIdx)
  })

  it('non-page sections never appear (rail-only/hidden ids ignored)', () => {
    // No registry section is rail-only today, but a stored entry for a
    // non-page id (or any id not show.page) must never be resolved.
    const stored = [{ id: 'some-rail-only-id', enabled: true }]
    const resolved = resolveUnderstandSections(stored)
    // Falls back to merging ALL page sections (none of which is the bogus id).
    expect(resolved.map((r) => r.descriptor.id)).not.toContain('some-rail-only-id')
    expect(resolved.every((r) => r.descriptor.show.page)).toBe(true)
  })

  it('is deterministic for the same input', () => {
    const stored = [
      { id: 'verdict-evidence', enabled: false },
      { id: 'summary', enabled: true },
    ]
    const a = resolveUnderstandSections(stored).map((r) => `${r.descriptor.id}:${r.enabled}`)
    const b = resolveUnderstandSections(stored).map((r) => `${r.descriptor.id}:${r.enabled}`)
    expect(a).toEqual(b)
  })
})
