/**
 * CiSummary component tests (REQ-10)
 *
 * States:
 *   - null + !error  → loading skeleton (aria-busy)
 *   - error=true     → "Couldn't load CI status" in role=alert
 *   - total=0        → "No CI configured"  (EC-10a)
 *   - pending>0      → pending state       (EC-10b)
 *   - all pass       → green count         (EC-10c)
 *   - failures       → failure list + annotations as TEXT nodes (EC-10g)
 *
 * EC-10g: annotation containing "<script>" is rendered as plain text (auto-escaped
 * by Svelte), NOT as an actual script element.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import CiSummary from './CiSummary.svelte'
import type { CiSummary as CiSummaryType } from '../lib/github/checks'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const zeroCi: CiSummaryType = {
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
  failures: [],
}

const pendingCi: CiSummaryType = {
  total: 3,
  passed: 1,
  failed: 0,
  pending: 2,
  failures: [],
}

const allPassCi: CiSummaryType = {
  total: 4,
  passed: 4,
  failed: 0,
  pending: 0,
  failures: [],
}

const failureCi: CiSummaryType = {
  total: 3,
  passed: 1,
  failed: 2,
  pending: 0,
  failures: [
    { name: 'unit-tests', annotations: ['Expected 42 got 0', 'Null pointer at line 7'] },
    { name: 'lint', annotations: [] },
  ],
}

// ---------------------------------------------------------------------------
// Loading state (ci=null, error=false)
// ---------------------------------------------------------------------------

describe('CiSummary — loading state', () => {
  it('renders loading skeleton with aria-busy when ci is null and no error', () => {
    render(CiSummary, { props: { ci: null, error: false } })
    const loader = document.querySelector('[aria-busy="true"]')
    expect(loader).not.toBeNull()
  })

  it('does not show error text in loading state', () => {
    render(CiSummary, { props: { ci: null, error: false } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/couldn't load/i)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Error state (error=true)
// ---------------------------------------------------------------------------

describe('CiSummary — error state', () => {
  it('shows error message in role=alert (EC-10e)', () => {
    render(CiSummary, { props: { ci: null, error: true } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('alert').textContent).toMatch(/couldn't load ci status/i)
  })
})

// ---------------------------------------------------------------------------
// EC-10a: zero CI runs
// ---------------------------------------------------------------------------

describe('CiSummary — no CI configured (EC-10a)', () => {
  it('renders "No CI configured" when total is 0', () => {
    render(CiSummary, { props: { ci: zeroCi, error: false } })
    expect(screen.getByText(/no ci configured/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// EC-10b: pending state
// ---------------------------------------------------------------------------

describe('CiSummary — pending (EC-10b)', () => {
  it('shows pending count when pending > 0', () => {
    render(CiSummary, { props: { ci: pendingCi, error: false } })
    expect(screen.getByText(/pending/i)).toBeInTheDocument()
    expect(screen.getByText(/pending/i).textContent).toMatch(/2/)
  })

  it('also shows passed count alongside pending', () => {
    render(CiSummary, { props: { ci: pendingCi, error: false } })
    expect(screen.getByText(/pending/i).textContent).toMatch(/1 passed/)
  })
})

// ---------------------------------------------------------------------------
// EC-10c: all pass
// ---------------------------------------------------------------------------

describe('CiSummary — all pass (EC-10c)', () => {
  it('shows all-pass message with the count', () => {
    render(CiSummary, { props: { ci: allPassCi, error: false } })
    expect(screen.getByText(/4 checks? passed/i)).toBeInTheDocument()
  })

  it('does not render any failure list', () => {
    render(CiSummary, { props: { ci: allPassCi, error: false } })
    expect(screen.queryByText(/failed/i)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Failures with annotations
// ---------------------------------------------------------------------------

describe('CiSummary — failures with annotations', () => {
  it('renders failure count', () => {
    render(CiSummary, { props: { ci: failureCi, error: false } })
    expect(screen.getByText(/2 checks? failed/i)).toBeInTheDocument()
  })

  it('renders each failing check name', () => {
    render(CiSummary, { props: { ci: failureCi, error: false } })
    expect(screen.getByText('unit-tests')).toBeInTheDocument()
    expect(screen.getByText('lint')).toBeInTheDocument()
  })

  it('renders annotations as text content', () => {
    render(CiSummary, { props: { ci: failureCi, error: false } })
    expect(screen.getByText('Expected 42 got 0')).toBeInTheDocument()
    expect(screen.getByText('Null pointer at line 7')).toBeInTheDocument()
  })

  it('handles a run with no annotations gracefully', () => {
    render(CiSummary, { props: { ci: failureCi, error: false } })
    // lint has no annotations — the name should still render without crashing
    expect(screen.getByText('lint')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// EC-10g: XSS via annotations — Svelte auto-escape
//
// An annotation containing "<script>alert(1)</script>" must be rendered as
// plain text (visible in the document as the literal string) and must NOT
// create an actual <script> element in the DOM.
// ---------------------------------------------------------------------------

describe('CiSummary — annotation XSS escaping (EC-10g)', () => {
  it('renders <script> annotation as literal text, not a script element', () => {
    const xssCi: CiSummaryType = {
      total: 1,
      passed: 0,
      failed: 1,
      pending: 0,
      failures: [
        {
          name: 'security-check',
          annotations: ['<script>alert(1)</script>'],
        },
      ],
    }

    const { container } = render(CiSummary, { props: { ci: xssCi, error: false } })

    // The literal text must be present in the document
    expect(container.textContent).toContain('<script>alert(1)</script>')

    // No actual script element should have been injected
    expect(container.querySelectorAll('script')).toHaveLength(0)
  })

  it('renders HTML attribute injection attempt as plain text', () => {
    const attrInjectionCi: CiSummaryType = {
      total: 1,
      passed: 0,
      failed: 1,
      pending: 0,
      failures: [
        {
          name: 'xss-check',
          annotations: ['" onmouseover="alert(1)'],
        },
      ],
    }

    const { container } = render(CiSummary, {
      props: { ci: attrInjectionCi, error: false },
    })

    // The literal string must appear as text
    expect(container.textContent).toContain('" onmouseover="alert(1)')
  })

  it('renders img onerror injection as plain text, no img element created', () => {
    const imgCi: CiSummaryType = {
      total: 1,
      passed: 0,
      failed: 1,
      pending: 0,
      failures: [
        {
          name: 'img-check',
          annotations: ['<img src=x onerror=alert(1)>'],
        },
      ],
    }

    const { container } = render(CiSummary, { props: { ci: imgCi, error: false } })

    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    // No injected img elements (the component itself has none)
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })
})
