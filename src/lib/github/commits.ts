import { ghFetchPage } from './client'
import type { PrRef } from './parse'

export interface PrCommit {
  sha: string
  shortSha: string
  message: string
  authoredAt: string
}

interface RawCommit {
  sha: string
  commit: {
    message: string
    author: { date: string } | null
  }
}

const MAX_COMMIT_PAGES = 3

/**
 * Fetch all commits for a pull request (paginated, max 3 pages / 300 commits).
 * Only the first line of the commit message is kept.
 */
export async function getPrCommits(ref: PrRef): Promise<PrCommit[]> {
  const all: PrCommit[] = []
  let path: string | null = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits?per_page=100`
  let pages = 0

  while (path !== null && pages < MAX_COMMIT_PAGES) {
    const result: { body: RawCommit[]; next: string | null } = await ghFetchPage<RawCommit[]>(path)
    const { body, next } = result
    for (const raw of body) {
      const firstLine = (raw.commit.message ?? '').split('\n')[0]
      all.push({
        sha: raw.sha,
        shortSha: raw.sha.slice(0, 7),
        message: firstLine,
        authoredAt: raw.commit.author?.date ?? '',
      })
    }
    path = next
    pages++
  }

  return all
}
