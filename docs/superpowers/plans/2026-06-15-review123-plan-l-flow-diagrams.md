# Plan L — Flow-of-execution diagrams

Rework the AI diagram from a static MODULE-DEPENDENCY change-map (file nodes +
imports/calls/delegates edges) into a FLOW-OF-EXECUTION diagram: the execution
path the change touches — entry point → handler → service → store/effect — with
new/changed/removed steps highlighted, so a reviewer sees "how this runs and
what's new in that run."

Keep the established patterns: AI emits STRUCTURED JSON, we render
deterministically (never raw Mermaid); harness-grounded deep mode (#87/#113);
per-task off/standard/deep mode (#113); dark+light palettes; node→file mapping
for click-to-jump + the story-coverage visited check-off (#114).

## Current state (studied)

- `runDiagramsTask` in `src/lib/ai/run.svelte.ts` — off/standard/deep branch,
  cache key `diagrams` / `diagrams|deep`, validates with `validateGraphResult`.
- `diagramsPrompt` in `src/lib/ai/tasks.ts` — emits `GraphResult`
  (`kind`, `before`, `after`, `changeMap`) with a few-shot example; deep mode
  adds one-hop "context" nodes.
- `validateGraphResult` / `validateGraph` in `src/lib/ai/schemas.ts`; `Graph` /
  `GraphResult` / `NodeStatus` in `src/lib/diagram/types.ts`.
- `graphToMermaid` in `src/lib/diagram/mermaid.ts` — deterministic
  `flowchart TD`, status classDefs in dark+light palettes, id remap to nN.
- `DiagramPanel.svelte` renders the change-map first, before/after toggle,
  click-to-jump + #114 visited check-off via `matchNodeToFile`.
- `PROMPT_VERSION = 16` in tasks.ts.

## Design

### 1. Flow schema (augments GraphResult — additive, backward compatible)

A new optional `flow` field on `GraphResult`. An ORDERED execution flow:

```
FlowStep  = { id, label (≤6 words), file?, symbol?, kind, change }
  kind:   'entry' | 'call' | 'branch' | 'effect' | 'return'
  change: 'added' | 'changed' | 'unchanged' | 'removed'
FlowTransition = { from, to, label?, condition? }   // ordered edges
ExecutionFlow  = { steps: FlowStep[], transitions: FlowTransition[] }
```

One delta-annotated flow (NOT before/after): added/changed/removed steps are
visually distinct so the delta shows in a single view. Branching = a step fans
to ≥2 transitions with `condition` labels. Loops = a back-edge labeled "for
each …". Cap ~12–15 steps; group/elide trivial plumbing.

`GraphResult.flow?` is optional → old cached change-map results still validate
and render via the existing change-map path. The validator is tolerant of extra
keys and rejects malformed steps/transitions/enum values.

### 2. Deterministic serializer — `flowToMermaid`

Renders the flow as `flowchart TD`, reusing the serializer infra + status
classDefs. Style by `change`: added=green, changed=amber, removed=red/dashed,
unchanged=muted (both palettes — reuse `CLASS_DEFS`, mapping change→status
class). Entry/effect nodes get a distinct shape (stadium `([…])` for entry,
subroutine `[[…]]` for effect) where Mermaid supports it; call/branch/return =
rectangle. Transition `condition`/`label` render as edge labels. Deterministic
order (steps in array order; ids remapped nN). Each step node carries its
`file` so DiagramPanel's `matchNodeToFile` click-jump + #114 visited check-off
keep working (map by `step.file`). Steps without a file just don't check off.

### 3. Prompt — trace the execution path

Instruct the model to trace the execution path the diff changes: start at the
entry point(s) the change affects (handler/endpoint/job/function-under-test),
follow calls through to the effect (DB write, API response, state change), and
mark each step's `change` from the diff. DEEP mode (harnessed): USE THE TOOLS
(read_file / read_file_at_base / search_code) to follow the real call chain
(read the entry function, find what it calls) so the flow is accurate, not
guessed; drop steps you can't substantiate. STANDARD mode: infer from diff +
import graph. Multiple independent changed paths → pick the most important 1–2.

### 4. Graceful fallback

If the change has no meaningful execution flow (pure data/config/schema/
dependency change) or the model can't construct one, the model returns an empty
`flow.steps` array. The panel renders a short honest note ("No clear execution
flow for this change") instead of a forced/empty diagram — never fabricate a
flow. (Future: pick ER/sequence/etc by change shape — OUT OF SCOPE here.)

### 5. UI / wiring

- `flowToMermaid` consumed by `DiagramPanel.svelte`: when `result.flow` has
  steps, render the flow (full width) as the primary view; the old change-map
  path stays for cached results lacking `flow`.
- Section title: "Execution flow" — update `sectionRegistry` (`diagrams` title)
  and `progressLabel` ("Tracing the execution path…").
- PROMPT_VERSION bump 16 → 17 (new output shape) → invalidates cached diagram
  results so old change-maps don't render under the new label.

## Constraints

Deterministic serializer (model emits JSON only). Both themes. Per-task mode
(#113) governs off/standard/deep. Don't break DiagramPanel pending/skeleton/
click-jump or the #114 coverage check-off. Analytics unchanged.

## TDD

- schema: `validateFlow` / `validateGraphResult` with `flow` — steps +
  transitions + change tags; tolerant of extra keys; reject malformed.
- serializer: `flowToMermaid` — change classDefs both palettes; branch edge
  labels; entry/effect shapes; deterministic order; node carries file.
- prompt: `diagramsPrompt` traces the execution path; deep-mode "use tools to
  follow the call chain" instruction; fallback-note instruction; flow shape in
  the prompt.
- run: deep-path diagram runs the harness (loop invoked when mode deep).
- e2e: fixture-backed flow renders flowchart nodes with change classes + a click
  jumps to the step's file; pure-data fixture renders the fallback note.

## Gates

`pnpm check && pnpm test && E2E_PORT=4819 pnpm exec playwright test && pnpm build`
(capture playwright's own exit code).

## Merge seam

feat/in-flight-reviews PR in flight (Landing/drafts — no diagram overlap).
Re-merge main + rerun all gates if it moves.
