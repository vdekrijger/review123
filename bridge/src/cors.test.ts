// @vitest-environment node
/**
 * cors.test.ts — the origin allowlist and the DNS-rebinding host guard.
 *
 * These are the rules that decide whether a random web page can talk to a
 * server that reads the user's repo, so the near-misses matter more than the
 * happy path: suffix look-alikes, scheme swaps, `null`, and a rebound Host.
 */
import { describe, it, expect } from 'vitest'
import {
  PRIVATE_NETWORK_ALLOW_HEADER,
  REVIEW123_ORIGIN,
  REVIEW123_ORIGINS,
  REVIEW123_WWW_ORIGIN,
  corsHeaders,
  isAllowedHost,
  isAllowedOrigin,
  privateNetworkHeaders,
} from './cors.js'

describe('isAllowedOrigin', () => {
  it('allows the deployed app origin exactly', () => {
    expect(isAllowedOrigin(REVIEW123_ORIGIN)).toBe(true)
    expect(REVIEW123_ORIGIN).toBe('https://review123.dev')
  })

  /**
   * THE REGRESSION. review123.dev answers 308 → www.review123.dev, so `www`
   * is the origin every real browser actually sends. Allowing only the apex
   * meant the bridge refused every genuine user with a headerless 403, which
   * the page could not tell apart from "no bridge is running".
   */
  it('allows the www origin the apex redirects to', () => {
    expect(isAllowedOrigin(REVIEW123_WWW_ORIGIN)).toBe(true)
    expect(REVIEW123_WWW_ORIGIN).toBe('https://www.review123.dev')
    expect(REVIEW123_ORIGINS).toEqual([REVIEW123_ORIGIN, REVIEW123_WWW_ORIGIN])
  })

  it('allowing www does NOT allow any other subdomain', () => {
    for (const origin of [
      'https://api.review123.dev',
      'https://www.review123.dev.evil.test',
      'https://wwww.review123.dev',
      'https://www.review123.dev:8443',
      'http://www.review123.dev',
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(false)
    }
  })

  it('allows loopback dev origins on any port', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:5173',
      'http://localhost:4174',
      'http://127.0.0.1:5173',
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(true)
    }
  })

  it.each([
    ['a missing Origin header', undefined],
    ['a foreign origin', 'https://evil.test'],
    ['a suffix look-alike of the app', 'https://review123.dev.evil.test'],
    ['a prefix look-alike of the app', 'https://notreview123.dev'],
    ['a subdomain of the app', 'https://api.review123.dev'],
    ['the app over http', 'http://review123.dev'],
    ['a loopback look-alike host', 'http://localhost.evil.test:5173'],
    ['loopback over https (we never serve TLS)', 'https://localhost:5173'],
    ['an origin with a trailing slash', 'http://localhost:5173/'],
    ['an origin with a path', 'https://review123.dev/settings'],
    ['the opaque null origin (sandboxed iframe, file://)', 'null'],
    ['an out-of-range port', 'http://localhost:99999'],
    ['a credentialed authority', 'http://user:pw@localhost:5173'],
  ])('rejects %s', (_label, origin) => {
    expect(isAllowedOrigin(origin as string | undefined)).toBe(false)
  })

  it('never matches a wildcard', () => {
    expect(isAllowedOrigin('*')).toBe(false)
  })

  it('adds --allow-origin values as EXACT matches only', () => {
    const extra = ['https://preview.review123.dev']
    expect(isAllowedOrigin('https://preview.review123.dev', extra)).toBe(true)
    expect(isAllowedOrigin('https://preview.review123.dev.evil.test', extra)).toBe(false)
    expect(isAllowedOrigin('https://other.review123.dev', extra)).toBe(false)
  })
})

describe('corsHeaders', () => {
  it('echoes the exact origin and never sends a wildcard', () => {
    const headers = corsHeaders('http://localhost:5173')
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173')
    expect(Object.values(headers)).not.toContain('*')
  })

  it('varies on Origin so a cached response cannot cross origins', () => {
    expect(corsHeaders(REVIEW123_ORIGIN)['Vary']).toBe('Origin')
  })

  it('allows the Authorization header through the preflight', () => {
    expect(corsHeaders(REVIEW123_ORIGIN)['Access-Control-Allow-Headers']).toMatch(/authorization/i)
  })

  it('does NOT allow credentials — the bridge is bearer-token only', () => {
    expect(corsHeaders(REVIEW123_ORIGIN)['Access-Control-Allow-Credentials']).toBeUndefined()
  })

  it('never carries the private-network answer on its own', () => {
    expect(corsHeaders(REVIEW123_ORIGIN)[PRIVATE_NETWORK_ALLOW_HEADER]).toBeUndefined()
  })
})

describe('privateNetworkHeaders', () => {
  it('answers a preflight that asked for private-network access', () => {
    expect(privateNetworkHeaders('true')).toEqual({ [PRIVATE_NETWORK_ALLOW_HEADER]: 'true' })
  })

  it.each([
    ['nothing asked', undefined],
    ['an explicit false', 'false'],
    ['a truthy-looking string that is not the spec value', 'TRUE'],
    ['an empty value', ''],
  ])('sends nothing for %s', (_label, requested) => {
    expect(privateNetworkHeaders(requested as string | undefined)).toEqual({})
  })
})

describe('isAllowedHost (DNS-rebinding guard)', () => {
  it('accepts loopback names, with or without our port', () => {
    expect(isAllowedHost('127.0.0.1:7321', 7321)).toBe(true)
    expect(isAllowedHost('localhost:7321', 7321)).toBe(true)
    expect(isAllowedHost('[::1]:7321', 7321)).toBe(true)
    expect(isAllowedHost('127.0.0.1', 7321)).toBe(true)
  })

  it('accepts a request with no Host header (HTTP/1.0 client, not a browser)', () => {
    expect(isAllowedHost(undefined, 7321)).toBe(true)
  })

  it('rejects a rebound hostname pointed at our loopback socket', () => {
    expect(isAllowedHost('evil.test:7321', 7321)).toBe(false)
    expect(isAllowedHost('localhost.evil.test:7321', 7321)).toBe(false)
  })

  it('rejects a loopback name on a port we did not bind', () => {
    expect(isAllowedHost('127.0.0.1:9999', 7321)).toBe(false)
  })

  it('rejects a malformed authority', () => {
    expect(isAllowedHost('localhost:notaport', 7321)).toBe(false)
    expect(isAllowedHost('[::1', 7321)).toBe(false)
  })
})
