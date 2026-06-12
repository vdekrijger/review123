/**
 * Returns true if the given file path looks like a test file.
 *
 * Detection patterns:
 *  - Filename contains .test. or .spec.  (e.g. foo.test.ts, bar.spec.js)
 *  - Filename contains _test.            (e.g. foo_test.go)
 *  - Filename starts with test_          (e.g. test_utils.py)
 *  - Path segment is __tests__           (e.g. src/__tests__/foo.ts)
 *  - Path contains /tests/ or /test/     (e.g. src/tests/foo.ts, src/test/foo.ts)
 */
export function isTestFile(path: string): boolean {
  if (!path) return false
  const parts = path.split('/')
  const filename = parts[parts.length - 1]

  // Filename-level patterns
  if (/\.(test|spec)\./.test(filename)) return true
  if (/_test\./.test(filename)) return true
  if (/^test_/.test(filename)) return true

  // Directory-level patterns
  if (parts.some(p => p === '__tests__')) return true
  if (parts.some(p => p === 'tests' || p === 'test')) return true

  return false
}
