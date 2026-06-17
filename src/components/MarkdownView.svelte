<script lang="ts">
  /**
   * MarkdownView — renders Markdown source to sanitized HTML.
   *
   * Security: uses {@html} ONLY with output of renderMarkdown() which runs
   * marked → DOMPurify. This is the ONLY acceptable use of {@html} here,
   * following the CommentEditor / UnderstandStep precedent.
   *
   * Post-processing: after mount, finds pre>code.language-mermaid blocks
   * (marked emits that class for ```mermaid fences) and replaces each with
   * a rendered SVG container. On mermaid render error the code block is left
   * as-is. Uses the shared getMermaid() helper (initialized once, dark theme).
   */
  import { renderMarkdown } from '../lib/markdown/render'
  import { getMermaid } from '../lib/diagram/mermaidInit'

  interface Props {
    source: string
  }

  let { source }: Props = $props()

  // Container div for post-processing mermaid fences
  let container = $state<HTMLDivElement | null>(null)

  // Rendered HTML (sanitized)
  const html = $derived(renderMarkdown(source))

  // After each render, post-process mermaid fences
  let mermaidCounter = 0
  $effect(() => {
    // Depend on html so this re-runs when source changes
    void html
    const el = container
    if (!el) return

    // Run asynchronously so the DOM is settled after {@html} update
    const handle = setTimeout(() => postProcessMermaid(el), 0)
    return () => clearTimeout(handle)
  })

  async function postProcessMermaid(el: HTMLDivElement) {
    const codeBlocks = el.querySelectorAll<HTMLElement>('pre > code.language-mermaid')
    if (codeBlocks.length === 0) return

    let m: Awaited<ReturnType<typeof getMermaid>>
    try {
      m = await getMermaid()
    } catch {
      return // mermaid failed to load — leave blocks as-is
    }

    for (const codeEl of Array.from(codeBlocks)) {
      const pre = codeEl.parentElement
      if (!pre) continue

      const diagramText = codeEl.textContent ?? ''
      const id = `mermaid-view-${++mermaidCounter}`

      try {
        const { svg } = await m.render(id, diagramText)
        const wrapper = document.createElement('div')
        wrapper.setAttribute('data-mermaid-container', '')
        wrapper.innerHTML = svg
        pre.replaceWith(wrapper)
      } catch {
        // Leave the code block as-is on parse/render error
      }
    }
  }
</script>

<div class="markdown-view" bind:this={container}>
  <!-- {@html} is acceptable ONLY with renderMarkdown() output (sanitization boundary) -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html html}
</div>

<style>
  .markdown-view {
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .markdown-view :global(h1),
  .markdown-view :global(h2),
  .markdown-view :global(h3),
  .markdown-view :global(h4) {
    margin: 0.75em 0 0.25em;
    font-size: 1em;
    font-weight: 600;
  }

  .markdown-view :global(p) { margin: 0 0 0.5em; }
  .markdown-view :global(p:last-child) { margin-bottom: 0; }
  .markdown-view :global(ul),
  .markdown-view :global(ol) { margin: 0 0 0.5em; padding-left: 1.5em; }
  .markdown-view :global(li) { margin: 0.15em 0; }
  .markdown-view :global(pre) { background: #8882; padding: 0.5rem; border-radius: 4px; overflow-x: auto; }
  .markdown-view :global(code) { font-size: 0.85em; background: #8881; padding: 0.1em 0.3em; border-radius: 3px; }
  .markdown-view :global(pre code) { background: none; padding: 0; }

  /* Embedded images (e.g. screenshots in a PR description) — constrain to the
     container so a native-resolution screenshot doesn't overflow and get
     clipped by an ancestor's `overflow: hidden` (which rendered as broken/blank
     images). `height: auto` preserves aspect ratio even when the source carries
     explicit width/height attributes. */
  .markdown-view :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
  }

  /* Mermaid SVG containers */
  .markdown-view :global([data-mermaid-container]) {
    overflow-x: auto;
    margin: 0.5em 0;
  }

  .markdown-view :global([data-mermaid-container] svg) {
    max-width: 100%;
    height: auto;
  }
</style>
