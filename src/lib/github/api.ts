import { ghFetch, ghFetchPage } from './client'
import { GithubApiError, type PrFile, type PrMeta } from './types'
import type { PrRef } from './parse'

interface RawPrFile {
  filename: string
  status: PrFile['status']
  previous_filename?: string
  patch?: string
  additions: number
  deletions: number
}

interface RawPr {
  title: string; state: 'open' | 'closed'; merged: boolean; body: string | null
  base: { sha: string; repo?: { private: boolean } }
  head: { sha: string }
  changed_files: number
}

export async function getPrMeta(ref: PrRef): Promise<PrMeta> {
  const pr = await ghFetch<RawPr>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)
  return {
    title: pr.title, state: pr.state, merged: pr.merged, body: pr.body,
    baseSha: pr.base.sha, headSha: pr.head.sha,
    private: pr.base.repo?.private ?? false,
    changedFiles: pr.changed_files,
  }
}

const MAX_PAGES = 50 // defensive cap against malformed Link cycles (~5 000 files)

function mapPrFile(raw: RawPrFile): PrFile {
  return {
    filename: raw.filename,
    status: raw.status,
    ...(raw.previous_filename ? { previousFilename: raw.previous_filename } : {}),
    ...(raw.patch !== undefined ? { patch: raw.patch } : {}),
    additions: raw.additions,
    deletions: raw.deletions,
  }
}

// EC-05i; MAX_PAGES caps runaway Link cycles.
export async function getPrFiles(ref: PrRef): Promise<PrFile[]> {
  const all: PrFile[] = []
  let path: string | null = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`
  let pages = 0
  while (path !== null && pages < MAX_PAGES) {
    const { body, next }: { body: RawPrFile[]; next: string | null } = await ghFetchPage<RawPrFile[]>(path)
    all.push(...body.map(mapPrFile))
    path = next
    pages++
  }
  return all
}

export async function getFileAtRef(
  repo: { owner: string; repo: string }, filePath: string, ref: string,
): Promise<string | null> {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  try {
    const data = await ghFetch<{ content: string; encoding: string }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    )
    if (data.encoding !== 'base64') return null
    return decodeBase64(data.content)
  } catch (e) {
    if (e instanceof GithubApiError && e.detail.kind === 'not-found') return null
    throw e
  }
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
