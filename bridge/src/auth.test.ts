// @vitest-environment node
/**
 * auth.test.ts — pairing-token minting, parsing and comparison.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_BYTES, extractBearer, generateToken, loadOrCreateToken, tokenMatches } from './auth.js'

describe('generateToken', () => {
  it('produces a URL-safe token with at least 32 bytes of entropy', () => {
    const token = generateToken()
    expect(TOKEN_BYTES).toBeGreaterThanOrEqual(32)
    // base64url of 32 bytes is 43 chars, alphabet A-Za-z0-9-_ with no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('is different on every call', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateToken()))
    expect(tokens.size).toBe(20)
  })
})

describe('extractBearer', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['BEARER   abc123', 'abc123'],
    ['  Bearer abc123  ', 'abc123'],
  ])('parses %j', (header, expected) => {
    expect(extractBearer(header)).toBe(expected)
  })

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a bare token with no scheme', 'abc123'],
    ['Basic auth', 'Basic YWJjOjEyMw=='],
    ['Bearer with no credential', 'Bearer '],
    ['Bearer with two credentials', 'Bearer abc 123'],
  ])('returns null for %s', (_label, header) => {
    expect(extractBearer(header as string | undefined)).toBeNull()
  })
})

describe('tokenMatches', () => {
  it('accepts the exact token', () => {
    const token = generateToken()
    expect(tokenMatches(token, token)).toBe(true)
  })

  it.each([
    ['null (no header)', null],
    ['the empty string', ''],
    ['a different token of the same length', generateToken()],
    ['a prefix of the token', 'short'],
  ])('rejects %s', (_label, presented) => {
    const token = generateToken()
    expect(tokenMatches(presented as string | null, token)).toBe(false)
  })

  it('does not throw on a length mismatch (timingSafeEqual would)', () => {
    expect(() => tokenMatches('a'.repeat(200), generateToken())).not.toThrow()
  })
})

describe('loadOrCreateToken', () => {
  it('mints a fresh per-process token when no --token-file is given', async () => {
    const first = await loadOrCreateToken(null)
    const second = await loadOrCreateToken(null)
    expect(first).not.toBe(second)
  })

  it('creates the token file with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-token-'))
    const file = join(dir, 'nested', 'token')
    const token = await loadOrCreateToken(file)
    expect((await readFile(file, 'utf8')).trim()).toBe(token)
    // 0o777 masks off the file-type bits; 0o600 = owner read/write only.
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('reuses the stored token across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-token-'))
    const file = join(dir, 'token')
    const first = await loadOrCreateToken(file)
    const second = await loadOrCreateToken(file)
    expect(second).toBe(first)
  })
})
