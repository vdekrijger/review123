<script lang="ts">
  /**
   * PreviewPanel — embedded side-by-side deploy-preview panel.
   *
   * A fixed right-side panel with an <iframe> of the preview URL, mounted from
   * Review.svelte (never inside InspectStep). Hard reality, handled honestly:
   * many sites send X-Frame-Options / CSP frame-ancestors and will refuse
   * framing, and a cross-origin page gives us NO reliable refusal signal (no
   * readable load error; a fetch probe is blocked by CORS; a timeout heuristic
   * would just guess). So we do NOT fake blank-detection — a persistent
   * fallback bar above the frame always offers "Open in new tab ↗".
   *
   * Security: the iframe loads a SANITIZED URL (https only, credentials and
   * query/hash stripped — tokens are never forwarded), is sandboxed, and sends
   * no referrer. The panel sits under the sticky draft bar (z-index) and
   * follows the rail/drawer responsive idioms (overlay below 1100px).
   */
  import { iframeSafeUrl } from '../lib/preview/preview'

  interface Props {
    /** The preview deployment's URL (iframe src is sanitized from it). */
    url: string
    /** Fixed platform enum ('vercel' | 'netlify' | …) — display only. */
    providerName: string
    onclose: () => void
  }
  let { url, providerName, onclose }: Props = $props()

  const frameSrc = $derived(iframeSafeUrl(url))
</script>

<aside class="preview-panel" aria-label="Deploy preview panel">
  <div class="preview-panel-head">
    <span class="preview-panel-title">
      Deploy preview <span class="preview-panel-provider">· {providerName}</span>
    </span>
    <button
      type="button"
      class="preview-panel-close"
      aria-label="Close preview panel"
      onclick={onclose}
    >×</button>
  </div>

  <!-- Persistent honesty bar — see the header comment: framing refusal is
       undetectable from here, so the escape hatch is always visible. -->
  <div class="preview-fallback">
    If the preview stays blank, the site refuses embedding —
    <a href={url} target="_blank" rel="noopener noreferrer"
      >Open in new tab <span aria-hidden="true">↗</span></a>
  </div>

  {#if frameSrc !== null}
    <iframe
      class="preview-frame"
      src={frameSrc}
      title="Deploy preview"
      sandbox="allow-scripts allow-same-origin allow-forms"
      referrerpolicy="no-referrer"
      loading="lazy"
    ></iframe>
  {:else}
    <p class="preview-unframeable">
      This preview URL can't be embedded — use "Open in new tab" above.
    </p>
  {/if}
</aside>

<style>
  .preview-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    /* Under the sticky draft bar (z-index 100) so Prev/Next stay clickable. */
    z-index: 90;
    width: min(40vw, 560px);
    display: flex;
    flex-direction: column;
    background: var(--surface, #0e1420);
    border-left: 1px solid var(--hairline);
    /* Keep the frame's bottom edge clear of the sticky draft bar. */
    padding-bottom: 3.4rem;
    box-sizing: border-box;
  }

  /* Below the rail breakpoint the panel becomes an overlay drawer (same idiom
     as the context rail) rather than claiming layout width. */
  @media (max-width: 1099px) {
    .preview-panel {
      width: min(92vw, 480px);
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
    }
  }

  .preview-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--hairline);
  }

  .preview-panel-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
  }

  .preview-panel-provider {
    font-weight: 400;
    color: var(--text-muted);
  }

  .preview-panel-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.25rem;
  }

  .preview-panel-close:hover,
  .preview-panel-close:focus-visible {
    color: var(--text);
  }

  .preview-fallback {
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--hairline);
    background: var(--surface-raised, #141a28);
  }

  .preview-fallback a {
    color: var(--accent, #4a90d0);
    text-decoration: underline;
  }

  .preview-frame {
    flex: 1;
    width: 100%;
    border: 0;
    /* Previews are overwhelmingly light-themed pages; a white ground also makes
       a refused (blank) frame read as "page didn't render" rather than a hole. */
    background: #fff;
  }

  .preview-unframeable {
    margin: 0;
    padding: 0.75rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
</style>
