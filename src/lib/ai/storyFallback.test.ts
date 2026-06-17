/**
 * Tests for the deterministic structural story fallback (storyFallback.ts).
 *
 * Guarantees under test:
 *   - every layer heuristic classifies as expected,
 *   - 100% file coverage (every input path appears exactly once),
 *   - respects STORY_MAX_STEPS (and a custom cap),
 *   - generated files sink last,
 *   - deterministic output for a given input,
 *   - empty input → empty steps.
 */

import { describe, it, expect } from 'vitest'
import { buildDeterministicStory, classifyStoryLayer } from './storyFallback'
import { STORY_LAYERS, STORY_MAX_STEPS } from './schemas'

describe('classifyStoryLayer — path heuristics', () => {
  it.each([
    ['src/db/schema.ts', 'data'],
    ['migrations/001_init.sql', 'data'],
    ['src/models/user.ts', 'data'],
    ['src/types.ts', 'data'],
    ['src/api/route.ts', 'api'],
    ['src/lib/api.ts', 'api'],
    ['src/lib/orchestrator.ts', 'logic'],
    ['src/lib/helpers.go', 'logic'],
    ['app.config.ts', 'config'],
    ['src/constants.ts', 'config'],
    ['.env.production', 'config'],
    ['src/components/Button.svelte', 'ui'],
    ['src/ui/theme.css', 'ui'],
    ['src/widgets/Card.tsx', 'ui'],
    ['src/lib/foo.test.ts', 'tests'],
    ['src/lib/foo.spec.ts', 'tests'],
    ['tests/test_foo.py', 'tests'],
    ['pkg/foo_test.go', 'tests'],
    ['src/__tests__/foo.ts', 'tests'],
    ['pnpm-lock.yaml', 'other'],
    ['dist/bundle.min.js', 'other'],
    ['src/__snapshots__/x.snap', 'other'],
  ] as const)('classifies %s as %s', (path, expected) => {
    expect(classifyStoryLayer(path)).toBe(expected)
  })

  it('generated wins over every other heuristic (a generated .svelte is "other")', () => {
    expect(classifyStoryLayer('dist/Widget.svelte')).toBe('other')
  })

  it('test wins over ui (a Button.test.ts is tests, not ui)', () => {
    expect(classifyStoryLayer('src/components/Button.test.ts')).toBe('tests')
  })
})

describe('buildDeterministicStory', () => {
  it('empty input → empty steps', () => {
    expect(buildDeterministicStory([])).toEqual({ steps: [] })
  })

  it('covers EVERY input path exactly once (100% coverage, no dupes)', () => {
    const files = [
      'src/db/schema.ts',
      'src/api/route.ts',
      'src/lib/logic.ts',
      'src/components/View.svelte',
      'src/lib/logic.test.ts',
      'app.config.ts',
    ]
    const story = buildDeterministicStory(files)
    const placed = story.steps.flatMap((s) => s.files)
    expect(placed.slice().sort()).toEqual(files.slice().sort())
    // no duplicates
    expect(new Set(placed).size).toBe(placed.length)
  })

  it('orders steps by the canonical STORY_LAYERS order', () => {
    const files = [
      'src/components/View.svelte', // ui
      'src/db/schema.ts', // data
      'src/api/route.ts', // api
    ]
    const story = buildDeterministicStory(files)
    const layers = story.steps.map((s) => s.layer)
    // data before api before ui (canonical order), regardless of input order.
    const dataIdx = layers.indexOf('data')
    const apiIdx = layers.indexOf('api')
    const uiIdx = layers.indexOf('ui')
    expect(dataIdx).toBeLessThan(apiIdx)
    expect(apiIdx).toBeLessThan(uiIdx)
    expect(STORY_LAYERS.indexOf('data')).toBeLessThan(STORY_LAYERS.indexOf('ui'))
  })

  it('sinks generated files to the LAST step', () => {
    const files = ['pnpm-lock.yaml', 'src/db/schema.ts', 'dist/bundle.min.js']
    const story = buildDeterministicStory(files)
    const last = story.steps[story.steps.length - 1]
    expect(last.layer).toBe('other')
    expect(last.files.slice().sort()).toEqual(['dist/bundle.min.js', 'pnpm-lock.yaml'])
  })

  it('respects STORY_MAX_STEPS — never exceeds the cap, never drops a file', () => {
    // One distinct layer-per-file is impossible (only ~8 layers), so to force
    // many steps we feed enough files; the cap still bounds the result and all
    // files remain covered.
    const files = Array.from({ length: 60 }, (_, i) => {
      const layers = ['db/schema', 'api/route', 'lib/logic', 'components/View', 'foo.test', 'app.config']
      const seg = layers[i % layers.length]
      return `src/${seg}.${i}.ts`
    })
    const story = buildDeterministicStory(files)
    expect(story.steps.length).toBeLessThanOrEqual(STORY_MAX_STEPS)
    const placed = story.steps.flatMap((s) => s.files)
    expect(placed.slice().sort()).toEqual(files.slice().sort())
    expect(new Set(placed).size).toBe(files.length)
    // indices are 0..n-1
    expect(story.steps.map((s) => s.index)).toEqual(story.steps.map((_, i) => i))
  })

  it('respects a custom maxSteps cap', () => {
    const files = [
      'src/db/schema.ts',
      'src/api/route.ts',
      'src/lib/logic.ts',
      'src/components/View.svelte',
    ]
    const story = buildDeterministicStory(files, { maxSteps: 2 })
    expect(story.steps.length).toBeLessThanOrEqual(2)
    expect(story.steps.flatMap((s) => s.files).slice().sort()).toEqual(files.slice().sort())
  })

  it('is deterministic for a given input', () => {
    const files = ['src/db/schema.ts', 'src/api/route.ts', 'src/lib/logic.ts', 'a.test.ts']
    expect(buildDeterministicStory(files)).toEqual(buildDeterministicStory(files))
  })

  it('dedupes repeated input paths (each appears once)', () => {
    const story = buildDeterministicStory(['src/db/schema.ts', 'src/db/schema.ts'])
    expect(story.steps.flatMap((s) => s.files)).toEqual(['src/db/schema.ts'])
  })

  it('produces honest captions naming files for small steps, counts for large', () => {
    const small = buildDeterministicStory(['src/db/schema.ts'])
    expect(small.steps[0].caption).toContain('schema.ts')
    const big = buildDeterministicStory(
      Array.from({ length: 5 }, (_, i) => `src/db/m${i}.sql`),
    )
    expect(big.steps[0].caption).toMatch(/across 5 files/)
  })

  it('always sets relatedTests to [] (no AI pairing)', () => {
    const story = buildDeterministicStory(['src/db/schema.ts', 'src/lib/logic.test.ts'])
    for (const step of story.steps) expect(step.relatedTests).toEqual([])
  })
})
