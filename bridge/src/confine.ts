/**
 * confine.ts — every path the bridge touches must stay inside ONE repo.
 *
 * The bridge is started inside a repo and resolves that root ONCE, through
 * `realpath`, at startup. Afterwards no request can name a path outside it:
 *
 *   - absolute paths are refused outright (a request names repo-RELATIVE paths);
 *   - `..` segments are neutralised by resolving against the real root and then
 *     re-checking containment — resolution alone is not enough, because…
 *   - …a SYMLINK inside the repo can point anywhere. So the resolved path is
 *     itself put through `realpath` before the containment check. That is the
 *     check that catches `repo/link -> /etc`, which a pure string/`path.resolve`
 *     guard would happily accept.
 *
 * The root is realpath'd too, or the comparison would fail on every macOS temp
 * dir (`/tmp` is a symlink to `/private/tmp`) and, worse, could be made to pass
 * by a symlinked root.
 */

import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Thrown when a requested path is not inside the repo root. Maps to HTTP 403. */
export class PathEscapeError extends Error {
  readonly requested: string
  constructor(requested: string, reason: string) {
    super(`path escapes the repo root (${reason}): ${requested}`)
    this.name = 'PathEscapeError'
    this.requested = requested
  }
}

/**
 * Resolve the bridge's repo root at startup: it must exist, be a directory, and
 * is stored in its fully-resolved (symlink-free) form.
 */
export async function resolveRepoRoot(root: string): Promise<string> {
  const real = await realpath(resolve(root))
  const st = await stat(real)
  if (!st.isDirectory()) throw new Error(`--root is not a directory: ${root}`)
  return real
}

/**
 * True when `candidate` is the root itself or lives beneath it.
 *
 * The `+ sep` matters: without it `/repo-secrets` would count as inside
 * `/repo`.
 */
export function isInside(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot + sep)
}

/**
 * Map a repo-relative request path to a real absolute path inside the root,
 * or throw PathEscapeError.
 *
 * Works for paths that do not exist yet (the deepest existing ancestor is
 * realpath'd and the remainder appended), so a request for a missing file is
 * reported as missing by the caller rather than being indistinguishable from a
 * rejected escape.
 */
export async function resolveInRoot(realRoot: string, requested: string): Promise<string> {
  if (requested.includes('\0')) throw new PathEscapeError(requested, 'NUL byte')
  if (isAbsolute(requested)) throw new PathEscapeError(requested, 'absolute path')
  // Windows-style absolute/UNC forms are not `isAbsolute` on POSIX; refuse the
  // drive-letter and backslash-root shapes explicitly so behaviour matches.
  if (/^[a-zA-Z]:[\\/]/.test(requested) || requested.startsWith('\\')) {
    throw new PathEscapeError(requested, 'absolute path')
  }

  const lexical = resolve(realRoot, requested)
  // Cheap first gate: catches plain `../` traversal before touching the disk.
  if (!isInside(realRoot, lexical)) throw new PathEscapeError(requested, 'traversal')

  // Expensive, authoritative gate: follows symlinks.
  const real = await realpathOrAncestor(lexical)
  if (!isInside(realRoot, real)) throw new PathEscapeError(requested, 'symlink escape')
  return real
}

/**
 * `realpath` that tolerates a missing leaf: resolves the deepest existing
 * ancestor and re-appends the missing segments. Any symlink along the existing
 * part is therefore still followed (and caught by the containment check).
 */
async function realpathOrAncestor(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const parent = dirname(target)
    // Filesystem root reached without finding anything that exists.
    if (parent === target) throw err
    return join(await realpathOrAncestor(parent), basename(target))
  }
}
