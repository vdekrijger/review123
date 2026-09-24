<script lang="ts">
  import type { PrComment } from '../lib/github/comments'
  import MarkdownView from './MarkdownView.svelte'
  import { relativeTime } from '../lib/time'
  import { track } from '../lib/analytics/analytics'

  interface Props {
    comments: PrComment[]
  }

  let { comments }: Props = $props()

  // ---- Per-comment actions menu ----
  //
  // ESCAPING THE DIFF'S STACKING TRAP. This menu renders inside an inline
  // comment thread, which @git-diff-view puts inside a line-widget wrapper
  // carrying its own `sticky` + `z-[1]` utilities. A positioned element with a
  // z-index establishes a stacking context, so this whole subtree paints at 1
  // against the root and NO z-index here can lift it out — measured: the menu
  // lost to the draft bar at a literal 20 and lost identically at --z-popover
  // (250). The token is a prerequisite for the fix, not a substitute for it.
  //
  // So the menu is promoted to the browser TOP LAYER via the Popover API, which
  // sits above every stacking context in the document by construction. Same
  // idiom, same reason, as VerifyVotesTooltip.
  //
  // `manual` rather than `auto` is deliberate: `auto` would hand light-dismiss
  // and Escape to the UA on top of the handlers below that already implement
  // them, and two dismissal paths racing on one piece of state is a worse
  // outcome than the bug. Promotion is for PAINTING only — the element stays
  // exactly where it is in the DOM, so `closest('[data-comment-menu]')` below,
  // focus order, and focus return all keep working unchanged.
  //
  // Only one menu is open at a time; keyed by comment id.
  let openMenuId = $state<number | null>(null)
  /** The open menu's own element, for showPopover + placement. */
  let menuEl = $state<HTMLDivElement | null>(null)
  /** The trigger the open menu belongs to — its rect anchors the placement. */
  let anchorEl: HTMLElement | null = null
  // Comment id currently showing the transient "Copied ✓" confirmation.
  let copiedId = $state<number | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  function toggleMenu(id: number, trigger: HTMLElement) {
    if (openMenuId === id) {
      closeMenu()
      return
    }
    openMenuId = id
    anchorEl = trigger
  }

  function closeMenu() {
    openMenuId = null
    anchorEl = null
  }

  /** Does this build have the Popover API? (jsdom / older browsers do not.) */
  // NOTE the attribute is CONDITIONAL. `[popover]` brings a UA rule with it —
  // `[popover]:not(:popover-open) { display: none }` — so on a build that has
  // the attribute but not the API (jsdom, and any browser in that window) the
  // element would be permanently hidden rather than merely un-promoted. Setting
  // it only when showPopover() exists makes the fallback path byte-for-byte the
  // behaviour we have today instead of a blank menu.
  const supportsPopover = (): boolean =>
    typeof HTMLElement !== 'undefined' &&
    typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function'

  const GAP = 4 // px between the trigger and the menu
  const MARGIN = 8 // px min distance from any viewport edge

  /**
   * Place the menu against its trigger with position:fixed coords.
   *
   * In the top layer the containing block is the viewport, so the old
   * `position: absolute; top: 100%; right: 0` no longer resolves against
   * `.comment-menu` and placement becomes ours to do. Right-aligned to the
   * trigger (what `right: 0` meant), flipped above when it would overflow the
   * bottom, and clamped into the viewport on both axes.
   */
  function positionMenu(): void {
    const menu = menuEl
    const anchor = anchorEl
    if (!menu || !anchor) return
    const r = anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = menu.offsetWidth
    const h = menu.offsetHeight

    let left = r.right - w
    left = Math.min(left, vw - w - MARGIN)
    left = Math.max(MARGIN, left)

    const spaceBelow = vh - r.bottom
    const placeAbove = spaceBelow < h + GAP + MARGIN && r.top > spaceBelow
    const top = placeAbove
      ? Math.max(MARGIN, r.top - GAP - h)
      : Math.min(r.bottom + GAP, Math.max(MARGIN, vh - h - MARGIN))

    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`
  }

  // Promote on open, and keep the menu glued to its trigger while it is open.
  // A fixed-position element does not follow a scrolling anchor by itself, and
  // the diff underneath this menu scrolls, so `scroll` is captured to catch any
  // scrolling ancestor rather than only the window.
  $effect(() => {
    const menu = menuEl
    if (!menu) return
    if (supportsPopover()) {
      try {
        ;(menu as unknown as { showPopover: () => void }).showPopover()
      } catch {
        // Already-open popovers throw — ignore.
      }
    }
    positionMenu()
    const reflow = () => positionMenu()
    window.addEventListener('scroll', reflow, true)
    window.addEventListener('resize', reflow)
    return () => {
      window.removeEventListener('scroll', reflow, true)
      window.removeEventListener('resize', reflow)
    }
  })

  /** Build a markdown blockquote of the comment for pasting into a reply. */
  function quoteOf(comment: PrComment): string {
    const attribution = `> @${comment.author} wrote:`
    const quoted = comment.body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const parts = [attribution, quoted]
    if (comment.url) parts.push(`>\n> ${comment.url}`)
    return parts.join('\n')
  }

  async function copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  function flashCopied(id: number) {
    copiedId = id
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      if (copiedId === id) copiedId = null
    }, 2000)
  }

  async function copyLink(comment: PrComment) {
    if (!comment.url) return
    const ok = await copyToClipboard(comment.url)
    closeMenu()
    if (ok) {
      flashCopied(comment.id)
      // Analytics: ids-only choke-point event — carries NOTHING.
      track('comment_link_copied')
    }
  }

  async function quoteReply(comment: PrComment) {
    await copyToClipboard(quoteOf(comment))
    closeMenu()
    flashCopied(comment.id)
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && openMenuId !== null) {
      // Capture the trigger before closeMenu() clears it: if focus had moved
      // into the menu, closing would otherwise strand it on a removed node.
      // Matches CommentEditor's emoji picker.
      const trigger = anchorEl
      closeMenu()
      trigger?.focus()
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (openMenuId === null) return
    const target = e.target as HTMLElement | null
    // Ignore clicks inside the open menu / its trigger (they self-handle).
    if (target && target.closest('[data-comment-menu]')) return
    closeMenu()
  }


  // Build ordered thread: top-level comments in order, each followed by replies
  const orderedComments = $derived.by(() => {
    const topLevel = comments.filter((c) => c.inReplyTo === null)
    const repliesMap = new Map<number, PrComment[]>()
    for (const c of comments) {
      if (c.inReplyTo !== null) {
        const arr = repliesMap.get(c.inReplyTo) ?? []
        arr.push(c)
        repliesMap.set(c.inReplyTo, arr)
      }
    }
    const result: { comment: PrComment; isReply: boolean }[] = []
    for (const top of topLevel) {
      result.push({ comment: top, isReply: false })
      const replies = repliesMap.get(top.id) ?? []
      for (const reply of replies) {
        result.push({ comment: reply, isReply: true })
      }
    }
    // Also include orphan replies (reply to unknown parent) at the end
    for (const c of comments) {
      if (c.inReplyTo !== null && !topLevel.some((t) => t.id === c.inReplyTo)) {
        result.push({ comment: c, isReply: true })
      }
    }
    return result
  })
</script>

<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

<div class="comment-thread">
  {#each orderedComments as { comment, isReply } (comment.id)}
    <div class="comment-item" class:reply={isReply}>
      <div class="comment-header">
        {#if comment.authorAvatar}
          <img
            class="avatar"
            src={comment.authorAvatar}
            alt={comment.author}
            width="20"
            height="20"
            loading="lazy"
          />
        {:else}
          <span class="avatar-initial" aria-hidden="true">
            {comment.author.slice(0, 1).toLowerCase()}
          </span>
        {/if}
        <span class="comment-author">{comment.author}</span>
        <span class="comment-time">{relativeTime(comment.createdAt)}</span>

        <div class="comment-menu" data-comment-menu>
          <button
            type="button"
            class="comment-menu-btn"
            aria-label="Comment actions"
            aria-haspopup="menu"
            aria-expanded={openMenuId === comment.id}
            onclick={(e) => {
              e.stopPropagation()
              toggleMenu(comment.id, e.currentTarget as HTMLElement)
            }}
          >
            <span aria-hidden="true">⋯</span>
          </button>

          {#if openMenuId === comment.id}
            <div
              class="comment-menu-popover"
              role="menu"
              aria-label="Comment actions"
              popover={supportsPopover() ? 'manual' : undefined}
              bind:this={menuEl}
            >
              {#if comment.url}
                <button
                  type="button"
                  role="menuitem"
                  class="comment-menu-item"
                  onclick={(e) => {
                    e.stopPropagation()
                    copyLink(comment)
                  }}
                >
                  Copy link to comment
                </button>
              {/if}
              <button
                type="button"
                role="menuitem"
                class="comment-menu-item"
                onclick={(e) => {
                  e.stopPropagation()
                  quoteReply(comment)
                }}
              >
                Quote reply
              </button>
            </div>
          {/if}
        </div>

        {#if copiedId === comment.id}
          <span class="comment-copied" role="status" aria-live="polite">Copied ✓</span>
        {/if}
      </div>
      <div class="comment-body">
        <MarkdownView source={comment.body} />
      </div>
    </div>
  {/each}
</div>

<style>
  .comment-thread {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Thread uses a left rail (2px subtle border) not a filled block */
  .comment-item {
    border-left: 2px solid var(--border-subtle, var(--hairline));
    padding: 0.4rem 0.75rem;
    border-radius: 0 4px 4px 0;
    background: var(--surface);
    max-width: 80ch;
  }

  .comment-item.reply {
    margin-left: 1.5rem;
    border-left-color: var(--hairline);
  }

  .comment-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
    font-size: 12px;
    color: var(--text-muted);
  }

  .avatar {
    border-radius: 50%;
    display: block;
    flex-shrink: 0;
  }

  .avatar-initial {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--text-muted);
    color: var(--surface);
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
    text-transform: uppercase;
  }

  .comment-author {
    font-weight: 600;
    color: var(--text);
  }

  .comment-time {
    opacity: 0.55;
    margin-left: auto;
    white-space: nowrap;
  }

  /* ---- Per-comment actions menu ---- */
  .comment-menu {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  .comment-menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    /* Unobtrusive: muted by default, revealed on hover/focus of the item */
    opacity: var(--chrome-muted-opacity);
    transition: opacity 0.12s ease, background 0.12s ease;
  }

  .comment-item:hover .comment-menu-btn,
  .comment-menu-btn:hover,
  .comment-menu-btn:focus-visible,
  .comment-menu-btn[aria-expanded='true'] {
    opacity: 1;
    background: var(--surface-raised);
  }

  .comment-menu-popover {
    /*
     * IN THE TOP LAYER. This element is `popover="manual"` and the script
     * calls showPopover() when it opens, which promotes it above every
     * stacking context in the document — the only thing that works here.
     *
     * WHY A NUMBER WAS NEVER GOING TO DO IT, so nobody retries it: this
     * menu's only stacking-context ancestor is @git-diff-view's line-widget
     * wrapper, which carries the library's own `sticky` + `z-[1]` utilities.
     * That wrapper establishes a context, so this subtree paints at 1 against
     * the root whatever is written below. Measured in the built app: park the
     * menu over the draft bar and hit-test it → the BAR wins, at the old
     * literal 20 and at --z-popover (250) alike. Set ONLY the wrapper to
     * `z-index: auto; position: static`, changing nothing about this element →
     * the MENU wins. Restyling the library's wrapper is not an option (it is
     * sticky for a reason and is not our subtree), hence the top layer.
     * e2e/popover-escape.spec.ts pins both halves.
     *
     * `position: fixed` + JS-set left/top, because in the top layer the
     * containing block is the viewport: the old `top: 100%; right: 0` no
     * longer resolves against .comment-menu. See positionMenu().
     *
     * z-index is the FALLBACK FLOOR only. On a browser without the Popover API
     * the attribute is inert, this stays an ordinary fixed element inside the
     * trap, and --z-popover leaves it exactly where it is today — no better,
     * and importantly no worse. Visibility is driven by the {#if} in the
     * markup rather than by `:popover-open`, so the unsupported path still
     * renders the menu instead of hiding it.
     */
    position: fixed;
    margin: 0;
    inset: auto;
    left: 0;
    top: 0;
    z-index: var(--z-popover);
    min-width: 11rem;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface);
    box-shadow: var(--elevation-3);
  }

  .comment-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.55rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 0.8rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .comment-menu-item:hover,
  .comment-menu-item:focus-visible {
    background: var(--surface-raised);
  }

  .comment-copied {
    font-size: 0.72rem;
    color: var(--accent, var(--text-muted));
    white-space: nowrap;
    flex-shrink: 0;
  }

  .comment-body {
    font-family: var(--font-prose);
    font-size: 0.9rem;
    line-height: 1.5;
    overflow-wrap: break-word;
  }

  /* Prose code blocks inside comments */
  .comment-body :global(pre) {
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }

  .comment-body :global(code) {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: var(--surface-raised);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }

  .comment-body :global(pre code) {
    background: none;
    padding: 0;
    font-size: inherit;
  }

  /* <details> inside comment bodies — styled like our collapsible primitives but smaller */
  .comment-body :global(details) {
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    margin: 0.4rem 0;
    font-size: 0.88em;
  }

  .comment-body :global(details summary) {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.88em;
    text-transform: none;
    letter-spacing: normal;
  }

  /* Tables inside comment bodies */
  .comment-body :global(table) {
    border-collapse: collapse;
    font-size: 0.85em;
    max-width: 100%;
    overflow-x: auto;
    display: block;
  }

  .comment-body :global(th),
  .comment-body :global(td) {
    border: 1px solid var(--hairline);
    padding: 0.25rem 0.5rem;
    text-align: left;
  }

  .comment-body :global(th) {
    background: var(--surface-raised);
    font-weight: 600;
  }

  /* Images and long links */
  .comment-body :global(img) {
    max-width: 100%;
    height: auto;
  }

  .comment-body :global(a) {
    overflow-wrap: break-word;
    word-break: break-all;
  }
</style>
