import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hasConsent, grantConsent, revokeAll, gateAi } from './consent'

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  // Clear any in-flight ask promises by forcing module re-evaluation isn't
  // practical in ESM — instead tests are written to not leak in-flight state
  // across cases (each uses unique repo names or waits for resolution).
})

// ---------------------------------------------------------------------------
// hasConsent / grantConsent / revokeAll
// ---------------------------------------------------------------------------

describe('hasConsent / grantConsent / revokeAll', () => {
  it('returns false when nothing stored', () => {
    expect(hasConsent('owner/repo')).toBe(false)
  })

  it('returns true after grantConsent', () => {
    grantConsent('owner/repo')
    expect(hasConsent('owner/repo')).toBe(true)
  })

  it('grantConsent is idempotent (no duplicate entries)', () => {
    grantConsent('owner/repo')
    grantConsent('owner/repo')
    const raw = localStorage.getItem('review123:ai-consent')
    expect(JSON.parse(raw!)).toHaveLength(1)
  })

  it('revokeAll removes all consents', () => {
    grantConsent('owner/a')
    grantConsent('owner/b')
    revokeAll()
    expect(hasConsent('owner/a')).toBe(false)
    expect(hasConsent('owner/b')).toBe(false)
  })

  it('corrupt storage treated as empty (EC-11e fail-safe)', () => {
    localStorage.setItem('review123:ai-consent', '{not json')
    expect(hasConsent('owner/repo')).toBe(false)
  })

  it('storage with wrong shape (non-array) treated as empty', () => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ owner: 'repo' }))
    expect(hasConsent('owner/repo')).toBe(false)
  })

  it('storage with non-string array items treated as empty', () => {
    localStorage.setItem('review123:ai-consent', JSON.stringify([1, 2, 3]))
    expect(hasConsent('owner/repo')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EC-11a: public repos → always true, ask never called
// ---------------------------------------------------------------------------

describe('gateAi — public repos (EC-11a)', () => {
  it('returns true immediately for public repo without calling ask', async () => {
    const ask = vi.fn()
    const result = await gateAi({ repo: 'owner/pub', isPrivate: false, ask })
    expect(result).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// EC-11b: ask not called until gate is invoked for private repo
// ---------------------------------------------------------------------------

describe('gateAi — ask not called until gate invoked (EC-11b)', () => {
  it('ask is never called before gateAi is invoked', () => {
    const ask = vi.fn().mockResolvedValue(true)
    // Just creating the function — not calling gateAi
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask is called only when gateAi is invoked for a private repo', async () => {
    const ask = vi.fn().mockResolvedValue(true)
    expect(ask).not.toHaveBeenCalled()
    await gateAi({ repo: 'owner/private-b2', isPrivate: true, ask })
    expect(ask).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// EC-11c: decline returns false, nothing persisted
// ---------------------------------------------------------------------------

describe('gateAi — decline (EC-11c)', () => {
  it('returns false when user declines', async () => {
    const ask = vi.fn().mockResolvedValue(false)
    const result = await gateAi({ repo: 'owner/private-c', isPrivate: true, ask })
    expect(result).toBe(false)
  })

  it('decline is not persisted (re-asks next session)', async () => {
    const ask = vi.fn().mockResolvedValue(false)
    await gateAi({ repo: 'owner/private-c2', isPrivate: true, ask })
    expect(hasConsent('owner/private-c2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EC-11d: grant persists, second call skips ask; different repo asks again
// ---------------------------------------------------------------------------

describe('gateAi — grant persists (EC-11d)', () => {
  it('returns true on grant', async () => {
    const ask = vi.fn().mockResolvedValue(true)
    const result = await gateAi({ repo: 'owner/private-d', isPrivate: true, ask })
    expect(result).toBe(true)
    expect(hasConsent('owner/private-d')).toBe(true)
  })

  it('second call for same repo does not call ask again', async () => {
    const ask = vi.fn().mockResolvedValue(true)
    await gateAi({ repo: 'owner/private-d2', isPrivate: true, ask })
    const ask2 = vi.fn().mockResolvedValue(true)
    const result = await gateAi({ repo: 'owner/private-d2', isPrivate: true, ask: ask2 })
    expect(result).toBe(true)
    expect(ask2).not.toHaveBeenCalled()
  })

  it('different repo calls ask again', async () => {
    grantConsent('owner/repo-alpha')
    const ask = vi.fn().mockResolvedValue(true)
    await gateAi({ repo: 'owner/repo-beta', isPrivate: true, ask })
    expect(ask).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// EC-11e: clear storage re-asks
// ---------------------------------------------------------------------------

describe('gateAi — re-asks after storage cleared (EC-11e)', () => {
  it('asks again after revokeAll clears the grant', async () => {
    const ask1 = vi.fn().mockResolvedValue(true)
    await gateAi({ repo: 'owner/private-e', isPrivate: true, ask: ask1 })
    expect(hasConsent('owner/private-e')).toBe(true)

    revokeAll()
    expect(hasConsent('owner/private-e')).toBe(false)

    const ask2 = vi.fn().mockResolvedValue(true)
    await gateAi({ repo: 'owner/private-e', isPrivate: true, ask: ask2 })
    expect(ask2).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// EC-11f: undefined visibility treated as private
// ---------------------------------------------------------------------------

describe('gateAi — undefined visibility treated private (EC-11f)', () => {
  it('calls ask when isPrivate is undefined', async () => {
    const ask = vi.fn().mockResolvedValue(false)
    const result = await gateAi({ repo: 'owner/private-f', isPrivate: undefined, ask })
    expect(ask).toHaveBeenCalledOnce()
    expect(result).toBe(false)
  })

  it('accepts consent when isPrivate is undefined and user agrees', async () => {
    const ask = vi.fn().mockResolvedValue(true)
    const result = await gateAi({ repo: 'owner/private-f2', isPrivate: undefined, ask })
    expect(result).toBe(true)
    expect(hasConsent('owner/private-f2')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// EC-11g: concurrent calls share ONE in-flight ask promise
// ---------------------------------------------------------------------------

describe('gateAi — concurrent calls share single ask (EC-11g)', () => {
  it('two parallel gateAi calls produce exactly one ask invocation', async () => {
    let resolveAsk!: (v: boolean) => void
    const askPromise = new Promise<boolean>((res) => { resolveAsk = res })
    const ask = vi.fn().mockReturnValue(askPromise)

    const p1 = gateAi({ repo: 'owner/private-g', isPrivate: true, ask })
    const p2 = gateAi({ repo: 'owner/private-g', isPrivate: true, ask })

    // ask should be called exactly once even though two gateAi calls are in flight
    expect(ask).toHaveBeenCalledOnce()

    resolveAsk(true)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    // ask is still only called once
    expect(ask).toHaveBeenCalledOnce()
    expect(hasConsent('owner/private-g')).toBe(true)
  })

  it('concurrent decline: ask called once, both callers get false', async () => {
    let resolveAsk!: (v: boolean) => void
    const askPromise = new Promise<boolean>((res) => { resolveAsk = res })
    const ask = vi.fn().mockReturnValue(askPromise)

    const p1 = gateAi({ repo: 'owner/private-g2', isPrivate: true, ask })
    const p2 = gateAi({ repo: 'owner/private-g2', isPrivate: true, ask })

    expect(ask).toHaveBeenCalledOnce()

    resolveAsk(false)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(false)
    expect(r2).toBe(false)
    expect(ask).toHaveBeenCalledOnce()
    // decline not persisted
    expect(hasConsent('owner/private-g2')).toBe(false)
  })

  it('after in-flight resolves false, a NEW gateAi call may ask again (EC-11e fail-safe)', async () => {
    const ask1 = vi.fn().mockResolvedValue(false)
    await gateAi({ repo: 'owner/private-g3', isPrivate: true, ask: ask1 })
    expect(ask1).toHaveBeenCalledOnce()

    // After the in-flight is done and declined, a new call should ask again
    const ask2 = vi.fn().mockResolvedValue(false)
    await gateAi({ repo: 'owner/private-g3', isPrivate: true, ask: ask2 })
    expect(ask2).toHaveBeenCalledOnce()
  })
})
