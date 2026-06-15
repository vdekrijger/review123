/**
 * eval/capture-case.mts — turn a REAL GitHub PR into a golden eval case.
 *
 * Usage (via the `eval:capture` pnpm script):
 *   GITHUB_TOKEN=ghp_... DEEPSEEK_API_KEY=sk-... \
 *     pnpm eval:capture <pr-url-or-owner/repo/number> --name <slug>
 *
 *   pnpm eval:capture https://github.com/o/r/pull/42 --name 07-my-case
 *   pnpm eval:capture o/r/42 --name 07-my-case
 *
 * What it does:
 *   1. Fetches the PR via GitHub's REST API (meta + files/patches + the full
 *      after-contents of each changed file) into the harness's fixture.json shape.
 *   2. Runs the REAL review tasks (verdict + attention + skill review) LIVE
 *      against the configured provider (the same env keys `pnpm eval --live`
 *      uses) and records every produced finding.
 *   3. Scaffolds eval/golden/<slug>/ with:
 *        - fixture.json        (the PR, harness shape)
 *        - expected.json       (every AI finding listed, label "UNLABELED")
 *        - mock/responses.json (the live findings, so the case replays in --mock)
 *
 * The UNLABELED entries are SKIPPED by the scorer until you resolve them — edit
 * each to "real" or "noise" (and add any real findings the AI MISSED). See the
 * "Capturing a real PR as a golden case" section in eval/README.md.
 *
 * Loading note: like run-eval.mts, the harness imports app code with
 * extensionless bundler-style imports, so we load it through a throwaway Vite
 * SSR server. No app runtime behavior is touched — this is a dev tool only.
 */

import { createServer, type ViteDevServer } from 'vite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const GOLDEN_DIR = join(HERE, 'golden')

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface Args {
  prRef: string | null
  name: string | null
  deep: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { prRef: null, name: null, deep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') args.name = argv[++i] ?? null
    else if (a === '--deep') args.deep = true
    else if (!a.startsWith('--') && args.prRef === null) args.prRef = a
  }
  return args
}

// ---------------------------------------------------------------------------
// PR-ref parsing (URL or owner/repo/number)
// ---------------------------------------------------------------------------

interface PrRef {
  owner: string
  repo: string
  number: number
}

function parsePrRef(input: string): PrRef {
  const trimmed = input.trim()
  // https://github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: Number(urlMatch[3]) }
  }
  // owner/repo/123 or owner/repo#123
  const shortMatch = trimmed.match(/^([^/]+)\/([^/#]+)[/#](\d+)$/)
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], number: Number(shortMatch[3]) }
  }
  throw new Error(
    `Could not parse "${input}" as a PR. Use a github.com/owner/repo/pull/N URL or owner/repo/N.`,
  )
}

// ---------------------------------------------------------------------------
// GitHub REST fetch (self-contained, mirrors src/lib/github/api.ts)
// ---------------------------------------------------------------------------

const GH_API = 'https://api.github.com'

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'review123-eval-capture',
  }
}

async function ghGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders(token) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub HTTP ${res.status} for ${path}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

interface RawPrFile {
  filename: string
  status: string
  patch?: string
}

interface RawPrMeta {
  title: string
  base: { sha: string }
  head: { sha: string }
}

async function fetchPrFiles(ref: PrRef, token: string): Promise<RawPrFile[]> {
  const all: RawPrFile[] = []
  for (let page = 1; page <= 50; page++) {
    const body = await ghGet<RawPrFile[]>(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100&page=${page}`,
      token,
    )
    all.push(...body)
    if (body.length < 100) break
  }
  return all
}

async function fetchFileAtRef(
  ref: PrRef,
  filePath: string,
  sha: string,
  token: string,
): Promise<string | null> {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  try {
    const data = await ghGet<{ content?: string; encoding?: string }>(
      `/repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(sha)}`,
      token,
    )
    if (data.encoding !== 'base64' || !data.content) return null
    return Buffer.from(data.content, 'base64').toString('utf8')
  } catch {
    // Deleted file / not found at this ref → no after-contents.
    return null
  }
}

// ---------------------------------------------------------------------------
// Live LLM completion (OpenAI-compatible — same provider selection as run-eval)
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
    'No provider key found. Set one of DEEPSEEK_API_KEY, OPENAI_API_KEY, or LLM_API_KEY (+ LLM_BASE_URL + LLM_MODEL) to run the review live.',
  )
}

type CompleteArgs = { system: string; user: string; taskKey: string }

function makeLiveComplete(provider: LiveProvider): (a: CompleteArgs) => Promise<string> {
  const url = provider.baseUrl.replace(/\/$/, '') + '/v1/chat/completions'
  return async ({ system, user }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
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
// Default reviewer persona for captured cases (the user can edit it after).
// ---------------------------------------------------------------------------

const DEFAULT_SKILL = {
  name: 'bug-hunter',
  content:
    'You are a correctness- and security-focused reviewer. Flag genuine defects: ' +
    'off-by-one errors, null/undefined hazards, injection/authz/secret issues, and ' +
    'logic that changes observable behavior. Ignore style, naming, and pre-existing ' +
    'issues on unchanged lines.',
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.prRef) {
    console.error('Usage: pnpm eval:capture <pr-url-or-owner/repo/number> --name <slug>')
    process.exitCode = 2
    return
  }
  if (!args.name) {
    console.error('Missing --name <slug>. Example: pnpm eval:capture o/r/42 --name 07-my-case')
    process.exitCode = 2
    return
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (!token) {
    console.error('No GitHub token. Set GITHUB_TOKEN (or GH_TOKEN) to fetch the PR.')
    process.exitCode = 2
    return
  }

  const outDir = join(GOLDEN_DIR, args.name)
  if (existsSync(outDir)) {
    console.error(`Refusing to overwrite an existing case: eval/golden/${args.name}/ already exists.`)
    process.exitCode = 2
    return
  }

  let prRef: PrRef
  try {
    prRef = parsePrRef(args.prRef)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 2
    return
  }

  // Resolve the provider BEFORE the network round-trips so a missing key fails fast.
  let provider: LiveProvider
  try {
    provider = resolveLiveProvider()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 2
    return
  }

  let server: ViteDevServer | null = null
  try {
    // 1. Fetch the PR into the fixture shape.
    console.log(`Fetching PR ${prRef.owner}/${prRef.repo}#${prRef.number} ...`)
    let meta: RawPrMeta
    let rawFiles: RawPrFile[]
    try {
      meta = await ghGet<RawPrMeta>(`/repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}`, token)
      rawFiles = await fetchPrFiles(prRef, token)
    } catch (err) {
      console.error(`PR fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 2
      return
    }

    const files = []
    for (const f of rawFiles) {
      const contentAfter =
        f.status === 'removed' ? null : await fetchFileAtRef(prRef, f.filename, meta.head.sha, token)
      files.push({
        path: f.filename,
        patch: f.patch ?? '',
        contentBefore: f.status === 'added' ? null : undefined,
        contentAfter,
      })
    }
    console.log(`  ${files.length} changed file(s): ${meta.title}`)

    if (files.length === 0) {
      console.error('PR has no changed files to review.')
      process.exitCode = 2
      return
    }

    // 2. Run the real review tasks live via the harness.
    server = await createServer({
      configFile: false,
      root: ROOT,
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true },
      logLevel: 'silent',
    })
    const harness = await server.ssrLoadModule('/src/lib/eval/harness.ts')
    const capture = await server.ssrLoadModule('/src/lib/eval/capture.ts')

    const { captureFindings } = harness as {
      captureFindings: (
        fixture: unknown,
        complete: (a: CompleteArgs) => Promise<string>,
        ci: null,
        opts: { deep?: boolean },
      ) => Promise<
        { taskKey: string; file: string; line: number | null; description: string; severity?: string }[]
      >
    }
    const { scaffoldCase } = capture as {
      scaffoldCase: (
        pr: unknown,
        findings: unknown[],
      ) => { fixture: unknown; expected: unknown; mockResponses: unknown }
    }

    const fixture = { name: args.name, files, skills: [DEFAULT_SKILL] }

    console.log(`Running live review (${provider.label} ${provider.model})${args.deep ? ' --deep' : ''} ...`)
    const complete = makeLiveComplete(provider)
    const findings = await captureFindings(fixture, complete, null, { deep: args.deep })
    console.log(`  ${findings.length} finding(s) produced.`)

    // 3. Scaffold the three case files.
    const pr = { name: args.name, files, skills: [DEFAULT_SKILL] }
    const scaffold = scaffoldCase(pr, findings)

    mkdirSync(join(outDir, 'mock'), { recursive: true })
    writeFileSync(join(outDir, 'fixture.json'), JSON.stringify(scaffold.fixture, null, 2) + '\n')
    writeFileSync(join(outDir, 'expected.json'), expectedWithHeader(scaffold.expected))
    writeFileSync(join(outDir, 'mock', 'responses.json'), JSON.stringify(scaffold.mockResponses, null, 2) + '\n')

    console.log(`\nWrote eval/golden/${args.name}/ (fixture.json + expected.json + mock/responses.json)\n`)
    console.log('Next steps:')
    console.log(`  1. Edit eval/golden/${args.name}/expected.json: mark each finding's "label"`)
    console.log('     as "real" or "noise" (UNLABELED entries are ignored by the scorer).')
    console.log('     Add any genuine findings the AI MISSED, with "label": "real".')
    console.log(`  2. pnpm eval -- --case ${args.name}          # replay offline (mock)`)
    console.log(`  3. pnpm eval -- --case ${args.name} --live    # measure the real model`)
  } catch (err) {
    console.error('\nCapture failed:', err instanceof Error ? err.message : err)
    process.exitCode = 2
  } finally {
    if (server) await server.close()
  }
}

/**
 * Serialize expected.json with a leading "_comment" key documenting the
 * UNLABELED contract (JSON has no comments, so we use a key the scorer ignores).
 */
function expectedWithHeader(expected: { findings: unknown[] }): string {
  const withComment = {
    _comment:
      'Mark each finding\'s "label" as "real" (a reviewer SHOULD flag it) or "noise" ' +
      '(should NOT). "UNLABELED" entries are SKIPPED by the scorer until you resolve them. ' +
      'Add real findings the AI missed with "label": "real".',
    findings: expected.findings,
  }
  return JSON.stringify(withComment, null, 2) + '\n'
}

await main()
