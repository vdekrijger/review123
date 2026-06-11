export interface PrMeta {
  title: string
  state: 'open' | 'closed'
  merged: boolean
  body: string | null
  baseSha: string
  headSha: string
  private: boolean
  changedFiles: number
}

export interface PrFile {
  filename: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  previousFilename?: string
  patch?: string // absent for binary / very large files (EC-05j)
  additions: number
  deletions: number
}

export type GithubError =
  | { kind: 'not-found' }          // 404 — also masks private w/o auth (EC-05b)
  | { kind: 'unauthorized' }       // 401 — bad/expired token (EC-04c/e)
  | { kind: 'rate-limited'; resetAt: Date } // EC-05c
  | { kind: 'forbidden' }          // other 403
  | { kind: 'server'; status: number }
  | { kind: 'network' }

export class GithubApiError extends Error {
  constructor(public readonly detail: GithubError) {
    super(`github: ${detail.kind}`)
  }
}
