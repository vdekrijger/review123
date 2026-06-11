<script lang="ts">
  let { owner, repo, number }: { owner: string; repo: string; number: number } = $props()
</script>
<p>Loading {owner}/{repo}#{number}…</p>
