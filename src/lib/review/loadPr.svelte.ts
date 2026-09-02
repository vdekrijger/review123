import { getPrMeta as defaultGetPrMeta, getPrFiles as defaultGetPrFiles } from '../github/api'
import { GithubApiError, type PrFile, type PrMeta } from '../github/types'
import type { PrRef } from '../github/parse'
import { track } from '../analytics/analytics'

/** Returns the most-frequent file extension across all files, or 'unknown'.
 *  Dotfiles (e.g. .gitignore) and extensionless files (e.g. Dockerfile) are
 *  excluded so no raw filename ever leaks into analytics. */
export function primaryLanguage(files: PrFile[]): string {
  const counts = new Map<string, number>()
  for (const { filename } of files) {
    const base = filename.split('/').pop() ?? filename
    const dot = base.lastIndexOf('.')
    if (dot <= 0) continue // no dot, or dot is the first char (dotfile)
    const ext = base.slice(dot + 1)
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  if (counts.size === 0) return 'unknown'
  return [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; meta: PrMeta; files: PrFile[] }
  | {
      status: 'error'
      // 'timeout' and 'cancelled' are distinct from 'network' on purpose: the
      // connection was not the problem in either case, so "check your
      // connection" was the wrong thing to tell the user.
      error: 'not-found' | 'unauthorized' | 'forbidden' | 'network' | 'server' | 'timeout' | 'cancelled'
    }
  | { status: 'error'; error: 'rate-limited'; resetAt: Date }

interface Deps {
  getPrMeta: typeof defaultGetPrMeta
  getPrFiles: typeof defaultGetPrFiles
}

export function createPrLoad(
  ref: PrRef,
  deps: Deps = { getPrMeta: defaultGetPrMeta, getPrFiles: defaultGetPrFiles },
) {
  const holder = $state<{ state: LoadState }>({ state: { status: 'loading' } })
  const promise = (async () => {
    try {
      const [meta, files] = await Promise.all([deps.getPrMeta(ref), deps.getPrFiles(ref)])
      holder.state = { status: 'ready', meta, files }
      // Note: this event may fire for an abandoned load (AbortSignal planned in a later milestone).
      track('pr_loaded', {
        visibility: meta.private ? 'private' : 'public',
        file_count: files.length,
        primary_language: primaryLanguage(files),
      })
    } catch (e) {
      if (e instanceof GithubApiError && e.detail.kind === 'rate-limited') {
        holder.state = { status: 'error', error: 'rate-limited', resetAt: e.detail.resetAt }
      } else if (
        e instanceof GithubApiError && (
          e.detail.kind === 'not-found' ||
          e.detail.kind === 'unauthorized' ||
          e.detail.kind === 'forbidden' ||
          e.detail.kind === 'server' ||
          e.detail.kind === 'timeout' ||
          e.detail.kind === 'cancelled'
        )
      ) {
        holder.state = { status: 'error', error: e.detail.kind }
      } else {
        holder.state = { status: 'error', error: 'network' }
      }
    }
  })()
  return { get state() { return holder.state }, promise }
}
