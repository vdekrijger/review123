/**
 * eval/rescore.mts — re-score a STORED run under the pipeline variants, offline.
 *
 * `pnpm eval -- --live --matrix` writes every generated finding to
 * eval/results/<run>.json with its severity, its cross-model verification and
 * its simplify rewrite attached. Those are all the inputs the post-generation
 * stages consume — so any variant can be scored again from the file, with no
 * model call and no cost.
 *
 * That matters for two reasons:
 *   1. Adding a variant (or fixing one) does NOT mean re-running inference. The
 *      expensive half of an eval is generation; scoring is free and repeatable.
 *   2. A comparison table is only trustworthy if the rows come from the SAME
 *      generation. Re-scoring guarantees that; re-running cannot, because the
 *      models are stochastic.
 *
 * Usage:
 *   node eval/rescore.mts                      # the newest live run
 *   node eval/rescore.mts <file-in-results>    # a specific one
 *   node eval/rescore.mts eval/baseline-run.json   # the committed baseline
 *   node eval/rescore.mts <file> --per-case    # add the per-case breakdown
 *
 * `eval/results/` is gitignored, so the two runs behind eval/BASELINE.md are
 * also committed — `eval/baseline-run.json` and `eval/repeat-run.json`. The
 * first is what a future quality change diffs against; the second exists so the
 * run-to-run jitter that decides whether a delta means anything is checkable
 * rather than asserted.
 */

import { createServer, type ViteDevServer } from 'vite'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const GOLDEN_DIR = join(HERE, 'golden')
const RESULTS_DIR = join(HERE, 'results')

interface StoredRun {
  mode: string
  transport?: string
  model?: string
  verifiers?: string[]
  generatedAt: string
  cases: Record<string, { findings: unknown[] }>
}

function newestRun(): string {
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const live = files.filter((f) => f.startsWith('live'))
  const pick = (live.length > 0 ? live : files).pop()
  if (!pick) throw new Error(`No runs in ${RESULTS_DIR}. Run \`pnpm eval -- --live --matrix\` first.`)
  return pick
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

/** A bare name means eval/results/<name>; anything that resolves is used as-is. */
function resolveRunPath(arg: string): string {
  const direct = resolve(process.cwd(), arg)
  if (existsSync(direct)) return direct
  return join(RESULTS_DIR, arg)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const perCase = args.includes('--per-case')
  const fileArg = args.find((a) => !a.startsWith('--'))
  const file = fileArg ?? newestRun()
  const runPath = resolveRunPath(file)

  let server: ViteDevServer | null = null
  try {
    const run = JSON.parse(readFileSync(runPath, 'utf8')) as StoredRun

    server = await createServer({
      configFile: false,
      root: ROOT,
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true },
      logLevel: 'silent',
    })
    const surfaceMod = await server.ssrLoadModule('/src/lib/eval/surface.ts')
    const scorer = await server.ssrLoadModule('/src/lib/eval/scorer.ts')

    const { surfaceFindings, PIPELINE_VARIANTS } = surfaceMod as {
      surfaceFindings: (findings: unknown[], stages: Record<string, boolean>) => unknown[]
      PIPELINE_VARIANTS: readonly { key: string; label: string; stages: Record<string, boolean> }[]
    }
    const { scoreCase, normalizeExpectation, aggregate, pct } = scorer as {
      scoreCase: (name: string, produced: unknown[], exp: unknown) => Record<string, number>
      normalizeExpectation: (raw: unknown) => unknown
      aggregate: (cases: unknown[]) => Record<string, number>
      pct: (n: number) => string
    }

    const names = Object.keys(run.cases).sort()
    const expectations = new Map<string, unknown>(
      names.map((n) => [
        n,
        normalizeExpectation(JSON.parse(readFileSync(join(GOLDEN_DIR, n, 'expected.json'), 'utf8'))),
      ]),
    )

    console.log(`\nRe-scoring ${file}`)
    console.log(`  mode ${run.mode} · transport ${run.transport ?? 'n/a'} · generated ${run.generatedAt}`)
    if (run.verifiers) console.log(`  verifiers: ${run.verifiers.join(', ') || 'none'}`)
    console.log('')

    const header = [pad('variant', 28), pad('findings', 9), pad('recall', 8), pad('precision', 10), pad('noise', 7)].join(' ')
    console.log(header)
    console.log('-'.repeat(header.length))

    const perVariantCases = new Map<string, Record<string, number>[]>()
    for (const variant of PIPELINE_VARIANTS) {
      const scores = names.map((n) =>
        scoreCase(n, surfaceFindings(run.cases[n].findings, variant.stages), expectations.get(n)),
      )
      perVariantCases.set(variant.key, scores)
      const agg = aggregate(scores) as unknown as {
        recall: number
        precision: number
        noiseRate: number
        totalProduced: number
        realCaught: number
        realTotal: number
        noiseFlagged: number
        noiseTotal: number
      }
      console.log(
        [
          pad(variant.key, 28),
          pad(String(agg.totalProduced), 9),
          pad(`${pct(agg.recall)} ${agg.realCaught}/${agg.realTotal}`, 8),
          pad(pct(agg.precision), 10),
          pad(`${pct(agg.noiseRate)} ${agg.noiseFlagged}/${agg.noiseTotal}`, 7),
        ].join(' '),
      )
    }

    console.log('')
    for (const variant of PIPELINE_VARIANTS) console.log(`  ${pad(variant.key, 28)} ${variant.label}`)

    if (perCase) {
      console.log('\nPer case — findings / real-caught / noise-flagged\n')
      for (const name of names) {
        console.log(`  ${name}`)
        for (const variant of PIPELINE_VARIANTS) {
          const idx = names.indexOf(name)
          const s = perVariantCases.get(variant.key)![idx]
          console.log(
            `    ${pad(variant.key, 28)} ${String(s.produced).padStart(3)}f  real ${s.realCaught}/${s.realTotal}  noise ${s.noiseFlagged}/${s.noiseTotal}`,
          )
        }
      }
    }
    console.log('')
  } finally {
    if (server) await server.close()
  }
}

await main()
