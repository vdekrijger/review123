/**
 * src/lib/skills/standingRules.ts — the standing-rules distillation: routing,
 * the LLM call, and the pipeline the settings section drives.
 *
 * WHERE IT RUNS IS A PRIVACY DECISION, not a performance one. The corpus is
 * the user's own review history — their comments, their dismissals, their
 * unsent drafts. When a local bridge is paired that can run inference, the
 * distillation goes through it (`claude -p` on their own machine) and the
 * corpus never leaves. Only without a bridge does it go to the configured API
 * provider, and the UI SAYS WHICH HAPPENED every time. The seam matters more
 * than today's feature: the parked MCP/Slack idea would feed team-private
 * content into this same pipeline.
 *
 * A bridge that fails does NOT silently become a billed API call — the same
 * rule llm.ts's bridge transport enforces. The user chose local; quietly
 * spending their money, and their privacy, on a fallback they did not pick is
 * exactly the drift this feature is built to avoid. The error says the bridge
 * failed and offers the choice explicitly.
 */

import type { llmJsonWithRepairFor as LlmJsonForFn, ProviderConfig } from '../llm/llm'
import type { LlmModelDef } from '../llm/providers'
import { getProvider, getModelDef } from '../llm/providers'
import { activeLlmConfig, providerCredential } from '../llm/config'
import { bridgeInferenceClis, bridgeCredentials, bridgeAvailable } from '../bridge/bridge.svelte'
import { BRIDGE_CLIS, type BridgeCli } from '../bridge/protocol'
import { standingRulesPrompt } from '../ai/tasks'
import { validateStandingRules, salvageStandingRules, type StandingRulesResult, type StandingRule } from '../ai/schemas'
import type { StandingRulesCorpus } from './standingRulesCorpus'
import type { DistillSource } from './standingRulesStore'

// ---------------------------------------------------------------------------
// Route decision — a pure function over a snapshot, so both paths are testable
// without a bridge, a key, or a network.
// ---------------------------------------------------------------------------

export interface RouteSnapshot {
  /** Inference CLIs the paired bridge advertises. Empty when none is paired. */
  bridgeClis: readonly string[]
  /** The bridge pairing token — the bridge's credential. Null when unpaired. */
  bridgeToken: string | null
  /** Display name of the configured API provider (the fallback). */
  apiDisplayName: string
  /** Whether that provider has a key saved. */
  apiHasKey: boolean
}

export type RouteDecision =
  | { ok: true; source: 'bridge'; cli: BridgeCli; label: string }
  | { ok: true; source: 'api'; label: string }
  | { ok: false; error: string }

function isBridgeCli(id: string): id is BridgeCli {
  return (BRIDGE_CLIS as readonly string[]).includes(id)
}

/**
 * Which CLI to distil with. `claude` first when both are present — the same
 * order the fix loop uses, for the same reason: it is the CLI whose
 * invocation this repo has actually verified end to end.
 */
export function preferredDistillCli(clis: readonly string[]): BridgeCli | null {
  if (clis.includes('claude')) return 'claude'
  if (clis.includes('codex')) return 'codex'
  const other = clis.find(isBridgeCli)
  return other ?? null
}

const CLI_LABELS: Record<BridgeCli, string> = {
  claude: 'Claude Code on this machine',
  codex: 'Codex CLI on this machine',
}

/**
 * LOCAL FIRST, always, when it is available. The API provider is the fallback,
 * never the preference — and never a silent one.
 */
export function decideDistillRoute(snapshot: RouteSnapshot): RouteDecision {
  const cli = snapshot.bridgeToken ? preferredDistillCli(snapshot.bridgeClis) : null
  if (cli) return { ok: true, source: 'bridge', cli, label: CLI_LABELS[cli] }
  if (snapshot.apiHasKey) return { ok: true, source: 'api', label: snapshot.apiDisplayName }
  return {
    ok: false,
    error:
      'No local bridge is paired and no AI provider key is configured. Pair a bridge under Local bridge to keep this on your machine, or add a key under AI models.',
  }
}

/** The live snapshot: what is actually paired and configured right now. */
export function currentRouteSnapshot(): RouteSnapshot {
  const { provider } = activeLlmConfig()
  const paired = bridgeCredentials()
  return {
    bridgeClis: bridgeAvailable('infer') ? bridgeInferenceClis() : [],
    bridgeToken: paired?.token ?? null,
    apiDisplayName: provider.displayName,
    apiHasKey: providerCredential(provider.id) !== null,
  }
}

export interface DistillRoute {
  source: DistillSource
  label: string
  cfg: ProviderConfig
}

/**
 * Turn a decision into the transport config that carries it out.
 *
 * The bridge's ProviderConfig is the same shape as any vendor's: its "model"
 * is the CLI id and its "key" is the pairing token (lib/llm/config.ts's
 * `providerCredential` already treats the token as the bridge's credential).
 */
export type BuiltRoute = { ok: true; route: DistillRoute } | { ok: false; error: string }

export function buildDistillRoute(decision: RouteDecision): BuiltRoute {
  if (!decision.ok) return decision

  if (decision.source === 'bridge') {
    const bridge = getProvider('bridge')
    const model = bridge ? getModelDef(bridge, decision.cli) : undefined
    const token = bridgeCredentials()?.token
    if (!bridge || !model || !token) {
      return { ok: false, error: 'The local bridge is no longer paired. Re-pair it under Local bridge, or pick an AI provider.' }
    }
    return { ok: true, route: { source: 'bridge', label: decision.label, cfg: { providerId: 'bridge', model, key: token } } }
  }

  const { provider, model } = activeLlmConfig()
  const key = providerCredential(provider.id)
  if (!key) {
    return { ok: false, error: `Add an API key for ${provider.displayName} under AI models to run this.` }
  }
  return {
    ok: true,
    route: { source: 'api', label: decision.label, cfg: { providerId: provider.id, model: model as LlmModelDef, key } },
  }
}

/** Decide + build in one step, against live state. */
export function currentDistillRoute(): BuiltRoute {
  return buildDistillRoute(decideDistillRoute(currentRouteSnapshot()))
}

// ---------------------------------------------------------------------------
// The distillation call
// ---------------------------------------------------------------------------

/**
 * Strict first, salvage second — passed as the transport's validator so the
 * salvage applies on every parse, including the repair pass (the
 * `shapeIntentCheck` idiom from run.svelte.ts).
 */
export function shapeStandingRules(x: unknown): StandingRulesResult | null {
  return validateStandingRules(x) ?? salvageStandingRules(x)
}

/**
 * Output budget. The distillation returns at most 12 short rules with a
 * handful of excerpts each — but reasoning models spend hidden tokens first,
 * so the cap is generous rather than tight (the llmTestConnection lesson).
 */
const DISTILL_MAX_TOKENS = 8_192

/**
 * Per-request window. A local CLI over a large corpus is minutes, not seconds;
 * the 60s default would kill every bridge run before it finished.
 */
const DISTILL_TIMEOUT_MS = 300_000

export interface DistillDeps {
  llmJsonWithRepairFor: typeof LlmJsonForFn
}

export type DistillOutcome =
  | { ok: true; rules: StandingRule[]; source: DistillSource; sourceLabel: string }
  | { ok: false; error: string; source: DistillSource; sourceLabel: string }

/**
 * Run ONE distillation over the corpus through the given route.
 *
 * Never falls back: if the bridge route fails, the caller is told the bridge
 * failed. Switching to a metered provider is the user's call to make.
 */
export async function distillStandingRules(
  corpus: StandingRulesCorpus,
  route: DistillRoute,
  deps: DistillDeps,
  signal?: AbortSignal,
): Promise<DistillOutcome> {
  const { system, user } = standingRulesPrompt(corpus)
  try {
    const { result } = await deps.llmJsonWithRepairFor<StandingRulesResult>(
      route.cfg,
      {
        system,
        user,
        json: true,
        maxTokens: DISTILL_MAX_TOKENS,
        timeoutMs: DISTILL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
      shapeStandingRules,
    )
    return { ok: true, rules: result.rules, source: route.source, sourceLabel: route.label }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'The distillation failed.'
    return {
      ok: false,
      source: route.source,
      sourceLabel: route.label,
      error:
        route.source === 'bridge'
          ? `${detail} The distillation ran on your machine and did not fall back to a paid provider — switch to one under AI models if you want to run it there.`
          : detail,
    }
  }
}
