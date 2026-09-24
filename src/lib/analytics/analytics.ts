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
  // PRIVACY DECISION (finding convergence): 'clusters' is the integer count of
  // overlap clusters the convergence pass produced — a count only, never
  // finding text, code, file paths, or reviewer names. Added so we can observe
  // how often reviewers actually overlap (merge-rate observability).
  // PRIVACY DECISION (finding simplify): 'rewrites' is the integer count of
  // finding bodies the simplify pass rewrote — a count only, never finding
  // text, code, or file paths. Added for rewrite-rate observability.
  // PRIVACY DECISION (#237 reviewer passes): 'pass' is 'implementation' |
  // 'tests' — WHICH reviewer pass a 'skill-review' task belonged to. A fixed
  // two-value enum naming a code path, never a file path, persona name,
  // finding, or any code content. Without it the two passes are one
  // indistinguishable blob in the task metrics, even though they have
  // different prompts, different contexts and very different costs.
  ai_task_completed: ['task', 'duration_ms', 'cached', 'tokens', 'deep', 'tool_calls', 'chunks', 'partial', 'clusters', 'rewrites', 'pass'],
  // PRIVACY DECISION (error-detail surfacing): 'reason_detail' is the concrete
  // upstream failure text behind the coarse 'reason' kind — the provider's OWN
  // error body (e.g. "insufficient quota", "maximum context length exceeded")
  // or an internal error message, truncated to 120 chars at the call site. It
  // is provider/tool-generated text about request shape or account state —
  // never diff content, code, prompts, or API keys (mapHttpError's detail path
  // already guarantees key-free bodies; providers do not echo request bodies).
  // Added so the failure mix is measurable (which real reasons dominate each
  // kind) instead of a 7-value enum.
  // PRIVACY BOUNDARY (JSON robustness): an 'invalid-output' failure ALSO knows
  // a short excerpt of what the MODEL actually returned — which paraphrases the
  // user's own code and must never be sent. That excerpt lives on
  // TaskErrorInfo.errorDetail (local UI tooltip only); reason_detail is fed
  // exclusively from TaskErrorInfo.analyticsDetail, which omits it and carries
  // only the machine-classified cause ("no valid JSON could be parsed from the
  // reply" / "the JSON did not match the expected shape", plus whether the
  // reply was cut off at the output limit). No new property is needed: the
  // truncation signal rides inside that same classified sentence.
  // 'pass' rides here for the same reason it rides on ai_task_completed: a
  // failure rate that cannot tell the agentic whole-PR tests pass from the
  // scoped implementation pass is not a failure rate anyone can act on.
  ai_task_failed: ['task', 'reason', 'reason_detail', 'partial', 'pass'],
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
  // PRIVACY DECISION (dismissal calibration): ai_finding_dismissed also carries
  //   - 'reason' : 'not-real' | 'not-worth' | 'none' — the one-click dismissal
  //                reason (or 'none' for a plain dismiss). A fixed enum only;
  //                the calibration LEDGER (finding patterns) stays local and is
  //                never sent.
  ai_finding_accepted: ['reviewer', 'severity', 'deep', 'crossVerified', 'confirmedBy', 'polledModels', 'fusionMode', 'raisedByCount'],
  ai_finding_dismissed: ['reviewer', 'severity', 'deep', 'crossVerified', 'confirmedBy', 'polledModels', 'fusionMode', 'raisedByCount', 'reason'],
  // PRIVACY DECISION (finding re-anchor): fired when the user MOVES an AI
  // finding to a corrected diff line (drag or the "Move to line…" keyboard
  // path). Props are enums / booleans / a line DELTA only:
  //   - 'method'          : 'drag' | 'keyboard' — fixed enum input path.
  //   - 'distance'        : integer ABS delta between the reported line and the
  //                         corrected line — a relative offset that cannot
  //                         locate code (omitted for file-level findings that
  //                         had no reported line).
  //   - 'same_side'       : boolean — corrected anchor is on the finding's
  //                         reported (RIGHT/new-file) side.
  //   - 'off_diff_rescue' : boolean — the reported anchor wasn't a renderable
  //                         diff line (the move rescued it from the fallback
  //                         block).
  // NEVER absolute line numbers, file paths, finding text, or any code content.
  finding_moved: ['method', 'distance', 'same_side', 'off_diff_rescue'],
  // Fired when the user undoes a move (✕ on the "moved from line N" chip).
  // Carries NOTHING — a pure interaction counter, like comment_link_copied.
  finding_move_undone: [],
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
  // PRIVACY DECISION (symbol click-through): fired when clicking an identifier
  // in the diff opens the symbol popover. Carries only 'definitions' and
  // 'references' — integer COUNTS of what the popover listed. Never the symbol
  // name, file paths, line numbers, or any code content.
  symbol_popover_opened: ['definitions', 'references'],
  // PRIVACY DECISION (Tier 2 repo-wide symbol search): fired ONCE per search
  // that ACTUALLY RUNS — a cache miss that hits the provider's code-search API.
  // Cache hits (settled or in-flight re-clicks) fire nothing: no quota was
  // spent and no work ran. Props are enums / counts / a duration only:
  //   - 'outcome'       : 'success' | 'rate_limited' | 'unauthorized' | 'error'.
  //   - 'definitions'   : integer count of definitions found (success only).
  //   - 'references'    : integer count of references found (success only).
  //   - 'files_scanned' : integer count of result files fetched + indexed.
  //   - 'files_skipped' : integer count dropped (gone at head / over size cap).
  //   - 'duration_ms'   : elapsed ms (same convention as ai_task_completed).
  // NEVER the searched symbol name, file paths, snippets, repo identifiers, or
  // any code content — counts cannot reconstruct what was searched or found.
  symbol_repo_searched: ['outcome', 'definitions', 'references', 'files_scanned', 'files_skipped', 'duration_ms'],
  drawer_opened: [],
  // Carries no content — fired when the user turns ON "Hide whitespace changes".
  whitespace_hidden: [],
  // PRIVACY DECISION (#241 per-hunk attention): the within-file attention layer
  // recedes hunks it classified as MECHANICAL behind a marker. Both events say
  // whether that classifier is earning its place, and neither can say anything
  // about the code it classified:
  //   - hunk_restored.'changed' : integer count of CHANGED LINES in the hunk the
  //     user un-receded — the same number already printed on the marker. A size,
  //     not a location: never the path, the hunk index, the line numbers, the
  //     classifier's summary, or one character of the diff. It answers "are
  //     people rescuing big hunks (the classifier is wrong) or one-liners?".
  //   - hunk_focus_toggled.'enabled' : boolean — the new state of the Inspect
  //     toolbar toggle. Unlike focus_mode_on (ON only), BOTH directions matter
  //     here: turning the layer off is the signal that it is getting in the way.
  hunk_restored: ['changed'],
  hunk_focus_toggled: ['enabled'],
  // PRIVACY DECISION (#272 hide-resolved threads): the Inspect toolbar can
  // exclude already-resolved comment threads. Carries only
  //   - 'enabled' : boolean — the new state of the toggle.
  // Modelled exactly on hunk_focus_toggled, and for the same reason: BOTH
  // directions matter, because turning it back off is the signal that hiding
  // resolved conversations lost the reviewer something they wanted. Never the
  // thread count, thread bodies, author logins, file paths, or repo identity —
  // a boolean cannot reconstruct a conversation.
  hide_resolved_toggled: ['enabled'],
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
  // PRIVACY DECISION (deploy-preview surfacing): fired when the user opens a
  // detected deploy preview — in a new tab or the embedded panel. Carries only
  //   - 'method'        : 'tab' | 'panel' — fixed enum.
  //   - 'provider_name' : the deploy PLATFORM enum ('vercel' | 'netlify' |
  //                       'cloudflare-pages' | 'deploy') — the detection module
  //                       guarantees a fixed enum, never a raw environment name.
  //   - 'state'         : 'ready' | 'building' | 'failed' — fixed enum.
  // NEVER the preview URL, environment name, sha, owner/repo, or any other
  // identifier that could locate the deployment.
  preview_opened: ['method', 'provider_name', 'state'],
  // PRIVACY DECISION: fired ONCE per loaded PR when the skill reviewers are
  // auto-started early (opt-out setting on, while the user is still on step 1).
  // Carries only 'count' — the integer number of enabled reviewers kicked off.
  // Never a path, persona name, finding, or any code/diff content.
  reviewers_auto_started: ['count'],
  // PRIVACY DECISION (Prepare-ahead): fired ONCE per landing-page "Prepare
  // review" run when it settles. Carries only 'outcome' — an enum ('ready' |
  // 'error' | 'cancelled' | 'declined' | 'load-failed') — plus 'tasks_run'
  // (integer count of AI tasks that actually executed) and 'duration_ms'
  // (same convention as ai_task_completed). Never a repo, PR number, title,
  // finding, or any code/diff content.
  review_prepared: ['outcome', 'tasks_run', 'duration_ms'],
  // PRIVACY DECISION (local bridge): fired ONCE when the user successfully pairs
  // review123 with a local bridge (bridge/README.md). Props describe the
  // MACHINE'S CAPABILITIES, never the machine or the code:
  //   - 'inference_clis' : the detected CLI ids, from the hard-coded set
  //                        ['claude', 'codex']. A fixed enum list, not free text.
  //   - 'has_files'      : boolean — whether the bridge advertises file reads.
  // Explicitly NOT sent: the pairing token, the port, the repo name (the bridge
  // reports only a directory basename and even that stays local), any path, and
  // any file content. Added so we can see whether the bridge is adopted at all
  // and which CLI the inference path has to support first.
  bridge_connected: ['inference_clis', 'has_files'],
  // PRIVACY DECISION (agent fix loop, #243): the fix loop hands findings to a
  // coding agent on the user's own machine and gets back commits. Almost
  // everything it touches is disqualified by definition — the finding text, its
  // path and line, the agent's intent sentence, the files it changed, the diff,
  // the commit shas, the test command and its output. NONE of that is sent.
  // What is sent is the SHAPE of the run:
  //   - 'findings' : integer count of findings dispatched in this batch.
  //   - 'cli'      : 'claude' | 'codex' — the hard-coded BRIDGE_CLIS enum, the
  //                  same value already sent as bridge_connected.inference_clis.
  // Added so the single most expensive action in the product ("did anyone run
  // it, and with what?") is measurable at all.
  //   - 'round'    : integer, 1-based — WHICH round of the bounded loop this
  //                  batch was. Round 1 is a batch the user sent; anything
  //                  above it is a round the loop sent on their behalf, and
  //                  without it the loop's cost is indistinguishable from
  //                  somebody clicking send five times. An integer counter over
  //                  an app-controlled loop; it says nothing about the code.
  bridge_fix_dispatched: ['findings', 'cli', 'round'],
  // The same run's OUTCOME. Counts and fixed enums only:
  //   - 'outcome'      : 'done' | 'failed' | 'cancelled'.
  //   - 'failure'      : the FixFailureKind enum ('unreachable', 'timeout',
  //                      'write-disabled', …) — present only when 'failed'. A
  //                      classified cause, never the bridge's own detail text
  //                      (which can quote a CLI's stderr).
  //   - 'changes'      : integer count of commits handed back.
  //   - 'skipped'      : integer count of findings that produced no commit.
  //   - 'stop_reason'  : the BridgeFixStopReason enum — why the loop stopped.
  //   - 'tests_passed' : integer count of changes whose test run passed.
  //   - 'tests_failed' : integer count whose test run failed.
  //   - 'duration_ms'  : elapsed ms (same convention as ai_task_completed).
  // A fix run is minutes long and mostly succeeds or mostly does not; these
  // counts say which, and nothing about the code involved.
  bridge_fix_settled: ['outcome', 'failure', 'changes', 'skipped', 'stop_reason', 'tests_passed', 'tests_failed', 'duration_ms'],
  // PRIVACY DECISION (the bounded fix loop): fired ONCE when the outer loop
  // stops, whatever stopped it. The loop's whole design question is "does a
  // budget actually terminate this, and on which condition" — unanswerable
  // without the stop mix. Counts and fixed enums only:
  //   - 'stop'       : the FixLoopStopReason enum ('quiet', 'round-cap',
  //                    'budget-spent', 'no-new-commit', 'repeat-outcome',
  //                    'stopped-by-user', 'run-failed'). The signal.
  //   - 'rounds'     : integer count of outer rounds that ran.
  //   - 'commits'    : integer count of commits the loop ended holding.
  //   - 'still_open' : integer count of findings still open when it stopped.
  //   - 'unsoftened' : integer count of commits that came back at the BRIDGE's
  //                    own round cap, stuck or oscillating. A quiet loop that
  //                    is still carrying red commits is the failure mode this
  //                    feature most has to be watched for, and it is a count.
  //   - 'duration_ms': elapsed ms (same convention as ai_task_completed).
  // Nothing about the findings, the code, the commits or the agent's words.
  bridge_fix_looped: ['stop', 'rounds', 'commits', 'still_open', 'unsoftened', 'duration_ms'],
  // PRIVACY DECISION (#280's verification pass, deferred from that PR): the
  // re-read sends the agent's diff to the configured models and gets back a
  // per-finding verdict plus problems raised against the fix itself. EVERY
  // interesting thing it touches is disqualified by definition — the finding
  // text, the persona's criterion, the diff, the models' own sentences, the new
  // problems' bodies and paths. NONE of that is sent. What is sent is the shape
  // of the pass, as integers and one boolean:
  //   - 'findings'         : how many findings were re-read at all.
  //   - 'still_standing' / 'not_raised_again' / 'could_not_tell' /
  //     'not_re_read'      : the four outcomes, as counts. This split IS the
  //                          measurement: a pass that says "not raised again"
  //                          every time is a pass that is not reading.
  //   - 'new_problems'     : count of problems raised against the fix itself.
  //   - 'models'           : how many distinct models answered. A count, never
  //                          which — the witness list is display-only.
  //   - 'failed_calls'     : count of calls that failed and are not counted.
  //   - 'cached'           : boolean. A cache hit and a fresh poll are the same
  //                          report and completely different events; blending
  //                          them would report the feature getting cheaper
  //                          every time somebody re-opens the panel.
  //   - 'duration_ms'      : elapsed ms (same convention as ai_task_completed).
  fix_verify_completed: [
    'findings',
    'still_standing',
    'not_raised_again',
    'could_not_tell',
    'not_re_read',
    'new_problems',
    'models',
    'failed_calls',
    'cached',
    'duration_ms',
  ],
  // PRIVACY DECISION (#281's readiness grade): fired once per graded report
  // when the user lands on the verdict step. The grade is computed from stated
  // facts about THIS pull request — which reviewers ran, which files were never
  // read, which findings stand — and every one of those is a private repo
  // identifier wearing a number. So none of them are sent. Fixed enums and
  // counts only:
  //   - 'band'  : the ReadinessBand enum ('broad' | 'partial' | 'thin' |
  //               'minimal' | 'none'). The headline, and the only thing needed
  //               to see whether the bands are calibrated at all.
  //   - 'score' / 'max' : integers. `max` is a constant today and is sent
  //               anyway, so a later reweighting does not silently reinterpret
  //               every historical score.
  //   - 'unmet' : integer count of checks that came back unmet. Which ones is
  //               the interesting part and is exactly what cannot be sent — a
  //               shortfall names reviewers and files.
  // Explicitly NOT sent: check ids, labels, details, shortfalls, reviewer
  // names, file paths, finding text, the disclaimer lines.
  readiness_viewed: ['band', 'score', 'max', 'unmet'],
  // PRIVACY DECISION (standing rules): the distillation reads the user's OWN
  // review comments, their dismissal ledger, and their unsent draft comments,
  // and returns rules written in their vocabulary. Its permitted ceiling was
  // "rule text and evidence counts"; we send LESS THAN THAT, deliberately.
  //
  // A distilled rule paraphrases the user's own review comments, so it can
  // and will name internal modules, services, and conventions ("Put billing
  // logic in AcmeLedgerService, never in the webhook handler"). That is a
  // private repo identifier wearing a sentence, and #232's boundary does not
  // stop being the boundary because the sentence is short. So NO rule text,
  // NO evidence excerpts, NO repo or path, ever. Counts and fixed enums only:
  //   - 'source'      : 'bridge' | 'api' — WHERE the distillation ran. The
  //                     whole point of the local-first seam is unmeasurable
  //                     without it, and it says nothing about the corpus.
  //   - 'rules'       : integer count of rules returned.
  //   - 'do' / 'avoid': integer counts per kind — the asked-for vs rejected
  //                     split, which is the feature's central claim.
  //   - 'comments' / 'dismissals' / 'drafts' : integer SIZES of the three
  //                     corpus streams. Sizes, never contents.
  //   - 'duration_ms' : elapsed ms (same convention as ai_task_completed).
  //   - 'outcome'     : 'done' | 'cancelled'. The distillation is a multi-minute
  //                     call the user can now stop, and an ABANDONED run is not
  //                     a failed one — the same distinction bridge_fix_settled
  //                     makes. Without it a cancel would either be invisible
  //                     (unmeasurable) or land in the failure mix (a lie). A
  //                     cancelled run carries the corpus sizes and the elapsed
  //                     ms it got through, and NO rule counts: there are none.
  standing_rules_distilled: ['outcome', 'source', 'rules', 'do', 'avoid', 'comments', 'dismissals', 'drafts', 'duration_ms'],
  // Fired when the user accepts or rejects ONE proposed rule. The accept/reject
  // rate is the only real precision measure this feature has — and it needs no
  // rule text to be useful. Fixed enums and one boolean:
  //   - 'decision' : 'accepted' | 'rejected'.
  //   - 'kind'     : 'do' | 'avoid' — the two kinds may well be judged very
  //                  differently, and a blended rate would hide that.
  //   - 'edited'   : boolean — did the user rewrite the rule before accepting
  //                  it. An accepted-but-rewritten rule is a near miss, not a
  //                  hit; the WORDS of the rewrite are never sent.
  standing_rules_decided: ['decision', 'kind', 'edited'],
  // Fired when the accepted rules leave the app. Carries only 'method'
  // ('clipboard' | 'download') and 'rules' (integer count) — never the
  // exported text, the filename the user chooses, or where it lands. The app
  // does not write to any file on the user's machine, so there is nothing
  // further to report.
  standing_rules_exported: ['method', 'rules'],
} as const

export type EventName = keyof typeof EVENTS
/**
 * A property value. `readonly string[]` is permitted for properties that are
 * genuinely a SET of enum values (bridge_connected.inference_clis) — PostHog
 * stores arrays natively and they stay far more queryable than a joined string.
 * The allowlist above still governs WHICH properties may be sent at all.
 */
type PropValue = string | number | boolean | readonly string[]
type AllowedProps<E extends EventName> = Partial<Record<(typeof EVENTS)[E][number], PropValue>>

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
