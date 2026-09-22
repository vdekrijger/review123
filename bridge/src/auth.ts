/**
 * auth.ts — the pairing token.
 *
 * The bridge mints a fresh 32-byte random token on every start and prints it.
 * Nothing reaches any route without presenting it as `Authorization: Bearer
 * <token>`. Per-process by default: stopping the bridge invalidates the token,
 * so a token that leaked into a screenshot or a shell history stops working the
 * moment the user restarts. `--token-file` opts into a stable token for people
 * who restart the bridge often; the file is created 0600.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Token entropy. 32 bytes → 43 base64url characters. */
export const TOKEN_BYTES = 32

/** A fresh, URL-safe pairing token. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Pull the credential out of an `Authorization` header.
 * Returns null for a missing header, a non-Bearer scheme, or an empty value.
 * The scheme is matched case-insensitively (RFC 7235); the token is not.
 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/**
 * Constant-time token comparison.
 *
 * A length mismatch short-circuits: the token length is fixed and public, so
 * leaking "wrong length" tells an attacker nothing, while feeding buffers of
 * different lengths to timingSafeEqual would throw.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * With `--token-file`: reuse the file's token when it holds one, otherwise mint
 * one and write it 0600. Without: mint a per-process token.
 */
export async function loadOrCreateToken(tokenFile: string | null): Promise<string> {
  if (tokenFile === null) return generateToken()
  try {
    const existing = (await readFile(tokenFile, 'utf8')).trim()
    if (existing !== '') return existing
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const token = generateToken()
  await mkdir(dirname(tokenFile), { recursive: true })
  await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  // writeFile's mode is only applied when it CREATES the file; chmod makes the
  // permissions right even when an empty file was already there.
  await chmod(tokenFile, 0o600)
  return token
}
