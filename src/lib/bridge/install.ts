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

/** Step 2, and the command every surface names when the bridge is not running. */
export const BRIDGE_START_COMMAND = `node ${BRIDGE_LOCAL_PATH} --root .`

export const BRIDGE_REPO_URL = 'https://github.com/vdekrijger/review123'
export const BRIDGE_README_URL = 'https://github.com/vdekrijger/review123/blob/main/bridge/README.md'
