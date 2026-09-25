/**
 * src/lib/guide/botThreads.ts — "is this thread the bot filter's business?"
 *
 * The pair to botThreadsPref.svelte.ts: the preference says WHETHER to hide,
 * this says WHAT counts. Same split as hunkAttention.ts / hunkAttentionPref.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE DEFINITION OF "BOT", AND IT IS NOT WRITTEN HERE
 *
 * `isReviewBotAuthor` already exists in src/lib/bridge/botComments.ts — the
 * `[bot]` login suffix GitHub appends to every GitHub App, plus a short
 * explicit allowlist for the review bots that post under a plain account on
 * some provider. It is imported, not re-derived. A second definition would
 * drift, and the two consumers would then disagree about a comment in the most
 * confusing possible way: the diff hiding something the fix panel still
 * offers, on a rule nobody could find.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A BOT COMMENT WITH HUMAN REPLIES IS NOT A BOT THREAD
 *
 * This is the rule the whole filter turns on, so it is stated rather than
 * implied: a thread is the filter's business only when a bot wrote the root
 * AND a bot wrote every reply.
 *
 * The screenshot that prompted this feature is the argument. Under two of the
 * bot findings sat the USER'S OWN replies — their answer to the bot, their
 * reasoning, the thing a reader of that PR most needs. "Hide bot comments"
 * asked for the noise to go, and a sentence the reviewer wrote themselves is
 * not noise by any reading. Hiding it would be the filter taking a side in a
 * conversation it was only asked to tidy around, and — unlike a bot's finding,
 * which is reproducible from the pull request and still reachable through the
 * fixing panel — those words exist nowhere else in this app.
 *
 * So the moment a person answers a bot, the thread stops being a machine's
 * output and becomes a conversation. It stays. The same reasoning
 * botComments.ts already writes down for why HUMAN comments are never offered
 * to the fixing agent ("a colleague's comment is a turn in a conversation"),
 * applied to the surface the reader looks at rather than the one the agent
 * reads from.
 *
 * A bot answering a bot is still only machines talking, so it still hides.
 *
 * WHAT THIS CANNOT SEE, stated so nobody trusts it too far: it inherits every
 * limit of `isReviewBotAuthor`. A person free to call themselves `coderabbitai`
 * on a self-hosted GitLab has a thread hidden from the diff — bounded, because
 * hiding is reversible from two places, counted in both, and changes nothing
 * about what the pull request contains.
 */

import type { CommentThread } from '../github/commentThreads'
import { isReviewBotAuthor } from '../bridge/botComments'

/**
 * Is this thread entirely a review bot's, root and every reply?
 *
 * False the moment a person has replied — see the header. That is the whole
 * asymmetry of the rule: one bot comment hides, one human sentence keeps it.
 */
export function isBotThread(thread: CommentThread): boolean {
  if (!isReviewBotAuthor(thread.root.author)) return false
  return thread.replies.every((r) => isReviewBotAuthor(r.author))
}

/**
 * Does this thread have a bot root that a PERSON has replied to?
 *
 * Not used to hide anything — it is the honest count for "bot threads a person
 * joined", which the toolbar needs so it can offer the switch only when there
 * is something for it to do, without pretending a conversation is noise.
 */
export function isAnsweredBotThread(thread: CommentThread): boolean {
  if (!isReviewBotAuthor(thread.root.author)) return false
  return thread.replies.some((r) => !isReviewBotAuthor(r.author))
}
