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
  }

  let { value, onchange, onsubmit }: Props = $props()

  let mode: 'write' | 'preview' = $state('write')
  let textareaEl: HTMLTextAreaElement | undefined = $state()

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

  // ---- Keyboard shortcut ----

  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      onsubmit?.()
    }
  }
</script>

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
  .comment-editor {
    border: 1px solid #8884;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .tab-bar {
    display: flex;
    border-bottom: 1px solid #8884;
  }

  .tab-bar button {
    background: none;
    border: none;
    padding: 0.4rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
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
    border-bottom: 1px solid #8882;
    background: #8881;
  }

  .toolbar button {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1.2;
  }

  .toolbar button:hover {
    border-color: #8884;
    background: #fff2;
  }

  textarea {
    width: 100%;
    min-height: 8rem;
    resize: vertical;
    border: none;
    padding: 0.6rem 0.75rem;
    font-family: inherit;
    font-size: 0.95rem;
    box-sizing: border-box;
    background: transparent;
    color: inherit;
    outline: none;
  }

  .preview {
    padding: 0.6rem 0.75rem;
    min-height: 8rem;
  }

  .empty-preview {
    opacity: 0.5;
    font-style: italic;
  }
</style>
