<script lang="ts">
  let { repo, onresult }: { repo: string; onresult: (accepted: boolean) => void } = $props()

  function accept() {
    onresult(true)
  }

  function decline() {
    onresult(false)
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      decline()
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  open
  aria-label="Allow AI analysis"
  aria-modal="true"
  onkeydown={onkeydown}
>
  <h2>Allow AI analysis of private repository?</h2>
  <p>
    Code from the private repository <strong>{repo}</strong> will be sent to DeepSeek for analysis.
  </p>
  <p>
    DeepSeek will receive the file contents and diffs from this pull request.
    Your API key is stored locally in your browser and sent only to DeepSeek.
  </p>
  <div class="actions">
    <button class="btn btn-primary" onclick={accept}>Send code to DeepSeek</button>
    <button class="btn" onclick={decline}>Not now</button>
  </div>
</dialog>

<style>
  /* dialog base styles come from app.css */

  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    justify-content: flex-end;
  }
</style>
