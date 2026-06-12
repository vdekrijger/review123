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
  ai_task_completed: ['task', 'duration_ms', 'cached', 'tokens'],
  ai_task_failed: ['task', 'reason'],
  diagram_viewed: [],
  hotspot_clicked: [],
  ci_summary_viewed: ['conclusion'],
  comment_drafted: [],
  // PRIVACY DECISION: 'ok' is a boolean outcome only — no body content,
  // thread ids, or repo identifiers are ever sent.
  reply_posted: ['ok'],
  review_submitted: ['verdict', 'comment_count'],
  settings_key_added: ['service'],
  // PRIVACY DECISION: engagement events below carry section/surface identifiers only.
  // 'section' is a stable registry id (e.g. 'summary', 'diagrams', 'queue', 'recent') —
  // never a file path, diff content, PR title, or any user-generated text.
  // 'surface' is 'page' | 'rail' | 'landing' — a layout location, not content.
  // 'origin' is 'viewed' | 'dim' — the collapse reason, not file identity.
  // 'step' is '1' | '2' | '3' — step index only.
  // None of these can be used to reconstruct code, diffs, or private repo data.
  section_expanded: ['section', 'surface'],
  file_expanded: ['origin'],
  drawer_opened: [],
  // Carries no content — fired when the user turns ON "Hide whitespace changes".
  whitespace_hidden: [],
  rail_expanded: [],
  step_viewed: ['step'],
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
