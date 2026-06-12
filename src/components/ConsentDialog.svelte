<script lang="ts">
  let { repo, onresult }: { repo: string; onresult: (accepted: boolean) => void } = $props()

  let dialogEl = $state<HTMLDialogElement | null>(null)

  $effect(() => {
    if (!dialogEl) return
    if (!dialogEl.open) {
      dialogEl.showModal()
    }
  })

  function accept() {
    onresult(true)
  }

  function decline() {
    onresult(false)
  }
</script>

<dialog
  bind:this={dialogEl}
  aria-label="Allow AI analysis"
  aria-modal="true"
  oncancel={(e) => { e.preventDefault(); decline() }}
  onclick={(e) => { if (e.target === e.currentTarget) decline() }}
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

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    justify-content: flex-end;
  }
</style>
