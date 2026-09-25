<script lang="ts">
  /**
   * CiFixPanel — a CI run is red; hand it to the local agent, then decide
   * whether to push what came back.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * THE TWO THINGS THIS SURFACE REFUSES TO BLUR
   *
   * 1. WHETHER THE FAILURE WAS EVER SEEN TO FAIL HERE. The bridge runs the
   *    repository's own test command at the pull request's head BEFORE starting
   *    any agent. If it passes, no agent runs, no diff exists and there is
   *    nothing to push — and this panel leads with that rather than burying it
   *    under an empty result. A CI failure that will not reproduce is a normal,
   *    common outcome (a different OS, a missing secret, a flaky test), and the
   *    honest surface for it is one that says so and names the next move.
   *
   * 2. WHAT A GREEN LOCAL RUN MEANS. It means one command, on one machine,
   *    stopped failing. It does not mean CI will pass, and it does not mean the
   *    defect is gone. Pushing makes CI run again; what CI then reports is a
   *    NEW RESULT, not a verdict. Every result here carries that sentence, and
   *    no surface in this file renders a green check as a conclusion.
   *
   * AND THE PUSH ITSELF. It is the only thing review123 does that leaves the
   * machine and the only one nobody can undo, so the confirmation names the
   * remote, the branch, the commit the branch is at now and the commit it will
   * be at — all four, every time, unshortened on the second push.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * MOUNTING IT. Everything it needs is in `Props` below: a pull-request ref, a
   * head sha and the CI summary the caller already has. It fetches its own push
   * target and its own logs, so a queue row can render it with three props and
   * no new plumbing.
   */
  import { track } from '../lib/analytics/analytics'
  import { bridgeState } from '../lib/bridge/bridge.svelte'
  import {
    currentFixReadiness,
    describeFixReadiness,
    fixCliChoices,
    readFixCliPref,
    writeFixCliPref,
  } from '../lib/bridge/fixLoop'
  import {
    CI_FIX_LOCAL_ONLY,
    CI_FIX_NOT_REVIEWED,
    describeCiFixFailure,
    describeCiStop,
    describeNoReproductionNextStep,
    describeReproduction,
    pushableCommit,
    runBridgeCiFix,
    type CiFixFailure,
  } from '../lib/bridge/ciFix'
  import {
    CI_LOGS_UNAVAILABLE,
    gatherCiFailures,
    getPushTarget,
    type CiFailureEvidence,
    type PushTarget,
  } from '../lib/bridge/ciFailures'
  import {
    DEFAULT_PUSH_REMOTE,
    PUSH_CONSEQUENCE,
    PUSH_GUARANTEES,
    PUSH_NOT_A_VERDICT,
    describePushFailure,
    describePushPlan,
    describePushResult,
    runBridgePush,
    type PushFailure,
  } from '../lib/bridge/push'
  import type { BridgeCiFixResponse, BridgeCli, BridgePushResponse } from '../lib/bridge/protocol'
  import type { CiSummary } from '../lib/github/checks'
  import type { PrRefX } from '../lib/provider/types'
  import Spinner from './Spinner.svelte'

  /** What the parent tells this panel when the run settles. Counts and enums. */
  export interface CiFixSettled {
    reproduction: BridgeCiFixResponse['reproduction']
    changes: number
    /** True once a push landed, so a queue row can re-read CI. */
    pushed: boolean
  }

  interface Props {
    /** Which pull request. Used to read the head branch and the failing jobs. */
    pr: PrRefX
    /**
     * The pull request's head sha — the commit CI failed on, and the commit the
     * bridge's scratch worktree is created from. The panel refuses to run when
     * the paired bridge's checkout is somewhere else.
     */
    headSha: string
    /**
     * The CI summary the caller already fetched. Passed in rather than fetched
     * here so this never becomes a second, disagreeing source of "is CI red".
     * Null means unknown, which is not the same as green.
     */
    ci: CiSummary | null
    /**
     * Re-read CI after a push. ABSENT MEANS THE AFFORDANCE IS NOT OFFERED —
     * never offered and then quietly dropped.
     */
    onRefreshCi?: (() => void) | null
    /** Told once when the run settles, so a queue row can update itself. */
    onSettled?: ((summary: CiFixSettled) => void) | null
  }

  let { pr, headSha, ci, onRefreshCi = null, onSettled = null }: Props = $props()

  type RunState =
    | { status: 'idle' }
    | { status: 'gathering' }
    | { status: 'running' }
    | { status: 'done'; response: BridgeCiFixResponse; evidence: CiFailureEvidence[] }
    | { status: 'failed'; failure: CiFixFailure }

  type PushState =
    | { status: 'idle' }
    | { status: 'confirming'; target: PushTarget }
    | { status: 'pushing' }
    | { status: 'pushed'; response: BridgePushResponse }
    | { status: 'refused'; failure: PushFailure }
    | { status: 'no-target'; why: string }

  let run = $state<RunState>({ status: 'idle' })
  let push = $state<PushState>({ status: 'idle' })
  let cliChoice = $state<BridgeCli | null>(readFixCliPref())

  // Non-reactive on purpose: a click must read the current controller, not the
  // one a re-render happened to capture.
  let abort: AbortController | null = null

  const failingJobs = $derived(ci?.failures ?? [])
  const readiness = $derived(currentFixReadiness(headSha, cliChoice))
  const choices = $derived(fixCliChoices(bridgeState.capabilities?.inference ?? []))
  const busy = $derived(run.status === 'gathering' || run.status === 'running' || push.status === 'pushing')

  /** The panel exists at all only when CI is red. Silence is not a surface. */
  const visible = $derived(failingJobs.length > 0)

  const response = $derived(run.status === 'done' ? run.response : null)
  const commitToPush = $derived(response === null ? null : pushableCommit(response))
  const logsMissing = $derived(
    run.status === 'done' && run.evidence.length > 0 && run.evidence.every((e) => e.logUnavailable),
  )

  function chooseCli(cli: BridgeCli): void {
    cliChoice = cli
    writeFixCliPref(cli)
  }

  async function start(): Promise<void> {
    if (busy) return
    const cli = readiness.cli
    if (cli === null) return

    abort = new AbortController()
    const startedAt = performance.now()
    run = { status: 'gathering' }

    let evidence: CiFailureEvidence[] = []
    try {
      evidence = await gatherCiFailures(pr, headSha, ci!, abort.signal)
    } catch {
      // Gathering is enrichment. A failure here must not stop the flow: the
      // signal the agent is verified against is the bridge's own local run,
      // not anything fetched from GitHub.
      evidence = failingJobs.map((f) => ({
        id: `check:${f.name}`,
        name: f.name,
        log: '(no output could be read for this job)',
        logUnavailable: true,
        url: f.url ?? null,
      }))
    }

    run = { status: 'running' }
    const outcome = await runBridgeCiFix(
      cli,
      headSha,
      evidence.map((e) => ({ id: e.id, name: e.name, log: e.log })),
      { signal: abort.signal },
    )

    // Analytics: counts and enums only. Nothing about the jobs, the logs, the
    // repository, the branch or the commits ever leaves this machine — see the
    // PRIVACY DECISION block on bridge_ci_fix_* in lib/analytics.
    const duration = Math.round(performance.now() - startedAt)
    if (outcome.ok) {
      run = { status: 'done', response: outcome.response, evidence }
      track('bridge_ci_fix_settled', {
        reproduction: outcome.response.reproduction,
        jobs: evidence.length,
        logs_missing: evidence.filter((e) => e.logUnavailable).length,
        cli,
        outcome: 'done',
        changes: outcome.response.changes.length,
        stop_reason: outcome.response.stopReason,
        tests_green: outcome.response.tests?.status === 'passed',
        duration_ms: duration,
      })
      onSettled?.({
        reproduction: outcome.response.reproduction,
        changes: outcome.response.changes.length,
        pushed: false,
      })
    } else {
      run = { status: 'failed', failure: outcome.failure }
      track('bridge_ci_fix_settled', {
        reproduction: 'no-local-signal',
        jobs: evidence.length,
        logs_missing: evidence.filter((e) => e.logUnavailable).length,
        cli,
        outcome: outcome.failure.kind === 'cancelled' ? 'cancelled' : 'failed',
        failure: outcome.failure.kind,
        changes: 0,
        duration_ms: duration,
      })
    }
    abort = null
  }

  function cancel(): void {
    abort?.abort()
    abort = null
  }

  /**
   * Step one of pushing: work out WHERE, and refuse to guess.
   *
   * A fork's head branch lives on a repository the local `origin` does not
   * point at, so pushing there would either fail or — worse — create a branch
   * on the base repo with the same name. The panel says so and stops, rather
   * than picking a remote on the user's behalf.
   */
  async function preparePush(): Promise<void> {
    if (busy || commitToPush === null) return
    const target = await getPushTarget(pr)
    if (target === null) {
      push = {
        status: 'no-target',
        why: 'review123 could not read this pull request’s head branch from GitHub, so it cannot say where a push would go. Nothing was sent.',
      }
      return
    }
    if (target.isFork) {
      push = {
        status: 'no-target',
        why: 'This pull request’s head is on a fork, so its branch is not on the remote your checkout points at. review123 will not guess which remote to push to — take the commit from the bridge’s scratch branch and push it yourself.',
      }
      return
    }
    if (target.headSha.toLowerCase() !== headSha.toLowerCase()) {
      push = {
        status: 'no-target',
        why: `The pull request has moved on GitHub since this ran — its head is now ${target.headSha.slice(0, 12)}, not ${headSha.slice(0, 12)}. The commit here was made against the older head, so pushing it would not be a fast-forward. Re-read the pull request and run again.`,
      }
      return
    }
    push = { status: 'confirming', target }
  }

  async function confirmPush(): Promise<void> {
    if (push.status !== 'confirming' || commitToPush === null) return
    const target = push.target
    const startedAt = performance.now()
    push = { status: 'pushing' }

    const outcome = await runBridgePush({
      remote: DEFAULT_PUSH_REMOTE,
      branch: target.branch,
      expectedRemoteSha: headSha,
      sha: commitToPush,
    })

    const duration = Math.round(performance.now() - startedAt)
    if (outcome.ok) {
      push = { status: 'pushed', response: outcome.response }
      // Counts and enums only: WHETHER it landed and HOW MANY commits — never
      // the branch, the remote, the repository or either sha.
      track('bridge_push_settled', {
        outcome: 'pushed',
        commits: outcome.response.commits,
        confirmed: true,
        duration_ms: duration,
      })
      if (response !== null) {
        onSettled?.({
          reproduction: response.reproduction,
          changes: response.changes.length,
          pushed: true,
        })
      }
    } else {
      push = { status: 'refused', failure: outcome.failure }
      track('bridge_push_settled', {
        outcome: outcome.failure.kind === 'cancelled' ? 'cancelled' : 'refused',
        failure: outcome.failure.kind,
        commits: 0,
        confirmed: true,
        duration_ms: duration,
      })
    }
  }

  function cancelPush(): void {
    push = { status: 'idle' }
  }

  const plan = $derived(
    push.status === 'confirming' && commitToPush !== null
      ? describePushPlan(
          {
            remote: DEFAULT_PUSH_REMOTE,
            branch: push.target.branch,
            expectedRemoteSha: headSha,
            sha: commitToPush,
          },
          response?.changes.length ?? null,
        )
      : '',
  )
</script>

{#if visible}
  <section class="ci-fix" data-testid="ci-fix-panel" data-state={run.status}>
    <header class="cfx-head">
      <h3 class="cfx-title">CI is failing</h3>
      <p class="cfx-count" data-testid="ci-fix-job-count">
        {failingJobs.length === 1 ? '1 job failed' : `${failingJobs.length} jobs failed`} on this commit.
      </p>
    </header>

    <ul class="cfx-jobs" data-testid="ci-fix-jobs">
      {#each failingJobs.slice(0, 5) as job (job.name)}
        <li class="cfx-job">
          <span class="cfx-job-name">{job.name}</span>
          {#if job.url}
            <a class="cfx-job-link" href={job.url} target="_blank" rel="noreferrer noopener">logs on GitHub</a>
          {/if}
        </li>
      {/each}
    </ul>

    <!--
      The readiness sentence comes from the same rule the review-finding panel
      uses, so "why can't I do this" has one answer in the product rather than
      two that drift apart.
    -->
    {#if !readiness.ready}
      <p class="cfx-refusal" role="status" data-testid="ci-fix-readiness" data-reason={readiness.reason}>
        {describeFixReadiness(readiness, headSha)}
      </p>
    {:else}
      {#if run.status === 'idle'}
        <p class="cfx-lede" data-testid="ci-fix-lede">
          The bridge will run this repository’s own test command at {headSha.slice(0, 7)} first. Unless it
          fails there too, no agent is started — a failure nobody has seen happen is not one anything here
          can honestly work on.
        </p>

        {#if choices.length > 1}
          <div class="cfx-clis" data-testid="ci-fix-cli-choice">
            {#each choices as choice (choice)}
              <button
                type="button"
                class="cfx-cli"
                aria-pressed={readiness.cli === choice}
                data-testid={`ci-fix-cli-${choice}`}
                onclick={() => chooseCli(choice)}
              >
                {choice}
              </button>
            {/each}
          </div>
        {/if}

        <button type="button" class="cfx-go" data-testid="ci-fix-start" onclick={() => void start()}>
          Try to reproduce it with {readiness.cli}
        </button>
      {/if}

      {#if run.status === 'gathering' || run.status === 'running'}
        <p class="cfx-progress" role="status" data-testid="ci-fix-progress" data-phase={run.status}>
          <Spinner />
          {run.status === 'gathering'
            ? 'Reading what CI printed…'
            : 'Running your test command at this commit, then handing the failure to the agent…'}
        </p>
        <button type="button" class="cfx-link" data-testid="ci-fix-cancel" onclick={cancel}>Stop</button>
      {/if}
    {/if}

    {#if run.status === 'failed'}
      <p class="cfx-refusal" role="alert" data-testid="ci-fix-failure" data-kind={run.failure.kind}>
        {describeCiFixFailure(run.failure)}
      </p>
    {/if}

    {#if response !== null}
      <!--
        THE HEADLINE IS THE REPRODUCTION VERDICT, not the commit count. Whether
        anything here was ever observed to fail is the fact everything else
        depends on, and a surface that led with "1 commit" would bury it.
      -->
      <p
        class="cfx-verdict"
        role="status"
        data-testid="ci-fix-reproduction"
        data-reproduction={response.reproduction}
      >
        {describeReproduction(response)}
      </p>

      {#if response.reproduction !== 'reproduced'}
        <p class="cfx-next" data-testid="ci-fix-next-step">
          {describeNoReproductionNextStep(response.reproduction)}
        </p>
      {:else}
        {#if logsMissing}
          <p class="cfx-note" data-testid="ci-fix-logs-missing">{CI_LOGS_UNAVAILABLE}</p>
        {/if}

        <p class="cfx-stop" data-testid="ci-fix-stop" data-stop={response.stopReason}>
          {describeCiStop(response)}
        </p>

        {#if response.changes.length > 0}
          <ul class="cfx-changes" data-testid="ci-fix-changes">
            {#each response.changes as change (change.commit)}
              <li class="cfx-change">
                <code class="cfx-sha">{change.commit.slice(0, 7)}</code>
                <span class="cfx-intent">{change.intent}</span>
              </li>
            {/each}
          </ul>

          <p class="cfx-honest" data-testid="ci-fix-local-only">{CI_FIX_LOCAL_ONLY}</p>
          <p class="cfx-honest" data-testid="ci-fix-not-reviewed">{CI_FIX_NOT_REVIEWED}</p>
        {/if}

        {#if commitToPush !== null && push.status === 'idle'}
          <button
            type="button"
            class="cfx-go"
            data-testid="ci-fix-push"
            disabled={busy}
            onclick={() => void preparePush()}
          >
            Push this to the pull request…
          </button>
        {/if}
      {/if}
    {/if}

    <!--
      THE CONFIRMATION. It names all four things that can be wrong — remote,
      branch, where it is, where it will be — and it says the consequence in
      full every time. A dialog that got shorter on the second push would be
      optimising for the wrong thing: the second push is exactly as
      irreversible as the first.
    -->
    {#if push.status === 'confirming'}
      <div class="cfx-confirm" role="alert" data-testid="ci-fix-confirm">
        <p class="cfx-plan" data-testid="ci-fix-plan">{plan}</p>
        <p class="cfx-consequence" data-testid="ci-fix-consequence">{PUSH_CONSEQUENCE}</p>
        <ul class="cfx-guarantees" data-testid="ci-fix-guarantees">
          {#each PUSH_GUARANTEES as guarantee (guarantee)}
            <li>{guarantee}</li>
          {/each}
        </ul>
        <div class="cfx-actions">
          <button type="button" class="cfx-go" data-testid="ci-fix-push-confirm" onclick={() => void confirmPush()}>
            Push
          </button>
          <button type="button" class="cfx-link" data-testid="ci-fix-push-cancel" onclick={cancelPush}>
            Cancel
          </button>
        </div>
      </div>
    {/if}

    {#if push.status === 'pushing'}
      <p class="cfx-progress" role="status" data-testid="ci-fix-pushing"><Spinner /> Pushing…</p>
    {/if}

    {#if push.status === 'pushed'}
      <p class="cfx-result" role="status" data-testid="ci-fix-pushed">{describePushResult(push.response)}</p>
      <p class="cfx-honest" data-testid="ci-fix-push-not-verdict">{PUSH_NOT_A_VERDICT}</p>
      {#if onRefreshCi !== null}
        <button type="button" class="cfx-link" data-testid="ci-fix-refresh" onclick={() => onRefreshCi()}>
          Re-read CI
        </button>
      {/if}
    {/if}

    {#if push.status === 'refused'}
      <p class="cfx-refusal" role="alert" data-testid="ci-fix-push-refused" data-kind={push.failure.kind}>
        {describePushFailure(push.failure)}
      </p>
      {#if push.failure.dirtyPaths && push.failure.dirtyPaths.length > 0}
        <ul class="cfx-dirty" data-testid="ci-fix-dirty-paths">
          {#each push.failure.dirtyPaths.slice(0, 10) as path (path)}
            <li><code class="cfx-sha">{path}</code></li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if push.status === 'no-target'}
      <p class="cfx-refusal" role="alert" data-testid="ci-fix-no-target">{push.why}</p>
    {/if}
  </section>
{/if}

<style>
  /* ── The panel ──────────────────────────────────────────────────────────
     Sunken, like the other agent surfaces, so it reads as a tool inside the
     review rather than as part of the pull request's own content. */
  .ci-fix {
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    background: var(--surface-sunken);
    padding: var(--space-3);
    margin: var(--space-3) 0;
    font-size: var(--text-sm);
    color: var(--text);
  }

  .cfx-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  .cfx-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .cfx-count {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  /* ── The failing jobs ───────────────────────────────────────────────── */
  .cfx-jobs {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
  }

  .cfx-job {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--hairline);
    font-size: var(--text-xs);
  }

  .cfx-job-name {
    font-family: var(--font-mono);
    color: var(--text);
  }

  .cfx-job-link {
    color: var(--accent);
  }

  /* ── Prose ──────────────────────────────────────────────────────────────
     `--measure-prose` is not used: these run at panel width, which is already
     narrow, and capping them again would leave a ragged column. */
  .cfx-lede,
  .cfx-next,
  .cfx-note,
  .cfx-stop {
    margin: var(--space-2) 0 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .cfx-verdict {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
  }

  /* The sentences that stop a green result from reading as a conclusion. They
     are muted, not hidden: a reader skimming for the outcome still passes
     through them on the way to the button. */
  .cfx-honest {
    margin: var(--space-2) 0 0;
    padding-left: var(--space-2);
    border-left: 2px solid var(--border-subtle);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .cfx-refusal {
    margin: var(--space-2) 0 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .cfx-result {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    font-weight: 600;
  }

  /* ── The commits ────────────────────────────────────────────────────── */
  .cfx-changes,
  .cfx-dirty {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
  }

  .cfx-change {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    font-size: var(--text-xs);
  }

  .cfx-sha {
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  .cfx-intent {
    color: var(--text-secondary);
  }

  /* ── The confirmation ───────────────────────────────────────────────────
     Raised and outlined, because it is the one place in this app where a
     click cannot be taken back. */
  .cfx-confirm {
    margin: var(--space-3) 0 0;
    padding: var(--space-3);
    border: 1px solid var(--border-control);
    border-radius: 6px;
    background: var(--surface-raised);
    box-shadow: var(--elevation-1);
  }

  .cfx-plan {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .cfx-consequence {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .cfx-guarantees {
    margin: var(--space-2) 0 0;
    padding-left: var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .cfx-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-3) 0 0;
  }

  /* ── Controls ───────────────────────────────────────────────────────── */
  .cfx-clis {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: var(--space-2) 0 0;
  }

  .cfx-cli {
    font: inherit;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .cfx-cli[aria-pressed='true'] {
    border-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }

  .cfx-go {
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 600;
    margin: var(--space-3) 0 0;
    padding: var(--space-1) var(--space-3);
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }

  .cfx-actions .cfx-go {
    margin: 0;
  }

  .cfx-go:disabled {
    opacity: var(--disabled-opacity);
    cursor: not-allowed;
  }

  .cfx-link {
    font: inherit;
    font-size: var(--text-xs);
    margin: var(--space-2) 0 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }

  .cfx-actions .cfx-link {
    margin: 0;
  }

  .cfx-progress {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-3) 0 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
</style>
