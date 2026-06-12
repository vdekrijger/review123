import { describe, it, expect } from 'vitest'
import { isTestFile } from './testFile'

describe('isTestFile', () => {
  it('detects .test.ts files', () => {
    expect(isTestFile('src/lib/foo.test.ts')).toBe(true)
  })
  it('detects .spec.ts files', () => {
    expect(isTestFile('src/components/Bar.spec.tsx')).toBe(true)
  })
  it('detects _test. pattern', () => {
    expect(isTestFile('src/lib/foo_test.go')).toBe(true)
  })
  it('detects test_ prefix pattern', () => {
    expect(isTestFile('test_foo.py')).toBe(true)
  })
  it('detects __tests__ directory', () => {
    expect(isTestFile('src/__tests__/foo.ts')).toBe(true)
  })
  it('detects /tests/ directory', () => {
    expect(isTestFile('src/tests/integration.ts')).toBe(true)
  })
  it('detects /test/ directory', () => {
    expect(isTestFile('src/test/unit.ts')).toBe(true)
  })
  it('does not flag normal source files', () => {
    expect(isTestFile('src/lib/settings.ts')).toBe(false)
  })
  it('does not flag files with "test" only in directory name prefix (e.g. testimony)', () => {
    expect(isTestFile('src/testimony/foo.ts')).toBe(false)
  })
  it('handles empty string without throwing', () => {
    expect(isTestFile('')).toBe(false)
  })
  it('detects .test.js files', () => {
    expect(isTestFile('utils/helper.test.js')).toBe(true)
  })
  it('detects .spec.js files', () => {
    expect(isTestFile('utils/helper.spec.js')).toBe(true)
  })
})
