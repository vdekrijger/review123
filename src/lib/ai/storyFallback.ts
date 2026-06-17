/**
 * src/lib/ai/storyFallback.ts — Deterministic structural story fallback.
 *
 * When the LLM story task fails (context overflow on a big PR, malformed JSON,
 * rate-limit, …) OR returns an unusable result, Story mode must STILL render a
 * walkthrough rather than collapsing into the generic hard-error state. This
 * module builds that walkthrough WITHOUT any LLM call, purely from the changed
 * file PATHS.
 *
 * Design:
 *   - Classify each path into a StoryLayer by PATH heuristics (generated → sink
 *     last like sinkGeneratedSteps; tests detected by filename convention; the
 *     rest by segment/extension heuristics). This is a heuristic — it prefers a
 *     sensible, honest grouping over per-file perfection.
 *   - Group files of the same layer into one step, ordered by the canonical
 *     STORY_LAYERS order, then re-balance so the total step count never exceeds
 *     STORY_MAX_STEPS (coalescing the smallest adjacent steps) while NEVER
 *     dropping a file — every input path appears in exactly one step.
 *   - Captions are generic but honest ("Data layer — `types.ts`, `schema.ts`",
 *     "Logic changes across 9 files"). relatedTests is always empty (no AI
 *     pairing in the structural fallback).
 *
 * Pure + deterministic: the same input always yields the same output. Empty
 * input → { steps: [] }.
 */

import { isGeneratedPath } from '../diff/generated'
import {
  STORY_LAYERS,
  STORY_MAX_STEPS,
  normalizeStoryPath,
  type StoryLayer,
  type StoryOrderResult,
  type StoryStep,
} from './schemas'

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/**
 * True when a path looks like a test file by common cross-language conventions:
 * `.test.` / `.spec.` infixes, a `__tests__/` directory segment, a `_test.` /
 * `test_` Python/Go-style affix.
 */
function isTestPath(path: string): boolean {
  const p = normalizeStoryPath(path)
  const base = p.split('/').pop() ?? p
  if (/\.(test|spec)\./i.test(base)) return true // foo.test.ts, foo.spec.tsx
  if (/(^|[._-])test[._-]/i.test(base)) return true // test_foo.py, foo_test.go
  if (/_test\.[^.]+$/i.test(base)) return true // foo_test.go (suffix form)
  if (p.split('/').some((s) => s === '__tests__' || s === 'tests' || s === 'test')) return true
  return false
}

/**
 * Classify a single changed file into a StoryLayer by PATH heuristics only.
 *
 * Precedence (first match wins — most specific signals first):
 *   1. generated → 'other' (sunk last, like sinkGeneratedSteps).
 *   2. test files → 'tests'.
 *   3. UI: `.svelte`/`.tsx`/`.jsx`/`.css` extensions, or a `/components/`,
 *      `/ui/` directory segment.
 *   4. api: an `/api/` segment or an `api.`-prefixed basename.
 *   5. data: `schema`/`model`/`types` in the basename, a `/db/` segment, or a
 *      `.sql`/`.prisma` extension.
 *   6. config: `config`/`.config.`/`constants`/`.env` in the path.
 *   7. else → 'logic' (the catch-all for business logic / core code).
 *
 * 'other' (generated) and 'foundational' are not actively assigned here:
 * 'foundational' has no reliable path signal, and 'other' is reserved for the
 * generated sink. Everything unclassified lands in 'logic', which is honest.
 */
export function classifyStoryLayer(path: string): StoryLayer {
  const p = normalizeStoryPath(path)
  const base = (p.split('/').pop() ?? p).toLowerCase()
  const segments = p.toLowerCase().split('/')

  // 1. Generated → sink last (reuse the single source of truth).
  if (isGeneratedPath(p)) return 'other'

  // 2. Tests.
  if (isTestPath(p)) return 'tests'

  // 3. UI / frontend / styling.
  if (/\.(svelte|tsx|jsx|css|scss|sass|less|vue)$/i.test(base)) return 'ui'
  if (segments.some((s) => s === 'components' || s === 'ui')) return 'ui'

  // 4. API / transport / routing.
  if (segments.some((s) => s === 'api')) return 'api'
  if (/^api[._]/i.test(base) || /[._]api\./i.test(base)) return 'api'

  // 5. Data model / schema / persistence.
  if (/\.(sql|prisma)$/i.test(base)) return 'data'
  if (segments.some((s) => s === 'db' || s === 'migrations' || s === 'models')) return 'data'
  if (/schema|model|types/i.test(base)) return 'data'

  // 6. Config / constants / build wiring.
  if (/\.config\.[^.]+$/i.test(base)) return 'config'
  if (/(^|[._-])(config|constants)([._-]|$)/i.test(base)) return 'config'
  if (/\.env(\.|$)/i.test(base)) return 'config'

  // 7. Everything else is business logic.
  return 'logic'
}

// ---------------------------------------------------------------------------
// Caption helpers
// ---------------------------------------------------------------------------

const LAYER_NAME: Record<StoryLayer, string> = {
  data: 'Data layer',
  api: 'API layer',
  logic: 'Logic',
  config: 'Configuration',
  tests: 'Tests',
  ui: 'UI',
  foundational: 'Foundational',
  other: 'Generated / other',
}

/** Basename of a path, for compact captions. */
function basename(path: string): string {
  const p = normalizeStoryPath(path)
  return p.split('/').pop() ?? p
}

/**
 * Honest caption for a step. Small steps name their files; larger ones say
 * "N files" so the caption stays one tidy line.
 */
function captionFor(layer: StoryLayer, files: readonly string[]): string {
  const name = LAYER_NAME[layer]
  if (files.length === 0) return name
  if (files.length <= 3) {
    const list = files.map((f) => `\`${basename(f)}\``).join(', ')
    return `${name} — ${list}`
  }
  return `${name} changes across ${files.length} files`
}

// ---------------------------------------------------------------------------
// buildDeterministicStory
// ---------------------------------------------------------------------------

export interface DeterministicStoryOptions {
  /** Override the step cap (defaults to STORY_MAX_STEPS). Tests use this. */
  maxSteps?: number
}

/**
 * Build a structural Story walkthrough from the changed file PATHS alone — never
 * calls an LLM. Guarantees:
 *   - every input path appears in EXACTLY ONE step (100% coverage, no dupes),
 *   - steps are ordered by the canonical STORY_LAYERS order (generated 'other'
 *     sinks last),
 *   - total step count ≤ maxSteps (default STORY_MAX_STEPS) via coalescing,
 *   - deterministic output for a given input; empty input → { steps: [] }.
 */
export function buildDeterministicStory(
  prFilenames: readonly string[],
  opts?: DeterministicStoryOptions,
): StoryOrderResult {
  const maxSteps = Math.max(1, opts?.maxSteps ?? STORY_MAX_STEPS)

  // Dedupe while preserving first-seen order (so output is deterministic and a
  // path never lands in two steps).
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const f of prFilenames) {
    const key = normalizeStoryPath(f)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    ordered.push(f)
  }
  if (ordered.length === 0) return { steps: [] }

  // Bucket by layer (preserving input order within each bucket).
  const buckets = new Map<StoryLayer, string[]>()
  for (const f of ordered) {
    const layer = classifyStoryLayer(f)
    const bucket = buckets.get(layer)
    if (bucket) bucket.push(f)
    else buckets.set(layer, [f])
  }

  // Emit one step per non-empty layer, in canonical STORY_LAYERS order.
  let steps: StoryStep[] = []
  for (const layer of STORY_LAYERS) {
    const files = buckets.get(layer)
    if (!files || files.length === 0) continue
    steps.push({
      index: steps.length,
      files,
      caption: captionFor(layer, files),
      layer,
      relatedTests: [],
    })
  }

  // Cap: coalesce the SMALLEST adjacent pair repeatedly until within the cap.
  // Merging adjacent steps keeps the layer order roughly intact and never drops
  // a file. The merged step adopts the FIRST member's layer (earlier in reading
  // order) and a combined caption.
  while (steps.length > maxSteps) {
    let bestIdx = 0
    let bestSize = Infinity
    for (let i = 0; i < steps.length - 1; i++) {
      const size = steps[i].files.length + steps[i + 1].files.length
      if (size < bestSize) {
        bestSize = size
        bestIdx = i
      }
    }
    const a = steps[bestIdx]
    const b = steps[bestIdx + 1]
    const mergedFiles = [...a.files, ...b.files]
    const merged: StoryStep = {
      index: a.index,
      files: mergedFiles,
      caption: captionFor(a.layer, mergedFiles),
      layer: a.layer,
      relatedTests: [],
    }
    steps = [...steps.slice(0, bestIdx), merged, ...steps.slice(bestIdx + 2)]
  }

  // Re-index 0..n-1.
  return { steps: steps.map((s, i) => ({ ...s, index: i })) }
}
