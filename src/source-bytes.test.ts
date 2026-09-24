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

/**
 * Every text source under src/, read through Vite's `?raw` — the same idiom
 * scaleRatchet.test.ts uses, so no fs access and no @types/node.
 *
 * The extension list is deliberately an ALLOWLIST: a genuinely binary asset
 * (.wasm, .png) added under src/ later must not fail this test — only files a
 * human greps for identifiers need to qualify. The patterns must be string
 * literals (Vite's transform requirement).
 */
const rawSources = import.meta.glob<string>(
  ['/src/**/*.ts', '/src/**/*.svelte', '/src/**/*.css', '/src/**/*.json', '/src/**/*.md', '/src/**/*.html'],
  { query: '?raw', import: 'default', eager: true },
)

describe('source hygiene — no NUL bytes under src/', () => {
  it('finds source files to check at all (guards against a silently empty scan)', () => {
    // A guard that scans nothing passes forever. Anchor it on a floor well
    // below the real count so it never becomes a churn magnet.
    expect(Object.keys(rawSources).length).toBeGreaterThan(100)
  })

  it('has no source file containing a 0x00 byte (grep must never call one binary)', () => {
    // A raw 0x00 on disk is valid UTF-8 (U+0000) and survives the decode, so
    // this sees exactly what makes grep give up on a file.
    const offenders = Object.entries(rawSources)
      .filter(([, text]) => text.includes('\0'))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
