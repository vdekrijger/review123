/**
 * balance.ts — capability-gated "credits remaining" readout for BYO-key
 * providers that expose a key-level balance endpoint.
 *
 * Reality (verified June 2026):
 *   - DeepSeek SUPPORTS it: GET https://api.deepseek.com/user/balance with
 *     `Authorization: Bearer <key>` returns
 *       { is_available, balance_infos: [{ currency, total_balance,
 *         granted_balance, topped_up_balance }] }
 *     Amounts are STRINGS. We call it DIRECT from the browser (no proxy):
 *     DeepSeek's chat endpoint is already called direct in llm.ts (same origin,
 *     same permissive CORS), so /user/balance is reachable the same way.
 *   - OpenAI / Anthropic / Gemini do NOT expose a key-level balance endpoint,
 *     so providerSupportsBalance() returns false for them and the UI shows
 *     NOTHING — no row, no error. The capability gate is the whole mechanism.
 *
 * Design: provider-agnostic in shape. Adding e.g. OpenRouter later
 * (GET /api/v1/credits) is just another branch in fetchProviderBalance plus the
 * gate returning true for it — no UI change beyond the gate.
 *
 * Graceful degradation is a HARD requirement: fetchProviderBalance NEVER throws.
 * Any failure (unsupported provider, missing key, network/CORS, HTTP error,
 * is_available:false, malformed JSON, unexpected shape) resolves to null so a
 * missing balance can never break Settings.
 */

import type { LlmProviderId } from './providers'

/** A parsed, display-ready balance for one provider. */
export interface ProviderBalance {
  /** ISO currency code, e.g. 'USD'. */
  currency: string
  /** Total spendable balance. */
  total: number
  /** Promotional / granted credit, when the provider reports it. */
  granted?: number
  /** User-topped-up balance, when the provider reports it. */
  toppedUp?: number
}

/**
 * Providers that expose a balance to a NORMAL API key. A Set keeps the gate
 * extensible and cheap — add 'openrouter' here (and a branch below) when wired.
 * Documented as the single source of truth the UI consults.
 */
const BALANCE_CAPABLE: ReadonlySet<LlmProviderId> = new Set<LlmProviderId>(['deepseek', 'openrouter'])

/**
 * True only for providers that expose a key-level balance endpoint. The UI gates
 * the whole credits readout on this, so unsupported providers render nothing.
 */
export function providerSupportsBalance(id: LlmProviderId): boolean {
  return BALANCE_CAPABLE.has(id)
}

/** Coerce a provider amount (string or number) to a finite number, else null. */
function toAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Shape of one DeepSeek balance_infos entry (all amounts are strings). */
interface DeepSeekBalanceInfo {
  currency?: unknown
  total_balance?: unknown
  granted_balance?: unknown
  topped_up_balance?: unknown
}

/**
 * Parse DeepSeek's /user/balance payload into a ProviderBalance, or null when
 * the shape is unusable / unavailable. Defensive on every field (the payload is
 * untrusted at runtime), mirroring the repo's other validators.
 */
function parseDeepSeekBalance(data: unknown): ProviderBalance | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as { is_available?: unknown; balance_infos?: unknown }
  // is_available:false → the key has no usable balance; treat as "nothing".
  if (obj.is_available !== true) return null
  const infos = obj.balance_infos
  if (!Array.isArray(infos) || infos.length === 0) return null

  // Prefer the USD entry; else the first entry.
  const usd = infos.find(
    (e): e is DeepSeekBalanceInfo =>
      !!e && typeof e === 'object' && (e as DeepSeekBalanceInfo).currency === 'USD',
  )
  const entry = (usd ?? infos[0]) as DeepSeekBalanceInfo
  if (!entry || typeof entry !== 'object') return null

  const total = toAmount(entry.total_balance)
  if (total === null) return null
  const currency = typeof entry.currency === 'string' && entry.currency ? entry.currency : 'USD'

  const granted = toAmount(entry.granted_balance)
  const toppedUp = toAmount(entry.topped_up_balance)

  const result: ProviderBalance = { currency, total }
  if (granted !== null) result.granted = granted
  if (toppedUp !== null) result.toppedUp = toppedUp
  return result
}

/**
 * Parse OpenRouter's GET /api/v1/credits payload into a ProviderBalance, or null
 * when unusable. Response shape:
 *   { data: { total_credits: number, total_usage: number } }  (both USD)
 * Remaining = total_credits - total_usage. Defensive on every field (untrusted
 * at runtime), mirroring parseDeepSeekBalance.
 */
function parseOpenRouterBalance(data: unknown): ProviderBalance | null {
  if (!data || typeof data !== 'object') return null
  const inner = (data as { data?: unknown }).data
  if (!inner || typeof inner !== 'object') return null
  const obj = inner as { total_credits?: unknown; total_usage?: unknown }
  const totalCredits = toAmount(obj.total_credits)
  const totalUsage = toAmount(obj.total_usage)
  if (totalCredits === null || totalUsage === null) return null
  return { currency: 'USD', total: totalCredits - totalUsage }
}

/**
 * Fetch a provider's remaining balance. Returns null — never throws — when the
 * provider is unsupported, the key is missing/empty, the provider reports no
 * available balance, or ANY error occurs (network/CORS/auth/HTTP/parse). The
 * caller treats null as "show nothing", so a failed fetch degrades silently.
 *
 * @param id  provider id
 * @param key the provider's API key (read by the caller from settings)
 */
export async function fetchProviderBalance(
  id: LlmProviderId,
  key: string,
): Promise<ProviderBalance | null> {
  if (!providerSupportsBalance(id)) return null
  if (!key || !key.trim()) return null

  if (id === 'deepseek') {
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        // Bound the wait so a hung request can't leave the UI spinning forever.
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return null
      const data: unknown = await res.json()
      return parseDeepSeekBalance(data)
    } catch {
      // network / CORS / abort / non-JSON body — degrade to "nothing".
      return null
    }
  }

  if (id === 'openrouter') {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/credits', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return null
      const data: unknown = await res.json()
      return parseOpenRouterBalance(data)
    } catch {
      // network / CORS / abort / non-JSON body — degrade to "nothing".
      return null
    }
  }

  // Capable per the gate but not yet wired (future providers) — be safe.
  return null
}

/**
 * Format a ProviderBalance for the muted credits line, e.g. "$110.00" for USD
 * or "110.00 EUR" for other currencies. Two decimals; USD leads with the $.
 */
export function formatBalance(balance: ProviderBalance): string {
  const amount = balance.total.toFixed(2)
  return balance.currency === 'USD' ? `$${amount}` : `${amount} ${balance.currency}`
}
