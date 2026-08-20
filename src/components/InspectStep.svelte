<script lang="ts">
  import FileDiff from './FileDiff.svelte'
  import type { SkillFinding } from './FileDiff.svelte'
  import FileTree from './FileTree.svelte'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import { getSettings, setTreeOpen, setFocusMode, type FocusMode } from '../lib/settings/settings'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { formatUsageLabel } from '../lib/ai/tokenCost'
  import { activeProviderHasKey, panelMode } from '../lib/llm/config'
  import type { DiffWidth } from '../lib/settings/settings'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'
  import { draftKey } from '../lib/drafts/drafts.svelte'
  import type { createDecisionStore, DecisionVerificationContext } from '../lib/eval/decisions'
  import { track } from '../lib/analytics/analytics'
  import { navigate } from '../lib/router/router.svelte'
  import type { AttentionResult } from '../lib/ai/schemas'
  import type { createViewedStore } from '../lib/viewed/viewed.svelte'
  import type { PrComment } from '../lib/github/comments'
  import type { ReplyOutcome } from '../lib/github/replies'
  import { slugify } from '../lib/slug'
  import { renderInlineMarkdown } from '../lib/markdown/render'
  import AskBox from './AskBox.svelte'
  import { excerptAround } from '../lib/diff/excerpt'
  import { scrollToFileCard, jumpToFinding } from '../lib/diff/jumpToFile'
  import { observeDiffColHeight } from '../lib/tree/diffColHeight'
  import type { SkillReviewEntry, AskFocus, PanelState, ConvergenceValue, SimplifyValue } from '../lib/ai/run.svelte'
  import type { SkillReviewResult, SkillFinding as SchemaSkillFinding } from '../lib/ai/schemas'
  import { applyConvergence, mergedReviewerLabel, type ReviewerFindings } from '../lib/ai/convergence'
  import { applySimplify } from '../lib/ai/simplify'
  import { listSkills } from '../lib/skills/skills'
  import { computeWhitespaceHiddenPatch, type WhitespaceDisplay } from '../lib/diff/whitespace'
  import { computeFileRisk, type RiskLevel } from '../lib/risk/risk'
  import { classifyFile } from '../lib/diff/diffFile'
  import { isGeneratedFile, sortGeneratedLast } from '../lib/diff/generated'
  import StorySlideshow from './StorySlideshow.svelte'
  import Skeleton from './Skeleton.svelte'
  import AiProgress from './AiProgress.svelte'
  import Spinner from './Spinner.svelte'
  import { matchStoryPath } from '../lib/ai/schemas'
  import type { StoryOrderResult, GraphResult } from '../lib/ai/schemas'
  import type { PanelStatus } from '../lib/ai/run.svelte'
  import { findingAnchorHash, pruneAnchorOverrides } from '../lib/findings/reanchor.svelte'

  let {
    files,
    changedFiles,
    mode,
    onmode,
    draftStore,
    currentHeadSha = undefined,
    decisionStore = null,
    attention = null,
    readingOrder = [],
    viewedStore = null,
    prComments = [],
    resolvedCommentIds = new Set(),
    contentsMap = null,
    skillReviews = [],
    convergence = null,
    simplify = null,
    runSkillReviewsFn = null,
    onRetrySkill = null,
    askFn = null,
    askDisabledReason = null,
    replyFn = null,
    hideWhitespace = false,
    onhidewhitespace = null,
    whitespaceDisabledReason = null,
    storyAvailable = false,
    storyMode = false,
    onstorymode = null,
    story = null,
    storyStatus = 'idle',
    storyActivity = undefined,
    storyError = null,
    storyFallback = false,
    storyFallbackReason = null,
    onRetryStory = null,
    diagrams = null,
  }: {
    files: PrFile[]
    changedFiles: number
    mode: DiffMode
    onmode: (m: DiffMode) => void
    draftStore: ReturnType<typeof createDraftStore> | null
    /**
     * The PR's CURRENT head sha. Passed to FileDiff → DraftThread so a draft made
     * on an OLDER commit (draft.headSha !== current) shows a "from commit …" note.
     */
    currentHeadSha?: string
    /** Records accept/dismiss outcomes for the eval telemetry loop. null → disabled. */
    decisionStore?: ReturnType<typeof createDecisionStore> | null
    attention?: AttentionResult | null
    readingOrder?: string[]
    viewedStore?: ReturnType<typeof createViewedStore> | null
    prComments?: PrComment[]
    /** Set of comment databaseIds that belong to resolved review threads */
    resolvedCommentIds?: Set<number>
    /**
     * Map from filename → { before, after } full file contents, used to enable
     * context-line expansion in the diff view. Undefined while loading.
     * Files not in the map (beyond the 30-file cap) render hunk-only.
     */
    contentsMap?: Map<string, { before: string | null; after: string | null }> | null
    /** Skill reviews from the AI run — populated after runSkillReviews() */
    skillReviews?: SkillReviewEntry[]
    /**
     * Cross-reviewer convergence pass state (AiRun.convergence). When 'done',
     * the pure merge is applied HERE (fingerprint-guarded) — reviewer entries
     * are never mutated, so a failed/absent pass renders originals unchanged.
     */
    convergence?: PanelState<ConvergenceValue> | null
    /**
     * Simplify pass state (AiRun.simplify). When 'done', the fingerprint-
     * guarded rewrites are attached HERE (applySimplify, after the convergence
     * merge) — reviewer entries are never mutated, so a failed/absent/'off'
     * pass renders the original bodies unchanged.
     */
    simplify?: PanelState<SimplifyValue> | null
    /** Optional callback to trigger runSkillReviews on the AiRun instance */
    runSkillReviewsFn?: (() => void) | null
    /**
     * Re-runs JUST one reviewer (the error-chip retry). Receives the skillId of
     * the errored reviewer; wired to AiRun.retrySkill. null → retry unavailable.
     */
    onRetrySkill?: ((skillId: string) => void) | null
    /**
     * Optional Ask AI function — when provided, DraftThread widgets show the
     * "Comment | Ask AI" tab toggle. Threaded from Review via AiRun.ask.
     */
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    /**
     * Optional disabled hint for Ask AI gating (e.g. "No API key configured.").
     */
    askDisabledReason?: string | null
    /**
     * Posts a reply to an existing comment thread immediately (provider
     * capability commentReplies). null → Reply affordance hidden.
     */
    replyFn?: ((root: PrComment, body: string) => Promise<ReplyOutcome>) | null
    /** Whether whitespace-only changes are hidden (like GitHub's ?w=1). */
    hideWhitespace?: boolean
    /** Called when the user toggles "Hide whitespace". */
    onhidewhitespace?: ((hide: boolean) => void) | null
    /**
     * When non-null, the toggle is disabled with this reason as tooltip
     * (e.g. compare mode, where fetched contents don't match the compared revisions).
     */
    whitespaceDisabledReason?: string | null
    // ---- Story mode (Plan H) ----
    /** Whether story mode is available (LLM key configured + not compare mode). */
    storyAvailable?: boolean
    /** Whether story mode is the active flow (persisted per-browser). */
    storyMode?: boolean
    /** Called when the user switches Story|Files in step 2 (persists the choice). */
    onstorymode?: ((story: boolean) => void) | null
    /** Story-order result from the AI run; null while pending / unavailable. */
    story?: StoryOrderResult | null
    /** Status of the story AI task (for skeleton / fallback decisions). */
    storyStatus?: PanelStatus
    /** Deep-mode tool-activity lines for the story task (unified progress log). */
    storyActivity?: string[]
    /** Humanized reason the story task failed (shown in the error note + retry). */
    storyError?: string | null
    /**
     * True when `story` is the DETERMINISTIC structural walkthrough (AI ordering
     * failed/unusable). The walkthrough still renders — we add a subtle muted
     * note + Retry instead of the old hard-error "Showing all files" state.
     */
    storyFallback?: boolean
    /** The specific reason AI ordering was unavailable (shown in the fallback note). */
    storyFallbackReason?: string | null
    /** Re-invokes just the story task (used by the Retry button on an errored story). */
    onRetryStory?: (() => void) | null
    /** Change-map source for the story progress map; null/pending → no map (never blocks). */
    diagrams?: GraphResult | null
  } = $props()

  // ---------------------------------------------------------------------------
  // Story mode switching + fallback (Plan H)
  // ---------------------------------------------------------------------------

  // Does the story result have at least one step that maps to a file in this PR?
  // Tolerant matching (exact → suffix → basename) so a path the model echoed
  // slightly differently still counts — ANY mapping step makes the story usable
  // (no longer all-or-nothing on exact paths). The slideshow renders only the
  // mappable steps/files; we only need to know if ≥1 maps.
  const storyHasUsableSteps = $derived.by(() => {
    if (!story || story.steps.length === 0) return false
    const prFilenames = files.map((f) => f.filename)
    return story.steps.some((s) => s.files.some((p) => matchStoryPath(p, prFilenames) !== null))
  })

  // The effective flow: story when available AND chosen AND a usable result
  // exists; otherwise files. While the story task is still loading we keep the
  // story surface (skeleton). On error / empty result we fall back to files with
  // a REASON-SPECIFIC note. No-key users never reach here (storyAvailable false).
  const storyPending = $derived(storyStatus === 'idle' || storyStatus === 'loading' || storyStatus === 'streaming')
  // The story TASK is turned off in AI settings (Plan J matrix) — a deliberate
  // user choice, distinct from no-key unavailability. The switch stays visible
  // but Story is disabled with an honest note, never the "couldn't build" copy.
  const storyTaskOff = $derived(storyStatus === 'disabled')
  const showStory = $derived(storyAvailable && storyMode && !storyTaskOff && (storyPending || storyHasUsableSteps))
  // True when story was chosen but we fell back to Files. Two distinct reasons:
  //  - errored: the task failed (invalid JSON / rate-limited / …) → show the
  //    reason + a Retry button that re-runs just the story task.
  //  - empty: the task finished but produced no usable walkthrough.
  // The deterministic structural fallback: story mode chosen, the AI ordering
  // was unavailable (flag set by the run), and the walkthrough still renders
  // (the fallback story maps to PR files). This REPLACES the hard-error state —
  // we show the walkthrough plus a muted note + Retry, never "Showing all files".
  const storyStructuralFallback = $derived(
    storyAvailable && storyMode && storyFallback && showStory && storyHasUsableSteps,
  )
  const storyErrored = $derived(storyAvailable && storyMode && storyStatus === 'error')
  const storyEmpty = $derived(
    storyAvailable && storyMode && !storyTaskOff && !storyPending && !storyErrored && !storyHasUsableSteps,
  )
  const storyFellBack = $derived(storyErrored || storyEmpty)

  function selectMode(toStory: boolean): void {
    onstorymode?.(toStory)
  }

  function commentsForFile(path: string): PrComment[] {
    return prComments.filter((c) => c.path === path)
  }

  function draftsForFile(path: string) {
    return draftStore?.drafts.filter((d) => d.path === path) ?? []
  }

  /**
   * Save a draft. `n` identifies the draft being EDITED in place (its store
   * ordinal); undefined = a NEW comment → APPEND via the store's n=-1 sentinel
   * so multiple drafts coexist at one line (adding never clobbers).
   */
  async function handleAddDraft(path: string, line: number, side: 'LEFT' | 'RIGHT', body: string, n?: number) {
    if (!draftStore) return
    await draftStore.upsert({ path, line, side, body, n: n ?? -1 })
    track('comment_drafted')
  }

  /** Remove ONE draft at a line — the one with ordinal `n` (undefined = first). */
  async function handleRemoveDraft(path: string, line: number, side: 'LEFT' | 'RIGHT', n?: number) {
    if (!draftStore) return
    const draft = draftStore.drafts.find(
      (d) => d.path === path && d.line === line && d.side === side && (n === undefined || (d.n ?? 0) === n),
    )
    if (draft) {
      await draftStore.remove(draftKey(draft))
    }
  }

  // Mark viewed + auto-advance (Files mode). When the user CHECKS a file viewed
  // it collapses, shifting everything below up and leaving them lost in the list.
  // So on a CHECK (not an uncheck) we scroll the NEXT file's card into view to
  // keep their place. scrollToFileCard rAF-retries until the post-collapse layout
  // settles, so no explicit tick() is needed. No next file (last one) → no-op.
  function handleToggleViewed(file: PrFile): void {
    const wasViewed = viewedStore?.isViewed(file.filename, file.patch) ?? false
    viewedStore?.toggle(file.filename, file.patch)
    if (!wasViewed) {
      const idx = orderedFiles.findIndex((f) => f.filename === file.filename)
      const next = orderedFiles[idx + 1]
      if (next) scrollToFileCard(next.filename)
    }
  }

  // Generated-file predicate (path + loaded contents). Reused for ordering and
  // for the per-file `generated` chip / focus-mode dimming inside FileDiff.
  function fileIsGenerated(f: PrFile): boolean {
    return isGeneratedFile(f.filename, contentsMap?.get(f.filename))
  }

  // File ordering per readingOrder (EC-12e), then generated files sunk last.
  // The generated sink is a STABLE post-pass: it preserves the reading-order /
  // file order WITHIN the generated and non-generated groups.
  const orderedFiles = $derived.by(() => {
    let base: PrFile[]
    if (!readingOrder.length) {
      base = files
    } else {
      const fileSet = new Set(files.map(f => f.filename))
      // Only use readingOrder entries that exist in files
      const validOrder = readingOrder.filter(p => fileSet.has(p))
      const orderedPaths = new Set(validOrder)
      const listedFiles = validOrder.map(p => files.find(f => f.filename === p)!).filter(Boolean)
      const unlistedFiles = files.filter(f => !orderedPaths.has(f.filename))
      base = [...listedFiles, ...unlistedFiles]
    }
    return sortGeneratedLast(base, fileIsGenerated)
  })

  // Hotspot and testFlag lookups (unknown paths ignored — EC-13c)
  const hotspotMap = $derived(
    new Map(
      (attention?.hotspots ?? [])
        .filter(h => files.some(f => f.filename === h.path))
        .map(h => [h.path, h])
    )
  )

  const testFlagSet = $derived(
    new Set(
      (attention?.testFlags ?? [])
        .filter(tf => files.some(f => f.filename === tf.path))
        .map(tf => tf.path)
    )
  )

  // Per-file review-effort risk (deterministic — src/lib/risk). Worst files
  // surface via a compact chip above the diff. To keep rows uncluttered and
  // avoid double-rendering, the chip is SKIPPED when the hotspot badge already
  // tells the whole story: for hotspot files we recompute WITHOUT the hotspot
  // input, and only show the chip if the residual (churn / findings /
  // sensitive-path) risk is still non-low. Low-risk files get no chip at all.
  const fileRiskByPath = $derived.by(() => {
    const map = new Map<string, { level: RiskLevel; show: boolean }>()
    for (const f of files) {
      const hotspotLevel = hotspotMap.get(f.filename)?.level ?? null
      const findings = (skillSuggestionsByPath.get(f.filename) ?? []).map((s) => ({
        severity: s.severity,
        verification: s.verification,
      }))
      const level = computeFileRisk({ file: f, hotspotLevel, findings })
      const residual = hotspotLevel
        ? computeFileRisk({ file: f, hotspotLevel: null, findings })
        : level
      map.set(f.filename, { level, show: level !== 'low' && residual !== 'low' })
    }
    return map
  })

  // Active path: set on tree click only (no IntersectionObserver)
  let activePath = $state<string | null>(null)

  // Collapsible tree drawer — default false (diff-first); read from settings on mount
  let treeOpen = $state(getSettings().treeOpen)
  let toggleTabEl = $state<HTMLButtonElement | null>(null)

  // Diff width: 'centered' (default) | 'full'
  const diffWidth = $derived<DiffWidth>(getSettings().diffWidth)

  // ---- Focus mode quick toggle (toolbar) ----------------------------------
  // Cycles off → imports → imports-comments → off. Reads reactively from
  // settingsState so the label/active state stay in sync with the Appearance
  // setting. The per-line dimming itself lives in FileDiff.
  const focusMode = $derived<FocusMode>(settingsState.current.focusMode)
  const FOCUS_CYCLE: Record<FocusMode, FocusMode> = {
    off: 'imports',
    imports: 'imports-comments',
    'imports-comments': 'off',
  }
  const FOCUS_LABEL: Record<FocusMode, string> = {
    off: 'Focus: off',
    imports: 'Focus: imports',
    'imports-comments': 'Focus: imports + comments',
  }
  function cycleFocusMode(): void {
    const next = FOCUS_CYCLE[focusMode]
    setFocusMode(next)
    if (next !== 'off') track('focus_mode_on')
  }

  // ---- Viewport thresholds ----
  // The margin-vs-inline drawer decision is pure CSS (see the drawer CSS block
  // below — media query + .diff-full). No JS viewport tracking is needed for it.
  // NARROW_THRESHOLD (<900px): after picking a file on a small screen we close
  // the drawer so the diff gets its width back (checked at call time, no listener).
  const NARROW_THRESHOLD = 900

  // ---- Tree height clamp (--diff-col-h) ----
  // The open tree nav must never be taller than the diff column it accompanies.
  // CSS can't read a sibling's height, so a ResizeObserver on the diff column
  // mirrors its height into --diff-col-h on .inspect-layout; the nav's
  // max-height clamps to min(viewport cap, max(12rem, that height)).
  // NOTE: this observes CONTENT height only — the margin-vs-inline drawer
  // decision above stays pure CSS with no viewport listeners (PR #59 contract).
  let layoutEl = $state<HTMLDivElement | null>(null)
  let diffColEl = $state<HTMLDivElement | null>(null)

  $effect(() => {
    if (!layoutEl || !diffColEl) return
    return observeDiffColHeight(diffColEl, layoutEl)
  })

  function toggleTree(): void {
    treeOpen = !treeOpen
    setTreeOpen(treeOpen)
    if (treeOpen) {
      track('drawer_opened')
    }
  }

  function closeTree(): void {
    if (!treeOpen) return
    treeOpen = false
    setTreeOpen(false)
    // Return focus to toggle tab
    toggleTabEl?.focus()
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && treeOpen) closeTree()
  }

  function handleTreeSelect(path: string): void {
    activePath = path
    // Shared scroll + expand-if-collapsed mechanism (also used by hotspot jumps)
    scrollToFileCard(path)
    // On narrow viewport (<900px), close the drawer after selecting a file
    if (window.innerWidth < NARROW_THRESHOLD) closeTree()
  }

  // ---------------------------------------------------------------------------
  // Skill suggestions
  // ---------------------------------------------------------------------------

  // Build a Set of paths in this PR for filtering
  const prPathSet = $derived(new Set(files.map(f => f.filename)))

  // Auto-scroll to first finding's file when a run completes with findings
  let prevRunning = $state(false)
  $effect(() => {
    const nowRunning = isRunning
    if (prevRunning && !nowRunning) {
      // Run just finished — find first finding across all done reviews
      for (const review of skillReviews) {
        if (review.state.status !== 'done' || !review.state.value) continue
        const result = review.state.value as { findings?: { path: string }[] }
        const firstValid = result.findings?.find(f => prPathSet.has(f.path))
        if (firstValid) {
          const slug = slugify(firstValid.path)
          const el = document.getElementById(`file-${slug}`)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
          break
        }
      }
    }
    prevRunning = nowRunning
  })

  // ---------------------------------------------------------------------------
  // Cross-reviewer convergence (applied here, loss-proof)
  // ---------------------------------------------------------------------------
  // The EFFECTIVE findings per reviewer: the settled results with the
  // convergence merge applied when (and only when) the pass finished AND its
  // fingerprint matches the current finding set. Everything downstream
  // (per-file cards, popovers, decision telemetry) reads THIS map, so a
  // failed/skipped/stale pass renders the original findings byte-identically.
  const effectiveFindingsBySkill = $derived.by(() => {
    const reviewers: ReviewerFindings[] = []
    for (const review of skillReviews) {
      if (review.state.status !== 'done' || !review.state.value || typeof review.state.value === 'string') continue
      const value = review.state.value as SkillReviewResult
      // Defensive on odd cached values — degrade to "no findings", never throw.
      reviewers.push({ skillId: review.skillId, name: review.name, findings: Array.isArray(value.findings) ? value.findings : [] })
    }
    const v =
      convergence && convergence.status === 'done' && convergence.value && typeof convergence.value === 'object'
        ? (convergence.value as ConvergenceValue)
        : null
    const effective = v ? applyConvergence(reviewers, v) : reviewers
    // Simplify pass (after the merge — its rewrites were computed against the
    // MERGED bodies): attach simpleBody where the fingerprint matches. A
    // failed/stale/absent pass leaves the bodies byte-identical.
    const s =
      simplify && simplify.status === 'done' && simplify.value && typeof simplify.value === 'object'
        ? (simplify.value as SimplifyValue)
        : null
    const simplified = s ? applySimplify(effective, s) : effective
    return new Map(simplified.map((r) => [r.skillId, r.findings]))
  })

  /** Display credit for a finding: merged → all contributing reviewers. */
  function findingLabel(reviewName: string, finding: SchemaSkillFinding): string {
    return finding.mergedFrom && finding.mergedFrom.length > 0
      ? mergedReviewerLabel(reviewName, finding.mergedFrom)
      : reviewName
  }

  // Per-file skill suggestions, filtered to only paths in the PR
  // Split into two maps: file-level (null line) stays above the file in InspectStep;
  // line-bearing findings are passed into FileDiff via skillFindings prop.
  // Shape: Map<path, entry[]>
  type SuggestionEntry = { skillName: string; findingPath: string; line: number | null; severity: 'high' | 'medium' | 'low'; body: string; key: string; verification?: import('../lib/ai/schemas').FindingVerification; raisedBy?: string[]; mergedFrom?: import('../lib/ai/schemas').AbsorbedFinding[]; mergedReason?: string; coveredByDraft?: { path: string; line: number }; simpleBody?: string }

  const skillSuggestionsByPath = $derived.by(() => {
    const map = new Map<string, SuggestionEntry[]>()
    for (const review of skillReviews) {
      if (review.state.status !== 'done' || !review.state.value) continue
      const findings = effectiveFindingsBySkill.get(review.skillId) ?? []
      for (const finding of findings) {
        if (!prPathSet.has(finding.path)) continue
        const arr = map.get(finding.path) ?? []
        arr.push({
          skillName: findingLabel(review.name, finding),
          findingPath: finding.path,
          line: finding.line,
          severity: finding.severity,
          body: finding.body,
          key: `${review.skillId}:${finding.path}:${finding.line}:${finding.body.slice(0, 30)}`,
          verification: finding.verification,
          raisedBy: finding.raisedBy,
          mergedFrom: finding.mergedFrom,
          mergedReason: finding.mergedReason,
          coveredByDraft: finding.coveredByDraft,
          simpleBody: finding.simpleBody,
        })
        map.set(finding.path, arr)
      }
    }
    return map
  })

  // Re-anchor housekeeping: once at least one reviewer has settled, drop stored
  // anchor overrides whose finding no longer exists (a re-run changed/removed
  // it — the override is an orphan; the fresh run may have fixed the line
  // itself). This is the ONE place with the COMPLETE finding set across all
  // files/reviewers, so pruning here can never eat another file's override.
  // Dismissed/added findings still count as live (their raw findings persist in
  // the run results), so a dismiss doesn't lose a correction. An in-progress
  // run (no reviewer done yet → empty suggestion map) never prunes.
  $effect(() => {
    const anyDone = skillReviews.some((r) => r.state.status === 'done')
    if (!anyDone) return
    const live = new Set<string>()
    for (const suggestions of skillSuggestionsByPath.values()) {
      for (const s of suggestions) {
        live.add(findingAnchorHash({ key: s.key, path: s.findingPath, line: s.line, body: s.body }))
      }
    }
    pruneAnchorOverrides(live)
  })

  // File-level (null-line) suggestions — rendered above the FileDiff (Files mode)
  // and per-file in Story mode. Cross-model demoted findings (Plan M) are NO
  // LONGER pulled out into a separate collapsed group: they render alongside the
  // rest, carrying their `verification` so the card shows the lower-confidence
  // treatment. Only findings the reviewer has DISMISSED or ADDED-as-draft are
  // hidden — adding auto-cleans up the card (its draft now lives in the diff);
  // this is a visual hide, the decision is still recorded as 'accepted'.
  const fileLevelSuggestionsByPath = $derived.by(() => {
    const map = new Map<string, SuggestionEntry[]>()
    for (const [path, suggestions] of skillSuggestionsByPath) {
      const fileLevelOnly = suggestions.filter(s => s.line === null && !dismissedKeys.has(s.key) && !addedDraftKeys.has(s.key))
      if (fileLevelOnly.length > 0) map.set(path, fileLevelOnly)
    }
    return map
  })

  // Line-bearing suggestions — passed to FileDiff as skillFindings prop. Demoted
  // findings flow through too (carrying `verification`); the card renders them
  // dimmer with a "lower confidence" badge rather than hiding them.
  const lineSkillFindingsByPath = $derived.by(() => {
    const map = new Map<string, SkillFinding[]>()
    for (const [path, suggestions] of skillSuggestionsByPath) {
      const lineOnly = suggestions
        .filter(s => s.line !== null && !dismissedKeys.has(s.key) && !addedDraftKeys.has(s.key))
        .map(s => ({
          skillName: s.skillName,
          line: s.line as number,
          severity: s.severity,
          body: s.body,
          key: s.key,
          verification: s.verification,
          raisedBy: s.raisedBy,
          mergedFrom: s.mergedFrom,
          mergedReason: s.mergedReason,
          coveredByDraft: s.coveredByDraft,
          simpleBody: s.simpleBody,
        }))
      if (lineOnly.length > 0) map.set(path, lineOnly)
    }
    return map
  })

  // ---------------------------------------------------------------------------
  // Chip → finding navigation (reveal/jump from the reviewer result chip)
  // ---------------------------------------------------------------------------
  // A flat, navigable list of a reviewer's findings: each entry carries the
  // finding's path, line, the FULL body (rendered as inline markdown in the
  // popover — so backticked code reads as <code>, never truncated) and the SAME
  // key the rendered SkillFindingCard emits as data-finding-key — so clicking an
  // entry scrolls+flashes the exact card (jumpToFinding). The popover is now the
  // home for findings that aren't anchored in the visible diff (the old "bottom"
  // file-level cards were removed), so each entry also carries what
  // addFindingAsDraft / dismissFinding need to act on the finding.
  type NavFinding = { key: string; path: string; line: number | null; body: string; skillName: string }

  const navFindingsBySkill = $derived.by(() => {
    const map = new Map<string, NavFinding[]>()
    for (const review of skillReviews) {
      if (review.state.status !== 'done' || !review.state.value) continue
      const findings = effectiveFindingsBySkill.get(review.skillId) ?? []
      const entries: NavFinding[] = []
      for (const finding of findings) {
        if (!prPathSet.has(finding.path)) continue
        const key = `${review.skillId}:${finding.path}:${finding.line}:${finding.body.slice(0, 30)}`
        // Hide a finding once it's been dismissed or added as a draft — same
        // visual-hide rule the inline/file-level cards used (decision still recorded).
        if (dismissedKeys.has(key) || addedDraftKeys.has(key)) continue
        entries.push({
          // MUST match SkillFindingCard's data-finding-key (see skillSuggestionsByPath).
          key,
          path: finding.path,
          line: finding.line,
          body: finding.body,
          skillName: findingLabel(review.name, finding),
        })
      }
      if (entries.length > 0) map.set(review.skillId, entries)
    }
    return map
  })

  // Open popover state — a compound `{surface}:{skillId}` token identifying WHICH
  // chip's finding list is currently disclosed, or null when none is open. Only
  // the reviewer result chip carries a popover now (the gray suggestion-summary
  // chips were removed — single source of truth). EVERY chip with ≥1 finding
  // opens a popover (uniform) — a single-finding chip shows a one-row popover
  // instead of yanking to the diff.
  type ChipSurface = 'result'
  let openFindingsToken = $state<string | null>(null)

  function popoverToken(surface: ChipSurface, skillId: string): string {
    return `${surface}:${skillId}`
  }

  function isPopoverOpen(surface: ChipSurface, skillId: string): boolean {
    return openFindingsToken === popoverToken(surface, skillId)
  }

  function navFindingsFor(skillId: string): NavFinding[] {
    return navFindingsBySkill.get(skillId) ?? []
  }

  /** Activate a reviewer chip: ALWAYS toggle its popover (uniform — even for a
   *  single finding, so the reviewer can scan it without being yanked to the
   *  diff). Zero-finding chips stay inert. Jumping happens on entry click. */
  function activateReviewerChip(surface: ChipSurface, skillId: string): void {
    const findings = navFindingsFor(skillId)
    if (findings.length === 0) return
    const token = popoverToken(surface, skillId)
    openFindingsToken = openFindingsToken === token ? null : token
  }

  /** Click a popover entry → jump+flash that finding and close the popover. */
  function jumpToNavFinding(f: NavFinding): void {
    openFindingsToken = null
    jumpToFinding(f.path, f.key)
  }

  function closeFindingsPopover(): void {
    openFindingsToken = null
    askOpenKey = null
  }

  // ---- Ask AI on a popover finding entry --------------------------------------
  // Only one entry's Ask box is open at a time (keyed by the finding key). Gated
  // on askFn (no key configured → no Ask AI button), matching the rest of the app.
  const hasAskFn = $derived(askFn !== null && askFn !== undefined)
  let askOpenKey = $state<string | null>(null)

  function toggleAsk(key: string): void {
    askOpenKey = askOpenKey === key ? null : key
  }

  // Best-effort grounding focus for a popover (file-level / unanchored) finding.
  // The finding text is the primary anchor; path locates it. A line-bearing
  // finding gets a hunk excerpt from the patch; a null-line finding falls back to
  // a small window from the loaded file contents (when available), else empty.
  function askFocusFor(nav: NavFinding): AskFocus {
    const file = files.find((f) => f.filename === nav.path)
    let excerpt = ''
    if (nav.line !== null && file?.patch) {
      excerpt = excerptAround(file.patch, nav.line, 'RIGHT', 6)
    } else {
      const after = contentsMap?.get(nav.path)?.after
      if (after) excerpt = after.split('\n').slice(0, 24).join('\n')
    }
    return { path: nav.path, line: nav.line ?? 1, excerpt, finding: nav.body }
  }

  // Focus the first finding entry when a popover opens (keyboard discoverability).
  $effect(() => {
    if (openFindingsToken === null) return
    const token = openFindingsToken
    requestAnimationFrame(() => {
      if (openFindingsToken !== token) return
      const first = document.querySelector('.findings-popover [role="menuitem"]') as HTMLElement | null
      first?.focus()
    })
  })

  // Close the open popover on an outside click (the chip + popover are excluded).
  $effect(() => {
    if (openFindingsToken === null) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.skill-chip-nav')) return
      closeFindingsPopover()
    }
    document.addEventListener('click', onDocClick, true)
    return () => document.removeEventListener('click', onDocClick, true)
  })

  // Roving focus inside an open popover (arrow keys / Enter / Escape).
  function handlePopoverKeydown(event: KeyboardEvent, surface: ChipSurface, skillId: string): void {
    const items = navFindingsFor(skillId)
    if (event.key === 'Escape') {
      event.preventDefault()
      closeFindingsPopover()
      // Return focus to the chip that opened it.
      const chip = document.querySelector(`[data-reviewer-chip="${surface}:${skillId}"]`) as HTMLElement | null
      chip?.focus()
      return
    }
    const target = event.target as HTMLElement
    const list = target.closest('[role="menu"]')
    if (!list) return
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    const idx = buttons.indexOf(target as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      buttons[(idx + 1) % buttons.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      buttons[(idx - 1 + buttons.length) % buttons.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      buttons[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      buttons[buttons.length - 1]?.focus()
    }
    void items
  }

  // ---------------------------------------------------------------------------
  // Accept/dismiss telemetry loop (analytics + local decision store)
  // ---------------------------------------------------------------------------
  // For each AI finding we record its accept ('Add as draft') / dismiss outcome:
  //   1. a PostHog event (ids/enums/counts ONLY — the choke-point strips content)
  //   2. a local decision row (durable ground-truth the eval capture flow reads)
  // The metadata lookup is keyed by the SAME finding key the cards emit, so the
  // existing handlers don't need new arguments.
  type DecisionMeta = {
    reviewer: string
    severity: 'high' | 'medium' | 'low'
    verificationContext: DecisionVerificationContext
  }

  // Run-level verification context shared by every finding this run.
  const runDeep = $derived(settingsState.current.aiTaskModes.skills === 'deep')
  // Plan P: mode is emergent — derive the analytics label from the panel's
  // generator count (≥2 generators = 'generate', else 'verify').
  const runFusionMode = $derived((settingsState.current, panelMode()))

  const decisionMetaByKey = $derived.by(() => {
    const map = new Map<string, DecisionMeta>()
    for (const review of skillReviews) {
      if (review.state.status !== 'done' || !review.state.value) continue
      const findings = effectiveFindingsBySkill.get(review.skillId) ?? []
      for (const finding of findings) {
        const key = `${review.skillId}:${finding.path}:${finding.line}:${finding.body.slice(0, 30)}`
        const v = finding.verification
        map.set(key, {
          reviewer: review.skillId,
          severity: finding.severity,
          verificationContext: {
            deep: runDeep,
            crossVerified: !!v,
            confirmedBy: v?.confirmedBy ?? 0,
            polledModels: v?.polledModels ?? 0,
            fusionMode: runFusionMode,
            raisedByCount: finding.raisedBy?.length ?? 0,
          },
        })
      }
    }
    return map
  })

  // Record a finding's accept/dismiss decision: fire the (content-free) analytics
  // event AND persist the durable local decision row. Invisible — no UI change.
  function recordDecision(key: string, decision: 'accepted' | 'dismissed'): void {
    const meta = decisionMetaByKey.get(key)
    if (!meta) return
    const vc = meta.verificationContext
    track(decision === 'accepted' ? 'ai_finding_accepted' : 'ai_finding_dismissed', {
      reviewer: meta.reviewer,
      severity: meta.severity,
      deep: vc.deep,
      crossVerified: vc.crossVerified,
      confirmedBy: vc.confirmedBy,
      polledModels: vc.polledModels,
      ...(vc.fusionMode ? { fusionMode: vc.fusionMode } : {}),
      raisedByCount: vc.raisedByCount,
    })
    void decisionStore?.record({
      findingKey: key,
      decision,
      severity: meta.severity,
      verificationContext: vc,
    })
  }

  // Session-only dismissed finding keys
  let dismissedKeys = $state<Set<string>>(new Set())

  function dismissFinding(key: string) {
    dismissedKeys = new Set([...dismissedKeys, key])
    recordDecision(key, 'dismissed')
  }

  // Add-as-draft confirmation: track which finding keys have been "added" (session-only)
  let addedDraftKeys = $state<Set<string>>(new Set())

  // Seed the suppression sets from the durable decision store on mount, so a
  // finding the user DISMISSED (or ADDED-as-draft → 'accepted') stays hidden
  // across a FULL PAGE RELOAD — not just across slide-nav. The store is bound to
  // the current prKey (PR-scoped read), so this only re-surfaces THIS PR's
  // decisions. We MERGE into the live sets (never clobber a session dismissal),
  // and seed once per store instance so a later retry's clearSuppressionForSkill
  // (which un-suppresses a reviewer for a deliberate re-run) isn't re-seeded over.
  let seededStore: ReturnType<typeof createDecisionStore> | null = null
  $effect(() => {
    const store = decisionStore
    if (!store || store === seededStore) return
    seededStore = store
    void (async () => {
      await store.load()
      // Guard: the effect may have re-run with a new store before this resolved.
      if (store !== seededStore) return
      const loadedDismissed: string[] = []
      const loadedAccepted: string[] = []
      for (const rec of store.list()) {
        if (rec.decision === 'dismissed') loadedDismissed.push(rec.findingKey)
        else if (rec.decision === 'accepted') loadedAccepted.push(rec.findingKey)
      }
      if (loadedDismissed.length) dismissedKeys = new Set([...dismissedKeys, ...loadedDismissed])
      if (loadedAccepted.length) addedDraftKeys = new Set([...addedDraftKeys, ...loadedAccepted])
    })()
  })

  // Retry (#108) re-runs ONE reviewer → a fresh run whose findings should ALL
  // show. Finding keys are skillId-prefixed (`${skillId}:${path}:${line}:…`), so
  // a re-run that re-surfaces a previously DISMISSED (or added-as-draft) finding
  // shares its key and would be silently pre-suppressed. Clear this reviewer's
  // suppressed keys before retrying so the fresh findings aren't filtered out.
  function clearSuppressionForSkill(skillId: string): void {
    const prefix = `${skillId}:`
    dismissedKeys = new Set([...dismissedKeys].filter(k => !k.startsWith(prefix)))
    addedDraftKeys = new Set([...addedDraftKeys].filter(k => !k.startsWith(prefix)))
  }

  // Wrap the parent retry callback so the suppressed-key reset happens in lockstep
  // with the re-run (keeps the error-chip's #108 behavior, just unsuppresses first).
  function retryReviewer(skillId: string): void {
    clearSuppressionForSkill(skillId)
    onRetrySkill?.(skillId)
  }

  async function addFindingAsDraft(finding: { findingPath: string; line: number | null; body: string; key: string; skillName?: string; side?: 'LEFT' | 'RIGHT'; originalBody?: string }) {
    if (!draftStore) return
    await draftStore.upsert({
      path: finding.findingPath,
      // line/side arrive as the finding's EFFECTIVE anchor: a user-corrected
      // (re-anchored) finding passes its corrected location from FileDiff, so
      // the draft lands where the user moved it. side defaults to RIGHT (the
      // findings' home side; only a drag onto a deleted line yields LEFT).
      line: finding.line ?? 1,
      side: finding.side ?? 'RIGHT',
      // The body is the text the card DISPLAYED when the user clicked — the
      // simplify pass's rewrite by default when one exists.
      body: finding.body,
      // APPEND (n=-1 sentinel): the user may already have their own draft at
      // this line — adding a finding must never overwrite it.
      n: -1,
      // This draft originates from an AI reviewer's finding → flag it so the
      // in-app 🤖 badge shows and a GitHub attribution marker is prepended on
      // submit/export. The editable body stays clean.
      aiAuthored: true,
      aiReviewer: finding.skillName,
      // When the displayed body was the SIMPLIFIED rewrite, carry the raw
      // finding text along so "Copy as LLM prompt" can hand an agent the full
      // detail (buildReviewPrompt) — the editable body stays the simplified
      // text the user chose.
      ...(finding.originalBody && finding.originalBody !== finding.body
        ? { aiOriginalBody: finding.originalBody }
        : {}),
    })
    track('comment_drafted')
    // Accept signal: record the accept/dismiss telemetry (event + local store).
    recordDecision(finding.key, 'accepted')
    // "Added as draft" is session state — shown as a labeled state chip on the card
    addedDraftKeys = new Set([...addedDraftKeys, finding.key])
  }

  // Show the run button when: skills exist + key present + runSkillReviewsFn provided
  const enabledSkillCount = $derived(listSkills().filter(s => s.enabled).length)
  // Run button gates on the ACTIVE provider's key (Plan F), not deepseekKey
  const hasKey = $derived(activeProviderHasKey())
  // Plan J: when the 'skills' task mode is 'off', don't offer the reviewers at
  // all — show a compact disabled note instead of the Run button. Reactive via
  // settingsState so toggling it in settings updates the step live.
  const skillsOff = $derived(settingsState.current.aiTaskModes.skills === 'off')
  const showRunButton = $derived(!skillsOff && enabledSkillCount > 0 && hasKey && runSkillReviewsFn !== null)
  // Show the disabled note only when reviewers WOULD otherwise be offered.
  const showSkillsDisabled = $derived(skillsOff && enabledSkillCount > 0 && hasKey && runSkillReviewsFn !== null)

  // Plan J: link to settings from the disabled reviewers note (preserve return-to).
  function goToSettings(e: MouseEvent) {
    e.preventDefault()
    sessionStorage.setItem('review123:settingsReturnTo', location.pathname)
    navigate('/settings')
  }

  // Run "in progress": a batch is still working if ANY reviewer is actively
  // running (loading) OR still waiting for a concurrency slot (queued). Both
  // keep the "Run my reviewers" button disabled/busy.
  const isRunning = $derived(skillReviews.some(e => e.state.status === 'loading' || e.state.status === 'queued'))

  // How many reviewers are in flight — drives the single global "Running… (N)"
  // indicator and the aria-live announcement (announces the count, not each
  // per-reviewer activity line, so screen readers aren't spammed). Only the
  // loading reviewers count as "running"; queued ones are counted separately.
  const runningCount = $derived(skillReviews.filter(e => e.state.status === 'loading').length)

  // How many reviewers are waiting for a concurrency slot (queued) — drives the
  // muted "Waiting (N)" region and its own aria-live count.
  const queuedCount = $derived(skillReviews.filter(e => e.state.status === 'queued').length)

  // Latest activity line for a running reviewer (deep mode). We show ONLY the
  // most recent line per row — truncated with ellipsis via CSS — rather than the
  // full scrolling log, so N concurrent reviewers stay bounded and aligned.
  function latestActivity(entry: SkillReviewEntry): string | null {
    const activity = entry.state.activity
    if (!activity || activity.length === 0) return null
    return activity[activity.length - 1] ?? null
  }

  // Session-only: which running rows the user expanded to see the full log.
  let expandedRunIds = $state<Set<string>>(new Set())
  function toggleExpandRun(skillId: string): void {
    const next = new Set(expandedRunIds)
    if (next.has(skillId)) next.delete(skillId)
    else next.add(skillId)
    expandedRunIds = next
  }

  // ---------------------------------------------------------------------------
  // Hide whitespace changes (git diff -w semantics)
  // ---------------------------------------------------------------------------

  const whitespaceToggleEnabled = $derived(whitespaceDisabledReason === null)

  /**
   * Per-file whitespace-hiding decision, computed once here (not per FileDiff)
   * so the toolbar can count collapsed files. Empty map when the toggle is off
   * or disabled. Files are only included when hiding can APPLY:
   * - added/removed files are exempt (a -w diff is identical to the normal one)
   * - files without both full contents are 'unavailable' (honest degradation)
   */
  const whitespaceByPath = $derived.by(() => {
    const map = new Map<string, WhitespaceDisplay>()
    if (!hideWhitespace || !whitespaceToggleEnabled) return map
    for (const f of files) {
      if (classifyFile(f) !== 'diff') continue
      // -w cannot change the diff of a pure addition/removal — leave as-is, no note
      if (f.status === 'added' || f.status === 'removed') continue
      const c = contentsMap?.get(f.filename)
      if (c == null || c.before === null || c.after === null) {
        map.set(f.filename, { kind: 'unavailable' })
        continue
      }
      map.set(f.filename, computeWhitespaceHiddenPatch(c.before, c.after))
    }
    return map
  })

  /** Files whose entire change is whitespace-only (shown as placeholders). */
  const whitespaceOnlyCount = $derived.by(() => {
    let n = 0
    for (const entry of whitespaceByPath.values()) {
      if (entry.kind === 'collapsed') n++
    }
    return n
  })

  function toggleHideWhitespace(): void {
    if (!whitespaceToggleEnabled) return
    onhidewhitespace?.(!hideWhitespace)
    if (!hideWhitespace) track('whitespace_hidden')
  }
</script>

<!-- Popover entry: the full finding body rendered as inline markdown (backticked
     code reads as <code>, never truncated). The body is the navigable menuitem
     (click → jump+flash the inline card / fallback). Add-as-draft + Dismiss live
     here too, because the popover is now the home for findings that aren't
     anchored in the visible diff (the old "bottom" file-level cards were removed).
     Simplify pass: the popover deliberately shows the ORIGINAL body (it is the
     full-detail navigation surface); only the finding CARDS display simpleBody.
     Add-as-draft here therefore uses the original — consistent with "the draft
     is whatever text was displayed". -->
{#snippet findingEntry(nav: NavFinding)}
  <div class="findings-popover-entry">
    <button
      type="button"
      role="menuitem"
      class="findings-popover-item"
      onclick={() => jumpToNavFinding(nav)}
    >
      <span class="findings-popover-loc">{nav.path}{nav.line !== null ? `:${nav.line}` : ''}</span>
      <!-- eslint-disable-next-line svelte/no-at-html-tags — renderInlineMarkdown sanitizes via DOMPurify -->
      <span class="findings-popover-body">{@html renderInlineMarkdown(nav.body)}</span>
    </button>
    <div class="findings-popover-actions">
      <button
        type="button"
        class="findings-popover-action"
        aria-label="Add as draft comment"
        onclick={(e) => { e.stopPropagation(); addFindingAsDraft({ findingPath: nav.path, line: nav.line, body: nav.body, key: nav.key, skillName: nav.skillName }) }}
      >Add as draft</button>
      <button
        type="button"
        class="findings-popover-action"
        aria-label="Dismiss finding"
        onclick={(e) => { e.stopPropagation(); dismissFinding(nav.key) }}
      >Dismiss</button>
      {#if hasAskFn}
        <button
          type="button"
          class="findings-popover-action"
          class:active={askOpenKey === nav.key}
          aria-label="Ask AI a follow-up about this finding"
          aria-expanded={askOpenKey === nav.key}
          data-testid="popover-ask-btn"
          onclick={(e) => { e.stopPropagation(); toggleAsk(nav.key) }}
        >Ask AI</button>
      {/if}
    </div>
    {#if hasAskFn && askOpenKey === nav.key && askFn}
      <!-- The keydown/click handlers stop the popover's roving-key + outside-click
           handlers from hijacking the textarea (arrow keys, typing). This wrapper
           is a passive container, not itself interactive. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="findings-popover-ask"
        role="group"
        aria-label="Ask AI"
        onkeydown={(e) => e.stopPropagation()}
        onclick={(e) => e.stopPropagation()}
      >
        <AskBox
          {askFn}
          focus={askFocusFor(nav)}
          onclose={() => (askOpenKey = null)}
        />
      </div>
    {/if}
  </div>
{/snippet}

{#if storyAvailable}
  <div class="flow-switch" role="group" aria-label="Inspect flow">
    <button
      class="flow-btn"
      class:flow-active={showStory}
      aria-pressed={showStory}
      disabled={storyTaskOff}
      title={storyTaskOff ? 'The story walkthrough task is turned off in AI settings' : undefined}
      onclick={() => selectMode(true)}
    >Story</button>
    <button
      class="flow-btn"
      class:flow-active={!showStory}
      aria-pressed={!showStory}
      onclick={() => selectMode(false)}
    >Files</button>
  </div>
{/if}

{#if storyAvailable && storyMode && storyTaskOff}
  <p class="story-fallback-note" role="note">
    Story walkthrough turned off — <a href="/settings" onclick={goToSettings}>enable in AI settings</a>. Showing all files.
  </p>
{:else if storyStructuralFallback}
  <p class="story-fallback-note story-structural-note" role="note">
    Structural walkthrough — AI ordering unavailable{storyFallbackReason ? ` (${storyFallbackReason})` : ''}.
    {#if onRetryStory}
      <button type="button" class="story-retry-btn" onclick={() => onRetryStory?.()}>Retry</button>
    {/if}
  </p>
{:else if storyErrored}
  <p class="story-fallback-note" role="note">
    Couldn't build the walkthrough{storyError ? ` — ${storyError}` : ''} Showing all files.
    {#if onRetryStory}
      <button type="button" class="story-retry-btn" onclick={() => onRetryStory?.()}>Retry</button>
    {/if}
  </p>
{:else if storyEmpty}
  <p class="story-fallback-note" role="note">
    Couldn't build a walkthrough for this PR — showing all files.
  </p>
{/if}

<div class="mode-toggle" role="group" aria-label="Diff mode">
  <button class="btn" class:btn-active={mode === 'unified'} aria-pressed={mode === 'unified'} onclick={() => onmode('unified')}>Unified</button>
  <button class="btn" class:btn-active={mode === 'split'} aria-pressed={mode === 'split'} onclick={() => onmode('split')}>Side-by-side</button>
  <button
    class="btn ws-toggle"
    class:btn-active={hideWhitespace && whitespaceToggleEnabled}
    aria-pressed={hideWhitespace && whitespaceToggleEnabled}
    disabled={!whitespaceToggleEnabled}
    title={whitespaceDisabledReason ?? 'Hide changes that only add or remove whitespace (like git diff -w)'}
    onclick={toggleHideWhitespace}
  >Hide whitespace</button>
  <button
    class="btn focus-toggle"
    class:btn-active={focusMode !== 'off'}
    aria-pressed={focusMode !== 'off'}
    title="Dim low-signal lines (imports, comments) so real changes stand out. Click to cycle: off → imports → imports + comments."
    onclick={cycleFocusMode}
  >{FOCUS_LABEL[focusMode]}</button>
  {#if hideWhitespace && whitespaceToggleEnabled && whitespaceOnlyCount > 0}
    <span class="ws-only-note" role="status">
      {whitespaceOnlyCount} whitespace-only file{whitespaceOnlyCount === 1 ? '' : 's'} hidden
    </span>
  {/if}
  {#if showRunButton}
    <button
      class="run-reviewers-btn"
      class:running={isRunning}
      onclick={() => !isRunning && runSkillReviewsFn?.()}
      disabled={isRunning}
      aria-busy={isRunning}
    >
      {#if isRunning}
        <Spinner size="0.75em" />Running…
      {:else}
        Run my reviewers ({enabledSkillCount})
      {/if}
    </button>
  {:else if showSkillsDisabled}
    <p class="reviewers-disabled-note">
      Reviewers disabled — <a href="/settings" onclick={goToSettings}>enable in AI settings</a>
    </p>
  {/if}
</div>

{#if skillReviews.length > 0}
  {@const runningEntries = skillReviews.filter(e => e.state.status === 'loading')}
  {@const queuedEntries = skillReviews.filter(e => e.state.status === 'queued')}
  {@const settledEntries = skillReviews.filter(e => e.state.status === 'done' || e.state.status === 'error')}

  <!-- RUNNING region: a BOUNDED, ALIGNED list of compact one-line rows. Each row
       is a small spinner + the reviewer NAME + (deep mode) ONLY its latest
       activity line (truncated). A single global "Running… (N)" indicator heads
       the block. aria-live announces the count, not every activity line, so
       screen readers aren't spammed by N concurrent logs. -->
  {#if runningEntries.length > 0}
    <div class="skill-running-region" aria-live="polite" aria-label="Reviewers running">
      <p class="skill-running-head">
        <Spinner size="0.75em" />Running… ({runningCount})
      </p>
      <ul class="skill-running-list">
        {#each runningEntries as entry (entry.skillId)}
          {@const activity = latestActivity(entry)}
          {@const expanded = expandedRunIds.has(entry.skillId)}
          <li class="skill-running-row">
            <Spinner size="0.7em" />
            <span class="skill-running-name">{entry.name}</span>
            {#if activity}
              {#if expanded}
                <ul class="skill-running-fulllog" aria-label="{entry.name} activity">
                  {#each entry.state.activity ?? [] as line, i (i)}
                    <li>{line}</li>
                  {/each}
                </ul>
              {:else}
                <span class="skill-running-activity" title={activity}>{activity}</span>
              {/if}
              <button
                type="button"
                class="skill-running-expand"
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${entry.name} activity` : `Expand ${entry.name} activity`}
                onclick={() => toggleExpandRun(entry.skillId)}
              >{expanded ? '⌃' : '⌄'}</button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- WAITING region: reviewers queued behind the concurrency cap. These have
       NOT started their LLM call yet, so they get a muted, spinner-free row —
       visually distinct from "Running…". As each running reviewer finishes a
       slot frees and one of these flips to the Running region (live). A single
       "Waiting (N)" head announces the count, not each transition. -->
  {#if queuedEntries.length > 0}
    <div class="skill-waiting-region" aria-live="polite" aria-label="Reviewers waiting">
      <p class="skill-waiting-head">
        ⏳ Waiting ({queuedCount})
      </p>
      <ul class="skill-waiting-list">
        {#each queuedEntries as entry (entry.skillId)}
          <li class="skill-waiting-row">
            <span class="skill-waiting-name">{entry.name}</span>
            <span class="skill-status-chip chip-queued" aria-label="Waiting for a slot">queued</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- CONVERGENCE status: the cross-reviewer consolidation pass that runs once
       after all reviewers settle. Loss-proof: on error we show a muted note and
       the original findings render unmerged — nothing is ever lost. -->
  {#if convergence?.status === 'loading'}
    <p class="convergence-status" role="status" aria-live="polite">
      <Spinner size="0.75em" />Consolidating overlapping findings…
    </p>
  {:else if convergence?.status === 'error'}
    <p class="convergence-error-note" role="note">
      Couldn't consolidate overlapping findings — showing all findings separately.
    </p>
  {/if}

  <!-- SIMPLIFY status: the plain-English rewrite pass that runs after the
       convergence pass settles. Loss-proof: on error we show a muted note
       (concrete upstream detail on hover, per the errorDetail machinery) and
       the cards render the original bodies — nothing is ever lost. -->
  {#if simplify?.status === 'loading'}
    <p class="convergence-status" role="status" aria-live="polite">
      <Spinner size="0.75em" />Simplifying findings…
    </p>
  {:else if simplify?.status === 'error'}
    <p
      class="convergence-error-note"
      role="note"
      title={[simplify.error?.trim(), simplify.errorDetail?.trim()].filter(Boolean).join(' — ') || undefined}
    >
      Couldn't simplify findings — showing the original text.
    </p>
  {/if}

  <!-- SETTLED region: done/error result chips, aligned and wrapping for many
       reviewers. An errored reviewer's chip is a real Retry BUTTON. -->
  {#if settledEntries.length > 0}
    <div class="skill-run-status-bar" role="status" aria-label="Reviewer run results">
      {#each settledEntries as entry (entry.skillId)}
        <span class="skill-run-entry">
          <span class="skill-run-name">{entry.name}</span>
          {#if entry.state.status === 'done'}
            <!-- Chip count mirrors the popover (navFindingsFor already drops
                 dismissed / added-as-draft findings) — so dismissing the last
                 finding from the popover flips the chip to "no significant issues". -->
            {@const findingCount = navFindingsFor(entry.skillId).length}
            {#if findingCount === 0}
              <span class="skill-status-chip chip-done" aria-label="Done, no significant issues">
                ✓ no significant issues
              </span>
            {:else}
              <span class="skill-chip-nav">
                <button
                  type="button"
                  class="skill-status-chip chip-done chip-nav"
                  data-reviewer-chip="result:{entry.skillId}"
                  aria-label="Show {findingCount} finding{findingCount !== 1 ? 's' : ''} from {entry.name}"
                  aria-haspopup="menu"
                  aria-expanded={isPopoverOpen('result', entry.skillId)}
                  onclick={() => activateReviewerChip('result', entry.skillId)}
                >
                  ✓ {findingCount} finding{findingCount !== 1 ? 's' : ''}
                </button>
                {#if isPopoverOpen('result', entry.skillId)}
                  <div
                    class="findings-popover"
                    role="menu"
                    tabindex="-1"
                    aria-label="{entry.name} findings"
                    onkeydown={(e) => handlePopoverKeydown(e, 'result', entry.skillId)}
                  >
                    {#each navFindingsFor(entry.skillId) as nav (nav.key)}
                      {@render findingEntry(nav)}
                    {/each}
                  </div>
                {/if}
              </span>
            {/if}
            {#if entry.state.toolCallsUsed !== undefined && entry.state.toolCallsUsed > 0}
              <span class="skill-deep-note" title="Deep review: this reviewer verified suspicions with tools before flagging">
                verified with {entry.state.toolCallsUsed} tool {entry.state.toolCallsUsed === 1 ? 'call' : 'calls'}
              </span>
            {/if}
            {#if settingsState.current.showTokenCost}
              {@const usageLabel = formatUsageLabel(entry.state.usage)}
              {#if usageLabel}
                <span class="skill-usage-footer" aria-label="Token usage">·· {usageLabel}</span>
              {/if}
            {/if}
          {:else if entry.state.status === 'error'}
            {@const errLead = entry.state.error?.trim() ? entry.state.error.trim() : ''}
            {@const errDetail = entry.state.errorDetail?.trim() ? entry.state.errorDetail.trim() : ''}
            <!-- Canned sentence + the CONCRETE upstream detail (provider error
                 body), so the hover explains the failure, not just its kind. -->
            {@const errText = [errLead, errDetail].filter(Boolean).join(' — ')}
            {#if onRetrySkill}
              <button
                type="button"
                class="skill-status-chip chip-error"
                aria-label={errText ? `${entry.name} failed: ${errText} — click to retry` : `Retry ${entry.name}`}
                title={errText ? `${errText} — click to retry` : 'Click to retry'}
                onclick={() => retryReviewer(entry.skillId)}
              >
                ↻ error
              </button>
            {:else}
              <span
                class="skill-status-chip chip-error"
                aria-label={errText ? `${entry.name} failed: ${errText}` : 'Error'}
                title={errText || undefined}
              >
                ↻ error
              </span>
            {/if}
          {:else}
            <span class="skill-status-chip chip-queued" aria-label="Queued">
              ⏳ queued
            </span>
          {/if}
        </span>
      {/each}
    </div>
  {/if}

{/if}

{#if files.length < changedFiles}
  <p role="alert">Showing {files.length} of {changedFiles} changed files — the list was truncated.</p>
{/if}
<svelte:document onkeydown={handleKeyDown} />

{#if files.length === 0}
  <p>This PR has no changed files.</p>
{:else if showStory && storyPending && !storyHasUsableSteps}
  <!-- Story task still running: unified AI progress — status line ("Ordering the
       walkthrough…") + (deep) activity log + content-shaped skeleton. -->
  <div class="story-skeleton" aria-label="Building the walkthrough">
    <AiProgress
      task="story"
      state={{ status: storyStatus, ...(storyActivity ? { activity: storyActivity } : {}) }}
      skeletonLines={6}
    />
  </div>
{:else if showStory && story}
  <StorySlideshow
    {story}
    {files}
    {mode}
    {draftStore}
    {viewedStore}
    {prComments}
    {resolvedCommentIds}
    {contentsMap}
    lineSkillFindingsByPath={lineSkillFindingsByPath}
    fileLevelSuggestionsByPath={fileLevelSuggestionsByPath}
    dismissedKeys={dismissedKeys}
    addedDraftKeys={addedDraftKeys}
    whitespaceByPath={whitespaceByPath}
    onAddDraft={handleAddDraft}
    onRemoveDraft={handleRemoveDraft}
    onAddFileLevelDraft={(suggestion) => addFindingAsDraft(suggestion)}
    onDismissFileLevelFinding={(key) => dismissFinding(key)}
    onAddSkillFindingDraft={(path, finding) => addFindingAsDraft({ findingPath: path, line: finding.line, body: finding.body, key: finding.key, skillName: finding.skillName, side: finding.side, originalBody: finding.originalBody })}
    onDismissSkillFinding={(key) => dismissFinding(key)}
    {askFn}
    {askDisabledReason}
    replyFn={replyFn}
    {diagrams}
  />
{:else}
  <div class="inspect-layout" class:diff-full={diffWidth === 'full'} data-diffwidth={diffWidth} bind:this={layoutEl}>
    <!-- Collapsible drawer. Two CSS regimes (see drawer CSS block below):
         MARGIN mode (centered + wide viewport): zero-width flex placeholder, nav extends LEFTWARD into the margin.
         INLINE mode (full-width OR narrower viewport): in-flow 340px flex child right of the tab; diff shrinks while open.
         DOM order: drawer first → tab second → diff column (margin mode anchors nav's right edge to the tab's LEFT edge;
         inline mode reorders the tab visually via flex `order`). -->
    <div class="file-tree-drawer" data-open={treeOpen ? 'true' : 'false'} aria-hidden={!treeOpen}>
      {#if treeOpen}
        <nav class="file-tree-nav" aria-label="File tree">
          <div class="tree-drawer-header">
            <span class="tree-drawer-title">Files</span>
            <button
              class="tree-drawer-close"
              onclick={closeTree}
              aria-label="Close file tree"
              title="Close file tree (Escape)"
            >✕</button>
          </div>
          <FileTree
            {files}
            {attention}
            {viewedStore}
            {activePath}
            onselect={handleTreeSelect}
          />
        </nav>
      {/if}
    </div>

    <!-- Slim toggle tab: at the content column's left edge (immediately right of drawer) -->
    <button
      bind:this={toggleTabEl}
      class="tree-toggle-tab"
      aria-expanded={treeOpen}
      aria-label={treeOpen ? 'Close file tree' : 'Open file tree'}
      onclick={toggleTree}
      title={treeOpen ? 'Close file tree (Escape)' : 'Open file tree'}
    >
      <span class="tree-toggle-icon" aria-hidden="true">{treeOpen ? '‹' : '☰'}</span>
      <span class="tree-toggle-label">Files</span>
    </button>

    <!-- No backdrop in any regime: the drawer never overlays the diff. In inline
         mode it pushes the diff over (flex), in margin mode it dwells in the margin. -->
    <div class="diff-column" bind:this={diffColEl}>
      {#each orderedFiles as file (file.filename)}
        <div id="file-{slugify(file.filename)}">
          {#if hotspotMap.has(file.filename)}
            {@const hotspot = hotspotMap.get(file.filename)!}
            <div class="hotspot-badge level-{hotspot.level}">
              <span class="hotspot-level">{hotspot.level}</span>
              <span class="hotspot-reason">{file.filename} — {hotspot.reason}</span>
            </div>
          {/if}
          {#if fileRiskByPath.get(file.filename)?.show}
            {@const risk = fileRiskByPath.get(file.filename)!}
            <div
              class="file-risk-chip risk-{risk.level}"
              role="note"
              title="Deterministic review-effort estimate from churn, findings and path — advisory, not a defect prediction"
            >
              <span class="file-risk-label">review effort</span>
              <span class="file-risk-level">{risk.level}</span>
            </div>
          {/if}
          {#if testFlagSet.has(file.filename)}
            <div class="test-flag-warning" role="note">
              AI-inferred — not measured coverage
            </div>
          {/if}
          <!-- File-level (null-line) finding cards used to render here as a
               separate "bottom" block, duplicating what the reviewer-chip popover
               now shows in full (markdown body + Add as draft / Dismiss). The
               redundant block was removed; null-line findings live in the popover.
               Anchored, in-diff SkillFindingCards still render inline via FileDiff. -->
          <FileDiff
            {file}
            {mode}
            {currentHeadSha}
            drafts={draftsForFile(file.filename)}
            comments={commentsForFile(file.filename)}
            {resolvedCommentIds}
            onAddDraft={(line, side, body, n) => handleAddDraft(file.filename, line, side, body, n)}
            onRemoveDraft={(line, side, n) => handleRemoveDraft(file.filename, line, side, n)}
            viewed={viewedStore?.isViewed(file.filename, file.patch) ?? false}
            changedSinceViewed={viewedStore?.changedSinceViewed(file.filename, file.patch) ?? false}
            onToggleViewed={() => handleToggleViewed(file)}
            contents={contentsMap?.get(file.filename)}
            {askFn}
            {askDisabledReason}
            onReply={replyFn}
            skillFindings={lineSkillFindingsByPath.get(file.filename) ?? []}
            onAddSkillFindingDraft={(finding) => addFindingAsDraft({ findingPath: file.filename, line: finding.line, body: finding.body, key: finding.key, skillName: finding.skillName, side: finding.side, originalBody: finding.originalBody })}
            onDismissSkillFinding={(key) => dismissFinding(key)}
            whitespace={whitespaceByPath.get(file.filename) ?? null}
          />
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /*
   * ==========================================================================
   * DRAWER CSS — TWO ADAPTIVE REGIMES (pure CSS, no JS viewport tracking)
   *
   * MARGIN mode — centered diff AND viewport ≥ 1750px (the left margin beside
   *   the 70rem column can fit the whole 340px tree): the drawer wrapper is a
   *   zero-width flex placeholder and the nav extends LEFTWARD into the margin.
   *   The diff column never moves. Exactly the historical wide behaviour.
   *
   * INLINE mode — everything else (full-width mode at ANY viewport, or a
   *   viewport too narrow for the margin): the drawer becomes an in-flow
   *   340px flex child to the RIGHT of its toggle tab, pushing the diff over.
   *   The diff shrinks while the tree is open — no overlay, no backdrop, the
   *   tree is always fully readable.
   *
   * Threshold derivation (1750px): the centered column is 70rem = 1050px at the
   * 15px root font plus 2 × 1rem .review padding → 1080px outer. The tree needs
   * 340px left of the column's content edge: (1750 − 1080) / 2 + 15 ≈ 350px. ✓
   * ==========================================================================
   */

  /* Inspect layout: relative+overflow-visible container for the drawer */
  .inspect-layout {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0;
    overflow: visible;
    /* Tree width: 340px, but never wider than the viewport minus tab + gutters */
    --tree-w: min(340px, calc(100vw - 80px));
  }

  /* Diff width: full mode overrides the content max-width via CSS custom property */
  .inspect-layout.diff-full {
    --content-max: none;
    max-width: none;
  }

  /* ---- Toggle tab: slim vertical strip at the content column's left edge ---- */
  /* INLINE mode (default): tab is visually FIRST (order -1) so the drawer opens
     to the RIGHT of its toggle. Margin mode restores DOM order (drawer | tab). */
  .tree-toggle-tab {
    order: -1;
    position: sticky;
    top: 0.5rem; /* same top as the drawer in both regimes */
    flex-shrink: 0;
    width: 28px;
    height: calc(100vh - 5rem);
    max-height: calc(100vh - 5rem);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 0.75rem 0 0.5rem;
    gap: 0.4rem;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    cursor: pointer;
    color: inherit;
    font-size: 0.78rem;
    z-index: 21; /* above the drawer's z-index so tab stays clickable */
    transition: background 0.15s;
    align-self: flex-start;
  }

  .tree-toggle-tab:hover {
    background: var(--surface-hover, color-mix(in srgb, var(--surface-raised) 80%, var(--text) 10%));
  }

  .tree-toggle-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .tree-toggle-icon {
    font-size: 1rem;
    line-height: 1;
  }

  .tree-toggle-label {
    writing-mode: vertical-lr;
    text-orientation: mixed;
    transform: rotate(180deg);
    font-size: 0.7rem;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    user-select: none;
  }

  /* ---- Collapsible drawer — sticky wrapper + nav panel anchored to its right edge ----
   *
   * The wrapper (.file-tree-drawer) is a sticky flex child. The nav panel
   * (.file-tree-nav) is absolutely positioned inside it, anchored to the
   * wrapper's RIGHT edge (right: 0).
   *
   * INLINE mode (default): the open wrapper is var(--tree-w) wide, so the nav
   *   exactly fills it IN FLOW — real flex space, the diff column shrinks.
   * MARGIN mode (media override below): the open wrapper stays 0 wide, so the
   *   nav extends 340px LEFTWARD into the page margin — out of flow, the diff
   *   column never moves.
   *
   * position: sticky on the wrapper gives scroll-following in both regimes.
   */
  .file-tree-drawer {
    position: sticky; /* sticky anchor follows scroll */
    top: 0.5rem;
    width: 0;
    flex-shrink: 0;
    align-self: flex-start;
    z-index: 20;
    max-height: calc(100vh - 5rem);
    overflow: visible; /* allow the absolutely-positioned nav to extend leftward */
  }

  /* INLINE mode (default): the open drawer takes real flex space → diff shrinks */
  .file-tree-drawer[data-open='true'] {
    width: var(--tree-w);
    margin: 0 0.75rem 0 0.5rem; /* breathing room: tab ←0.5rem→ tree ←0.75rem→ diff */
  }

  .file-tree-nav {
    /* Anchored to the wrapper's right edge; fills the wrapper in inline mode,
       extends leftward past it (width 0) in margin mode */
    position: absolute;
    right: 0;
    top: 0;
    width: var(--tree-w);
    box-sizing: border-box; /* total width = var(--tree-w) including border + padding */
    /* Clamp: min(viewport cap, diff column height) — the tree must never run
       past the end of the diff it accompanies. --diff-col-h is kept current by
       a ResizeObserver on .diff-column (see observeDiffColHeight). The 12rem
       floor keeps the tree usable beside a tiny diff: a tree squashed to three
       rows is worse than a slight overhang. Applies in BOTH drawer regimes —
       this same element is the visible panel in inline and margin mode. */
    max-height: min(calc(100vh - 5rem), max(12rem, var(--diff-col-h, 100vh)));
    overflow-y: auto;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.5rem 0.25rem;
    scrollbar-width: thin;
    box-shadow: -2px 4px 20px rgba(0, 0, 0, 0.22);
  }

  /* ---- MARGIN mode: centered diff + viewport wide enough for the 340px tree ---- */
  @media (min-width: 1750px) {
    .inspect-layout:not(.diff-full) .file-tree-drawer[data-open='true'] {
      width: 0;   /* zero-width placeholder again — nav extends into the margin */
      margin: 0;
    }
    .inspect-layout:not(.diff-full) .tree-toggle-tab {
      order: 0;   /* restore DOM order: drawer (leftward nav) | tab | diff */
    }
  }

  /* Drawer header: "Files" label + ✕ close button */
  .tree-drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3rem 0.5rem 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    margin-bottom: 0.25rem;
  }

  .tree-drawer-title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    user-select: none;
  }

  .tree-drawer-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.8rem;
    line-height: 1;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tree-drawer-close:hover {
    color: var(--text);
    background: var(--surface-hover, color-mix(in srgb, var(--surface-raised) 80%, var(--text) 10%));
  }

  .tree-drawer-close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* ---- Diff column: takes the remaining flex space ---- */
  /* In inline mode the open drawer consumes flex space and the diff shrinks
     naturally; in margin mode the drawer is out of flow and the diff is untouched. */
  .diff-column {
    min-width: 0;
    flex: 1;
  }

  /* ---- Story | Files flow switch (Plan H) ---- */
  .flow-switch {
    display: inline-flex;
    gap: 0;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    padding: 0.15rem;
    margin-bottom: 0.5rem;
  }
  .flow-btn {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.25rem 0.9rem;
    border-radius: 999px;
    cursor: pointer;
  }
  .flow-btn.flow-active {
    background: var(--accent);
    color: var(--surface, #fff);
  }
  .story-fallback-note {
    font-size: 0.82rem;
    color: var(--text-muted);
    margin: 0 0 0.5rem;
  }
  /* Structural-fallback note is even more understated — the walkthrough still
     renders below it, so the note is informational, not an error. */
  .story-structural-note {
    opacity: 0.85;
    font-size: 0.78rem;
  }
  .story-retry-btn {
    margin-left: 0.4rem;
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: transparent;
    color: var(--accent);
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }
  .story-retry-btn:hover { background: var(--surface-raised); }
  .story-retry-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .story-skeleton {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 0.5rem 0;
  }

  /* Mode toggle: active state via accent underline, consistent with stepper */
  .mode-toggle .btn-active {
    border-bottom: 2px solid var(--accent);
    font-weight: 700;
    color: var(--accent);
  }
  .mode-toggle .btn {
    border-radius: 4px 4px 0 0; /* flat bottom, pairs with underline indicator */
  }
  .ws-toggle:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ws-only-note {
    font-size: 0.78rem;
    color: var(--text-muted);
    align-self: center;
    margin-left: 0.4rem;
  }
  .run-reviewers-btn { margin-left: auto; }

  /* Plan J: compact muted note when reviewers are turned off in AI settings. */
  .reviewers-disabled-note {
    margin: 0 0 0 auto;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .reviewers-disabled-note a {
    color: var(--accent);
  }

  .hotspot-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    border-left: 3px solid currentColor;
  }

  .hotspot-badge.level-high { color: var(--legend-removed-color); background: var(--legend-removed-bg); }
  .hotspot-badge.level-medium { color: var(--legend-changed-color); background: var(--legend-changed-bg); }
  .hotspot-badge.level-low { color: var(--text-muted); background: var(--surface-raised); }

  .hotspot-level {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .hotspot-reason {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    word-break: break-word;
  }

  .test-flag-warning {
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    background: var(--legend-changed-bg);
    color: var(--legend-changed-color);
    border-left: 3px solid var(--legend-changed-border);
  }

  /* ---- Per-file review-effort chip (deterministic risk) ---- */

  .file-risk-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
    font-size: 0.72rem;
    margin-bottom: 0.25rem;
    border: 1px solid currentColor;
  }

  .file-risk-chip.risk-high { color: var(--legend-removed-color); background: var(--legend-removed-bg); }
  .file-risk-chip.risk-medium { color: var(--legend-changed-color); background: var(--legend-changed-bg); }
  .file-risk-chip.risk-low { color: var(--text-muted); background: var(--surface-raised); }

  .file-risk-label {
    opacity: 0.75;
    white-space: nowrap;
  }

  .file-risk-level {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 0.68rem;
    letter-spacing: 0.05em;
  }

  /* ---- Run button ---- */
  .run-reviewers-btn {
    margin-left: auto;
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .run-reviewers-btn:hover:not(:disabled) {
    background: var(--surface-raised);
  }

  .run-reviewers-btn:disabled {
    cursor: default;
    opacity: 0.85;
  }

  /* ---- Running reviewers: bounded, aligned compact list ----
     One row per running reviewer: spinner + name + (deep) latest activity line.
     Fixed row height + aligned columns keep the block calm regardless of how
     many reviewers run concurrently — NOT N stacked full activity logs. */
  .skill-running-region {
    padding: 0.4rem 0;
  }

  /* CONVERGENCE status — the cross-reviewer consolidation pass. */
  .convergence-status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.2rem 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .convergence-error-note {
    margin: 0.2rem 0;
    font-size: 0.78rem;
    color: var(--text-muted);
    opacity: 0.85;
  }

  /* WAITING region — queued reviewers that have NOT started their LLM call.
     Muted and spinner-free, visually distinct from the active "Running…" rows. */
  .skill-waiting-region {
    padding: 0.2rem 0 0.4rem;
  }

  .skill-waiting-head {
    margin: 0 0 0.3rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    opacity: 0.85;
  }

  .skill-waiting-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.75rem;
  }

  .skill-waiting-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
  }

  .skill-waiting-name {
    color: var(--text-muted);
    font-weight: 500;
  }

  .skill-running-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.35rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .skill-running-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    /* spinner | name (content, capped) | activity (rest) | expand */
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.25rem 0.6rem;
  }

  .skill-running-row {
    display: grid;
    grid-template-columns: subgrid;
    grid-column: 1 / -1;
    align-items: center;
    min-height: 1.5rem;
  }

  /* The spinner sits in the first cell before the name; align it. */
  .skill-running-row > :global(.ui-spinner) {
    grid-column: 1;
  }

  .skill-running-name {
    grid-column: 2;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 16rem;
  }

  /* ONLY the latest activity line, truncated with ellipsis — not the full log. */
  .skill-running-activity {
    grid-column: 3 / 4;
    font-size: 0.75rem;
    font-family: var(--font-mono, monospace);
    color: var(--text-muted);
    opacity: 0.85;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    justify-self: start;
  }

  /* Expanded: the full activity log spans the activity column. */
  .skill-running-fulllog {
    grid-column: 3 / 4;
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 0.75rem;
    font-family: var(--font-mono, monospace);
    color: var(--text-muted);
    opacity: 0.85;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .skill-running-fulllog li {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .skill-running-expand {
    grid-column: 4;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.85rem;
    line-height: 1;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  .skill-running-expand:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .skill-running-expand:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* ---- Per-reviewer run results bar (settled chips) ---- */
  .skill-run-status-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    padding: 0.4rem 0;
    font-size: 0.8rem;
    align-items: center;
  }

  .skill-run-entry {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .skill-run-name {
    color: var(--text-muted);
    font-weight: 500;
  }

  .skill-status-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .skill-deep-note {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .skill-usage-footer {
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    opacity: 0.7;
  }

  .chip-queued {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
  }

  .chip-done {
    background: var(--legend-added-bg);
    border: 1px solid var(--legend-added-border);
    color: var(--legend-added-color);
  }

  .chip-error {
    background: var(--legend-removed-bg);
    border: 1px solid var(--legend-removed-border);
    color: var(--legend-removed-color);
    cursor: pointer;
  }

  /* ---- Chip → finding navigation (result + suggestion chips) ---- */
  /* Wrapper anchors the popover to the chip. */
  .skill-chip-nav {
    position: relative;
    display: inline-flex;
  }

  /* A result chip that navigates to its findings: same look, now a real button
     with a discoverable (subtle) affordance — pointer + hover/focus emphasis. */
  button.skill-status-chip.chip-nav {
    cursor: pointer;
    font: inherit;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    transition: filter 0.12s, box-shadow 0.12s;
  }
  button.skill-status-chip.chip-nav:hover {
    filter: brightness(1.06);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  button.skill-status-chip.chip-nav:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }


  /* Disclosure popover listing a reviewer's findings. Wide enough to read a full
     finding body comfortably (Fix B) — no truncation; entries carry actions. */
  .findings-popover {
    position: absolute;
    top: calc(100% + 0.3rem);
    left: 0;
    z-index: 30;
    min-width: 22rem;
    max-width: min(40rem, 90vw);
    max-height: 28rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.25rem;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.22);
    scrollbar-width: thin;
  }

  /* Each entry = the navigable (jump) body + its Add/Dismiss action row. */
  .findings-popover-entry {
    display: flex;
    flex-direction: column;
    border-radius: 4px;
  }
  .findings-popover-entry:hover {
    background: var(--surface-hover, color-mix(in srgb, var(--surface-raised) 80%, var(--text) 12%));
  }
  .findings-popover-entry + .findings-popover-entry {
    border-top: 1px solid var(--border-subtle);
  }

  .findings-popover-item {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    align-items: flex-start;
    text-align: left;
    width: 100%;
    padding: 0.4rem 0.5rem 0.2rem;
    border: none;
    border-radius: 4px 4px 0 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .findings-popover-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .findings-popover-loc {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
    word-break: break-all;
  }

  /* Full finding body, rendered as inline markdown (code spans / emphasis / links). */
  .findings-popover-body {
    font-size: 0.82rem;
    line-height: 1.45;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .findings-popover-body :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    padding: 0.05em 0.3em;
    border-radius: 3px;
    background: color-mix(in srgb, var(--text) 10%, transparent);
  }
  .findings-popover-body :global(a) {
    color: var(--accent);
  }

  .findings-popover-actions {
    display: flex;
    gap: 0.4rem;
    padding: 0 0.5rem 0.4rem;
  }
  .findings-popover-action {
    font: inherit;
    font-size: 0.72rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }
  .findings-popover-action:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .findings-popover-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .findings-popover-action.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  .findings-popover-ask {
    padding: 0 0.5rem 0.5rem;
  }

  /* The error chip is a real Retry button — reset button defaults so it matches
     the chip span visually, and add hover/focus affordances. */
  button.chip-error {
    font-family: inherit;
    line-height: 1.2;
  }

  button.chip-error:hover {
    background: color-mix(in srgb, var(--legend-removed-bg) 80%, var(--text) 12%);
  }

  button.chip-error:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* File-level (null-line) finding cards stack above the FileDiff */
  .file-level-finding {
    margin-bottom: 0.4rem;
  }
</style>
