// Build-time provenance for the running bundle. The __BUILD_*__ globals are
// injected by Vite's `define` (see vite.config.ts). Under vitest the test
// config provides no such define, so we guard each global with a typeof check
// and fall back to 'test' — keeping unit tests from blowing up on the
// undefined global.
export const BUILD_SHA: string =
  typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'test'

export const BUILD_TIME: string =
  typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'test'

const REPO = 'vdekrijger/review123'

/** Canonical GitHub repository URL (for the footer "view source" link). */
export const repoUrl = `https://github.com/${REPO}`

// Sentinel shas that don't correspond to a real commit (local dev with no git,
// or the vitest fallback). For those we render plain text instead of a link.
const NON_COMMIT_SHAS = new Set(['dev', 'test'])

/**
 * GitHub commit URL for a sha, or null when the sha is a non-commit sentinel.
 * GitHub resolves short (7-char) shas, so a short sha links fine.
 */
export function commitUrl(sha: string): string | null {
  if (NON_COMMIT_SHAS.has(sha)) return null
  return `https://github.com/${REPO}/commit/${sha}`
}
