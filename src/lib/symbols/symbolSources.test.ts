import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerSymbolSource,
  unregisterSymbolSource,
  currentSymbolIndex,
  registeredSymbolFilenames,
  _resetSymbolSourcesForTest,
} from './symbolSources'

const utilFile = {
  filename: 'src/util.ts',
  patch: '@@ -1,1 +1,2 @@\n context\n+export function sharedThing() {}',
}
const appFile = {
  filename: 'src/app.ts',
  patch: '@@ -1,1 +1,2 @@\n context\n+const v = sharedThing()',
}

beforeEach(() => {
  _resetSymbolSourcesForTest()
})

describe('symbolSources registry', () => {
  it('indexes across all registered files', () => {
    registerSymbolSource(utilFile)
    registerSymbolSource(appFile)
    const index = currentSymbolIndex()
    expect(index.definitionsOf('sharedThing')[0]?.file).toBe('src/util.ts')
    expect(index.referencesOf('sharedThing')[0]?.file).toBe('src/app.ts')
  })

  it('unregistering removes a file from the index', () => {
    registerSymbolSource(utilFile)
    registerSymbolSource(appFile)
    unregisterSymbolSource('src/util.ts')
    const index = currentSymbolIndex()
    expect(index.definitionsOf('sharedThing')).toHaveLength(0)
    expect(index.referencesOf('sharedThing')).toHaveLength(1) // app.ts still there
  })

  it('ref-counts duplicate registrations of the same file', () => {
    registerSymbolSource(utilFile) // e.g. Files-mode card
    registerSymbolSource(utilFile) // e.g. Story-mode snippet of the same file
    unregisterSymbolSource('src/util.ts')
    expect(currentSymbolIndex().definitionsOf('sharedThing')).toHaveLength(1)
    unregisterSymbolSource('src/util.ts')
    expect(currentSymbolIndex().definitionsOf('sharedThing')).toHaveLength(0)
  })

  it('re-registering refreshes the stored source (contents arriving later)', () => {
    registerSymbolSource(utilFile)
    registerSymbolSource({
      ...utilFile,
      contents: { before: null, after: 'export function sharedThing() {}\nconst local = sharedThing()' },
    })
    const refs = currentSymbolIndex().referencesOf('sharedThing')
    expect(refs).toHaveLength(1)
    expect(refs[0].line).toBe(2)
    // Two registrations happened — both must unregister before the file drops.
    unregisterSymbolSource('src/util.ts')
    expect(currentSymbolIndex().definitionsOf('sharedThing')).toHaveLength(1)
  })

  it('caches the index between lookups and invalidates on change', () => {
    registerSymbolSource(utilFile)
    const first = currentSymbolIndex()
    expect(currentSymbolIndex()).toBe(first) // cached instance
    registerSymbolSource(appFile)
    expect(currentSymbolIndex()).not.toBe(first) // invalidated + rebuilt
  })

  it('unregistering an unknown file is a no-op', () => {
    expect(() => unregisterSymbolSource('nope.ts')).not.toThrow()
  })

  it('exposes the registered filenames (repo search excludes the PR files)', () => {
    registerSymbolSource(utilFile)
    registerSymbolSource(appFile)
    expect(registeredSymbolFilenames()).toEqual(new Set(['src/util.ts', 'src/app.ts']))
    unregisterSymbolSource('src/app.ts')
    expect(registeredSymbolFilenames()).toEqual(new Set(['src/util.ts']))
  })
})
