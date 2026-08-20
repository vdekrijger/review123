/**
 * src/lib/github/reviewExport.ts — turn a drafted review into a self-contained,
 * paste-ready command that posts the WHOLE review (overall comment + verdict +
 * every drafted line comment, at the correct files/lines) to the GitHub PR
 * WITHOUT installing the OAuth app.
 *
 * DETERMINISTIC + PURE: no network, no DOM, no analytics. Mirrors the builder
 * pattern of `src/lib/ai/reviewPrompt.ts`. The single source of truth is
 * `buildReviewPayload`, which reproduces `submitReview`'s request body EXACTLY
 * (see src/lib/github/review.ts):
 *
 *   POST https://api.github.com/repos/{owner}/{repo}/pulls/{number}/reviews
 *   { commit_id, body, event, comments? }
 *
 * where each comment is
 *   { path, line, side, body,
 *     ...(startLine != null && startLine < line
 *           ? { start_line, start_side } : {}) }
 * and the `comments` key is OMITTED entirely when there are no drafts.
 *
 * Off-diff coherence: when `files` (patches) are provided, the payload applies
 * the SAME split as submitReview (anchorSplit): only anchorable drafts ride
 * `comments`; off-diff drafts are folded into the body's marked section — a
 * one-shot command cannot post file-level comments, and leaving them in
 * comments[] would make the exported command 422.
 *
 * Three formatters wrap that ONE payload:
 *   - buildBrowserConsoleSnippet — JS to paste into devtools (PAT via prompt()).
 *     GitHub's REST API sends CORS headers so a token-auth fetch works
 *     cross-origin. JSON is valid JS, so bodies (quotes/backticks/$/newlines)
 *     are embedded as a JS object literal with NO shell-quoting hazards.
 *   - buildGhCommand — `gh api --method POST … --input -` with a single-quoted
 *     heredoc. Uses the user's existing `gh` login → no token needed.
 *   - buildCurlScript — bash reading `$GITHUB_TOKEN`, single-quoted heredoc.
 *
 * Single-quoted heredocs (`<<'REVIEW_PAYLOAD'`) keep the JSON literal: no shell
 * expansion of `$`, no interpretation of quotes/backticks/backslashes. Comment
 * bodies are already JSON-escaped inside the payload, so they round-trip intact.
 */

import type { Draft } from '../drafts/drafts.svelte'
import { outgoingCommentBody } from '../drafts/drafts.svelte'
import type { Verdict } from './review'
import { splitDraftsByAnchor, foldOffDiffIntoBody, type PatchFile } from './anchorSplit'

/** The exact GitHub "create a review" request body (matches submitReview). */
export interface ReviewPayload {
  commit_id: string
  body: string
  event: Verdict
  comments?: ReviewPayloadComment[]
}

export interface ReviewPayloadComment {
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}

/** Identity + content needed to build the review payload. */
export interface ReviewExportInput {
  owner: string
  repo: string
  number: number
  commitId: string
  verdict: Verdict
  /** Overall review comment (may be empty). */
  body: string
  drafts: Draft[]
  /**
   * The PR's changed files (patch text) — enables the same off-diff split
   * submitReview performs. A one-shot exported command cannot post file-level
   * comments, so off-diff drafts are folded into the review body's marked
   * section instead (honest + the command cannot 422 on a bad anchor).
   * Empty/omitted → no split (all drafts ride comments[], as before).
   */
  files?: readonly PatchFile[]
}

/** The heredoc delimiter used by the gh / curl formatters. */
const HEREDOC = 'REVIEW_PAYLOAD'

/**
 * Build the EXACT GitHub review request body — the single source the three
 * formatters share. Reproduces submitReview's rules:
 *   - `comments` omitted entirely when there are no drafts,
 *   - start_line/start_side added only when startLine != null && startLine < line.
 */
export function buildReviewPayload(input: ReviewExportInput): ReviewPayload {
  // Same split as submitReview: comments[] carries only anchorable drafts;
  // off-diff drafts fold into the body (a single POST has nowhere else to
  // put them — create-review comments[] rejects off-diff lines with a 422).
  const { inline, offDiff } = splitDraftsByAnchor(input.drafts, input.files ?? [])

  const payload: ReviewPayload = {
    commit_id: input.commitId,
    body: foldOffDiffIntoBody(
      input.body,
      offDiff.map((d) => ({ draft: d, outgoingBody: outgoingCommentBody(d) })),
    ),
    event: input.verdict,
  }

  if (inline.length > 0) {
    payload.comments = inline.map((d) => ({
      path: d.path,
      line: d.line,
      side: d.side,
      body: outgoingCommentBody(d),
      ...(d.startLine != null && d.startLine < d.line
        ? { start_line: d.startLine, start_side: d.side }
        : {}),
    }))
  }

  return payload
}

/** The reviews endpoint path for this PR (no host). */
function reviewsPath(input: ReviewExportInput): string {
  return `/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews`
}

/** The absolute reviews endpoint URL. */
function reviewsUrl(input: ReviewExportInput): string {
  return `https://api.github.com${reviewsPath(input)}`
}

/**
 * Format 1 — Browser console (default, safest).
 *
 * A JS snippet to paste into the browser devtools Console on ANY page. JSON is
 * valid JS, so the payload is embedded as an object literal — no shell quoting,
 * no escaping pitfalls. The PAT is prompted for (or can be hardcoded).
 */
export function buildBrowserConsoleSnippet(input: ReviewExportInput): string {
  const payload = buildReviewPayload(input)
  const payloadJson = JSON.stringify(payload, null, 2)
  const url = reviewsUrl(input)

  return [
    '// Paste into your browser\'s devtools Console (any page) and run.',
    '// Needs a GitHub PAT; nothing is sent anywhere except api.github.com.',
    '// Tip: replace the prompt() below with your token string to hardcode it.',
    'const TOKEN = prompt("Paste a GitHub PAT with repo / pull-request write scope:");',
    'if (!TOKEN) { throw new Error("No token provided — review not posted."); }',
    `const PAYLOAD = ${payloadJson};`,
    `fetch(${JSON.stringify(url)}, {`,
    '  method: "POST",',
    '  headers: {',
    '    "Authorization": "Bearer " + TOKEN,',
    '    "Accept": "application/vnd.github+json",',
    '    "X-GitHub-Api-Version": "2022-11-28",',
    '  },',
    '  body: JSON.stringify(PAYLOAD),',
    '})',
    '  .then(async (r) => {',
    '    const text = await r.text();',
    '    if (r.ok) {',
    '      let url = "";',
    '      try { url = JSON.parse(text).html_url || ""; } catch {}',
    '      console.log("\\u2713 Review posted", url);',
    '    } else {',
    '      console.error("\\u2717 " + r.status + " " + text);',
    '    }',
    '  })',
    '  .catch((e) => console.error("\\u2717 Request failed", e));',
    '',
  ].join('\n')
}

/**
 * Format 2 — gh CLI.
 *
 * `gh api --method POST … --input -` with a single-quoted heredoc carrying the
 * literal JSON. Uses the user's existing `gh auth login` → no token needed.
 */
export function buildGhCommand(input: ReviewExportInput): string {
  const payload = buildReviewPayload(input)
  const payloadJson = JSON.stringify(payload, null, 2)
  const path = reviewsPath(input)

  return [
    '# Requires the GitHub CLI (`gh auth login`). No token needed.',
    `gh api --method POST -H "Accept: application/vnd.github+json" "${path}" --input - <<'${HEREDOC}'`,
    payloadJson,
    HEREDOC,
    '',
  ].join('\n')
}

/**
 * Format 3 — curl.
 *
 * A bash script that checks `$GITHUB_TOKEN`, then POSTs the literal JSON via a
 * single-quoted heredoc. For terminal users without `gh`.
 */
export function buildCurlScript(input: ReviewExportInput): string {
  const payload = buildReviewPayload(input)
  const payloadJson = JSON.stringify(payload, null, 2)
  const url = reviewsUrl(input)

  return [
    '#!/usr/bin/env bash',
    '# Posts your review to the GitHub PR via curl. For terminal users without gh.',
    'set -euo pipefail',
    'if [ -z "${GITHUB_TOKEN:-}" ]; then',
    '  echo "GITHUB_TOKEN is not set. Export a token with repo / pull-request write scope:" >&2',
    '  echo "  export GITHUB_TOKEN=ghp_xxx" >&2',
    '  echo "A fine-grained PAT sidesteps org OAuth-app restrictions." >&2',
    '  exit 1',
    'fi',
    `if curl -sS -X POST \\`,
    '  -H "Authorization: Bearer $GITHUB_TOKEN" \\',
    '  -H "Accept: application/vnd.github+json" \\',
    '  -H "X-GitHub-Api-Version: 2022-11-28" \\',
    '  --fail-with-body \\',
    `  ${url} \\`,
    `  --data @- <<'${HEREDOC}'`,
    payloadJson,
    HEREDOC,
    'then',
    '  echo "\\u2713 Review posted."',
    'else',
    '  echo "\\u2717 Failed to post review (see response above)." >&2',
    '  exit 1',
    'fi',
    '',
  ].join('\n')
}

/** The three export formats, keyed by id. */
export type ReviewExportFormat = 'browser' | 'gh' | 'curl'

/** Build the selected format from the input. */
export function buildReviewCommand(format: ReviewExportFormat, input: ReviewExportInput): string {
  switch (format) {
    case 'gh':
      return buildGhCommand(input)
    case 'curl':
      return buildCurlScript(input)
    case 'browser':
    default:
      return buildBrowserConsoleSnippet(input)
  }
}
