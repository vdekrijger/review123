/**
 * bridge/install.ts — where the bridge comes from and how it is started.
 *
 * Two surfaces quote this and they must not drift: Settings → Local bridge
 * (the install block a user pastes) and the mid-review "the bridge is not
 * responding" error (src/lib/llm/llm.ts), which has to name the SAME command
 * the user actually ran. A component cannot be imported by the llm layer, so
 * the strings live here rather than in either of them.
 *
 * Since #239 the PRIMARY route is the prebuilt single-file bundle published on
 * GitHub Releases. `pnpm bridge` still works and is still documented in the
 * settings panel, but it is the fallback for people who would rather build it
 * themselves — it is not what the error line should tell someone to run.
 */

/**
 * The prebuilt single-file bundle (bridge/scripts/bundle.mjs), published on
 * GitHub Releases. `/releases/latest/download/` always resolves to the newest
 * release's asset, so this URL never needs a version bump here.
 */
export const BRIDGE_DOWNLOAD_URL =
  'https://github.com/vdekrijger/review123/releases/latest/download/bridge.mjs'

/** Where the download lands. Stable, so the run step works from any repo. */
export const BRIDGE_LOCAL_PATH = '~/review123-bridge.mjs'

/** Step 1: fetch the bundle once. */
export const BRIDGE_DOWNLOAD_COMMAND = `curl -fsSL ${BRIDGE_DOWNLOAD_URL} -o ${BRIDGE_LOCAL_PATH}`

/**
 * Step 2, and the command every surface names when the bridge is not running.
 *
 * WHY THE FLAGS ARE IN THE DOCUMENTED COMMAND, AND MUST STAY:
 *
 * The bridge's code defaults are OFF and that is not changing — this string is
 * DOCUMENTATION, not a default. `--allow-write` and `--allow-checkout` are the
 * only way to turn on the two features most people install the bridge for, and
 * they are typed at a terminal on purpose: nothing review123 sends can enable
 * them, so the grant survives even if review123.dev is compromised and starts
 * asking for things the user never wanted. The flags defend the user against
 * THIS APP; they were never a warning about the user's own machine. Leaving
 * them out of the documented line doesn't harden anything — the process is
 * equally exposed either way — it just means the features silently don't work
 * and the user is told to "restart the bridge with…" later.
 *
 *   --allow-write     → POST /v1/fix: hand a finding to your local coding
 *                       agent, which fixes it in a SCRATCH git worktree.
 *   --allow-checkout  → POST /v1/checkout + /v1/restore: check a PR out in
 *                       THIS working tree so your dev server serves it.
 *
 * They are independent in both directions; neither implies the other. Drop
 * either from this string only with a reason better than "it looks safer".
 */
export const BRIDGE_START_COMMAND =
  `node ${BRIDGE_LOCAL_PATH} --root . --allow-write --allow-checkout`

/**
 * The same command plus `--allow-push`. This is the line Settings → Local
 * bridge documents, AT THE USER'S EXPLICIT REQUEST — they asked for the setup
 * paste to grant all three, so one paste sets the bridge up for everything they
 * use it for instead of sending them back to the terminal later.
 *
 * WHY PUSH IS STILL A MATERIALLY DIFFERENT GRANT.
 *
 * The argument for putting `--allow-write` and `--allow-checkout` in the
 * documented command is written out above, and it holds: those flags defend the
 * user against THIS APP, not against their own machine, so leaving them out
 * hardens nothing and just means the features silently do not work.
 *
 * `--allow-push` does not fit that argument, and the difference is not a
 * technicality. Both of the other flags authorise changes on the user's own
 * machine that the user can undo. This one authorises a change their whole team
 * sees the moment it lands and that nothing review123 offers takes back. So
 * omitting it genuinely WOULD harden something, which is exactly why it was
 * absent here until the user decided otherwise — the conclusion changed because
 * they chose, not because the reasoning was wrong.
 *
 * WHAT THAT MEANS FOR THE TWO CONSTANTS. They stay two, and the choice of which
 * one a surface names is the choice of which grant that surface is asking for:
 *
 *   Settings → Local bridge     → this one. Setup, all three grants, and the
 *                                 panel carries its own note about the
 *                                 difference rather than extending the
 *                                 local-only argument over all three.
 *   CiFixPanel's push refusal   → this one. Pushing is what the user is doing.
 *   AgentFixPanel write-disabled → BRIDGE_START_COMMAND. That refusal is about
 *                                 the FIX LOOP, which writes only in a scratch
 *                                 worktree.
 *   llm.ts's "not responding"   → BRIDGE_START_COMMAND. That message is about
 *                                 INFERENCE.
 *
 * Naming a push grant in a message about inference, or about a worktree that
 * never reaches a remote, would ask the user for something the situation does
 * not need — so collapsing these into one constant would be a regression even
 * though the two strings now differ by a single flag.
 */
export const BRIDGE_START_COMMAND_WITH_PUSH = `${BRIDGE_START_COMMAND} --allow-push`

export const BRIDGE_REPO_URL = 'https://github.com/vdekrijger/review123'
export const BRIDGE_README_URL = 'https://github.com/vdekrijger/review123/blob/main/bridge/README.md'
