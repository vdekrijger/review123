// @vitest-environment node
/**
 * capabilities.test.ts — CLI detection against a STUBBED PATH.
 *
 * Two layers are covered: the pure PATH walk (with an injected probe) and the
 * real one (against a temp dir holding a genuinely executable file), so the
 * "detect by probing the binary, never run it" rule is verified end to end.
 */
import { describe, it, expect, vi } from 'vitest'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  INFERENCE_CLIS,
  defaultCapabilityDeps,
  detectCapabilities,
  detectInferenceClis,
  findOnPath,
  isExecutableFile,
  type CapabilityDeps,
} from './capabilities.js'

/** Deps whose PATH is `dirs` and where only `present` paths are executable. */
function stubDeps(dirs: string[], present: string[]): CapabilityDeps {
  return {
    env: { PATH: dirs.join(delimiter) },
    isExecutable: async (path) => present.includes(path),
  }
}

describe('findOnPath', () => {
  it('finds a binary in the first PATH entry that has it', async () => {
    const deps = stubDeps(['/a/bin', '/b/bin'], ['/b/bin/claude'])
    expect(await findOnPath('claude', deps)).toBe(true)
  })

  it('returns false when no PATH entry has it', async () => {
    expect(await findOnPath('claude', stubDeps(['/a/bin'], []))).toBe(false)
  })

  it('returns false for an absent PATH', async () => {
    const deps: CapabilityDeps = { env: {}, isExecutable: async () => true }
    expect(await findOnPath('claude', deps)).toBe(false)
  })

  it('never resolves an EMPTY PATH entry against the cwd (PATH-injection footgun)', async () => {
    const isExecutable = vi.fn(async (_path: string) => false)
    await findOnPath('claude', { env: { PATH: `${delimiter}/a/bin${delimiter}` }, isExecutable })
    expect(isExecutable).toHaveBeenCalledTimes(1)
    expect(isExecutable).toHaveBeenCalledWith(join('/a/bin', 'claude'))
  })
})

describe('detectInferenceClis', () => {
  it('lists only the CLIs actually on PATH, in a stable order', async () => {
    const deps = stubDeps(['/bin'], ['/bin/codex'])
    expect(await detectInferenceClis(deps)).toEqual(['codex'])
  })

  it('lists both when both are installed', async () => {
    const deps = stubDeps(['/bin'], ['/bin/claude', '/bin/codex'])
    expect(await detectInferenceClis(deps)).toEqual(['claude', 'codex'])
  })

  it('is empty on a machine with neither', async () => {
    expect(await detectInferenceClis(stubDeps(['/bin'], []))).toEqual([])
  })

  it('only ever probes the hard-coded CLI names', async () => {
    const isExecutable = vi.fn(async (_path: string) => false)
    await detectInferenceClis({ env: { PATH: '/bin' }, isExecutable })
    const probed = isExecutable.mock.calls.map(([path]) => String(path).split('/').pop())
    expect(probed).toEqual([...INFERENCE_CLIS])
  })
})

describe('detectCapabilities', () => {
  it('reports files/search as NOT ready while their routes answer 501, and infer as READY', async () => {
    const caps = await detectCapabilities(stubDeps(['/bin'], ['/bin/claude']))
    expect(caps).toEqual({ inference: ['claude'], infer: true, files: false, search: false })
  })

  it('reports infer READY even with no CLI detected — readiness and detection are different questions', async () => {
    const caps = await detectCapabilities(stubDeps(['/bin'], []))
    expect(caps).toEqual({ inference: [], infer: true, files: false, search: false })
  })
})

describe('isExecutableFile (the real probe)', () => {
  it('detects a real executable on a stubbed PATH without running it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-path-'))
    const fake = join(dir, 'claude')
    // A script that would fail loudly if the detector ever executed it.
    await writeFile(fake, '#!/bin/sh\nexit 42\n')
    await chmod(fake, 0o755)

    const deps = defaultCapabilityDeps({ PATH: dir })
    expect(await detectInferenceClis(deps)).toEqual(['claude'])
  })

  it('ignores a non-executable file of the right name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-path-'))
    const fake = join(dir, 'codex')
    await writeFile(fake, 'not executable\n')
    await chmod(fake, 0o644)

    expect(await isExecutableFile(fake)).toBe(false)
    expect(await detectInferenceClis(defaultCapabilityDeps({ PATH: dir }))).toEqual([])
  })

  it('ignores a DIRECTORY of the right name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-path-'))
    expect(await isExecutableFile(dir)).toBe(false)
  })

  it('returns false for a missing path instead of throwing', async () => {
    expect(await isExecutableFile('/definitely/not/here/claude')).toBe(false)
  })
})
