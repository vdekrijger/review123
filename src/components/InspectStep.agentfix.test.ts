/**
 * "Send to agent" on the finding card, end to end through the Inspect step.
 *
 * #243 shipped the single-finding path as the PANEL's "only this" button,
 * because SkillFindingCard is rendered by FileDiff / StorySlideshow — two
 * components away from the panel that owns the run. This pins the threaded
 * version: the affordance sits on the card, next to Add as draft / Dismiss,
 * and it appears ONLY when it would actually work.
 *
 * Both gates are the ones that already exist, used as gates:
 *   - the #228 routing rule — a CONCRETE suggestedFix, not "No clean fix — …";
 *   - the bridge's own readiness — `capabilities.fix` (`--allow-write`), a CLI
 *     on PATH, and a checkout sitting on this PR's head.
 * Anything else and the button is ABSENT, not disabled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { PROTOCOL_VERSION } from '../lib/bridge/protocol'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})
Element.prototype.scrollIntoView = function () {}

const HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_HEAD = 'def4567890abcdef1234567890abcdef12345678'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'
const FILES: PrFile[] = [
  { filename: 'src/foo.ts', status: 'modified', additions: 1, deletions: 1, patch: PATCH },
]

const fetchMock = vi.fn()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function pairBridge(opts: { head?: string; fix?: boolean; clis?: string[] } = {}): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    json({
      ok: true,
      protocol: PROTOCOL_VERSION,
      root: 'review123',
      capabilities: {
        inference: opts.clis ?? ['claude'],
        infer: true,
        files: true,
        search: true,
        fix: opts.fix ?? true,
      },
      git: { head: opts.head ?? HEAD, branch: 'feat/x', dirty: false },
      version: '0.1.0',
    }),
  )
  await connectBridge(TOKEN, 7321)
}

function review(suggestedFix: string | undefined): SkillReviewEntry {
  return {
    skillId: 'skill-1',
    name: 'Security',
    state: {
      status: 'done',
      value: {
        skillName: 'Security',
        findings: [
          {
            path: 'src/foo.ts',
            line: 2,
            severity: 'high',
            body: 'Unescaped user input reaches the DOM',
            ...(suggestedFix !== undefined ? { suggestedFix } : {}),
          },
        ],
      },
    },
  } as unknown as SkillReviewEntry
}

function renderInspect(reviews: SkillReviewEntry[]) {
  return render(InspectStep, {
    props: {
      files: FILES,
      changedFiles: 1,
      mode: 'unified',
      onmode: () => {},
      draftStore: null,
      skillReviews: reviews,
      currentHeadSha: HEAD,
    },
  })
}

/** Let the diff view mount its extend rows (where the cards live). */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60))
}

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetBridgeForTest()
})

describe('InspectStep — "Send to agent" on the finding card', () => {
  it('is ABSENT for everyone without a bridge — not a disabled hint', async () => {
    renderInspect([review('Escape it with textContent.')])
    await settle()

    expect(screen.getByText(/Unescaped user input reaches the DOM/)).toBeTruthy()
    expect(screen.queryByTestId('finding-send-to-agent')).toBeNull()
  })

  it('appears on the card when the bridge is write-enabled and on this PR’s head', async () => {
    await pairBridge()
    renderInspect([review('Escape it with textContent.')])
    await settle()

    expect(screen.getByTestId('finding-send-to-agent')).toBeTruthy()
  })

  it('sends exactly THIS finding to /v1/fix when clicked', async () => {
    await pairBridge()
    renderInspect([review('Escape it with textContent.')])
    await settle()

    fetchMock.mockResolvedValueOnce(
      json({
        ok: true,
        cli: 'claude',
        baseSha: HEAD,
        branch: 'review123/fix/abc',
        changes: [],
        skipped: [],
        rounds: 1,
        stopReason: 'all-addressed',
        tests: null,
        durationMs: 10,
      }),
    )

    await userEvent.click(screen.getByTestId('finding-send-to-agent'))
    await settle()

    const fixCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/fix'))
    expect(fixCall).toBeDefined()
    const body = JSON.parse((fixCall![1] as RequestInit).body as string)
    expect(body.cli).toBe('claude')
    expect(body.headSha).toBe(HEAD)
    expect(body.findings).toHaveLength(1)
    expect(body.findings[0].path).toBe('src/foo.ts')
  })

  it('is absent for a "No clean fix — …" finding: a tradeoff stays with the human', async () => {
    await pairBridge()
    renderInspect([review('No clean fix — you would have to rewrite the renderer.')])
    await settle()

    expect(screen.getByText(/Unescaped user input reaches the DOM/)).toBeTruthy()
    expect(screen.queryByTestId('finding-send-to-agent')).toBeNull()
  })

  it('is absent for a finding with no concrete fix at all', async () => {
    await pairBridge()
    renderInspect([review(undefined)])
    await settle()

    expect(screen.queryByTestId('finding-send-to-agent')).toBeNull()
  })

  it('is absent on a READ-ONLY bridge — --allow-write is the whole authorisation', async () => {
    await pairBridge({ fix: false })
    renderInspect([review('Escape it with textContent.')])
    await settle()

    expect(screen.queryByTestId('finding-send-to-agent')).toBeNull()
  })

  it('is absent when the checkout is on another commit', async () => {
    await pairBridge({ head: OTHER_HEAD })
    renderInspect([review('Escape it with textContent.')])
    await settle()

    expect(screen.queryByTestId('finding-send-to-agent')).toBeNull()
  })

  it('is absent when the bridge found no coding agent on its PATH', async () => {
    await pairBridge({ clis: [] })
    renderInspect([review('Escape it with textContent.')])
    await settle()

    expect(screen.queryByTestId('finding-send-to-agent')).toBeNull()
  })
})
