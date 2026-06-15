/**
 * src/lib/landing/collapse.ts — per-browser landing-section collapse state.
 *
 * Storage: localStorage `review123:landing-collapsed`
 * Schema:  { [sectionId: string]: boolean }   (true = collapsed)
 * Default: expanded (absent / invalid entries read as not collapsed)
 *
 * This is per-browser UI state (like visits/viewed), NOT a settings.ts field.
 */

const KEY = 'review123:landing-collapsed'

export type LandingSectionId = 'queue' | 'recent' | 'inflight'

type CollapseMap = Record<string, boolean>

function readStore(): CollapseMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: CollapseMap = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') result[id] = value
    }
    return result
  } catch {
    return {}
  }
}

function writeStore(store: CollapseMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

/** Whether a landing section is collapsed. Defaults to false (expanded). */
export function isSectionCollapsed(id: LandingSectionId): boolean {
  return readStore()[id] === true
}

/** Persist the collapsed state for a landing section. */
export function setSectionCollapsed(id: LandingSectionId, collapsed: boolean): void {
  const store = readStore()
  store[id] = collapsed
  writeStore(store)
}
