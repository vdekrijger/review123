/**
 * eval/run-eval.mts — CLI runner for the AI-review eval harness.
 *
 * Usage (via the `eval` pnpm script):
 *   pnpm eval                 # --mock (default): scripted stub, no network/key
 *   pnpm eval -- --live       # real provider call (requires a key in env)
 *   pnpm eval -- --live --deep # exercise the agentic deep-review guidance too
 *   pnpm eval -- --case 01-real-bug   # run a single golden case
 *
 * The harness logic lives in src/lib/eval/* (so it is unit-tested under
 * `pnpm test`). This file is the THIN driver: it loads golden cases from
 * eval/golden/, wires an LLM completion function (mock or live), runs the real
 * review code paths, prints a table + verdict, writes JSON to eval/results/
 * (gitignored), and exits non-zero if recall/noise-rate cross the gates.
 *
 * HONESTY (read this before trusting the numbers):
 *   --mock validates the HARNESS MECHANICS (scoring + matching) deterministically.
 *          The "model" is a scripted stub, so a green --mock run proves the
 *          plumbing works — it says NOTHING about real model quality.
 *   --live measures ACTUAL model quality against the (small, seed) golden set.
 *          This is the run you do locally to judge prompt/calibration changes.
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = { live: false, deep: false, caseFilter: null, crossVerify: false, fusion: 'verify' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') args.live = true
    else if (a === '--mock') args.live = false
    else if (a === '--deep') args.deep = true
    else if (a === '--cross-verify') args.crossVerify = true
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
  return { name, fixture, expected, mockResponses, mockVerifyVerdicts, mockGenerators }
}

// ---------------------------------------------------------------------------
// Live LLM completion (self-contained, OpenAI-compatible chat/completions)
//
// Provider selection by env, in priority order:
//   DEEPSEEK_API_KEY → https://api.deepseek.com, model deepseek-chat
//   OPENAI_API_KEY   → OPENAI_BASE_URL or https://api.openai.com, model gpt-4o-mini
//   LLM_API_KEY      → LLM_BASE_URL (required), LLM_MODEL (required)
// Override the model with LLM_MODEL in any case.
// ---------------------------------------------------------------------------

interface LiveProvider {
  baseUrl: string
  apiKey: string
  model: string
  label: string
}

function resolveLiveProvider(): LiveProvider {
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
  throw new Error(
    'No provider key found. Set one of DEEPSEEK_API_KEY, OPENAI_API_KEY, or LLM_API_KEY (+ LLM_BASE_URL + LLM_MODEL) to run --live.',
  )
}

type CompleteArgs = { system: string; user: string; taskKey: string }

function makeLiveComplete(provider: LiveProvider): (a: CompleteArgs) => Promise<string> {
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

// ---------------------------------------------------------------------------
// Table + verdict printing
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
    const crossVerifyMod = await server.ssrLoadModule('/src/lib/ai/crossVerify.ts')

    type ProducedFinding = { file: string; line: number | null; description: string }
    type VerifyResult = { surfaced: boolean[] }
    type VerifyFn = (findings: ProducedFinding[]) => Promise<VerifyResult>

    const { buildVerifyPrompt, validateVerifierResponse, aggregateFinding } = crossVerifyMod as {
      buildVerifyPrompt: (findings: unknown[]) => { system: string; user: string }
      validateVerifierResponse: (x: unknown) => { verdicts: { id: string; verdict: string }[] } | null
      aggregateFinding: (
        gen: string,
        votes: { provider: string; verdict: string; reason: string }[],
      ) => { surfaced: boolean }
    }

    type GenCompleteFn = (a: CompleteArgs) => Promise<string>
    const { runCase } = harness as {
      runCase: (
        c: unknown,
        complete: (a: CompleteArgs) => Promise<string>,
        ci: null,
        opts: {
          deep?: boolean
          crossVerify?: boolean
          verify?: VerifyFn
          fusionGenerate?: boolean
          generators?: { name: string; complete: GenCompleteFn }[]
        },
      ) => Promise<{ score: Record<string, number | string>; produced: unknown[]; rawByTask: Record<string, string> }>
    }
    const { aggregate, evaluateGates, pct, DEFAULT_GATES } = scorer as {
      aggregate: (cases: unknown[]) => Record<string, unknown>
      evaluateGates: (agg: unknown, gates?: unknown) => { passed: boolean; reasons: string[] }
      pct: (n: number) => string
      DEFAULT_GATES: { minRecall: number; maxNoiseRate: number }
    }
    const { mockComplete } = mockMod as {
      mockComplete: (responses: Record<string, string>) => (a: CompleteArgs) => Promise<string>
    }

    // Build the completion function for the chosen mode.
    let complete: (a: CompleteArgs) => Promise<string>
    let modeLabel: string
    let liveProvider: LiveProvider | null = null
    if (args.live) {
      liveProvider = resolveLiveProvider()
      complete = makeLiveComplete(liveProvider)
      modeLabel = `--live (${liveProvider.label} ${liveProvider.model})${args.deep ? ' --deep' : ''}`
    } else {
      // Mock: pick the per-case responses map at call time via a closure-by-case.
      modeLabel = '--mock (scripted stub — validates harness mechanics, NOT model quality)'
      complete = async () => '{}' // replaced per-case below
    }
    if (args.fusion === 'generate') modeLabel += ' --fusion generate'
    else if (args.crossVerify) modeLabel += ' --cross-verify'

    // Cross-verify pass (Plan M). In --live, the verify provider is the SAME
    // live provider (a single verifier here for harness simplicity — the app
    // polls up to 3 distinct providers); it judges each finding adversarially
    // and we demote refute/uncertain. In --mock, an optional mock/verify.json
    // maps finding descriptions to verdicts; absent → all surface (no-op).
    function makeLiveVerify(provider: LiveProvider): VerifyFn {
      const completeFn = makeLiveComplete(provider)
      return async (findings) => {
        const verifiable = findings.map((f, i) => ({ id: `f${i}`, path: f.file, line: f.line, severity: 'medium', body: f.description }))
        const prompts = buildVerifyPrompt(verifiable)
        const raw = await completeFn({ system: prompts.system, user: prompts.user, taskKey: 'verify' })
        let parsed: unknown = null
        try { parsed = JSON.parse(raw) } catch { parsed = null }
        const validated = validateVerifierResponse(parsed)
        const byId = new Map<string, string>()
        for (const v of validated?.verdicts ?? []) byId.set(v.id, v.verdict)
        return {
          surfaced: findings.map((_, i) => {
            const verdict = byId.get(`f${i}`) ?? 'uncertain'
            return aggregateFinding(provider.label, [{ provider: provider.label, verdict, reason: '' }]).surfaced
          }),
        }
      }
    }
    function makeMockVerify(verdictByDesc: Record<string, string>): VerifyFn {
      return async (findings) => ({
        surfaced: findings.map((f) => {
          const verdict = verdictByDesc[f.description] ?? 'confirm'
          return aggregateFinding('generator', [{ provider: 'mock-verifier', verdict, reason: '' }]).surfaced
        }),
      })
    }

    let names = listCaseDirs()
    if (args.caseFilter) names = names.filter((n) => n === args.caseFilter)
    if (names.length === 0) {
      console.error(`No golden cases found${args.caseFilter ? ` matching "${args.caseFilter}"` : ''}.`)
      process.exitCode = 2
      return
    }

    console.log(`\nEval harness — mode: ${modeLabel}`)
    console.log(`Golden cases: ${names.length} (seed set; grows under eval/golden/)\n`)

    const caseScores: unknown[] = []
    const rowData: { name: string; produced: number; recall: number; precision: number; noiseRate: number }[] = []
    const perCaseRaw: Record<string, unknown> = {}

    for (const name of names) {
      const loaded = loadCase(name)
      const goldenCase = { name: loaded.name, fixture: loaded.fixture, expected: loaded.expected }

      // In mock mode, stringify this case's scripted responses and wrap.
      const caseComplete = args.live
        ? complete
        : mockComplete(
            Object.fromEntries(
              Object.entries(loaded.mockResponses).map(([k, v]) => [k, JSON.stringify(v)]),
            ),
          )

      const caseVerify: VerifyFn | undefined = args.crossVerify
        ? args.live
          ? makeLiveVerify(liveProvider!)
          : makeMockVerify(loaded.mockVerifyVerdicts)
        : undefined

      // Plan O: build the per-generator completion functions for --fusion generate.
      // Live: two stand-in generators using the same provider (harness simplicity —
      // the app fans out to distinct ensemble models). Mock: each generator gets
      // its own scripted response map (responses.<gen>.json); falls back to the
      // base responses for both when no per-gen files exist (→ no recall lift).
      let generators: { name: string; complete: GenCompleteFn }[] | undefined
      if (args.fusion === 'generate') {
        if (args.live) {
          generators = [
            { name: 'gen-1', complete },
            { name: 'gen-2', complete },
          ]
        } else if (loaded.mockGenerators.length >= 2) {
          generators = loaded.mockGenerators.map((g) => ({
            name: g.name,
            complete: mockComplete(
              Object.fromEntries(Object.entries(g.responses).map(([k, v]) => [k, JSON.stringify(v)])),
            ),
          }))
        } else {
          // No per-gen mock files → two copies of the base scripted set.
          generators = [
            { name: 'gen-1', complete: caseComplete },
            { name: 'gen-2', complete: caseComplete },
          ]
        }
      }

      const result = await runCase(goldenCase, caseComplete, null, {
        deep: args.deep,
        crossVerify: args.crossVerify,
        ...(caseVerify ? { verify: caseVerify } : {}),
        ...(args.fusion === 'generate' ? { fusionGenerate: true } : {}),
        ...(generators ? { generators } : {}),
      })
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
      perCaseRaw[name] = { score: result.score, produced: result.produced, rawByTask: result.rawByTask }
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
    if (!args.live) {
      console.log('\nNote: --mock only proves the scoring/matching plumbing. Run --live to measure the model.')
    }

    // Emit JSON to eval/results/ (gitignored).
    mkdirSync(RESULTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = join(RESULTS_DIR, `${args.live ? 'live' : 'mock'}-${stamp}.json`)
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          mode: args.live ? 'live' : 'mock',
          deep: args.deep,
          aggregate: agg,
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

await main()
