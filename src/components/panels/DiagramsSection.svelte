<script lang="ts">
  import AiPanel from '../AiPanel.svelte'
  import DiagramPanel from '../DiagramPanel.svelte'
  import type { AiRun } from '../../lib/ai/run.svelte'
  import type { GraphResult } from '../../lib/ai/schemas'

  interface Props {
    run: AiRun
  }

  let { run }: Props = $props()
</script>

<AiPanel title="Diagrams" state={run.diagrams} onretry={() => run.retry('diagrams')}>
  {#if run.diagrams.status === 'done'}
    <DiagramPanel result={run.diagrams.value as GraphResult} panelState="idle" />
  {/if}
</AiPanel>
