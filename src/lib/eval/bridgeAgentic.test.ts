import { describe, it, expect } from 'vitest'
import {
  AGENTIC_INFER_TIMEOUT_MS,
  MAX_INFER_TIMEOUT_MS,
  agenticVerdict,
  gateAgentic,
  inferTimeoutMs,
  observeAgentic,
  type AgenticCall,
} from './bridgeAgentic'

const WANTS_NEITHER = { deep: false, grounded: false }
const WANTS_BOTH = { deep: true, grounded: true }

describe('inferTimeoutMs', () => {
  it('leaves a tool-less budget exactly as configured', () => {
    expect(inferTimeoutMs(240_000, false)).toBe(240_000)
  })

  it('RAISES a too-small budget to the bridge agentic default rather than measuring a timeout', () => {
    // The whole point: 240s is the harness default, an agentic call gets 300s.
    expect(inferTimeoutMs(240_000, true)).toBe(AGENTIC_INFER_TIMEOUT_MS)
  })

  it('keeps an operator-chosen budget that is already larger', () => {
    expect(inferTimeoutMs(420_000, true)).toBe(420_000)
  })

  it('clamps to the bridge ceiling instead of sending a value it would silently reduce', () => {
    expect(inferTimeoutMs(900_000, true)).toBe(MAX_INFER_TIMEOUT_MS)
    expect(inferTimeoutMs(900_000, false)).toBe(MAX_INFER_TIMEOUT_MS)
  })
})

describe('gateAgentic', () => {
  it('sends nothing and claims nothing when neither flag was asked for', () => {
    const gate = gateAgentic({ wants: WANTS_NEITHER, isBridge: true, capable: true, capabilityKnown: true })
    expect(gate).toMatchObject({ generator: false, verifier: false, refuse: false })
    expect(gate.reason).toContain('tool-less')
  })

  it('REFUSES rather than downgrades when the bridge predates the flag', () => {
    const gate = gateAgentic({ wants: WANTS_BOTH, isBridge: true, capable: false, capabilityKnown: false })
    expect(gate.refuse).toBe(true)
    expect(gate.generator).toBe(false)
    expect(gate.verifier).toBe(false)
    // The silent-downgrade hazard must be spelled out, not merely implied.
    expect(gate.reason).toContain('IGNORE')
    expect(gate.reason).toContain('0.3.0')
  })

  it('distinguishes an explicit false from an absent key, because they are different facts', () => {
    const explicit = gateAgentic({ wants: WANTS_BOTH, isBridge: true, capable: false, capabilityKnown: true })
    expect(explicit.refuse).toBe(true)
    expect(explicit.reason).toContain('inferAgentic = false')
    expect(explicit.reason).not.toContain('predates')
  })

  it('refuses an API-key transport, which reaches a model but not the working tree', () => {
    const gate = gateAgentic({ wants: WANTS_BOTH, isBridge: false, capable: false, capabilityKnown: false })
    expect(gate.refuse).toBe(true)
    expect(gate.reason).toContain('API key')
  })

  it('turns tools on per ROLE, so grounded verification can be isolated from deep review', () => {
    const groundedOnly = gateAgentic({
      wants: { deep: false, grounded: true },
      isBridge: true,
      capable: true,
      capabilityKnown: true,
    })
    expect(groundedOnly).toMatchObject({ generator: false, verifier: true, refuse: false })

    const deepOnly = gateAgentic({
      wants: { deep: true, grounded: false },
      isBridge: true,
      capable: true,
      capabilityKnown: true,
    })
    expect(deepOnly).toMatchObject({ generator: true, verifier: false, refuse: false })
  })
})

const call = (over: Partial<AgenticCall> = {}): AgenticCall => ({
  role: 'verifier',
  cli: 'codex',
  requested: true,
  ...over,
})

describe('observeAgentic', () => {
  it('ignores calls that never asked for tools', () => {
    const obs = observeAgentic([call({ requested: false }), call({ requested: false })])
    expect(obs.requested).toBe(0)
    expect(obs.honoured).toBe(0)
  })

  it('counts a request with NO report back as the silent downgrade it is', () => {
    const obs = observeAgentic([call({ report: undefined })])
    expect(obs.requested).toBe(1)
    expect(obs.honoured).toBe(0)
    expect(obs.silentlyToolLess).toBe(1)
  })

  it('sums tool calls as a lower bound and tracks denials and tool names', () => {
    const obs = observeAgentic([
      call({ role: 'generator', cli: 'claude', report: { tools: ['Read', 'Glob'], toolCallsAtLeast: 3, denied: 1 } }),
      call({ role: 'verifier', cli: 'codex', report: { tools: [], toolCallsAtLeast: 4 } }),
    ])
    expect(obs.honoured).toBe(2)
    expect(obs.silentlyToolLess).toBe(0)
    expect(obs.toolCallsAtLeast).toBe(7)
    expect(obs.countedCalls).toBe(2)
    expect(obs.denied).toBe(1)
    expect(obs.tools).toEqual(['Glob', 'Read'])
    expect(obs.byRole.generator).toEqual({ requested: 1, honoured: 1, toolCallsAtLeast: 3 })
    expect(obs.byRole.verifier).toEqual({ requested: 1, honoured: 1, toolCallsAtLeast: 4 })
  })

  it('separates "tools granted and unused" (zero) from "nothing countable" (absent)', () => {
    const obs = observeAgentic([
      call({ report: { tools: ['Read'], toolCallsAtLeast: 0 } }),
      call({ report: { tools: ['Read'] } }),
    ])
    expect(obs.honoured).toBe(2)
    expect(obs.countedCalls).toBe(1)
    expect(obs.toolsUnused).toBe(1)
    expect(obs.toolCallsAtLeast).toBe(0)
  })
})

describe('agenticVerdict', () => {
  it('does not claim grounding when nothing agentic was requested', () => {
    const v = agenticVerdict(observeAgentic([call({ requested: false })]))
    expect(v.earned).toBe(false)
    expect(v.line).toContain('nothing here measures grounding')
  })

  it('does not claim grounding when EVERY request came back tool-less', () => {
    const v = agenticVerdict(observeAgentic([call({}), call({})]))
    expect(v.earned).toBe(false)
    expect(v.line).toContain('WITHOUT an agentic report')
  })

  it('refuses the grounded label for a MIXTURE — one downgrade is enough', () => {
    const v = agenticVerdict(
      observeAgentic([call({ report: { tools: [], toolCallsAtLeast: 2 } }), call({ report: undefined })]),
    )
    expect(v.earned).toBe(false)
    expect(v.line).toContain('MIXTURE')
  })

  it('earns the label when every request was honoured, and states the bound as a bound', () => {
    const v = agenticVerdict(
      observeAgentic([
        call({ report: { tools: ['Read', 'Grep'], toolCallsAtLeast: 5, denied: 0 } }),
        call({ report: { tools: [], toolCallsAtLeast: 2 } }),
      ]),
    )
    expect(v.earned).toBe(true)
    expect(v.line).toContain('>=7')
    expect(v.line).toContain('LOWER bound')
  })

  it('reports tools-granted-but-unused rather than hiding it inside the total', () => {
    const v = agenticVerdict(observeAgentic([call({ report: { tools: ['Read'], toolCallsAtLeast: 0 } })]))
    expect(v.earned).toBe(true)
    expect(v.line).toContain('used no tool at all')
  })
})
