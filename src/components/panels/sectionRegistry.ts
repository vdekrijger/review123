/**
 * sectionRegistry.ts — single source of truth for the UnderstandStep / ContextRail section list.
 *
 * Both UnderstandStep and ContextRail render from this registry, guaranteeing:
 *   • Identical ORDER everywhere (summary → intent → outcomes → diagrams →
 *     file-structure → test-insight → alternatives → verdict-evidence →
 *     ci-details → pr-description).
 *   • Consistent show/hide rules per context (page vs rail).
 *   • defaultOpen for the page context (all page panels start closed).
 *
 * Rail open state is NOT registry-driven: every rail section starts COLLAPSED
 * and the user's expand/collapse choices persist per browser — see
 * src/lib/rail/collapse.ts and ContextRail.svelte.
 *
 * Each consumer keeps its own chrome (page: .detail-panel <details>; rail: .rail-section-details
 * <details>) — the registry only describes WHAT and in what ORDER.
 *
 * The "Glance card" section stays page-only, lives above the registry, and is
 * NOT listed here.
 *
 * The "Hotspots" section is rail-specific (driven by attention data, not AiRun tasks directly)
 * and is also NOT listed here — ContextRail keeps it as a local injection between the first
 * two registry sections (summary, diagrams) and the rest when attention is available.
 */

export interface SectionDescriptor {
  /** Stable ID used for key, test selectors, aria-labels. */
  id: SectionId
  /** Human-readable panel title (used verbatim in <summary>). */
  title: string
  /**
   * Default open state for the page context (.detail-panel <details>).
   * The rail has no registry default: its sections always start collapsed,
   * overlaid with per-browser persisted choices (src/lib/rail/collapse.ts).
   */
  defaultOpen: {
    page: boolean
  }
  /**
   * Whether to render the section in each context at all.
   * Components may apply additional runtime guards (e.g. hide ci-details
   * when ci prop is null and ciError is false), but this flag is the
   * registry-level gate.
   */
  show: {
    page: boolean
    rail: boolean
  }
}

export type SectionId =
  | 'summary'
  | 'intent'
  | 'outcomes'
  | 'diagrams'
  | 'file-structure'
  | 'test-insight'
  | 'alternatives'
  | 'verdict-evidence'
  | 'ci-details'
  | 'pr-description'

/**
 * Ordered array of section descriptors.
 * ORDER IS CANONICAL — both UnderstandStep and ContextRail iterate this array.
 */
/**
 * The AI tasks whose run-state backs a section's header status indicator.
 * Keyed by SectionId; only AI-backed sections appear here. Synchronous sections
 * (file-structure, ci-details, pr-description) are intentionally ABSENT — they
 * never show a spinner.
 *
 * The value is the AiRun PanelState property name, so a consumer can read
 * `run[AI_SECTION_TASK[id]].status` and feed it to <SectionStatus>. This is the
 * SAME per-task state AiProgress consumes — not a parallel source.
 */
export const AI_SECTION_TASK: Partial<Record<SectionId, 'summary' | 'intent' | 'outcomes' | 'diagrams' | 'tests' | 'alternatives' | 'verdict'>> = {
  summary: 'summary',
  intent: 'intent',
  outcomes: 'outcomes',
  diagrams: 'diagrams',
  'test-insight': 'tests',
  alternatives: 'alternatives',
  'verdict-evidence': 'verdict',
}

/**
 * One stored Understand-step section preference: the section's stable id plus
 * whether it is enabled. The user's ordered list of these (settings
 * `understandSections`) drives the page panel order + visibility. Typed with a
 * bare `string` id (not SectionId) so the settings module can store/coerce it
 * without importing this component-dir registry (avoids an import cycle); the
 * resolver below validates ids against the registry.
 */
export interface StoredUnderstandSection {
  id: string
  enabled: boolean
}

/** A resolved page section: its registry descriptor + whether it is enabled. */
export interface ResolvedUnderstandSection {
  descriptor: SectionDescriptor
  enabled: boolean
}

/**
 * Resolve the ordered+visible Understand-step page sections from the stored
 * preference, against the canonical registry.
 *
 * Rules:
 *  • Only `show.page` sections participate (rail-only / hidden ids never appear).
 *  • Start from the STORED order, skipping ids that are unknown or not show.page.
 *  • FORWARD-COMPAT MERGE: any show.page registry section NOT present in the
 *    stored list is appended in its registry-relative position, enabled by
 *    default — so a newly-added section shows up for existing users.
 *  • With no stored preference (undefined/null) → exactly the registry order,
 *    all enabled (byte-identical to the pre-setting behavior).
 *
 * Deterministic: the same input always yields the same output.
 */
export function resolveUnderstandSections(
  stored: StoredUnderstandSection[] | null | undefined,
): ResolvedUnderstandSection[] {
  const pageSections = SECTION_REGISTRY.filter((s) => s.show.page)

  // No stored preference → registry order, all enabled.
  if (!Array.isArray(stored)) {
    return pageSections.map((descriptor) => ({ descriptor, enabled: true }))
  }

  const byId = new Map(pageSections.map((s) => [s.id, s]))
  const seen = new Set<SectionId>()
  const result: ResolvedUnderstandSection[] = []

  // 1) Honor the stored order, validating each entry against the registry.
  for (const entry of stored) {
    if (!entry || typeof entry.id !== 'string') continue
    const descriptor = byId.get(entry.id as SectionId)
    if (!descriptor || seen.has(descriptor.id)) continue
    seen.add(descriptor.id)
    result.push({ descriptor, enabled: entry.enabled !== false })
  }

  // 2) Forward-compat merge: re-insert any registry page section the stored
  //    list omitted, in its registry-relative position, enabled by default.
  //    A missing section is placed immediately AFTER its nearest preceding
  //    registry neighbor that is already present in the result; if none is
  //    present it goes to the front. This puts a newly-added section back in its
  //    registry slot for existing users WITHOUT disturbing a user's explicit
  //    reordering of the sections they did pick (those keep their stored order).
  //    Iterating in registry order keeps consecutive new sections in their
  //    relative order too.
  const positionInResult = (id: SectionId): number =>
    result.findIndex((r) => r.descriptor.id === id)

  for (let i = 0; i < pageSections.length; i++) {
    const descriptor = pageSections[i]
    if (seen.has(descriptor.id)) continue
    // Walk backwards through earlier registry sections to find one already in
    // the result; insert just after it. (Sections appended earlier in this loop
    // are now in `result`, so consecutive new sections chain correctly.)
    let insertAt = 0
    for (let k = i - 1; k >= 0; k--) {
      const pos = positionInResult(pageSections[k].id)
      if (pos !== -1) {
        insertAt = pos + 1
        break
      }
    }
    result.splice(insertAt, 0, { descriptor, enabled: true })
    seen.add(descriptor.id)
  }

  return result
}

export const SECTION_REGISTRY: readonly SectionDescriptor[] = [
  {
    id: 'summary',
    title: 'Full summary',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
  {
    // Intent-vs-implementation check. Page-only in v1 (show.rail false):
    // the rail keeps its current section set; ContextRail never renders it.
    id: 'intent',
    title: 'Intent check (AI)',
    defaultOpen: { page: false },
    show: { page: true, rail: false },
  },
  {
    // Expected-outcomes check. Slots right after intent so the validation
    // story reads top-down: intent = promised, outcomes = actually changes,
    // tests (further down) = proven. Page-only in v1, like intent.
    id: 'outcomes',
    title: 'Expected outcomes (AI)',
    defaultOpen: { page: false },
    show: { page: true, rail: false },
  },
  {
    id: 'diagrams',
    title: 'Change impact',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
  {
    id: 'file-structure',
    title: 'Changed files — structure',
    defaultOpen: { page: false },
    show: { page: true, rail: false },
  },
  {
    id: 'test-insight',
    title: 'Test coverage (AI-inferred)',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
  {
    id: 'alternatives',
    title: 'Alternative approaches (AI)',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
  {
    id: 'verdict-evidence',
    title: 'Why this verdict',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
  {
    id: 'ci-details',
    title: 'CI details',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
  {
    id: 'pr-description',
    title: 'Original PR description',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
] as const
