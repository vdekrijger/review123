<script lang="ts">
  import AiPanel from '../AiPanel.svelte'
  import MarkdownView from '../MarkdownView.svelte'
  import { stripReadingOrder } from '../../lib/ai/tasks'
  import type { AiRun } from '../../lib/ai/run.svelte'

  interface Props {
    run: AiRun
  }

  let { run }: Props = $props()

  const summaryText = $derived.by(() => {
    if (run.summary.status === 'done' || run.summary.status === 'streaming') {
      const raw = run.summary.value as string
      return run.summary.status === 'done' ? stripReadingOrder(raw) : raw
    }
    return ''
  })
</script>

<AiPanel title="Summary" task="summary" state={run.summary} skeletonVariant="text" skeletonLines={4} onretry={() => run.retry('summary')}>
  {#if run.summary.status === 'streaming'}
    <pre class="prose">{summaryText}</pre>
  {:else if run.summary.status === 'done'}
    <MarkdownView source={summaryText} />
  {/if}
</AiPanel>

<style>
  .prose {
    font-family: inherit;
    white-space: pre-wrap;
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
  }
</style>
