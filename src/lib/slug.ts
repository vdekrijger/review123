/**
 * Shared slug helper: converts a file path to a safe DOM id segment.
 * e.g. "src/a.ts" → "src-a-ts"
 */
export function slugify(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}
