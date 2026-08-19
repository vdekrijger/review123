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

<AiPanel title="Diagrams" task="diagrams" state={run.diagrams} skeletonVariant="block" onretry={() => run.retry('diagrams')}>
  {#if run.diagrams.status === 'done'}
    <!-- error/errorDetail pass-through: AiPanel owns the primary error UI here
         (panelState is only ever "idle" inside the done branch), but the props
         keep DiagramPanel self-sufficient for callers that drive its own
         'error' state. -->
    <DiagramPanel result={run.diagrams.value as GraphResult} panelState="idle" error={run.diagrams.error} errorDetail={run.diagrams.errorDetail} />
  {/if}
</AiPanel>
