import { describe, it, expect } from 'vitest'
import { generateVerifier, challengeFromVerifier } from './pkce'

describe('pkce', () => {
  describe('generateVerifier', () => {
    it('produces a URL-safe string', () => {
      const v = generateVerifier()
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/)
    })

    it('length is 86 chars (64 bytes base64url-encoded)', () => {
      const v = generateVerifier()
      // 64 random bytes → base64url without padding → exactly 86 characters
      expect(v.length).toBe(86)
      // Also confirms it is within RFC 7636 §4.1 range (43–128)
      expect(v.length).toBeGreaterThanOrEqual(43)
      expect(v.length).toBeLessThanOrEqual(128)
    })

    it('produces different values each time', () => {
      const a = generateVerifier()
      const b = generateVerifier()
      expect(a).not.toBe(b)
    })
  })

  describe('challengeFromVerifier', () => {
    // RFC 7636 Appendix B test vector
    it('matches the RFC 7636 test vector', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
      const challenge = await challengeFromVerifier(verifier)
      expect(challenge).toBe(expected)
    })

    it('returns a URL-safe base64 string (no padding, no +, no /)', async () => {
      const v = generateVerifier()
      const c = await challengeFromVerifier(v)
      expect(c).toMatch(/^[A-Za-z0-9\-_]+$/)
      expect(c).not.toContain('=')
      expect(c).not.toContain('+')
      expect(c).not.toContain('/')
    })
  })
})
