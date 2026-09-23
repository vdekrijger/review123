/**
 * eval/materialize-golden.mts — write the golden fixtures out as a real working
 * tree, so an agentic bridge has something to read.
 *
 *   node eval/materialize-golden.mts [--out <dir>]
 *
 * Default output: eval/.golden-tree (git-ignored).
 *
 * Then serve the bridge FROM that tree rather than from review123 itself:
 *
 *   node bridge/dist/cli.js --root eval/.golden-tree --port 7739 \
 *     --token-file .bridge-token
 *
 * WHY THIS STEP EXISTS: see src/lib/eval/goldenTree.ts. In one line — the
 * fixtures are synthetic, so a bridge rooted at this repo answers "no such
 * file" for every path under review, and grounded verification (which drops
 * what it cannot confirm) would then refute real defects for a reason that has
 * nothing to do with grounding.
 *
 * The directory is DISPOSABLE and rewritten from scratch each run. Nothing
 * reads it except a CLI the bridge spawned.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { planGoldenTree, goldenTreeReadme } from '../src/lib/eval/goldenTree.ts'
import type { GoldenCase } from '../src/lib/eval/harness.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(HERE, 'golden')
const DEFAULT_OUT = join(HERE, '.golden-tree')

function parseOut(argv: string[]): string {
  const i = argv.indexOf('--out')
  return i >= 0 && argv[i + 1] ? resolve(process.cwd(), argv[i + 1]) : DEFAULT_OUT
}

function loadCases(): GoldenCase[] {
  return readdirSync(GOLDEN_DIR)
    .filter((name) => {
      try {
        return statSync(join(GOLDEN_DIR, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .map((name) => ({
      name,
      fixture: JSON.parse(readFileSync(join(GOLDEN_DIR, name, 'fixture.json'), 'utf8')),
      expected: JSON.parse(readFileSync(join(GOLDEN_DIR, name, 'expected.json'), 'utf8')),
    })) as GoldenCase[]
}

function main(): void {
  const out = parseOut(process.argv.slice(2))
  const cases = loadCases()
  const plan = planGoldenTree(cases)

  // Rewritten from scratch: a stale file left behind from an earlier fixture
  // set is exactly the kind of thing a grep would find and a reader would
  // never suspect.
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  for (const f of plan.files) {
    const dest = join(out, f.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, f.content.endsWith('\n') ? f.content : f.content + '\n')
  }
  writeFileSync(join(out, 'README.md'), goldenTreeReadme(plan, new Date().toISOString()))

  console.log(`Materialized ${plan.files.length} file(s) from ${cases.length} golden case(s) into:`)
  console.log(`  ${out}`)
  if (plan.collisions.length > 0) {
    console.log(`\n  ! ${plan.collisions.length} path collision(s) — a tool read of these is ambiguous:`)
    for (const c of plan.collisions) console.log(`    ${c.path} — claimed by ${c.cases.join(', ')}`)
  }
  if (plan.deleted.length > 0) {
    console.log(`\n  ${plan.deleted.length} deleted-in-fixture path(s) intentionally NOT written.`)
  }
  console.log('\nServe the bridge from it:')
  console.log(`  node bridge/dist/cli.js --root ${out} --port 7739 --token-file .bridge-token`)
}

main()
