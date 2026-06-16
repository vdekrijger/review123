import { describe, it, expect } from 'vitest'
import { parseTestStructure, humanizePyTestName } from './testStructure'

// ---------------------------------------------------------------------------
// JS / TS
// ---------------------------------------------------------------------------

const JS_FILE = `import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildKey } from './keys'

vi.mock('./db', () => ({ query: vi.fn() }))

describe('keys', () => {
  const expected = 2
  let store

  beforeEach(() => {
    store = new Map()
  })

  afterEach(() => {
    store.clear()
  })

  it('buildKey works', () => {
    expect(buildKey(1)).toBe(expected)
  })

  it('handles zero', () => {
    expect(buildKey(0)).toBe(0)
  })
})
`

describe('parseTestStructure — JS/TS', () => {
  it('detects the jest/vitest framework and is not a fallback', () => {
    const r = parseTestStructure(JS_FILE, 'src/keys.test.ts')
    expect(r.fallback).toBe(false)
    expect(r.framework).toBe('jest')
  })

  it('lists every test case title under its describe group, untruncated', () => {
    const r = parseTestStructure(JS_FILE, 'src/keys.test.ts')
    const group = r.groups.find((g) => g.title === 'keys')
    expect(group).toBeDefined()
    const titles = group!.tests.map((t) => t.title)
    expect(titles).toEqual(['buildKey works', 'handles zero'])
  })

  it('captures a non-empty body line range for each test', () => {
    const r = parseTestStructure(JS_FILE, 'src/keys.test.ts')
    const tests = r.groups.flatMap((g) => g.tests)
    for (const t of tests) {
      expect(t.lineRange.end).toBeGreaterThanOrEqual(t.lineRange.start)
    }
    // The `buildKey works` body should contain the buildKey call.
    const bk = tests.find((t) => t.title === 'buildKey works')!
    const lines = JS_FILE.split('\n').slice(bk.lineRange.start - 1, bk.lineRange.end)
    expect(lines.join('\n')).toContain('buildKey(1)')
  })

  it('puts beforeEach/afterEach hooks and vi.mock into the setup bucket', () => {
    const r = parseTestStructure(JS_FILE, 'src/keys.test.ts')
    const setupText = r.setup
      .map((range) => JS_FILE.split('\n').slice(range.start - 1, range.end).join('\n'))
      .join('\n')
    expect(setupText).toContain('beforeEach')
    expect(setupText).toContain('afterEach')
    expect(setupText).toContain("vi.mock('./db'")
  })

  it('excludes import lines from every bucket', () => {
    const r = parseTestStructure(JS_FILE, 'src/keys.test.ts')
    const all = [...r.setup, ...r.groups.flatMap((g) => g.tests.map((t) => t.lineRange))]
    const allText = all
      .map((range) => JS_FILE.split('\n').slice(range.start - 1, range.end))
      .flat()
    expect(allText.some((l) => /^\s*import\b/.test(l))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_FILE = `import pytest
from app.dashboard import render

@pytest.fixture
def client():
    return Client()

class TestDashboard:
    def setUp(self):
        self.user = make_user()

    def tearDown(self):
        self.user.delete()

    def test_renders_dashboard_tile(self):
        assert render(self.user) == "ok"

    def test_handles_empty(self):
        assert render(None) == ""
`

describe('humanizePyTestName', () => {
  it('strips the test_ prefix and underscores → words', () => {
    expect(humanizePyTestName('test_renders_dashboard_tile')).toBe('renders dashboard tile')
  })
})

describe('parseTestStructure — Python', () => {
  it('detects pytest/unittest and is not a fallback', () => {
    const r = parseTestStructure(PY_FILE, 'tests/test_dashboard.py')
    expect(r.fallback).toBe(false)
    expect(r.framework).toBe('pytest')
  })

  it('lists humanized test names grouped under the Test class', () => {
    const r = parseTestStructure(PY_FILE, 'tests/test_dashboard.py')
    const group = r.groups.find((g) => g.title === 'TestDashboard')
    expect(group).toBeDefined()
    expect(group!.tests.map((t) => t.title)).toEqual([
      'renders dashboard tile',
      'handles empty',
    ])
  })

  it('puts setUp/tearDown and @pytest.fixture into the setup bucket', () => {
    const r = parseTestStructure(PY_FILE, 'tests/test_dashboard.py')
    const setupText = r.setup
      .map((range) => PY_FILE.split('\n').slice(range.start - 1, range.end).join('\n'))
      .join('\n')
    expect(setupText).toContain('def setUp')
    expect(setupText).toContain('def tearDown')
    expect(setupText).toContain('@pytest.fixture')
  })

  it('flags a conftest note honestly (fixtures may live out of file)', () => {
    const r = parseTestStructure(PY_FILE, 'tests/test_dashboard.py')
    expect(typeof r.conftestNote).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe('parseTestStructure — fallback', () => {
  it('falls back when no recognized test framework is present', () => {
    const r = parseTestStructure('fn main() { let x = 1; }\n', 'src/main.rs')
    expect(r.fallback).toBe(true)
    expect(r.groups.flatMap((g) => g.tests)).toHaveLength(0)
  })

  it('falls back for a JS file with no it/test declarations', () => {
    const r = parseTestStructure("const x = 1\nexport default x\n", 'src/util.ts')
    expect(r.fallback).toBe(true)
  })
})
