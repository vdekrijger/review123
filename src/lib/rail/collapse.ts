/**
 * src/lib/rail/collapse.ts — per-browser context-rail section expand state.
 *
 * Storage: localStorage `review123:rail-expanded`
 * Schema:  { [sectionId: string]: boolean }   (true = expanded)
 * Default: collapsed (absent / invalid entries read as not expanded)
 *
 * Mirrors the landing-collapse pattern (src/lib/landing/collapse.ts): this is
 * per-browser UI state (like visits/viewed), NOT a settings.ts field.
 *
 * Note the inverted default vs landing: rail sections start COLLAPSED so the
 * rail doesn't eat screen real estate by duplicating the Understand step's
 * content — only sections the user explicitly expanded come back open.
 */
import type { SectionId } from '../../components/panels/sectionRegistry'

const KEY = 'review123:rail-expanded'

/** Registry section ids plus the rail-only "hotspots" section. */
export type RailSectionId = SectionId | 'hotspots'

type ExpandMap = Record<string, boolean>

function readStore(): ExpandMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: ExpandMap = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') result[id] = value
    }
    return result
  } catch {
    return {}
  }
}

function writeStore(store: ExpandMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

/** Whether a rail section is expanded. Defaults to false (collapsed). */
export function isRailSectionExpanded(id: RailSectionId): boolean {
  return readStore()[id] === true
}

/** Persist the expanded state for a rail section. */
export function setRailSectionExpanded(id: RailSectionId, expanded: boolean): void {
  const store = readStore()
  store[id] = expanded
  writeStore(store)
}
