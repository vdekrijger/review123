import { describe, it, expect } from 'vitest'
import { buildFileTree } from './buildTree'
import type { PrFile } from '../github/types'

function makeFile(filename: string, additions = 1, deletions = 0): PrFile {
  return { filename, status: 'modified', additions, deletions }
}

function renamedFile(filename: string, previousFilename: string): PrFile {
  return { filename, previousFilename, status: 'renamed', additions: 0, deletions: 0 }
}

describe('buildFileTree', () => {
  it('builds a flat list of files with no directories', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')]
    const root = buildFileTree(files)
    expect(root.name).toBe('')
    expect(root.path).toBe('')
    expect(root.file).toBeNull()
    expect(root.children).toHaveLength(2)
    expect(root.children[0].name).toBe('a.ts')
    expect(root.children[0].file).toBe(files[0])
    expect(root.children[1].name).toBe('b.ts')
    expect(root.children[1].file).toBe(files[1])
  })

  it('builds nested directories', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts'), makeFile('lib/c.ts')]
    const root = buildFileTree(files)
    // dirs before files; alpha order: lib < src
    expect(root.children).toHaveLength(2)
    expect(root.children[0].name).toBe('lib')
    expect(root.children[0].file).toBeNull()
    expect(root.children[0].children[0].name).toBe('c.ts')
    expect(root.children[1].name).toBe('src')
    expect(root.children[1].children).toHaveLength(2)
  })

  it('collapses single-child directory chains (GitHub-style)', () => {
    // a/b/c.ts → node named "a/b" (collapsed chain) with child "c.ts"
    const files = [makeFile('a/b/c.ts')]
    const root = buildFileTree(files)
    expect(root.children).toHaveLength(1)
    const collapsed = root.children[0]
    expect(collapsed.name).toBe('a/b')
    expect(collapsed.file).toBeNull()
    expect(collapsed.children).toHaveLength(1)
    expect(collapsed.children[0].name).toBe('c.ts')
    expect(collapsed.children[0].file).toBe(files[0])
  })

  it('collapses long single-child chains', () => {
    const files = [makeFile('x/y/z/deep.ts')]
    const root = buildFileTree(files)
    const node = root.children[0]
    expect(node.name).toBe('x/y/z')
    expect(node.children[0].name).toBe('deep.ts')
  })

  it('does NOT collapse when a directory has multiple children', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const root = buildFileTree(files)
    const srcNode = root.children[0]
    expect(srcNode.name).toBe('src')
    // src has 2 children — no collapse
    expect(srcNode.children).toHaveLength(2)
  })

  it('dirs before files — alpha within each group', () => {
    const files = [makeFile('b.ts'), makeFile('a/x.ts'), makeFile('a.ts'), makeFile('z/y.ts')]
    const root = buildFileTree(files)
    // dirs first: a (collapsed to "a"), z
    // files after: a.ts, b.ts
    const names = root.children.map(n => n.name)
    expect(names[0]).toBe('a') // dir
    expect(names[1]).toBe('z') // dir
    expect(names[2]).toBe('a.ts') // file
    expect(names[3]).toBe('b.ts') // file
  })

  it('uses filename (not previousFilename) for renamed files', () => {
    const file = renamedFile('src/new.ts', 'src/old.ts')
    const root = buildFileTree([file])
    // Should show up under "src" with name "new.ts"
    const srcNode = root.children[0]
    expect(srcNode.name).toBe('src')
    expect(srcNode.children[0].name).toBe('new.ts')
    expect(srcNode.children[0].file).toBe(file)
  })

  it('deterministic sort is stable for same-type siblings', () => {
    const files = [makeFile('b/x.ts'), makeFile('a/y.ts')]
    const root = buildFileTree(files)
    expect(root.children[0].name).toBe('a')
    expect(root.children[1].name).toBe('b')
  })

  it('sets correct path on collapsed nodes', () => {
    const files = [makeFile('deep/chain/file.ts')]
    const root = buildFileTree(files)
    const collapsed = root.children[0]
    expect(collapsed.path).toBe('deep/chain')
    expect(collapsed.children[0].path).toBe('deep/chain/file.ts')
  })

  it('handles files at root (no directory prefix)', () => {
    const files = [makeFile('README.md'), makeFile('src/index.ts')]
    const root = buildFileTree(files)
    // src dir first, then README.md
    expect(root.children[0].name).toBe('src')
    expect(root.children[1].name).toBe('README.md')
  })

  it('returns empty children for empty input', () => {
    const root = buildFileTree([])
    expect(root.children).toHaveLength(0)
  })
})
