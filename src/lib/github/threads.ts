import { getSettings } from '../settings/settings'
import type { PrRef } from './parse'

const GRAPHQL_URL = 'https://api.github.com/graphql'

const RESOLVED_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 50) {
            nodes {
              databaseId
            }
          }
        }
      }
    }
  }
}
`

interface ThreadNode {
  isResolved: boolean
  comments: {
    nodes: Array<{ databaseId: number }>
  }
}

interface GraphQLResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: ThreadNode[]
        }
      }
    }
  } | null
  errors?: unknown[]
}

/**
 * Fetches the set of comment databaseIds that belong to resolved review threads.
 *
 * Tokenless degradation: if no auth token is configured, returns an empty Set
 * immediately without making a network call (resolved state just won't be shown).
 *
 * Non-fatal: any HTTP failure or GraphQL error returns an empty Set so the app
 * continues to function without resolved-thread indicators.
 */
export async function getResolvedCommentIds(ref: PrRef): Promise<Set<number>> {
  const auth = getSettings().githubAuth
  if (!auth) return new Set()

  const { owner, repo, number } = ref

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        query: RESOLVED_THREADS_QUERY,
        variables: { owner, repo, number },
      }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!res.ok) return new Set()

    const json = (await res.json()) as GraphQLResponse

    if (json.errors) return new Set()

    const nodes =
      json.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []

    const ids = new Set<number>()
    for (const thread of nodes) {
      if (thread.isResolved) {
        for (const comment of thread.comments.nodes) {
          ids.add(comment.databaseId)
        }
      }
    }
    return ids
  } catch {
    return new Set()
  }
}
