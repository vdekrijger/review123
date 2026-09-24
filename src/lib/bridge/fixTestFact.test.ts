/**
 * fixTestFact — the app's only real test signal, and the rules that stop it
 * lying.
 *
 * Two of these are load-bearing and were named as such when this was asked for:
 * a test run belongs to the commit it ran against (stale green is worse than no
 * green), and `failed` and `not-run` are different facts that must stay
 * different (a red run is not an absence).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  NO_FIX_TEST_FACT,
  _resetFixTestFactForTest,
  currentFixTestFact,
  fixTestFactFor,
  noteFixTestFact,
} from './fixTestFact.svelte'
import type { BridgeFixChange, BridgeFixTestStatus } from './protocol'

const HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER = 'def4567890abcdef1234567890abcdef12345678'

function change(
  commit: string,
  tests: { status: BridgeFixTestStatus; command?: string; detail?: string } | null,
): BridgeFixChange {
  return {
    findingId: `f-${commit}`,
    commit: commit.padEnd(40, '0'),
    subject: 's',
    intent: 'i',
    files: [],
    diff: '',
    truncated: false,
    rounds: 1,
    stopReason: 'all-addressed',
    tests:
      tests === null
        ? null
        : {
            status: tests.status,
            command: tests.command ?? 'pnpm test',
            durationMs: 100,
            output: 'out',
            ...(tests.detail ? { detail: tests.detail } : {}),
          },
  }
}

describe('fixTestFactFor', () => {
  it('is not-run with no commits at all', () => {
    expect(fixTestFactFor([])).toEqual(NO_FIX_TEST_FACT)
  })

  it('is not-run when commits exist but nothing ran', () => {
    expect(fixTestFactFor([change('aaa', null)]).status).toBe('not-run')
  })

  it('reports a pass, and scopes it to the agent’s commit rather than the PR', () => {
    const fact = fixTestFactFor([change('aaa', { status: 'passed' })])
    expect(fact.status).toBe('passed')
    // The scope is the whole reason this is honest: the tests ran on this PR's
    // head PLUS a change nobody has taken yet, and the grade prints this string
    // in its parenthetical.
    expect(fact.command).toBe("pnpm test — on the agent's fix commit aaa0000")
  })

  it('names the count rather than every sha once there is more than one', () => {
    const fact = fixTestFactFor([change('aaa', { status: 'passed' }), change('bbb', { status: 'passed' })])
    expect(fact.command).toBe("pnpm test — across the agent's 2 fix commits")
  })

  // The weakest link, not the average: one red among four greens is a red run.
  it('reports FAILED when any commit came back red, however many passed', () => {
    const fact = fixTestFactFor([
      change('aaa', { status: 'passed' }),
      change('bbb', { status: 'failed' }),
      change('ccc', { status: 'passed' }),
    ])
    expect(fact.status).toBe('failed')
  })

  // `failed` and `not-run` are different facts. One says a runner executed the
  // code and it came back red; the other says nothing executed it.
  it('never collapses a failing run into "no run"', () => {
    expect(fixTestFactFor([change('aaa', { status: 'failed' })]).status).toBe('failed')
    expect(fixTestFactFor([change('aaa', null)]).status).toBe('not-run')
  })

  it('calls a run that reached no verdict skipped, not passed', () => {
    for (const status of ['timeout', 'unrunnable', 'skipped'] as const) {
      const fact = fixTestFactFor([change('aaa', { status }), change('bbb', { status: 'passed' })])
      expect(fact.status, status).toBe('skipped')
      expect(fact.detail, status).toBeTruthy()
    }
  })

  it('puts a timeout’s own reason in the detail the grade prints', () => {
    const fact = fixTestFactFor([change('aaa', { status: 'timeout' })])
    expect(fact.detail).toMatch(/did not finish in time/i)
  })
})

describe('the published fact', () => {
  beforeEach(() => _resetFixTestFactForTest())

  it('reads back for the head it was published for', () => {
    noteFixTestFact(HEAD, { status: 'passed', command: 'pnpm test' })
    expect(currentFixTestFact(HEAD)).toEqual({ status: 'passed', command: 'pnpm test' })
  })

  // A grade must never be able to count a green run that belongs to the pull
  // request the user was looking at a moment ago — or to a commit this PR has
  // since moved past.
  it('is not-run for any other head', () => {
    noteFixTestFact(HEAD, { status: 'passed' })
    expect(currentFixTestFact(OTHER)).toEqual(NO_FIX_TEST_FACT)
  })

  it('is not-run before anything is published, and after it is cleared', () => {
    expect(currentFixTestFact(HEAD)).toEqual(NO_FIX_TEST_FACT)
    noteFixTestFact(HEAD, { status: 'passed' })
    noteFixTestFact(HEAD, null)
    expect(currentFixTestFact(HEAD)).toEqual(NO_FIX_TEST_FACT)
  })

  it('matches a head whatever case the provider used', () => {
    noteFixTestFact(HEAD.toUpperCase(), { status: 'failed' })
    expect(currentFixTestFact(HEAD).status).toBe('failed')
  })
})
