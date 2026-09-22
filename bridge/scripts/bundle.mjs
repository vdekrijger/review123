#!/usr/bin/env node
/**
 * bundle.mjs — build `bridge.mjs`, the single-file artifact we publish on
 * GitHub Releases. Run it with `pnpm bridge:bundle` from the repo root.
 *
 * Why this exists: the bridge has ZERO runtime dependencies, yet the only way
 * to run it used to be cloning review123 and installing the SPA's entire dev
 * toolchain (Playwright included) just to get `tsc` to emit `dist/`. A
 * prebuilt ESM file turns that into `curl … && node bridge.mjs --root .`.
 *
 * esbuild is invoked through `pnpm dlx` at a PINNED version instead of being a
 * root devDependency, deliberately: only this script and the tag-triggered
 * release workflow ever bundle, so making every `pnpm install` — CI's node-22
 * and node-26 matrix, the e2e job, the Vercel deploy, every contributor — pay
 * for a ~10 MB platform binary they never execute is the exact cost this whole
 * change is trying to remove. dlx keeps it to the one machine that bundles.
 *
 * The output carries NO build timestamp, so a given commit always produces
 * byte-identical bytes: anyone can rebuild the tag and diff it against the
 * published file. Provenance lives in the header comment instead.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Pinned: a release artifact should not change because a bundler shipped. */
export const ESBUILD_VERSION = '0.28.2'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BRIDGE_DIR = resolve(HERE, '..')
export const ENTRY = join(BRIDGE_DIR, 'src', 'cli.ts')
export const TSCONFIG = join(BRIDGE_DIR, 'tsconfig.json')
export const OUT_DIR = join(BRIDGE_DIR, 'dist', 'bundle')
/** dist/ is gitignored — the bundle is a build product, never committed. */
export const OUT_FILE = join(OUT_DIR, 'bridge.mjs')

export const SOURCE_URL = 'https://github.com/vdekrijger/review123/tree/main/bridge'

/**
 * `BRIDGE_VERSION` is hardcoded in cli.ts (it is printed in the banner and in
 * /v1/health) while package.json carries its own `version`. Shipping an
 * artifact whose header disagrees with what it reports at runtime would make
 * every bug report ambiguous, so the two are pinned together here.
 */
export function readCliVersion(cliSource) {
  const match = /export const BRIDGE_VERSION = '([^']+)'/.exec(cliSource)
  if (match === null) {
    throw new Error(`could not find BRIDGE_VERSION in ${ENTRY}`)
  }
  return match[1]
}

/** Throws unless cli.ts and package.json agree on the version. */
export function assertVersionsAgree(packageVersion, cliVersion) {
  if (packageVersion !== cliVersion) {
    throw new Error(
      `version drift: bridge/package.json says ${packageVersion} but ` +
        `BRIDGE_VERSION in src/cli.ts says ${cliVersion}. Update both.`,
    )
  }
  return packageVersion
}

/**
 * The comment block prepended to the artifact. A file people download and run
 * should say, in itself, what it is, where it came from and what it grants.
 */
export function buildHeader({ version, sha, esbuildVersion = ESBUILD_VERSION }) {
  return `#!/usr/bin/env node
/**
 * review123 local bridge ${version} — single-file bundle.
 *
 * Built from bridge/src/cli.ts at commit ${sha} by \`pnpm bridge:bundle\`
 * (esbuild ${esbuildVersion}, --platform=node --target=node22 --format=esm).
 * No build timestamp: the same commit always bundles to identical bytes, so
 * this file can be rebuilt and diffed against the published one.
 *
 * Source, every flag, and the full security model:
 *   ${SOURCE_URL}
 *
 * Zero runtime dependencies — Node 22+ built-ins only. Run it INSIDE the repo
 * you want to serve:
 *
 *   node bridge.mjs --root .
 *
 * READ THIS BEFORE YOU RUN IT. While this process runs it grants
 * https://review123.dev read access to that repo, to anyone holding the
 * pairing token it prints on startup. It binds 127.0.0.1 only, never writes to
 * the repo, never reads outside it, and the token dies with the process.
 */
`
}

/** Drop esbuild's own copy of the entry's hashbang so ours stays line 1. */
export function stripLeadingHashbang(code) {
  return code.startsWith('#!') ? code.slice(code.indexOf('\n') + 1) : code
}

/** Short commit sha, with a `-dirty` marker when the tree has local edits. */
function gitProvenance() {
  const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: BRIDGE_DIR,
    encoding: 'utf8',
  })
  if (rev.status !== 0) return 'unknown'
  const sha = rev.stdout.trim()
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: BRIDGE_DIR, encoding: 'utf8' })
  const dirty = status.status === 0 && status.stdout.trim() !== ''
  return dirty ? `${sha}-dirty` : sha
}

/**
 * Exported so a test can assert the bridge's OWN tsconfig is pinned.
 *
 * Without `--tsconfig` esbuild walks up from the entry and settles on the
 * repo-root tsconfig — the browser SPA's, a DOM type world that extends
 * `@tsconfig/svelte`, a package that is not even installed on a fresh clone
 * (esbuild warns about exactly that). It does not change today's emit, but
 * letting a Node artifact's compile settings be decided by the browser app's
 * tsconfig is a silent breakage waiting for whoever edits that file next.
 */
export function esbuildArgs(outfile) {
  return [
    'dlx',
    `esbuild@${ESBUILD_VERSION}`,
    ENTRY,
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    `--tsconfig=${TSCONFIG}`,
    `--outfile=${outfile}`,
  ]
}

function runEsbuild(outfile) {
  const result = spawnSync('pnpm', esbuildArgs(outfile), { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`esbuild exited with code ${result.status}`)
  }
}

export async function main() {
  const pkg = JSON.parse(readFileSync(join(BRIDGE_DIR, 'package.json'), 'utf8'))
  const version = assertVersionsAgree(pkg.version, readCliVersion(readFileSync(ENTRY, 'utf8')))
  const sha = gitProvenance()

  mkdirSync(OUT_DIR, { recursive: true })
  runEsbuild(OUT_FILE)

  const code = stripLeadingHashbang(readFileSync(OUT_FILE, 'utf8'))
  writeFileSync(OUT_FILE, buildHeader({ version, sha }) + code)
  chmodSync(OUT_FILE, 0o755)

  const kib = (statSync(OUT_FILE).size / 1024).toFixed(1)
  process.stdout.write(`\nreview123 bridge ${version} (${sha}) → ${OUT_FILE}  ${kib} KiB\n`)
}

// Only when run directly — the test imports the pure helpers above.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`bridge:bundle failed: ${err.message}\n`)
    process.exit(1)
  })
}
