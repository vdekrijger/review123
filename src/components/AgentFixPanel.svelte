<script lang="ts">
  /**
   * AgentFixPanel — hand findings to the user's own coding agent, and review
   * what comes back.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * WHAT THE USER REVIEWS HERE
   *
   * Not a conversation. A finding with a concrete fix goes straight to the
   * agent over the bridge; the agent works in a scratch worktree and hands back
   * one commit per finding. What this panel shows is the OUTCOME of each one:
   *
   *   which finding · what the agent did and why · which files · did the tests
   *   pass · the diff
   *
   * and, per commit, Approve or Reject. Six findings give six independent
   * commits, so accepting four and rejecting two is a `git cherry-pick`.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * THE PANEL APPLIES NOTHING. Approving is a verdict, not an action: it adds
   * the commit to the cherry-pick line at the bottom, which the user runs in
   * their own terminal. The bridge never writes outside its scratch worktree,
   * and no web origin should be able to move a commit onto a branch someone is
   * working on. That separation is deliberate, and it is stated on screen.
   *
   * NOT OFFERED AT ALL unless a write-enabled bridge is connected and the
   * checkout is on this PR's head. Every refusal is a NAMED reason from
   * `decideFixReadiness` — the UI never reconstructs "why not" from a boolean.
   */

  import Spinner from './Spinner.svelte'
  import {
    cherryPickCommand,
    currentFixReadiness,
    describeFixFailure,
    describeFixReadiness,
    describeFixSkip,
    describeFixStop,
    describeFixTests,
    fixSkipLabel,
    fixTestLabel,
    runBridgeFix,
    type FixFailure,
  } from '../lib/bridge/fixLoop'
  import {
    checkoutPr,
    currentCheckoutReadiness,
    decideCheckoutTrust,
    describeCheckout,
    describeCheckoutLanding,
    describeCheckoutTrust,
    describeStackFailure,
    prCheckoutContext,
    refreshStack,
    stackState,
    trustNeedsConfirmation,
    type CheckoutTrust,
  } from '../lib/bridge/runPr.svelte'
  import { bridgeState } from '../lib/bridge/bridge.svelte'
  import { BRIDGE_START_COMMAND } from '../lib/bridge/install'
  import { MAX_FIX_FINDINGS, type BridgeFixFinding, type BridgeFixResponse } from '../lib/bridge/protocol'
  import { track } from '../lib/analytics/analytics'
  import {
    capPatchRows,
    parseCommitPatch,
    patchIsEmpty,
    patchRowCount,
    type ParsedPatch,
  } from '../lib/diff/commitPatch'
  import { verifyAgentFix } from '../lib/ai/fixVerifyRun'
  import {
    FIX_VERIFY_EVIDENCE_CAVEAT,
    FIX_VERIFY_NEW_PROBLEM_HEADING,
    describeFixFinding,
    describeNewProblems,
    describeVerificationUnder,
    fixOutcomeLabel,
    stillOpenFindingIds,
    type FixFindingVerification,
    type FixVerificationReport,
  } from '../lib/ai/fixVerify'

  /** One eligible finding, as the parent knows it. */
  export interface FixCandidateEntry {
    /** The finding key the rest of the app uses — also the bridge's `id`. */
    key: string
    /** Reviewer name, for the row label. */
    skillName: string
    path: string
    line: number | null
    severity: 'high' | 'medium' | 'low'
    body: string
    suggestedFix: string
  }

  interface Props {
    /** The PR's head sha. The scratch worktree is created from this commit. */
    headSha: string
    /** Every finding the routing rule found eligible, strongest first. */
    candidates: FixCandidateEntry[]
  }

  let { headSha, candidates }: Props = $props()

  // ---- Readiness -----------------------------------------------------------
  // Read live from the bridge, so plugging one in mid-review lights the panel
  // up without a reload. `reason` is a named value, never a bare false.
  const readiness = $derived(currentFixReadiness(headSha))

  /**
   * Whether to render AT ALL.
   *
   * With no bridge paired we render nothing. Telling someone who has never
   * heard of the bridge that they are missing out is noise, not honesty — the
   * same rule the grounding indicator follows. Once a bridge IS connected,
   * every other reason is worth saying, because the user can act on it.
   */
  const visible = $derived(readiness.reason !== 'no-bridge' && candidates.length > 0)

  // ---- The way out of a refusal --------------------------------------------
  //
  // A refusal that names its reason and offers nothing is still a dead end.
  // `head-mismatch` in particular refuses because the working tree is not where
  // the findings are — and moving it there is a capability the user may already
  // have granted (`--allow-checkout`), with its own prior-state, stash and
  // restore handling. So the refusal offers it, ON THE SAME TERMS the top-bar
  // panel does: the same readiness rule, the same trust rule, the same stash
  // confirmation naming the files, and the same typed failures.
  //
  // `--allow-checkout` is a SEPARATE grant from `--allow-write`; neither implies
  // the other. With it absent there is no control here at all, only the sentence
  // that says which flag turns it on.

  /** Which PR the route is showing, and whose code it is. Null for any other. */
  const prCtx = $derived(prCheckoutContext(headSha))
  /** The checkout rule's own answer — never a second opinion on the head. */
  const checkout = $derived(currentCheckoutReadiness(headSha))
  /** Absent provenance is treated exactly like a fork, as it is everywhere. */
  const trust = $derived<CheckoutTrust>(
    decideCheckoutTrust({ relation: prCtx?.relation ?? 'unknown' }),
  )
  /** May the resolving action be offered at all? */
  const canOfferCheckout = $derived(
    prCtx?.ref != null && (checkout.reason === 'ready' || checkout.reason === 'tree-dirty'),
  )

  const dirtyPaths = $derived(stackState.state?.dirtyPaths ?? checkout.dirtyPaths)
  const dirtyCount = $derived(stackState.state?.dirtyCount ?? checkout.dirtyCount)

  /** Which confirmation is open, if any. One at a time, always explicit. */
  let confirm = $state<'trust' | 'stash' | null>(null)
  /** The last checkout attempt's failure sentence. Its OWN, never a generic one. */
  let checkoutError = $state<string | null>(null)
  /** Set when the checkout landed somewhere other than the reviewed commit. */
  let landing = $state<string | null>(null)

  let probed = false
  $effect(() => {
    // Re-read the tree once this panel is on screen. The head this refusal
    // rests on was last established at app start otherwise, and the user may
    // have switched branches in their terminal since — refusing (or worse,
    // offering) on a page-load-old fact is how this surface earned its bug.
    if (bridgeState.status === 'connected' && !probed) {
      probed = true
      // `refreshStack` never rejects — it resolves to null on every failure.
      void refreshStack()
    }
  })

  function beginCheckout(): void {
    if (!canOfferCheckout) return
    landing = null
    checkoutError = null
    // The scarier question first: whether to run this code at all, before what
    // to do with the user's edits. Same order as the top-bar panel.
    if (trustNeedsConfirmation(trust)) {
      confirm = 'trust'
      return
    }
    if (checkout.reason === 'tree-dirty') {
      confirm = 'stash'
      return
    }
    void doCheckout(false)
  }

  function trustAccepted(): void {
    confirm = null
    if (checkout.reason === 'tree-dirty') {
      confirm = 'stash'
      return
    }
    void doCheckout(false)
  }

  async function doCheckout(stashDirty: boolean): Promise<void> {
    confirm = null
    const ref = prCtx?.ref ?? null
    if (ref === null) return
    checkoutError = null
    const outcome = await checkoutPr({ ref, stashDirty })
    if (!outcome.ok) {
      // EVERY typed failure keeps its own sentence — `tree-dirty` and
      // `ref-unknown` are different problems with different next steps and are
      // never collapsed into "couldn't check out".
      checkoutError = describeStackFailure(outcome.failure)
      // The tree changed between the probe and the click. Offer the stash
      // rather than only complaining about it.
      if (outcome.failure.kind === 'tree-dirty') confirm = 'stash'
      return
    }
    // It worked — but a PR ref resolves at fetch time, so "it worked" and
    // "you are now on the reviewed commit" are not the same claim.
    landing = describeCheckoutLanding(outcome.value.git.head, headSha)
  }

  let startCopied = $state(false)
  async function copyStartCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(BRIDGE_START_COMMAND)
      startCopied = true
      setTimeout(() => (startCopied = false), 1_500)
    } catch {
      // Clipboard denied — the command is on screen and selectable.
    }
  }

  // ---- Selection -----------------------------------------------------------
  // Default: every eligible finding is ticked. The user unticks what they want
  // to keep for themselves — the cheapest possible "you are in charge".
  let unticked = $state<Set<string>>(new Set())

  const selectedKeys = $derived(candidates.filter((c) => !unticked.has(c.key)).map((c) => c.key))
  /** The batch is capped by the protocol; the UI says so rather than silently trimming. */
  const overCap = $derived(selectedKeys.length > MAX_FIX_FINDINGS)

  function toggle(key: string): void {
    const next = new Set(unticked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    unticked = next
  }

  function tickAll(on: boolean): void {
    unticked = on ? new Set() : new Set(candidates.map((c) => c.key))
  }

  // ---- Run state -----------------------------------------------------------
  type RunState =
    | { status: 'idle' }
    | { status: 'running'; count: number }
    | { status: 'done'; response: BridgeFixResponse }
    | { status: 'failed'; failure: FixFailure }

  let run = $state<RunState>({ status: 'idle' })
  let abort: AbortController | null = null

  /** Per-change verdict. Absent = not yet judged; the user must choose. */
  let verdicts = $state<Record<string, 'approved' | 'rejected'>>({})

  // ---- Verification -------------------------------------------------------
  //
  // ONE re-read of what the agent produced, never a loop. The reviewer that
  // raised each finding is asked whether its complaint still stands, and the
  // same call asks every polled model for problems THE FIX introduced — the
  // output nothing else in this system looks for.
  //
  // It runs automatically when a fix run lands, because "did that work?" is the
  // question the user already has at that moment, and it is cached on the
  // commit shas so re-opening the panel re-spends nothing.
  //
  // IT NEVER BLOCKS THE VERDICT. Approve and Reject work while it is still
  // running and work if it fails outright — the human's judgment is the
  // authority here, and a check that could hold it hostage would have the
  // relationship backwards.
  type VerifyState =
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; report: FixVerificationReport }

  let verify = $state<VerifyState>({ status: 'idle' })

  const verification = $derived(verify.status === 'done' ? verify.report : null)

  function verificationFor(findingId: string): FixFindingVerification | null {
    return verification?.byFinding.find((f) => f.findingId === findingId) ?? null
  }

  /** The findings this run leaves open — what another round would be FOR. */
  const stillOpen = $derived(verification === null ? [] : stillOpenFindingIds(verification))

  async function runVerification(response: BridgeFixResponse): Promise<void> {
    verify = { status: 'running' }
    try {
      const report = await verifyAgentFix(
        headSha,
        response.changes.map((c) => ({
          findingId: c.findingId,
          commit: c.commit,
          intent: c.intent,
          diff: c.diff,
          truncated: c.truncated,
        })),
        candidates.map((c) => ({
          key: c.key,
          skillName: c.skillName,
          path: c.path,
          line: c.line,
          body: c.body,
          suggestedFix: c.suggestedFix,
        })),
      )
      verify = { status: 'done', report }
    } catch {
      // A thrown pass is reported as a pass that read nothing, which every
      // per-finding row then states plainly. Swallowing it into `idle` would
      // leave the panel silent, and silence here reads as "checked, clean".
      verify = {
        status: 'done',
        report: {
          byFinding: response.changes.map((c) => ({
            findingId: c.findingId,
            persona: reviewerFor(c.findingId),
            outcome: 'not-re-read' as const,
            votes: [],
            polledModels: 0,
            agreeing: 0,
          })),
          newProblems: [],
          witnesses: [],
          calls: 0,
          failedCalls: 0,
        },
      }
    }
  }

  // ---- Rendering the agent's actual change --------------------------------
  // Parsed ONCE per run, not per re-render: a commit patch can be 256KB and
  // this is read inside an each block.
  const parsedDiffs = $derived.by(() => {
    const out = new Map<string, ParsedPatch>()
    if (run.status === 'done') {
      for (const c of run.response.changes) out.set(c.findingId, parseCommitPatch(c.diff))
    }
    return out
  })

  /** Changes whose full diff the user has asked to draw past the render cap. */
  let expanded = $state<Set<string>>(new Set())

  function expand(findingId: string): void {
    const next = new Set(expanded)
    next.add(findingId)
    expanded = next
  }

  function diffFor(findingId: string): ParsedPatch {
    return parsedDiffs.get(findingId) ?? { files: [], additions: 0, deletions: 0 }
  }

  const approvedChanges = $derived(
    run.status === 'done' ? run.response.changes.filter((c) => verdicts[c.findingId] === 'approved') : [],
  )
  const cherryPick = $derived(cherryPickCommand(approvedChanges))

  function labelFor(key: string): string {
    const candidate = candidates.find((c) => c.key === key)
    if (!candidate) return key
    return `${candidate.path}${candidate.line === null ? '' : `:${candidate.line}`}`
  }

  function reviewerFor(key: string): string {
    return candidates.find((c) => c.key === key)?.skillName ?? ''
  }

  function toWire(entry: FixCandidateEntry): BridgeFixFinding {
    return {
      id: entry.key,
      path: entry.path,
      line: entry.line,
      severity: entry.severity,
      body: entry.body,
      suggestedFix: entry.suggestedFix,
    }
  }

  async function dispatch(keys: readonly string[]): Promise<void> {
    if (!readiness.ready || readiness.cli === null) return
    const chosen = candidates.filter((c) => keys.includes(c.key))
    if (chosen.length === 0) return

    verdicts = {}
    verify = { status: 'idle' }
    expanded = new Set()
    run = { status: 'running', count: chosen.length }
    abort = new AbortController()

    // Analytics: counts and enums only. Nothing about the findings being fixed,
    // the code, the commits or the agent's own words ever leaves this machine —
    // see the PRIVACY DECISION block on bridge_fix_* in lib/analytics.
    const t0 = performance.now()
    track('bridge_fix_dispatched', { findings: chosen.length, cli: readiness.cli })

    const outcome = await runBridgeFix(readiness.cli, headSha, chosen.map(toWire), {
      signal: abort.signal,
    })
    abort = null

    if (outcome.ok) {
      const changes = outcome.response.changes
      track('bridge_fix_settled', {
        outcome: 'done',
        changes: changes.length,
        skipped: outcome.response.skipped.length,
        stop_reason: outcome.response.stopReason,
        tests_passed: changes.filter((c) => c.tests?.status === 'passed').length,
        tests_failed: changes.filter((c) => c.tests?.status === 'failed').length,
        duration_ms: Math.round(performance.now() - t0),
      })
    } else {
      // A user cancellation is not a failure — the same distinction the
      // transport already makes, kept in the metric so an abandoned run never
      // reads as a broken one.
      const cancelled = outcome.failure.kind === 'cancelled'
      track('bridge_fix_settled', {
        outcome: cancelled ? 'cancelled' : 'failed',
        // The classified KIND only. `failure.detail` can quote the bridge's or
        // a CLI's own message and is never sent.
        ...(cancelled ? {} : { failure: outcome.failure.kind }),
        duration_ms: Math.round(performance.now() - t0),
      })
    }

    run = outcome.ok
      ? { status: 'done', response: outcome.response }
      : { status: 'failed', failure: outcome.failure }

    // Close the loop: look once at what came back. Only when there IS a commit
    // to look at — a run that produced nothing but skips has no diff to re-read
    // and must not spend a model call saying so.
    if (outcome.ok && outcome.response.changes.length > 0) {
      void runVerification(outcome.response)
    }
  }

  /**
   * Send ONE finding, from outside the panel — the "Send to agent" action on
   * the finding card itself (#243 shipped that path only as the panel's "only
   * this" button, because the cards are rendered two components away).
   *
   * The panel stays the single owner of run state, so there is exactly one
   * place a fix run can be in flight and exactly one place its result renders.
   * The view scrolls to it, because a click that starts a multi-minute job
   * somewhere off-screen is a click that looks like it did nothing.
   */
  export function sendOne(key: string): void {
    if (run.status === 'running') return
    void dispatch([key])
    sectionEl?.scrollIntoView({ block: 'nearest' })
  }

  let sectionEl: HTMLElement | null = $state(null)

  function cancel(): void {
    abort?.abort()
    abort = null
    run = { status: 'idle' }
    verify = { status: 'idle' }
  }

  function reset(): void {
    run = { status: 'idle' }
    verdicts = {}
    verify = { status: 'idle' }
    expanded = new Set()
  }

  /**
   * Send the findings this run left OPEN back for another round.
   *
   * THE USER'S CALL, ONE CLICK — never automatic. The inner loop in
   * bridge/src/fix.ts terminates on the TESTS, an oracle with no opinion;
   * looping out here on FINDINGS would terminate on reviewer judgment, which
   * this repo has measured returning 1/3 and 3/3 on the same defect in
   * identical code. A fixer optimising against its own reviewer converges on
   * text that satisfies the reviewer, not on correct code. So the machine
   * reports, and the person decides whether it is worth another turn.
   */
  function sendStillOpen(): void {
    if (stillOpen.length === 0 || run.status === 'running') return
    void dispatch(stillOpen)
    sectionEl?.scrollIntoView({ block: 'nearest' })
  }

  function setVerdict(findingId: string, verdict: 'approved' | 'rejected'): void {
    verdicts = { ...verdicts, [findingId]: verdict }
  }

  let copied = $state(false)
  async function copyCherryPick(): Promise<void> {
    try {
      await navigator.clipboard.writeText(cherryPick)
      copied = true
      setTimeout(() => (copied = false), 1_500)
    } catch {
      // Clipboard denied — the command is on screen and selectable.
    }
  }

  function firstLine(text: string): string {
    const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
    return line.length > 140 ? `${line.slice(0, 139)}…` : line
  }
</script>

{#if visible}
  <section class="agent-fix" data-testid="agent-fix-panel" data-ready={readiness.ready} bind:this={sectionEl}>
    <header class="afx-head">
      <h3 class="afx-title">Fix with your agent</h3>
      <p class="afx-readiness" data-testid="agent-fix-readiness" data-reason={readiness.reason}>
        {describeFixReadiness(readiness, headSha)}
      </p>
    </header>

    {#if !readiness.ready}
      <!-- NEVER a refusal with nothing to do about it. Each reason gets the
           resolving action it actually has — and the ones whose resolution is
           only possible at the user's own terminal say so and stop there,
           rather than growing a button that would lie. -->
      <div class="afx-wayout" data-testid="agent-fix-wayout" data-reason={readiness.reason}>
        {#if readiness.reason === 'head-mismatch'}
          {#if canOfferCheckout}
            <div class="afx-actions">
              <button
                type="button"
                class="afx-send"
                data-testid="agent-fix-checkout"
                disabled={stackState.busy}
                onclick={beginCheckout}
              >
                {#if stackState.busy}<Spinner />{/if}
                Bring my checkout to this PR
              </button>
              <span class="afx-note" data-testid="agent-fix-checkout-note">
                {checkout.reason === 'tree-dirty'
                  ? `Your checkout has ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}. Nothing is touched until you choose to stash them.`
                  : 'Moves your working tree onto this pull request. review123 records where you were, so the top bar can put it back.'}
              </span>
            </div>
          {:else}
            <!-- No control where the capability is absent — and the sentence
                 names the flag that grants it, not the adjacent one. -->
            <p
              class="afx-note"
              data-testid="agent-fix-checkout-blocked"
              data-reason={prCtx?.ref == null ? 'no-ref' : checkout.reason}
            >
              {prCtx?.ref == null
                ? 'This provider does not expose a pull-request ref the bridge can fetch, so review123 cannot move your checkout for you.'
                : describeCheckout(checkout)}
            </p>
          {/if}
        {:else if readiness.reason === 'write-disabled' || readiness.reason === 'no-repo-state'}
          <!-- Both resolve to the same thing: restart the bridge, from inside
               the repository, with the grants. Nothing review123 sends can turn
               either on — that is the point of the flags — so the panel hands
               over the command rather than a button it cannot back. -->
          <div class="afx-cherry">
            <code data-testid="agent-fix-start-command">{BRIDGE_START_COMMAND}</code>
            <button type="button" class="afx-link" onclick={copyStartCommand}>
              {startCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {#if readiness.reason === 'no-repo-state'}
            <p class="afx-note">Run it from inside the repository you are reviewing — <code>--root .</code> is what it serves.</p>
          {/if}
        {/if}

        {#if confirm === 'trust'}
          <!-- Whose code is about to run. Same sentence, same rule, same
               treatment of "cannot prove it is not a fork" as the top bar. -->
          <div class="afx-confirm" data-testid="agent-fix-trust-confirm">
            <p class="afx-confirm-text" data-testid="agent-fix-trust-text">{describeCheckoutTrust(trust)}</p>
            <div class="afx-actions">
              <button type="button" class="afx-send" data-testid="agent-fix-trust-accept" onclick={trustAccepted}>
                I've read the diff — check it out
              </button>
              <button type="button" class="afx-link" data-testid="agent-fix-trust-cancel" onclick={() => (confirm = null)}>
                Cancel
              </button>
            </div>
          </div>
        {/if}

        {#if confirm === 'stash'}
          <div class="afx-confirm" data-testid="agent-fix-stash-confirm">
            <p class="afx-confirm-text">
              These {dirtyCount} file{dirtyCount === 1 ? '' : 's'} will be moved into a
              <code>git stash</code> entry so this pull request can be checked out. Nothing is deleted,
              and restoring puts them back.
            </p>
            <!-- NAMING THE FILES IS THE POINT: a prompt that says "you have
                 uncommitted changes" asks the user to trust a claim they
                 cannot check. -->
            <ul class="afx-dirty-list" data-testid="agent-fix-dirty-list">
              {#each dirtyPaths as path (path)}
                <li><code>{path}</code></li>
              {/each}
            </ul>
            {#if dirtyCount > dirtyPaths.length}
              <p class="afx-note">…and {dirtyCount - dirtyPaths.length} more.</p>
            {/if}
            <div class="afx-actions">
              <button type="button" class="afx-send" data-testid="agent-fix-stash-accept" onclick={() => doCheckout(true)}>
                Stash and check out
              </button>
              <button type="button" class="afx-link" data-testid="agent-fix-stash-cancel" onclick={() => (confirm = null)}>
                Cancel
              </button>
            </div>
          </div>
        {/if}

        {#if landing !== null}
          <p class="afx-warn" role="status" data-testid="agent-fix-landing">{landing}</p>
        {/if}

        {#if checkoutError !== null}
          <div class="afx-error" role="alert" data-testid="agent-fix-checkout-error">
            <p>{checkoutError}</p>
          </div>
        {/if}
      </div>
    {/if}

    {#if readiness.ready}
      {#if run.status === 'idle'}
        <!-- Selection. Everything eligible is ticked; untick what you want to
             keep. The rule that got these here is stated once, plainly. -->
        <div class="afx-select-head">
          <span class="afx-count" data-testid="agent-fix-count">
            {selectedKeys.length} of {candidates.length} selected
          </span>
          <button type="button" class="afx-link" onclick={() => tickAll(true)}>Select all</button>
          <button type="button" class="afx-link" onclick={() => tickAll(false)}>Select none</button>
        </div>

        <ul class="afx-candidates">
          {#each candidates as candidate (candidate.key)}
            <li class="afx-candidate" data-testid="agent-fix-candidate" data-finding-key={candidate.key}>
              <label class="afx-candidate-label">
                <input
                  type="checkbox"
                  checked={!unticked.has(candidate.key)}
                  onchange={() => toggle(candidate.key)}
                  data-testid="agent-fix-checkbox"
                />
                <span class="afx-sev afx-sev-{candidate.severity}">{candidate.severity}</span>
                <span class="afx-loc">{candidate.path}{candidate.line === null ? '' : `:${candidate.line}`}</span>
                <span class="afx-body">{firstLine(candidate.body)}</span>
              </label>
              <!-- The single-finding path. A batch is the default, but one
                   finding at a time is the cheapest way to try the loop out —
                   and the only sensible move for a finding you half-trust. -->
              <button
                type="button"
                class="afx-only"
                title="Send only this finding to {readiness.cli}"
                onclick={() => dispatch([candidate.key])}
                data-testid="agent-fix-send-one"
              >only this</button>
            </li>
          {/each}
        </ul>

        {#if overCap}
          <p class="afx-warn" role="alert" data-testid="agent-fix-over-cap">
            The bridge accepts at most {MAX_FIX_FINDINGS} findings per run. Untick some, or send them in
            two batches.
          </p>
        {/if}

        <div class="afx-actions">
          <button
            type="button"
            class="afx-send"
            disabled={selectedKeys.length === 0 || overCap}
            onclick={() => dispatch(selectedKeys)}
            data-testid="agent-fix-send"
          >
            Send {selectedKeys.length} to {readiness.cli}
          </button>
          <span class="afx-note">
            Runs on your machine, in a scratch worktree. Your checkout is never touched and nothing is
            pushed.
          </span>
        </div>
      {/if}

      {#if run.status === 'running'}
        <div class="afx-progress" data-testid="agent-fix-progress" role="status">
          <Spinner />
          <span>
            {run.count}
            {run.count === 1 ? 'finding' : 'findings'} with {readiness.cli} — one commit each, tests after
            every fix. This can take a few minutes.
          </span>
          <button type="button" class="afx-link" onclick={cancel} data-testid="agent-fix-cancel">Cancel</button>
        </div>
      {/if}

      {#if run.status === 'failed'}
        <div class="afx-error" role="alert" data-testid="agent-fix-error" data-kind={run.failure.kind}>
          <p>{describeFixFailure(run.failure)}</p>
          <button type="button" class="afx-link" onclick={reset} data-testid="agent-fix-retry">Back</button>
        </div>
      {/if}

      {#if run.status === 'done'}
        <div class="afx-results">
          <p class="afx-stop" data-testid="agent-fix-stop" data-stop={run.response.stopReason}>
            {describeFixStop(run.response.stopReason, run.response.rounds)}
          </p>

          <!-- THE EVIDENCE CAVEAT, stated ONCE and before any result — it is a
               property of the pass, not of each row, and repeating it per
               finding would turn the thing that must be read into wallpaper.
               It says what the re-read is worth AND that this is not the code
               review: a reviewer going quiet is not a person having read it. -->
          {#if verify.status !== 'idle'}
            <div class="afx-verify-head" data-testid="agent-fix-verify-head">
              <p class="afx-caveat">{FIX_VERIFY_EVIDENCE_CAVEAT}</p>
              {#if verification !== null && verification.witnesses.length > 0}
                <p class="afx-note" data-testid="agent-fix-witnesses">
                  Who looked: {verification.witnesses.join(', ')}.
                  {#if verification.failedCalls > 0}
                    {verification.failedCalls} of {verification.calls} calls failed and are not counted.
                  {/if}
                </p>
              {:else if verification !== null}
                <p class="afx-note" data-testid="agent-fix-witnesses">
                  No model answered, so nothing below was re-read.
                </p>
              {/if}
            </div>
          {/if}

          {#each run.response.changes as change (change.findingId)}
            {@const parsed = diffFor(change.findingId)}
            {@const capped = capPatchRows(
              parsed,
              expanded.has(change.findingId) ? Number.MAX_SAFE_INTEGER : undefined,
            )}
            <article
              class="afx-change"
              data-testid="agent-fix-result"
              data-finding-id={change.findingId}
              data-verdict={verdicts[change.findingId] ?? 'undecided'}
              class:approved={verdicts[change.findingId] === 'approved'}
              class:rejected={verdicts[change.findingId] === 'rejected'}
            >
              <header class="afx-change-head">
                <span class="afx-reviewer">{reviewerFor(change.findingId)}</span>
                <span class="afx-loc">{labelFor(change.findingId)}</span>
                <span
                  class="afx-tests afx-tests-{change.tests?.status ?? 'none'}"
                  data-testid="agent-fix-tests"
                  data-status={change.tests?.status ?? 'none'}
                  title={describeFixTests(change.tests)}
                >{fixTestLabel(change.tests)}</span>
                <code class="afx-sha">{change.commit.slice(0, 7)}</code>
              </header>

              <!-- INTENT is the thing being reviewed. It is the agent's own
                   sentence — never one this app composed on its behalf. -->
              <p class="afx-intent" data-testid="agent-fix-intent">{change.intent}</p>

              {#if change.files.length > 0}
                <p class="afx-files">{change.files.join(', ')}</p>
              {/if}

              {#if change.stopReason !== 'all-addressed'}
                <p class="afx-change-stop" data-testid="agent-fix-change-stop">
                  {describeFixStop(change.stopReason, change.rounds)}
                </p>
              {/if}

              {#if change.tests !== null && change.tests.status !== 'passed'}
                <details class="afx-test-output">
                  <summary>{describeFixTests(change.tests)}</summary>
                  <pre>{change.tests.output}</pre>
                </details>
              {/if}

              <!-- WHAT THE RE-READ OBSERVED. Never a green check that says
                   "fixed": the chip and the sentence both report a REVIEWER
                   ("did not raise it again"), and the evidence caveat above
                   the results says why that is not the same claim. -->
              {#if verify.status === 'running'}
                <p class="afx-verify afx-verify-pending" data-testid="agent-fix-verify" data-outcome="running">
                  <Spinner />
                  <span>{reviewerFor(change.findingId)} is re-reading this against the diff…</span>
                </p>
              {:else if verificationFor(change.findingId)}
                {@const v = verificationFor(change.findingId)!}
                <p
                  class="afx-verify afx-verify-{v.outcome}"
                  data-testid="agent-fix-verify"
                  data-outcome={v.outcome}
                >
                  <span class="afx-verify-chip">{fixOutcomeLabel(v.outcome)}</span>
                  <span class="afx-verify-text">{describeFixFinding(v)}</span>
                </p>
                <!-- DELIVERABLE 3: the loop's own verdict is not negotiable.
                     round-cap means the commit came back RED; no-progress and
                     repeat-diff mean stuck or oscillating. A quiet re-read does
                     not get to soften any of them. -->
                {#if describeVerificationUnder(change.stopReason) !== null}
                  <p class="afx-warn" data-testid="agent-fix-verify-under" data-stop={change.stopReason}>
                    {describeVerificationUnder(change.stopReason)}
                  </p>
                {/if}
              {/if}

              <!-- THE CHANGE ITSELF. The user asked to see it, not a summary of
                   it, so it is drawn rather than hidden behind a disclosure. -->
              <div class="afx-diff" data-testid="agent-fix-diff" data-truncated={change.truncated}>
                {#if change.truncated}
                  <!-- The BRIDGE's byte cap: part of this diff never arrived.
                       Said before the rows, so an amputated diff is never read
                       as a whole one. -->
                  <p class="afx-warn" data-testid="agent-fix-diff-truncated">
                    This diff was too large to send whole, so the bridge cut it. What follows is the
                    beginning of the change, not all of it — read the commit itself before taking it.
                  </p>
                {/if}

                {#if patchIsEmpty(parsed)}
                  <p class="afx-note" data-testid="agent-fix-diff-empty">
                    The commit carries no textual diff to show{change.files.length > 0
                      ? ' for these files'
                      : ''}.
                  </p>
                {:else}
                  {#each capped.files as file, i (file.path + i)}
                    <div class="afx-file">
                      <div class="afx-file-head">
                        <code class="afx-file-path">
                          {#if file.oldPath !== null}{file.oldPath} &rarr; {/if}{file.path || 'unnamed file'}
                        </code>
                        <span class="afx-file-status">{file.status}</span>
                        <span class="afx-file-stat afx-stat-add">+{file.additions}</span>
                        <span class="afx-file-stat afx-stat-del">&minus;{file.deletions}</span>
                      </div>
                      {#if file.binary}
                        <p class="afx-note">Binary file — git produced no textual diff.</p>
                      {:else}
                        {#each file.hunks as hunk, h (h)}
                          <div class="afx-hunk-head"><code>{hunk.header}</code></div>
                          {#each hunk.lines as line, l (l)}
                            <div class="afx-row afx-row-{line.kind}">
                              <span class="afx-ln">{line.oldLine ?? ''}</span>
                              <span class="afx-ln">{line.newLine ?? ''}</span>
                              <span class="afx-mark" aria-hidden="true"
                                >{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span
                              >
                              <code class="afx-code">{line.text}</code>
                            </div>
                          {/each}
                        {/each}
                      {/if}
                    </div>
                  {/each}

                  {#if capped.hidden > 0}
                    <!-- The RENDER cap, which is a different thing from the
                         bridge's byte cap above and says so: this diff arrived
                         whole, it is simply too long to draw at once. -->
                    <div class="afx-actions">
                      <button
                        type="button"
                        class="afx-link"
                        data-testid="agent-fix-diff-expand"
                        onclick={() => expand(change.findingId)}
                      >
                        Show the remaining {capped.hidden} lines
                      </button>
                      <span class="afx-note">
                        All {patchRowCount(parsed)} lines arrived; only the first are drawn.
                      </span>
                    </div>
                  {/if}
                {/if}
              </div>

              <div class="afx-verdict">
                <button
                  type="button"
                  class="afx-approve"
                  aria-pressed={verdicts[change.findingId] === 'approved'}
                  onclick={() => setVerdict(change.findingId, 'approved')}
                  data-testid="agent-fix-approve"
                >Approve</button>
                <button
                  type="button"
                  class="afx-reject"
                  aria-pressed={verdicts[change.findingId] === 'rejected'}
                  onclick={() => setVerdict(change.findingId, 'rejected')}
                  data-testid="agent-fix-reject"
                >Reject</button>
              </div>
            </article>
          {/each}

          {#each run.response.skipped as skip (skip.findingId)}
            <!-- A skip is a RESULT, not a gap. A refusal especially: the agent
                 read the finding and disagreed, which is exactly what it was
                 asked to do when a finding is wrong. -->
            <article class="afx-skip" data-testid="agent-fix-skip" data-reason={skip.reason}>
              <header class="afx-change-head">
                <span class="afx-reviewer">{reviewerFor(skip.findingId)}</span>
                <span class="afx-loc">{labelFor(skip.findingId)}</span>
                <span class="afx-skip-chip">{fixSkipLabel(skip.reason)}</span>
              </header>
              <p class="afx-intent">{describeFixSkip(skip)}</p>
            </article>
          {/each}

          {#if run.response.changes.length === 0 && run.response.skipped.length === 0}
            <p class="afx-empty">The agent produced no changes and reported no reasons.</p>
          {/if}

          <!-- THE MOST VALUABLE OUTPUT HERE: problems the fix ITSELF introduced.
               Nothing else in the system looks for these — the fix loop
               terminates on the tests, and the tests only know what they
               already covered. -->
          {#if verification !== null && verify.status === 'done'}
            <section class="afx-new" data-testid="agent-fix-new-problems" data-count={verification.newProblems.length}>
              <h4 class="afx-new-title">{FIX_VERIFY_NEW_PROBLEM_HEADING}</h4>
              <p class="afx-note">
                {describeNewProblems(verification.newProblems.length, verification.calls - verification.failedCalls)}
              </p>
              {#each verification.newProblems as problem (problem.key)}
                <article class="afx-new-item" data-testid="agent-fix-new-problem" data-severity={problem.severity}>
                  <header class="afx-change-head">
                    <span class="afx-sev afx-sev-{problem.severity}">{problem.severity}</span>
                    <span class="afx-loc">{problem.path}{problem.line === null ? '' : `:${problem.line}`}</span>
                    <span class="afx-new-chip">
                      raised by {problem.raisedBy.length} of {problem.polledModels}
                    </span>
                  </header>
                  <p class="afx-intent">{problem.body}</p>
                  {#if problem.suggestedFix}
                    <p class="afx-note">{problem.suggestedFix}</p>
                  {/if}
                  <p class="afx-note">{problem.raisedBy.join(', ')}</p>
                </article>
              {/each}
            </section>
          {/if}

          <!-- ANOTHER ROUND IS A CHOICE, NOT A LOOP. One click, and it says
               exactly what it would send. -->
          {#if stillOpen.length > 0}
            <div class="afx-actions" data-testid="agent-fix-still-open">
              <button
                type="button"
                class="afx-send"
                data-testid="agent-fix-send-open"
                disabled={run.status !== 'done'}
                onclick={sendStillOpen}
              >
                Send the {stillOpen.length} still-open {stillOpen.length === 1 ? 'finding' : 'findings'} back to {readiness.cli}
              </button>
              <span class="afx-note">
                Starts a fresh run over just those, from this pull request's head again. Your approvals
                above are cleared, and the commits already made stay on the scratch branch.
              </span>
            </div>
          {/if}

          <footer class="afx-footer">
            {#if approvedChanges.length > 0}
              <p class="afx-apply-note">
                Nothing has been applied. These commits live on the bridge's scratch branch
                <code>{run.response.branch}</code> in your own repository — take the ones you approved:
              </p>
              <div class="afx-cherry">
                <code data-testid="agent-fix-cherry-pick">{cherryPick}</code>
                <button type="button" class="afx-link" onclick={copyCherryPick}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            {:else}
              <p class="afx-apply-note">
                Nothing has been applied, and nothing was pushed. Approve a change to get the command that
                takes it.
              </p>
            {/if}
            <button type="button" class="afx-link" onclick={reset} data-testid="agent-fix-done">
              Start another run
            </button>
          </footer>
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  /* ── The verification block ───────────────────────────────────────────────
     Deliberately quiet. There is no green, no check mark and no success
     colour anywhere in here: a finding going quiet is an observation, and
     painting it with the palette's "good" signal would say the thing the
     words are careful not to. Only the two states that ask for ATTENTION —
     still raised, and a problem the fix introduced — are tinted at all. */
  .afx-verify {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
  }

  .afx-verify-chip {
    flex: none;
    padding: 0 var(--space-1);
    border: 1px solid var(--hairline);
    border-radius: var(--space-1);
    background: var(--surface);
    color: var(--text-secondary);
    font-weight: 600;
    white-space: nowrap;
  }

  /* Still raised and could-not-tell are the states that want the eye. */
  .afx-verify-still-standing .afx-verify-chip,
  .afx-verify-could-not-tell .afx-verify-chip {
    border-color: var(--legend-removed-border);
    background: var(--legend-removed-bg);
    color: var(--legend-removed-color);
  }

  .afx-verify-text {
    flex: 1 1 16rem;
    color: var(--text-secondary);
  }

  .afx-verify-pending {
    color: var(--text-muted);
  }

  .afx-verify-head {
    margin-top: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: var(--space-1);
    background: var(--surface);
  }

  .afx-caveat {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .afx-new {
    margin-top: var(--space-3);
    padding-top: var(--space-2);
    border-top: 1px solid var(--hairline);
  }

  .afx-new-title {
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .afx-new-item {
    margin-top: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--legend-removed-border);
    border-radius: var(--space-1);
    background: var(--surface);
  }

  .afx-new-chip {
    padding: 0 var(--space-1);
    border-radius: var(--space-1);
    background: var(--surface-sunken);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  /* ── The change itself ────────────────────────────────────────────────────
     Painted from the SAME tokens as the real diff viewer's theme
     (src/components/diff-view-theme.css), so the two surfaces read as one
     system, without dragging in a renderer that needs whole files the bridge
     never sends. */
  .afx-file {
    margin-top: var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: var(--space-1);
    overflow: hidden;
  }

  .afx-file-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--hairline);
    font-size: var(--text-xs);
  }

  .afx-file-path {
    flex: 1 1 12rem;
    min-width: 0;
    overflow-wrap: anywhere;
    font-weight: 600;
  }

  .afx-file-status {
    color: var(--text-muted);
  }

  .afx-file-stat {
    font-variant-numeric: tabular-nums;
  }

  .afx-stat-add {
    color: var(--legend-added-color);
  }

  .afx-stat-del {
    color: var(--legend-removed-color);
  }

  .afx-hunk-head {
    padding: var(--space-1) var(--space-2);
    background: var(--surface-sunken);
    color: var(--text-muted);
    font-size: var(--text-xs);
    overflow-x: auto;
  }

  .afx-row {
    display: flex;
    align-items: flex-start;
    background: var(--surface);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .afx-row-add {
    background: var(--legend-added-bg);
  }

  .afx-row-del {
    background: var(--legend-removed-bg);
  }

  .afx-row-meta {
    background: var(--surface-sunken);
    color: var(--text-muted);
  }

  .afx-ln {
    flex: none;
    width: 3.5rem;
    padding: 0 var(--space-1);
    background: var(--surface-sunken);
    color: var(--text-secondary);
    text-align: right;
    font-variant-numeric: tabular-nums;
    user-select: none;
  }

  .afx-row-add .afx-ln {
    background: var(--diff-added-emphasis);
  }

  .afx-row-del .afx-ln {
    background: var(--diff-removed-emphasis);
  }

  .afx-mark {
    flex: none;
    width: var(--space-4);
    padding-left: var(--space-1);
    color: var(--text-secondary);
    user-select: none;
  }

  .afx-code {
    flex: 1 1 auto;
    min-width: 0;
    padding-right: var(--space-2);
    color: var(--syntax-ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 2;
  }

  /* Narrow windows: the gutter is the first thing worth its space back. */
  @media (max-width: 30rem) {
    .afx-ln {
      width: 2.25rem;
    }
  }

  .agent-fix {
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    background: var(--surface-sunken);
    padding: 0.75rem 0.9rem;
    margin: 0.75rem 0;
    font-size: 0.85rem;
  }

  .afx-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }

  .afx-title {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 700;
  }

  .afx-readiness {
    margin: 0;
    flex: 1 1 18rem;
    color: var(--text-muted);
    font-size: 0.78rem;
  }

  .afx-select-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.6rem;
  }

  .afx-count {
    font-weight: 600;
    font-size: 0.78rem;
  }

  .afx-link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    text-decoration: underline;
  }

  .afx-candidates {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .afx-candidate {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }

  .afx-candidate-label {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    cursor: pointer;
    padding: 0.15rem 0;
    flex: 1;
    min-width: 0;
  }

  .afx-only {
    font: inherit;
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
  }

  .afx-sev {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    white-space: nowrap;
  }

  .afx-sev-high {
    background: var(--legend-removed-bg);
    color: var(--legend-removed-color);
    border: 1px solid var(--legend-removed-border);
  }

  .afx-sev-medium {
    background: var(--legend-changed-bg);
    color: var(--legend-changed-color);
    border: 1px solid var(--legend-changed-border);
  }

  .afx-sev-low {
    background: var(--surface-sunken);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }

  .afx-loc {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .afx-body {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .afx-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.7rem;
  }

  .afx-send {
    font: inherit;
    font-weight: 600;
    padding: 0.3rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }

  .afx-send:disabled {
    opacity: var(--disabled-opacity);
    cursor: not-allowed;
  }

  .afx-note,
  .afx-apply-note {
    color: var(--text-muted);
    font-size: 0.75rem;
    margin: 0;
  }

  .afx-wayout {
    margin-top: var(--space-2);
  }

  .afx-confirm {
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--surface);
  }

  .afx-confirm-text {
    margin: 0;
    font-size: var(--text-xs);
  }

  .afx-dirty-list {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    font-size: var(--text-xs);
  }

  .afx-warn {
    color: var(--legend-changed-color);
    font-size: 0.78rem;
    margin: 0.5rem 0 0;
  }

  .afx-progress {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.7rem;
    font-size: 0.8rem;
  }

  .afx-error {
    margin-top: 0.7rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--legend-removed-border);
    background: var(--legend-removed-bg);
    color: var(--legend-removed-color);
    border-radius: 6px;
    font-size: 0.8rem;
  }

  .afx-error p {
    margin: 0 0 0.35rem;
  }

  .afx-results {
    margin-top: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .afx-stop {
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .afx-change,
  .afx-skip {
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
    background: var(--surface);
  }

  /* VERDICT is the only thing these two modifiers encode — a left rule, never
     a whole-card recolour that would compete with severity. */
  .afx-change.approved {
    border-left: 3px solid var(--legend-added-border);
  }

  .afx-change.rejected {
    opacity: 0.55;
    border-left: 3px solid var(--border-subtle);
  }

  .afx-change-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    margin-bottom: 0.3rem;
  }

  .afx-reviewer {
    font-size: 0.72rem;
    font-weight: 600;
    opacity: 0.75;
  }

  .afx-sha {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-left: auto;
  }

  .afx-tests,
  .afx-skip-chip {
    font-size: 0.68rem;
    font-weight: 600;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    background: var(--surface-sunken);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .afx-tests-passed {
    background: var(--legend-added-bg);
    color: var(--legend-added-color);
    border-color: var(--legend-added-border);
  }

  .afx-tests-failed,
  .afx-tests-timeout {
    background: var(--legend-removed-bg);
    color: var(--legend-removed-color);
    border-color: var(--legend-removed-border);
  }

  .afx-intent {
    margin: 0 0 0.3rem;
  }

  .afx-files,
  .afx-change-stop {
    margin: 0 0 0.3rem;
    font-size: 0.74rem;
    color: var(--text-muted);
  }

  .afx-test-output pre {
    margin: 0.35rem 0 0;
    padding: 0.4rem 0.5rem;
    max-height: 22rem;
    overflow: auto;
    font-size: 0.72rem;
    line-height: 1.35;
    background: var(--surface-sunken);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    white-space: pre;
  }

  .afx-diff {
    margin-top: var(--space-2);
  }

  .afx-test-output summary {
    cursor: pointer;
    font-size: 0.76rem;
    color: var(--text-muted);
  }

  .afx-verdict {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.45rem;
  }

  .afx-approve,
  .afx-reject {
    font: inherit;
    font-size: 0.78rem;
    padding: 0.2rem 0.6rem;
    border-radius: 5px;
    border: 1px solid var(--border-subtle);
    background: var(--surface-sunken);
    cursor: pointer;
  }

  .afx-approve[aria-pressed='true'] {
    background: var(--legend-added-bg);
    color: var(--legend-added-color);
    border-color: var(--legend-added-border);
  }

  .afx-reject[aria-pressed='true'] {
    background: var(--legend-removed-bg);
    color: var(--legend-removed-color);
    border-color: var(--legend-removed-border);
  }

  .afx-footer {
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .afx-cherry {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .afx-cherry code {
    font-size: 0.75rem;
    padding: 0.2rem 0.4rem;
    background: var(--surface-sunken);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    overflow-x: auto;
  }

  .afx-empty {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
</style>
