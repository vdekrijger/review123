/**
 * src/lib/provider/selfReview.ts — own-PR verdict gating predicate.
 *
 * Some providers reject review verdicts on the viewer's own PR:
 *   - GitHub: 422 "Can not approve your own pull request" (verified)
 *   - Bitbucket Cloud: rejects self-approval
 *   - GitLab: governed by project settings (often allowed) → never gated here
 *
 * The provider encodes the decision via capabilities.selfReviewBlocked; this
 * predicate combines it with the resolved identities. Unknown identity on
 * either side → no gating (fail open; the submit error path is the backstop).
 */

/**
 * True when Approve / Request changes should be disabled because the
 * authenticated viewer is the PR author on a provider that rejects
 * self-review. Logins are compared case-insensitively.
 */
export function isSelfReviewGated(
  selfReviewBlocked: boolean,
  viewerLogin: string | null | undefined,
  authorLogin: string | null | undefined,
): boolean {
  if (!selfReviewBlocked) return false
  if (!viewerLogin || !authorLogin) return false
  return viewerLogin.toLowerCase() === authorLogin.toLowerCase()
}
