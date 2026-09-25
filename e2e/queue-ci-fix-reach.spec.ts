/**
 * e2e/queue-ci-fix-reach.spec.ts — can you actually GET to Fix CI?
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS FOR
 *
 * queue-ci-fix.spec.ts pins what the flow DOES. This file pins that the flow is
 * REACHABLE, which is a different property and the one that was broken.
 *
 * The readiness rule used to compare the bridge's HEAD to the pull request's
 * head for equality. A checkout sits on one commit at a time, so on a queue of
 * the user's own pull requests AT MOST ONE ROW could ever offer the control —
 * and in the ordinary case, where the user is working on something else
 * entirely, none could. The feature shipped and could not be got at.
 *
 * `git worktree add … <sha>` materialises the commit out of the LOCAL OBJECT
 * STORE, so the real precondition is containment: does this repository HAVE the
 * commit? Every branch the user has pushed from this machine passes, whatever
 * their checkout is doing.
 *
 * THE FIXTURE IS THE SCENARIO THE BUG WAS REPORTED FROM: four of the user's own
 * pull requests, all red, and a bridge sitting on `main` — on NONE of their
 * heads. Three of the four are in the object store; the fourth was opened from
 * another machine and has never been fetched here.
 *
 *   before: 0 rows could offer Fix CI.
 *   after:  3 — and the fourth refuses SPECIFICALLY, with the one command that
 *           fixes it, rather than with the old "your checkout is elsewhere".
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The bridge is stubbed at `window.fetch`, for the reason queue-ci-fix.spec.ts
 * and bridge.spec.ts give: the real calls are cross-origin to 127.0.0.1 with an
 * Authorization header, and intercepting them would drag CORS into assertions
 * that are not about CORS.
 */
import { test, expect, type Page } from '@playwright/test'

const OWNER = 'acme'
const REPO = 'web'

/** Where the bridge's checkout actually is: `main`, which is none of them. */
const MAIN = 'f'.repeat(38) + 'ff'

interface Row {
  number: number
  title: string
  head: string
  /** Is the commit in the local object store? */
  local: boolean
}

const ROWS: Row[] = [
  { number: 101, title: 'fix: the boundary check', head: 'a'.repeat(38) + '01', local: true },
  { number: 102, title: 'feat: add the retry path', head: 'a'.repeat(38) + '02', local: true },
  { number: 103, title: 'chore: bump the toolchain', head: 'a'.repeat(38) + '03', local: true },
  // Opened from a different machine. This repository has never seen it.
  { number: 104, title: 'docs: rewrite the readme', head: 'a'.repeat(38) + '04', local: false },
]

const PRESENT = ROWS.filter((r) => r.local).map((r) => r.head)

/** What the bridge was asked, so a test can prove it was asked ONCE. */
interface BridgeSeen {
  calls: string[]
  commitRequests: string[][]
}

async function seedGithub(page: Page) {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const request = route.request()
    const { pathname, searchParams } = new URL(request.url())

    if (pathname === '/graphql') {
      const query = (JSON.parse(request.postData() ?? '{}') as { query?: string }).query ?? ''
      const isMergeState = !query.includes('reviewThreads')
      const data: Record<string, unknown> = {}
      for (const [, alias, number] of query.matchAll(/(p\d+): repository\([\s\S]*?pullRequest\(number: (\d+)\)/g)) {
        const row = ROWS.find((r) => String(r.number) === number)
        if (!row) continue
        data[alias] = isMergeState
          ? { pullRequest: { mergeStateStatus: 'CLEAN' } }
          : {
              viewerPermission: 'WRITE',
              pullRequest: {
                additions: 12,
                deletions: 3,
                mergeable: 'MERGEABLE',
                headRefOid: row.head,
                reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
                // EVERY row is red. That is the state the user described.
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
              },
            }
      }
      return route.fulfill({ json: { data } })
    }

    if (pathname === '/search/issues') {
      // All four are the viewer's OWN, and nothing is awaiting their review —
      // Fix CI is only ever offered on a branch they can push to.
      const mine = (searchParams.get('q') ?? '').includes('author:')
      const items = mine
        ? ROWS.map((r) => ({
            number: r.number,
            title: r.title,
            updated_at: new Date(Date.now() - 60_000).toISOString(),
            repository_url: `https://api.github.com/repos/${OWNER}/${REPO}`,
          }))
        : []
      return route.fulfill({ json: { total_count: items.length, items } })
    }

    if (pathname.endsWith('/check-runs')) {
      return route.fulfill({
        json: {
          total_count: 1,
          check_runs: [{
            id: 9001,
            name: 'unit (node 22)',
            status: 'completed',
            conclusion: 'failure',
            html_url: `https://github.com/${OWNER}/${REPO}/runs/9001`,
          }],
        },
      })
    }
    if (pathname.endsWith('/annotations')) {
      return route.fulfill({ json: [{ message: 'src/a.ts:12 expected 1 to be 2' }] })
    }
    return route.fulfill({ json: [] })
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    githubAuth: { token: 'ghp_reach', method: 'pat', scopes: [] },
    deepseekKey: 'sk-reach',
    aiProvider: 'deepseek',
  })
}

/**
 * A paired bridge sitting on `main`, which is NONE of the four heads, that can
 * answer the containment question.
 *
 * `answerCommits: false` models a bridge from before `/v1/commits`: the flag is
 * off and the route 404s, so the client must fall back to the old equality test
 * rather than reading the 404 as "absent" for every row.
 */
async function seedBridge(page: Page, answerCommits: boolean) {
  await page.addInitScript(
    ({ key, present, mainSha, canAnswer }) => {
      localStorage.setItem(key, JSON.stringify({ token: 'e2e-reach-token', port: 7321 }))
      const seen: BridgeSeen = { calls: [], commitRequests: [] }
      ;(window as unknown as { __bridge: BridgeSeen }).__bridge = seen
      const realFetch = window.fetch.bind(window)
      const json = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)
        const path = new URL(url).pathname
        seen.calls.push(path)
        if (path === '/v1/health') {
          return json({
            ok: true,
            protocol: 1,
            root: 'web',
            version: canAnswer ? '0.5.0' : '0.4.0',
            capabilities: {
              inference: ['claude'],
              infer: true,
              inferStream: true,
              inferAgentic: true,
              files: true,
              search: true,
              commits: canAnswer,
              fix: true,
              checkout: false,
              push: false,
            },
            // THE WHOLE POINT: the checkout is on main, not on any PR head.
            git: { head: mainSha, branch: 'main', dirty: true },
          })
        }
        if (path === '/v1/commits') {
          const asked = (JSON.parse(String(init?.body ?? '{}')) as { shas?: string[] }).shas ?? []
          seen.commitRequests.push(asked)
          if (!canAnswer) return Promise.resolve(new Response('{}', { status: 404 }))
          return json({ ok: true, present: asked.filter((s) => present.includes(s)) })
        }
        return Promise.resolve(new Response('{}', { status: 404 }))
      }
    },
    { key: 'review123:bridge', present: PRESENT, mainSha: MAIN, canAnswer: answerCommits },
  )
}

function bridgeSeen(page: Page): Promise<BridgeSeen> {
  return page.evaluate(() => (window as unknown as { __bridge: BridgeSeen }).__bridge)
}

function row(page: Page, number: number) {
  return page.locator('.queue-item', { hasText: `#${number}` })
}

test('Fix CI is offered on EVERY red row whose commit the repo has, with the checkout on main', async ({ page }) => {
  await seedGithub(page)
  await seedBridge(page, true)
  await page.goto('/')
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })

  // Three, not one. Under the old equality rule this was ZERO: the checkout is
  // on main, which is none of these four commits.
  await expect(page.getByTestId('queue-ci-fix')).toHaveCount(3, { timeout: 20_000 })
  for (const r of ROWS.filter((x) => x.local)) {
    await expect(row(page, r.number).getByTestId('queue-ci-fix')).toBeVisible()
  }
  // And NOT on the one this repository has never fetched — a control that opens
  // a panel whose only content is a refusal is a control that fails.
  await expect(row(page, 104).getByTestId('queue-ci-fix')).toHaveCount(0)

  // ONE request answered the whole page, and it asked about all four.
  const seen = await bridgeSeen(page)
  const probes = seen.calls.filter((c) => c === '/v1/commits')
  expect(probes).toHaveLength(1)
  expect([...seen.commitRequests[0]!].sort()).toEqual([...ROWS.map((r) => r.head)].sort())
})

test('the panel opens and does not refuse, on a row the checkout is not sitting on', async ({ page }) => {
  await seedGithub(page)
  await seedBridge(page, true)
  await page.goto('/')
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })

  await row(page, 102).getByTestId('queue-ci-fix').click()
  await expect(page.getByTestId('ci-fix-panel')).toBeVisible({ timeout: 10_000 })
  // The readiness sentence is the refusal. Its absence is the assertion.
  await expect(page.getByTestId('ci-fix-readiness')).toHaveCount(0)
  await expect(page.getByTestId('ci-fix-start')).toBeVisible()
})

test('a bridge too old to answer behaves exactly as it always did', async ({ page }) => {
  await seedGithub(page)
  await seedBridge(page, false)
  await page.goto('/')
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })
  // Wait for the signals, so "no control" is a settled answer rather than a
  // measurement taken before the row could have drawn one.
  await expect(page.getByTestId('queue-ci')).toHaveCount(ROWS.length, { timeout: 20_000 })

  // The old rule, unchanged: the checkout is on main, so no row qualifies. The
  // 404 must NOT be read as "absent" — that would be the same outcome by
  // accident, so the assertion that matters is the one below it.
  await expect(page.getByTestId('queue-ci-fix')).toHaveCount(0)
  // Nothing was sent at all: the capability flag is off, so the client never
  // calls a route it knows is not there.
  expect((await bridgeSeen(page)).calls.filter((c) => c === '/v1/commits')).toHaveLength(0)
})
