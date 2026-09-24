/**
 * e2e/readiness-basis.spec.ts — the computed readiness grade on Step 3.
 *
 * What this proves in a real browser, which the unit tests cannot:
 *   1. the panel is REACHABLE without hunting — it renders on the Verdict step
 *      with no click, no disclosure and no scrolling into a drawer;
 *   2. it does NOT displace the primary action — it sits above the verdict
 *      radios in document order and the Submit button is still on the page;
 *   3. every input is on screen, each with its own arithmetic, and the
 *      "what this did not check" list and the disclaimer render with it;
 *   4. it survives a 400px-wide window without overflowing horizontally;
 *   5. it renders in both themes.
 *
 * The fixture is deliberately a WEAK review — one reviewer, one model, no
 * verifier, no test run, a high-severity finding standing — because the honest
 * behaviour of a weak review is the thing worth pinning.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

const SKILL_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/feature.ts',
      line: 2,
      severity: 'high',
      body: 'Potential XSS vulnerability: user input is not sanitized',
      suggestedFix: 'Escape it with `sanitizeHtml(input)` before rendering.',
    },
  ],
}

function makePrMeta() {
  return {
    title: 'Test PR: add feature',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 1,
  }
}

function makePrFiles() {
  return [
    { filename: 'src/feature.ts', status: 'modified', patch: PATCH_WITH_LINES, additions: 2, deletions: 1 },
  ]
}

function makeFileContent(text: string) {
  return { content: Buffer.from(text).toString('base64') + '\n', encoding: 'base64' }
}

function makeDeepSeekStreamResponse(text: string): string {
  const lines = text.split(' ').map((word) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }],
    })}`,
  )
  lines.push('data: [DONE]')
  return lines.join('\n') + '\n'
}

const SUMMARY_TEXT = 'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

function seedSettings() {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
    storyMode: false,
    autoRunReviewers: false,
    githubAuth: { token: 'ghp_test_token', method: 'pat', scopes: ['repo'] },
  }
}

function seedSkillScript() {
  return `
    (() => {
      const skill = {
        id: 'skill-e2e-readiness',
        name: 'Security Reviewer',
        content: '## Security\\nCheck for XSS and injection vulnerabilities.',
        scope: 'both',
        addedAt: 1700000000000,
      };
      localStorage.setItem('review123:reviewer-skills', JSON.stringify([skill]));
    })();
  `
}

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) return route.fulfill({ json: makePrMeta() })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) return route.fulfill({ json: makePrFiles() })
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      const ref = url.searchParams.get('ref') ?? ''
      const filePath = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/contents/`, ''))
      if (filePath === 'src/feature.ts' && ref === BASE_SHA) {
        return route.fulfill({ json: makeFileContent('const old = 1\nremoved line\ntrailing context') })
      }
      if (filePath === 'src/feature.ts' && ref === HEAD_SHA) {
        return route.fulfill({
          json: makeFileContent('const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context'),
        })
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path.endsWith('/comments') || path.endsWith('/commits')) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }

    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: makeDeepSeekStreamResponse(SUMMARY_TEXT),
      })
    }

    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    const json = (content: unknown) => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop', index: 0 }],
    })

    if (systemContent.includes('consolidating overlapping code-review findings')) {
      return route.fulfill({ status: 200, json: json({ clusters: [] }) })
    }
    if (systemContent.includes('rewriting code-review findings into plain')) {
      return route.fulfill({ status: 200, json: json({ rewrites: [] }) })
    }
    if (systemContent.includes('reviewer persona') || systemContent.includes('security reviewer')) {
      return route.fulfill({ status: 200, json: json(SKILL_REVIEW_RESULT) })
    }
    return route.fulfill({
      status: 200,
      json: json({ level: 'minor-changes', evidence: ['src/feature.ts modified'], notAnalyzed: [] }),
    })
  })
}

/** Load the PR, run the one reviewer on Step 2, land on Step 3. */
async function reachVerdictStep(page: import('@playwright/test').Page) {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Next step' }).click()
  const runBtn = page.getByRole('button', { name: /run my reviewers \(1\)/i })
  await expect(runBtn).toBeVisible({ timeout: 10_000 })
  await runBtn.click()
  await expect(page.getByText(/Potential XSS vulnerability/i).first()).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('radio', { name: /approve/i })).toBeVisible({ timeout: 10_000 })
}

test('readiness basis: the grade, its inputs and its limits all render on the Verdict step', async ({ page }) => {
  await reachVerdictStep(page)

  const panel = page.locator('[data-testid="readiness-basis"]')
  await expect(panel).toBeVisible()

  // The grade is a WORD about the checking, never a letter about the code.
  const headline = page.locator('[data-testid="readiness-headline"]')
  await expect(headline).toContainText(/checked/i)
  // …and the band and its reason stay separated by a real em-dash with spaces
  // either side (Svelte trims a bare " — " between elements into "—").
  const headlineText = await headline.evaluate((el) => el.textContent ?? '')
  expect(headlineText).toMatch(/checked — /)

  // It says who produced it, which is nobody.
  await expect(page.locator('[data-testid="readiness-provenance"]')).toContainText('No model produced this grade.')

  // Every input is on screen, each carrying its own arithmetic.
  const rows = page.locator('[data-testid="readiness-check"]')
  await expect(rows).toHaveCount(7)
  for (const id of ['reviewers', 'verification', 'findings', 'tests', 'coverage', 'grounding', 'approval']) {
    await expect(panel.locator(`[data-check="${id}"]`)).toBeVisible()
  }

  // The weak inputs of THIS fixture (one model, no verifier, no test run, a
  // high-severity finding standing, nothing signed off) read as unmet.
  await expect(panel.locator('[data-check="tests"]')).toHaveAttribute('data-state', 'unmet')
  await expect(panel.locator('[data-check="tests"]')).toContainText('Nothing here executed the code.')
  await expect(panel.locator('[data-check="verification"]')).toHaveAttribute('data-state', 'unmet')
  await expect(panel.locator('[data-check="approval"]')).toHaveAttribute('data-state', 'unmet')

  // And the limits are stated, not implied.
  const notChecked = page.locator('[data-testid="readiness-notchecked"]')
  await expect(notChecked).toContainText('Only one model looked')
  await expect(notChecked).toContainText('No human has read and approved this implementation here yet.')
  await expect(page.locator('[data-testid="readiness-disclaimer"]')).toContainText('only ever saw a diff')
})

test('readiness basis: sits above the verdict without displacing the primary action', async ({ page }) => {
  await reachVerdictStep(page)

  // Document order: the basis is read, THEN the choice is made.
  const order = await page.evaluate(() => {
    const basis = document.querySelector('[data-testid="readiness-basis"]')
    const fieldset = document.querySelector('.verdict-group')
    if (!basis || !fieldset) return 'missing'
    return basis.compareDocumentPosition(fieldset) & Node.DOCUMENT_POSITION_FOLLOWING ? 'basis-first' : 'verdict-first'
  })
  expect(order).toBe('basis-first')

  // The primary action is still there and still usable.
  const submit = page.getByRole('button', { name: /submit review/i })
  await expect(submit).toBeVisible()
  await expect(submit).toBeEnabled()
})

test('readiness basis: survives a 400px window and renders in both themes', async ({ page }) => {
  await reachVerdictStep(page)
  await page.setViewportSize({ width: 400, height: 900 })

  const panel = page.locator('[data-testid="readiness-basis"]')
  await expect(panel).toBeVisible()

  // Nothing inside the panel pushes the page sideways.
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="readiness-basis"]') as HTMLElement | null
    if (!el) return -1
    return el.scrollWidth - el.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(1)

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const painted = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="readiness-basis"]') as HTMLElement | null
      const disclaimer = document.querySelector('[data-testid="readiness-disclaimer"]') as HTMLElement | null
      if (!el || !disclaimer) return null
      return {
        background: getComputedStyle(el).backgroundColor,
        ink: getComputedStyle(disclaimer).color,
      }
    })
    expect(painted, theme).not.toBeNull()
    // A panel whose ink matches its ground is an invisible panel.
    expect(painted!.ink, theme).not.toBe(painted!.background)
    expect(painted!.background, theme).not.toBe('rgba(0, 0, 0, 0)')
  }
})
