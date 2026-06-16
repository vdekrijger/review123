# Plan P — Unified Model Panel

Date: 2026-06-16 · Branch: feat/unified-model-panel

## Problem
Two AI-ensemble settings exist side by side and confuse each other:
- **"How models combine"** = `fusionMode: 'verify' | 'generate'` (#134)
- **"Ensemble / verification panel"** = `aiEnsemble {generator, verifiers[]}` (#130/#133) with a per-row generator/verifier RADIO.

These contradict: `fusionMode: 'generate'` says "every model generates" while the panel still shows one generator + verifiers. Mode and per-row roles are independent controls for the same concept.

## Solution — ONE "Model panel" with per-row roles; mode is EMERGENT
Replace BOTH `fusionMode` and `aiEnsemble` with a single setting:

```ts
type ParticipantRole = 'generator' | 'verifier'
interface PanelParticipant { provider: AiProvider; model: string; role: ParticipantRole }
interface AiPanel { participants: PanelParticipant[] }
// Settings: aiPanel: AiPanel | null   (null = synthesize today's default)
```

Constraint: **at least 1 generator** (enforced in coercion + UI). Can't set every row to verifier.

### Emergent mode (drop the verify/generate radio)
- exactly 1 generator → behaves like old `'verify'` (single gen raises, others verify)
- ≥2 generators → behaves like old `'generate'` (multi-gen union + dedup + cross-confirm)
- a mix → generators generate, verifiers verify; non-raising generators also verify

### Per-row UI
provider dropdown + model dropdown + role segmented toggle (Generator | Verifier) + remove ✕.
Plus "+ Add a model", "Reset to default", cost note, keys-storage footnote, no hard cap (#133 backstop only).

### Two preset buttons (just set roles)
- **"One generator"** — active/first model = sole generator, rest = verifiers (= old verify)
- **"All generate"** — every participant = generator (= old generate)

## Migration (one-time, on settings load)
Synthesize `aiPanel.participants` from old shape:
- old `aiEnsemble.generator` → `{role:'generator'}`; old `aiEnsemble.verifiers[]` → `{role:'verifier'}`
- IF old `fusionMode === 'generate'` → set ALL participants `role:'generator'`
- default/unset aiEnsemble → default participants (active gen + other-keyed-default verifiers)
- `crossModelVerify` carries over unchanged as the master enable
Thereafter `aiPanel` is the source of truth. Byte-identical effective behavior for users who never customized.

## Engine wiring (reuse Fusion v2)
`resolvePanel()` in config.ts produces `{ generators: ResolvedParticipant[], verifiers: ProviderConfig[] }` from participants, dropping key-missing ones. DEFAULT (null) = active provider+model as sole generator + other-keyed default-model verifiers.

- `crossModelVerifyEffective()` = master on AND ≥2 effective models (generator + ≥1 other participant).
- 1 generator + verifiers → `crossVerify` path (verify), now LENSED.
- ≥2 generators → multi-gen fusion (`mergeGeneratorFindings` + `fuseConfirm`), already lensed.
- `fusionGenerateEffective()` becomes: ≥2 generators among effective participants (mode is emergent).
- `fusionParticipants()` = all effective participants (generators + verifiers) for the fuse path; generator set drives multi-gen generation.
- <2 effective models → no-op single-model review (byte-identical).

### Lenses-everywhere (the real behavior shift → PROMPT_VERSION bump)
Today lenses apply only on the fusion 'generate' path. Now the verify path (`verifyFindingSet` → `crossVerify`) also assigns lenses to verifiers. This changes the verifier prompt in verify configs → bump PROMPT_VERSION (cache invalidates).

## Analytics
`fusionMode` label on decision events becomes DERIVED: `panelMode()` = `'generate'` when ≥2 generators else `'verify'`. Keeps the event field stable.

## TDD
- settings: aiPanel shape; ≥1-generator constraint; presets set roles; role toggle; add/remove/reset
- migration: verify→1gen+verifiers; generate→all generators; default→default participants; crossModelVerify preserved
- config: resolvePanel splits generators/verifiers dropping key-missing; panelMode derivation; crossModelVerifyEffective
- engine: 1 gen+verifiers == old verify (now lensed); all-gen == old generate; mix runs correctly; <2 → no-op
- e2e: "All generate" 2 models → multi-gen + per-model breakdown; "One generator" → verify; one section, role toggles, no verify/generate radio

## Gates
pnpm check && pnpm test && E2E_PORT=4951 pnpm exec playwright test && pnpm build
