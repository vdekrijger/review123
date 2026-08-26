<script lang="ts">
  /**
   * PreviewButton — the review-header deploy-preview affordance.
   *
   * Renders NOTHING when no preview was detected (zero-cost absence — no
   * settings row, no placeholder). Otherwise:
   *   - ready    → "Open preview ↗" link + "Preview panel" toggle + state note
   *                ("vercel · ready · 2m ago"), with freshness honesty: when
   *                the deployment sha ≠ the current PR head sha the note adds
   *                "1+ commits behind" (sha comparison only — no count math).
   *   - building → disabled-ish button with the shared Spinner token + note.
   *   - failed   → muted "preview failed" note (no dead link).
   *
   * Mounted from Review.svelte's header (NOT inside InspectStep). Analytics:
   * one allowlisted event, preview_opened {method, provider_name, state} —
   * provider_name is a fixed platform enum, never a URL or repo identifier.
   */
  import Spinner from './Spinner.svelte'
  import { relativeTime } from '../lib/time'
  import { isPreviewBehind, type PreviewDeployment } from '../lib/preview/preview'
  import { track } from '../lib/analytics/analytics'

  interface Props {
    /** Best detected deploy preview — null renders nothing. */
    preview: PreviewDeployment | null
    /** Current PR head sha, for the freshness note. */
    headSha: string
    /** Whether the embedded preview panel is open (toggle state lives in Review). */
    panelOpen: boolean
    onTogglePanel: () => void
  }
  let { preview, headSha, panelOpen, onTogglePanel }: Props = $props()

  const behind = $derived(preview !== null && isPreviewBehind(preview, headSha))

  function handleOpenTab() {
    if (preview === null) return
    track('preview_opened', {
      method: 'tab',
      provider_name: preview.providerName,
      state: preview.state,
    })
  }

  function handleTogglePanel() {
    if (preview === null) return
    if (!panelOpen) {
      track('preview_opened', {
        method: 'panel',
        provider_name: preview.providerName,
        state: preview.state,
      })
    }
    onTogglePanel()
  }
</script>

{#if preview !== null}
  <span class="preview-affordance">
    {#if preview.state === 'ready'}
      <a
        class="preview-open"
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open deploy preview (opens in a new tab)"
        onclick={handleOpenTab}
      >
        Open preview <span class="ext" aria-hidden="true">↗</span>
      </a>
      <button
        type="button"
        class="preview-panel-toggle"
        aria-pressed={panelOpen}
        onclick={handleTogglePanel}
      >
        Preview panel
      </button>
      <span class="preview-note">
        {preview.providerName} · ready{#if preview.updatedAt}&nbsp;· {relativeTime(preview.updatedAt)}{/if}{#if behind}&nbsp;· <span
            class="preview-behind">1+ commits behind</span>{/if}
      </span>
    {:else if preview.state === 'building'}
      <span class="preview-building" role="status">
        <Spinner />
        <span class="preview-note">{preview.providerName} · preview building…</span>
      </span>
    {:else}
      <span class="preview-note preview-failed">{preview.providerName} · preview failed</span>
    {/if}
  </span>
{/if}

<style>
  .preview-affordance {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Prominent primary affordance — accent-bordered sibling of .view-on-provider */
  .preview-open {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
    font-size: 0.85rem;
    font-weight: 600;
    text-decoration: none;
    color: var(--accent, #4a90d0);
    border: 1px solid var(--accent, #4a90d0);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    white-space: nowrap;
    transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
  }

  .preview-open:hover,
  .preview-open:focus-visible {
    background: #4a90d01a;
  }

  .preview-open .ext {
    font-size: 0.8em;
    opacity: 0.8;
  }

  .preview-panel-toggle {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.3rem 0.55rem;
    white-space: nowrap;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }

  .preview-panel-toggle:hover,
  .preview-panel-toggle:focus-visible {
    background: #8881;
    color: var(--text);
  }

  .preview-panel-toggle[aria-pressed='true'] {
    color: var(--text);
    border-color: var(--accent, #4a90d0);
  }

  .preview-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .preview-behind {
    color: var(--legend-changed-color, #b08800);
  }

  .preview-building {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    opacity: 0.8;
  }

  .preview-failed {
    opacity: 0.75;
  }
</style>
