/**
 * Tests for the storyOrder task in src/lib/ai/run.svelte.ts (Plan H).
 *
 * Covers:
 *   - single-pass cache miss → llmJsonWithRepair called, result on run.story, cached
 *   - single-pass cache hit → no llm call, status done, track cached:true
 *   - deep path (aiDeepReview on, tools wired): runs the loop, '|deep' cache key,
 *     toolCallsUsed surfaced, deep result cached
 *   - toggle off → loop NEVER invoked (byte-identical single-pass)
 *   - error path → status 'error'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import { LlmError } from '../llm/llm'
import type { PackedContext } from '../context/pack'
import type { StoryOrderResult } from './schemas'
import { validateStoryOrder } from './schemas'

const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
  // Compact story summaries — the changed-file list the deterministic fallback
  // classifies (and the compact prompt sends). Mirrors STORY_RESULT's paths.
  storyFiles: [
    { path: 'src/db/schema.ts', additions: 10, deletions: 2, hunkHeaders: ['@@ -1,3 +1,11 @@ class Schema'] },
    { path: 'src/api/route.ts', additions: 5, deletions: 1, hunkHeaders: ['@@ -4,2 +4,7 @@ function route'] },
  ],
}

const STORY_RESULT: StoryOrderResult = {
  steps: [
    { index: 0, files: ['src/db/schema.ts'], caption: 'Schema gains a column.', layer: 'data', relatedTests: ['src/db/schema.test.ts'] },
    { index: 1, files: ['src/api/route.ts'], caption: 'API reads it.', layer: 'api', relatedTests: [] },
  ],
}

type ValidateFn = (x: unknown) => unknown

function makeDeps({ hasKey = true, deep = false } = {}) {
  const settings: Record<string, unknown> = {}
  if (hasKey) settings['deepseekKey'] = 'sk-test'
  if (deep) settings['aiDeepReview'] = true
  localStorage.setItem('review123:settings', JSON.stringify(settings))

  const gateAi = vi.fn().mockResolvedValue(true)
  const getCached = vi.fn().mockResolvedValue(null)
  const setCached = vi.fn().mockResolvedValue(undefined)
  const llmStream = vi.fn().mockResolvedValue('hello')
  const llmStreamWithUsage = vi.fn().mockResolvedValue({ content: 'hello', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  const llmJsonWithRepair = vi.fn().mockImplementation(async (_o: unknown, validate: ValidateFn) =>
    validate(STORY_RESULT) !== null ? STORY_RESULT : { steps: [] },
  )
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async (_o: unknown, validate: ValidateFn) => ({
    result: validate(STORY_RESULT) !== null ? STORY_RESULT : { steps: [] },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }))
  const llmToolLoop = vi.fn().mockResolvedValue({
    content: JSON.stringify(STORY_RESULT),
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    toolCallsUsed: 2,
  })
  const track = vi.fn()

  return { gateAi, getCached, setCached, llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage, llmToolLoop, track }
}

// Build a PackedContext whose storyFiles match the given step paths, so the
// usability gate (mirrors InspectStep.storyHasUsableSteps) recognises the AI
// result's paths as real PR files. Defaults to PACKED_CTX's paths.
function ctxWithPaths(paths: string[]): PackedContext {
  return {
    text: 'some PR context',
    notAnalyzed: [],
    includedFiles: paths,
    storyFiles: paths.map((p) => ({ path: p, additions: 1, deletions: 0, hunkHeaders: [] })),
  }
}

function makeInput(deepSource = true, ctx: PackedContext = PACKED_CTX): Parameters<typeof createAiRun>[0] {
  return {
    prKey: 'owner/repo#1@abc',
    repo: 'owner/repo',
    isPrivate: false,
    pack: async () => ctx,
    ci: async () => null,
    ask: async () => true,
    ...(deepSource
      ? {
          deepReview: {
            getFileAtHead: async () => 'head contents',
            getFileAtBase: async () => 'base contents',
            searchCode: async () => 'search results',
          },
        }
      : {}),
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('storyOrder task — single-pass', () => {
  it('runs via llmJsonWithRepair on a cache miss and exposes the result', async () => {
    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    await run.start()
    expect(run.story.status).toBe('done')
    expect(run.story.value).toEqual(STORY_RESULT)
    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    // cached under the single-pass 'story' key (cacheKey joins with '|')
    expect(deps.setCached).toHaveBeenCalledWith(expect.stringContaining('|story|'), STORY_RESULT)
  })

  it('uses a cache hit without calling the llm and tracks cached:true', async () => {
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) =>
      key.includes('|story|') ? STORY_RESULT : null,
    )
    const run = createAiRun(makeInput(), deps)
    await run.start()
    expect(run.story.status).toBe('done')
    expect(run.story.value).toEqual(STORY_RESULT)
    expect(deps.llmJsonWithRepairWithUsage).not.toHaveBeenCalledWith(
      expect.anything(),
      validateStoryOrder,
    )
    expect(deps.track).toHaveBeenCalledWith('ai_task_completed', expect.objectContaining({ task: 'story', cached: true }))
  })

  it('degrades to the deterministic fallback when the llm call fails (never hard-errors)', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      if (validate(STORY_RESULT) !== null) throw new LlmError('server', 'boom')
      return { result: { steps: [] }, usage: undefined }
    })
    const run = createAiRun(makeInput(), deps)
    await run.start()
    // Robustness: status is 'done' with a usable structural story + fallback flag,
    // NOT 'error'. Story mode renders rather than collapsing into the hard error.
    expect(run.story.status).toBe('done')
    expect(run.story.fallback).toBe(true)
    const result = run.story.value as StoryOrderResult
    expect(result.steps.length).toBeGreaterThan(0)
    // Every changed file is covered exactly once by the deterministic story.
    const placed = result.steps.flatMap((s) => s.files)
    expect(placed.sort()).toEqual(['src/api/route.ts', 'src/db/schema.ts'])
    // The fallback is NOT cached as an AI result.
    expect(deps.setCached).not.toHaveBeenCalledWith(expect.stringContaining('|story|'), expect.anything())
  })

  it('surfaces the SPECIFIC LlmError message in the fallback reason (not just the generic kind)', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      if (validate(STORY_RESULT) !== null) throw new LlmError('invalid-output', 'context length exceeded')
      return { result: { steps: [] }, usage: undefined }
    })
    const run = createAiRun(makeInput(), deps)
    await run.start()
    expect(run.story.status).toBe('done')
    expect(run.story.fallback).toBe(true)
    expect(run.story.fallbackReason).toContain('context length exceeded')
  })

  it('a successful AI story is cached and carries NO fallback flag', async () => {
    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    await run.start()
    expect(run.story.status).toBe('done')
    expect(run.story.fallback).toBeFalsy()
    expect(run.story.value).toEqual(STORY_RESULT)
    expect(deps.setCached).toHaveBeenCalledWith(expect.stringContaining('|story|'), STORY_RESULT)
  })
})

describe('storyOrder task — post-process (dedupe / cap / salvage)', () => {
  it('de-duplicates a file shown in two steps before exposing/caching the result', async () => {
    const deps = makeDeps()
    const dup: StoryOrderResult = {
      steps: [
        { index: 0, files: ['a.ts', 'b.ts'], caption: 'one', layer: 'data', relatedTests: [] },
        { index: 1, files: ['b.ts', 'c.ts'], caption: 'two', layer: 'api', relatedTests: [] },
      ],
    }
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => ({
      result: validate(dup), // validator IS shapeStoryOrder now → returns deduped
      usage: undefined,
    }))
    const run = createAiRun(makeInput(true, ctxWithPaths(['a.ts', 'b.ts', 'c.ts'])), deps)
    await run.start()
    expect(run.story.status).toBe('done')
    const result = run.story.value as StoryOrderResult
    expect(result.steps[0].files).toEqual(['a.ts', 'b.ts'])
    expect(result.steps[1].files).toEqual(['c.ts'])
    // the de-duplicated result is what gets cached
    expect(deps.setCached).toHaveBeenCalledWith(expect.stringContaining('|story|'), result)
  })

  it('caps the story to STORY_MAX_STEPS on a big PR', async () => {
    const deps = makeDeps()
    const many: StoryOrderResult = {
      steps: Array.from({ length: 20 }, (_, i) => ({
        index: i,
        files: [`f${i}.ts`],
        caption: `step ${i}`,
        layer: 'data' as const,
        relatedTests: [],
      })),
    }
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => ({
      result: validate(many),
      usage: undefined,
    }))
    const run = createAiRun(
      makeInput(true, ctxWithPaths(Array.from({ length: 20 }, (_, i) => `f${i}.ts`))),
      deps,
    )
    await run.start()
    const result = run.story.value as StoryOrderResult
    expect(result.steps).toHaveLength(12)
    expect(result.steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('salvages partial JSON: keeps valid steps, drops malformed ones', async () => {
    const deps = makeDeps()
    const partial = {
      steps: [
        { index: 0, files: ['ok.ts'], caption: 'good', layer: 'data', relatedTests: [] },
        { files: ['bad.ts'], layer: 'frontend', relatedTests: [] }, // bad layer → dropped by salvage
      ],
    }
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => ({
      result: validate(partial), // strict validate fails → salvage keeps ok.ts
      usage: undefined,
    }))
    const run = createAiRun(makeInput(true, ctxWithPaths(['ok.ts', 'bad.ts'])), deps)
    await run.start()
    expect(run.story.status).toBe('done')
    const result = run.story.value as StoryOrderResult
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].files).toEqual(['ok.ts'])
  })

  it('degrades to the fallback (never caches) when nothing usable survives the salvage', async () => {
    const deps = makeDeps()
    // validate() returns null after shaping → llmJsonWithRepair throws invalid-output
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      const shaped = validate({ steps: [{ files: [], layer: 'data' }] })
      if (shaped === null) throw new LlmError('invalid-output', 'no usable steps')
      return { result: shaped, usage: undefined }
    })
    const run = createAiRun(makeInput(), deps)
    await run.start()
    // No hard error: the structural fallback renders instead.
    expect(run.story.status).toBe('done')
    expect(run.story.fallback).toBe(true)
    expect((run.story.value as StoryOrderResult).steps.length).toBeGreaterThan(0)
    expect(deps.setCached).not.toHaveBeenCalledWith(expect.stringContaining('|story|'), expect.anything())
  })
})

describe('storyOrder task — deep (agentic) path', () => {
  it('runs the tool loop, caches under a |deep key, and surfaces toolCallsUsed', async () => {
    const deps = makeDeps({ deep: true })
    const run = createAiRun(makeInput(), deps)
    await run.start()
    expect(deps.llmToolLoop).toHaveBeenCalled()
    expect(run.story.status).toBe('done')
    expect(run.story.value).toEqual(STORY_RESULT)
    expect(run.story.toolCallsUsed).toBe(2)
    expect(deps.setCached).toHaveBeenCalledWith(
      expect.stringContaining('story|deep'),
      expect.objectContaining({ deep: true, toolCallsUsed: 2 }),
    )
  })

  it('toggle OFF never invokes the tool loop (byte-identical single-pass)', async () => {
    const deps = makeDeps({ deep: false })
    const run = createAiRun(makeInput(), deps)
    await run.start()
    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(run.story.status).toBe('done')
  })
})
