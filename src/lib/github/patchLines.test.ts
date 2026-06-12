/**
 * Tests for extractPatchLines — the helper that extracts source lines
 * from a GitHub patch for the suggestion button.
 */
import { describe, it, expect } from 'vitest'
import { extractPatchLines } from './patchLines'

// A minimal patch touching lines 2-4 of the new file (RIGHT side)
//   line 1: ' unchanged'
//   line 2: '-old line 2'   → removed (LEFT line 2)
//   line 3: '+new line 3'   → added (RIGHT line 2)
//   line 4: '+new line 4'   → added (RIGHT line 3)
//   line 5: ' trailing'
const SIMPLE_PATCH = `@@ -1,5 +1,5 @@
 unchanged
-old line 2
+new line 3
+new line 4
 trailing`

// A patch adding 3 lines at line 10
const MULTI_HUNK_PATCH = `@@ -8,4 +8,6 @@
 ctx8
 ctx9
-old10
+new10a
+new10b
+new10c
 ctx11`

describe('extractPatchLines', () => {
  it('returns undefined when patch is undefined', () => {
    expect(extractPatchLines(undefined, 3, 'RIGHT')).toBeUndefined()
  })

  it('returns undefined when patch is empty string', () => {
    expect(extractPatchLines('', 3, 'RIGHT')).toBeUndefined()
  })

  it('extracts a single RIGHT (new-file) line', () => {
    // RIGHT line 2 = '+new line 3'
    const result = extractPatchLines(SIMPLE_PATCH, 2, 'RIGHT')
    expect(result).toEqual(['new line 3'])
  })

  it('extracts a range of RIGHT lines (startLine to endLine)', () => {
    // RIGHT lines 2-3 = 'new line 3' and 'new line 4'
    const result = extractPatchLines(SIMPLE_PATCH, 3, 'RIGHT', 2)
    expect(result).toEqual(['new line 3', 'new line 4'])
  })

  it('extracts a single LEFT (old-file) line', () => {
    // LEFT line 2 = 'old line 2'
    const result = extractPatchLines(SIMPLE_PATCH, 2, 'LEFT')
    expect(result).toEqual(['old line 2'])
  })

  it('returns undefined for a RIGHT line that is not in the patch', () => {
    // Line 999 doesn't exist in patch
    const result = extractPatchLines(SIMPLE_PATCH, 999, 'RIGHT')
    expect(result).toBeUndefined()
  })

  it('returns undefined when startLine > endLine (invalid range)', () => {
    // startLine (10) > endLine (3) — invalid
    const result = extractPatchLines(SIMPLE_PATCH, 3, 'RIGHT', 10)
    expect(result).toBeUndefined()
  })

  it('handles multi-hunk patch: extracts line from added lines', () => {
    // In MULTI_HUNK_PATCH, RIGHT line 10 = 'new10a' (first added line)
    const result = extractPatchLines(MULTI_HUNK_PATCH, 10, 'RIGHT')
    expect(result).toEqual(['new10a'])
  })

  it('handles multi-hunk patch: extracts range across added lines', () => {
    // RIGHT lines 10-12 = 'new10a', 'new10b', 'new10c'
    const result = extractPatchLines(MULTI_HUNK_PATCH, 12, 'RIGHT', 10)
    expect(result).toEqual(['new10a', 'new10b', 'new10c'])
  })

  it('context lines (unchanged) are extractable as RIGHT', () => {
    // RIGHT line 1 = 'unchanged' (context line)
    const result = extractPatchLines(SIMPLE_PATCH, 1, 'RIGHT')
    expect(result).toEqual(['unchanged'])
  })

  it('context lines (unchanged) are extractable as LEFT', () => {
    // LEFT line 1 = 'unchanged' (context line)
    const result = extractPatchLines(SIMPLE_PATCH, 1, 'LEFT')
    expect(result).toEqual(['unchanged'])
  })
})
