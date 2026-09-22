/**
 * search.ts — `POST /v1/search`: content search across the working tree.
 *
 * The other half of the bridge's grounding value. The hosted path uses the
 * provider's code-search API: roughly ten calls a minute, indexed against the
 * DEFAULT branch rather than the PR's head, and unavailable at all to a signed
 * -out user. A local search has none of those properties — it is free, it is
 * instant, and it sees the tree that is actually on disk.
 *
 * TWO BACKENDS, ONE CONTRACT
 *
 *   ripgrep  — used when `rg` is on PATH. It is enormously faster than
 *              anything written here, and it implements `.gitignore` properly
 *              rather than approximately. Invoked with `spawn` and a
 *              HARD-CODED argv array — never a shell, so no query text can
 *              become a flag (`-e` carries the pattern) or a command.
 *   JS walk  — the fallback. A bounded directory walk applying ignore.ts's
 *              documented gitignore subset.
 *
 * Both obey the same rules:
 *   - NEVER follow a symlink. `rg` does not by default (and is told
 *     `--no-follow` anyway); the walker checks `isSymbolicLink()` on every
 *     entry. A link inside the repo pointing at `/etc` therefore cannot
 *     smuggle outside content into a result — the same escape confine.ts
 *     blocks on the read path.
 *   - Skip binary files rather than reporting matches inside them.
 *   - Honour `maxResults` and report `truncated` honestly, including when the
 *     scan budget or the wall clock ran out rather than the result cap.
 *
 * If ripgrep is present but FAILS (an unsupported flag on an ancient build, a
 * crash), the walker runs instead. A degraded search beats no search, and the
 * caller cannot tell the difference because the contract is identical.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { findOnPath, type CapabilityDeps } from './capabilities.js'
import {
  ALWAYS_SKIP_DIRS,
  globToRegExp,
  isIgnored,
  matchesInclude,
  couldContainInclude,
  parseGitignore,
  type IgnoreScope,
} from './ignore.js'
import {
  BINARY_SNIFF_BYTES,
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
  SEARCH_MAX_FILES_SCANNED,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_PREVIEW_MAX_CHARS,
  SEARCH_TIMEOUT_MS,
  type SearchMatch,
  type SearchRequest,
  type SearchResponse,
} from './protocol.js'

/** Max `include` globs one request may carry. */
export const MAX_INCLUDE_GLOBS = 20

/** Max characters in a query. A pattern longer than this is not a search. */
export const MAX_QUERY_CHARS = 500

/** Validate an untrusted `/v1/search` body. */
export function parseSearchRequest(body: unknown): SearchRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'Body must be a JSON object.' }
  const raw = body as Record<string, unknown>

  const query = raw['query']
  if (typeof query !== 'string' || query === '') return { error: 'query must be a non-empty string.' }
  if (query.length > MAX_QUERY_CHARS) return { error: `query is capped at ${MAX_QUERY_CHARS} characters.` }

  const regex = raw['regex']
  if (regex !== undefined && typeof regex !== 'boolean') return { error: 'regex must be a boolean.' }
  const caseSensitive = raw['caseSensitive']
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    return { error: 'caseSensitive must be a boolean.' }
  }
  const maxResults = raw['maxResults']
  if (maxResults !== undefined && typeof maxResults !== 'number') {
    return { error: 'maxResults must be a number.' }
  }
  const include = raw['include']
  if (include !== undefined && (!Array.isArray(include) || include.some((g) => typeof g !== 'string'))) {
    return { error: 'include must be an array of glob strings.' }
  }
  if (Array.isArray(include) && include.length > MAX_INCLUDE_GLOBS) {
    return { error: `include is capped at ${MAX_INCLUDE_GLOBS} globs.` }
  }

  // A user-supplied regex is COMPILED HERE, so a malformed one is a 400 the
  // caller can act on rather than an opaque failure two layers down.
  if (regex === true) {
    try {
      new RegExp(query)
    } catch {
      return { error: 'query is not a valid regular expression.' }
    }
  }

  const parsed: SearchRequest = { query }
  if (typeof regex === 'boolean') parsed.regex = regex
  if (typeof caseSensitive === 'boolean') parsed.caseSensitive = caseSensitive
  if (typeof maxResults === 'number') parsed.maxResults = maxResults
  if (Array.isArray(include)) parsed.include = include as string[]
  return parsed
}

/** Clamp a requested result ceiling into what the bridge will actually serve. */
export function clampMaxResults(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_SEARCH_RESULTS
  }
  return Math.min(Math.trunc(requested), MAX_SEARCH_RESULTS)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Trim a matching line to something a prompt can carry. */
export function previewLine(line: string): string {
  const clean = line.replace(/\r?\n$/, '').replace(/\t/g, '  ')
  return clean.length > SEARCH_PREVIEW_MAX_CHARS ? `${clean.slice(0, SEARCH_PREVIEW_MAX_CHARS)}…` : clean
}

// ---------------------------------------------------------------------------
// Backend 1 — ripgrep
// ---------------------------------------------------------------------------

/**
 * Build ripgrep's argv. Exported so a test can assert the SHAPE — that the
 * query is carried by `-e` (so a query like `--foo` is a pattern, not a flag),
 * that the search path is `.` behind a `--` terminator, and that symlink
 * following is off — without spawning anything.
 */
export function buildRipgrepArgs(req: SearchRequest): string[] {
  const args = [
    '--json',
    '--no-follow',
    '--no-messages',
    // Without this, ripgrep applies .gitignore ONLY inside a git repository —
    // so a bridge served from a plain directory (or a worktree rg does not
    // recognise) would silently search `dist/` and `node_modules/` while the
    // JS fallback did not. The two backends must answer the same question.
    '--no-require-git',
    '--color', 'never',
    '--max-filesize', String(SEARCH_MAX_FILE_BYTES),
    req.caseSensitive === true ? '--case-sensitive' : '--ignore-case',
  ]
  // Literal by default: review123 searches for identifiers, and a bare `.` or
  // `(` in one must not silently become a regex metacharacter.
  if (req.regex !== true) args.push('--fixed-strings')
  for (const glob of req.include ?? []) args.push('--glob', glob)
  // `-e` keeps a leading-dash query a PATTERN. `--` then ends option parsing
  // so the search path cannot be reinterpreted either.
  args.push('-e', req.query, '--', '.')
  return args
}

interface RgMatchData {
  path?: { text?: string }
  lines?: { text?: string }
  line_number?: number
  submatches?: { start?: number }[]
}

/**
 * Turn one `rg --json` NDJSON line into a SearchMatch, or null.
 *
 * `submatches[].start` is a BYTE offset into the line; the contract promises a
 * 1-based CHARACTER column, so the prefix is re-decoded to convert. A line rg
 * reports as `bytes` rather than `text` is not valid UTF-8 and is dropped:
 * there is no honest column or preview to report for it.
 */
export function parseRipgrepLine(line: string): SearchMatch | null {
  let doc: { type?: string; data?: RgMatchData }
  try {
    doc = JSON.parse(line) as { type?: string; data?: RgMatchData }
  } catch {
    return null
  }
  if (doc.type !== 'match' || !doc.data) return null
  const path = doc.data.path?.text
  const text = doc.data.lines?.text
  const lineNumber = doc.data.line_number
  if (typeof path !== 'string' || typeof text !== 'string' || typeof lineNumber !== 'number') return null

  const startByte = doc.data.submatches?.[0]?.start ?? 0
  const column = Buffer.from(text, 'utf8').subarray(0, startByte).toString('utf8').length + 1
  return { path: normalizeRelPath(path), line: lineNumber, column, preview: previewLine(text) }
}

/** rg prints `./src/a.ts` when told to search `.`; the contract wants `src/a.ts`. */
function normalizeRelPath(p: string): string {
  return p.replace(/^\.\//, '')
}

type SpawnFn = typeof nodeSpawn

/**
 * Run ripgrep, streaming its NDJSON and stopping the moment the result cap is
 * reached. Resolves null when rg could not produce an answer at all, which is
 * the caller's cue to fall back to the walker.
 */
export async function searchWithRipgrep(
  realRoot: string,
  req: SearchRequest,
  maxResults: number,
  opts: { spawn?: SpawnFn; timeoutMs?: number } = {},
): Promise<SearchResponse | null> {
  const spawn = opts.spawn ?? nodeSpawn
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS

  return new Promise<SearchResponse | null>((resolve) => {
    const matches: SearchMatch[] = []
    let truncated = false
    let buffer = ''
    let settled = false
    let killed = false
    let sawError = false
    let killTimer: NodeJS.Timeout | null = null

    let child: ReturnType<SpawnFn>
    try {
      child = spawn('rg', buildRipgrepArgs(req), {
        cwd: realRoot,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
      })
    } catch {
      resolve(null)
      return
    }

    const stop = (): void => {
      if (killed) return
      killed = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      killTimer.unref?.()
    }

    const budget = setTimeout(() => {
      truncated = true
      stop()
    }, timeoutMs)

    const finish = (value: SearchResponse | null): void => {
      if (settled) return
      settled = true
      clearTimeout(budget)
      if (killTimer) clearTimeout(killTimer)
      resolve(value)
    }

    const take = (raw: string): void => {
      if (matches.length >= maxResults) return
      const match = parseRipgrepLine(raw)
      if (match === null) return
      matches.push(match)
      if (matches.length >= maxResults) {
        truncated = true
        stop()
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        take(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
      // A pathological single line with no newline would grow forever.
      if (buffer.length > 1024 * 1024) buffer = ''
    })

    child.on('error', () => {
      sawError = true
      finish(null)
    })

    child.on('close', (code) => {
      if (buffer !== '') take(buffer)
      if (sawError) return finish(null)
      // rg: 0 = matches, 1 = no matches, 2 = error. We kill it ourselves once
      // the cap is hit, so a killed run with results is a success, not a
      // failure — check `killed` before trusting the exit code.
      if (!killed && code !== 0 && code !== 1) return finish(null)
      finish({ ok: true, matches, truncated })
    })
  })
}

// ---------------------------------------------------------------------------
// Backend 2 — the bounded JS walk
// ---------------------------------------------------------------------------

/** Read a file's ignore rules, or an empty rule set when it has none. */
async function scopeFor(dirAbs: string, baseRel: string): Promise<IgnoreScope | null> {
  try {
    const text = await readFile(join(dirAbs, '.gitignore'), 'utf8')
    const rules = parseGitignore(text)
    return rules.length > 0 ? { baseRel, rules } : null
  } catch {
    return null
  }
}

/** The first chunk of a file, for the binary sniff. Null when unreadable. */
async function sniff(abs: string): Promise<Buffer | null> {
  try {
    const handle = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
      const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0)
      return buf.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function searchWithWalk(
  realRoot: string,
  req: SearchRequest,
  maxResults: number,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<SearchResponse> {
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.timeoutMs ?? SEARCH_TIMEOUT_MS)

  const flags = req.caseSensitive === true ? 'g' : 'gi'
  const pattern = new RegExp(req.regex === true ? req.query : escapeRegExp(req.query), flags)
  const includeGlobs = req.include ?? []
  const includes = includeGlobs.map((g) => globToRegExp(g))

  const matches: SearchMatch[] = []
  let truncated = false
  let scanned = 0

  async function walk(dirAbs: string, dirRel: string, scopes: IgnoreScope[]): Promise<void> {
    if (truncated) return
    if (now() > deadline) {
      truncated = true
      return
    }

    let entries: Dirent[]
    try {
      entries = await readdir(dirAbs, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }

    const own = await scopeFor(dirAbs, dirRel)
    const active = own ? [...scopes, own] : scopes

    // Directories last, so shallow matches come back before deep ones.
    const dirs: { abs: string; rel: string }[] = []

    for (const entry of entries) {
      if (truncated) return
      // NEVER follow a symlink — see the module header. A link is not read and
      // not descended, whether it points inside the repo or out of it.
      if (entry.isSymbolicLink()) continue

      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue
        if (isIgnored(rel, true, active)) continue
        if (!couldContainInclude(rel, includeGlobs)) continue
        dirs.push({ abs: join(dirAbs, entry.name), rel })
        continue
      }
      if (!entry.isFile()) continue
      if (isIgnored(rel, false, active)) continue
      if (!matchesInclude(rel, includes)) continue

      if (scanned >= SEARCH_MAX_FILES_SCANNED) {
        truncated = true
        return
      }
      scanned += 1
      await scanFile(join(dirAbs, entry.name), rel)
      if (truncated) return
    }

    for (const dir of dirs) {
      await walk(dir.abs, dir.rel, active)
      if (truncated) return
    }
  }

  async function scanFile(abs: string, rel: string): Promise<void> {
    let size: number
    try {
      size = (await stat(abs)).size
    } catch {
      return
    }
    if (size > SEARCH_MAX_FILE_BYTES) return

    const head = await sniff(abs)
    if (head === null) return
    // Same NUL heuristic files.ts uses: a binary file has no lines worth
    // reporting, and reporting a "match" inside one is noise at best.
    for (let i = 0; i < head.length; i += 1) {
      if (head[i] === 0) return
    }

    let text: string
    try {
      text = await readFile(abs, 'utf8')
    } catch {
      return
    }

    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      pattern.lastIndex = 0
      const hit = pattern.exec(line)
      if (hit === null) continue
      matches.push({ path: rel, line: i + 1, column: hit.index + 1, preview: previewLine(line) })
      if (matches.length >= maxResults) {
        truncated = true
        return
      }
      if (now() > deadline) {
        truncated = true
        return
      }
    }
  }

  await walk(realRoot, '', [])
  return { ok: true, matches, truncated }
}

// ---------------------------------------------------------------------------
// The route's worker
// ---------------------------------------------------------------------------

export interface RunSearchOptions {
  /** PATH probe for `rg`. Injected so tests can force either backend. */
  hasRipgrep?: () => Promise<boolean>
  spawn?: SpawnFn
  timeoutMs?: number
}

/** Is `rg` on PATH? Uses the same executable probe capabilities.ts does. */
export function ripgrepProbe(deps: CapabilityDeps): () => Promise<boolean> {
  return () => findOnPath('rg', deps)
}

/**
 * Run one search, preferring ripgrep and falling back to the walker.
 *
 * Every error the backends can foresee — an unreadable directory, a file that
 * vanished mid-walk, a crashed `rg` — is already handled inside them, so this
 * does not swallow exceptions: anything that still escapes is a bug, and
 * server.ts turns it into a generic 500 rather than a 400 that would blame the
 * caller for the bridge's own failure.
 */
export async function runSearch(
  realRoot: string,
  req: SearchRequest,
  opts: RunSearchOptions = {},
): Promise<SearchResponse> {
  const maxResults = clampMaxResults(req.maxResults)

  const useRg = opts.hasRipgrep ? await opts.hasRipgrep() : false
  if (useRg) {
    const spawnOpts: { spawn?: SpawnFn; timeoutMs?: number } = {}
    if (opts.spawn) spawnOpts.spawn = opts.spawn
    if (opts.timeoutMs !== undefined) spawnOpts.timeoutMs = opts.timeoutMs
    const viaRg = await searchWithRipgrep(realRoot, req, maxResults, spawnOpts)
    if (viaRg !== null) return viaRg
    // rg was there but could not answer. Fall through to the walker rather
    // than failing a search the fallback can still serve.
  }
  const walkOpts: { timeoutMs?: number } = {}
  if (opts.timeoutMs !== undefined) walkOpts.timeoutMs = opts.timeoutMs
  return searchWithWalk(realRoot, req, maxResults, walkOpts)
}
