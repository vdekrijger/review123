/**
 * PKCE (Proof Key for Code Exchange) helpers — RFC 7636.
 * Uses WebCrypto (available in all modern browsers and Node 19+/jsdom).
 */

/** URL-safe characters for the verifier (unreserved chars per RFC 3986) */
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/**
 * Generate a cryptographically random code verifier.
 * Length: 43–128 URL-safe characters (RFC 7636 §4.1).
 */
export function generateVerifier(): string {
  // 96 bytes → 96 chars (all within 0-63 range after modulo CHARS.length=66)
  // We use exactly 96 bytes → string length 96 (within 43-128)
  const bytes = new Uint8Array(96)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join('')
}

/**
 * Compute the S256 code challenge from a verifier.
 * challenge = base64url(SHA-256(ASCII(verifier)))
 */
export async function challengeFromVerifier(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64url(new Uint8Array(digest))
}

/** Encode a Uint8Array as base64url (no padding). */
function base64url(bytes: Uint8Array): string {
  // Convert to base64 via btoa then make it URL-safe
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
