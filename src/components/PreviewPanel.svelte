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
   * no referrer. The panel sits at --z-panel, ABOVE the sticky draft bar and
   * the context rail (both --z-bar) — this comment used to say "under", which
   * never matched the stylesheet — and follows the rail/drawer responsive
   * idioms (overlay below 1100px).
   *
   * ──────────────────────────────────────────────────────────────────────────
   * TWO SOURCES NOW, PICKED BY `decidePreviewSource`.
   *
   * When the pull request is checked out locally AND the dev server answers,
   * the panel frames the LOCAL app instead — the reviewer's own database,
   * flags and seed data, which is strictly more useful than a preview built on
   * someone else's infrastructure.
   *
   * THE DEPLOY PATH IS NOT REMOVED and never becomes unreachable: it is the
   * fallback for every case where local is not live, which is most of them.
   * The panel always says which source it is showing, because a frame that
   * silently swapped between "your machine" and "a deployment" would make the
   * reviewer unable to trust what they are looking at.
   *
   * A local URL is framed WITHOUT `iframeSafeUrl`, which is an https-only
   * sanitizer for third-party deployment links. A dev server is http on
   * loopback by construction, so passing it through that check would reject
   * every real one. The URL is not user-supplied: it comes from the bridge's
   * own detection, which only ever produces a loopback origin.
   */
  import { iframeSafeUrl } from '../lib/preview/preview'
  import {
    decidePreviewSource,
    describePreviewSource,
    stackState,
  } from '../lib/bridge/runPr.svelte'

  interface Props {
    /** The preview deployment's URL (iframe src is sanitized from it). */
    url: string
    /** Fixed platform enum ('vercel' | 'netlify' | …) — display only. */
    providerName: string
    /**
     * The PR's head sha, so the panel can tell whether the local checkout is
     * actually sitting on THIS pull request. Without it, a local app would be
     * framed as "this PR" while serving some other branch.
     */
    headSha: string
    onclose: () => void
  }
  let { url, providerName, headSha, onclose }: Props = $props()

  const source = $derived(
    decidePreviewSource({
      onPrBranch: stackState.onPrBranch(headSha),
      app: stackState.app,
      deployUrl: url,
    }),
  )

  const isLocal = $derived(source.kind === 'local')

  /**
   * What the iframe loads. A deploy URL goes through the https-only sanitizer;
   * a local one is already a loopback origin from the bridge's own detection.
   */
  const frameSrc = $derived(
    source.url === null ? null : isLocal ? source.url : iframeSafeUrl(source.url),
  )
</script>

<aside class="preview-panel" aria-label="Preview panel" data-source={source.kind}>
  <div class="preview-panel-head">
    <span class="preview-panel-title" data-testid="preview-panel-title">
      {#if isLocal}
        Your local app
        <span class="preview-panel-provider">· running this PR</span>
      {:else}
        Deploy preview <span class="preview-panel-provider">· {providerName}</span>
      {/if}
    </span>
    <button
      type="button"
      class="preview-panel-close"
      aria-label="Close preview panel"
      onclick={onclose}
    >×</button>
  </div>

  <!-- ALWAYS says which source this is. A frame that silently swapped between
       the reviewer's machine and a deployment would be untrustworthy. -->
  <div class="preview-source" data-testid="preview-source" data-reason={source.reason}>
    {describePreviewSource(source, stackState.app)}
  </div>

  {#if source.url !== null}
    <!-- Persistent honesty bar — see the header comment: framing refusal is
         undetectable from here, so the escape hatch is always visible. -->
    <div class="preview-fallback">
      {isLocal
        ? 'If the app stays blank, it refuses embedding —'
        : 'If the preview stays blank, the site refuses embedding —'}
      <a href={source.url} target="_blank" rel="noopener noreferrer"
        >Open in new tab <span aria-hidden="true">↗</span></a>
    </div>
  {/if}

  {#if frameSrc !== null}
    <iframe
      class="preview-frame"
      src={frameSrc}
      title={isLocal ? 'Your local app running this pull request' : 'Deploy preview'}
      sandbox="allow-scripts allow-same-origin allow-forms"
      referrerpolicy="no-referrer"
      loading="lazy"
    ></iframe>
  {:else if source.url !== null}
    <p class="preview-unframeable">
      This preview URL can't be embedded — use "Open in new tab" above.
    </p>
  {:else}
    <p class="preview-unframeable" data-testid="preview-none">
      Nothing to show here yet.
    </p>
  {/if}
</aside>

<style>
  .preview-panel {
    position: fixed;
    /* Below the sticky topbar (same idiom as the context rail) so the app's
       navigation stays visible and clickable above the panel. */
    top: var(--topbar-h, 2.75rem);
    right: 0;
    bottom: 0;
    /* Above --z-bar (the context rail AND the sticky draft bar): the panel owns
       the right edge while open — Review collapses the rail on open and pads
       the draft bar so Prev/Next slide left of the panel. */
    z-index: var(--z-panel);
    width: min(40vw, 560px);
    display: flex;
    flex-direction: column;
    background: var(--surface, #0e1420);
    border-left: 1px solid var(--hairline);
    box-sizing: border-box;
  }

  /* Below the rail breakpoint the panel becomes an overlay drawer (same idiom
     as the context rail) rather than claiming layout width. */
  @media (max-width: 1099px) {
    .preview-panel {
      width: min(92vw, 480px);
      box-shadow: var(--elevation-drawer);
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

  /* The source line: which of the two things you are looking at. */
  .preview-source {
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--hairline);
  }

  /* Local gets the "live" accent the RunPrPanel indicator uses, so the two
     surfaces agree at a glance about which world you are in. */
  .preview-panel[data-source='local'] .preview-source {
    color: var(--legend-added-color, #3f9142);
  }

  .preview-fallback {
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--hairline);
    background: var(--surface-sunken, #141a28);
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
