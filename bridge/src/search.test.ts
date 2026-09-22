// @vitest-environment node
/**
 * search.test.ts — `/v1/search`, both backends.
 *
 * The walker is tested against a REAL temp tree (that is the only way to prove
 * a symlink is not followed and a .gitignore is honoured). ripgrep is tested
 * two ways: its argv SHAPE and NDJSON parsing as pure functions, and — when
 * `rg` is actually installed — end to end against the same tree, so the two
 * backends are proven to agree on the same contract.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildRipgrepArgs,
  clampMaxResults,
  MAX_INCLUDE_GLOBS,
  MAX_QUERY_CHARS,
  parseRipgrepLine,
  parseSearchRequest,
  previewLine,
  runSearch,
  searchWithWalk,
} from './search.js'
import { globToRegExp, isIgnored, parseGitignore } from './ignore.js'
import { DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS, SEARCH_PREVIEW_MAX_CHARS } from './protocol.js'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-search-')))
  await mkdir(join(root, 'src', 'lib'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'export function target() {}\nconst other = 1\n')
  await writeFile(join(root, 'src', 'lib', 'b.ts'), 'import { target } from "../a"\ntarget()\n')
  await writeFile(join(root, 'README.md'), 'Call target to do the thing.\n')
  await writeFile(join(root, 'dist', 'bundle.js'), 'target();\n')
  await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n')
  await writeFile(join(root, 'debug.log'), 'target in a log\n')
})

/** The walker only. Deterministic, and the backend every machine has. */
function walk(req: Parameters<typeof searchWithWalk>[1], maxResults = 100) {
  return searchWithWalk(root, req, maxResults)
}

describe('parseSearchRequest', () => {
  it('accepts a minimal body', () => {
    expect(parseSearchRequest({ query: 'foo' })).toEqual({ query: 'foo' })
  })

  it('carries every optional field through', () => {
    expect(
      parseSearchRequest({ query: 'f', regex: true, caseSensitive: true, maxResults: 5, include: ['*.ts'] }),
    ).toEqual({ query: 'f', regex: true, caseSensitive: true, maxResults: 5, include: ['*.ts'] })
  })

  it.each([
    ['a non-object body', 'nope'],
    ['no query', {}],
    ['an empty query', { query: '' }],
    ['a non-boolean regex', { query: 'a', regex: 'yes' }],
    ['a non-boolean caseSensitive', { query: 'a', caseSensitive: 1 }],
    ['a non-numeric maxResults', { query: 'a', maxResults: 'lots' }],
    ['a non-array include', { query: 'a', include: '*.ts' }],
    ['non-string globs', { query: 'a', include: [1] }],
  ])('rejects %s', (_label, body) => {
    expect(parseSearchRequest(body)).toHaveProperty('error')
  })

  it('rejects an over-long query', () => {
    expect(parseSearchRequest({ query: 'x'.repeat(MAX_QUERY_CHARS + 1) })).toHaveProperty('error')
  })

  it('rejects too many include globs', () => {
    const include = Array.from({ length: MAX_INCLUDE_GLOBS + 1 }, () => '*.ts')
    expect(parseSearchRequest({ query: 'a', include })).toHaveProperty('error')
  })

  it('rejects a malformed REGEX up front, so the caller gets a 400 not a mystery', () => {
    const parsed = parseSearchRequest({ query: '([', regex: true })
    expect(parsed).toHaveProperty('error')
    expect((parsed as { error: string }).error).toMatch(/regular expression/i)
  })

  it('accepts the same string as a LITERAL query', () => {
    expect(parseSearchRequest({ query: '([' })).toEqual({ query: '([' })
  })
})

describe('clampMaxResults', () => {
  it.each([
    [undefined, DEFAULT_SEARCH_RESULTS],
    [0, DEFAULT_SEARCH_RESULTS],
    [-1, DEFAULT_SEARCH_RESULTS],
    [MAX_SEARCH_RESULTS * 10, MAX_SEARCH_RESULTS],
    [7, 7],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampMaxResults(input as number | undefined)).toBe(expected)
  })
})

describe('previewLine', () => {
  it('trims a long line and marks the cut', () => {
    const out = previewLine('y'.repeat(SEARCH_PREVIEW_MAX_CHARS + 50))
    expect(out.length).toBe(SEARCH_PREVIEW_MAX_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('leaves a short line alone but normalises tabs', () => {
    expect(previewLine('a\tb')).toBe('a  b')
  })
})

// ---------------------------------------------------------------------------
// The JS walker
// ---------------------------------------------------------------------------

describe('searchWithWalk', () => {
  it('finds literal matches with 1-based line and column', async () => {
    const result = await walk({ query: 'target' })
    const hit = result.matches.find((m) => m.path === 'src/a.ts')
    expect(hit).toEqual({
      path: 'src/a.ts',
      line: 1,
      column: 17,
      preview: 'export function target() {}',
    })
  })

  it('returns repo-RELATIVE paths with forward slashes and no leading ./', async () => {
    const result = await walk({ query: 'target' })
    for (const m of result.matches) {
      expect(m.path.startsWith('/')).toBe(false)
      expect(m.path.startsWith('./')).toBe(false)
    }
    expect(result.matches.map((m) => m.path)).toContain('src/lib/b.ts')
  })

  it('treats the query as a LITERAL by default — a dot is a dot', async () => {
    await writeFile(join(root, 'dots.txt'), 'a.c\nabc\n')
    const result = await walk({ query: 'a.c', include: ['dots.txt'] })
    expect(result.matches.map((m) => m.line)).toEqual([1])
  })

  it('treats the query as a REGEX when asked', async () => {
    await writeFile(join(root, 'dots.txt'), 'a.c\nabc\n')
    const result = await walk({ query: 'a.c', regex: true, include: ['dots.txt'] })
    expect(result.matches.map((m) => m.line)).toEqual([1, 2])
  })

  it('is case-insensitive by default and case-sensitive on request', async () => {
    await writeFile(join(root, 'case.txt'), 'Target\n')
    expect((await walk({ query: 'target', include: ['case.txt'] })).matches).toHaveLength(1)
    expect(
      (await walk({ query: 'target', caseSensitive: true, include: ['case.txt'] })).matches,
    ).toHaveLength(0)
  })

  it('honours .gitignore — a dist/ match is not reported', async () => {
    const result = await walk({ query: 'target' })
    expect(result.matches.map((m) => m.path)).not.toContain('dist/bundle.js')
  })

  it('honours a *.log rule at any depth', async () => {
    const result = await walk({ query: 'target' })
    expect(result.matches.map((m) => m.path)).not.toContain('debug.log')
  })

  it('honours a NESTED .gitignore', async () => {
    await writeFile(join(root, 'src', '.gitignore'), 'lib/\n')
    const result = await walk({ query: 'target' })
    expect(result.matches.map((m) => m.path)).not.toContain('src/lib/b.ts')
    expect(result.matches.map((m) => m.path)).toContain('src/a.ts')
  })

  it('honours a NEGATION that re-includes an ignored file', async () => {
    await writeFile(join(root, '.gitignore'), '*.log\n!keep.log\n')
    await writeFile(join(root, 'keep.log'), 'target here\n')
    const result = await walk({ query: 'target' })
    const paths = result.matches.map((m) => m.path)
    expect(paths).toContain('keep.log')
    expect(paths).not.toContain('debug.log')
  })

  it('never walks into .git', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'COMMIT_EDITMSG'), 'target\n')
    const result = await walk({ query: 'target' })
    expect(result.matches.map((m) => m.path)).not.toContain('.git/COMMIT_EDITMSG')
  })

  it('NEVER follows a symlink out of the repo', async () => {
    const outside = dirname(root)
    await writeFile(join(outside, 'outside-search.txt'), 'target outside\n')
    await symlink(join(outside, 'outside-search.txt'), join(root, 'linked.txt'))
    await symlink(outside, join(root, 'up'))
    const result = await walk({ query: 'target' })
    const paths = result.matches.map((m) => m.path)
    expect(paths).not.toContain('linked.txt')
    expect(paths.some((p) => p.startsWith('up/'))).toBe(false)
  })

  it('does not follow a symlink even when it stays INSIDE the repo', async () => {
    // The rule is "never follow", not "never escape": following an internal
    // link would report the same file twice under two paths.
    await symlink(join(root, 'src', 'a.ts'), join(root, 'alias.ts'))
    const result = await walk({ query: 'target' })
    expect(result.matches.map((m) => m.path)).not.toContain('alias.ts')
  })

  it('narrows to the include globs', async () => {
    const result = await walk({ query: 'target', include: ['src/**/*.ts'] })
    expect([...new Set(result.matches.map((m) => m.path))].sort()).toEqual(['src/a.ts', 'src/lib/b.ts'])
  })

  it('reports EVERY matching line in a file, not just the first', async () => {
    // b.ts names `target` on both of its lines.
    const result = await walk({ query: 'target', include: ['src/lib/b.ts'] })
    expect(result.matches.map((m) => m.line)).toEqual([1, 2])
  })

  it('an empty include list means everything, not nothing', async () => {
    const result = await walk({ query: 'target', include: [] })
    expect(result.matches.length).toBeGreaterThan(1)
  })

  it('skips a BINARY file instead of reporting a match inside it', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x00]))
    const result = await walk({ query: 'target' })
    expect(result.matches.map((m) => m.path)).not.toContain('blob.bin')
  })

  it('cuts at maxResults and says truncated', async () => {
    const result = await walk({ query: 'target' }, 1)
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('does NOT claim truncation when everything fit', async () => {
    const result = await walk({ query: 'nothing-matches-this-string' })
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('reports truncated when the wall clock expires mid-walk', async () => {
    let clock = 0
    const result = await searchWithWalk(
      root,
      { query: 'target' },
      100,
      // Every read of the clock advances it past the budget.
      { timeoutMs: 1, now: () => (clock += 1000) },
    )
    expect(result.truncated).toBe(true)
  })

  it('reports at most one match per line, so a repeated identifier is not spam', async () => {
    await writeFile(join(root, 'many.txt'), 'target target target\n')
    const result = await walk({ query: 'target', include: ['many.txt'] })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.column).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ripgrep — the argv shape and the NDJSON parser, without spawning
// ---------------------------------------------------------------------------

describe('buildRipgrepArgs', () => {
  it('carries the query behind -e so a leading dash is a PATTERN, not a flag', () => {
    const args = buildRipgrepArgs({ query: '--version' })
    expect(args[args.indexOf('-e') + 1]).toBe('--version')
  })

  it('ends option parsing with -- before the search path', () => {
    const args = buildRipgrepArgs({ query: 'x' })
    expect(args.slice(-2)).toEqual(['--', '.'])
  })

  it('never follows symlinks', () => {
    expect(buildRipgrepArgs({ query: 'x' })).toContain('--no-follow')
  })

  it('applies .gitignore even outside a repo, so both backends answer alike', () => {
    expect(buildRipgrepArgs({ query: 'x' })).toContain('--no-require-git')
  })

  it('is literal by default and regex only on request', () => {
    expect(buildRipgrepArgs({ query: 'x' })).toContain('--fixed-strings')
    expect(buildRipgrepArgs({ query: 'x', regex: true })).not.toContain('--fixed-strings')
  })

  it('maps caseSensitive onto rg\u2019s own flags', () => {
    expect(buildRipgrepArgs({ query: 'x' })).toContain('--ignore-case')
    expect(buildRipgrepArgs({ query: 'x', caseSensitive: true })).toContain('--case-sensitive')
  })

  it('passes each include through as its own --glob', () => {
    const args = buildRipgrepArgs({ query: 'x', include: ['src/**/*.ts', '*.md'] })
    expect(args.filter((a, i) => args[i - 1] === '--glob')).toEqual(['src/**/*.ts', '*.md'])
  })

  it('is a flat array of strings — nothing a shell could reinterpret', () => {
    for (const arg of buildRipgrepArgs({ query: '; rm -rf /', include: ['$(whoami)'] })) {
      expect(typeof arg).toBe('string')
    }
  })
})

describe('parseRipgrepLine', () => {
  const line = (data: unknown) => JSON.stringify({ type: 'match', data })

  it('converts a match into the contract shape', () => {
    expect(
      parseRipgrepLine(
        line({
          path: { text: './src/a.ts' },
          lines: { text: 'export function target() {}\n' },
          line_number: 1,
          submatches: [{ start: 16 }],
        }),
      ),
    ).toEqual({ path: 'src/a.ts', line: 1, column: 17, preview: 'export function target() {}' })
  })

  it('converts a BYTE offset into a 1-based CHARACTER column', () => {
    // 'é' is two bytes, so byte offset 3 is character index 2.
    const match = parseRipgrepLine(
      line({
        path: { text: 'x.ts' },
        lines: { text: 'aéb\n' },
        line_number: 4,
        submatches: [{ start: 3 }],
      }),
    )
    expect(match?.column).toBe(3)
  })

  it('returns null for every non-match event', () => {
    expect(parseRipgrepLine(JSON.stringify({ type: 'begin', data: {} }))).toBeNull()
    expect(parseRipgrepLine(JSON.stringify({ type: 'summary', data: {} }))).toBeNull()
  })

  it('returns null for a line that is not JSON at all', () => {
    expect(parseRipgrepLine('not json')).toBeNull()
  })

  it('drops a match rg reported as BYTES — there is no honest preview for it', () => {
    expect(
      parseRipgrepLine(line({ path: { text: 'x' }, lines: { bytes: 'abc' }, line_number: 1 })),
    ).toBeNull()
  })

  it('defaults the column to 1 when rg reports no submatch offset', () => {
    const match = parseRipgrepLine(
      line({ path: { text: 'x' }, lines: { text: 'hi\n' }, line_number: 2 }),
    )
    expect(match).toEqual({ path: 'x', line: 2, column: 1, preview: 'hi' })
  })
})

// ---------------------------------------------------------------------------
// The backend selection, and ripgrep end-to-end when the machine has it
// ---------------------------------------------------------------------------

function hasRg(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('runSearch — backend selection', () => {
  it('uses the WALKER when ripgrep is absent, and still answers', async () => {
    const result = await runSearch(root, { query: 'target' }, { hasRipgrep: async () => false })
    expect(result.matches.map((m) => m.path)).toContain('src/a.ts')
  })

  it('falls back to the walker when ripgrep is present but cannot answer', async () => {
    // A spawn stub whose child immediately errors, exactly as an unusable
    // binary does. The search must still come back with real results.
    const spawn = (() => {
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      const child = {
        stdout: { setEncoding() {}, on() {} },
        kill() {},
        on(event: string, fn: (...args: unknown[]) => void) {
          ;(handlers[event] ??= []).push(fn)
          if (event === 'error') setTimeout(() => fn(new Error('boom')), 0)
          return child
        },
      }
      return () => child
    })() as unknown as Parameters<typeof runSearch>[2] extends { spawn?: infer S } ? S : never

    const result = await runSearch(
      root,
      { query: 'target' },
      { hasRipgrep: async () => true, spawn: spawn as never },
    )
    expect(result.matches.map((m) => m.path)).toContain('src/a.ts')
  })

  it('clamps maxResults through the public entry point', async () => {
    const result = await runSearch(
      root,
      { query: 'target', maxResults: 1 },
      { hasRipgrep: async () => false },
    )
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })
})

describe.runIf(hasRg())('ripgrep end to end — the two backends agree', () => {
  it('finds the same files the walker does, honouring .gitignore', async () => {
    const viaRg = await runSearch(root, { query: 'target' }, { hasRipgrep: async () => true })
    const viaWalk = await runSearch(root, { query: 'target' }, { hasRipgrep: async () => false })
    expect(new Set(viaRg.matches.map((m) => m.path))).toEqual(
      new Set(viaWalk.matches.map((m) => m.path)),
    )
    expect(viaRg.matches.map((m) => m.path)).not.toContain('dist/bundle.js')
  })

  it('reports the same line and column as the walker for a known hit', async () => {
    const viaRg = await runSearch(root, { query: 'target' }, { hasRipgrep: async () => true })
    const hit = viaRg.matches.find((m) => m.path === 'src/a.ts')
    expect(hit).toEqual({ path: 'src/a.ts', line: 1, column: 17, preview: 'export function target() {}' })
  })

  it('honours maxResults and reports truncation', async () => {
    const result = await runSearch(
      root,
      { query: 'target', maxResults: 1 },
      { hasRipgrep: async () => true },
    )
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('does NOT follow a symlink out of the repo', async () => {
    const outside = dirname(root)
    await writeFile(join(outside, 'outside-rg.txt'), 'target outside\n')
    await symlink(join(outside, 'outside-rg.txt'), join(root, 'linked.txt'))
    const result = await runSearch(root, { query: 'target' }, { hasRipgrep: async () => true })
    expect(result.matches.map((m) => m.path)).not.toContain('linked.txt')
  })

  it('answers empty (not an error) when nothing matches', async () => {
    const result = await runSearch(
      root,
      { query: 'zzz-nothing-matches-zzz' },
      { hasRipgrep: async () => true },
    )
    expect(result).toEqual({ ok: true, matches: [], truncated: false })
  })

  it('treats a leading-dash query as a pattern rather than a flag', async () => {
    await writeFile(join(root, 'dash.txt'), '--version here\n')
    const result = await runSearch(
      root,
      { query: '--version', include: ['dash.txt'] },
      { hasRipgrep: async () => true },
    )
    expect(result.matches.map((m) => m.path)).toEqual(['dash.txt'])
  })
})

// ---------------------------------------------------------------------------
// ignore.ts — the gitignore subset, in isolation
// ---------------------------------------------------------------------------

describe('globToRegExp', () => {
  it.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'deep/nested/a.ts', true],
    ['*.ts', 'a.js', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/lib/a.ts', false],
    ['src/**/*.ts', 'src/lib/a.ts', true],
    ['src/**/*.ts', 'src/a.ts', true],
    ['/root-only', 'root-only', true],
    ['/root-only', 'deep/root-only', false],
    ['a?c', 'abc', true],
    ['a?c', 'abbc', false],
    ['[ab].ts', 'a.ts', true],
    ['[ab].ts', 'c.ts', false],
  ])('%s vs %s -> %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected)
  })

  it('matches everything beneath a directory pattern', () => {
    expect(globToRegExp('dist').test('dist/bundle.js')).toBe(true)
  })
})

describe('parseGitignore', () => {
  it('skips comments and blank lines', () => {
    expect(parseGitignore('# a comment\n\n   \n')).toEqual([])
  })

  it('marks a trailing slash as directory-only', () => {
    expect(parseGitignore('build/\n')[0]?.dirOnly).toBe(true)
    expect(parseGitignore('build\n')[0]?.dirOnly).toBe(false)
  })

  it('marks a leading ! as negated', () => {
    expect(parseGitignore('!keep\n')[0]?.negated).toBe(true)
  })

  it('un-escapes a literal leading # or !', () => {
    const rules = parseGitignore('\\#hash\n')
    expect(rules).toHaveLength(1)
    expect(rules[0]?.negated).toBe(false)
  })
})

describe('isIgnored', () => {
  const scopes = [{ baseRel: '', rules: parseGitignore('dist/\n*.log\n!keep.log\n') }]

  it('applies last-match-wins so a negation re-includes', () => {
    expect(isIgnored('debug.log', false, scopes)).toBe(true)
    expect(isIgnored('keep.log', false, scopes)).toBe(false)
  })

  it('applies a directory-only rule to directories only', () => {
    expect(isIgnored('dist', true, scopes)).toBe(true)
    expect(isIgnored('dist', false, scopes)).toBe(false)
  })

  it('applies a NESTED scope only beneath its own directory', () => {
    const nested = [
      { baseRel: '', rules: parseGitignore('') },
      { baseRel: 'src', rules: parseGitignore('generated/\n') },
    ]
    expect(isIgnored('src/generated', true, nested)).toBe(true)
    expect(isIgnored('other/generated', true, nested)).toBe(false)
  })
})
