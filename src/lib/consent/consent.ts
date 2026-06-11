const STORAGE_KEY = 'review123:ai-consent'

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function loadConsented(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[]
    }
    return []
  } catch {
    // Corrupt JSON → treat as empty (EC-11e fail-safe)
    return []
  }
}

function saveConsented(repos: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(repos))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function hasConsent(repo: string): boolean {
  return loadConsented().includes(repo)
}

export function grantConsent(repo: string): void {
  const repos = loadConsented()
  if (!repos.includes(repo)) {
    repos.push(repo)
    saveConsented(repos)
  }
}

export function revokeAll(): void {
  localStorage.removeItem(STORAGE_KEY)
}

// ---------------------------------------------------------------------------
// In-flight ask de-duplication (EC-11g)
// Concurrent gateAi calls for the same repo share a single ask() invocation.
// After the promise resolves (true or false), the map entry is cleared so that
// a subsequent call (e.g. after a page reload clears storage) may ask again —
// that is the correct fail-safe behaviour (EC-11e).
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<boolean>>()

export async function gateAi(opts: {
  repo: string
  isPrivate: boolean | undefined
  ask: () => Promise<boolean>
}): Promise<boolean> {
  const { repo, isPrivate, ask } = opts

  // Public repos: always allow, never call ask (EC-11a)
  if (isPrivate === false) {
    return true
  }

  // Private or undefined visibility (EC-11f fail-safe): check persisted consent
  if (hasConsent(repo)) {
    return true
  }

  // Deduplicate concurrent asks for the same repo (EC-11g)
  const existing = inFlight.get(repo)
  if (existing) {
    return existing
  }

  const promise = (async () => {
    try {
      const accepted = await ask()
      if (accepted) {
        grantConsent(repo)
        return true
      }
      // Decline is NOT persisted (EC-11c/EC-11e): next call will ask again
      return false
    } finally {
      // Remove from map so future calls can ask again after decline (EC-11e)
      inFlight.delete(repo)
    }
  })()

  inFlight.set(repo, promise)
  return promise
}
