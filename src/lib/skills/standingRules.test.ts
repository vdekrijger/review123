/**
 * standingRules.test.ts — routing and the distillation call.
 *
 * The routing tests exist for one reason: WHERE this runs is a privacy
 * decision. Local when a bridge can run it, API only as a stated fallback, and
 * a bridge failure NEVER silently becomes a billed API call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  decideDistillRoute,
  buildDistillRoute,
  currentDistillRoute,
  currentRouteSnapshot,
  preferredDistillCli,
  shapeStandingRules,
  distillStandingRules,
  type DistillRoute,
  type RouteSnapshot,
} from './standingRules'
import type { StandingRulesCorpus } from './standingRulesCorpus'
import { LlmError } from '../llm/llm'
import { setAiProvider, setDeepseekKey } from '../settings/settings'

/**
 * The bridge's live state is behind read-only reactive getters that only a
 * real `GET /v1/health` probe can set, so the two accessors this module
 * consults are faked here. It is a NARROW fake by design: it stands in for
 * "what is paired and reachable right now", which is precisely the input the
 * routing decision is about.
 */
const fakeBridge = { clis: [] as string[], inferReady: false, token: null as string | null }
vi.mock('../bridge/bridge.svelte', () => ({
  bridgeAvailable: (cap: string) => cap === 'infer' && fakeBridge.inferReady,
  bridgeInferenceClis: () => fakeBridge.clis,
  bridgeCredentials: () => (fakeBridge.token ? { token: fakeBridge.token, port: 7321 } : null),
}))

function pairBridge(clis: string[] = ['claude']): void {
  fakeBridge.clis = clis
  fakeBridge.inferReady = true
  fakeBridge.token = 'pair-tok'
}

const CORPUS: StandingRulesCorpus = {
  reviewComments: ['This belongs in the domain module.'],
  dismissals: [{ pattern: 'missing jsdoc', reason: 'not-worth' }],
  drafts: ['Pull this into a constant.'],
  acceptedFindings: [],
}

function snapshot(overrides: Partial<RouteSnapshot> = {}): RouteSnapshot {
  return { bridgeClis: [], bridgeToken: null, apiDisplayName: 'DeepSeek', apiHasKey: true, ...overrides }
}

beforeEach(() => {
  localStorage.clear()
  fakeBridge.clis = []
  fakeBridge.inferReady = false
  fakeBridge.token = null
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe('decideDistillRoute', () => {
  it('prefers the BRIDGE whenever one is paired that can infer — local first, always', () => {
    const decision = decideDistillRoute(snapshot({ bridgeClis: ['claude'], bridgeToken: 'tok' }))
    expect(decision).toEqual({ ok: true, source: 'bridge', cli: 'claude', label: 'Claude Code on this machine' })
  })

  it('prefers the bridge even when an API key is also configured', () => {
    const decision = decideDistillRoute(
      snapshot({ bridgeClis: ['codex'], bridgeToken: 'tok', apiHasKey: true }),
    )
    expect(decision.ok && decision.source).toBe('bridge')
  })

  it('falls back to the API provider when no bridge can infer — and names it', () => {
    const decision = decideDistillRoute(snapshot({ apiDisplayName: 'Anthropic' }))
    expect(decision).toEqual({ ok: true, source: 'api', label: 'Anthropic' })
  })

  it('does NOT use the bridge when it is paired but advertises no inference CLI', () => {
    const decision = decideDistillRoute(snapshot({ bridgeClis: [], bridgeToken: 'tok' }))
    expect(decision.ok && decision.source).toBe('api')
  })

  it('does NOT use the bridge when a CLI is advertised but no token is stored', () => {
    const decision = decideDistillRoute(snapshot({ bridgeClis: ['claude'], bridgeToken: null }))
    expect(decision.ok && decision.source).toBe('api')
  })

  it('refuses, with an actionable message, when neither route exists', () => {
    const decision = decideDistillRoute(snapshot({ apiHasKey: false }))
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('unreachable')
    expect(decision.error).toMatch(/No local bridge is paired/)
    expect(decision.error).toMatch(/Local bridge/)
    expect(decision.error).toMatch(/AI models/)
  })
})

describe('preferredDistillCli', () => {
  it('prefers claude over codex, and returns null when neither is present', () => {
    expect(preferredDistillCli(['codex', 'claude'])).toBe('claude')
    expect(preferredDistillCli(['codex'])).toBe('codex')
    expect(preferredDistillCli([])).toBeNull()
    expect(preferredDistillCli(['emacs'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Building the transport config
// ---------------------------------------------------------------------------

describe('buildDistillRoute', () => {
  it('builds a bridge config whose credential is the PAIRING TOKEN, not an API key', () => {
    pairBridge()
    const built = buildDistillRoute({ ok: true, source: 'bridge', cli: 'claude', label: 'Claude Code on this machine' })
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error('unreachable')
    expect(built.route.source).toBe('bridge')
    expect(built.route.cfg.providerId).toBe('bridge')
    expect(built.route.cfg.model.id).toBe('claude')
    expect(built.route.cfg.key).toBe('pair-tok')
  })

  it('uses the CODEX model definition when that is the chosen CLI', () => {
    pairBridge(['codex'])
    const built = buildDistillRoute({ ok: true, source: 'bridge', cli: 'codex', label: 'Codex CLI on this machine' })
    expect(built.ok && built.route.cfg.model.id).toBe('codex')
  })

  it('refuses a bridge route whose pairing vanished between decide and build', () => {
    const built = buildDistillRoute({ ok: true, source: 'bridge', cli: 'claude', label: 'x' })
    expect(built.ok).toBe(false)
    if (built.ok) throw new Error('unreachable')
    expect(built.error).toMatch(/no longer paired/)
  })

  it('builds an API config from the active provider and its saved key', () => {
    setAiProvider('deepseek')
    setDeepseekKey('sk-test-key')
    const built = buildDistillRoute({ ok: true, source: 'api', label: 'DeepSeek' })
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error('unreachable')
    expect(built.route.source).toBe('api')
    expect(built.route.cfg.providerId).toBe('deepseek')
    expect(built.route.cfg.key).toBe('sk-test-key')
  })

  it('refuses an API route with no key, naming the provider to fix', () => {
    setAiProvider('deepseek')
    const built = buildDistillRoute({ ok: true, source: 'api', label: 'DeepSeek' })
    expect(built.ok).toBe(false)
    if (built.ok) throw new Error('unreachable')
    expect(built.error).toMatch(/Add an API key for DeepSeek/)
  })

  it('passes a refusal straight through', () => {
    expect(buildDistillRoute({ ok: false, error: 'nope' })).toEqual({ ok: false, error: 'nope' })
  })
})

describe('currentRouteSnapshot / currentDistillRoute', () => {
  it('reports no bridge and the active API provider when nothing is paired', () => {
    setAiProvider('deepseek')
    setDeepseekKey('sk-test-key')
    const snap = currentRouteSnapshot()
    expect(snap.bridgeClis).toEqual([])
    expect(snap.bridgeToken).toBeNull()
    expect(snap.apiDisplayName).toBe('DeepSeek')
    expect(snap.apiHasKey).toBe(true)
    const built = currentDistillRoute()
    expect(built.ok && built.route.source).toBe('api')
  })

  it('routes to the bridge once one is paired AND advertising an inference CLI', () => {
    pairBridge()
    expect(currentRouteSnapshot().bridgeClis).toEqual(['claude'])
    const built = currentDistillRoute()
    expect(built.ok).toBe(true)
    if (!built.ok) throw new Error('unreachable')
    expect(built.route.source).toBe('bridge')
    expect(built.route.label).toBe('Claude Code on this machine')
  })
})

// ---------------------------------------------------------------------------
// The validator seam
// ---------------------------------------------------------------------------

describe('shapeStandingRules', () => {
  const ok = {
    rules: [{ rule: 'Alpha.', kind: 'do', occurrences: 2, evidence: [{ source: 'draft', excerpt: 'x' }] }],
  }

  it('takes the strict shape when it is valid', () => {
    expect(shapeStandingRules(ok)?.rules[0].rule).toBe('Alpha.')
  })

  it('falls through to the salvage when the strict validator rejects', () => {
    const garbled = { rules: [{ rule: 'Alpha.' }, { nope: true }] }
    const result = shapeStandingRules(garbled)
    expect(result?.rules).toHaveLength(1)
    expect(result?.rules[0].kind).toBe('do')
  })

  it('returns null when neither can make sense of it', () => {
    expect(shapeStandingRules({ rules: [null] })).toBeNull()
    expect(shapeStandingRules('nope')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The call itself — BOTH paths
// ---------------------------------------------------------------------------

describe('distillStandingRules', () => {
  const bridgeRoute: DistillRoute = {
    source: 'bridge',
    label: 'Claude Code on this machine',
    cfg: { providerId: 'bridge', model: { id: 'claude', label: 'Claude Code CLI', contextWindowTokens: 200_000 }, key: 'tok' },
  }
  const apiRoute: DistillRoute = {
    source: 'api',
    label: 'DeepSeek',
    cfg: { providerId: 'deepseek', model: { id: 'deepseek-chat', label: 'V3', contextWindowTokens: 64_000 }, key: 'sk' },
  }

  const goodResult = {
    rules: [{ rule: 'Alpha.', kind: 'do' as const, occurrences: 2, evidence: [{ source: 'draft' as const, excerpt: 'x' }] }],
  }

  it('runs through the BRIDGE and reports the local source', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => ({ result: goodResult }))
    const outcome = await distillStandingRules(CORPUS, bridgeRoute, {
      llmJsonWithRepairFor: llmJsonWithRepairFor as never,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.source).toBe('bridge')
    expect(outcome.sourceLabel).toBe('Claude Code on this machine')
    // It really went through the bridge config, not the active provider.
    expect(llmJsonWithRepairFor.mock.calls[0][0]).toEqual(bridgeRoute.cfg)
  })

  it('runs through the API provider and reports THAT source', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => ({ result: goodResult }))
    const outcome = await distillStandingRules(CORPUS, apiRoute, {
      llmJsonWithRepairFor: llmJsonWithRepairFor as never,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.source).toBe('api')
    expect(outcome.sourceLabel).toBe('DeepSeek')
    expect(llmJsonWithRepairFor.mock.calls[0][0]).toEqual(apiRoute.cfg)
  })

  it('sends the standing-rules prompt, in JSON mode, with a window long enough for a local CLI', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => ({ result: goodResult }))
    await distillStandingRules(CORPUS, bridgeRoute, { llmJsonWithRepairFor: llmJsonWithRepairFor as never })
    const opts = llmJsonWithRepairFor.mock.calls[0][1] as { system: string; user: string; json: boolean; timeoutMs: number }
    expect(opts.system).toContain("turning a reviewer's own past corrections into standing orders")
    expect(opts.json).toBe(true)
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(120_000)
    expect(JSON.parse(opts.user).reviewComments).toEqual(CORPUS.reviewComments)
  })

  it('passes the strict-then-salvage validator to the transport, so the repair pass salvages too', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => ({ result: goodResult }))
    await distillStandingRules(CORPUS, apiRoute, { llmJsonWithRepairFor: llmJsonWithRepairFor as never })
    const validate = llmJsonWithRepairFor.mock.calls[0][2] as (x: unknown) => unknown
    expect(validate({ rules: [{ rule: 'Only a sentence.' }] })).not.toBeNull()
  })

  it('a BRIDGE failure does NOT become a paid API call — it fails, and says so', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => {
      throw new LlmError('network', 'The local bridge is not responding.')
    })
    const outcome = await distillStandingRules(CORPUS, bridgeRoute, {
      llmJsonWithRepairFor: llmJsonWithRepairFor as never,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.source).toBe('bridge')
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.error).toContain('The local bridge is not responding.')
    expect(outcome.error).toMatch(/did not fall back to a paid provider/)
    // Exactly ONE attempt: no second call against another provider.
    expect(llmJsonWithRepairFor).toHaveBeenCalledTimes(1)
  })

  it('an API failure surfaces the provider error plainly, with no bridge wording', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => {
      throw new LlmError('rate-limited', 'Rate limited.')
    })
    const outcome = await distillStandingRules(CORPUS, apiRoute, {
      llmJsonWithRepairFor: llmJsonWithRepairFor as never,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.error).toBe('Rate limited.')
    expect(outcome.error).not.toMatch(/fall back/)
  })

  it('an EMPTY rules answer is carried through as a result, not an error', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => ({ result: { rules: [] } }))
    const outcome = await distillStandingRules(CORPUS, apiRoute, {
      llmJsonWithRepairFor: llmJsonWithRepairFor as never,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.rules).toEqual([])
  })

  it('forwards a caller abort signal so the run is cancellable', async () => {
    const llmJsonWithRepairFor = vi.fn(async (_cfg: unknown, _opts: unknown, _validate: unknown) => ({ result: goodResult }))
    const controller = new AbortController()
    await distillStandingRules(CORPUS, apiRoute, { llmJsonWithRepairFor: llmJsonWithRepairFor as never }, controller.signal)
    const opts = llmJsonWithRepairFor.mock.calls[0][1] as { signal?: AbortSignal }
    expect(opts.signal).toBe(controller.signal)
  })
})
