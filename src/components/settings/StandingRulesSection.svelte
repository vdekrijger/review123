<script lang="ts">
  /**
   * StandingRulesSection — the standing-rules knowledge base.
   *
   * Every review comment the user writes is a spec fragment that arrived too
   * late. This section distils the corrections they keep repeating into
   * authoring rules they can paste into the CLAUDE.md / AGENTS.md of the repos
   * their coding agents work in.
   *
   * Two constraints govern the whole surface:
   *   1. PROPOSE, NEVER AUTO-APPLY. Every rule is a candidate the user accepts,
   *      edits or rejects, one at a time, with its evidence in view. Nothing is
   *      written into any file on their machine — not via the bridge, not with
   *      --allow-write. Where their authoring policy lives is their call.
   *   2. LOCAL WHEN POSSIBLE, AND SAY WHICH. The corpus is their own review
   *      history; when a bridge can run inference it never leaves the machine.
   *      The source is stated on the result, not implied.
   */
  import { llmJsonWithRepairFor } from '../../lib/llm/llm'
  import { PROMPT_VERSIONS } from '../../lib/ai/tasks'
  import type { StandingRule } from '../../lib/ai/schemas'
  import { settingsState } from '../../lib/settings/settingsState.svelte'
  import { track } from '../../lib/analytics/analytics'
  import Spinner from '../Spinner.svelte'
  import {
    collectCorpus,
    assessCorpus,
    estimateCorpusTokens,
    countCorpus,
    corpusTotal,
    type StandingRulesCorpus,
    type CorpusCounts,
  } from '../../lib/skills/standingRulesCorpus'
  import { currentDistillRoute, currentRouteSnapshot, decideDistillRoute, distillStandingRules } from '../../lib/skills/standingRules'
  import {
    loadStandingRules,
    saveStandingRules,
    clearStandingRules,
    loadDecisions,
    decideRule,
    clearDecision,
    clearAllDecisions,
    withoutRejected,
    exportStandingRules,
    acceptedCount,
    ruleId,
    isRecordStale,
    provenanceLine,
    STANDING_RULES_FILENAME,
    type Decisions,
    type DistillSource,
    type StandingRulesRecord,
  } from '../../lib/skills/standingRulesStore'

  /**
   * Seams. The clipboard follows VerdictStep's injectable `copyFn`; the
   * download is injectable for the same reason — jsdom has neither.
   */
  let {
    copyFn = (text: string) => navigator.clipboard.writeText(text),
    downloadFn = defaultDownload,
  }: {
    copyFn?: (text: string) => Promise<void>
    downloadFn?: (filename: string, text: string) => void
  } = $props()

  function defaultDownload(filename: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  // ---- State -------------------------------------------------------------

  let record = $state<StandingRulesRecord | null>(loadStandingRules())
  let decisions = $state<Decisions>(loadDecisions())

  let previewCounts = $state<CorpusCounts | null>(null)
  let previewTokens = $state(0)
  let previewCorpus: StandingRulesCorpus | null = null
  let previewNote = $state<string | null>(null)
  let previewBlocked = $state<string | null>(null)
  let previewing = $state(false)

  let running = $state(false)
  let error = $state<string | null>(null)
  let exported = $state<string | null>(null)

  /**
   * CANCELLATION. The distillation is ONE call that takes minutes over the
   * bridge, so it needs a stop — and a stop is not a failure:
   *   - the calm line below is a muted note, never the red `error` chip, and
   *     never carries the engine's own "The user aborted a request." text
   *     (the #233/#234 rule, which the transport already enforces);
   *   - the previous distillation is left EXACTLY as it was. Cancelling must
   *     not cost the user accepted rules they already decided on;
   *   - analytics records it as an outcome, not a failure (see the PRIVACY
   *     DECISION block on standing_rules_distilled).
   *
   * `runSeq` supersedes the in-flight run so its late outcome — whatever it
   * turns out to be — can never write state after a cancel. That is what keeps
   * a re-run immediate: the UI is calm the moment the button is pressed, and
   * nothing arrives later to undo it.
   */
  let cancelled = $state(false)
  let cancelledSource = $state<DistillSource | null>(null)
  let distillAbort: AbortController | null = null
  let runSeq = 0
  let inFlight: { source: DistillSource; counts: CorpusCounts; startedAt: number } | null = null

  let editingId = $state<string | null>(null)
  let editText = $state('')

  // The route is recomputed from live state whenever the provider or the
  // bridge pairing changes — settingsState makes the provider half reactive.
  const routeDecision = $derived.by(() => {
    void settingsState.current.aiProvider
    return decideDistillRoute(currentRouteSnapshot())
  })

  const routeLabel = $derived(routeDecision.ok ? routeDecision.label : null)
  const routeIsLocal = $derived(routeDecision.ok && routeDecision.source === 'bridge')

  const proposed = $derived(record ? withoutRejected(record.rules, decisions) : [])
  const dos = $derived(proposed.filter((r) => r.kind === 'do'))
  const avoids = $derived(proposed.filter((r) => r.kind === 'avoid'))
  const accepted = $derived(acceptedCount(decisions))
  const stale = $derived(record !== null && isRecordStale(record, PROMPT_VERSIONS.standingRules))
  const rejectedCount = $derived(Object.values(decisions).filter((d) => d.status === 'rejected').length)

  function decisionFor(rule: StandingRule) {
    return decisions[ruleId(rule.rule)]
  }

  function displayText(rule: StandingRule): string {
    return decisionFor(rule)?.text ?? rule.rule
  }

  // ---- Cost preview ------------------------------------------------------

  async function handlePreview() {
    previewing = true
    error = null
    cancelled = false
    cancelledSource = null
    previewNote = null
    previewBlocked = null
    try {
      const result = await collectCorpus()
      if (!result.ok) {
        error = result.error
        return
      }
      previewCorpus = result.corpus
      previewCounts = result.counts
      previewTokens = estimateCorpusTokens(result.corpus)
      previewNote = result.commentsError ?? null
      const readiness = assessCorpus(result.counts)
      previewBlocked = readiness.ready ? null : readiness.message
    } catch (e) {
      error = (e as Error).message
    } finally {
      previewing = false
    }
  }

  // ---- Run ---------------------------------------------------------------

  async function handleRun() {
    if (!previewCorpus || previewBlocked) return
    const corpus = previewCorpus
    const built = currentDistillRoute()
    if (!built.ok) {
      error = built.error
      return
    }
    const route = built.route
    const counts = countCorpus(corpus)
    const seq = ++runSeq
    const controller = new AbortController()
    distillAbort = controller
    inFlight = { source: route.source, counts, startedAt: Date.now() }
    running = true
    error = null
    // A previous distillation is NOT cleared here: it stays on screen while the
    // new one runs, so a cancel (or a failure) leaves the user where they were.
    cancelled = false
    cancelledSource = null
    exported = null
    const startedAt = Date.now()
    try {
      const outcome = await distillStandingRules(corpus, route, { llmJsonWithRepairFor }, controller.signal)
      // Superseded by a cancel (or by a newer run): its result is not ours to
      // render, and the calm state it left behind stands.
      if (seq !== runSeq) return
      if (!outcome.ok && outcome.cancelled) {
        // An abort we did not press the button for — the page tearing the
        // request down, say. Still a stop, so still the calm path.
        settleCancelled(outcome.source, startedAt, counts)
        return
      }
      if (!outcome.ok) {
        error = outcome.error
        return
      }
      const next: StandingRulesRecord = {
        promptVersion: PROMPT_VERSIONS.standingRules,
        distilledAt: Date.now(),
        source: outcome.source,
        sourceLabel: outcome.sourceLabel,
        counts,
        rules: outcome.rules,
      }
      saveStandingRules(next)
      record = next
      track('standing_rules_distilled', {
        outcome: 'done',
        source: outcome.source,
        rules: outcome.rules.length,
        do: outcome.rules.filter((r) => r.kind === 'do').length,
        avoid: outcome.rules.filter((r) => r.kind === 'avoid').length,
        comments: counts.reviewComments,
        dismissals: counts.dismissals,
        drafts: counts.drafts,
        duration_ms: Date.now() - startedAt,
      })
    } catch (e) {
      if (seq !== runSeq) return
      error = (e as Error).message
    } finally {
      if (seq === runSeq) {
        running = false
        distillAbort = null
        inFlight = null
      }
    }
  }

  /**
   * Stop the run in flight.
   *
   * It ABORTS — the signal reaches the transport's fetch, so the request is
   * torn down rather than merely ignored. Over the bridge, closing that HTTP
   * connection to 127.0.0.1 is also what stops the CLI: since #249 the bridge
   * treats a client disconnect as a kill (SIGTERM, then SIGKILL after a grace
   * period, on `/v1/infer` and `/v1/infer/stream` alike), so cancelling really
   * does make the machine go quiet — which is what the calm line now says.
   *
   * The state flips HERE rather than waiting for the aborted promise to settle:
   * a stop the user has to wait for is not a stop, and nothing that arrives
   * afterwards can write over it (the `runSeq` guard above).
   */
  function handleCancel() {
    if (!running) return
    const run = inFlight
    runSeq++
    distillAbort?.abort()
    distillAbort = null
    inFlight = null
    running = false
    if (run) settleCancelled(run.source, run.startedAt, run.counts)
  }

  /** The one calm landing for a stopped run — state and metric in one place. */
  function settleCancelled(source: DistillSource, startedAt: number, counts: CorpusCounts): void {
    running = false
    error = null
    cancelled = true
    cancelledSource = source
    // An abandoned run is not a failed one. Counts and enums only, and no rule
    // counts — there are none.
    track('standing_rules_distilled', {
      outcome: 'cancelled',
      source,
      comments: counts.reviewComments,
      dismissals: counts.dismissals,
      drafts: counts.drafts,
      duration_ms: Date.now() - startedAt,
    })
  }

  // ---- Per-rule decisions ------------------------------------------------

  function handleAccept(rule: StandingRule, text?: string) {
    const entry = decideRule(rule, 'accepted', text)
    decisions = loadDecisions()
    editingId = null
    exported = null
    track('standing_rules_decided', { decision: 'accepted', kind: rule.kind, edited: entry.edited })
  }

  function handleReject(rule: StandingRule) {
    decideRule(rule, 'rejected')
    decisions = loadDecisions()
    editingId = null
    exported = null
    track('standing_rules_decided', { decision: 'rejected', kind: rule.kind, edited: false })
  }

  function handleUndo(rule: StandingRule) {
    clearDecision(ruleId(rule.rule))
    decisions = loadDecisions()
    exported = null
  }

  function startEdit(rule: StandingRule) {
    editingId = ruleId(rule.rule)
    editText = displayText(rule)
  }

  function handleForgetRejections() {
    clearAllDecisions()
    decisions = loadDecisions()
    exported = null
  }

  function handleDiscard() {
    clearStandingRules()
    record = null
    cancelled = false
    cancelledSource = null
    previewCounts = null
    previewCorpus = null
    previewBlocked = null
    previewNote = null
    exported = null
  }

  // ---- Export ------------------------------------------------------------

  function buildExport(): string | null {
    if (!record) return null
    return exportStandingRules(decisions, record)
  }

  async function handleCopy() {
    const text = buildExport()
    if (!text) return
    try {
      await copyFn(text)
      exported = 'Copied.'
      track('standing_rules_exported', { method: 'clipboard', rules: accepted })
    } catch {
      exported = 'Could not reach the clipboard — use Download instead.'
    }
  }

  function handleDownload() {
    const text = buildExport()
    if (!text) return
    downloadFn(STANDING_RULES_FILENAME, text)
    exported = `Saved as ${STANDING_RULES_FILENAME}.`
    track('standing_rules_exported', { method: 'download', rules: accepted })
  }

  function sourceWord(source: string): string {
    return source === 'review-comment' ? 'review comment' : source === 'dismissal' ? 'dismissal' : 'draft'
  }
</script>

<section id="standing-rules" aria-label="Standing rules" data-testid="standing-rules-section">
  <h2 class="section-label">Standing rules <span class="optional-note">(for the agents that write your code)</span></h2>

  <p class="explainer">
    Every review comment you write is a piece of the spec that arrived too late. When you keep
    making the same correction, that is not a review finding — it is a standing order nobody gave
    the agent. This reads your own review history and proposes those orders as rules you can paste
    into a repo's <code>CLAUDE.md</code> or <code>AGENTS.md</code>.
  </p>
  <p class="explainer">
    Every rule is a <strong>proposal</strong>. You accept, edit or reject each one, and the result
    only ever leaves here as text you copy or download.
    <strong>Nothing is written to any file on your machine.</strong>
  </p>

  <p class="field-note" data-testid="standing-rules-route">
    {#if routeIsLocal}
      Runs on <strong>{routeLabel}</strong> through the local bridge — your comments never leave
      this machine.
    {:else if routeDecision.ok}
      No bridge can run inference, so this will go to <strong>{routeLabel}</strong> over the API.
      Pair a bridge under <a href="#bridge">Local bridge</a> to keep it local.
    {:else}
      {routeDecision.error}
    {/if}
  </p>

  <!-- Cost preview: counts BEFORE any call, and the call only on a click. -->
  <div class="run-row">
    <button type="button" class="secondary-btn" onclick={handlePreview} disabled={previewing || running}>
      {#if previewing}<Spinner size="0.8em" />Counting…{:else}Check what's there{/if}
    </button>
    {#if previewCounts}
      <button
        type="button"
        class="primary-btn"
        onclick={handleRun}
        disabled={running || previewBlocked !== null || !routeDecision.ok}
        aria-busy={running}
      >
        {#if running}<Spinner size="0.8em" />Distilling…{:else if record}Re-run{:else}Distil rules{/if}
      </button>
    {/if}
    <!--
      Only while a run is in flight. A multi-minute call with no way out is a
      trap; a real <button> is the affordance, so it is in the tab order and
      answers Enter/Space like every other control here.
    -->
    {#if running}
      <button
        type="button"
        class="secondary-btn"
        onclick={handleCancel}
        aria-label="Cancel the distillation"
        data-testid="standing-rules-cancel"
      >
        Cancel
      </button>
    {/if}
  </div>

  {#if previewCounts}
    <p class="cost" data-testid="standing-rules-cost">
      {previewCounts.reviewComments} review comments · {previewCounts.dismissals} dismissals ·
      {previewCounts.drafts} of your own drafts · {previewCounts.acceptedFindings} accepted findings
      — one call, roughly {previewTokens.toLocaleString()} input tokens
      ({corpusTotal(previewCounts)} items).
    </p>
  {/if}
  {#if previewNote}
    <p class="field-note" data-testid="standing-rules-partial">{previewNote}</p>
  {/if}
  {#if previewBlocked}
    <p class="field-note blocked" role="status" data-testid="standing-rules-blocked">{previewBlocked}</p>
  {/if}
  {#if error}
    <p class="error" role="alert" data-testid="standing-rules-error">{error}</p>
  {/if}
  <!--
    A stopped run is reported CALMLY: a muted status line, not the red chip and
    not role="alert". Nothing broke — the user changed their mind.
  -->
  {#if cancelled}
    <p class="field-note" role="status" data-testid="standing-rules-cancelled">
      Cancelled before it finished — nothing was distilled{#if record}, and the rules you already
        have are untouched{/if}.
      {#if cancelledSource === 'bridge'}
        The bridge also stops the CLI it started on your machine.
      {/if}
    </p>
  {/if}

  {#if record}
    <div class="result" data-testid="standing-rules-result">
      <p class="provenance" data-testid="standing-rules-provenance">
        Distilled on <strong>{record.sourceLabel}</strong>
        {record.source === 'bridge' ? '(on this machine)' : '(over the API)'} from
        {record.counts.reviewComments} review comments, {record.counts.dismissals} dismissals and
        {record.counts.drafts} drafts.
        {#if stale}<span class="stale"> The distillation prompt has changed since — re-run for current rules.</span>{/if}
      </p>

      {#if proposed.length === 0}
        <p class="field-note" data-testid="standing-rules-none">
          No rules stand right now. Either the history showed no pattern that repeats, or you have
          rejected every proposal.
        </p>
      {/if}

      {#each [{ kind: 'do', title: 'You keep asking for this', rules: dos }, { kind: 'avoid', title: 'You keep rejecting this', rules: avoids }] as group (group.kind)}
        {#if group.rules.length > 0}
          <h3 class="group-title" data-testid="standing-rules-group-{group.kind}">{group.title}</h3>
          <ul class="rules">
            {#each group.rules as rule (ruleId(rule.rule))}
              {@const id = ruleId(rule.rule)}
              {@const decision = decisions[id]}
              <li class="rule" data-testid="standing-rule" data-rule-kind={rule.kind} data-decision={decision?.status ?? 'undecided'}>
                {#if editingId === id}
                  <textarea
                    class="rule-edit"
                    bind:value={editText}
                    rows={2}
                    aria-label="Edit rule"
                  ></textarea>
                  <div class="rule-actions">
                    <button type="button" class="primary-btn" onclick={() => handleAccept(rule, editText)}>Save &amp; accept</button>
                    <button type="button" class="secondary-btn" onclick={() => (editingId = null)}>Cancel</button>
                  </div>
                {:else}
                  <p class="rule-text">{displayText(rule)}</p>
                  <p class="evidence" data-testid="standing-rule-evidence">
                    Seen {rule.occurrences}
                    {rule.occurrences === 1 ? 'time' : 'times'}{#if rule.evidence.length > 0}, for example:{/if}
                  </p>
                  {#if rule.evidence.length > 0}
                    <ul class="excerpts">
                      {#each rule.evidence as ev, i (i)}
                        <li><span class="excerpt-source">{sourceWord(ev.source)}</span> “{ev.excerpt}”</li>
                      {/each}
                    </ul>
                  {/if}
                  <div class="rule-actions">
                    {#if decision}
                      <span class="decided" data-testid="standing-rule-decided">
                        {decision.status === 'accepted' ? (decision.edited ? 'Accepted (edited)' : 'Accepted') : 'Rejected'}
                      </span>
                      <button type="button" class="secondary-btn" onclick={() => handleUndo(rule)}>Undo</button>
                    {:else}
                      <button type="button" class="primary-btn" onclick={() => handleAccept(rule)} aria-label="Accept rule">Accept</button>
                      <button type="button" class="secondary-btn" onclick={() => startEdit(rule)} aria-label="Edit rule">Edit</button>
                      <button type="button" class="secondary-btn" onclick={() => handleReject(rule)} aria-label="Reject rule">Reject</button>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/each}

      <div class="export" data-testid="standing-rules-export">
        <p class="field-note">
          {accepted} accepted {accepted === 1 ? 'rule' : 'rules'} — paste this under a heading in
          your repo's <code>CLAUDE.md</code> or <code>AGENTS.md</code>. review123 never writes it
          for you.
        </p>
        <div class="run-row">
          <button type="button" class="secondary-btn" onclick={handleCopy} disabled={accepted === 0}>Copy to clipboard</button>
          <button type="button" class="secondary-btn" onclick={handleDownload} disabled={accepted === 0}>Download .md</button>
          <button type="button" class="secondary-btn" onclick={handleDiscard}>Discard distillation</button>
        </div>
        {#if exported}
          <p class="field-note" role="status" data-testid="standing-rules-exported">{exported}</p>
        {/if}
        {#if accepted > 0}
          <pre class="preview" data-testid="standing-rules-preview">{exportStandingRules(decisions, record)}</pre>
        {:else}
          <p class="field-note">{provenanceLine(record)}</p>
        {/if}
      </div>
    </div>
  {/if}

  {#if rejectedCount > 0}
    <p class="field-note" data-testid="standing-rules-rejections">
      {rejectedCount} rejected {rejectedCount === 1 ? 'rule' : 'rules'} are remembered and will not
      be proposed again.
      <button type="button" class="link-btn" onclick={handleForgetRejections}>Forget them</button>
    </p>
  {/if}
</section>

<style>
  section {
    margin-bottom: 1.5rem;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 1rem 1.25rem;
  }

  /* A real <h2> (F13/rubric D1) styled down to the label it already was.
     letter-spacing is pinned back to normal because the global h2/h3 rules
     tighten it: the outline is the change here, not a single rendered pixel. */
  .section-label {
    font-size: 0.9em;
    font-weight: 600;
    letter-spacing: normal;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .optional-note {
    /* F18: `normal` IS 400 — one spelling, so the set stays countable. */
    font-weight: 400;
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .explainer,
  .field-note,
  .cost {
    margin: 0 0 0.5rem;
    font-size: 0.85em;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .cost {
    color: var(--text);
  }

  .blocked {
    color: var(--text);
  }

  .explainer code,
  .field-note code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.95em;
  }

  /* Without this the in-body link renders in the UA default #0000EE — the one
     colour on the page that is in neither palette (audit F14). Inherit the
     note's own --text-muted and keep the underline as the affordance. */
  .field-note a {
    color: inherit;
    text-decoration: underline;
  }

  .error {
    margin: 0 0 0.5rem;
    font-size: 0.85em;
    color: var(--danger, #b3261e);
  }

  .run-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }

  .primary-btn,
  .secondary-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--border-control);
    background: var(--surface, transparent);
    color: var(--text);
    font-size: 0.85em;
    cursor: pointer;
  }

  .primary-btn {
    border-color: var(--accent, currentColor);
    font-weight: 600;
  }

  .primary-btn:disabled,
  .secondary-btn:disabled {
    opacity: var(--disabled-opacity);
    cursor: not-allowed;
  }

  .link-btn {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent, currentColor);
    font-size: inherit;
    cursor: pointer;
    text-decoration: underline;
  }

  .provenance {
    margin: 0.75rem 0 0.5rem;
    font-size: 0.85em;
    color: var(--text-muted);
  }

  .stale {
    color: var(--text);
  }

  /* 1.15rem above / 0.4rem below = 2.9:1 (rubric D2, p.85); was 2.25:1. */
  .group-title {
    font-size: 0.85em;
    font-weight: 600;
    letter-spacing: normal;
    margin: 1.15rem 0 0.4rem;
    color: var(--text);
  }

  .rules {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .rule {
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
  }

  .rule[data-decision='rejected'] {
    opacity: 0.6;
  }

  .rule-text {
    margin: 0 0 0.35rem;
    font-size: 0.9em;
    line-height: 1.45;
    color: var(--text);
  }

  .evidence {
    margin: 0 0 0.25rem;
    font-size: 0.8em;
    color: var(--text-muted);
  }

  .excerpts {
    list-style: none;
    margin: 0 0 0.4rem;
    padding: 0 0 0 0.75rem;
    border-left: 2px solid var(--hairline);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.8em;
    color: var(--text-muted);
  }

  .excerpt-source {
    font-weight: 600;
  }

  .rule-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .decided {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--text);
  }

  .rule-edit {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 0.4rem;
    font: inherit;
    font-size: 0.9em;
    padding: 0.4rem;
    border-radius: 6px;
    border: 1px solid var(--hairline);
    background: var(--surface, transparent);
    color: var(--text);
  }

  .export {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--hairline);
  }

  .preview {
    margin: 0.5rem 0 0;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    border: 1px solid var(--hairline);
    background: var(--surface-sunken, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.78em;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-x: auto;
  }
</style>
