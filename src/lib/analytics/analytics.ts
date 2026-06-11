import posthog from 'posthog-js'

// Allowlist schema: event -> permitted property names. The ONLY path to
// PostHog. Adding a property here is a privacy decision — never allow
// code, diffs, keys, tokens, or private repo identifiers.
const EVENTS = {
  pr_loaded: ['visibility', 'file_count', 'primary_language'],
  signed_in: ['method'],
  ai_task_completed: ['task', 'duration_ms', 'cached'],
  ai_task_failed: ['task', 'reason'],
  diagram_viewed: [],
  hotspot_clicked: [],
  ci_summary_viewed: ['conclusion'],
  comment_drafted: [],
  review_submitted: ['verdict', 'comment_count'],
  settings_key_added: ['service'],
} as const

export type EventName = keyof typeof EVENTS
type AllowedProps<E extends EventName> = Partial<Record<(typeof EVENTS)[E][number], string | number | boolean>>

type CaptureFn = (event: string, props: Record<string, unknown>) => void
let capture: CaptureFn = posthog.capture.bind(posthog)
export function _setCaptureForTest(fn: CaptureFn): void { capture = fn }

export function initAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
  if (!key) return // analytics disabled without a key
  posthog.init(key, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com',
    autocapture: false, // only typed events pass the choke-point
    capture_pageview: true,
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
