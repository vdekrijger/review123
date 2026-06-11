import { ghFetch } from './client'
import { mapPrFile, type RawPrFile } from './api'
import type { PrFile } from './types'

interface CompareResponse {
  files: RawPrFile[]
}

/**
 * Compare two commits in a repository and return the list of changed files.
 *
 * Uses the GitHub compare API: GET /repos/{owner}/{repo}/compare/{base}...{head}
 * 404 → throws GithubApiError as-is (caller handles gracefully).
 */
export async function compareCommits(
  repo: { owner: string; repo: string },
  base: string,
  head: string,
): Promise<PrFile[]> {
  const path = `/repos/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  const data = await ghFetch<CompareResponse>(path)
  return (data.files ?? []).map(mapPrFile)
}
