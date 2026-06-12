/**
 * src/lib/provider/registry.ts — provider registry for Review 1-2-3.
 */

import { githubProvider } from './github'
import { gitlabProvider } from './gitlab'
import type { ReviewProvider, PrRefX } from './types'

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PROVIDERS: Map<string, ReviewProvider> = new Map([
  ['github', githubProvider],
  ['gitlab', gitlabProvider],
])

/**
 * Look up a provider by its id string.
 * Throws if the provider is not found — callers should always use a valid id.
 */
export function providerFor(id: string): ReviewProvider {
  const provider = PROVIDERS.get(id)
  if (!provider) {
    throw new Error(`Unknown provider: "${id}". Known providers: ${[...PROVIDERS.keys()].join(', ')}`)
  }
  return provider
}

/**
 * Try to parse a URL or short-form PR reference using all registered providers.
 * Returns the matching provider and a fully-qualified PrRefX, or null when no
 * provider recognises the input.
 */
export function parseAnyUrl(input: string): { provider: ReviewProvider; ref: PrRefX } | null {
  for (const provider of PROVIDERS.values()) {
    const result = provider.parseUrl(input)
    if (result.ok) {
      return { provider, ref: result.value }
    }
  }
  return null
}
