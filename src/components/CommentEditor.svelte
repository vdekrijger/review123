<script lang="ts">
  /**
   * CommentEditor — markdown editor with toolbar + sanitized live preview.
   *
   * Security note: the Preview tab uses {@html} ONLY with the output of
   * renderMarkdown(), which is the ONLY acceptable use of {@html} in this codebase.
   * renderMarkdown() runs marked → DOMPurify and is the single sanitization boundary.
   */
  import { renderMarkdown } from '../lib/markdown/render'

  interface Props {
    value: string
    onchange: (v: string) => void
    onsubmit?: () => void
    /**
     * When provided, shows a "Suggest change" toolbar button that inserts a
     * GitHub-style suggestion fence with these lines pre-filled for the user to edit.
     * Pass the original source line(s) for the anchored line/range.
     */
    suggestionSource?: string[]
  }

  let { value, onchange, onsubmit, suggestionSource }: Props = $props()

  let mode: 'write' | 'preview' = $state('write')
  let textareaEl: HTMLTextAreaElement | undefined = $state()

  // ---- Emoji picker (hand-rolled popover, no dependency) ----

  /**
   * Curated set of common reaction/dev emojis. Clicking one inserts the raw
   * unicode character at the cursor. The :shortcode: support in previews
   * (renderMarkdown) is unrelated and stays as-is.
   */
  const EMOJIS = [
    '👍', '👎', '🎉', '❤️', '🚀', '👀',
    '😄', '😅', '🤔', '🙏', '💯', '🔥',
    '✨', '💡', '✅', '❌', '⚠️', '🐛',
    '📝', '♻️', '⚡', '😕', '😮', '🧹',
  ]

  let emojiOpen = $state(false)
  let emojiBtnEl: HTMLButtonElement | undefined = $state()
  let emojiWrapEl: HTMLElement | undefined = $state()

  function toggleEmoji() {
    emojiOpen = !emojiOpen
  }

  function pickEmoji(emoji: string) {
    emojiOpen = false
    // insertAt restores focus to the textarea with the cursor after the emoji
    insertAt(emoji)
  }

  /** Escape closes the picker and returns focus to the emoji toggle button. */
  function onEmojiWindowKeydown(e: KeyboardEvent) {
    if (!emojiOpen) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      emojiOpen = false
      emojiBtnEl?.focus()
    }
  }

  /** Click/tap outside the emoji button + popover closes the picker. */
  function onEmojiWindowPointerDown(e: PointerEvent) {
    if (!emojiOpen) return
    if (emojiWrapEl && !emojiWrapEl.contains(e.target as Node)) {
      emojiOpen = false
    }
  }

  // ---- Toolbar helpers ----

  /**
   * Wrap the current textarea selection in prefix/suffix markers.
   * If nothing is selected, insert prefix+suffix with cursor between them.
   * Calls onchange with the new value.
   */
  function wrapSelection(prefix: string, suffix: string = prefix): void {
    const ta = textareaEl
    if (!ta) return

    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = value.slice(start, end)
    const newValue =
      value.slice(0, start) + prefix + selected + suffix + value.slice(end)

    onchange(newValue)

    // Restore/advance cursor: place it after the inserted prefix when selection was empty
    requestAnimationFrame(() => {
      if (!ta) return
      if (start === end) {
        // No selection: put cursor between prefix and suffix
        const cursorPos = start + prefix.length
        ta.setSelectionRange(cursorPos, cursorPos)
      } else {
        // Had selection: highlight only the original text (between the markers)
        ta.setSelectionRange(start + prefix.length, end + prefix.length)
      }
      ta.focus()
    })
  }

  /** Insert text at the current cursor position. */
  function insertAt(text: string): void {
    const ta = textareaEl
    if (!ta) return
    const start = ta.selectionStart
    const newValue = value.slice(0, start) + text + value.slice(ta.selectionEnd)
    onchange(newValue)
    requestAnimationFrame(() => {
      if (!ta) return
      const cursorPos = start + text.length
      ta.setSelectionRange(cursorPos, cursorPos)
      ta.focus()
    })
  }

  // ---- Toolbar button handlers ----

  function onBold() {
    wrapSelection('**')
  }

  function onItalic() {
    wrapSelection('_')
  }

  function onCode() {
    wrapSelection('`')
  }

  function onCodeBlock() {
    const ta = textareaEl
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = value.slice(start, end)
    const block = selected ? `\`\`\`\n${selected}\n\`\`\`` : `\`\`\`\n\n\`\`\``
    const newValue = value.slice(0, start) + block + value.slice(end)
    onchange(newValue)
    requestAnimationFrame(() => {
      if (!ta) return
      // Place cursor inside the block when nothing was selected
      const cursorPos = selected ? start + block.length : start + 4
      ta.setSelectionRange(cursorPos, cursorPos)
      ta.focus()
    })
  }

  function onLink() {
    const ta = textareaEl
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = value.slice(start, end)
    const text = selected || 'text'
    const insertion = `[${text}](url)`
    const newValue = value.slice(0, start) + insertion + value.slice(end)
    onchange(newValue)
    requestAnimationFrame(() => {
      if (!ta) return
      // Select 'url' part so user can type the URL immediately
      const urlStart = start + text.length + 3
      const urlEnd = urlStart + 3
      ta.setSelectionRange(urlStart, urlEnd)
      ta.focus()
    })
  }

  function onList() {
    const ta = textareaEl
    if (!ta) return
    const start = ta.selectionStart
    const newValue = value.slice(0, start) + '- ' + value.slice(start)
    onchange(newValue)
    requestAnimationFrame(() => {
      if (!ta) return
      const cursorPos = start + 2
      ta.setSelectionRange(cursorPos, cursorPos)
      ta.focus()
    })
  }

  function onSuggestChange() {
    if (!suggestionSource) return
    const fence = `\`\`\`suggestion\n${suggestionSource.join('\n')}\n\`\`\``
    insertAt(fence)
  }

  // ---- Keyboard shortcut ----

  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      onsubmit?.()
    }
  }
</script>

<svelte:window onkeydown={onEmojiWindowKeydown} onpointerdown={onEmojiWindowPointerDown} />

<div class="comment-editor">
  <!-- Tab bar -->
  <div class="tab-bar" role="tablist">
    <button
      role="tab"
      aria-selected={mode === 'write'}
      class:active={mode === 'write'}
      onclick={() => (mode = 'write')}
    >
      Write
    </button>
    <button
      role="tab"
      aria-selected={mode === 'preview'}
      class:active={mode === 'preview'}
      onclick={() => (mode = 'preview')}
    >
      Preview
    </button>
  </div>

  {#if mode === 'write'}
    <!-- Toolbar -->
    <div class="toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" aria-label="Bold" onclick={onBold} title="Bold (**text**)">B</button>
      <button type="button" aria-label="Italic" onclick={onItalic} title="Italic (_text_)"><em>I</em></button>
      <button type="button" aria-label="Inline code" onclick={onCode} title="Inline code (`code`)"><code>`</code></button>
      <button type="button" aria-label="Code block" onclick={onCodeBlock} title="Code block (``` block ```)"><code>```</code></button>
      <button type="button" aria-label="Link" onclick={onLink} title="Link ([text](url))">🔗</button>
      <button type="button" aria-label="List" onclick={onList} title="Unordered list (- item)">•</button>
      <span class="emoji-wrap" bind:this={emojiWrapEl}>
        <button
          type="button"
          bind:this={emojiBtnEl}
          aria-label="Insert emoji"
          aria-haspopup="true"
          aria-expanded={emojiOpen}
          onclick={toggleEmoji}
          title="Insert emoji"
        >🙂</button>
        {#if emojiOpen}
          <div class="emoji-popover" data-testid="emoji-picker" role="group" aria-label="Emoji picker">
            {#each EMOJIS as emoji (emoji)}
              <button type="button" class="emoji-option" onclick={() => pickEmoji(emoji)}>{emoji}</button>
            {/each}
          </div>
        {/if}
      </span>
      {#if suggestionSource}
        <button type="button" aria-label="Suggest change" onclick={onSuggestChange} title="Insert suggestion block (```suggestion ...```)">±</button>
      {/if}
    </div>

    <!-- Editor -->
    <textarea
      bind:this={textareaEl}
      {value}
      oninput={(e) => onchange((e.currentTarget as HTMLTextAreaElement).value)}
      onkeydown={onKeydown}
      placeholder="Leave a comment…"
      rows="5"
      aria-label="Comment body"
    ></textarea>
  {:else}
    <!-- Preview — sanitization happens inside renderMarkdown(); this is the only
         acceptable use of {@html} in this codebase. -->
    <div class="preview">
      {#if value.trim()}
        {@html renderMarkdown(value)}
      {:else}
        <p class="empty-preview">Nothing to preview.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  /*
   * Theme audit: editor chrome and the Write-tab textarea use design-system
   * tokens (--surface / --text / --hairline) so text stays readable in BOTH
   * themes — the previous transparent/inherit combo rendered dim dark-on-dark
   * text in dark theme (same class of bug as the theme-audit PR #11).
   */
  .comment-editor {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    overflow: visible;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }

  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--hairline);
  }

  .tab-bar button {
    background: none;
    border: none;
    padding: 0.4rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
    color: var(--text);
    opacity: 0.7;
  }

  .tab-bar button.active {
    opacity: 1;
    border-bottom: 2px solid currentColor;
    margin-bottom: -1px;
  }

  .toolbar {
    display: flex;
    gap: 0.25rem;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--hairline);
    background: var(--surface-raised);
  }

  .toolbar button {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1.2;
    color: var(--text);
  }

  .toolbar button:hover {
    border-color: var(--hairline);
    background: var(--accent-subtle);
  }

  textarea {
    width: 100%;
    min-height: 8rem;
    resize: vertical;
    border: none;
    border-radius: 0 0 6px 6px;
    padding: 0.6rem 0.75rem;
    font-family: inherit;
    font-size: 0.95rem;
    box-sizing: border-box;
    background: var(--surface);
    color: var(--text);
    caret-color: var(--text);
    outline: none;
  }

  textarea::placeholder {
    color: var(--text-muted);
  }

  .preview {
    padding: 0.6rem 0.75rem;
    min-height: 8rem;
    color: var(--text);
  }

  /* ── Emoji picker popover ── */

  .emoji-wrap {
    position: relative;
    display: inline-block;
  }

  .emoji-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    display: grid;
    grid-template-columns: repeat(6, auto);
    gap: 2px;
    padding: 0.35rem;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  }

  /* scoped under .toolbar to out-rank the generic .toolbar button rule */
  .toolbar .emoji-option {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.15rem 0.3rem;
    font-size: 1rem;
    line-height: 1.2;
    cursor: pointer;
  }

  .toolbar .emoji-option:hover,
  .toolbar .emoji-option:focus-visible {
    border-color: var(--hairline);
    background: var(--accent-subtle);
  }

  .empty-preview {
    opacity: 0.5;
    font-style: italic;
  }
</style>
