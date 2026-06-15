/**
 * src/lib/diff/generated.ts — CONSERVATIVE detection of machine-generated files.
 *
 * A generated file is one a human is not expected to hand-edit: lockfiles,
 * compiled/minified bundles, protobuf stubs, snapshot artifacts, files under a
 * `generated/` directory, or files carrying the standard `@generated` /
 * `Code generated … DO NOT EDIT.` content marker.
 *
 * Design stance — PREFER FALSE NEGATIVES over FALSE POSITIVES. Mislabeling a
 * hand-written file as generated (and then dimming + sorting it last) is more
 * harmful than missing one genuinely-generated file. Every heuristic here is
 * therefore deliberately narrow and segment-bounded; when in doubt we say "no".
 *
 * Two signal sources:
 *   1. PATH signals (filename / extension / directory segment) — always available.
 *   2. CONTENT markers (first ~40 lines) — only consulted when contents are
 *      loaded; path signals alone are sufficient otherwise.
 *
 * This module is the SINGLE SOURCE OF TRUTH for generated-PATH detection. The
 * AI context packer (lib/context/pack.ts) imports {@link isGeneratedPath} to
 * exclude generated files from the prompt budget — do not duplicate the regexes.
 */

// ---------------------------------------------------------------------------
// Lockfiles (exact basenames)
// ---------------------------------------------------------------------------

const LOCK_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
])

// ---------------------------------------------------------------------------
// Filename / extension patterns (matched against the BASENAME)
// ---------------------------------------------------------------------------

// Minified bundles + source maps: `*.min.js`, `*.min.css`, `*.map` (incl. `*.js.map`).
const MIN_OR_MAP_RE = /\.min\.[^.]+$|\.map$/

// Protobuf-generated stubs across languages:
//   *.pb.go  *.pb.cc  *.pb.h  *_pb2.py  *_pb2.pyi  *_pb.js  *_pb.d.ts
const PROTOBUF_RE = /\.pb\.(?:go|cc|h)$|_pb2\.pyi?$|_pb\.(?:js|d\.ts)$/

// Conventional generated infixes: `foo.generated.ts`, `foo.gen.go`,
// `Foo.designer.cs` (Visual Studio designer files).
const GENERATED_INFIX_RE = /\.generated\.[^.]+$|\.gen\.[^.]+$|\.designer\.cs$/i

// Swagger / OpenAPI generated clients commonly land in obvious filenames.
const SWAGGER_RE = /(?:^|[-_.])swagger\.(?:json|ya?ml)$|(?:^|[-_.])openapi\.(?:json|ya?ml)$/i

// ---------------------------------------------------------------------------
// Directory-segment patterns (segment-bounded, case-insensitive)
// ---------------------------------------------------------------------------

// A path is generated when ANY directory segment is exactly `generated`,
// `__generated__`, `gen`, or `dist`. Segment-bounded so `generator.ts` (a
// hand-written file whose BASENAME merely starts with "gen") never matches,
// and so `regenerate/` (a dir whose name CONTAINS "gen") never matches.
const GENERATED_DIR_SEGMENTS = new Set(['generated', '__generated__', 'gen', 'dist'])

// Snapshot artifacts: Jest/Vitest write these and forbid hand-editing.
const SNAPSHOT_DIR = '__snapshots__'
const SNAPSHOT_EXT_RE = /\.snap$/

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

/**
 * True when the file PATH alone marks it as generated. Pure, no contents.
 *
 * Note on `.d.ts`: hand-written ambient declaration files are common, so a
 * `.d.ts` is treated as generated ONLY when it also lives under a generated
 * directory segment (handled by the segment check) — never by extension alone.
 */
export function isGeneratedPath(path: string): boolean {
  if (!path) return false

  const segments = path.split('/')
  const base = segments[segments.length - 1]

  // Lockfiles
  if (LOCK_FILES.has(base)) return true

  // Basename / extension patterns
  if (MIN_OR_MAP_RE.test(base)) return true
  if (PROTOBUF_RE.test(base)) return true
  if (GENERATED_INFIX_RE.test(base)) return true
  if (SWAGGER_RE.test(base)) return true

  // Snapshot artifacts
  if (SNAPSHOT_EXT_RE.test(base)) return true
  if (segments.some((s) => s === SNAPSHOT_DIR)) return true

  // Generated directory segments (case-insensitive, segment-bounded)
  if (segments.some((s) => GENERATED_DIR_SEGMENTS.has(s.toLowerCase()))) return true

  return false
}

// ---------------------------------------------------------------------------
// Content marker detection
// ---------------------------------------------------------------------------

// The two canonical machine-generated annotations, case-insensitive:
//   - `@generated`                       (Facebook/Meta convention, JS/Go/…)
//   - `Code generated … DO NOT EDIT.`    (Go convention, also widely copied)
// We also accept a bare uppercase `DO NOT EDIT` paired with "generated" on the
// same line — the common denominator of most codegen banners.
const CONTENT_MARKER_RE = /@generated\b|code generated[\s\S]{0,80}?do not edit|generated[\s\S]{0,40}?do not edit/i

const MARKER_SCAN_LINES = 40

/**
 * True when the first ~40 lines of `contents` carry a generated marker.
 * Scans a bounded prefix so a stray "@generated" deep in a large file (e.g. in
 * test data) doesn't trip detection — codegen banners always sit at the top.
 */
export function hasGeneratedMarker(contents: string | null | undefined): boolean {
  if (!contents) return false
  const prefix = contents.split('\n', MARKER_SCAN_LINES).join('\n')
  return CONTENT_MARKER_RE.test(prefix)
}

// ---------------------------------------------------------------------------
// Combined detection
// ---------------------------------------------------------------------------

/**
 * True when a file is generated by EITHER its path OR a content marker in its
 * (after, else before) contents. Path signals alone suffice when contents are
 * absent. `contents` is the optional contentsMap entry for the file.
 */
export function isGeneratedFile(
  path: string,
  contents?: { before: string | null; after: string | null } | null,
): boolean {
  if (isGeneratedPath(path)) return true
  if (contents) {
    // Prefer after-content (the new file state); fall back to before for deletes.
    if (hasGeneratedMarker(contents.after ?? contents.before)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Stable "generated last" ordering
// ---------------------------------------------------------------------------

/**
 * Stable partition of `items` so every generated item sorts AFTER every
 * non-generated one, preserving each group's existing relative order.
 *
 * `isGen` decides generated-ness per item (so callers can supply contents when
 * they have them, or rely on path alone). Returns a NEW array; never mutates.
 *
 * Used everywhere generated files must sink to the bottom: the Files-mode diff
 * list, the file tree, and the story-mode step order.
 */
export function sortGeneratedLast<T>(items: readonly T[], isGen: (item: T) => boolean): T[] {
  const normal: T[] = []
  const generated: T[] = []
  for (const item of items) {
    if (isGen(item)) generated.push(item)
    else normal.push(item)
  }
  return [...normal, ...generated]
}
