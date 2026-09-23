/**
 * src/lib/eval/bridgeAgentic.ts — the honesty layer between the eval harness and
 * the bridge's agentic (`InferRequest.agentic`) inference.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN run-eval.mts
 *
 * `agentic` is an ADDITIVE request field. A bridge older than 0.3.0 does not
 * reject it — it ignores it and answers `200` with a perfectly good tool-less
 * single-pass review. So the one failure mode that matters here is silent: ask
 * for a grounded deep review, get an ungrounded one, and publish it as a
 * measurement of grounding. Nothing errors. Nothing looks wrong. The number is
 * simply about a feature that never ran.
 *
 * Two independent checks close that hole, and BOTH are needed:
 *
 *   1. BEFORE the run — `gateAgentic` reads `capabilities.inferAgentic` from
 *      `/v1/health`. Absent or false and the harness refuses to claim a
 *      deep/grounded measurement rather than producing one it cannot back.
 *   2. AFTER every call — `observeAgentic` counts how many responses actually
 *      carried an `InferAgentic` report. The capability says the bridge
 *      understands the flag; only the report says THIS call used tools.
 *
 * Check 1 without check 2 trusts a request. Check 2 without check 1 cannot tell
 * "no report because the bridge is old" from "no report because the model chose
 * not to look". The harness does both and prints both.
 */

/**
 * The bridge's own default budget for an agentic call — `claude` reading,
 * grepping and turning again on what it found is not one model turn.
 *
 * Mirrored from `bridge/src/protocol.ts` (DEFAULT_AGENTIC_INFER_TIMEOUT_MS)
 * rather than imported: `src/` does not depend on the bridge package, and a
 * harness that under-budgets an agentic call measures timeouts, not grounding.
 */
export const AGENTIC_INFER_TIMEOUT_MS = 300_000

/** The bridge's ceiling on `InferRequest.timeoutMs`. Larger values are clamped. */
export const MAX_INFER_TIMEOUT_MS = 600_000

/**
 * The per-call budget to send for a run.
 *
 * An agentic call is never given LESS than the bridge's agentic default, even
 * when the tool-less default (or `BRIDGE_TIMEOUT_MS`) is smaller — a harness
 * that quietly kept a 240 s budget for a 300 s job would report the feature as
 * failing when what failed was the budget. An explicitly larger request is
 * honoured up to the bridge's own ceiling.
 */
export function inferTimeoutMs(baseMs: number, agentic: boolean): number {
  const wanted = agentic ? Math.max(baseMs, AGENTIC_INFER_TIMEOUT_MS) : baseMs
  return Math.min(wanted, MAX_INFER_TIMEOUT_MS)
}

/** What a run asked for that needs tools, in the words the report will use. */
export interface AgenticWants {
  /** `--deep`: the GENERATOR is told to verify its claims with repo tools (#82). */
  deep: boolean
  /** `--grounded`: the VERIFIER panel is told to look things up (#229). */
  grounded: boolean
}

export interface AgenticGate {
  /** Put `agentic: true` on the generator's `/v1/infer` bodies. */
  generator: boolean
  /** Put `agentic: true` on each verifier's `/v1/infer` bodies. */
  verifier: boolean
  /**
   * True when the run asked for a tool-dependent feature this transport cannot
   * provide. The caller must ABORT rather than downgrade silently: a run that
   * quietly drops `--deep` produces a number labelled "deep" about a tool-less
   * pass, which is the exact mislabelling this module exists to prevent.
   */
  refuse: boolean
  /** One line, printed next to every number the run produces. */
  reason: string
}

/**
 * Decide, before any inference is paid for, whether this run may claim tools.
 *
 * `capabilityKnown === false` means the health document had no `inferAgentic`
 * key at all — a pre-0.3.0 bridge. That is reported differently from an
 * explicit `false`, because the two are different facts about the world and a
 * reader chasing "why was my run refused" needs to know which one they hit.
 */
export function gateAgentic(opts: {
  wants: AgenticWants
  /** The transport is the local bridge (the only one that can run tools here). */
  isBridge: boolean
  /** `capabilities.inferAgentic === true`. */
  capable: boolean
  /** The health document carried an `inferAgentic` key at all. */
  capabilityKnown: boolean
}): AgenticGate {
  const { wants, isBridge, capable, capabilityKnown } = opts
  const asked = wants.deep || wants.grounded
  const asks = [wants.deep ? '--deep' : null, wants.grounded ? '--grounded' : null].filter(Boolean).join(' + ')

  if (!asked) {
    return {
      generator: false,
      verifier: false,
      refuse: false,
      reason: 'tool-less: neither --deep nor --grounded was requested, so no run claims grounding.',
    }
  }

  if (!isBridge) {
    return {
      generator: false,
      verifier: false,
      refuse: true,
      reason:
        `${asks} needs repo tools, and this transport is an OpenAI-compatible API key, ` +
        'which reaches a model but not the working tree. Use the local bridge.',
    }
  }

  if (!capable) {
    return {
      generator: false,
      verifier: false,
      refuse: true,
      reason: capabilityKnown
        ? `${asks} needs repo tools, and this bridge reports capabilities.inferAgentic = false.`
        : `${asks} needs repo tools, and this bridge predates them: /v1/health has no ` +
          'inferAgentic key (bridge < 0.3.0). It would IGNORE the agentic flag and answer ' +
          '200 with an ordinary tool-less review, which is why this is refused rather than sent.',
    }
  }

  return {
    generator: wants.deep,
    verifier: wants.grounded,
    refuse: false,
    reason:
      `agentic ON (capabilities.inferAgentic = true) for ${asks} — ` +
      `generator ${wants.deep ? 'WITH' : 'without'} tools, ` +
      `verifiers ${wants.grounded ? 'WITH' : 'without'} tools.`,
  }
}

/** `InferResponse.agentic` — present ONLY when the run really used tools. */
export interface AgenticReport {
  tools: string[]
  toolCallsAtLeast?: number
  denied?: number
}

/** One recorded `/v1/infer` call: what was asked for, and what came back. */
export interface AgenticCall {
  /** Which side of the pipeline made it. */
  role: 'generator' | 'verifier'
  /** The CLI it was sent to. */
  cli: string
  /** `agentic: true` was on the request body. */
  requested: boolean
  /** The response's `agentic` report, or undefined when the run was not agentic. */
  report?: AgenticReport
}

export interface AgenticObservation {
  /** Calls the harness asked to be agentic. */
  requested: number
  /** Calls that came back with an `InferAgentic` report — the honest count. */
  honoured: number
  /**
   * Calls that asked for tools and got NO report back. Non-zero means the
   * bridge answered a tool-less completion to an agentic request — the silent
   * downgrade. Any value above zero invalidates a "grounded" label.
   */
  silentlyToolLess: number
  /** Summed `toolCallsAtLeast` — a LOWER BOUND, never an exact count. */
  toolCallsAtLeast: number
  /** Calls whose report carried a `toolCallsAtLeast` at all. */
  countedCalls: number
  /** Reports whose `toolCallsAtLeast` was exactly 0 — tools granted, none used. */
  toolsUnused: number
  /** Summed tool calls the CLI's own permission layer refused. */
  denied: number
  /** Every distinct tool name granted, sorted. Empty for codex, which cannot enumerate. */
  tools: string[]
  /** Per-role breakdown, so "the verifier never looked" is visible separately. */
  byRole: Record<'generator' | 'verifier', { requested: number; honoured: number; toolCallsAtLeast: number }>
}

/**
 * Fold the recorded calls into the numbers a measurement is allowed to quote.
 *
 * `toolCallsAtLeast` is summed, never averaged into an "exact" figure: each CLI
 * reports a different under-count (claude `num_turns - 1`, codex its
 * `command_execution` count), so the sum is a floor on a floor. It is reported
 * as such everywhere it appears.
 */
export function observeAgentic(calls: readonly AgenticCall[]): AgenticObservation {
  const obs: AgenticObservation = {
    requested: 0,
    honoured: 0,
    silentlyToolLess: 0,
    toolCallsAtLeast: 0,
    countedCalls: 0,
    toolsUnused: 0,
    denied: 0,
    tools: [],
    byRole: {
      generator: { requested: 0, honoured: 0, toolCallsAtLeast: 0 },
      verifier: { requested: 0, honoured: 0, toolCallsAtLeast: 0 },
    },
  }
  const tools = new Set<string>()
  for (const call of calls) {
    if (!call.requested) continue
    obs.requested++
    obs.byRole[call.role].requested++
    if (!call.report) {
      obs.silentlyToolLess++
      continue
    }
    obs.honoured++
    obs.byRole[call.role].honoured++
    for (const t of call.report.tools) tools.add(t)
    const n = call.report.toolCallsAtLeast
    if (typeof n === 'number') {
      obs.countedCalls++
      obs.toolCallsAtLeast += n
      obs.byRole[call.role].toolCallsAtLeast += n
      if (n === 0) obs.toolsUnused++
    }
    if (typeof call.report.denied === 'number') obs.denied += call.report.denied
  }
  obs.tools = [...tools].sort()
  return obs
}

/**
 * The sentence a measurement may print about its own grounding, and whether the
 * "grounded" label is earned at all.
 *
 * `earned` is false the moment ANY agentic request came back without a report:
 * a run that was 90% grounded is not a measurement of grounding, it is a
 * measurement of a mixture, and saying so is cheaper than discovering it later.
 */
export function agenticVerdict(obs: AgenticObservation): { earned: boolean; line: string } {
  if (obs.requested === 0) {
    return { earned: false, line: 'No agentic calls were requested — nothing here measures grounding.' }
  }
  if (obs.honoured === 0) {
    return {
      earned: false,
      line:
        `All ${obs.requested} agentic requests came back WITHOUT an agentic report. The bridge ` +
        'answered tool-less completions; no number from this run describes grounding.',
    }
  }
  if (obs.silentlyToolLess > 0) {
    return {
      earned: false,
      line:
        `${obs.honoured}/${obs.requested} agentic requests were honoured — ` +
        `${obs.silentlyToolLess} came back tool-less. This run is a MIXTURE and must not be ` +
        'labelled grounded.',
    }
  }
  const unused =
    obs.toolsUnused > 0
      ? ` ${obs.toolsUnused} of them used no tool at all (a real answer: tools were there and the model declined).`
      : ''
  return {
    earned: true,
    line:
      `${obs.honoured}/${obs.requested} agentic requests honoured, ` +
      `>=${obs.toolCallsAtLeast} tool calls across ${obs.countedCalls} reporting calls ` +
      `(a LOWER bound — both CLIs under-count), ${obs.denied} denied by the CLI's own ` +
      `permission layer. Tools granted: ${obs.tools.length ? obs.tools.join(', ') : '(codex: not enumerable)'}.` +
      unused,
  }
}
