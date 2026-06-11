<script lang="ts">
  /**
   * DraftThread — inline thread widget for a single line comment.
   *
   * Shows an existing draft body (rendered via renderMarkdown) with Edit/Delete buttons,
   * or a CommentEditor in edit/new mode.
   */
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import { renderMarkdown } from '../lib/markdown/render'
  import CommentEditor from './CommentEditor.svelte'

  interface Props {
    /** Existing draft for this line, or null when opening a new comment */
    draft: Draft | null
    path: string
    line: number
    side: 'LEFT' | 'RIGHT'
    onsave: (body: string) => void
    ondelete: () => void
    oncancel: () => void
  }

  let { draft, path: _path, line, side: _side, onsave, ondelete, oncancel }: Props = $props()

  // Track the last draft identity to detect external draft changes (e.g. parent load).
  // initialized with a sentinel so the $effect always runs on first mount.
  let lastDraftKey = $state<string | undefined>(undefined)

  // edit mode and editor buffer — will be set immediately by the $effect below
  let editing = $state<boolean>(false)
  let editorValue = $state<string>('')

  // When draft changes externally (different draft loaded for same line), reset editor state.
  // On first mount, lastDraftKey is undefined, so this always runs once on mount.
  $effect(() => {
    const key = draft ? `${draft.prKey}|${draft.path}|${draft.line}|${draft.side}` : null
    if (key !== lastDraftKey) {
      lastDraftKey = key ?? undefined
      if (draft === null) {
        editing = true
        editorValue = ''
      } else {
        editing = false
        editorValue = draft.body
      }
    }
  })

  function handleSave() {
    if (editorValue.trim()) {
      onsave(editorValue)
      editing = false
    }
  }

  function handleEdit() {
    editorValue = draft?.body ?? ''
    editing = true
  }

  function handleDelete() {
    ondelete()
  }

  function handleCancel() {
    if (draft === null) {
      // New draft cancelled: close the widget
      oncancel()
    } else {
      // Existing draft: go back to view mode
      editorValue = draft.body
      editing = false
    }
  }
</script>

<div class="draft-thread" data-testid="draft-thread" data-line={line}>
  <div class="thread-header">
    <span class="thread-label">Comment at line {line}</span>
  </div>

  {#if editing}
    <CommentEditor
      value={editorValue}
      onchange={(v) => (editorValue = v)}
      onsubmit={handleSave}
    />
    <div class="thread-actions">
      <button type="button" class="btn-primary" onclick={handleSave} disabled={!editorValue.trim()}>
        Save
      </button>
      <button type="button" class="btn-secondary" onclick={handleCancel}>
        Cancel
      </button>
    </div>
  {:else if draft !== null}
    <!-- View mode: show rendered body -->
    <!-- renderMarkdown output is the only accepted use of {@html} -->
    <div class="draft-body">
      {@html renderMarkdown(draft.body)}
    </div>
    <div class="thread-actions">
      <button type="button" class="btn-secondary" onclick={handleEdit}>Edit</button>
      <button type="button" class="btn-danger" onclick={handleDelete}>Delete</button>
    </div>
  {/if}
</div>

<style>
  .draft-thread {
    border: 1px solid #f0b44488;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    background: #fffbf0;
    color: #333;
    font-size: 0.9rem;
  }

  :global(.dark) .draft-thread {
    background: #2a2510;
    border-color: #a07820;
    color: #e8e0c8;
  }

  .thread-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.4rem;
  }

  .thread-label {
    font-size: 0.8rem;
    opacity: 0.7;
    font-weight: 500;
  }

  .draft-body {
    padding: 0.25rem 0;
    line-height: 1.5;
  }

  /* Normalize markdown output inside the draft body */
  .draft-body :global(p) { margin: 0 0 0.5em; }
  .draft-body :global(p:last-child) { margin-bottom: 0; }
  .draft-body :global(pre) { background: #8882; padding: 0.5rem; border-radius: 4px; overflow-x: auto; }
  .draft-body :global(code) { font-size: 0.85em; background: #8881; padding: 0.1em 0.3em; border-radius: 3px; }
  .draft-body :global(pre code) { background: none; padding: 0; }

  .thread-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  button {
    border: none;
    border-radius: 4px;
    padding: 0.25rem 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .btn-primary {
    background: #0969da;
    color: #fff;
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: #8882;
    color: inherit;
  }

  .btn-danger {
    background: #cf222e22;
    color: #cf222e;
  }

  button:hover:not(:disabled) {
    filter: brightness(0.9);
  }
</style>
