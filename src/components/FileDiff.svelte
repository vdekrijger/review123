<script lang="ts">
  import { DiffView, DiffModeEnum, SplitSide } from '@git-diff-view/svelte'
  import { highlighter } from '@git-diff-view/lowlight'
  import '@git-diff-view/svelte/styles/diff-view.css'
  import { buildDiffFile, classifyFile } from '../lib/diff/diffFile'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode, FocusMode } from '../lib/settings/settings'
  import { type TestFileDisplay } from '../lib/settings/settings'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { langForFilename, classifyNoiseLines } from '../lib/diff/codeNoise'
  import { isGeneratedFile } from '../lib/diff/generated'
  import { isTestFile } from '../lib/testFile'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import DraftThread from './DraftThread.svelte'
  import ExistingThread from './ExistingThread.svelte'
  import SkillFindingCard from './SkillFindingCard.svelte'
  import { patchLineNumbers } from '../lib/diff/patchLines'
  import type { PrComment } from '../lib/github/comments'
  import { groupThreads, type CommentThread as Thread } from '../lib/github/commentThreads'
  import type { ReplyOutcome } from '../lib/github/replies'
  import type { AskFocus } from '../lib/ai/tasks'
  import type { WhitespaceDisplay } from '../lib/diff/whitespace'
  import { excerptAround } from '../lib/diff/excerpt'
  import { track } from '../lib/analytics/analytics'
  import SymbolPopover from './SymbolPopover.svelte'
  import { registerSymbolSource, unregisterSymbolSource, currentSymbolIndex } from '../lib/symbols/symbolSources'
  import { resolveClickedToken } from '../lib/symbols/clickToken'
  import { jumpToDiffLine } from '../lib/symbols/jumpToLine'
  import { currentRepoSearchContext, searchRepoForSymbol } from '../lib/symbols/repoSearch'
  import type { SymbolDefinition, SymbolReference, DiffSide } from '../lib/symbols/symbolIndex'

  /** A skill finding scoped to a specific line in this file */
  export interface SkillFinding {
    skillName: string
    line: number
    severity: 'high' | 'medium' | 'low'
    body: string
    key: string
    /** Cross-model verification (Plan M) — drives the "confirmed by N/M" chip. */
    verification?: import('../lib/ai/schemas').FindingVerification
    /** Multi-generator provenance (Plan O) — drives the "raised by A,B" chip. */
    raisedBy?: string[]
    /** Convergence: absorbed sibling findings ("also flagged as…" disclosure). */
    mergedFrom?: import('../lib/ai/schemas').AbsorbedFinding[]
    /** Convergence: ≤100-char shared-root-cause reason (tooltip). */
    mergedReason?: string
    /** Convergence: same point as the user's own draft → collapsed rendering. */
    coveredByDraft?: { path: string; line: number }
  }

  interface Props {
    file: PrFile
    mode: DiffMode
    /** Drafts that belong to this file */
    drafts?: Draft[]
    /** Existing PR comments for this file */
    comments?: PrComment[]
    /** Set of comment databaseIds that belong to resolved review threads */
    resolvedCommentIds?: Set<number>
    /**
     * Called when the user saves a comment at a given line. `n` identifies the
     * draft being EDITED in place (its store ordinal); omitted → this is a NEW
     * comment and the parent must APPEND it (multiple drafts can coexist at
     * one line — adding never overwrites an existing draft).
     */
    onAddDraft?: (line: number, side: 'LEFT' | 'RIGHT', body: string, n?: number) => void
    /**
     * Called when the user deletes a comment at a given line. `n` identifies
     * WHICH draft at the line to remove; omitted → the first draft at the line
     * (legacy single-draft behavior).
     */
    onRemoveDraft?: (line: number, side: 'LEFT' | 'RIGHT', n?: number) => void
    /** Whether this file has been marked viewed (hash-matched) */
    viewed?: boolean
    /** Whether the file changed since it was last viewed (entry exists, hash differs) */
    changedSinceViewed?: boolean
    /** Called when the user clicks the Viewed checkbox */
    onToggleViewed?: () => void
    /**
     * Full before/after file contents used to enable GitHub-style context
     * expansion between hunks. When omitted (or while still loading) the
     * diff renders hunk-only without expansion affordances.
     */
    contents?: { before: string | null; after: string | null }
    /**
     * Optional Ask AI function threaded from Review via InspectStep.
     * When provided, DraftThread shows a "Comment | Ask AI" tab toggle.
     */
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    /**
     * Optional disabled hint for Ask AI gating (e.g. "No API key configured.").
     */
    askDisabledReason?: string | null
    /**
     * Line-bearing skill findings for this file, rendered inside the annotation
     * area at their respective lines (not stacked above the file).
     */
    skillFindings?: SkillFinding[]
    /**
     * Called when the user clicks "Add as draft" on a skill finding inside FileDiff.
     */
    onAddSkillFindingDraft?: (finding: { body: string; line: number; key: string; skillName: string }) => Promise<void>
    /**
     * Called when the user DISMISSES a skill finding inside FileDiff (the accept
     * path flows through onAddSkillFindingDraft). Lets the parent record the
     * accept/dismiss telemetry. Receives only the finding's stable key.
     */
    onDismissSkillFinding?: (key: string) => void
    /**
     * Posts a reply to an existing comment thread IMMEDIATELY (not queued
     * with the review). null → no Reply affordance (provider unsupported).
     */
    onReply?: ((root: PrComment, body: string) => Promise<ReplyOutcome>) | null
    /**
     * Whitespace-hiding decision for this file (computed in InspectStep).
     * null/undefined = toggle off or not applicable → render the provider diff.
     * 'collapsed'    = whole change is whitespace-only → placeholder instead of diff.
     * 'recomputed'   = render the recomputed patch; line-comment widgets disabled
     *                  because displayed rows no longer match provider-side anchors.
     * 'unavailable'  = full contents missing → provider diff + honest note.
     */
    whitespace?: WhitespaceDisplay | null
    /**
     * Whether the file header sticks to the top of the viewport while the
     * file's diff is in view (so Viewed / collapse / path stay reachable on a
     * long file). Enabled in Files mode AND on Story mode's PRIMARY step diffs
     * (so the path + Viewed toggle stay reachable while scrolling a long story
     * step). Disabled on the Story "Related test" snippets, which are short. The
     * sticky top is `--topbar-h` in both modes: in Story mode the only sticky
     * element above the diff is the app topbar (the flow switch, diff-mode
     * toolbar, change map, step caption and Prev/Next nav all scroll away).
     */
    sticky?: boolean
    /**
     * Keep the diff body expanded regardless of viewed state. Story Mode uses
     * this for the slide's PRIMARY diff: the slideshow auto-marks a file viewed
     * for COVERAGE tracking the moment its slide is reached, which would
     * otherwise collapse the very diff being narrated (header-only, no body —
     * and therefore no syntax highlighting). The file still counts as viewed
     * (✓ in Files mode); only the collapse-on-view is suppressed. The user can
     * still manually un-view via the checkbox. Default false → Files-mode
     * collapse-on-view behaviour is unchanged.
     */
    forceExpanded?: boolean
    /**
     * The PR's CURRENT head sha. When a draft's own `headSha` differs (it was
     * made on an older commit), DraftThread shows a "from commit …" note so the
     * reviewer understands why a draft sits in the unanchored fallback block.
     */
    currentHeadSha?: string
  }

  let { file, mode, drafts = [], comments = [], resolvedCommentIds = new Set(), onAddDraft, onRemoveDraft, viewed = false, changedSinceViewed = false, onToggleViewed, contents, askFn = null, askDisabledReason = null, skillFindings = [], onAddSkillFindingDraft, onDismissSkillFinding, onReply = null, whitespace = null, sticky = true, forceExpanded = false, currentHeadSha = undefined }: Props = $props()

  // Test-file display (must be declared before collapsed)
  const testFileDisplay = $derived<TestFileDisplay>(settingsState.current.testFileDisplay)
  const isTest = $derived(isTestFile(file.filename))

  // ---- Focus mode (dim code noise) ----------------------------------------
  // Reactive: dims import lines ('imports') or imports + comments
  // ('imports-comments') by toggling a `dimmed-noise` class on each matching
  // diff row AFTER the third-party DiffView renders. Lines are never hidden or
  // collapsed — text stays selectable and comment-anchorable.
  const focusMode = $derived<FocusMode>(settingsState.current.focusMode)
  const noiseLang = $derived(langForFilename(file.filename))

  // A GENERATED file (lockfile, *.min.*, codegen output, snapshot, …) gets the
  // SAME focus-mode treatment as imports/comments — but for the WHOLE file: when
  // focus mode is on, every code line is dimmed (never hidden/collapsed). The
  // header also shows a `generated` chip so the file is labelled. Detection uses
  // the path plus loaded contents (the `@generated` marker) when available.
  const isGenerated = $derived(isGeneratedFile(file.filename, contents))

  /** True for a classified NoiseKind under the active focusMode. */
  function dimsKind(kind: ReturnType<typeof classifyNoiseLines>[number]): boolean {
    if (focusMode === 'off' || kind === null) return false
    if (kind === 'import') return true
    if (kind === 'comment') return focusMode === 'imports-comments'
    return false
  }

  /**
   * Read the raw source text of a single content cell WITHOUT the +/- diff
   * marker. The library renders the marker in a separate
   * `.diff-line-content-operator` span and the line text in
   * `.diff-line-content-raw` (plain) or `.diff-line-syntax-raw` (highlighted).
   * We read those so classification sees the source line, not `+ import …`.
   */
  function cellText(cell: Element): string {
    const raws = cell.querySelectorAll('.diff-line-content-raw, .diff-line-syntax-raw')
    if (raws.length === 0) return ''
    return [...raws].map((s) => s.textContent ?? '').join('')
  }

  /**
   * Read the SOURCE line numbers (old + new) for a content cell's row. Used to
   * detect contiguous runs vs collapsed-context / hunk-boundary gaps: within a
   * single hunk the source numbers increment by 1 row-to-row; across a hunk
   * header or a collapsed (expandable) region they JUMP. That jump is exactly
   * where a multi-line import span must reset (its closing delimiter may live in
   * the hidden gap), so it cannot leak its dimming onto the next hunk's code.
   *
   * The @git-diff-view DOM exposes them per row:
   *  - unified:  spans `[data-line-old-num]` / `[data-line-new-num]` (a deletion
   *              row carries only old, an addition row only new, context both).
   *  - split:    the sibling num cell carries a single `[data-line-num]`; we read
   *              it as the side matching this content column (old-content → old,
   *              new-content → new), so each column is independently monotonic.
   * Returns 0 for an absent side. `data-line` (the rendered index) is NOT used:
   * it re-indexes contiguously across hunk gaps, so it cannot see the boundary.
   */
  function cellRowNums(cell: Element): { old: number; new: number } {
    const row = cell.closest('tr')
    if (!row) return { old: 0, new: 0 }
    const parse = (raw: string | null | undefined): number => {
      if (raw == null) return 0
      const n = parseInt(raw.trim(), 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    if (cell.classList.contains('diff-line-old-content')) {
      const v = parse(row.querySelector('td.diff-line-old-num [data-line-num]')?.getAttribute('data-line-num'))
      return { old: v, new: 0 }
    }
    if (cell.classList.contains('diff-line-new-content')) {
      const v = parse(row.querySelector('td.diff-line-new-num [data-line-num]')?.getAttribute('data-line-num'))
      return { old: 0, new: v }
    }
    // Unified single column: both sides may be present.
    return {
      old: parse(row.querySelector('[data-line-old-num]')?.getAttribute('data-line-old-num')),
      new: parse(row.querySelector('[data-line-new-num]')?.getAttribute('data-line-new-num')),
    }
  }

  /**
   * Decorate a single COLUMN of content cells. Cells are collected in document
   * order, their source text run through the SPAN-AWARE classifier (so a
   * multi-line import dims its continuation + closing lines, not just the
   * opener), then each cell toggled accordingly.
   *
   * Why per-column: span detection needs the lines IN SEQUENCE. In split mode
   * the old (LEFT) and new (RIGHT) sides are independent sequences — classifying
   * them together would let a span on one side leak onto the other. We therefore
   * decorate each side's column separately. Unified has a single column.
   */
  function decorateColumn(cells: Element[]): void {
    // Generated file: dim EVERY non-empty line (the whole file is noise). This
    // is language-agnostic — generated files (lockfiles, *.map, …) often have no
    // recognised code language, so we can't rely on classifyNoiseLines here.
    if (isGenerated) {
      for (const cell of cells) {
        cell.classList.toggle('dimmed-noise', cellText(cell).trim() !== '')
      }
      return
    }
    // Boundary detection (the import-span runaway fix). querySelectorAll
    // collects content cells across ALL hunks into one flat array, but those
    // rows are NOT a contiguous slice of the source file: collapsed-context
    // regions and hunk boundaries omit lines. Feeding them to the span-aware
    // classifier as one sequence lets a multi-line import whose closing
    // delimiter sits in a hidden gap leak its 'import' span onto a LATER hunk's
    // real code. We therefore mark every index where this column's source line
    // number is NOT exactly one past the previous rendered row (a gap, a reset,
    // or an unreadable number) as a BOUNDARY, and the classifier resets any open
    // span there. Within a contiguous run, balance is meaningful and multi-line
    // imports still fully dim.
    // Detect hunk / collapsed-context gaps via the source numbers. Within one
    // hunk the rendered rows advance one source line at a time, but a deletion
    // reports only an OLD number and an addition only a NEW one (context reports
    // both). So we CARRY FORWARD the last-seen old and new and flag a boundary
    // only when a row's reported side SKIPS AHEAD past carried+1 — that skip is a
    // collapsed region or a new hunk. A del→add pair (old 2 / new 2 in the same
    // hunk) is NOT a boundary: neither carried side skips. The first row never
    // is. Rows with no readable number start a fresh run (carried stays 0 → a
    // later real number > 1 is treated as a skip only if carried was set).
    const boundaries = new Set<number>()
    let carryOld = 0
    let carryNew = 0
    for (let i = 0; i < cells.length; i++) {
      const cur = cellRowNums(cells[i])
      if (i > 0) {
        const oldSkips = carryOld > 0 && cur.old > 0 && cur.old > carryOld + 1
        const newSkips = carryNew > 0 && cur.new > 0 && cur.new > carryNew + 1
        if (oldSkips || newSkips) boundaries.add(i)
      }
      if (cur.old > 0) carryOld = cur.old
      if (cur.new > 0) carryNew = cur.new
    }
    const kinds = classifyNoiseLines(cells.map(cellText), noiseLang, boundaries)
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('dimmed-noise', dimsKind(kinds[i]))
    }
  }

  /**
   * Decorate the diff. Unified rows expose one content column
   * (`.diff-line-content`); split rows expose two (`.diff-line-old-content`,
   * `.diff-line-new-content`). Each column is a top-to-bottom sequence handed to
   * the span-aware classifier.
   */
  function decorateRows(root: HTMLElement): void {
    // Nothing to dim when focus is off, or for a non-generated file with no
    // recognised language. Generated files dim regardless of language.
    if (focusMode === 'off' || (noiseLang === null && !isGenerated)) {
      for (const cell of root.querySelectorAll('.dimmed-noise')) {
        cell.classList.remove('dimmed-noise')
      }
      return
    }
    decorateColumn([...root.querySelectorAll('.diff-line-content')])
    decorateColumn([...root.querySelectorAll('.diff-line-old-content')])
    decorateColumn([...root.querySelectorAll('.diff-line-new-content')])
  }

  /**
   * Svelte action: keep the diff rows decorated as focus mode / diff content
   * change. Re-runs on the reactive `_` arg (a tuple of focusMode + filename +
   * mode) and observes library re-renders (highlight load, context expansion)
   * via a MutationObserver so newly inserted rows get decorated too.
   */
  function focusDim(node: HTMLElement, _: unknown) {
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => decorateRows(node))
    }
    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(node, { childList: true, subtree: true })
    return {
      update() {
        schedule()
      },
      destroy() {
        cancelAnimationFrame(raf)
        mo.disconnect()
      },
    }
  }

  // ---- Diff view theme ----------------------------------------------------
  // The library scopes its syntax-highlight token colors (hljs-*) and diff row
  // backgrounds by a data-theme attribute on its own wrapper, driven by the
  // diffViewTheme prop. Resolve the app theme setting ('auto' via matchMedia)
  // reactively so the diff restyles live when the user flips the theme.
  let prefersDark = $state(
    typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false),
  )
  $effect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq?.addEventListener) return
    prefersDark = mq.matches
    const onChange = (e: MediaQueryListEvent) => {
      prefersDark = e.matches
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  })
  const diffTheme = $derived.by((): 'light' | 'dark' => {
    const t = settingsState.current.theme
    if (t === 'dark' || t === 'light') return t
    return prefersDark ? 'dark' : 'light'
  })

  // @git-diff-view skips syntax highlighting once a file's raw length exceeds
  // `maxLineToIgnoreSyntax` (default 2000). Because we feed it the FULL file
  // contents (to enable GitHub-style context expansion), large source files —
  // e.g. a 2000+ line Django module — blew past it and rendered UNHIGHLIGHTED.
  // Pass the bundled lowlight highlighter with a much higher threshold so real
  // source files always highlight; the engine + per-language support are reused
  // unchanged (only the size guard is raised).
  const highlighterNoSizeCap = { ...highlighter, maxLineToIgnoreSyntax: 200_000 }

  // When viewed → collapse diff body; user can re-expand by clicking header or unchecking
  // dim mode reduces opacity only — it does NOT collapse the file
  let manuallyExpanded = $state(false)
  // True once the USER ticks the Viewed checkbox in THIS session (vs. an
  // auto/external mark from the parent). In Story Mode the slideshow auto-marks
  // the narrated file viewed for coverage tracking; that must NOT collapse the
  // diff being narrated (forceExpanded keeps it open). But a DELIBERATE user tick
  // should still collapse even under forceExpanded — this flag distinguishes the
  // two so a manual view collapses while the auto/narrated view stays expanded.
  let userMarkedViewed = $state(false)
  // forceExpanded (Story Mode primary diff) keeps the narrated diff body — and its
  // syntax highlighting — expanded BY DEFAULT, but a manual user view (the checkbox)
  // overrides it and collapses. In Files mode forceExpanded is false, so this is
  // byte-identical to `viewed && !manuallyExpanded`.
  const collapsed = $derived(viewed && !manuallyExpanded && (!forceExpanded || userMarkedViewed))

  // A viewed file in Files mode (not Story's forceExpanded) can be collapsed AND
  // re-expanded by clicking its header — the click toggles both ways. Story mode
  // owns expansion of the narrated diff, so we don't hijack its header clicks.
  const canToggleCollapse = $derived(viewed && !forceExpanded)

  function handleHeaderClick() {
    if (collapsed) {
      manuallyExpanded = true
      // viewed-collapsed is the only collapse origin that also hides the diff body
      track('file_expanded', { origin: 'viewed' })
    } else if (canToggleCollapse) {
      // Expanded-after-viewing → clicking the header re-collapses it (previously
      // a one-way toggle left a viewed file stuck open with no way back).
      manuallyExpanded = false
    }
  }

  function handleViewedChange(e: Event) {
    const checked = (e.target as HTMLInputElement).checked
    // Check → record a DELIBERATE user view so it collapses even under
    // forceExpanded (Story Mode). Uncheck → expand + notify parent.
    if (checked) userMarkedViewed = true
    else manuallyExpanded = true
    onToggleViewed?.()
  }

  // Reset manual expansion + the user-mark flag when viewed clears (e.g. unchecked,
  // or re-toggled from outside) so a later view starts from the default state.
  $effect(() => {
    if (!viewed) {
      manuallyExpanded = false
      userMarkedViewed = false
    }
  })

  const filename = $derived(
    file.previousFilename ? `${file.previousFilename} → ${file.filename}` : file.filename
  )

  const kind = $derived(classifyFile(file))

  // Whitespace-hiding display state for this file
  const wsCollapsed = $derived(kind === 'diff' && whitespace?.kind === 'collapsed')
  const wsActive = $derived(kind === 'diff' && whitespace?.kind === 'recomputed')
  const wsUnavailable = $derived(kind === 'diff' && whitespace?.kind === 'unavailable')

  const diffFile = $derived(
    kind === 'diff' && !wsCollapsed
      ? buildDiffFile(file, mode, contents, whitespace?.kind === 'recomputed' ? whitespace.patch : undefined)
      : null,
  )

  // Copy-path state
  let copyDone = $state(false)
  async function copyPath() {
    await navigator.clipboard.writeText(file.filename)
    copyDone = true
    setTimeout(() => { copyDone = false }, 1500)
  }

  // ---- Widget state -------------------------------------------------------
  // Only one widget open at a time. Cleared after save or cancel.
  let openWidget: { line: number; side: SplitSide } | null = $state(null)

  function handleAddWidgetClick(lineNumber: number, side: SplitSide) {
    // Toggle: clicking the same line again closes the widget
    if (openWidget && openWidget.line === lineNumber && openWidget.side === side) {
      openWidget = null
      composerAt = null
    } else {
      openWidget = { line: lineNumber, side }
      // The "+" gutter click means "add a comment HERE": when the line already
      // has draft(s), open the new-comment composer below the stack right away
      // (on an empty line the stack snippet shows the composer regardless).
      composerAt = `${lineNumber}|${splitSideToSide(side)}`
    }
  }

  function splitSideToSide(side: SplitSide): 'LEFT' | 'RIGHT' {
    return side === SplitSide.old ? 'LEFT' : 'RIGHT'
  }

  function sideToSplitSide(side: 'LEFT' | 'RIGHT'): SplitSide {
    return side === 'LEFT' ? SplitSide.old : SplitSide.new
  }

  // ---- Skill findings (line-anchored) state -------------------------------

  // Session-only dismissed finding keys within this FileDiff instance
  let dismissedSkillKeys = $state<Set<string>>(new Set())
  // Session-only "added as draft" state keys (persist for the session — state chip)
  let addedSkillKeys = $state<Set<string>>(new Set())

  // Retry (#108) re-runs a reviewer → a fresh `skillFindings` array arrives from
  // the parent. Without clearing the local suppression, a re-surfaced finding
  // that shares a key with a previously DISMISSED (or added-as-draft) one stays
  // hidden — the user "restarts a reviewer and its findings never appear".
  //
  // The distinguishing signal for a fresh run (vs the parent merely re-deriving
  // the same findings array) is a key transitioning ABSENT → PRESENT: a dismissed
  // finding leaves the set when dismissed at the source / on error, then a retry
  // re-introduces it. On that transition we un-suppress the re-emitted key so the
  // fresh finding shows; an in-session dismiss (key stays present) is untouched.
  let prevSkillKeys = new Set<string>()
  $effect(() => {
    const incomingKeys = new Set(skillFindings.map(f => f.key))
    const reEmerged = [...incomingKeys].filter(k => !prevSkillKeys.has(k))
    prevSkillKeys = incomingKeys
    if (reEmerged.length === 0) return
    // A reviewer re-emitted these keys → clear any stale per-key suppression for
    // EXACTLY those keys so the fresh findings render (and reset their "added as
    // draft" state chip). Other suppressed keys are left untouched.
    const reEmergedSet = new Set(reEmerged)
    if (reEmerged.some(k => dismissedSkillKeys.has(k))) {
      dismissedSkillKeys = new Set([...dismissedSkillKeys].filter(k => !reEmergedSet.has(k)))
    }
    if (reEmerged.some(k => addedSkillKeys.has(k))) {
      addedSkillKeys = new Set([...addedSkillKeys].filter(k => !reEmergedSet.has(k)))
    }
  })

  function dismissSkillFinding(key: string) {
    dismissedSkillKeys = new Set([...dismissedSkillKeys, key])
    onDismissSkillFinding?.(key)
  }

  async function handleAddSkillFindingDraft(finding: SkillFinding) {
    if (onAddSkillFindingDraft) {
      await onAddSkillFindingDraft({ body: finding.body, line: finding.line, key: finding.key, skillName: finding.skillName })
    }
    addedSkillKeys = new Set([...addedSkillKeys, finding.key])
  }

  // Visible (non-dismissed) skill findings
  const visibleSkillFindings = $derived(skillFindings.filter(f => !dismissedSkillKeys.has(f.key)))

  // ---- Anchor resolvability -----------------------------------------------
  // A line anchor (draft or finding) is resolvable when its line number is
  // present in the patch hunks for its side. Resolvable anchors render INLINE
  // at the line via extendData; unresolvable ones fall back to the per-file
  // annotation blocks below the diff. Never both.
  const leftAnchorLines = $derived(patchLineNumbers(file.patch, 'LEFT'))
  const rightAnchorLines = $derived(patchLineNumbers(file.patch, 'RIGHT'))

  function isAnchoredDraft(d: Draft): boolean {
    return d.side === 'LEFT' ? leftAnchorLines.has(d.line) : rightAnchorLines.has(d.line)
  }

  // ---- Existing comments: thread grouping + anchorability split ------------
  // Threads group a root comment with its replies (GitHub in_reply_to_id
  // chains / GitLab discussions). A thread is ANCHORED when its root line is
  // present in the patch hunks — anchored threads render INLINE at their line
  // (via extendData); only file-level / unanchorable threads go to the
  // bottom-of-file list. Same dedupe rule as drafts: never both.
  const threads = $derived(groupThreads(comments))

  function isAnchoredThread(t: Thread): boolean {
    const { line, side } = t.root
    if (line === null || side === null) return false
    return side === 'LEFT' ? leftAnchorLines.has(line) : rightAnchorLines.has(line)
  }

  const anchoredThreads = $derived(threads.filter(isAnchoredThread))
  const unanchoredThreads = $derived(threads.filter((t) => !isAnchoredThread(t)))

  /** Whether a thread is resolved (root comment id in resolvedCommentIds) */
  function isThreadResolved(thread: Thread): boolean {
    return resolvedCommentIds.has(thread.root.id)
  }

  // Bottom list: unanchorable threads grouped by line (null = "General", last)
  const unanchoredThreadsByLine = $derived.by(() => {
    const map = new Map<number | null, Thread[]>()
    for (const t of unanchoredThreads) {
      const key = t.root.line
      const arr = map.get(key) ?? []
      arr.push(t)
      map.set(key, arr)
    }
    return map
  })

  // Ordered line keys (non-null first, sorted numerically; null last)
  const lineKeys = $derived.by(() => {
    const keys = [...unanchoredThreadsByLine.keys()]
    const nonNull = (keys.filter((k) => k !== null) as number[]).sort((a, b) => a - b)
    const hasNull = keys.includes(null)
    return hasNull ? ([...nonNull, null] as (number | null)[]) : nonNull
  })

  function commentCountAt(lineKey: number | null): number {
    const group = unanchoredThreadsByLine.get(lineKey) ?? []
    return group.reduce((n, t) => n + 1 + t.replies.length, 0)
  }

  // ---- extendData — per-line annotation entries (drafts + skill findings) --
  // NOTE: @git-diff-view's unified-mode DiffUnifiedExtendLine shipped with an
  // inverted isHidden condition (extend rows only rendered for collapsed
  // lines). We patch the package (patches/@git-diff-view__svelte.patch) so
  // extendData renders inline at visible lines in BOTH unified and split
  // modes — the same path drafts already used in split mode.
  interface ExtendEntry {
    /** ALL drafts at this line, sorted by ordinal n (multiple can coexist). */
    drafts: Draft[]
    findings: SkillFinding[]
    threads: Thread[]
  }

  const extendData = $derived.by(() => {
    const oldFile: Record<string, { data: ExtendEntry }> = {}
    const newFile: Record<string, { data: ExtendEntry }> = {}
    const entryAt = (map: Record<string, { data: ExtendEntry }>, line: number): ExtendEntry => {
      const key = String(line)
      if (!map[key]) map[key] = { data: { drafts: [], findings: [], threads: [] } }
      return map[key].data
    }
    for (const d of drafts) {
      if (!isAnchoredDraft(d)) continue
      // While the add/edit widget is open at this line, the widget shows the
      // draft stack — suppress the extend entry so drafts never render twice.
      if (openWidget && openWidget.line === d.line && splitSideToSide(openWidget.side) === d.side) continue
      if (d.side === 'LEFT') {
        entryAt(oldFile, d.line).drafts.push(d)
      } else {
        entryAt(newFile, d.line).drafts.push(d)
      }
    }
    // Stack order within a line: by ordinal n ascending (comment thread order)
    for (const map of [oldFile, newFile]) {
      for (const key of Object.keys(map)) {
        map[key].data.drafts.sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
      }
    }
    for (const f of visibleSkillFindings) {
      // Findings anchor to the new (RIGHT) side of the diff
      if (!rightAnchorLines.has(f.line)) continue
      entryAt(newFile, f.line).findings.push(f)
    }
    for (const t of anchoredThreads) {
      const map = t.root.side === 'LEFT' ? oldFile : newFile
      entryAt(map, t.root.line!).threads.push(t)
    }
    return { oldFile, newFile }
  })

  // Drafts whose anchor is NOT in the current diff — fallback block below the diff
  const unanchoredDrafts = $derived(drafts.filter((d) => !isAnchoredDraft(d)))

  // ---- Flash-highlight state for newly saved annotation entries (Fix-B) ----
  // Set of "line|side" strings that should flash after widget save
  let flashKeys = $state<Set<string>>(new Set())

  function addFlash(line: number, side: 'LEFT' | 'RIGHT') {
    const key = `${line}|${side}`
    flashKeys = new Set([...flashKeys, key])
    // Remove flash class after animation completes (1.5s)
    setTimeout(() => {
      flashKeys = new Set([...flashKeys].filter(k => k !== key))
    }, 1600)
  }

  // ---- Helpers for DraftThread handlers ----------------------------------

  // The one open "add another comment" composer, keyed `${line}|${side}`.
  // Shared by the widget row and the extend row (only one composer at a time —
  // same invariant as openWidget). null = no composer open.
  let composerAt = $state<string | null>(null)

  /** All drafts at a line/side, sorted by ordinal n (thread order). */
  function draftsAtLine(line: number, side: 'LEFT' | 'RIGHT'): Draft[] {
    return drafts
      .filter((d) => d.line === line && d.side === side)
      .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
  }

  /**
   * Save a draft at a line. `n` = the ordinal of the draft being EDITED in
   * place; undefined = a NEW comment → the parent APPENDS it (never overwrites
   * an existing draft at the line).
   */
  function handleExtendSave(line: number, side: SplitSide, body: string, n?: number) {
    const sideStr = splitSideToSide(side)
    onAddDraft?.(line, sideStr, body, n)
  }

  /** Delete the draft with ordinal `n` at a line (undefined = first draft). */
  function handleExtendDelete(line: number, side: SplitSide, n?: number) {
    const sideStr = splitSideToSide(side)
    onRemoveDraft?.(line, sideStr, n)
  }

  // Skill findings whose anchor is NOT in the current diff — fallback block
  const unanchoredSkillFindings = $derived(visibleSkillFindings.filter(f => !rightAnchorLines.has(f.line)))

  // ---- Symbol click-through (Tier 1) ---------------------------------------
  // Each mounted FileDiff registers its file's text (patch + full contents
  // when fetched) into the shared symbol-source registry, so clicking an
  // identifier ANYWHERE in the review can resolve definitions/references
  // across all rendered PR files. Re-runs when contents arrive (refresh);
  // unregisters on unmount. See src/lib/symbols/symbolSources.ts.
  $effect(() => {
    registerSymbolSource({ filename: file.filename, status: file.status, patch: file.patch, contents: contents ?? null })
    return () => unregisterSymbolSource(file.filename)
  })

  interface SymbolPopoverState {
    symbol: string
    definitions: SymbolDefinition[]
    references: SymbolReference[]
    x: number
    y: number
  }
  let symbolPopover = $state<SymbolPopoverState | null>(null)

  /**
   * Delegated click handler on the diff container. A PLAIN click opens the
   * symbol popover — chosen over modified-click because the selection guard
   * below keeps it from fighting text selection: a click that ends a drag
   * leaves a non-collapsed selection and is ignored.
   */
  function handleDiffClick(e: MouseEvent) {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    if (e.defaultPrevented) return
    const token = resolveClickedToken(e.target, e.clientX, e.clientY)
    if (!token) return
    const index = currentSymbolIndex()
    if (!index.has(token)) return
    const definitions = index.definitionsOf(token)
    const references = index.referencesOf(token)
    symbolPopover = { symbol: token, definitions, references, x: e.clientX, y: e.clientY }
    track('symbol_popover_opened', { definitions: definitions.length, references: references.length })
  }

  function handleSymbolJump(path: string, line: number, side: DiffSide) {
    jumpToDiffLine(path, line, side)
  }

  // Tier 2 repo search context: provider + owner/repo come from the router's
  // review route (no prop threading needed), head SHA from the existing
  // currentHeadSha prop. null (demo route, no head SHA, or a provider without
  // code search — GitLab/Bitbucket today) → the popover omits the action.
  const repoSearchCtx = $derived(currentRepoSearchContext(currentHeadSha))
</script>

<article class="file-diff" class:is-collapsed={collapsed} class:test-dim={isTest && testFileDisplay === 'dim'} class:test-highlight={isTest && testFileDisplay === 'highlight'}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <header onclick={handleHeaderClick} class:clickable={collapsed || canToggleCollapse} class:sticky-header={sticky} class:test-highlight={isTest && testFileDisplay === 'highlight'}>
    <code>{filename}</code>
    <div class="header-right">
      {#if changedSinceViewed}
        <span class="changed-badge" role="status">Changed since you viewed it</span>
      {/if}
      <button class="copy-path-btn" aria-label="Copy file path" onclick={(e) => { e.stopPropagation(); copyPath() }}>
        {#if copyDone}<span class="copy-done">Copied</span>{:else}<span class="copy-icon" aria-hidden="true">⎘</span>{/if}
      </button>
      <span class="stats">
        <span class="stat-add">+{file.additions}</span>
        <span class="stat-del"> −{file.deletions}</span>
      </span>
      {#if isTest && testFileDisplay !== 'normal'}
        <span class="test-chip chip">test</span>
      {/if}
      {#if isGenerated}
        <span class="generated-chip chip">generated</span>
      {/if}
      <label class="viewed-label">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span onclick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            class="viewed-checkbox"
            checked={viewed}
            aria-label="Mark {file.filename} as viewed"
            onchange={handleViewedChange}
          />
        </span>
        Viewed
      </label>
    </div>
  </header>
  {#if !collapsed}
  {#if kind === 'rename-only'}
    <p class="note">Rename only — no content changes.</p>
  {:else if wsCollapsed}
    <p class="note ws-collapsed-note" role="status">No changes when hiding whitespace.</p>
  {:else if kind === 'binary-or-too-large' || !diffFile}
    <p class="note">Binary or too large to display.</p>
  {:else}
    {#if wsUnavailable}
      <p class="ws-inline-note" role="note">Whitespace hiding isn't available for this file — showing the full diff.</p>
    {:else if wsActive}
      <p class="ws-inline-note" role="note">Line comments are disabled while whitespace changes are hidden — turn off "Hide whitespace" to comment on exact lines.</p>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="focus-dim-host"
      data-focus-mode={focusMode}
      use:focusDim={[focusMode, file.filename, mode, isGenerated]}
      onclick={handleDiffClick}
    >
    <!-- Shared stack: EVERY draft at the line (ordered by n) as its own
         DraftThread — each independently editable/removable — followed by the
         new-comment composer (or the "Add another comment" affordance).
         `widgetClose` is non-null when rendering inside the widget row: it
         closes the widget when the LAST draft is deleted or when composing
         the FIRST comment is cancelled (the pre-existing single-draft UX).
         Declared OUTSIDE <DiffView> so it stays a lexical snippet (declaring
         it inside the tag would pass it to DiffView as an unknown prop). -->
    {#snippet draftStack(lineNumber: number, side: SplitSide, widgetClose: (() => void) | null)}
      {@const sideStr = splitSideToSide(side)}
      {@const lineDrafts = draftsAtLine(lineNumber, sideStr)}
      {@const composerKey = `${lineNumber}|${sideStr}`}
      {@const composing = lineDrafts.length === 0 || composerAt === composerKey}
      {@const lineExcerpt = file.patch ? excerptAround(file.patch, lineNumber, sideStr, 6) : ''}
      {#each lineDrafts as draft (draft.n ?? 0)}
        <DraftThread
          {draft}
          path={file.filename}
          line={lineNumber}
          side={sideStr}
          onsave={(body) => handleExtendSave(lineNumber, side, body, draft.n ?? 0)}
          ondelete={() => {
            handleExtendDelete(lineNumber, side, draft.n ?? 0)
            // Deleting the LAST draft closes the widget (single-draft UX);
            // with siblings left, the stack stays open.
            if (widgetClose && lineDrafts.length === 1) widgetClose()
          }}
          oncancel={() => {}}
          {askFn}
          {askDisabledReason}
          {currentHeadSha}
          excerpt={lineExcerpt}
        />
      {/each}
      {#if composing}
        <DraftThread
          draft={null}
          path={file.filename}
          line={lineNumber}
          side={sideStr}
          onsave={(body) => {
            // NEW comment → append (never overwrites an existing draft)
            handleExtendSave(lineNumber, side, body)
            composerAt = null
            addFlash(lineNumber, sideStr)
          }}
          ondelete={() => {}}
          oncancel={() => {
            composerAt = null
            // Cancelling the FIRST comment on the line closes the widget
            if (widgetClose && lineDrafts.length === 0) widgetClose()
          }}
          {askFn}
          {askDisabledReason}
          excerpt={lineExcerpt}
        />
      {:else if !wsActive}
        <button
          type="button"
          class="add-another-comment"
          data-testid="add-another-comment"
          onclick={() => (composerAt = composerKey)}
        >+ Add another comment</button>
      {/if}
    {/snippet}

    <DiffView
      {diffFile}
      diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight={true}
      registerHighlighter={highlighterNoSizeCap}
      diffViewTheme={diffTheme}
      diffViewWrap={true}
      diffViewAddWidget={!wsActive}
      {extendData}
      onAddWidgetClick={handleAddWidgetClick}
    >
      {#snippet renderWidgetLine({ lineNumber, side, onClose })}
        <!-- Fix-B: saving does NOT close the widget — the saved draft stack
             stays visible in read view (onClose only fires on explicit
             cancel-with-no-drafts or deleting the last draft). -->
        <div class="draft-annotations inline-annotation" data-testid="widget-annotations" data-line={lineNumber}>
          {@render draftStack(lineNumber, side, () => {
            onClose()
            openWidget = null
            composerAt = null
          })}
        </div>
      {/snippet}

      {#snippet renderExtendLine({ lineNumber, side, data })}
        {@const entry = data as ExtendEntry}
        {#if entry?.drafts?.length}
          {@const flashKey = `${lineNumber}|${splitSideToSide(side)}`}
          <div class="draft-annotations inline-annotation" data-testid="inline-annotations" data-line={lineNumber} class:flash={flashKeys.has(flashKey)} aria-label="Draft comments at line {lineNumber}">
            {@render draftStack(lineNumber, side, null)}
          </div>
        {/if}
        {#if entry?.findings?.length}
          <div class="line-findings" data-line-findings={lineNumber} aria-label="Reviewer findings at line {lineNumber}">
            {#each entry.findings as finding (finding.key)}
              <SkillFindingCard
                skillName={finding.skillName}
                severity={finding.severity}
                body={finding.body}
                verification={finding.verification}
                raisedBy={finding.raisedBy}
                mergedFrom={finding.mergedFrom}
                mergedReason={finding.mergedReason}
                coveredByDraft={finding.coveredByDraft}
                line={finding.line}
                anchored={true}
                compact={true}
                findingKey={finding.key}
                added={addedSkillKeys.has(finding.key)}
                onAdd={() => handleAddSkillFindingDraft(finding)}
                onDismiss={() => dismissSkillFinding(finding.key)}
                {askFn}
                askPath={file.filename}
                askExcerpt={file.patch ? excerptAround(file.patch, finding.line, splitSideToSide(side), 6) : ''}
              />
            {/each}
          </div>
        {/if}
        {#if entry?.threads?.length}
          <div class="inline-comment-threads" data-testid="inline-annotations" data-line={lineNumber} aria-label="Existing comment threads at line {lineNumber}">
            {#each entry.threads as thread (thread.root.id)}
              <ExistingThread {thread} resolved={isThreadResolved(thread)} {onReply} />
            {/each}
          </div>
        {/if}
      {/snippet}
    </DiffView>
    </div>

    <!-- Symbol click-through popover (Tier 1): definition + call points for
         the clicked identifier. Cross-file jumps ride the shared
         #file-<slug> scroll mechanism (jumpToDiffLine), so no InspectStep
         wiring is needed. -->
    {#if symbolPopover}
      <!-- The optional chains are NOT redundant: closing the popover nulls
           `symbolPopover` and these @const deriveds re-evaluate during the
           SAME flush that tears the branch down — a bare `.symbol` there
           throws mid-flush and strands the popover DOM. -->
      {@const sym = symbolPopover?.symbol ?? ''}
      {@const spDefs = symbolPopover?.definitions ?? []}
      {@const spRefs = symbolPopover?.references ?? []}
      {@const spX = symbolPopover?.x ?? 0}
      {@const spY = symbolPopover?.y ?? 0}
      {@const searchCtx = repoSearchCtx}
      <SymbolPopover
        symbol={sym}
        definitions={spDefs}
        references={spRefs}
        x={spX}
        y={spY}
        currentFile={file.filename}
        onJump={handleSymbolJump}
        onClose={() => (symbolPopover = null)}
        onSearchRepo={searchCtx && sym ? () => searchRepoForSymbol(sym, searchCtx) : null}
      />
    {/if}

    <!-- Fallback draft annotations: ONLY drafts whose line anchor is not present
         in the current diff. Anchored drafts render inline at their line via
         extendData (see renderExtendLine above). -->
    {#if unanchoredDrafts.length > 0}
      <div class="draft-annotations" aria-label="Draft comments on this file">
        {#each unanchoredDrafts as draft (draft.line + '|' + draft.side + '|' + (draft.n ?? 0))}
          {@const flashKey = `${draft.line}|${draft.side}`}
          <div class="annotation-entry" class:flash={flashKeys.has(flashKey)}>
            <DraftThread
              {draft}
              path={file.filename}
              line={draft.line}
              side={draft.side}
              onsave={(body) => handleExtendSave(draft.line, sideToSplitSide(draft.side), body, draft.n ?? 0)}
              ondelete={() => handleExtendDelete(draft.line, sideToSplitSide(draft.side), draft.n ?? 0)}
              oncancel={() => {}}
              {askFn}
              {askDisabledReason}
              {currentHeadSha}
              excerpt={file.patch ? excerptAround(file.patch, draft.line, draft.side, 6) : ''}
            />
          </div>
        {/each}
      </div>
    {/if}

    <!-- Fallback findings block: ONLY findings whose line anchor is not present
         in the current diff. Anchored findings render inline at their line. -->
    {#if unanchoredSkillFindings.length > 0}
      <div class="skill-findings-annotations" aria-label="Skill review findings for this file">
        {#each unanchoredSkillFindings as finding (finding.key)}
          <SkillFindingCard
            skillName={finding.skillName}
            severity={finding.severity}
            body={finding.body}
            verification={finding.verification}
            raisedBy={finding.raisedBy}
            mergedFrom={finding.mergedFrom}
            mergedReason={finding.mergedReason}
            coveredByDraft={finding.coveredByDraft}
            line={finding.line}
            anchored={false}
            findingKey={finding.key}
            added={addedSkillKeys.has(finding.key)}
            onAdd={() => handleAddSkillFindingDraft(finding)}
            onDismiss={() => dismissSkillFinding(finding.key)}
          />
        {/each}
      </div>
    {/if}

    <!-- Bottom-of-file existing comments: ONLY file-level / unanchorable
         threads (root line null or not present in the patch hunks).
         Anchored threads render inline at their line via extendData. -->
    {#if unanchoredThreads.length > 0}
      <div class="existing-comments" aria-label="Existing review comments">
        {#each lineKeys as lineKey (lineKey)}
          {@const group = unanchoredThreadsByLine.get(lineKey)!}
          {@const count = commentCountAt(lineKey)}
          <div class="existing-line-group">
            <div class="existing-line-label">
              {lineKey !== null ? `Line ${lineKey}` : 'General'} — {count} comment{count === 1 ? '' : 's'}
            </div>
            {#each group as thread (thread.root.id)}
              <ExistingThread {thread} resolved={isThreadResolved(thread)} {onReply} />
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
  {/if}
</article>

<style>
  /* NOTE: no `overflow: hidden` here — it would clip the sticky header and
     defeat position: sticky. The rounded corners are preserved by clipping the
     header's top corners and the last child's bottom corners instead. */
  .file-diff { border: 1px solid var(--hairline); border-radius: 6px; margin-bottom: 1rem; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.8rem; background: var(--surface-raised); border-radius: 6px 6px 0 0; }
  /* Collapsed: header is the only visible child → round all four corners. */
  .is-collapsed header { border-radius: 6px; }

  /*
   * Sticky file header (Files mode). While a long file's diff is on screen the
   * header pins below the app topbar so the path, ± counts, copy-path, the
   * Viewed toggle and the collapse control stay reachable without scrolling
   * back up. Each FileDiff is its own sticky context, so the next file's header
   * pushes the current one up — standard per-section sticky-header behaviour.
   *
   * top:  sits directly below the app topbar (the only element sticky above the
   *       diff — the Unified/Side-by-side + hide-whitespace toolbar scrolls away).
   * z-index 5: above the diff rows, below the file-tree drawer/tab (20/21) and
   *       the topbar (200) and any modal. Background is the opaque surface token
   *       so diff rows never show through behind the pinned header.
   */
  header.sticky-header {
    position: sticky;
    top: var(--topbar-h, 2.75rem);
    z-index: 5;
  }
  header code { font-family: var(--font-mono); font-size: 0.8125rem; }
  header.clickable { cursor: pointer; }
  header.clickable:hover { background: color-mix(in srgb, var(--hairline) 30%, var(--surface-raised)); }
  .header-right { display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; }
  .note { padding: 0.8rem; opacity: 0.7; }
  .ws-collapsed-note { font-style: italic; }
  .ws-inline-note {
    margin: 0;
    padding: 0.3rem 0.8rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    background: var(--surface-raised);
    border-bottom: 1px solid var(--hairline);
  }
  .viewed-label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.8rem;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .viewed-checkbox { cursor: pointer; }
  .changed-badge {
    font-size: 0.75rem;
    padding: 0.15rem 0.4rem;
    border-radius: 3px;
    background: var(--legend-changed-bg);
    color: var(--legend-changed-color);
    border: 1px solid var(--legend-changed-border);
    white-space: nowrap;
  }
  .is-collapsed { opacity: 0.85; }

  /* Copy path button */
  .copy-path-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0 0.2rem;
    font-size: 0.85rem;
    line-height: 1;
    border-radius: 3px;
    transition: color 0.1s;
  }
  .copy-path-btn:hover { color: var(--text); }
  .copy-icon { font-size: 0.9rem; }
  .copy-done { font-size: 0.72rem; color: var(--legend-added-color); font-weight: 600; }

  /* Colored stat counts */
  .stat-add { color: var(--diff-add); }
  .stat-del { color: var(--diff-del); }

  /* Test chip (shown in highlight and dim modes) — verdigris accent tokens */
  .test-chip {
    background: var(--accent-subtle);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
    font-size: 0.68rem;
    padding: 0.08rem 0.4rem;
    border-radius: 999px;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  /* Generated chip — neutral/muted treatment so it reads as "lower priority"
     rather than an accent highlight. Shown whenever the file is detected as
     generated, independent of focus mode. */
  .generated-chip {
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    color: var(--text-muted);
    font-size: 0.68rem;
    padding: 0.08rem 0.4rem;
    border-radius: 999px;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  /* Test highlight: accent left border on the whole file card so test files
     are scannable in the file list at a glance. Code rows stay untouched. */
  article.test-highlight {
    border-left: 3px solid var(--accent);
  }

  /* Test highlight: subtle verdigris tint on the file header only.
     Both --accent and --surface-raised are theme-aware, so the tint adapts
     to light and dark palettes. */
  header.test-highlight {
    background: color-mix(in srgb, var(--accent) 9%, var(--surface-raised));
  }
  header.test-highlight.clickable:hover {
    background: color-mix(in srgb, var(--accent) 14%, var(--surface-raised));
  }

  /* Test dim */
  article.test-dim { opacity: 0.6; }
  article.test-dim header { opacity: 0.8; }

  /* Focus mode — dim "code noise" (import / comment) content cells.
     Opacity-only so the text stays fully selectable and the cell remains
     comment-anchorable (the add-comment affordance and line number are
     untouched). Hover restores full opacity for legibility on demand. Works in
     unified (.diff-line-content) and split (old/new-content) layouts and in both
     themes (opacity is theme-agnostic). The class is toggled per content cell. */
  .focus-dim-host :global(.diff-line-content.dimmed-noise),
  .focus-dim-host :global(.diff-line-old-content.dimmed-noise),
  .focus-dim-host :global(.diff-line-new-content.dimmed-noise) {
    opacity: 0.45;
    transition: opacity 0.12s ease;
  }
  .focus-dim-host :global(.diff-line-content.dimmed-noise):hover,
  .focus-dim-host :global(.diff-line-old-content.dimmed-noise):hover,
  .focus-dim-host :global(.diff-line-new-content.dimmed-noise):hover {
    opacity: 1;
  }
  /* ---- Symbol click-through (Tier 1) ---- */
  /* Hover affordance: identifier-ish highlighted tokens hint clickability.
     Keyword/string/comment/literal tokens are excluded to mirror the click
     handler's rejection rules. CSS-only — no library surgery. */
  .focus-dim-host :global(.diff-line-syntax-raw span[class*='hljs-']:not(.hljs-keyword):not(.hljs-string):not(.hljs-comment):not(.hljs-literal):not(.hljs-number):not(.hljs-regexp):not(.hljs-meta):not(.hljs-doctag):not(.hljs-operator):not(.hljs-punctuation)):hover {
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  /* Flash highlight on the row a symbol-popover jump landed on (the class is
     toggled by src/lib/symbols/jumpToLine.ts; reuses the draft-save flash
     keyframes). */
  .focus-dim-host :global(tr.symbol-jump-flash td) {
    animation: flash-new-draft 1.5s ease-out forwards;
  }

  /* Apply the --font-mono token to the diff view container */
  :global(.unified-diff-table-wrapper),
  :global(.old-diff-table-wrapper),
  :global(.new-diff-table-wrapper) {
    font-family: var(--font-mono) !important;
  }
  .draft-annotations { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; border-top: 1px solid var(--border-draft); }

  /* Fix-B: flash-highlight animation on the annotation entry after widget save */
  @keyframes flash-new-draft {
    0%   { background: var(--legend-changed-bg); }
    80%  { background: var(--legend-changed-bg); }
    100% { background: transparent; }
  }

  .annotation-entry.flash {
    animation: flash-new-draft 1.5s ease-out forwards;
    border-radius: 4px;
  }

  .existing-comments {
    border-top: 1px solid var(--border-banner);
    background: var(--surface-banner);
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .existing-line-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .existing-line-label {
    font-size: 0.75rem;
    opacity: 0.6;
    font-family: var(--font-mono);
    padding: 0.1rem 0.25rem;
    border-left: 2px solid var(--border-banner-accent);
    margin-bottom: 0.15rem;
  }

  /* (Resolved-thread collapse styles live in ExistingThread.svelte) */

  /* ---- Per-file fallback block for unanchored findings ---- */
  .skill-findings-annotations {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    border-top: 1px solid var(--border-draft, var(--hairline));
  }

  /* ---- Inline (at-line) annotation containers inside extend rows ---- */
  .draft-annotations.inline-annotation {
    border-top: none;
  }

  /* "Add another comment" affordance below a line's draft stack (GitHub-style
     thread feel). Subtle: text-button look, draft accent on hover. */
  .add-another-comment {
    align-self: flex-start;
    background: none;
    border: 1px dashed var(--border-draft, #f0b44488);
    border-radius: 6px;
    padding: 0.25rem 0.6rem;
    margin-top: 0.25rem;
    font-size: 0.8rem;
    font-family: inherit;
    color: var(--text-muted, #b8862a);
    cursor: pointer;
    transition: background 0.1s;
  }

  .add-another-comment:hover {
    background: var(--surface-draft, #fffbf0);
  }

  .draft-annotations.inline-annotation.flash {
    animation: flash-new-draft 1.5s ease-out forwards;
    border-radius: 4px;
  }

  .line-findings {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.35rem 0.5rem;
  }

  /* Inline existing-comment threads anchored at a line (extend row) */
  .inline-comment-threads {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--surface-banner);
    border-top: 1px solid var(--border-banner);
    border-bottom: 1px solid var(--border-banner);
  }

  /*
   * ── Inline-widget theme-inheritance fix (dark-mode contrast bug) ──
   *
   * @git-diff-view's diff-view.css forces, on EVERY descendant of an inline
   * annotation row:
   *     .diff-line-extend-wrapper * { color: initial; }   (specificity 0,0,1,1)
   *     .diff-line-widget-wrapper * { color: initial; }
   * `initial` for `color` is canvastext (≈ black). Readable on the light
   * surface, but washed dark-on-dark in dark theme — for the existing comment
   * threads, draft threads, AI finding cards, and the add-comment editor that
   * render inline at a line. The SAME content in the bottom-of-file list sits
   * OUTSIDE these wrappers and renders fine, which is why only the inline
   * (extend-row / widget) context was broken.
   *
   * Fix: re-establish the app's text cascade. Our inline host containers are
   * pinned to the proper app token; their descendants are set to
   * `color: inherit` so body text resolves to the APP color, not the diff row
   * color. Every selector below sits at specificity 0,0,2,x — beating the
   * library's 0,0,1,1 universal rule WITHOUT depending on CSS load order (the
   * library and these styles ship in separate bundle chunks, so source order
   * is not a reliable tie-breaker).
   *
   * `color: inherit` would also flatten the few descendants that carry their
   * OWN design-system color (severity / state chips, accent + danger text,
   * muted notes). Those are re-pinned just below, again at 0,0,2,x, so the
   * proper tokens drive them in BOTH themes.
   */

  /* Host containers → app text tokens. */
  :global(.diff-line-extend-wrapper) .inline-comment-threads,
  :global(.diff-line-extend-wrapper) .line-findings {
    color: var(--text);
  }
  /* Draft threads carry their own dedicated --text-draft surface/text pair. */
  :global(.diff-line-extend-wrapper) .draft-annotations :global(.draft-thread),
  :global(.diff-line-widget-wrapper) :global(.draft-thread) {
    color: var(--text-draft);
  }

  /* Body text descendants inherit from the pinned host (not the diff row). */
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(*),
  :global(.diff-line-extend-wrapper) .line-findings :global(*),
  :global(.diff-line-extend-wrapper) .draft-annotations :global(.draft-thread) :global(*),
  :global(.diff-line-widget-wrapper) :global(.draft-thread) :global(*) {
    color: inherit;
  }

  /* Re-pin design-system token colors for non-body descendants (0,0,2,x). */
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.comment-header),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.resolved-summary),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.resolved-label),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.reply-hint),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.reply-pending-label),
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-line-note) {
    color: var(--text-muted);
  }

  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.resolved-check),
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-add-draft-btn:not(.added)) {
    color: var(--accent);
  }

  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.avatar-initial) {
    color: var(--surface);
  }

  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.reply-error),
  :global(.diff-line-extend-wrapper) .line-findings :global(.severity-chip-high) {
    color: var(--legend-removed-color);
  }
  :global(.diff-line-extend-wrapper) .line-findings :global(.severity-chip-medium) {
    color: var(--legend-changed-color);
  }
  :global(.diff-line-extend-wrapper) .line-findings :global(.severity-chip-low) {
    color: var(--text-muted);
  }
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-state-chip),
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-add-draft-btn.added) {
    color: var(--legend-added-color);
  }
</style>
