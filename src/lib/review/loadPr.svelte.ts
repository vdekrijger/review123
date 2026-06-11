import { getPrMeta as defaultGetPrMeta, getPrFiles as defaultGetPrFiles } from '../github/api'
import { GithubApiError, type PrFile, type PrMeta } from '../github/types'
import type { PrRef } from '../github/parse'
import { track } from '../analytics/analytics'

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; meta: PrMeta; files: PrFile[] }
  | { status: 'error'; error: 'not-found' | 'unauthorized' | 'forbidden' | 'network' | 'server' }
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
        primary_language: files[0]?.filename.split('.').pop() ?? 'unknown',
      })
    } catch (e) {
      if (e instanceof GithubApiError && e.detail.kind === 'rate-limited') {
        holder.state = { status: 'error', error: 'rate-limited', resetAt: e.detail.resetAt }
      } else if (
        e instanceof GithubApiError && (
          e.detail.kind === 'not-found' ||
          e.detail.kind === 'unauthorized' ||
          e.detail.kind === 'forbidden' ||
          e.detail.kind === 'server'
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
