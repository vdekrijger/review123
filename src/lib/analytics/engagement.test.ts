/**
 * engagement.test.ts — unit tests for engagement analytics events.
 *
 * For each event: verifies (a) fires with exactly the allowed props via the
 * capture spy, and (b) the allowlist strips any extras.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { track, _setCaptureForTest } from './analytics'

describe('engagement events — allowlist entries', () => {
  const capture = vi.fn()
  beforeEach(() => { capture.mockClear(); capture.mockImplementation(() => {}); _setCaptureForTest(capture) })

  // section_expanded
  it('section_expanded fires with section + surface only', () => {
    track('section_expanded', { section: 'summary', surface: 'page' })
    expect(capture).toHaveBeenCalledWith('section_expanded', { section: 'summary', surface: 'page' })
  })

  it('section_expanded: rail surface fires correctly', () => {
    track('section_expanded', { section: 'diagrams', surface: 'rail' })
    expect(capture).toHaveBeenCalledWith('section_expanded', { section: 'diagrams', surface: 'rail' })
  })

  it('section_expanded strips extra props not in allowlist', () => {
    track('section_expanded', { section: 'summary', surface: 'page', path: '/src/secret.ts' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({ section: 'summary', surface: 'page' })
    expect(props).not.toHaveProperty('path')
  })

  // file_expanded
  it('file_expanded fires with origin:viewed', () => {
    track('file_expanded', { origin: 'viewed' })
    expect(capture).toHaveBeenCalledWith('file_expanded', { origin: 'viewed' })
  })

  it('file_expanded fires with origin:dim', () => {
    track('file_expanded', { origin: 'dim' })
    expect(capture).toHaveBeenCalledWith('file_expanded', { origin: 'dim' })
  })

  it('file_expanded strips extra props (filename must never appear)', () => {
    track('file_expanded', { origin: 'viewed', filename: 'src/secret.ts' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({ origin: 'viewed' })
    expect(props).not.toHaveProperty('filename')
  })

  // drawer_opened
  it('drawer_opened fires with no properties', () => {
    track('drawer_opened')
    expect(capture).toHaveBeenCalledWith('drawer_opened', {})
  })

  it('drawer_opened strips any extra props', () => {
    track('drawer_opened', { path: '/leaked' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({})
  })

  // rail_expanded
  it('rail_expanded fires with no properties', () => {
    track('rail_expanded')
    expect(capture).toHaveBeenCalledWith('rail_expanded', {})
  })

  it('rail_expanded strips any extra props', () => {
    track('rail_expanded', { user: 'leaked' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({})
  })

  // step_viewed
  it('step_viewed fires with step:1', () => {
    track('step_viewed', { step: '1' })
    expect(capture).toHaveBeenCalledWith('step_viewed', { step: '1' })
  })

  it('step_viewed fires with step:2', () => {
    track('step_viewed', { step: '2' })
    expect(capture).toHaveBeenCalledWith('step_viewed', { step: '2' })
  })

  it('step_viewed fires with step:3', () => {
    track('step_viewed', { step: '3' })
    expect(capture).toHaveBeenCalledWith('step_viewed', { step: '3' })
  })

  it('step_viewed strips extra props (PR info must never appear)', () => {
    track('step_viewed', { step: '2', owner: 'acme', repo: 'secret' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({ step: '2' })
    expect(props).not.toHaveProperty('owner')
    expect(props).not.toHaveProperty('repo')
  })
})
