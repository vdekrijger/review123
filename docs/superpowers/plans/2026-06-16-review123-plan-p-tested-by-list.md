# Plan P — "Tested by" as a test-case LIST (not a capped code slice)

## Problem
The story-mode "Tested by" affordance (#95 symbol↔test pairing) currently expands to a
SINGLE capped code slice (#109 cap at 40 lines + "… (truncated)", #110 syntax highlight).
That slice shows imports / long blocks and truncates, so the reviewer can't actually read
the tests it claims cover the change.

## New design
Parse the "Tested by" test file's content into THREE buckets and render a scannable LIST:

1. **Test cases** — title (humanized) + body line-range, grouped under describe/class.
   - JS/TS: `it('…')` / `test('…')` (incl. `.each`), nested under `describe('…')`.
   - Python: `def test_*` (and `Test*` classes) → name humanized
     (`test_renders_dashboard_tile` → "renders dashboard tile").
   - Other langs (Go `func Test*`, Rust `#[test] fn`): best-effort; unrecognized →
     FALL BACK to the existing single-snippet behavior.
2. **Setup & teardown (shared scaffolding)** — extracted OUT, pinned at top.
   - JS: `beforeEach`/`afterEach`/`beforeAll`/`afterAll`, top-of-describe
     `jest.mock(…)` / `vi.mock(…)`, and describe/module-scope `const`/`let`/helper fns
     outside any `it`.
   - Python: `setUp`/`tearDown`/`setUpClass`/`tearDownClass`, `@pytest.fixture` fns,
     module/class-level shared mocks/consts. (conftest.py fixtures are OUT OF FILE —
     noted honestly, never fabricated.)
3. **Imports** — EXCLUDED entirely (reuse codeNoise import detection).

## Files
- NEW `src/lib/diff/testStructure.ts` — heuristic parser (NOT a full AST). Exposes
  `parseTestStructure(content, filename, opts?) → { framework, groups, setup, fallback }`.
  - `groups`: ordered list of `{ title?, tests: [{ title, humanizedTitle?, lineRange,
    truncated }] }` (top-level group has no title).
  - `setup`: array of scaffolding line-ranges (merged/sorted) + a `conftestNote` flag
    for Python when fixtures likely live in conftest.
  - `fallback: true` when no framework recognized → caller keeps old single-snippet path.
  - Reuse: codeNoise import detection (export `isImportLine` or a thin wrapper), the
    #109 brace/indent block-range logic (mirror `enclosingBlock`/`pyHeaderEndLine`).
- `src/components/SymbolTestPairing.svelte` — replace the single capped snippet with:
  - "Setup & teardown" collapsible row pinned at top (only if bucket 2 non-empty),
    collapsed by default, expands to highlighted scaffolding.
  - A LIST of test-case rows: every title shown (NO list-level truncation), collapsed
    by default, expand → that test's highlighted body (a huge body may still cap with
    its own small "… (truncated)").
  - HIGHLIGHT the test(s) referencing the CHANGED symbol (from the existing pairing's
    `tests[].lineRange`): subtle accent + "covers this change" chip; expanded-by-default
    and sorted first.
  - Keep header "Tested by {file}", in-this-PR vs existing chip, LIKELY confidence,
    file link. Indent tests under describe/class group.
  - Graceful fallback to the old snippet when `fallback` or content unavailable.
  - Both themes, compact, keyboard-accessible (reuse button/aria-expanded pattern).

## TDD
- `testStructure.test.ts`: JS describe/it titles + bodies; beforeEach/afterEach/mock into
  setup; imports excluded; Python `def test_*` humanized + setUp/tearDown/@fixture into
  setup; conftest note; unrecognized framework → fallback. (JS + Python.)
- `SymbolTestPairing.test.ts`: setup row pinned when present; all titles listed (no
  truncation); expand shows highlighted body; relevant test marked + expanded; fallback
  when unparseable.

## Gates (all four)
`pnpm check && pnpm test && E2E_PORT=4963 pnpm exec playwright test && pnpm build`
(capture playwright's own exit code).

## Merge seam
feat/unified-model-panel in flight (settings/config/crossVerify — no symbolTests/story
overlap). Re-merge main + rerun all gates if main moves.
