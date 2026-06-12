/**
 * src/lib/skills/mineSkill.ts — "mine my GitHub reviews into a reviewer skill" feature.
 *
 * Flow (account-wide by default):
 *   1. Provider resolves the authenticated identity (GET /user)
 *   2. Provider fetches the user's recent review comments ACROSS repos
 *      (GitHub: /search/issues?q=type:pr commenter:LOGIN → per-PR review comments;
 *       GitLab: /events?action=commented → MergeRequest notes).
 *      An optional repoFilter narrows the harvest to one repository.
 *   3. Comments are author-filtered, capped at 150, code fences > 10 lines stripped
 *   4. Call llmJsonWithRepair with the mining prompt → { name, content }
 *   5. Return the draft skill for the user to review + save (NOT auto-saved)
 *
 * Privacy note: comments are sent to DeepSeek for analysis.
 * This module is a settings-time flow (not a review-time flow like tasks.ts).
 */

import type { llmJsonWithRepair as LlmJsonFn } from '../llm/llm'
import { providerFor } from '../provider/registry'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const MINE_COMMENTS_CAP = 150
const MINE_PAGES = 3
const CODE_FENCE_LINE_LIMIT = 10

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawPullComment {
  id: number
  user: { login: string }
  body: string
  created_at: string
  path: string
}

export interface MineDeps {
  getToken: () => string | null
  ghFetch: (path: string, token: string) => Promise<unknown>
}

export interface MineResult {
  ok: true
  login: string
  comments: string[]
}

export interface MineError {
  ok: false
  error: string
}

export interface MinedSkill {
  name: string
  content: string
}

export interface MineSkillResult {
  ok: true
  skill: MinedSkill
}

export interface MineSkillError {
  ok: false
  error: string
}

// ---------------------------------------------------------------------------
// Prompt builder — in this file (settings-time flow, not tasks.ts)
// ---------------------------------------------------------------------------

export function mineSkillPrompt(login: string, comments: string[]): { system: string; user: string } {
  const system = `You are a code review meta-analyst. Your job is to distill a developer's \
recurring review patterns into a concise reviewer persona markdown document.

Analyze the GitHub pull-request review comments provided. Identify recurring themes, priorities, \
and phrasing style. Then write a reviewer persona profile with these sections:

## Priorities (ordered by frequency)
List the topics this reviewer consistently raises, from most to least frequent.

## Phrasing style
One short paragraph describing how this reviewer writes comments (tone, directness, use of \
suggestions vs. demands, etc.).

## What this reviewer skips
A short bullet list of things this reviewer rarely or never flags.

Respond with JSON ONLY — no explanation, no markdown outside the JSON string values. \
Your response must be valid JSON matching exactly this shape:

{
  "name": "<login>'s review style",
  "content": "<full markdown persona document as a single string with \\n for newlines>"
}

The "name" field should be "${login}'s review style".
The "content" field must contain the full persona document.`

  const commentsBlock = comments
    .map((c, i) => `[Comment ${i + 1}]\n${c}`)
    .join('\n\n')

  const user = `GitHub user: ${login}
Total comments to analyze: ${comments.length}

Review comments:

${commentsBlock}`

  return { system, user }
}

// ---------------------------------------------------------------------------
// Strip code fences longer than CODE_FENCE_LINE_LIMIT lines
// ---------------------------------------------------------------------------

export function stripLongFences(body: string): string {
  // Matches ``` optionally followed by a language tag, then content, then ```
  return body.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, inner: string) => {
    const lines = inner.split('\n')
    if (lines.length > CODE_FENCE_LINE_LIMIT) {
      return '' // strip the entire fence block
    }
    return match // keep short fences
  })
}

// ---------------------------------------------------------------------------
// fetchMineableComments — DI-injectable for testability
// ---------------------------------------------------------------------------

export async function fetchMineableComments(
  repo: { owner: string; repo: string },
  deps: MineDeps,
): Promise<MineResult | MineError> {
  const token = deps.getToken()
  if (!token) {
    return { ok: false, error: 'GitHub auth required. Please sign in or add a GitHub token in Settings.' }
  }

  // Step 1: get authenticated user login
  let login: string
  try {
    const user = await deps.ghFetch('/user', token) as { login: string }
    login = user.login
  } catch (err) {
    return { ok: false, error: `Failed to fetch GitHub user: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Step 2: fetch up to 3 pages of PR review comments
  const { owner, repo: repoName } = repo
  const allComments: RawPullComment[] = []

  for (let page = 1; page <= MINE_PAGES; page++) {
    try {
      const path = `/repos/${owner}/${repoName}/pulls/comments?sort=created&direction=desc&per_page=100&page=${page}`
      const raw = await deps.ghFetch(path, token) as RawPullComment[]
      if (!Array.isArray(raw) || raw.length === 0) break
      allComments.push(...raw)
    } catch {
      break // non-fatal — use what we have
    }
  }

  // Step 3: filter by author, cap, strip long fences
  const myComments = allComments
    .filter(c => c.user?.login === login)
    .slice(0, MINE_COMMENTS_CAP)
    .map(c => stripLongFences(c.body).trim())
    .filter(body => body.length > 0)

  if (myComments.length === 0) {
    return { ok: false, error: `No review comments found by @${login} on ${owner}/${repoName}.` }
  }

  return { ok: true, login, comments: myComments }
}

// ---------------------------------------------------------------------------
// Validator for LLM output
// ---------------------------------------------------------------------------

function validateMinedSkill(x: unknown): MinedSkill | null {
  if (typeof x !== 'object' || x === null) return null
  const obj = x as Record<string, unknown>
  if (typeof obj['name'] !== 'string' || !obj['name']) return null
  if (typeof obj['content'] !== 'string' || !obj['content']) return null
  return { name: obj['name'] as string, content: obj['content'] as string }
}

// ---------------------------------------------------------------------------
// mineSkillFromComments — core LLM call
// ---------------------------------------------------------------------------

export interface MineFromCommentsDeps {
  llmJsonWithRepair: typeof LlmJsonFn
}

export async function mineSkillFromComments(
  input: { login: string; comments: string[] },
  deps: MineFromCommentsDeps,
): Promise<MineSkillResult | MineSkillError> {
  const prompts = mineSkillPrompt(input.login, input.comments)

  try {
    const result = await deps.llmJsonWithRepair<MinedSkill>(
      { system: prompts.system, user: prompts.user },
      validateMinedSkill,
    )
    return { ok: true, skill: result }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to generate reviewer skill from comments.',
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level: full pipeline (used by UI)
// Uses real GitHub client + LLM — deps injected for tests.
// ---------------------------------------------------------------------------

export interface MineSkillPipelineDeps {
  llmJsonWithRepair: typeof LlmJsonFn
  /**
   * Override the resolved provider for testing.
   * When omitted, the provider is resolved from the registry using providerId.
   */
  provider?: {
    id: string
    displayName: string
    authState(): { configured: boolean; hint: string }
    getMyAccountReviewComments?(cap: number, repoFilter?: { owner: string; repo: string }): Promise<string[]>
  }
}

/**
 * Mine the authenticated user's recent review comments (account-wide by
 * default) and distill them into a reviewer skill draft.
 *
 * @param repoFilter — optional narrowing to a single repository. When null,
 *   comments are sourced across all repos via the provider's account-scoped path.
 */
export async function mineSkillPipeline(
  providerId: string,
  repoFilter: { owner: string; repo: string } | null,
  deps: MineSkillPipelineDeps,
): Promise<MineSkillResult | MineSkillError> {
  // Resolve provider (from registry or injected override)
  const provider = deps.provider ?? providerFor(providerId)

  // Check provider supports account-scoped mining (capability = method presence)
  if (typeof provider.getMyAccountReviewComments !== 'function') {
    return {
      ok: false,
      error: `Generate from my reviews is not available for ${provider.displayName} yet.`,
    }
  }

  // Check auth
  const auth = provider.authState()
  if (!auth.configured) {
    return { ok: false, error: auth.hint }
  }

  // Fetch comments via provider (account-wide, optionally narrowed to one repo)
  let comments: string[]
  try {
    comments = await provider.getMyAccountReviewComments(MINE_COMMENTS_CAP, repoFilter ?? undefined)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to fetch review comments.',
    }
  }

  if (comments.length === 0) {
    return {
      ok: false,
      error: repoFilter
        ? `No review comments found on ${repoFilter.owner}/${repoFilter.repo}.`
        : 'No recent review comments found for your account.',
    }
  }

  // Distill with LLM — use providerId as login label since providers return only bodies
  const loginLabel = `${providerId}-user`
  return mineSkillFromComments(
    { login: loginLabel, comments },
    { llmJsonWithRepair: deps.llmJsonWithRepair },
  )
}
