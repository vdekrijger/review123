<script lang="ts">
  /**
   * SymbolPopover — IDE-like symbol navigation popover (Tier 1).
   *
   * Opened by FileDiff when the user clicks an identifier in the rendered
   * diff. Two sections:
   *   1. Definition — snippet + file:line when the symbol's definition is
   *      findable in the content available for this PR; otherwise an HONEST
   *      "not in the changed files" line (repo-wide lookup is a later PR).
   *   2. Call points in this PR (N) — every reference, grouped by file; rows
   *      inside the rendered hunks jump to that file+line (cross-file jumps
   *      included — the shared #file-<slug> scroll mechanism handles them);
   *      rows known only from fetched full contents (unchanged regions) are
   *      non-clickable with a tooltip explaining why.
   *
   * Interaction idioms follow the review-command menu (VerdictStep): Escape
   * closes, focus is moved into the popover on open, and focus leaving the
   * popover closes it.
   *
   * Tier 2 adds an on-demand "In repo" section: a [Search repo] button (never
   * automatic — the code-search API allows ~10 searches/min) that finds call
   * points OUTSIDE the PR's files via lib/symbols/repoSearch. Results are
   * NON-clickable (those files aren't in the diff view) with a copyable path;
   * a repo-found definition upgrades the "not in the changed files" state.
   * The section only renders when the provider supports code search
   * (onSearchRepo non-null — capability by method presence).
   */
  import type { SymbolDefinition, SymbolReference, DiffSide } from '../lib/symbols/symbolIndex'
  import type { RepoSearchOutcome } from '../lib/symbols/repoSearch'
  import { peekDefinition, type DefinitionPeek } from '../lib/symbols/definitionPeek'
  import { symbolSourceFor } from '../lib/symbols/symbolSources'
  import { highlightSnippet, snippetLangForFilename } from '../lib/diff/highlightSnippet'

  interface Props {
    symbol: string
    definitions: SymbolDefinition[]
    references: SymbolReference[]
    /** Viewport coords of the originating click (popover anchors nearby). */
    x: number
    y: number
    /** The file whose diff was clicked — its references group lists first. */
    currentFile: string
    onJump: (file: string, line: number, side: DiffSide) => void
    onClose: () => void
    /**
     * Runs the repo-wide search for this symbol (Tier 2). null → the provider
     * has no code search (or no head SHA is known) and the "In repo" section
     * is omitted entirely.
     */
    onSearchRepo?: (() => Promise<RepoSearchOutcome>) | null
  }

  let { symbol, definitions, references, x, y, currentFile, onJump, onClose, onSearchRepo = null }: Props = $props()

  let dialogEl = $state<HTMLElement | null>(null)

  // Move focus into the popover on open so Escape/focusout semantics work.
  $effect(() => {
    dialogEl?.focus()
  })

  const MAX_DEFS_SHOWN = 3
  const shownDefs = $derived(definitions.slice(0, MAX_DEFS_SHOWN))

  // ---- Definition peek (expandable code block per definition row) ----------
  // Per-row disclosure state, keyed by origin+location so multiple definitions
  // expand independently. The toggle button NEVER unmounts on toggle (the peek
  // block renders BELOW the row) — unmounting the focused element would fire
  // focusout with relatedTarget null and the focus-leave idiom would close the
  // whole popover (the #210 lesson).
  let expandedPeeks = $state<ReadonlySet<string>>(new Set())

  function peekKey(def: SymbolDefinition, origin: 'pr' | 'repo'): string {
    return `${origin}|${def.file}|${def.side}|${def.line}`
  }

  function togglePeek(key: string) {
    const next = new Set(expandedPeeks)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expandedPeeks = next
  }

  /**
   * Peek for a Tier 1 definition — reads the file's REGISTERED symbol source
   * (the same text the index was built on). null → no expand affordance.
   */
  function peekFor(def: SymbolDefinition): DefinitionPeek | null {
    const source = symbolSourceFor(def.file)
    return source ? peekDefinition(source, def.side, def.line, def.endLine) : null
  }

  const PATCH_ONLY_NOTE = 'Only the changed lines are available for this file.'

  // References grouped by file — current file first, then path order; within
  // a file new-side rows before old-side (deleted) rows, ascending lines.
  const refsByFile = $derived.by(() => {
    const ordered = [...references].sort((a, b) => {
      const aCur = a.file === currentFile ? 0 : 1
      const bCur = b.file === currentFile ? 0 : 1
      if (aCur !== bCur) return aCur - bCur
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      if (a.side !== b.side) return a.side === 'new' ? -1 : 1
      return a.line - b.line
    })
    const map = new Map<string, SymbolReference[]>()
    for (const r of ordered) {
      const arr = map.get(r.file) ?? []
      arr.push(r)
      map.set(r.file, arr)
    }
    return map
  })

  function handleJump(file: string, line: number, side: DiffSide) {
    onClose()
    onJump(file, line, side)
  }

  // ---- "In repo" section (Tier 2) ----------------------------------------
  type RepoPhase =
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'done'; outcome: RepoSearchOutcome }
  let repoState = $state<RepoPhase>({ phase: 'idle' })

  // Reset when the popover is retargeted to another symbol without unmount
  // (clicking a different identifier replaces the props, not the component).
  $effect(() => {
    void symbol
    repoState = { phase: 'idle' }
    expandedPeeks = new Set()
  })

  async function runRepoSearch() {
    if (!onSearchRepo || repoState.phase === 'loading') return
    const forSymbol = symbol
    // The click leaves focus on the [Search repo] button, and the loading
    // state UNMOUNTS that button. Removing the focused element fires focusout
    // with relatedTarget null, which the focus-leave idiom would read as
    // "focus left the popover" — closing it mid-search. Park focus back on
    // the dialog BEFORE the button unmounts.
    dialogEl?.focus()
    repoState = { phase: 'loading' }
    const outcome = await onSearchRepo()
    // Drop a stale result if the popover was retargeted mid-flight.
    if (symbol !== forSymbol) return
    repoState = { phase: 'done', outcome }
  }

  const repoOutcome = $derived(repoState.phase === 'done' ? repoState.outcome : null)
  const repoOk = $derived(repoOutcome?.ok === true ? repoOutcome : null)
  const repoError = $derived(repoOutcome && !repoOutcome.ok ? repoOutcome.message : null)

  /** Repo-found definitions — shown in the Definition section, tagged "repo". */
  const repoDefs = $derived(repoOk ? repoOk.definitions.slice(0, MAX_DEFS_SHOWN) : [])

  /**
   * Peek for a repo-found definition — reads the fetched head-SHA contents the
   * search outcome carries (the SAME text those definitions were indexed
   * from). Outcomes without contents (hand-built/legacy) offer no peek.
   */
  function repoPeekFor(def: SymbolDefinition): DefinitionPeek | null {
    const text = repoOk?.contentsByPath?.get(def.file)
    if (text === undefined) return null
    return peekDefinition({ filename: def.file, contents: { before: null, after: text } }, def.side, def.line, def.endLine)
  }

  const repoRefsByFile = $derived.by(() => {
    const map = new Map<string, SymbolReference[]>()
    if (!repoOk) return map
    const ordered = [...repoOk.references].sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    for (const r of ordered) {
      const arr = map.get(r.file) ?? []
      arr.push(r)
      map.set(r.file, arr)
    }
    return map
  })

  // Copy-path state for repo result files (they aren't in the diff view, so
  // the path itself is the take-away).
  let copiedPath = $state<string | null>(null)
  async function copyRepoPath(path: string) {
    await navigator.clipboard.writeText(path)
    copiedPath = path
    setTimeout(() => {
      if (copiedPath === path) copiedPath = null
    }, 1500)
  }

  const NOT_IN_DIFF_HINT = "Not in this PR's diff"

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  /** Close when focus leaves the whole popover (same idiom as VerdictStep's menu). */
  function onFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null
    const root = e.currentTarget as HTMLElement
    if (next && root.contains(next)) return
    onClose()
  }

  // Clamp near the click, inside the viewport.
  const POPOVER_WIDTH = 460
  const positionStyle = $derived.by(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800
    const left = Math.max(8, Math.min(x, vw - POPOVER_WIDTH - 8))
    const top = Math.max(8, Math.min(y + 10, vh - 80))
    return `left: ${left}px; top: ${top}px;`
  })

  const UNCHANGED_REGION_HINT = 'In an unchanged region — not shown in the rendered diff'
</script>

<div
  class="symbol-popover"
  role="dialog"
  aria-label="Symbol {symbol}"
  tabindex="-1"
  bind:this={dialogEl}
  onkeydown={onKeydown}
  onfocusout={onFocusOut}
  style={positionStyle}
  data-testid="symbol-popover"
>
  <header class="popover-header">
    <code class="symbol-name">{symbol}</code>
    <button class="close-btn" type="button" aria-label="Close symbol popover" onclick={onClose}>×</button>
  </header>

  <!-- Expanded definition body: line-number gutter + highlighted code in ONE
       scroll container (height-capped; horizontal overflow stays inside). -->
  {#snippet peekBlock(peek: DefinitionPeek, file: string)}
    {@const code = peek.lines.map((l) => l.text).join('\n')}
    <div class="peek-block" data-testid="definition-peek">
      <div class="peek-scroll">
        <pre class="peek-gutter" aria-hidden="true">{peek.lines.map((l) => l.line).join('\n')}</pre>
        {#await highlightSnippet(code, snippetLangForFilename(file))}
          <pre class="peek-code"><code>{code}</code></pre>
        {:then highlighted}
          <pre class="peek-code"><code>{@html highlighted}</code></pre>
        {/await}
      </div>
      {#if peek.moreLines > 0}
        <p class="peek-more">… ({peek.moreLines} more line{peek.moreLines === 1 ? '' : 's'})</p>
      {/if}
      {#if peek.limitedToPatch}
        <p class="peek-partial">{PATCH_ONLY_NOTE}</p>
      {/if}
    </div>
  {/snippet}

  <!-- One definition row: disclosure toggle + one-line snippet, the expanded
       peek rendered BELOW (the focused toggle must never unmount — #210). -->
  {#snippet defRow(def: SymbolDefinition, peek: DefinitionPeek | null, key: string)}
    {@const open = peek !== null && expandedPeeks.has(key)}
    <div class="def-row">
      {#if peek}
        <button
          class="peek-toggle"
          type="button"
          aria-expanded={open}
          aria-label="Definition body at {def.file}:{def.line}"
          onclick={() => togglePeek(key)}
        ><span class="peek-caret" aria-hidden="true">{open ? '▾' : '▸'}</span></button>
      {/if}
      <pre class="def-snippet">{def.snippet}</pre>
    </div>
    {#if peek !== null && open}
      {@render peekBlock(peek, def.file)}
    {/if}
  {/snippet}

  <section class="defs" aria-label="Definition of {symbol}">
    <h4>Definition</h4>
    {#if shownDefs.length > 0 || repoDefs.length > 0}
      {#each shownDefs as def (def.file + '|' + def.side + '|' + def.line)}
        <div class="def-entry">
          {@render defRow(def, peekFor(def), peekKey(def, 'pr'))}
          {#if def.inDiff}
            <button class="loc jump" type="button" onclick={() => handleJump(def.file, def.line, def.side)}>
              {def.file}:{def.line}{def.side === 'old' ? ' (old)' : ''}
            </button>
          {:else}
            <span class="loc" title={UNCHANGED_REGION_HINT}>{def.file}:{def.line}{def.side === 'old' ? ' (old)' : ''}</span>
          {/if}
        </div>
      {/each}
      {#if definitions.length > MAX_DEFS_SHOWN}
        <p class="more-note">+{definitions.length - MAX_DEFS_SHOWN} more definition{definitions.length - MAX_DEFS_SHOWN === 1 ? '' : 's'}</p>
      {/if}
      <!-- Repo-found definitions (Tier 2) — outside the PR's files, so the
           location is copy-only, never a jump target. -->
      {#each repoDefs as def (def.file + '|' + def.line)}
        <div class="def-entry" data-testid="repo-definition">
          {@render defRow(def, repoPeekFor(def), peekKey(def, 'repo'))}
          <span class="loc" title={NOT_IN_DIFF_HINT}>{def.file}:{def.line} <span class="repo-tag">repo</span></span>
        </div>
      {/each}
    {:else}
      <p class="not-found">Definition not in the changed files of this PR.</p>
    {/if}
  </section>

  <section class="refs" aria-label="Call points of {symbol}">
    <h4>Call points in this PR ({references.length})</h4>
    {#if references.length === 0}
      <p class="not-found">No references in this PR's files.</p>
    {:else}
      <div class="ref-list">
        {#each [...refsByFile.entries()] as [file, refs] (file)}
          <div class="ref-file">
            <div class="ref-file-name"><code>{file}</code></div>
            {#each refs as ref (ref.side + '|' + ref.line)}
              {#if ref.inDiff}
                <button class="ref-row" type="button" onclick={() => handleJump(ref.file, ref.line, ref.side)}>
                  <span class="ref-line" class:old-side={ref.side === 'old'}>{ref.side === 'old' ? '−' : ''}{ref.line}</span>
                  <span class="ref-snippet">{ref.snippet}</span>
                </button>
              {:else}
                <div class="ref-row static" title={UNCHANGED_REGION_HINT}>
                  <span class="ref-line">{ref.line}</span>
                  <span class="ref-snippet">{ref.snippet}</span>
                </div>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if onSearchRepo}
    <section class="repo" aria-label="Call points in the repo for {symbol}">
      <h4>In repo{repoOk ? ` (${repoOk.references.length})` : ''}</h4>
      {#if repoState.phase === 'loading'}
        <p class="repo-status" role="status">Searching repo…</p>
      {:else if repoOk}
        {#if repoOk.references.length === 0}
          <p class="not-found">No other call points found in the repo.</p>
        {:else}
          <div class="ref-list">
            {#each [...repoRefsByFile.entries()] as [file, refs] (file)}
              <div class="ref-file">
                <div class="ref-file-name repo-file">
                  <code>{file}</code>
                  <button class="copy-repo-path" type="button" aria-label="Copy path {file}" onclick={() => copyRepoPath(file)}>
                    {#if copiedPath === file}<span class="copy-done">Copied</span>{:else}<span aria-hidden="true">⎘</span>{/if}
                  </button>
                </div>
                {#each refs as ref (ref.line)}
                  <div class="ref-row static" title={NOT_IN_DIFF_HINT}>
                    <span class="ref-line">{ref.line}</span>
                    <span class="ref-snippet">{ref.snippet}</span>
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
        <p class="repo-footnote">Repo search uses the default branch index; results re-checked at this PR's head.</p>
      {:else}
        {#if repoError}
          <p class="repo-error" role="alert">{repoError}</p>
        {/if}
        <button class="search-repo-btn" type="button" onclick={runRepoSearch}>Search repo</button>
      {/if}
    </section>
  {/if}
</div>

<style>
  .symbol-popover {
    position: fixed;
    z-index: 250; /* above the topbar (200); below nothing that matters here */
    width: 460px;
    max-width: calc(100vw - 16px);
    max-height: min(24rem, 70vh);
    overflow-y: auto;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
    padding: 0.5rem 0.65rem 0.65rem;
    font-size: 0.8rem;
    color: var(--text);
    outline: none;
  }

  .popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
  }

  .symbol-name {
    font-family: var(--font-mono);
    font-size: 0.85rem;
    font-weight: 600;
  }

  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
    border-radius: 3px;
  }
  .close-btn:hover { color: var(--text); }

  h4 {
    margin: 0 0 0.25rem;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  section + section { margin-top: 0.6rem; }

  .def-entry { margin-bottom: 0.4rem; }

  .def-snippet {
    margin: 0 0 0.15rem;
    padding: 0.3rem 0.45rem;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ---- Definition peek (expandable code block) ---- */
  .def-row {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
  }
  .def-row .def-snippet {
    flex: 1;
    min-width: 0;
  }

  .peek-toggle {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.3rem 0.1rem 0 0;
    line-height: 1;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .peek-toggle:hover { color: var(--text); }
  .peek-caret { font-size: 0.7rem; }

  .peek-block { margin: 0.15rem 0 0.2rem; }

  .peek-scroll {
    display: flex;
    overflow: auto;
    /* ~15 lines visible; vertical scroll for the rest. */
    max-height: calc(15 * 1.5 * 0.72rem);
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 4px;
  }

  .peek-gutter {
    position: sticky; /* survives horizontal scroll of long lines */
    left: 0;
    margin: 0;
    padding: 0.35rem 0.45rem;
    text-align: right;
    color: var(--text-muted);
    background: var(--surface);
    border-right: 1px solid var(--hairline);
    user-select: none;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.5;
  }

  .peek-code {
    margin: 0;
    padding: 0.35rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.5;
    white-space: pre;
  }
  .peek-code code { font-family: inherit; }

  .peek-more,
  .peek-partial {
    margin: 0.15rem 0 0;
    font-size: 0.68rem;
    color: var(--text-muted);
  }
  .peek-partial { font-style: italic; }

  /* Syntax-token colors for the peek, scoped like SymbolTestPairing's snippet
     palette: GitHub prettylights DARK as the base (the app's default theme),
     with explicit + auto light-theme overrides below. */
  .peek-code :global(.hljs-doctag),
  .peek-code :global(.hljs-keyword),
  .peek-code :global(.hljs-meta .hljs-keyword),
  .peek-code :global(.hljs-template-tag),
  .peek-code :global(.hljs-template-variable),
  .peek-code :global(.hljs-type),
  .peek-code :global(.hljs-variable.language_) { color: #ff7b72; }
  .peek-code :global(.hljs-title),
  .peek-code :global(.hljs-title.class_),
  .peek-code :global(.hljs-title.function_) { color: #d2a8ff; }
  .peek-code :global(.hljs-attr),
  .peek-code :global(.hljs-attribute),
  .peek-code :global(.hljs-literal),
  .peek-code :global(.hljs-meta),
  .peek-code :global(.hljs-number),
  .peek-code :global(.hljs-operator),
  .peek-code :global(.hljs-variable),
  .peek-code :global(.hljs-selector-attr),
  .peek-code :global(.hljs-selector-class),
  .peek-code :global(.hljs-selector-id) { color: #79c0ff; }
  .peek-code :global(.hljs-regexp),
  .peek-code :global(.hljs-string),
  .peek-code :global(.hljs-meta .hljs-string) { color: #a5d6ff; }
  .peek-code :global(.hljs-built_in),
  .peek-code :global(.hljs-symbol) { color: #ffa657; }
  .peek-code :global(.hljs-comment),
  .peek-code :global(.hljs-code),
  .peek-code :global(.hljs-formula) { color: #8b949e; }
  .peek-code :global(.hljs-name),
  .peek-code :global(.hljs-quote),
  .peek-code :global(.hljs-selector-tag),
  .peek-code :global(.hljs-selector-pseudo) { color: #7ee787; }
  .peek-code :global(.hljs-emphasis) { font-style: italic; }
  .peek-code :global(.hljs-strong) { font-weight: bold; }

  /* Light palette (GitHub light) — explicit theme choice. */
  :global(:root[data-theme='light']) .peek-code :global(.hljs-doctag),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-keyword),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-meta .hljs-keyword),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-template-tag),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-template-variable),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-type),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-variable.language_) { color: #d73a49; }
  :global(:root[data-theme='light']) .peek-code :global(.hljs-title),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-title.class_),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-title.function_) { color: #6f42c1; }
  :global(:root[data-theme='light']) .peek-code :global(.hljs-attr),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-attribute),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-literal),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-meta),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-number),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-operator),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-variable),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-selector-attr),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-selector-class),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-selector-id) { color: #005cc5; }
  :global(:root[data-theme='light']) .peek-code :global(.hljs-regexp),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-string),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-meta .hljs-string) { color: #032f62; }
  :global(:root[data-theme='light']) .peek-code :global(.hljs-built_in),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-symbol) { color: #e36209; }
  :global(:root[data-theme='light']) .peek-code :global(.hljs-comment),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-code),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-formula) { color: #6a737d; }
  :global(:root[data-theme='light']) .peek-code :global(.hljs-name),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-quote),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-selector-tag),
  :global(:root[data-theme='light']) .peek-code :global(.hljs-selector-pseudo) { color: #22863a; }

  /* Auto light preference (no explicit choice stored). */
  @media (prefers-color-scheme: light) {
    :global(:root:not([data-theme])) .peek-code :global(.hljs-doctag),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-keyword),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-type),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-variable.language_) { color: #d73a49; }
    :global(:root:not([data-theme])) .peek-code :global(.hljs-title),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-title.function_) { color: #6f42c1; }
    :global(:root:not([data-theme])) .peek-code :global(.hljs-attr),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-literal),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-number),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-selector-id) { color: #005cc5; }
    :global(:root:not([data-theme])) .peek-code :global(.hljs-regexp),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-string) { color: #032f62; }
    :global(:root:not([data-theme])) .peek-code :global(.hljs-built_in),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-symbol) { color: #e36209; }
    :global(:root:not([data-theme])) .peek-code :global(.hljs-comment) { color: #6a737d; }
    :global(:root:not([data-theme])) .peek-code :global(.hljs-name),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-selector-tag),
    :global(:root:not([data-theme])) .peek-code :global(.hljs-selector-pseudo) { color: #22863a; }
  }

  .loc {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .loc.jump {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--accent);
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  .loc.jump:hover { text-decoration-style: solid; }

  .not-found {
    margin: 0;
    font-style: italic;
    color: var(--text-muted);
  }

  .more-note {
    margin: 0;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .ref-list { display: flex; flex-direction: column; gap: 0.45rem; }

  .ref-file-name {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-bottom: 0.15rem;
    border-left: 2px solid var(--hairline);
    padding-left: 0.35rem;
  }

  .ref-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 4px;
    padding: 0.15rem 0.3rem;
    font-size: 0.75rem;
    color: var(--text);
  }
  button.ref-row { cursor: pointer; }
  button.ref-row:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .ref-row.static { opacity: 0.65; cursor: default; }

  .ref-line {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
    min-width: 2.5rem;
    flex-shrink: 0;
  }
  .ref-line.old-side { color: var(--diff-del); }

  .ref-snippet {
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- "In repo" section (Tier 2) ---- */
  .search-repo-btn {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 0.2rem 0.55rem;
    font-size: 0.72rem;
    color: var(--text);
    cursor: pointer;
  }
  .search-repo-btn:hover {
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
    border-color: color-mix(in srgb, var(--accent) 50%, var(--hairline));
  }

  .repo-status {
    margin: 0;
    font-style: italic;
    color: var(--text-muted);
  }

  .repo-error {
    margin: 0 0 0.35rem;
    color: var(--legend-removed-color);
  }

  .repo-footnote {
    margin: 0.4rem 0 0;
    font-size: 0.68rem;
    color: var(--text-muted);
  }

  .repo-tag {
    display: inline-block;
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 0 0.3rem;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    color: var(--text-muted);
    background: var(--surface);
  }

  .ref-file-name.repo-file {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .copy-repo-path {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0 0.15rem;
    font-size: 0.78rem;
    line-height: 1;
    border-radius: 3px;
  }
  .copy-repo-path:hover { color: var(--text); }
  .copy-done { font-size: 0.62rem; color: var(--legend-added-color); font-weight: 600; }
</style>
