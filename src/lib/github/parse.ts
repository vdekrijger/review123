export interface PrRef { owner: string; repo: string; number: number }
export type ParseError = 'empty' | 'not-github' | 'not-a-pr-url'
export type ParseResult = { ok: true; value: PrRef } | { ok: false; error: ParseError }

// GitHub owner/repo segment: word chars, hyphens, dots
const SEGMENT = /^[A-Za-z0-9_.-]+$/

export function parsePrUrl(input: string | null | undefined): ParseResult {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, error: 'empty' }
  const raw = input.trim()
  if (raw.length > 2048) return { ok: false, error: 'not-a-pr-url' }
  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: 'not-a-pr-url' }
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
    return { ok: false, error: 'not-github' }
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/)
  if (!m) return { ok: false, error: 'not-a-pr-url' }
  const [, owner, repo, num] = m
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return { ok: false, error: 'not-a-pr-url' }
  const number = Number(num)
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false, error: 'not-a-pr-url' }
  return { ok: true, value: { owner, repo, number } }
}
