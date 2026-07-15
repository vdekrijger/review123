/**
 * src/lib/risk/heuristics.ts — deterministic, diff-computable "AI-pattern"
 * heuristics for the review-effort score.
 *
 * Each heuristic inspects ONLY the unified-diff patches already loaded for the
 * PR (PrFile.patch) — no network, no registry lookups, no LLM. All flags are
 * ADVISORY "worth a closer look" signals, never "this is a defect".
 *
 * Matching is deliberately conservative — precision over recall. A near-miss
 * (a catch that rethrows, a dependency line that only bumped a version) must
 * NOT fire. False positives here erode trust in the whole breakdown.
 *
 * The module is pure and framework-free so a later LLM risk-judge factor can
 * sit beside it without touching this file.
 */

import type { PrFile } from '../github/types'
import { isTestFile } from '../testFile'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeuristicId =
  | 'new-dependency'
  | 'error-masking'
  | 'duplication'
  | 'untested-bulk'
  | 'sensitive-path'

export interface HeuristicFlag {
  id: HeuristicId
  /** Short human label ("new dependency: leftpad"). */
  label: string
  /** File the evidence lives in (first file for cross-file duplication). */
  file: string
  /** One-line evidence / why-it-matters detail. */
  evidence: string
}

/** Added LOC (across non-test files) at/above which "untested bulk" fires. */
export const UNTESTED_BULK_THRESHOLD = 150

/** Window size (consecutive substantive added lines) for duplication. */
export const DUPLICATION_WINDOW = 5

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

/** Added lines of a unified diff patch, WITHOUT the leading '+'. */
export function addedLines(patch: string | undefined): string[] {
  if (!patch) return []
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
}

/** Removed lines of a unified diff patch, WITHOUT the leading '-'. */
export function removedLines(patch: string | undefined): string[] {
  if (!patch) return []
  return patch
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1))
}

// ---------------------------------------------------------------------------
// (a) New dependency — slopsquatting guard
// ---------------------------------------------------------------------------

type DepExtractor = (line: string) => string | null

/**
 * package.json keys that look like `"name": "value"` but are NOT dependencies.
 * Conservative denylist — a dep-section context parse is overkill for a patch.
 */
const PKG_JSON_NON_DEP_KEYS = new Set([
  'name', 'version', 'description', 'main', 'module', 'types', 'type',
  'license', 'author', 'homepage', 'repository', 'packageManager', 'exports',
])

/** `"pkg": "^1.2.3"` — value must look like a version/range, not a script. */
function npmDep(line: string): string | null {
  const m = line.match(/^\s*"(@?[\w./-]+)"\s*:\s*"([^"]*)"\s*,?\s*$/)
  if (!m) return null
  const [, key, value] = m
  if (PKG_JSON_NON_DEP_KEYS.has(key)) return null
  // Version-ish values only: 1.2.3, ^1.2, ~0.1, >=2, *, latest, workspace:*, npm:…
  if (!/^([~^><=]*\d|\*$|latest$|workspace:|npm:|file:|link:|git\+|github:)/.test(value)) return null
  return key
}

/** requirements.txt: `pkg`, `pkg==1.2`, `pkg>=1,<2`; skips options/comments. */
function pipDep(line: string): string | null {
  const t = line.trim()
  if (t === '' || t.startsWith('#') || t.startsWith('-')) return null
  const m = t.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([=<>!~;].*)?$/)
  return m ? m[1] : null
}

/** go.mod: `require example.com/mod v1.2.3` or bare `example.com/mod v1.2.3`. */
function goDep(line: string): string | null {
  const m = line.trim().match(/^(?:require\s+)?([\w.-]+\.[\w-]+(?:\/[\w./-]+)+)\s+v\d/)
  return m ? m[1] : null
}

/** Cargo.toml / pyproject.toml: `name = "1.2"` or `name = { version = … }`. */
function tomlDep(line: string): string | null {
  const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"[~^><=]*\d[^"]*"|\{.*version.*\})\s*,?$/)
  return m ? m[1] : null
}

/** Gemfile: `gem 'name'` / `gem "name", "~> 1.2"`. */
function gemDep(line: string): string | null {
  const m = line.trim().match(/^gem\s+['"]([\w-]+)['"]/)
  return m ? m[1] : null
}

/** pom.xml: `<artifactId>name</artifactId>`. */
function mavenDep(line: string): string | null {
  const m = line.trim().match(/^<artifactId>([\w.-]+)<\/artifactId>$/)
  return m ? m[1] : null
}

/** build.gradle: `implementation 'group:name:1.2'` (and friends). */
function gradleDep(line: string): string | null {
  const m = line
    .trim()
    .match(/^(?:implementation|api|compileOnly|runtimeOnly|testImplementation|classpath)\s*\(?\s*['"]([\w.-]+:[\w.-]+)(?::[^'"]*)?['"]/)
  return m ? m[1] : null
}

const MANIFEST_EXTRACTORS: Record<string, DepExtractor> = {
  'package.json': npmDep,
  'requirements.txt': pipDep,
  'pyproject.toml': tomlDep,
  'go.mod': goDep,
  'cargo.toml': tomlDep,
  'gemfile': gemDep,
  'pom.xml': mavenDep,
  'build.gradle': gradleDep,
  'build.gradle.kts': gradleDep,
}

function detectNewDependencies(files: PrFile[]): HeuristicFlag[] {
  const flags: HeuristicFlag[] = []
  for (const f of files) {
    const base = (f.filename.split('/').pop() ?? '').toLowerCase()
    const extract = MANIFEST_EXTRACTORS[base]
    if (!extract || !f.patch) continue

    const added = new Set(addedLines(f.patch).map(extract).filter((d): d is string => d !== null))
    const removed = new Set(removedLines(f.patch).map(extract).filter((d): d is string => d !== null))

    for (const dep of added) {
      // A dep also present on a removed line only changed its version — skip.
      if (removed.has(dep)) continue
      flags.push({
        id: 'new-dependency',
        label: `new dependency: ${dep}`,
        file: f.filename,
        evidence: `verify ${dep} is a real, intended package (typo-/slopsquatting guard)`,
      })
    }
  }
  return flags
}

// ---------------------------------------------------------------------------
// (b) Error masking — silently swallowed failures
// ---------------------------------------------------------------------------

// One-line empty catch: `catch {}` / `catch (e) {}` / `} catch (e) {}` — the
// braces must be EMPTY (a rethrow/log in the block must not match).
const EMPTY_CATCH_ONE_LINE = /catch\s*(\([^)]*\))?\s*\{\s*\}/
// Promise-chain swallow: `.catch(() => {})` / `.catch(e => {})` with empty body.
const EMPTY_PROMISE_CATCH = /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/
// Opening of a catch block (multi-line form).
const CATCH_OPEN = /catch\s*(\([^)]*\))?\s*\{\s*$/
// Python: `except: pass` / `except Exception: pass` on one line.
const EXCEPT_PASS_ONE_LINE = /^\s*except(\s+[\w.()\s,]+)?\s*:\s*pass\s*(#.*)?$/
// Python multi-line: bare `except…:` opener, then `pass` as the sole body line.
const EXCEPT_OPEN = /^\s*except(\s+[\w.()\s,]+)?\s*:\s*$/
const PASS_ONLY = /^\s*pass\s*(#.*)?$/

function detectErrorMasking(files: PrFile[]): HeuristicFlag[] {
  const flags: HeuristicFlag[] = []
  for (const f of files) {
    const lines = addedLines(f.patch)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const next = lines[i + 1]
      let evidence: string | null = null

      if (EMPTY_CATCH_ONE_LINE.test(line)) {
        evidence = 'empty catch block swallows the error'
      } else if (EMPTY_PROMISE_CATCH.test(line)) {
        evidence = 'promise .catch(() => {}) swallows the rejection'
      } else if (EXCEPT_PASS_ONE_LINE.test(line)) {
        evidence = 'bare except: pass swallows the exception'
      } else if (CATCH_OPEN.test(line) && next !== undefined && /^\s*\}/.test(next)) {
        // `catch (…) {` immediately closed by the NEXT ADDED line → empty body.
        // Any body line between them (log, rethrow) breaks the adjacency → no flag.
        evidence = 'empty catch block swallows the error'
      } else if (EXCEPT_OPEN.test(line) && next !== undefined && PASS_ONLY.test(next)) {
        evidence = 'except: pass swallows the exception'
      }

      if (evidence) {
        flags.push({
          id: 'error-masking',
          label: 'error masking',
          file: f.filename,
          evidence,
        })
      }
    }
  }
  return flags
}

// ---------------------------------------------------------------------------
// (c) Within-diff duplication — near-identical added blocks
// ---------------------------------------------------------------------------

/** Lines too trivial to count toward a duplicated block. */
function isTrivialLine(normalized: string): boolean {
  if (normalized === '') return true
  if (/^[{}()[\];,]+$/.test(normalized)) return true
  if (/^(import\s|from\s.+\simport\s|export\s+\{|#include\s|using\s|package\s)/.test(normalized)) return true
  if (/^(\/\/|\/\*|\*|#|--)/.test(normalized)) return true
  return false
}

function detectDuplication(files: PrFile[]): HeuristicFlag[] {
  // Per-file list of substantive normalized added lines (whitespace-collapsed).
  type Loc = { file: string; start: number }
  const windows = new Map<string, Loc[]>()

  for (const f of files) {
    const substantive = addedLines(f.patch)
      .map((l) => l.trim().replace(/\s+/g, ' '))
      .filter((l) => !isTrivialLine(l))
    for (let i = 0; i + DUPLICATION_WINDOW <= substantive.length; i++) {
      const key = substantive.slice(i, i + DUPLICATION_WINDOW).join('\n')
      const locs = windows.get(key) ?? []
      locs.push({ file: f.filename, start: i })
      windows.set(key, locs)
    }
  }

  // A window key seen at 2+ NON-OVERLAPPING locations = duplicated block.
  const flaggedPairs = new Set<string>()
  const flags: HeuristicFlag[] = []
  for (const locs of windows.values()) {
    if (locs.length < 2) continue
    for (let a = 0; a < locs.length; a++) {
      for (let b = a + 1; b < locs.length; b++) {
        const la = locs[a]
        const lb = locs[b]
        const overlaps = la.file === lb.file && Math.abs(la.start - lb.start) < DUPLICATION_WINDOW
        if (overlaps) continue
        const pairKey = la.file === lb.file ? la.file : `${la.file}|${lb.file}`
        if (flaggedPairs.has(pairKey)) continue
        flaggedPairs.add(pairKey)
        flags.push({
          id: 'duplication',
          label: 'duplicated added code',
          file: la.file,
          evidence:
            la.file === lb.file
              ? `≥${DUPLICATION_WINDOW} near-identical added lines appear twice in ${la.file}`
              : `≥${DUPLICATION_WINDOW} near-identical added lines appear in ${la.file} and ${lb.file}`,
        })
      }
    }
  }
  return flags
}

// ---------------------------------------------------------------------------
// (d) Untested bulk — large addition, zero test changes
// ---------------------------------------------------------------------------

function detectUntestedBulk(files: PrFile[]): HeuristicFlag[] {
  const touchesTests = files.some((f) => isTestFile(f.filename))
  if (touchesTests) return []
  const nonTestAdded = files.reduce((s, f) => s + f.additions, 0)
  if (nonTestAdded < UNTESTED_BULK_THRESHOLD) return []
  const biggest = [...files].sort((a, b) => b.additions - a.additions)[0]
  return [
    {
      id: 'untested-bulk',
      label: 'large addition without tests',
      file: biggest?.filename ?? '',
      evidence: `+${nonTestAdded} lines added with no test-file changes`,
    },
  ]
}

// ---------------------------------------------------------------------------
// (e) Security-sensitive paths
// ---------------------------------------------------------------------------

const SENSITIVE_TOKENS = new Set([
  'auth', 'authn', 'authz', 'authentication', 'authorization', 'oauth',
  'token', 'tokens', 'crypto', 'payment', 'payments', 'billing',
  'secret', 'secrets', 'permission', 'permissions', 'credentials',
  'password', 'passwords', 'security',
])

/**
 * True when the path contains a security-sensitive segment. Segments are
 * tokenized on -_. so `auth-service` and `user_tokens.py` match but `author.ts`
 * does NOT (whole-token match only — conservative).
 */
export function isSensitivePath(path: string): boolean {
  if (path.startsWith('.github/workflows/')) return true
  for (const segment of path.split('/')) {
    const noExt = segment.replace(/\.[A-Za-z0-9]+$/, '')
    for (const token of noExt.toLowerCase().split(/[-_.]/)) {
      if (SENSITIVE_TOKENS.has(token)) return true
    }
  }
  return false
}

function detectSensitivePaths(files: PrFile[]): HeuristicFlag[] {
  const flags: HeuristicFlag[] = []
  for (const f of files) {
    if (!isSensitivePath(f.filename)) continue
    flags.push({
      id: 'sensitive-path',
      label: 'security-sensitive path',
      file: f.filename,
      evidence: f.filename.startsWith('.github/workflows/')
        ? 'CI workflow change — review permissions and injected inputs'
        : 'touches an auth/token/crypto/payment/secret/permission area',
    })
  }
  return flags
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run every diff-computable AI-pattern heuristic over the PR's files. */
export function detectHeuristics(files: PrFile[]): HeuristicFlag[] {
  return [
    ...detectNewDependencies(files),
    ...detectErrorMasking(files),
    ...detectDuplication(files),
    ...detectUntestedBulk(files),
    ...detectSensitivePaths(files),
  ]
}
