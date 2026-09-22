/**
 * ignore.ts — the `.gitignore` subset the JS search fallback honours, plus the
 * glob compiler `SearchRequest.include` uses.
 *
 * WHY A SUBSET, STATED UP FRONT
 *
 * When `ripgrep` is on PATH the bridge uses it, and ripgrep implements
 * gitignore properly. This module exists for the machines that do not have it.
 * Reimplementing git's matcher exactly would be a library, not a file, so this
 * is deliberately the common subset — and the bridge SAYS so rather than
 * implying fidelity it does not have:
 *
 *   supported   comments (`#`), blank lines, `!` negation, trailing `/`
 *               (directory-only), leading `/` (anchored to the .gitignore's
 *               own directory), `*`, `?`, `**`, `[abc]` classes, nested
 *               .gitignore files, last-match-wins
 *   NOT         `.git/info/exclude`, the global core.excludesFile, `.gitignore`
 *               rules from parent directories ABOVE the served root, and
 *               git's exact handling of `**` in a few corner positions
 *
 * The practical consequence of a miss is that the fallback searches a file git
 * would have ignored — a slightly noisier result, never a wrong one, and never
 * a file outside the repo (confinement is a separate, exact gate).
 */

/** Always skipped, with or without a .gitignore. */
export const ALWAYS_SKIP_DIRS: ReadonlySet<string> = new Set([
  // Never useful, enormous, and full of the user's own object store.
  '.git',
  // Not a gitignore rule, a FLOOR. A repo that somehow does not ignore its
  // dependency directory would otherwise turn a fallback search into a
  // multi-minute walk of a hundred thousand vendored files.
  'node_modules',
])

export interface IgnoreRule {
  /** `!foo` — a match here UN-ignores. */
  negated: boolean
  /** `foo/` — matches directories only. */
  dirOnly: boolean
  re: RegExp
}

/**
 * Compile one glob to a regex anchored over a whole relative path.
 *
 * `*` and `?` never cross a `/`; `**` does. A pattern containing no `/` (other
 * than a trailing one) matches at ANY depth, exactly as git specifies — that
 * is what makes `*.log` ignore `deep/nested/x.log`.
 */
export function globToRegExp(glob: string, caseSensitive = true): RegExp {
  const anchored = glob.startsWith('/')
  const body = anchored ? glob.slice(1) : glob
  // A pattern with no interior slash floats to any depth.
  const floats = !anchored && !body.replace(/\/$/, '').includes('/')

  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!
    if (ch === '*') {
      if (body[i + 1] === '*') {
        i += 1
        // `**/` consumes the separator so it can also match zero directories.
        if (body[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const close = body.indexOf(']', i + 1)
      if (close === -1) {
        out += '\\['
      } else {
        let cls = body.slice(i + 1, close)
        // git/fnmatch spell negation `!`; a regex class spells it `^`.
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
        out += `[${cls.replace(/\\/g, '\\\\')}]`
        i = close
      }
    } else if ('\\^$.|+()/{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }

  const prefix = floats ? '(?:.*/)?' : ''
  // A directory rule must also match everything beneath it.
  return new RegExp(`^${prefix}${out}(?:/.*)?$`, caseSensitive ? '' : 'i')
}

/** Parse one `.gitignore` file's text into ordered rules. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/\r$/, '')
    // A trailing backslash escapes the space before it; anything else trailing
    // is whitespace git strips.
    if (!line.endsWith('\\ ')) line = line.replace(/\s+$/, '')
    if (line === '' || line.startsWith('#')) continue

    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1)
    }

    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    if (line === '') continue

    rules.push({ negated, dirOnly, re: globToRegExp(line) })
  }
  return rules
}

/** One `.gitignore`'s rules, plus the directory they are relative to. */
export interface IgnoreScope {
  /** Repo-relative directory holding the .gitignore. '' for the root. */
  baseRel: string
  rules: IgnoreRule[]
}

/**
 * Is `relPath` (repo-relative, `/`-separated, no leading slash) ignored by the
 * scopes in effect?
 *
 * Scopes are consulted OUTERMOST FIRST and the LAST match wins, which is how a
 * nested `.gitignore` gets to un-ignore something the root ignored.
 */
export function isIgnored(relPath: string, isDir: boolean, scopes: readonly IgnoreScope[]): boolean {
  let ignored = false
  for (const scope of scopes) {
    const prefix = scope.baseRel === '' ? '' : `${scope.baseRel}/`
    if (prefix !== '' && !relPath.startsWith(prefix)) continue
    const local = relPath.slice(prefix.length)
    if (local === '') continue
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDir) continue
      if (rule.re.test(local)) ignored = !rule.negated
    }
  }
  return ignored
}

/**
 * Does `relPath` pass the request's `include` globs? An empty list includes
 * everything, which is what makes `include` an optional narrowing rather than
 * a required allowlist.
 */
export function matchesInclude(relPath: string, includes: readonly RegExp[]): boolean {
  if (includes.length === 0) return true
  return includes.some((re) => re.test(relPath))
}

/**
 * Could anything under `relDir` still match an include glob?
 *
 * Without this the walker would descend the whole tree to apply a
 * `src/**` filter at the leaves. A directory is kept when any include's
 * literal prefix is compatible with it in either direction — `src/lib` is
 * worth entering for `src/**\/*.ts`, and so is `src` for `src/lib/**`.
 */
export function couldContainInclude(relDir: string, includeGlobs: readonly string[]): boolean {
  if (includeGlobs.length === 0) return true
  return includeGlobs.some((glob) => {
    const literal = glob.replace(/^\//, '').split(/[*?[]/)[0] ?? ''
    const dirPart = literal.includes('/') ? literal.slice(0, literal.lastIndexOf('/')) : ''
    if (dirPart === '') return true
    return dirPart.startsWith(relDir) || relDir.startsWith(dirPart)
  })
}
