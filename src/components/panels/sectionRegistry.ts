/**
 * sectionRegistry.ts — single source of truth for the UnderstandStep / ContextRail section list.
 *
 * Both UnderstandStep and ContextRail render from this registry, guaranteeing:
 *   • Identical ORDER everywhere (summary → diagrams → file-structure → test-insight →
 *     alternatives → verdict-evidence → ci-details → pr-description).
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
export const SECTION_REGISTRY: readonly SectionDescriptor[] = [
  {
    id: 'summary',
    title: 'Full summary',
    defaultOpen: { page: false },
    show: { page: true, rail: true },
  },
  {
    id: 'diagrams',
    title: 'Diagrams',
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
