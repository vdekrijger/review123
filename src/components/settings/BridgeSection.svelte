<script lang="ts">
  /**
   * BridgeSection — pair review123 with an OPTIONAL local bridge.
   *
   * The bridge is a process the user runs inside a repo (bridge/README.md).
   * This section is the ONLY place in the app that touches it today: the
   * silent health probe fires on mount HERE, not app-wide, so a user who has
   * never paired sends not one extra byte anywhere else in the product.
   *
   * The explainer is not decoration. Pairing hands a web origin read access to
   * a checkout on the user's machine, so the surface says so plainly, above the
   * field that does it.
   */
  import SecretInput from './SecretInput.svelte'
  import {
    bridgeState,
    connectBridge,
    disconnectBridge,
    initBridge,
    bridgeAvailable,
    BRIDGE_STORAGE_KEY,
  } from '../../lib/bridge/bridge.svelte'
  import { DEFAULT_BRIDGE_PORT, isValidModelId } from '../../lib/bridge/protocol'
  import { getSettings, setBridgeModel } from '../../lib/settings/settings'
  // Shared with the mid-review "bridge is not responding" error (llm.ts), so
  // the two surfaces can never name different commands.
  import {
    BRIDGE_DOWNLOAD_COMMAND,
    BRIDGE_README_URL,
    BRIDGE_REPO_URL,
    BRIDGE_START_COMMAND,
  } from '../../lib/bridge/install'

  let token = $state('')
  let portInput = $state(String(bridgeState.port))
  let busy = $state(false)
  /**
   * Which MODEL the paired CLI should run. Separate from the "Local bridge
   * model" dropdown under AI models, which picks the CLI (`claude` / `codex`) —
   * a process name, not a model. Until this existed there was nowhere to say
   * which model that process should use, so every bridge review silently ran
   * the CLI's own configured default.
   */
  let modelInput = $state(getSettings().bridgeModel)
  /** A non-empty entry that could never be sent. Blank is valid — it means "default". */
  const modelInvalid = $derived(modelInput.trim() !== '' && !isValidModelId(modelInput.trim()))

  // Re-probe when this section mounts. main.ts already probes at app start
  // (inference routes through the bridge, so the connection has to be known
  // before Settings is ever opened); this second probe is about FRESHNESS —
  // someone who just started the bridge in a terminal and came here to pair it
  // should see the live answer, not the one from page load. Still silent, and
  // still does nothing at all — no fetch — unless a token was stored.
  $effect(() => {
    void initBridge()
  })

  const connected = $derived(bridgeState.status === 'connected')
  const clis = $derived(bridgeState.capabilities?.inference ?? [])
  /** Route readiness — an older bridge answers /v1/health but not /v1/infer. */
  const inferReady = $derived(bridgeAvailable('infer'))
  /**
   * `/v1/infer/stream`. Stated rather than hidden because its absence is
   * VISIBLE to the user — answers stop typing out — and an app that let them
   * wonder why would be implying a stream it never got. It is route readiness,
   * not a promise about every CLI: `codex` has no partial-output mode even on
   * a bridge that has the route, which the note below says separately.
   */
  const streamReady = $derived(bridgeAvailable('inferStream'))
  /** Both grounding routes. An older bridge has neither. */
  const filesReady = $derived(bridgeAvailable('files') && bridgeAvailable('search'))
  /**
   * `capabilities.fix` — the bridge's `--allow-write` flag, and the ONLY
   * authorisation for the fix loop. It is not a release-readiness boolean like
   * the other capabilities: it is a process flag the person at the terminal
   * typed, which is exactly why this section states it rather than hiding it.
   */
  const writeEnabled = $derived(bridgeAvailable('fix'))
  const repoState = $derived(bridgeState.git)

  /**
   * What the paired checkout is sitting on, in the shas a user can check.
   *
   * This section cannot say whether grounding will be LOCAL — that depends on
   * which PR is open, and no PR is open here. So it reports the fact and the
   * rule, and lets the review page (GroundingIndicator) answer the question
   * for a specific PR. Overstating it here would be the exact dishonesty the
   * head-matching rule exists to prevent.
   */
  const checkoutLine = $derived.by(() => {
    if (!filesReady) return null
    if (repoState === null) {
      return 'That directory is not a git repository, so its files cannot be matched to a PR — reviews will read code from GitHub.'
    }
    const where = repoState.branch === null ? 'a detached HEAD' : repoState.branch
    const dirty = repoState.dirty ? ', with uncommitted changes' : ''
    return `Checked out at ${where} (${repoState.head.slice(0, 7)})${dirty}. Reviews read code from here whenever a PR's head matches that commit, and from GitHub whenever it does not.`
  })

  const statusLine = $derived.by(() => {
    switch (bridgeState.status) {
      case 'connected':
        return `Connected to ${bridgeState.root}`
      case 'pairing':
        return 'Connecting…'
      case 'error':
        return 'Not connected'
      case 'disconnected':
        return bridgeState.paired ? 'Not connected — the bridge is not running' : 'Not connected'
    }
  })

  async function handleConnect(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    try {
      const port = Number(portInput.trim()) || DEFAULT_BRIDGE_PORT
      const ok = await connectBridge(token, port)
      if (ok) token = ''
    } finally {
      busy = false
    }
  }

  function handleDisconnect() {
    disconnectBridge()
    token = ''
    portInput = String(DEFAULT_BRIDGE_PORT)
  }
</script>

<section id="bridge" aria-label="Local bridge" data-testid="bridge-section">
  <p class="section-label">Local bridge <span class="optional-note">(optional)</span></p>

  <p class="explainer">
    Run a small process inside a repo on your machine and review123 can run reviews
    through your own Claude Code or Codex CLI, on the subscription you already pay
    for, instead of a per-token API key. It listens on <code>127.0.0.1</code> only
    and needs the pairing token it prints on startup.
  </p>
  <p class="explainer warning">
    While the bridge runs, this site gets <strong>read access to that repo</strong>.
    Nothing here is required: with no bridge, review123 works exactly as it does
    today.
  </p>

  <div class="status-row" data-testid="bridge-status">
    <span class="status-dot" class:on={connected} aria-hidden="true"></span>
    <span class="status-text">{statusLine}</span>
  </div>

  {#if connected}
    <dl class="detail">
      <dt>Repo</dt>
      <dd data-testid="bridge-root">{bridgeState.root}</dd>
      <dt>CLIs detected</dt>
      <dd data-testid="bridge-clis">{clis.length > 0 ? clis.join(', ') : 'none on PATH'}</dd>
      <dt>Port</dt>
      <dd>127.0.0.1:{bridgeState.port}</dd>
      <dt>Bridge version</dt>
      <dd>{bridgeState.version}</dd>
    </dl>
    <p class="field-note" data-testid="bridge-inference-note">
      {#if !inferReady}
        This bridge is too old to run inference — update it and restart.
      {:else if clis.length === 0}
        No CLI was found on its PATH, so it cannot run reviews yet. Install
        <code>claude</code> or <code>codex</code>, then restart the bridge.
      {:else}
        Ready to run reviews. Pick <strong>Local bridge</strong> under
        <a href="#ai-models">AI models</a> to use it instead of an API key.
        {#if !streamReady}
          Answers will arrive all at once rather than typing out: this bridge has no
          streaming route. Update it to see them stream.
        {:else if clis.includes('codex') && !clis.includes('claude')}
          Answers from <code>codex</code> arrive all at once rather than typing out — it has
          no partial-output mode. <code>claude</code> streams.
        {/if}
      {/if}
    </p>
    <p class="field-note" data-testid="bridge-write-note">
      {#if writeEnabled}
        Write mode is on (<code>--allow-write</code>): a finding with a concrete fix can go
        straight to your coding agent, which fixes it in a scratch git worktree, runs your
        tests, and hands back one commit per finding for you to review and cherry-pick. Your
        checkout, branch, index and uncommitted work are never touched, and nothing is pushed.
      {:else}
        This bridge is <strong>read-only</strong>. Restart it with <code>--allow-write</code>
        to let review123 hand findings to your coding agent — it works in a scratch git
        worktree, runs your tests, and hands back one commit per finding; your checkout,
        branch, index and uncommitted work are never touched, and nothing is pushed. Nothing
        on this page can turn it on: the flag is typed at the terminal or it does not happen.
      {/if}
    </p>
    <p class="field-note" data-testid="bridge-grounding-note">
      {#if !filesReady}
        This bridge is too old to serve repo files, so reviews will read code
        from GitHub. Update it and restart.
      {:else}
        {checkoutLine}
      {/if}
    </p>
    <label class="field model-field">
      <span class="field-label">Model (optional)</span>
      <input
        type="text"
        bind:value={modelInput}
        oninput={() => setBridgeModel(modelInput)}
        aria-label="Bridge CLI model"
        placeholder="leave blank to use the CLI's own default"
        autocomplete="off"
        spellcheck="false"
      />
    </label>
    <p class="field-note" data-testid="bridge-model-note">
      Passed to the CLI as <code>--model</code>. Both take a short alias or a full id —
      <code>claude</code> accepts <code>opus</code>, <code>sonnet</code> or a full name like
      <code>claude-fable-5</code>; <code>codex</code> takes any model id its
      <code>exec --model</code> understands. Blank sends no flag at all, so the CLI keeps
      whatever model you configured it with. We don't list the options here because each
      CLI's accepted set changes with its own releases — an unknown id is rejected by the
      CLI, with its own error.
      {#if modelInvalid}
        <strong class="model-invalid">That isn't a model id — use letters, digits and
        <code>. _ : / -</code>. Nothing will be sent until it is fixed.</strong>
      {/if}
    </p>
    <button type="button" class="secondary-btn" onclick={handleDisconnect}>Disconnect</button>
  {:else}
    <form class="pair-form" onsubmit={handleConnect}>
      <label class="field">
        <span class="field-label">Pairing token</span>
        <SecretInput bind:value={token} placeholder="paste the token the bridge printed" ariaLabel="Bridge pairing token" />
      </label>
      <label class="field port-field">
        <span class="field-label">Port</span>
        <input
          type="text"
          inputmode="numeric"
          bind:value={portInput}
          aria-label="Bridge port"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <button type="submit" class="primary-btn" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>

    {#if bridgeState.error}
      <p class="error" role="alert">{bridgeState.error}</p>
    {/if}

    <div class="install" data-testid="bridge-install">
      <p class="field-note">
        <strong>Get the bridge.</strong> Download the single file once, then run it
        inside whichever repo you want to review. Needs Node 22+ and nothing else.
      </p>
      <pre class="cmd"><code>{BRIDGE_DOWNLOAD_COMMAND}
{BRIDGE_START_COMMAND}</code></pre>
      <p class="field-note" data-testid="bridge-flags-note">
        <strong>The two flags are the point of typing this yourself.</strong>
        <code>--allow-write</code> lets review123 hand a finding to your local coding agent,
        which fixes it in a scratch git worktree; <code>--allow-checkout</code> lets it check
        a pull request out in this working tree so your dev server serves it. They are
        independent — neither turns on the other — and the bridge starts with both
        <strong>off</strong> unless you type them. That is deliberate: a grant that only
        exists on your command line still holds if this website is ever compromised, because
        nothing we send can switch it on. They protect you from <em>us</em>, not from
        yourself — so leaving them out doesn't harden anything, it just turns the features off.
      </p>
      <p class="field-note" data-testid="bridge-permission-note">
        <strong>Your browser will ask once.</strong> Reaching a server on your own machine
        from a website needs your permission — Chrome asks to
        <em>“look for and connect to any device on your local network”</em>. Choose
        <strong>Allow</strong>. Until you do, the bridge is unreachable from here no matter
        how well it is running, and nothing you type reaches it.
      </p>
      <p class="field-note">
        Prefer to build it yourself? Clone
        <a href={BRIDGE_REPO_URL} target="_blank" rel="noopener noreferrer">the repo</a> and run
        <code>pnpm install</code>, then <code>pnpm bridge</code> — fair warning, that
        first install pulls this app's entire dev toolchain (Playwright included) to
        compile a package that has no dependencies of its own.
      </p>
      <p class="field-note">
        Every flag, and the full security model, are in
        <a href={BRIDGE_README_URL} target="_blank" rel="noopener noreferrer">bridge/README.md</a>.
        The token is stored in this browser under <code>{BRIDGE_STORAGE_KEY}</code>.
      </p>
    </div>
  {/if}
</section>

<style>
  section {
    margin-bottom: 1.5rem;
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 1rem 1.25rem;
  }

  .section-label {
    font-size: 0.9em;
    font-weight: 600;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .optional-note {
    font-weight: normal;
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .explainer {
    margin: 0 0 0.5rem;
    font-size: 0.85em;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .explainer.warning {
    color: var(--text);
  }

  .explainer code,
  .field-note code {
    font-family: var(--font-mono, monospace);
    font-size: 0.95em;
    background: var(--surface-raised);
    border-radius: 4px;
    padding: 0.05em 0.3em;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.75rem 0;
    font-size: 0.9em;
    color: var(--text);
  }

  .status-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-muted);
    opacity: 0.45;
  }

  .status-dot.on {
    background: var(--accent);
    opacity: 1;
  }

  .detail {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 0.85rem;
    margin: 0 0 0.6rem;
    font-size: 0.85em;
  }

  .detail dt {
    color: var(--text-muted);
  }

  .detail dd {
    margin: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .pair-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.6rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1 1 16rem;
    min-width: 0;
  }

  .port-field {
    flex: 0 0 6rem;
  }

  /* Stands alone in the connected view rather than sharing the pairing row. */
  .model-field {
    margin-top: 0.75rem;
    max-width: 22rem;
  }

  .model-invalid {
    display: block;
    margin-top: 0.25rem;
    color: var(--danger, #b3261e);
  }

  .field-label {
    font-size: 0.8em;
    color: var(--text-muted);
  }

  .primary-btn,
  .secondary-btn {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85em;
    font-weight: 500;
    padding: 0.35rem 0.85rem;
    background: var(--surface-raised);
    color: var(--text);
  }

  .primary-btn {
    border-color: var(--accent);
    color: var(--accent);
  }

  .primary-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .primary-btn:hover:not(:disabled),
  .secondary-btn:hover {
    background: #8881;
  }

  /* --legend-removed-color is the repo's theme-aware "something is wrong" red
     (it flips between light and dark in app.css), so the message stays legible
     in both themes instead of hard-coding one hex. */
  .error {
    margin: 0.6rem 0 0;
    font-size: 0.85em;
    color: var(--legend-removed-color);
  }

  .field-note {
    margin: 0.6rem 0 0;
    font-size: 0.8em;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .install a {
    color: inherit;
  }

  /* The one thing in this section people have to copy. pre-wrap rather than a
     horizontal scroller so the whole URL is visible in a narrow settings
     panel — soft wrapping inserts no newlines, so a selection still pastes as
     the two real commands. */
  .cmd {
    margin: 0.4rem 0 0;
    padding: 0.6rem 0.7rem;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    font-family: var(--font-mono, monospace);
    font-size: 0.75em;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
