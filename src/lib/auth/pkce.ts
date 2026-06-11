/**
 * PKCE (Proof Key for Code Exchange) helpers — RFC 7636.
 * Uses WebCrypto (available in all modern browsers and Node 19+/jsdom).
 */

/**
 * Generate a cryptographically random code verifier.
 * Encodes 64 random bytes as base64url → 86 URL-safe characters,
 * which is within the 43–128 range required by RFC 7636 §4.1.
 * Using base64url avoids modulo bias and produces a uniform distribution
 * over the RFC 3986 unreserved character set.
 */
export function generateVerifier(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
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
