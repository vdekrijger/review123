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
 * The same command plus `--allow-push`, named ONLY where pushing is what the
 * user is trying to do.
 *
 * WHY PUSH IS NOT IN THE LINE ABOVE, AND SHOULD NOT BE.
 *
 * The argument for putting `--allow-write` and `--allow-checkout` in the
 * documented command is written out above it, and it is a good argument: the
 * flags defend the user against THIS APP, not against their own machine, so
 * leaving them out hardens nothing and just means the features silently do not
 * work.
 *
 * `--allow-push` is different in the one way that matters. Both of those flags
 * authorise changes on the user's own machine that the user can undo. This one
 * authorises a change their whole team sees and that nobody can undo. A person
 * pasting a setup command is not, at that moment, deciding to let a web page
 * write to their remote — and a grant nobody consciously made is not a grant.
 *
 * So the default paste stays local-only, and this string is shown at the one
 * place where the user has already decided they want to push and needs the
 * exact line to restart with. The feature does not silently not work: it says
 * what to type, right where the button would have been.
 */
export const BRIDGE_START_COMMAND_WITH_PUSH = `${BRIDGE_START_COMMAND} --allow-push`

export const BRIDGE_REPO_URL = 'https://github.com/vdekrijger/review123'
export const BRIDGE_README_URL = 'https://github.com/vdekrijger/review123/blob/main/bridge/README.md'
