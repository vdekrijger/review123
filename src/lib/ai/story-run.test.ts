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

function makeInput(deepSource = true): Parameters<typeof createAiRun>[0] {
  return {
    prKey: 'owner/repo#1@abc',
    repo: 'owner/repo',
    isPrivate: false,
    pack: async () => PACKED_CTX,
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

  it('sets error status when the llm call fails', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      if (validate(STORY_RESULT) !== null) throw new LlmError('server', 'boom')
      return { result: { steps: [] }, usage: undefined }
    })
    const run = createAiRun(makeInput(), deps)
    await run.start()
    expect(run.story.status).toBe('error')
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
