/**
 * files.ts — `POST /v1/files`: batch-read the working tree.
 *
 * This is half of what makes the bridge worth running. The hosted path fetches
 * file contents one GET at a time from the provider API: rate limited, capped,
 * and blind to anything outside the PR's diff. Here the same read is a local
 * `open()`.
 *
 * WHAT MAKES IT SAFE
 *
 * EVERY path — not the first, not a sample, every one — goes through
 * confine.ts's realpath-twice check before anything is opened. That is the
 * gate that catches `../../.ssh/id_rsa`, `/etc/passwd`, and the nastier case a
 * lexical check misses: `repo/link -> /etc`, a symlink that lives inside the
 * repo and points out of it.
 *
 * A confinement failure fails the WHOLE request with `403 forbidden-path`
 * rather than dropping that path from the results. A caller must never be able
 * to mistake "refused" for "missing".
 *
 * THREE OUTCOMES PER PATH, and they never overlap:
 *   files[]   — it is a readable text file; here is its content (maybe cut).
 *   missing[] — nothing is there. Per the contract this is NOT an error.
 *   skipped[] — something is there but it yields no text: binary, a directory,
 *               or unreadable. Reported with a reason rather than decoded into
 *               replacement-character soup that reads like source and is not.
 *
 * CAPS, all enforced BEFORE the bytes exist rather than after:
 *   - MAX_FILES_PER_REQUEST paths per call (over → bad-request, never a silent
 *     trim: a caller that asked for 500 and silently got 200 would ground its
 *     answer in a set it did not choose);
 *   - `maxBytes` per file, clamped to MAX_FILE_BYTES;
 *   - MAX_FILES_TOTAL_BYTES across the response.
 * `truncated` is reported honestly in every case — including a file cut to
 * nothing because the total budget was already spent.
 */

import { open, stat } from 'node:fs/promises'
import { PathEscapeError, resolveInRoot } from './confine.js'
import {
  BINARY_SNIFF_BYTES,
  MAX_FILES_PER_REQUEST,
  MAX_FILES_TOTAL_BYTES,
  MAX_FILE_BYTES,
  type FileEntry,
  type FileSkip,
  type FilesRequest,
  type FilesResponse,
} from './protocol.js'

/** A refusal the route turns into an HTTP status. Mirrors InferFailure. */
export interface FilesFailure {
  ok: false
  code: 'bad-request' | 'forbidden-path'
  message: string
}

export type FilesOutcome = FilesResponse | FilesFailure

/** Validate an untrusted `/v1/files` body. */
export function parseFilesRequest(body: unknown): FilesRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'Body must be a JSON object.' }
  const raw = body as Record<string, unknown>

  const paths = raw['paths']
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    return { error: 'paths must be an array of strings.' }
  }
  if (paths.length === 0) return { error: 'paths must name at least one file.' }
  if (paths.length > MAX_FILES_PER_REQUEST) {
    return { error: `paths is capped at ${MAX_FILES_PER_REQUEST} entries per request.` }
  }

  const maxBytes = raw['maxBytes']
  if (maxBytes !== undefined && typeof maxBytes !== 'number') {
    return { error: 'maxBytes must be a number.' }
  }

  const parsed: FilesRequest = { paths: paths as string[] }
  if (typeof maxBytes === 'number') parsed.maxBytes = maxBytes
  return parsed
}

/** Clamp a requested per-file ceiling into what the bridge will actually serve. */
export function clampMaxBytes(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return MAX_FILE_BYTES
  }
  return Math.min(Math.trunc(requested), MAX_FILE_BYTES)
}

/** Git's own heuristic: a NUL in the first few KB means "not text". */
export function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * Decode a byte prefix as UTF-8 WITHOUT inventing a replacement character at
 * the cut.
 *
 * Slicing a file at an arbitrary byte offset lands mid-codepoint roughly one
 * time in four for non-ASCII text. `toString('utf8')` would turn that dangling
 * lead byte into U+FFFD — a character that was never in the user's file, in a
 * payload a model is about to reason over. So the trailing incomplete sequence
 * is dropped instead: a truncated read loses at most three bytes it was never
 * going to show anyway.
 *
 * Only applied when the buffer IS a cut prefix; a whole file is decoded as-is
 * (a file that is genuinely invalid UTF-8 keeps whatever git-style mojibake it
 * has, rather than being silently shortened).
 */
export function decodeUtf8Prefix(buf: Buffer, isPrefix: boolean): string {
  if (!isPrefix || buf.length === 0) return buf.toString('utf8')

  // Walk back over continuation bytes (10xxxxxx) to the last lead byte.
  let end = buf.length
  let back = 0
  while (end > 0 && back < 4 && (buf[end - 1]! & 0xc0) === 0x80) {
    end -= 1
    back += 1
  }
  if (end === 0) return buf.toString('utf8')

  const lead = buf[end - 1]!
  // How many bytes the sequence starting at `lead` needs in total.
  const needed = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0
  // `needed === 0` means `lead` is itself a stray continuation byte — not a
  // truncation we caused, so leave the buffer alone.
  if (needed === 0) return buf.toString('utf8')
  const have = buf.length - (end - 1)
  return have >= needed ? buf.toString('utf8') : buf.subarray(0, end - 1).toString('utf8')
}

/** One path's read, after confinement. Never throws. */
async function readOne(
  realPath: string,
  requested: string,
  perFileCap: number,
  remainingTotal: number,
): Promise<
  | { kind: 'file'; entry: FileEntry }
  | { kind: 'missing' }
  | { kind: 'skipped'; skip: FileSkip }
> {
  let size: number
  try {
    const st = await stat(realPath)
    if (!st.isFile()) return { kind: 'skipped', skip: { path: requested, reason: 'not-a-file' } }
    size = st.size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'skipped', skip: { path: requested, reason: 'unreadable' } }
  }

  // The cut is the tighter of: this file's own ceiling, and what is left of
  // the whole response's budget. A file cut to ZERO still comes back as a file
  // entry with `truncated: true` — the caller learns it exists and that the
  // budget ran out, which is more useful than pretending it is missing.
  const cap = Math.max(0, Math.min(perFileCap, remainingTotal))
  const toRead = Math.min(size, cap)

  let buf: Buffer
  try {
    const handle = await open(realPath, 'r')
    try {
      // Sniff for binary over the first chunk even when `cap` is 0, so a
      // budget-exhausted binary is still reported as binary and not as a
      // zero-byte text file.
      const sniffLen = Math.min(size, Math.max(toRead, BINARY_SNIFF_BYTES))
      const sniff = Buffer.alloc(sniffLen)
      const { bytesRead } = sniffLen > 0 ? await handle.read(sniff, 0, sniffLen, 0) : { bytesRead: 0 }
      const head = sniff.subarray(0, bytesRead)
      if (looksBinary(head)) return { kind: 'skipped', skip: { path: requested, reason: 'binary' } }
      buf = head.subarray(0, toRead)
      // The sniff covered the whole read only when it reached at least `toRead`.
      if (bytesRead < toRead) {
        const rest = Buffer.alloc(toRead - bytesRead)
        const more = await handle.read(rest, 0, rest.length, bytesRead)
        buf = Buffer.concat([head, rest.subarray(0, more.bytesRead)])
      }
    } finally {
      await handle.close()
    }
  } catch {
    return { kind: 'skipped', skip: { path: requested, reason: 'unreadable' } }
  }

  const truncated = buf.length < size
  return {
    kind: 'file',
    entry: {
      path: requested,
      bytes: size,
      truncated,
      content: decodeUtf8Prefix(buf, truncated),
      encoding: 'utf-8',
    },
  }
}

/**
 * The route's worker. Never throws — every outcome is a FilesOutcome, because
 * an escaping exception in the HTTP layer becomes a generic 500 that tells the
 * user nothing.
 */
export async function readFiles(realRoot: string, req: FilesRequest): Promise<FilesOutcome> {
  const perFileCap = clampMaxBytes(req.maxBytes)

  // CONFINE EVERY PATH FIRST, before a single byte is read. Resolving as we go
  // would mean an escape attempt buried at position 40 only failed after 39
  // files had already been read and were about to be returned.
  const resolved: { requested: string; real: string }[] = []
  for (const requested of req.paths) {
    try {
      resolved.push({ requested, real: await resolveInRoot(realRoot, requested) })
    } catch (err) {
      if (err instanceof PathEscapeError) {
        // The path is the CALLER's own string, so echoing it leaks nothing the
        // caller did not already send.
        return { ok: false, code: 'forbidden-path', message: `Path is outside the repo: ${requested}` }
      }
      return { ok: false, code: 'bad-request', message: `Could not resolve path: ${requested}` }
    }
  }

  const files: FileEntry[] = []
  const missing: string[] = []
  const skipped: FileSkip[] = []
  let remainingTotal = MAX_FILES_TOTAL_BYTES

  for (const { requested, real } of resolved) {
    const result = await readOne(real, requested, perFileCap, remainingTotal)
    if (result.kind === 'missing') {
      missing.push(requested)
    } else if (result.kind === 'skipped') {
      skipped.push(result.skip)
    } else {
      remainingTotal -= Buffer.byteLength(result.entry.content, 'utf8')
      files.push(result.entry)
    }
  }

  return { ok: true, files, missing, skipped }
}

/** HTTP status for each failure the route can produce. */
export function statusForFilesError(code: FilesFailure['code']): number {
  return code === 'forbidden-path' ? 403 : 400
}
