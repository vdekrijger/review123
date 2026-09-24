/**
 * src/source-bytes.test.ts — every source file under src/ must be TEXT.
 *
 * WHY THIS EXISTS. `src/lib/bridge/grounding.ts` carried a literal NUL byte
 * (0x00) inside a string literal — `batch.join('<NUL>')` — where the author
 * meant the two-character escape `'\0'`. The runtime behaviour was identical,
 * so nothing failed and nothing looked wrong. What it broke was GREP: a single
 * NUL makes grep classify the file as binary, so `grep -rn <identifier> src/`
 * printed "Binary file src/lib/bridge/grounding.ts matches" and SILENTLY
 * skipped every line in it.
 *
 * That is not a cosmetic problem here. CLAUDE.md's "THE RECURRING LESSON" —
 * the #1 cause of CI failures in this repo — is to grep the whole repo for
 * every identifier/prop/label you change and update every caller. A file grep
 * refuses to read is a file that rule cannot protect, and it fails OPEN: the
 * grep exits 0 with a reassuring "matches" line while showing you nothing.
 *
 * So this guard asserts the property the rule depends on, rather than the one
 * bug that violated it: no source file under src/ contains a 0x00 byte.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Extensions grep is expected to read as text. Deliberately an allowlist:
 * a genuinely binary asset (.wasm, .png) added under src/ later must not make
 * this test fail — only files a human greps for identifiers need to qualify.
 */
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.svelte', '.css', '.json', '.md', '.html']

function textFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) textFilesUnder(path, out)
    else if (TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(path)
  }
  return out
}

describe('source hygiene — no NUL bytes under src/', () => {
  it('finds source files to check at all (guards against a silently empty scan)', () => {
    // A guard that scans nothing passes forever. Anchor it on a floor well
    // below the real count so it never becomes a churn magnet.
    expect(textFilesUnder('src').length).toBeGreaterThan(100)
  })

  it('has no source file containing a 0x00 byte (grep must never call one binary)', () => {
    // Raw bytes, NOT a decoded string: the point is what grep sees on disk.
    const offenders = textFilesUnder('src').filter((path) => readFileSync(path).includes(0))
    expect(offenders).toEqual([])
  })
})
