# Verification Report — Review 1-2-3, Plan A (foundation + diff viewer)

```
VERIFICATION_REPORT:
  spec: docs/superpowers/specs/2026-06-11-review123-design.md
  criteria: docs/superpowers/specs/2026-06-11-review123-criteria-matrix.md
  scope: Plan A must-haves only (REQ-01, REQ-04 subset, REQ-05, REQ-06 subset, REQ-18, REQ-20 subset)
  branch: feat/plan-a-foundation
  run_at: 2026-06-11 (Europe/Amsterdam)
  script: scripts/verify-review123-plan-a.sh
  status: PARTIAL  # all testable must-haves pass; 1 deferred-vacuous item

RESULTS:
  - id: GATE-check  | status: PASS | svelte-check 0 errors 0 warnings
  - id: GATE-tests  | status: PASS | full vitest suite 81/81
  - id: GATE-build  | status: PASS | vite production build
  - id: REQ-01      | status: PASS | tests: happy + EC-01a,b,h,i,j,l,o (+ nice-to-haves c,d,e,g,m,n also green)
  - id: REQ-04*     | status: PASS | EC-04a,c,e,h (+ key-never-in-analytics)  *Plan A storage subset
  - id: REQ-05      | status: PASS | EC-05a,b,c,g,i (+page cap),j,k
  - id: REQ-06*     | status: PASS | EC-06b (incl. bare-patch regression), EC-06c  *modes/rename/binary subset
  - id: REQ-18      | status: PASS | EC-18a–h + compile-time allowlist proof
  - id: REQ-20*     | status: PASS | EC-20d (title swap + state reset on PR→PR popstate, deep links)

UNCOVERED:
  - EC-06h: "diff renders before any AI stream completes" — vacuous in Plan A
    (no AI panels exist yet). Becomes testable and MUST be covered in Plan C.
    Human risk-acceptance requested at checkpoint.

OPTIONAL (nice-to-have, untested, tracked):
  - EC-01f/k (exotic parse inputs partially covered), EC-05d/e/f/h/l/m beyond
    client-level mapping tests, EC-06a/d/e/f/g/i, EC-20b/c/f/g/h — see matrix.

ADVERSARIAL:  # "if it were broken despite green tests, where would it hide?"
  - FOUND & FIXED: bare GitHub patch strings (the real wire format) parsed to
    ZERO diff lines in @git-diff-view — every real PR would have rendered an
    empty diff while 80 tests stayed green (fixtures used post-mapping/full-
    format shapes). Fixed by synthesizing the unified-diff envelope
    (---/+++ headers, /dev/null for added/removed) in lib/diff/diffFile.ts;
    regression tests now use bare-hunk fixtures.
  - FOUND & FIXED (final review): GitHub's snake_case previous_filename was
    never mapped to previousFilename — rename headers silently dead.
  - REMAINS — real-browser rendering: jsdom stubs canvas and DiffView
    virtualizes rows, so automated tests cannot prove pixels. Mitigation:
    human checkpoint item #1 (look at a real PR in the dev server). A
    Playwright e2e is planned with Plan C's fixture work.
  - REMAINS — GitHub API shape drift: fixtures encode our assumptions about
    wire shapes; two drift bugs were already caught. Mitigation: a tokenless
    smoke test against one real public PR lands in CI with Plan C (per spec
    testing section).
  - REMAINS — Vercel rewrite regex behavior is config, untestable locally;
    verify after first deploy (deep-link a /review/... URL on the deployment).

SUMMARY:
  total: 44 | pass: 43 | fail: 0 | uncovered: 1 | optional: tracked in matrix
  visual_artifacts: SKIPPED (no browser tools / proof-capture in this
    environment) — human checkpoint covers visual verification via pnpm dev
```
