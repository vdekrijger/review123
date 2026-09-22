/**
 * e2e/standing-rules.spec.ts — the standing-rules knowledge base, end to end.
 *
 * The round trip this spec owns:
 *   seeded corpus → cost preview → stubbed distillation → rules render with
 *   their evidence → accept one, reject one → the export carries EXACTLY the
 *   accepted one.
 *
 * The corpus is seeded entirely from localStorage: the dismissal ledger (#230)
 * is a local stream, so the whole feature is exercisable without a GitHub
 * token — which also proves the partial-harvest path renders honestly instead
 * of pretending the history was complete.
 *
 * The DeepSeek route dispatches on the standing-rules prompt marker, the same
 * way every other AI spec here does.
 */

import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CALIBRATION_KEY = 'review123:skill-calibration'
const SETTINGS_KEY = 'review123:settings'
const RULES_KEY = 'review123:standing-rules'
const DECISIONS_KEY = 'review123:standing-rule-decisions'

/** The rule the user will ACCEPT. */
const KEPT_RULE = 'Put domain logic in the domain module, never in a route handler.'
/** The rule the user will REJECT — it must not reach the export. */
const REJECTED_RULE = 'Do not flag missing JSDoc on internal helpers.'

const DISTILLED = {
  rules: [
    {
      rule: KEPT_RULE,
      kind: 'do',
      occurrences: 5,
      evidence: [{ source: 'review-comment', excerpt: 'this belongs in the domain layer' }],
    },
    {
      rule: REJECTED_RULE,
      kind: 'avoid',
      occurrences: 3,
      evidence: [{ source: 'dismissal', excerpt: 'missing jsdoc on an internal helper' }],
    },
  ],
}

function makeDeepSeekJsonResponse(payload: unknown) {
  return {
    id: 'chatcmpl-standing-rules',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 200, total_tokens: 1400 },
  }
}

/**
 * Seed a corpus big enough to clear the "not enough signal" floor, using only
 * local state: 14 dismissed finding patterns across two reviewers.
 */
async function seedCorpus(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ([calibrationKey, settingsKey]) => {
      const entries = (prefix: string, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          pattern: `${prefix} pattern ${i}`,
          reason: i % 2 === 0 ? 'not-real' : 'not-worth',
          addedAt: 1_700_000_000_000 + i,
          findingDigest: `${prefix}-${i}`,
        }))
      localStorage.setItem(
        calibrationKey,
        JSON.stringify({ 'skill-a': entries('alpha', 7), 'skill-b': entries('beta', 7) }),
      )
      localStorage.setItem(
        settingsKey,
        JSON.stringify({ aiProvider: 'deepseek', deepseekKey: 'sk-e2e-standing-rules' }),
      )
    },
    [CALIBRATION_KEY, SETTINGS_KEY],
  )
}

/**
 * Lets ONE distillation request hang, so the in-flight state is real and the
 * Cancel has something to stop. `release` is filled in while the request is
 * parked; calling it lets the handler finish after the browser has already
 * dropped the request.
 */
type HangControl = { on: boolean; release: (() => void) | null }

async function stubExternal(page: import('@playwright/test').Page, hang?: HangControl) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  // No GitHub token is seeded, so the harvest degrades to the local streams.
  await page.route('**/api.github.com/**', (route) => route.abort())

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body — fall through to the default below
    }
    const system = body?.messages?.find((m) => m.role === 'system')?.content ?? ''
    if (system.includes("turning a reviewer's own past corrections into standing orders")) {
      if (hang?.on) {
        await new Promise<void>((resolve) => {
          hang.release = resolve
        })
        try {
          return await route.abort('failed')
        } catch {
          // The page aborted it first — that IS the cancel under test.
          return
        }
      }
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeDeepSeekJsonResponse(DISTILLED)),
      })
    }
    return route.abort()
  })
}

async function openStandingRules(page: import('@playwright/test').Page) {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })
  const section = page.getByTestId('standing-rules-section')
  await expect(section).toBeVisible()
  return section
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test.describe('standing rules', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('preview → distil → accept one, reject one → export carries exactly the accepted rule', async ({
    page,
  }) => {
    await stubExternal(page)
    await seedCorpus(page)

    const section = await openStandingRules(page)

    // It promises not to write anything, before anything has run.
    await expect(section).toContainText(/Nothing is written to any file on your machine/i)

    // COST HONESTY: nothing has run yet; the preview comes first.
    await expect(page.getByTestId('standing-rules-result')).toHaveCount(0)
    await section.getByRole('button', { name: /check what's there/i }).click()

    const cost = page.getByTestId('standing-rules-cost')
    await expect(cost).toBeVisible({ timeout: 5_000 })
    await expect(cost).toContainText('14 dismissals')
    await expect(cost).toContainText(/input tokens/)
    // The harvest was partial (no GitHub token) and says so rather than
    // pretending the whole history was read.
    await expect(page.getByTestId('standing-rules-partial')).toBeVisible()

    // The route is stated: no bridge is paired here, so it names the API.
    await expect(page.getByTestId('standing-rules-route')).toContainText(/over the API/i)

    // Only NOW does the call happen.
    await section.getByRole('button', { name: /distil rules/i }).click()
    await expect(page.getByTestId('standing-rules-result')).toBeVisible({ timeout: 15_000 })

    // Both kinds render, under headings that read differently.
    await expect(page.getByTestId('standing-rules-group-do')).toContainText(/keep asking for/i)
    await expect(page.getByTestId('standing-rules-group-avoid')).toContainText(/keep rejecting/i)

    // The evidence is attached so the user can judge the pattern.
    const cards = page.getByTestId('standing-rule')
    await expect(cards).toHaveCount(2)
    await expect(cards.first()).toContainText('Seen 5 times')
    await expect(cards.first()).toContainText('this belongs in the domain layer')

    // Accept the first rule.
    await cards.first().getByRole('button', { name: /accept rule/i }).click()
    await expect(page.getByTestId('standing-rule-decided')).toContainText(/accepted/i)

    // Reject the second — it leaves the list and is remembered.
    await page.getByTestId('standing-rule').filter({ hasText: REJECTED_RULE })
      .getByRole('button', { name: /reject rule/i }).click()
    await expect(page.getByTestId('standing-rule')).toHaveCount(1)
    await expect(page.getByTestId('standing-rules-rejections')).toContainText(/1 rejected rule/)

    // THE EXPORT: exactly the accepted rule, with a one-line provenance header.
    const preview = page.getByTestId('standing-rules-preview')
    await expect(preview).toContainText('## Standing rules')
    await expect(preview).toContainText('_Distilled by review123 on')
    await expect(preview).toContainText(`- ${KEPT_RULE}`)
    await expect(preview).not.toContainText(REJECTED_RULE)
    await expect(preview).toContainText('### Always')
    await expect(preview).not.toContainText('### Never')

    // …and the same text reaches the clipboard.
    await section.getByRole('button', { name: /copy to clipboard/i }).click()
    await expect(page.getByTestId('standing-rules-exported')).toContainText(/copied/i)
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip).toContain(KEPT_RULE)
    expect(clip).not.toContain(REJECTED_RULE)
    expect(clip.startsWith('## Standing rules')).toBe(true)

    // Both decisions persisted, and the distillation is cached for next time.
    const persisted = await page.evaluate(
      ([rulesKey, decisionsKey]) => ({
        rules: localStorage.getItem(rulesKey),
        decisions: localStorage.getItem(decisionsKey),
      }),
      [RULES_KEY, DECISIONS_KEY],
    )
    expect(persisted.rules).toContain(KEPT_RULE)
    const decisions = JSON.parse(persisted.decisions ?? '{}') as Record<string, { status: string }>
    expect(Object.values(decisions).map((d) => d.status).sort()).toEqual(['accepted', 'rejected'])
  })

  test('a rejected rule survives a reload and is not re-proposed by a re-run', async ({ page }) => {
    await stubExternal(page)
    await seedCorpus(page)

    const section = await openStandingRules(page)
    await section.getByRole('button', { name: /check what's there/i }).click()
    await expect(page.getByTestId('standing-rules-cost')).toBeVisible({ timeout: 5_000 })
    await section.getByRole('button', { name: /distil rules/i }).click()
    await expect(page.getByTestId('standing-rules-result')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('standing-rule').filter({ hasText: REJECTED_RULE })
      .getByRole('button', { name: /reject rule/i }).click()
    await expect(page.getByTestId('standing-rule')).toHaveCount(1)

    // A reload: the decision is persisted, not merely in component state.
    await page.reload()
    await expect(page.getByTestId('standing-rules-result')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('standing-rule')).toHaveCount(1)

    // A RE-RUN returns both rules from the model, and still proposes only one.
    await page.getByTestId('standing-rules-section').getByRole('button', { name: /check what's there/i }).click()
    await expect(page.getByTestId('standing-rules-cost')).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('standing-rules-section').getByRole('button', { name: /re-run/i }).click()
    await expect(page.getByTestId('standing-rule')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.getByTestId('standing-rule')).toContainText(KEPT_RULE)
  })

  test('a run in flight can be STOPPED — calmly, without losing the rules already there', async ({
    page,
  }) => {
    // The distillation is one multi-minute call over the bridge. This is the
    // whole point of the Cancel: the user changes their mind, and pays nothing
    // for it — not the spinner, not the rules they already decided on.
    const hang: HangControl = { on: false, release: null }
    await stubExternal(page, hang)
    await seedCorpus(page)

    const section = await openStandingRules(page)
    await section.getByRole('button', { name: /check what's there/i }).click()
    await expect(page.getByTestId('standing-rules-cost')).toBeVisible({ timeout: 5_000 })

    // A first, complete run — the result the cancel must not destroy.
    await section.getByRole('button', { name: /distil rules/i }).click()
    await expect(page.getByTestId('standing-rules-result')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('standing-rule').first().getByRole('button', { name: /accept rule/i }).click()
    await expect(page.getByTestId('standing-rule-decided')).toContainText(/accepted/i)

    // No Cancel while nothing is running.
    await expect(page.getByTestId('standing-rules-cancel')).toHaveCount(0)

    // A second run, parked in flight.
    hang.on = true
    await section.getByRole('button', { name: /re-run/i }).click()
    const cancel = page.getByTestId('standing-rules-cancel')
    await expect(cancel).toBeVisible({ timeout: 10_000 })

    // Keyboard-operable: focused and activated without a mouse.
    await cancel.focus()
    await page.keyboard.press('Enter')

    // CALM: a status line, never the error chip.
    await expect(page.getByTestId('standing-rules-cancelled')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('standing-rules-cancelled')).toContainText(/cancelled before it finished/i)
    await expect(page.getByTestId('standing-rules-error')).toHaveCount(0)
    await expect(page.getByTestId('standing-rules-cancel')).toHaveCount(0)

    // The previous distillation and its decision are untouched, on screen and
    // in storage.
    await expect(page.getByTestId('standing-rules-result')).toBeVisible()
    await expect(page.getByTestId('standing-rule')).toHaveCount(2)
    await expect(page.getByTestId('standing-rule-decided')).toContainText(/accepted/i)
    expect(await page.evaluate((k) => localStorage.getItem(k), RULES_KEY)).toContain(KEPT_RULE)

    // Let the parked request go, and re-run: no stuck state, no stale note.
    hang.on = false
    hang.release?.()
    await section.getByRole('button', { name: /re-run/i }).click()
    await expect(page.getByTestId('standing-rules-cancelled')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId('standing-rule')).toHaveCount(2)
    await expect(page.getByTestId('standing-rules-result')).toBeVisible()
  })

  test('a thin corpus says so instead of inventing rules, and the run stays disabled', async ({
    page,
  }) => {
    await stubExternal(page)
    await page.addInitScript(
      ([calibrationKey, settingsKey]) => {
        localStorage.setItem(
          calibrationKey,
          JSON.stringify({
            'skill-a': [
              { pattern: 'a lone nitpick', reason: 'not-worth', addedAt: 1, findingDigest: 'x1' },
              { pattern: 'another nitpick', reason: 'not-real', addedAt: 2, findingDigest: 'x2' },
            ],
          }),
        )
        localStorage.setItem(
          settingsKey,
          JSON.stringify({ aiProvider: 'deepseek', deepseekKey: 'sk-e2e-standing-rules' }),
        )
      },
      [CALIBRATION_KEY, SETTINGS_KEY],
    )

    const section = await openStandingRules(page)
    await section.getByRole('button', { name: /check what's there/i }).click()

    const blocked = page.getByTestId('standing-rules-blocked')
    await expect(blocked).toBeVisible({ timeout: 5_000 })
    await expect(blocked).toContainText(/Not enough signal yet — 2 comments/)
    await expect(section.getByRole('button', { name: /distil rules/i })).toBeDisabled()
    // Nothing was distilled and nothing was stored.
    await expect(page.getByTestId('standing-rules-result')).toHaveCount(0)
    expect(await page.evaluate((k) => localStorage.getItem(k), RULES_KEY)).toBeNull()
  })
})
