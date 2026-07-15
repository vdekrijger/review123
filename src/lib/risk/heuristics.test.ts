import { describe, it, expect } from 'vitest'
import type { PrFile } from '../github/types'
import {
  detectHeuristics,
  isSensitivePath,
  addedLines,
  removedLines,
  UNTESTED_BULK_THRESHOLD,
} from './heuristics'

function file(overrides: Partial<PrFile> & { filename: string }): PrFile {
  return { status: 'modified', additions: 0, deletions: 0, ...overrides }
}

/** Build a minimal unified-diff patch from raw +/-/context lines. */
function patch(lines: string[]): string {
  return ['@@ -1,1 +1,1 @@', ...lines].join('\n')
}

function flagsOf(files: PrFile[], id: string) {
  return detectHeuristics(files).filter((f) => f.id === id)
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

describe('addedLines / removedLines', () => {
  it('extracts added and removed lines, ignoring headers and context', () => {
    const p = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n+added\n-removed'
    expect(addedLines(p)).toEqual(['added'])
    expect(removedLines(p)).toEqual(['removed'])
  })

  it('returns empty arrays for an absent patch (binary / large file)', () => {
    expect(addedLines(undefined)).toEqual([])
    expect(removedLines(undefined)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (a) New dependency
// ---------------------------------------------------------------------------

describe('new-dependency heuristic', () => {
  it('flags a newly added package.json dependency', () => {
    const f = file({
      filename: 'package.json',
      patch: patch(['+    "leftpad": "^1.3.0",']),
    })
    const flags = flagsOf([f], 'new-dependency')
    expect(flags).toHaveLength(1)
    expect(flags[0].label).toContain('leftpad')
    expect(flags[0].evidence).toMatch(/real, intended/i)
  })

  it('does NOT flag a version-only bump (same dep on a removed line)', () => {
    const f = file({
      filename: 'package.json',
      patch: patch(['-    "svelte": "^5.0.0",', '+    "svelte": "^5.1.0",']),
    })
    expect(flagsOf([f], 'new-dependency')).toHaveLength(0)
  })

  it('does NOT flag package.json script or metadata lines', () => {
    const f = file({
      filename: 'package.json',
      patch: patch(['+    "build": "vite build",', '+  "version": "2.0.0",', '+  "name": "my-app",']),
    })
    expect(flagsOf([f], 'new-dependency')).toHaveLength(0)
  })

  it('flags a scoped npm package', () => {
    const f = file({
      filename: 'apps/web/package.json',
      patch: patch(['+    "@evil/almost-real": "1.0.0",']),
    })
    const flags = flagsOf([f], 'new-dependency')
    expect(flags).toHaveLength(1)
    expect(flags[0].label).toContain('@evil/almost-real')
  })

  it('flags a new requirements.txt package but not a version bump or comment', () => {
    const f = file({
      filename: 'requirements.txt',
      patch: patch(['+requezts==2.31.0', '-numpy==1.24.0', '+numpy==1.26.0', '+# a comment', '+-r base.txt']),
    })
    const flags = flagsOf([f], 'new-dependency')
    expect(flags).toHaveLength(1)
    expect(flags[0].label).toContain('requezts')
  })

  it('flags a new go.mod require', () => {
    const f = file({
      filename: 'go.mod',
      patch: patch(['+require github.com/fake/pkg v1.2.3']),
    })
    const flags = flagsOf([f], 'new-dependency')
    expect(flags).toHaveLength(1)
    expect(flags[0].label).toContain('github.com/fake/pkg')
  })

  it('flags a new Cargo.toml dep but not a version-only change', () => {
    const f = file({
      filename: 'Cargo.toml',
      patch: patch(['+serde_klone = "1.0"', '-tokio = "1.35"', '+tokio = "1.36"']),
    })
    const flags = flagsOf([f], 'new-dependency')
    expect(flags).toHaveLength(1)
    expect(flags[0].label).toContain('serde_klone')
  })

  it('flags a new Gemfile gem', () => {
    const f = file({ filename: 'Gemfile', patch: patch(["+gem 'rails-html-sanitizer'"]) })
    expect(flagsOf([f], 'new-dependency')).toHaveLength(1)
  })

  it('flags a new pom.xml artifactId', () => {
    const f = file({
      filename: 'pom.xml',
      patch: patch(['+    <artifactId>log4j-core</artifactId>']),
    })
    expect(flagsOf([f], 'new-dependency')).toHaveLength(1)
  })

  it('flags a new build.gradle implementation but not a version bump', () => {
    const f = file({
      filename: 'build.gradle',
      patch: patch([
        "+implementation 'com.fake:lib:1.0'",
        "-implementation 'com.squareup.okhttp3:okhttp:4.11.0'",
        "+implementation 'com.squareup.okhttp3:okhttp:4.12.0'",
      ]),
    })
    const flags = flagsOf([f], 'new-dependency')
    expect(flags).toHaveLength(1)
    expect(flags[0].label).toContain('com.fake:lib')
  })

  it('ignores non-manifest files entirely', () => {
    const f = file({ filename: 'src/deps.ts', patch: patch(['+    "leftpad": "^1.3.0",']) })
    expect(flagsOf([f], 'new-dependency')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (b) Error masking
// ---------------------------------------------------------------------------

describe('error-masking heuristic', () => {
  it('flags a one-line empty catch', () => {
    const f = file({ filename: 'src/a.ts', patch: patch(['+  try { run() } catch (e) {}']) })
    expect(flagsOf([f], 'error-masking')).toHaveLength(1)
  })

  it('flags a multi-line empty catch (open + immediate close, both added)', () => {
    const f = file({ filename: 'src/a.ts', patch: patch(['+  } catch (e) {', '+  }']) })
    expect(flagsOf([f], 'error-masking')).toHaveLength(1)
  })

  it('flags an empty promise .catch(() => {})', () => {
    const f = file({ filename: 'src/a.ts', patch: patch(['+  fetchIt().catch(() => {})']) })
    expect(flagsOf([f], 'error-masking')).toHaveLength(1)
  })

  it('flags python except: pass (one line and two lines)', () => {
    const one = file({ filename: 'a.py', patch: patch(['+    except: pass']) })
    const two = file({ filename: 'b.py', patch: patch(['+    except Exception:', '+        pass']) })
    expect(flagsOf([one], 'error-masking')).toHaveLength(1)
    expect(flagsOf([two], 'error-masking')).toHaveLength(1)
  })

  it('does NOT flag a catch that logs', () => {
    const f = file({
      filename: 'src/a.ts',
      patch: patch(['+  } catch (e) {', '+    console.error(e)', '+  }']),
    })
    expect(flagsOf([f], 'error-masking')).toHaveLength(0)
  })

  it('does NOT flag a catch that rethrows', () => {
    const f = file({
      filename: 'src/a.ts',
      patch: patch(['+  } catch (e) {', '+    throw new WrappedError(e)', '+  }']),
    })
    expect(flagsOf([f], 'error-masking')).toHaveLength(0)
  })

  it('does NOT flag an except block with real handling', () => {
    const f = file({
      filename: 'a.py',
      patch: patch(['+    except ValueError:', '+        logger.warning("bad value")']),
    })
    expect(flagsOf([f], 'error-masking')).toHaveLength(0)
  })

  it('does NOT flag catch patterns on unchanged (context) lines', () => {
    const f = file({
      filename: 'src/a.ts',
      patch: '@@ -1,3 +1,3 @@\n } catch (e) {}\n+  const x = 1',
    })
    expect(flagsOf([f], 'error-masking')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (c) Within-diff duplication
// ---------------------------------------------------------------------------

const BLOCK = [
  '+const total = items.reduce((s, i) => s + i.price, 0)',
  '+const tax = total * TAX_RATE',
  '+const shipping = total > 50 ? 0 : 5.99',
  '+const grand = total + tax + shipping',
  '+return formatCurrency(grand)',
]

describe('duplication heuristic', () => {
  it('flags the same ≥5-line added block in two files', () => {
    const a = file({ filename: 'src/checkout.ts', patch: patch(BLOCK) })
    const b = file({ filename: 'src/invoice.ts', patch: patch(BLOCK) })
    const flags = flagsOf([a, b], 'duplication')
    expect(flags).toHaveLength(1)
    expect(flags[0].evidence).toContain('src/checkout.ts')
    expect(flags[0].evidence).toContain('src/invoice.ts')
  })

  it('flags the same block appearing twice in ONE file (non-overlapping)', () => {
    const f = file({
      filename: 'src/big.ts',
      patch: patch([...BLOCK, '+const unrelatedSeparator = separate(now)', ...BLOCK]),
    })
    expect(flagsOf([f], 'duplication')).toHaveLength(1)
  })

  it('does NOT flag a block that appears only once', () => {
    const f = file({ filename: 'src/one.ts', patch: patch(BLOCK) })
    expect(flagsOf([f], 'duplication')).toHaveLength(0)
  })

  it('does NOT flag duplicated import/blank/brace lines (trivial lines excluded)', () => {
    const trivia = [
      '+import { a } from "./a"',
      '+import { b } from "./b"',
      '+import { c } from "./c"',
      '+import { d } from "./d"',
      '+import { e } from "./e"',
      '+',
      '+}',
    ]
    const a = file({ filename: 'src/x.ts', patch: patch(trivia) })
    const b = file({ filename: 'src/y.ts', patch: patch(trivia) })
    expect(flagsOf([a, b], 'duplication')).toHaveLength(0)
  })

  it('does NOT flag two 4-line similar blocks (below window)', () => {
    const short = BLOCK.slice(0, 4)
    const a = file({ filename: 'src/x.ts', patch: patch(short) })
    const b = file({ filename: 'src/y.ts', patch: patch(short) })
    expect(flagsOf([a, b], 'duplication')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (d) Untested bulk
// ---------------------------------------------------------------------------

describe('untested-bulk heuristic', () => {
  it('flags a large addition with zero test-file changes', () => {
    const f = file({ filename: 'src/engine.ts', additions: UNTESTED_BULK_THRESHOLD, deletions: 0 })
    const flags = flagsOf([f], 'untested-bulk')
    expect(flags).toHaveLength(1)
    expect(flags[0].file).toBe('src/engine.ts')
  })

  it('does NOT flag when a test file is part of the PR', () => {
    const impl = file({ filename: 'src/engine.ts', additions: 500, deletions: 0 })
    const test = file({ filename: 'src/engine.test.ts', additions: 40, deletions: 0 })
    expect(flagsOf([impl, test], 'untested-bulk')).toHaveLength(0)
  })

  it('does NOT flag a small addition without tests', () => {
    const f = file({ filename: 'src/tweak.ts', additions: 30, deletions: 10 })
    expect(flagsOf([f], 'untested-bulk')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (e) Security-sensitive paths
// ---------------------------------------------------------------------------

describe('sensitive-path heuristic', () => {
  it.each([
    'src/lib/auth/session.ts',
    'src/token-store.ts',
    'services/payment_gateway.py',
    'lib/crypto/hash.go',
    'config/secrets.yml',
    'src/permissions/roles.ts',
    '.github/workflows/deploy.yml',
  ])('flags %s', (p) => {
    expect(isSensitivePath(p)).toBe(true)
    expect(flagsOf([file({ filename: p })], 'sensitive-path')).toHaveLength(1)
  })

  it.each([
    'src/author.ts', // "author" must not match "auth"
    'src/components/Button.svelte',
    'docs/tokenizer-notes.md', // "tokenizer" is not "token"
    'src/lib/authorize-helpers/README.md', // token "authorize" not in set
  ])('does NOT flag %s', (p) => {
    expect(isSensitivePath(p)).toBe(false)
  })

  it('workflow flag carries a CI-specific evidence line', () => {
    const flags = flagsOf([file({ filename: '.github/workflows/ci.yml' })], 'sensitive-path')
    expect(flags[0].evidence).toMatch(/workflow/i)
  })
})

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('detectHeuristics composition', () => {
  it('returns an empty list for a benign PR', () => {
    const f = file({
      filename: 'src/components/Button.svelte',
      additions: 12,
      deletions: 4,
      patch: patch(['+  const label = props.label ?? "OK"']),
    })
    const test = file({ filename: 'src/components/Button.test.ts', additions: 8, deletions: 0 })
    expect(detectHeuristics([f, test])).toHaveLength(0)
  })

  it('collects flags across multiple heuristics at once', () => {
    const pkg = file({ filename: 'package.json', patch: patch(['+    "leftpad": "^1.3.0",']) })
    const auth = file({ filename: 'src/auth/login.ts', additions: 200, deletions: 0, patch: patch(['+  doLogin().catch(() => {})']) })
    const ids = detectHeuristics([pkg, auth]).map((f) => f.id)
    expect(ids).toContain('new-dependency')
    expect(ids).toContain('error-masking')
    expect(ids).toContain('untested-bulk')
    expect(ids).toContain('sensitive-path')
  })
})
