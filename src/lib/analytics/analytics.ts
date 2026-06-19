import posthog from 'posthog-js'

// Allowlist schema: event -> permitted property names. The ONLY path to
// PostHog. Adding a property here is a privacy decision — never allow
// code, diffs, keys, tokens, or private repo identifiers.
const EVENTS = {
  pr_loaded: ['visibility', 'file_count', 'primary_language'],
  signed_in: ['method'],
  // PRIVACY DECISION: 'tokens' is a token count (integer), not content.
  // It tells us how many tokens were consumed per task; it cannot be used
  // to reconstruct code or diffs. Added for cost observability only.
  // PRIVACY DECISION (Plan G): 'deep' is a boolean mode flag and 'tool_calls'
  // is a count of verification tool invocations — neither carries file paths,
  // queries, or content. Added for deep-review cost/precision observability.
  // PRIVACY DECISION (coach batching): 'chunks' is the integer count of LLM
  // calls a coach run split into, and 'partial' is a boolean (some chunks
  // failed) — neither carries comment bodies, code, file paths, or counts of
  // content. Added for coach-robustness observability only.
  ai_task_completed: ['task', 'duration_ms', 'cached', 'tokens', 'deep', 'tool_calls', 'chunks', 'partial'],
  ai_task_failed: ['task', 'reason', 'partial'],
  // PRIVACY DECISION (robust big-PR story): fired when the story task degrades
  // to the deterministic structural walkthrough (AI ordering failed or returned
  // an unusable result). Carries only 'task' ('story') and 'reason' — a
  // humanized failure summary (LlmError kind/message), the SAME class of string
  // already sent as ai_task_failed.reason. Never diff content, code, or paths.
  ai_task_fallback: ['task', 'reason'],
  // PRIVACY DECISION (Plan J — per-task AI modes): fired when the user changes
  // a task's run mode in AI settings. Carries only 'task' (a stable task id like
  // 'diagrams') and 'mode' ('off' | 'standard' | 'deep') — both fixed enums,
  // never a file path, diff content, key, or any user-generated text.
  ai_task_mode_changed: ['task', 'mode'],
  // PRIVACY DECISION (Plan — accept/dismiss telemetry loop): fired when the user
  // ACCEPTS ('Add as draft') or DISMISSES an AI finding. This accept/dismiss
  // signal is the best real-world precision measure and was previously discarded.
  // Props are ids / enums / counts ONLY — NEVER finding text, code, file paths,
  // line numbers, or comment bodies:
  //   - 'reviewer'      : the reviewer/skill id, or 'builtin:<name>' for a non-skill
  //                       source. A stable identifier, never user code or a path.
  //   - 'severity'      : 'high' | 'medium' | 'low' — fixed enum.
  //   - 'deep'          : boolean — was deep (tool-using) review on for this run.
  //   - 'crossVerified' : boolean — did cross-model verification run on this finding.
  //   - 'confirmedBy'   : integer count of models that confirmed it (0 when none).
  //   - 'polledModels'  : integer count of models polled (0 when verification absent).
  //   - 'fusionMode'    : 'verify' | 'generate' — the ensemble mode, when known.
  //   - 'raisedByCount' : integer count of models that independently RAISED it.
  // None of these can reconstruct the finding's content, the diff, or repo data.
  ai_finding_accepted: ['reviewer', 'severity', 'deep', 'crossVerified', 'confirmedBy', 'polledModels', 'fusionMode', 'raisedByCount'],
  ai_finding_dismissed: ['reviewer', 'severity', 'deep', 'crossVerified', 'confirmedBy', 'polledModels', 'fusionMode', 'raisedByCount'],
  diagram_viewed: [],
  hotspot_clicked: [],
  ci_summary_viewed: ['conclusion'],
  comment_drafted: [],
  // PRIVACY DECISION: 'ok' is a boolean outcome only — no body content,
  // thread ids, or repo identifiers are ever sent.
  reply_posted: ['ok'],
  // PRIVACY DECISION: fired when a reviewer copies a permalink to an existing
  // comment via the per-comment menu. Carries NOTHING — no URL, comment id,
  // body, author, repo, or PR identifier. It is a pure interaction counter
  // ("did anyone use copy-link?"), ids-only being the empty set here.
  comment_link_copied: [],
  review_submitted: ['verdict', 'comment_count'],
  // PRIVACY DECISION: 'item_count' is an integer count of drafted items exported
  // when the reviewer clicks "Copy as LLM prompt". No comment bodies, code,
  // diffs, file paths, or PR identifiers are sent — counts only.
  review_prompt_copied: ['item_count'],
  // PRIVACY DECISION: fired when the reviewer clicks "Copy review command".
  // Carries only 'format' (the export format id: 'browser' | 'gh' | 'curl') and
  // 'item_count' (integer count of drafted line comments). No comment bodies,
  // code, diffs, file paths, tokens, or PR identifiers are sent — counts only.
  review_command_copied: ['format', 'item_count'],
  settings_key_added: ['service'],
  // PRIVACY DECISION: engagement events below carry section/surface identifiers only.
  // 'section' is a stable registry id (e.g. 'summary', 'diagrams', 'queue', 'recent') —
  // never a file path, diff content, PR title, or any user-generated text.
  // 'surface' is 'page' | 'rail' | 'landing' — a layout location, not content.
  // 'origin' is 'viewed' | 'dim' — the collapse reason, not file identity.
  // 'step' is '1' | '2' | '3' — step index only.
  // None of these can be used to reconstruct code, diffs, or private repo data.
  section_expanded: ['section', 'surface'],
  // PRIVACY DECISION: fired when the user clicks "Expand all" / "Collapse all"
  // on the Understand step. Carries only 'expanded' (boolean — whether the click
  // opened or closed every section) and 'surface' ('page'). No content.
  expand_all: ['expanded', 'surface'],
  file_expanded: ['origin'],
  drawer_opened: [],
  // Carries no content — fired when the user turns ON "Hide whitespace changes".
  whitespace_hidden: [],
  // Carries no content — fired when the user turns ON focus mode (any non-off).
  focus_mode_on: [],
  rail_expanded: [],
  step_viewed: ['step'],
  // PRIVACY DECISION (Plan H — Story mode): neither event carries content.
  // 'story_mode_entered' fires when the user switches step 2 to the narrative
  // walkthrough — no properties. 'story_step_viewed' carries 'index', the
  // integer step position only (never a file path, caption, or diff content),
  // for walkthrough-engagement observability.
  story_mode_entered: [],
  story_step_viewed: ['index'],
  // PRIVACY DECISION (Plan K — story coverage): fired ONCE per walkthrough when
  // the user has seen every unique changed file. Carries only 'files' — the
  // integer count of unique changed files covered (never a path, caption, or any
  // diff content) — for "did users actually walk the whole PR?" observability.
  story_coverage_complete: ['files'],
  // PRIVACY DECISION (Plan I — function↔test pairing): fired when the user
  // expands an inline "tested by" snippet beneath a changed function. Carries
  // only 'confidence' ('named' | 'referenced') — the pairing-confidence label.
  // Never a symbol name, test title, file path, or any code/diff content.
  symbol_test_expanded: ['confidence'],
  // Fired when the user opens the original PR/MR in its native provider UI via
  // the "View on <Provider>" header link. Carries only 'provider' (the provider
  // id: 'github' | 'gitlab' | 'bitbucket') — never a URL, owner, repo, or number.
  original_pr_opened: ['provider'],
  // Fired when the user opens the bundled "Try a live demo" onboarding path from
  // the landing page. No props — it's a pure navigation signal.
  demo_opened: [],
  // PRIVACY DECISION: fired ONCE per loaded PR when the skill reviewers are
  // auto-started early (opt-out setting on, while the user is still on step 1).
  // Carries only 'count' — the integer number of enabled reviewers kicked off.
  // Never a path, persona name, finding, or any code/diff content.
  reviewers_auto_started: ['count'],
} as const

export type EventName = keyof typeof EVENTS
type AllowedProps<E extends EventName> = Partial<Record<(typeof EVENTS)[E][number], string | number | boolean>>

type CaptureFn = (event: string, props: Record<string, unknown>) => void
let capture: CaptureFn = posthog.capture.bind(posthog)
export function _setCaptureForTest(fn: CaptureFn): void { capture = fn }

// Seam for testing posthog.init config — replaced by spy in init tests.
type PosthogLike = { init: (key: string, opts: Record<string, unknown>) => void }
let _posthog: PosthogLike = posthog as unknown as PosthogLike
export function _setPosthogForTest(ph: PosthogLike): void { _posthog = ph }

export function initAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
  if (!key) return // analytics disabled without a key
  // session_recording.maskAllInputs + maskTextSelector='*': masks ALL visible text
  // in session replays — a code-review tool must never record readable code.
  // Interaction patterns and layout remain useful for UX analysis.
  // capture_exceptions: true — forwards unhandled JS errors to PostHog error
  // tracking. Stack traces may include file paths but never code content.
  _posthog.init(key, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com',
    autocapture: false, // only typed events pass the choke-point
    capture_pageview: true,
    capture_exceptions: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
    },
  })
}

export function track<E extends EventName>(event: E, props: AllowedProps<E> = {} as AllowedProps<E>): void {
  const allowed = EVENTS[event] as readonly string[] | undefined
  if (!allowed) return // defense-in-depth: guard against as-never bypasses at runtime
  const safe: Record<string, unknown> = {}
  for (const k of allowed) if (k in (props as Record<string, unknown>)) safe[k] = (props as Record<string, unknown>)[k]
  try {
    capture(event, safe)
  } catch {
    // analytics must never break the app (EC-18g)
  }
}
