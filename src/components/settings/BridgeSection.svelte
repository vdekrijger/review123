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
  import { DEFAULT_BRIDGE_PORT } from '../../lib/bridge/protocol'

  let token = $state('')
  let portInput = $state(String(bridgeState.port))
  let busy = $state(false)

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
        Reading repo files through the bridge is not wired up yet.
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

    <p class="field-note">
      Start it from a review123 checkout with <code>pnpm bridge</code>, or point it
      at any repo with <code>node bridge/dist/cli.js --root .</code>. The token is
      stored in this browser under <code>{BRIDGE_STORAGE_KEY}</code>.
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
</style>
