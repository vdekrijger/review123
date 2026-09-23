/**
 * eval/run-eval.mts — CLI runner for the AI-review eval harness.
 *
 * Usage (via the `eval` pnpm script):
 *   pnpm eval                     # --mock (default): scripted stub, no network/key
 *   pnpm eval -- --live           # real inference (needs a key OR the local bridge)
 *   pnpm eval -- --live --deep    # exercise the agentic deep-review guidance too
 *   pnpm eval -- --case 01-real-bug          # one golden case
 *   pnpm eval -- --live --matrix             # the ON/OFF comparison (see below)
 *
 * The harness logic lives in src/lib/eval/* (so it is unit-tested under
 * `pnpm test`). This file is the THIN driver: it loads golden cases from
 * eval/golden/, wires an inference function (mock, API key, or local bridge),
 * runs the real review code paths, prints a table + verdict, writes JSON to
 * eval/results/, and exits non-zero if recall/noise-rate cross the gates.
 *
 * HONESTY (read this before trusting the numbers):
 *   --mock validates the HARNESS MECHANICS (scoring + matching) deterministically.
 *          The "model" is a scripted stub, so a green --mock run proves the
 *          plumbing works — it says NOTHING about real model quality.
 *   --live measures ACTUAL model quality against the (small, seed) golden set.
 *
 * --matrix is the answer to "did the filtering help, or did it just hide
 * findings?". It pays for ONE generation per case and then scores those same
 * findings under every combination of the post-generation stages
 * (see src/lib/eval/surface.ts). A single number cannot separate "precision
 * went up because noise was removed" from "precision went up because real
 * findings were removed too"; the per-case delta can.
 *
 * Loading note: the harness imports app code with extensionless, bundler-style
 * relative imports, so we load it through a throwaway Vite SSR server (Node's
 * native TS type-stripping cannot resolve those). No app runtime behavior is
 * touched — this is a dev/CI tool only.
 */

import { createServer, type ViteDevServer } from 'vite'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const GOLDEN_DIR = join(HERE, 'golden')
const RESULTS_DIR = join(HERE, 'results')

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface Args {
  live: boolean
  deep: boolean
  caseFilter: string | null
  crossVerify: boolean
  /** Plan O: 'generate' enables multi-generator fusion (recall lift). */
  fusion: 'verify' | 'generate'
  /** Run the separate TESTS reviewer pass (#237) alongside the impl pass. */
  tests: boolean
  /** Score one generation under every pipeline-stage combination. */
  matrix: boolean
  /** How many golden cases to run at once. Live runs are latency-bound. */
  concurrency: number
  /** Suffix for the eval/results/ filename, so a run is findable later. */
  label: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    live: false,
    deep: false,
    caseFilter: null,
    crossVerify: false,
    fusion: 'verify',
    tests: false,
    matrix: false,
    concurrency: 1,
    label: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') args.live = true
    else if (a === '--mock') args.live = false
    else if (a === '--deep') args.deep = true
    else if (a === '--cross-verify') args.crossVerify = true
    else if (a === '--tests') args.tests = true
    else if (a === '--matrix') {
      // The matrix needs every stage's data, so it turns the producing passes on.
      args.matrix = true
      args.crossVerify = true
      args.tests = true
    } else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 1)
    else if (a === '--label') args.label = argv[++i] ?? null
    else if (a === '--fusion') {
      const mode = argv[++i]
      args.fusion = mode === 'generate' ? 'generate' : 'verify'
      // 'generate' implies cross-confirm of the merged union.
      if (args.fusion === 'generate') args.crossVerify = true
    } else if (a === '--case') args.caseFilter = argv[++i] ?? null
  }
  return args
}

// ---------------------------------------------------------------------------
// Golden-case loading
// ---------------------------------------------------------------------------

interface LoadedCase {
  name: string
  fixture: unknown
  expected: unknown
  mockResponses: Record<string, unknown>
  mockVerifyVerdicts: Record<string, string>
  /**
   * Scripted convergence clusters for --mock (mock/convergence.json), in the
   * validator's own shape. Only a MULTI-PERSONA case has any; absent → the
   * convergence pass is not wired for that case at all.
   */
  mockConvergence: unknown | null
  /**
   * Plan O: per-generator scripted responses for --fusion generate. Each entry
   * is one simulated generator's response map (same shape as mockResponses).
   * Loaded from mock/responses.<gen>.json (gen ∈ a, b, c…). When absent, the
   * runner falls back to mockResponses for every generator (no recall lift).
   */
  mockGenerators: { name: string; responses: Record<string, unknown> }[]
}

function listCaseDirs(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((name) => {
      const p = join(GOLDEN_DIR, name)
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadCase(name: string): LoadedCase {
  const dir = join(GOLDEN_DIR, name)
  const fixture = readJson(join(dir, 'fixture.json'))
  const expected = readJson(join(dir, 'expected.json'))
  let mockResponses: Record<string, unknown> = {}
  try {
    mockResponses = readJson(join(dir, 'mock', 'responses.json')) as Record<string, unknown>
  } catch {
    mockResponses = {}
  }
  let mockVerifyVerdicts: Record<string, string> = {}
  try {
    mockVerifyVerdicts = readJson(join(dir, 'mock', 'verify.json')) as Record<string, string>
  } catch {
    mockVerifyVerdicts = {}
  }
  let mockConvergence: unknown | null = null
  try {
    mockConvergence = readJson(join(dir, 'mock', 'convergence.json'))
  } catch {
    mockConvergence = null
  }
  // Plan O: optional per-generator scripted responses (mock/responses.<gen>.json).
  const mockGenerators: { name: string; responses: Record<string, unknown> }[] = []
  for (const gen of ['a', 'b', 'c', 'd', 'e']) {
    try {
      const responses = readJson(join(dir, 'mock', `responses.${gen}.json`)) as Record<string, unknown>
      mockGenerators.push({ name: `gen-${gen}`, responses })
    } catch {
      // absent → skip
    }
  }
  return { name, fixture, expected, mockResponses, mockVerifyVerdicts, mockConvergence, mockGenerators }
}

// ---------------------------------------------------------------------------
// Live inference transports
//
// TWO transports, because this repo has two ways to reach a model:
//
//   1. An OpenAI-compatible API key (DeepSeek / OpenAI / a generic base URL).
//      Billed per token.
//   2. The LOCAL BRIDGE (`POST /v1/infer`) — the same transport the app offers,
//      which spends the user's EXISTING Claude Code / Codex subscription by
//      invoking the CLI as a subprocess. No per-token cost, and it is the only
//      way to run this harness on a machine with no API key at all.
//
// The bridge is checked FIRST when BRIDGE_URL is set, because a user who
// started a bridge meant to use it.
//
// BRIDGE LIMITATION, stated up front: `/v1/infer` runs the CLI with
// `--tools ""` — every built-in tool disabled, by design, so the route cannot
// touch the repo. Deep review (`--deep`) and grounded verification (#229) both
// tell the model to VERIFY claims with tools and to DROP whatever it cannot
// verify. Over the bridge those tools do not exist, so neither feature can be
// honestly measured through it; use an API-key transport with the app's real
// agentic harness for that.
// ---------------------------------------------------------------------------

type CompleteArgs = { system: string; user: string; taskKey: string }
type CompleteFn = (a: CompleteArgs) => Promise<string>

interface Transport {
  /** Human-readable, printed next to every number this run produces. */
  label: string
  /** The model/CLI identifier, recorded in the results JSON. */
  model: string
  complete: CompleteFn
  /**
   * Independent verifier transports for the cross-verification pass.
   *
   * At least TWO are required for verification to be able to change anything:
   * the surface rule is `score >= polledModels / 2` with the generator counting
   * as one implicit confirm, so with a single verifier `1 >= 2/2` holds no
   * matter how the verifier votes. A one-verifier cross-verify run is a
   * guaranteed no-op — it cannot demote, and its worth axis can never reach the
   * mootness threshold either.
   */
  verifiers: { label: string; complete: CompleteFn }[]
}

// --- Transport A: OpenAI-compatible API key --------------------------------

interface LiveProvider {
  baseUrl: string
  apiKey: string
  model: string
  label: string
}

function resolveKeyProvider(): LiveProvider | null {
  const modelOverride = process.env.LLM_MODEL
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: modelOverride ?? 'deepseek-chat',
      label: 'DeepSeek',
    }
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY,
      model: modelOverride ?? 'gpt-4o-mini',
      label: 'OpenAI',
    }
  }
  if (process.env.LLM_API_KEY) {
    const baseUrl = process.env.LLM_BASE_URL
    if (!baseUrl || !modelOverride) {
      throw new Error('LLM_API_KEY set but LLM_BASE_URL and LLM_MODEL are both required for the generic provider.')
    }
    return { baseUrl, apiKey: process.env.LLM_API_KEY, model: modelOverride, label: 'custom' }
  }
  return null
}

function makeKeyComplete(provider: LiveProvider): CompleteFn {
  const url = provider.baseUrl.replace(/\/$/, '') + '/v1/chat/completions'
  return async ({ system, user }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${provider.label} HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }
}

// --- Transport B: the local bridge (`POST /v1/infer`) -----------------------

interface BridgeConfig {
  url: string
  token: string
  /** Generator CLI. */
  cli: string
  /** Verifier CLIs, in order. */
  verifierClis: string[]
  timeoutMs: number
}

const BRIDGE_DEFAULT_TIMEOUT_MS = 240_000

function resolveBridge(): BridgeConfig | null {
  const url = process.env.BRIDGE_URL
  if (!url) return null
  const token = process.env.BRIDGE_TOKEN ?? readTokenFile(process.env.BRIDGE_TOKEN_FILE)
  if (!token) {
    throw new Error(
      'BRIDGE_URL is set but no pairing token was found. Set BRIDGE_TOKEN, or BRIDGE_TOKEN_FILE to the --token-file path the bridge was started with.',
    )
  }
  const cli = process.env.BRIDGE_CLI ?? 'claude'
  // Two verifiers by default — one is structurally incapable of demoting
  // anything (see Transport.verifiers). The other vendor's CLI comes first so
  // the panel is genuinely cross-model rather than one model arguing with itself.
  const other = cli === 'claude' ? 'codex' : 'claude'
  const verifierClis = (process.env.BRIDGE_VERIFY_CLIS ?? `${other},${cli}`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const timeoutMs = Number(process.env.BRIDGE_TIMEOUT_MS) || BRIDGE_DEFAULT_TIMEOUT_MS
  return { url: url.replace(/\/$/, ''), token, cli, verifierClis, timeoutMs }
}

function readTokenFile(path: string | undefined): string | null {
  if (!path) return null
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function makeBridgeComplete(cfg: BridgeConfig, cli: string): CompleteFn {
  return async ({ system, user }) => {
    const res = await fetch(`${cfg.url}/v1/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ cli, system, prompt: user, timeoutMs: cfg.timeoutMs }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`bridge/${cli} HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { text?: string }
    return data.text ?? ''
  }
}

async function bridgeHealth(cfg: BridgeConfig): Promise<{ inference: string[] }> {
  const res = await fetch(`${cfg.url}/v1/health`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  })
  if (!res.ok) throw new Error(`bridge health HTTP ${res.status} — is the bridge running at ${cfg.url}?`)
  const data = (await res.json()) as { capabilities?: { inference?: string[] } }
  return { inference: data.capabilities?.inference ?? [] }
}

async function resolveTransport(): Promise<Transport> {
  const bridge = resolveBridge()
  if (bridge) {
    const { inference } = await bridgeHealth(bridge)
    if (!inference.includes(bridge.cli)) {
      throw new Error(
        `The bridge does not offer the "${bridge.cli}" CLI (it has: ${inference.join(', ') || 'none'}). Set BRIDGE_CLI.`,
      )
    }
    const verifierClis = bridge.verifierClis.filter((c) => inference.includes(c))
    return {
      label: `bridge (${bridge.cli}${verifierClis.length ? `, verifiers: ${verifierClis.join('+')}` : ''})`,
      model: `bridge:${bridge.cli}`,
      complete: makeBridgeComplete(bridge, bridge.cli),
      verifiers: verifierClis.map((c) => ({ label: `bridge:${c}`, complete: makeBridgeComplete(bridge, c) })),
    }
  }

  const key = resolveKeyProvider()
  if (key) {
    const complete = makeKeyComplete(key)
    return {
      label: `${key.label} ${key.model}`,
      model: key.model,
      complete,
      // One API provider = one verifier model. Verification cannot demote with
      // a single verifier (see Transport.verifiers), so this is reported, not
      // silently pretended to work.
      verifiers: [{ label: key.label, complete }],
    }
  }

  throw new Error(
    'No inference transport found for --live. Either:\n' +
      '  - set a key: DEEPSEEK_API_KEY / OPENAI_API_KEY / LLM_API_KEY (+ LLM_BASE_URL + LLM_MODEL), or\n' +
      '  - start the local bridge and point the harness at it:\n' +
      '      pnpm bridge -- --port 7739 --token-file .bridge-token\n' +
      '      BRIDGE_URL=http://127.0.0.1:7739 BRIDGE_TOKEN_FILE=.bridge-token pnpm eval -- --live',
  )
}

// ---------------------------------------------------------------------------
// Table printing
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function printTable(
  rows: { name: string; produced: number; recall: number; precision: number; noiseRate: number }[],
  pct: (n: number) => string,
): void {
  const cols = [
    ['case', 20],
    ['findings', 9],
    ['recall', 8],
    ['precision', 10],
    ['noise', 7],
  ] as const
  const header = cols.map(([c, w]) => pad(c, w)).join(' ')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const r of rows) {
    console.log(
      [
        pad(r.name, 20),
        pad(String(r.produced), 9),
        pad(pct(r.recall), 8),
        pad(pct(r.precision), 10),
        pad(pct(r.noiseRate), 7),
      ].join(' '),
    )
  }
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= tasks.length) return
      results[i] = await tasks[i]()
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  let server: ViteDevServer | null = null
  let exitCode = 0
  try {
    server = await createServer({
      configFile: false,
      root: ROOT,
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true },
      logLevel: 'silent',
    })

    const harness = await server.ssrLoadModule('/src/lib/eval/harness.ts')
    const scorer = await server.ssrLoadModule('/src/lib/eval/scorer.ts')
    const mockMod = await server.ssrLoadModule('/src/lib/eval/mock.ts')
    const surfaceMod = await server.ssrLoadModule('/src/lib/eval/surface.ts')
    const crossVerifyMod = await server.ssrLoadModule('/src/lib/ai/crossVerify.ts')
    const tasksMod = await server.ssrLoadModule('/src/lib/ai/tasks.ts')
    const simplifyMod = await server.ssrLoadModule('/src/lib/ai/simplify.ts')
    const convergenceMod = await server.ssrLoadModule('/src/lib/ai/convergence.ts')

    type ProducedFinding = {
      file: string
      line: number | null
      description: string
      severity?: 'high' | 'medium' | 'low'
    }
    type FindingVerification = {
      confirmedBy: number
      polledModels: number
      surfaced: boolean
      worthFlagging?: boolean
      perModel: unknown[]
    }
    type VerifyFn = (
      findings: ProducedFinding[],
    ) => Promise<{ surfaced: boolean[]; verifications?: (FindingVerification | undefined)[] }>
    type SimplifyFn = (findings: ProducedFinding[]) => Promise<(string | undefined)[]>
    type ConvergenceInput = {
      id: string
      reviewer: string
      path: string
      line: number | null
      severity: string
      body: string
    }
    type ConvergeFn = (
      inputs: ConvergenceInput[],
    ) => Promise<{ clusters: { members: string[]; primary: string; reason: string }[] } | null>

    const { buildVerifyPrompt, validateVerifierResponse, aggregateFinding } = crossVerifyMod as {
      buildVerifyPrompt: (findings: unknown[], opts?: { grounded?: boolean }) => { system: string; user: string }
      validateVerifierResponse: (
        x: unknown,
      ) => { verdicts: { id: string; verdict: string; reason: string; worth?: boolean }[] } | null
      aggregateFinding: (
        gen: string,
        votes: { provider: string; verdict: string; reason: string; worth?: boolean }[],
      ) => FindingVerification
    }
    const { simplifyPrompt, convergencePrompt } = tasksMod as {
      simplifyPrompt: (findings: { id: string; body: string }[]) => { system: string; user: string }
      convergencePrompt: (
        findings: ConvergenceInput[],
        drafts: { id: string; path: string; line: number; body: string }[],
      ) => { system: string; user: string }
    }
    const { validateConvergence } = convergenceMod as {
      validateConvergence: (
        x: unknown,
        findingIds: ReadonlySet<string>,
        draftIds: ReadonlySet<string>,
      ) => { clusters: { members: string[]; primary: string; reason: string }[] } | null
    }
    const { validateSimplify } = simplifyMod as {
      validateSimplify: (x: unknown, ids: ReadonlySet<string>) => { rewrites: { id: string; simple: string }[] } | null
    }
    const { PIPELINE_VARIANTS } = surfaceMod as {
      PIPELINE_VARIANTS: readonly { key: string; label: string; stages: Record<string, boolean> }[]
    }

    const { runCase } = harness as {
      runCase: (
        c: unknown,
        complete: CompleteFn,
        ci: null,
        opts: Record<string, unknown>,
      ) => Promise<{
        score: Record<string, number | string>
        produced: unknown[]
        rawByTask: Record<string, string>
        findings: unknown[]
        variantScores: Record<string, Record<string, number | string>>
      }>
    }
    const { aggregate, evaluateGates, pct, DEFAULT_GATES } = scorer as {
      aggregate: (cases: unknown[]) => Record<string, unknown>
      evaluateGates: (agg: unknown, gates?: unknown) => { passed: boolean; reasons: string[] }
      pct: (n: number) => string
      DEFAULT_GATES: { minRecall: number; maxNoiseRate: number }
    }
    const { mockComplete } = mockMod as {
      mockComplete: (responses: Record<string, string>) => CompleteFn
    }

    // Build the transport for the chosen mode.
    let transport: Transport
    let modeLabel: string
    if (args.live) {
      transport = await resolveTransport()
      modeLabel = `--live (${transport.label})${args.deep ? ' --deep' : ''}`
    } else {
      modeLabel = '--mock (scripted stub — validates harness mechanics, NOT model quality)'
      transport = { label: 'mock', model: 'mock', complete: async () => '{}', verifiers: [] }
    }
    if (args.fusion === 'generate') modeLabel += ' --fusion generate'
    else if (args.crossVerify) modeLabel += ' --cross-verify'
    if (args.tests) modeLabel += ' --tests'
    if (args.matrix) modeLabel += ' --matrix'

    // --- Cross-verification pass --------------------------------------------
    // Uses the REAL prompt + the REAL aggregation, and now keeps the FULL
    // FindingVerification (confirmedBy / polledModels / worthFlagging) rather
    // than only its surface bit — triage (#226) and the mootness gate (#228)
    // are functions of exactly those fields.
    function makeLiveVerify(): VerifyFn {
      return async (findings) => {
        const verifiable = findings.map((f, i) => ({
          id: `f${i}`,
          path: f.file,
          line: f.line,
          // The reviewer's OWN severity, not a hardcoded 'medium': the verify
          // prompt ships severity, and the worth axis is asked to judge it.
          severity: f.severity ?? 'medium',
          body: f.description,
        }))
        // Grounded verification (#229) is deliberately OFF: it instructs the
        // verifier to look things up with repo tools, and no transport here
        // exposes tools. Asking for grounding we cannot provide would produce
        // a number about a feature that never ran.
        const prompts = buildVerifyPrompt(verifiable)

        const perVerifier = await Promise.all(
          transport.verifiers.map(async (v) => {
            try {
              const raw = await v.complete({ system: prompts.system, user: prompts.user, taskKey: 'verify' })
              const validated = validateVerifierResponse(safeJson(raw))
              if (!validated) return null
              const byId = new Map<string, { verdict: string; reason: string; worth?: boolean }>()
              for (const d of validated.verdicts) byId.set(d.id, d)
              return { label: v.label, byId }
            } catch {
              // A failing verifier is SKIPPED — never blocks, never votes.
              return null
            }
          }),
        )

        const verifications = findings.map((_, i) => {
          const votes = perVerifier.flatMap((v) => {
            if (!v) return []
            const d = v.byId.get(`f${i}`)
            if (!d) return []
            return [
              {
                provider: v.label,
                verdict: d.verdict,
                reason: d.reason ?? '',
                ...(d.worth !== undefined ? { worth: d.worth } : {}),
              },
            ]
          })
          if (votes.length === 0) return undefined
          return aggregateFinding('generator', votes)
        })

        return {
          surfaced: verifications.map((v) => v?.surfaced !== false),
          verifications,
        }
      }
    }

    function makeMockVerify(verdictByDesc: Record<string, string>): VerifyFn {
      return async (findings) => {
        const verifications = findings.map((f) => {
          const verdict = verdictByDesc[f.description] ?? 'confirm'
          return aggregateFinding('generator', [{ provider: 'mock-verifier', verdict, reason: '' }])
        })
        return { surfaced: verifications.map((v) => v.surfaced), verifications }
      }
    }

    // --- The simplify pass (#220) -------------------------------------------
    function makeLiveSimplify(): SimplifyFn {
      return async (findings) => {
        const inputs = findings.map((f, i) => ({ id: `f${i}`, body: f.description }))
        const prompts = simplifyPrompt(inputs)
        try {
          const raw = await transport.complete({ system: prompts.system, user: prompts.user, taskKey: 'simplify' })
          const validated = validateSimplify(safeJson(raw), new Set(inputs.map((i) => i.id)))
          if (!validated) return findings.map(() => undefined)
          const byId = new Map(validated.rewrites.map((r) => [r.id, r.simple]))
          return findings.map((_, i) => byId.get(`f${i}`))
        } catch {
          return findings.map(() => undefined)
        }
      }
    }

    // --- The cross-reviewer convergence pass (#206) -------------------------
    // Uses the REAL prompt and the REAL validator; harness.ts then applies the
    // REAL merge. Inert on a single-persona case (nothing to converge across),
    // which is exactly why the 2026-09-22 baseline could not measure it.
    function makeLiveConverge(): ConvergeFn {
      return async (inputs) => {
        const prompts = convergencePrompt(inputs, [])
        const ids = new Set(inputs.map((i) => i.id))
        try {
          const raw = await transport.complete({
            system: prompts.system,
            user: prompts.user,
            taskKey: 'convergence',
          })
          return validateConvergence(safeJson(raw), ids, new Set())
        } catch {
          return null
        }
      }
    }

    /**
     * Scripted clusters from mock/convergence.json, run through the REAL
     * validator. Scripted member ids are positional, so a fixture edit that
     * adds or reorders reviewer findings silently invalidates them — and an
     * invalid cluster set is a NO-OP, which would look like "convergence had no
     * effect" rather than "the script rotted". Say so loudly instead.
     */
    function makeMockConverge(caseName: string, scripted: unknown): ConvergeFn {
      return async (inputs) => {
        const validated = validateConvergence(scripted, new Set(inputs.map((i) => i.id)), new Set())
        if (validated === null) {
          console.log(
            `  ! ${caseName}: mock/convergence.json does not validate against this run's ${inputs.length} reviewer\n` +
              `    findings (positional ids f0..f${inputs.length - 1}). The convergence pass is a NO-OP for it.`,
          )
        }
        return validated
      }
    }

    let names = listCaseDirs()
    if (args.caseFilter) names = names.filter((n) => n === args.caseFilter)
    if (names.length === 0) {
      console.error(`No golden cases found${args.caseFilter ? ` matching "${args.caseFilter}"` : ''}.`)
      process.exitCode = 2
      return
    }

    console.log(`\nEval harness — mode: ${modeLabel}`)
    console.log(`Golden cases: ${names.length} (seed set; grows under eval/golden/)`)
    if (args.live && args.crossVerify && transport.verifiers.length < 2) {
      console.log(
        `\n  ! Only ${transport.verifiers.length} verifier available. Cross-verification CANNOT demote\n` +
          `    anything with fewer than 2 (the generator's implicit confirm already meets the\n` +
          `    score >= polled/2 bar), so --cross-verify is a no-op for this run.`,
      )
    }
    if (args.live && args.deep) {
      console.log(
        `\n  ! --deep asks the model to verify claims with repo tools. Confirm this transport\n` +
          `    actually exposes tools; the local bridge does NOT (/v1/infer runs --tools "").`,
      )
    }
    // Convergence merges ACROSS reviewer personas, so a set of single-persona
    // fixtures makes its comparison rows silently identical to their siblings.
    // Say which cases can actually move it rather than letting a reader assume
    // a flat row means "no effect".
    const multiPersona = names.filter(
      (n) => ((loadCase(n).fixture as { skills?: unknown[] }).skills?.length ?? 0) >= 2,
    )
    if (multiPersona.length === 0) {
      console.log(
        `\n  ! No fixture has 2+ reviewer personas, so cross-reviewer convergence (#206) has\n` +
          `    nothing to merge — its rows are inert, NOT evidence that the pass does nothing.`,
      )
    } else {
      console.log(`\n  Convergence (#206) is exercisable on: ${multiPersona.join(', ')}`)
    }
    console.log('')

    const variants = args.matrix ? PIPELINE_VARIANTS : undefined

    const caseTasks = names.map((name) => async () => {
      const loaded = loadCase(name)
      const goldenCase = { name: loaded.name, fixture: loaded.fixture, expected: loaded.expected }

      const caseComplete = args.live
        ? transport.complete
        : mockComplete(
            Object.fromEntries(
              Object.entries(loaded.mockResponses).map(([k, v]) => [k, JSON.stringify(v)]),
            ),
          )

      const caseVerify: VerifyFn | undefined = args.crossVerify
        ? args.live
          ? makeLiveVerify()
          : makeMockVerify(loaded.mockVerifyVerdicts)
        : undefined

      // Cross-reviewer convergence (#206) is part of the app's default
      // pipeline, not a flag — so it runs whenever a fixture actually has
      // something to converge ACROSS (≥2 reviewer personas). Under --mock it
      // needs scripted clusters; with none, wiring it would only prove that a
      // pass with no input does nothing.
      const personaCount = (loaded.fixture as { skills?: unknown[] }).skills?.length ?? 0
      const caseConverge: ConvergeFn | undefined =
        personaCount < 2
          ? undefined
          : args.live
            ? makeLiveConverge()
            : loaded.mockConvergence
              ? makeMockConverge(name, loaded.mockConvergence)
              : undefined

      // Plan O: per-generator completion functions for --fusion generate.
      let generators: { name: string; complete: CompleteFn }[] | undefined
      if (args.fusion === 'generate') {
        if (args.live) {
          generators = [
            { name: 'gen-1', complete: transport.complete },
            { name: 'gen-2', complete: transport.complete },
          ]
        } else if (loaded.mockGenerators.length >= 2) {
          generators = loaded.mockGenerators.map((g) => ({
            name: g.name,
            complete: mockComplete(
              Object.fromEntries(Object.entries(g.responses).map(([k, v]) => [k, JSON.stringify(v)])),
            ),
          }))
        } else {
          generators = [
            { name: 'gen-1', complete: caseComplete },
            { name: 'gen-2', complete: caseComplete },
          ]
        }
      }

      const result = await runCase(goldenCase, caseComplete, null, {
        deep: args.deep,
        crossVerify: args.crossVerify,
        testsPass: args.tests,
        ...(caseVerify ? { verify: caseVerify } : {}),
        ...(caseConverge ? { converge: caseConverge } : {}),
        ...(args.live && args.matrix ? { simplify: makeLiveSimplify() } : {}),
        ...(args.fusion === 'generate' ? { fusionGenerate: true } : {}),
        ...(generators ? { generators } : {}),
        ...(variants ? { variants } : {}),
      })
      return { name, result }
    })

    const settled = await pooled(caseTasks, args.live ? args.concurrency : 1)

    const caseScores: unknown[] = []
    const rowData: { name: string; produced: number; recall: number; precision: number; noiseRate: number }[] = []
    const perCaseRaw: Record<string, unknown> = {}
    const variantCaseScores: Record<string, unknown[]> = {}

    for (const { name, result } of settled) {
      caseScores.push(result.score)
      const score = result.score as unknown as {
        produced: number
        recall: number
        precision: number
        noiseRate: number
      }
      rowData.push({
        name,
        produced: score.produced,
        recall: score.recall,
        precision: score.precision,
        noiseRate: score.noiseRate,
      })
      perCaseRaw[name] = {
        score: result.score,
        produced: result.produced,
        findings: result.findings,
        variantScores: result.variantScores,
        rawByTask: result.rawByTask,
      }
      for (const [key, s] of Object.entries(result.variantScores ?? {})) {
        ;(variantCaseScores[key] ??= []).push(s)
      }
    }

    printTable(rowData, pct)

    const agg = aggregate(caseScores) as unknown as {
      recall: number
      precision: number
      noiseRate: number
      totalProduced: number
      realCaught: number
      realTotal: number
      noiseFlagged: number
      noiseTotal: number
    }
    console.log('-'.repeat(56))
    console.log(
      [
        pad('AGGREGATE', 20),
        pad(String(agg.totalProduced), 9),
        pad(pct(agg.recall), 8),
        pad(pct(agg.precision), 10),
        pad(pct(agg.noiseRate), 7),
      ].join(' '),
    )

    const gate = evaluateGates(agg, DEFAULT_GATES)
    console.log('')
    console.log(
      `Verdict: recall ${pct(agg.recall)} (${agg.realCaught}/${agg.realTotal} real caught), ` +
        `noise-rate ${pct(agg.noiseRate)} (${agg.noiseFlagged}/${agg.noiseTotal} noise flagged) — ` +
        `${gate.passed ? 'PASS' : 'FAIL'}`,
    )
    if (!gate.passed) {
      for (const reason of gate.reasons) console.log(`  - ${reason}`)
    }

    // --- The on/off comparison ----------------------------------------------
    const variantAggregates: Record<string, unknown> = {}
    if (variants) {
      console.log('\nPipeline stage comparison — ONE generation, scored under each stage combination.')
      console.log('Read the DELTAS, not the levels: recall falling while noise falls too means the')
      console.log('filters are hiding real findings, not just noise.\n')
      const header = [pad('variant', 28), pad('findings', 9), pad('recall', 8), pad('precision', 10), pad('noise', 7)].join(' ')
      console.log(header)
      console.log('-'.repeat(header.length))
      for (const variant of variants) {
        const rows = variantCaseScores[variant.key] ?? []
        const vAgg = aggregate(rows) as unknown as {
          recall: number
          precision: number
          noiseRate: number
          totalProduced: number
        }
        variantAggregates[variant.key] = { ...vAgg, label: variant.label, stages: variant.stages }
        console.log(
          [
            pad(variant.key, 28),
            pad(String(vAgg.totalProduced), 9),
            pad(pct(vAgg.recall), 8),
            pad(pct(vAgg.precision), 10),
            pad(pct(vAgg.noiseRate), 7),
          ].join(' '),
        )
      }
      console.log('')
      for (const variant of variants) console.log(`  ${pad(variant.key, 28)} ${variant.label}`)
    }

    if (!args.live) {
      console.log('\nNote: --mock only proves the scoring/matching plumbing. Run --live to measure the model.')
    }

    // Emit JSON to eval/results/.
    mkdirSync(RESULTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const suffix = args.label ? `-${args.label}` : ''
    const outPath = join(RESULTS_DIR, `${args.live ? 'live' : 'mock'}${suffix}-${stamp}.json`)
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          mode: args.live ? 'live' : 'mock',
          transport: transport.label,
          model: transport.model,
          verifiers: transport.verifiers.map((v) => v.label),
          deep: args.deep,
          testsPass: args.tests,
          crossVerify: args.crossVerify,
          aggregate: agg,
          variantAggregates,
          gate,
          cases: perCaseRaw,
          gates: DEFAULT_GATES,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    console.log(`\nWrote ${outPath}`)

    exitCode = gate.passed ? 0 : 1
  } catch (err) {
    console.error('\nEval run failed:', err instanceof Error ? err.message : err)
    exitCode = 2
  } finally {
    if (server) await server.close()
  }
  process.exitCode = exitCode
}

/** Parse JSON, tolerating the ```json fences a CLI transport often adds. */
function safeJson(raw: string): unknown {
  const trimmed = raw.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  try {
    return JSON.parse(fence ? fence[1] : trimmed)
  } catch {
    return null
  }
}

await main()
