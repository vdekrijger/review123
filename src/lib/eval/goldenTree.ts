/**
 * src/lib/eval/goldenTree.ts — turn the golden fixtures into a real working
 * tree, so that "the model can read the repo" means something.
 *
 * WHY THIS EXISTS, AND WHY WITHOUT IT THE MEASUREMENT IS A LIE
 *
 * Deep review (#82), grounded verification (#229) and local grounding (#242)
 * all come down to one sentence: the model can open the file it is reviewing.
 * The bridge grants exactly that — `Read`/`Glob`/`Grep` confined to the served
 * `--root`.
 *
 * But the golden fixtures are SYNTHETIC. `01-real-bug` reviews
 * `src/lib/paginate.ts`; `08-quiet-low` reviews `src/lib/range.ts`. Neither file
 * exists in review123's own repo, and never will. Point an agentic bridge at
 * review123 and the verifier's `Read` returns "no such file" for every path in
 * the diff.
 *
 * That failure is not neutral. Grounded verification tells the verifier to drop
 * what it cannot confirm, so a tree with none of the files under review pushes
 * the panel towards REFUTE on everything — including the real defects. The run
 * would produce a large, confident recall drop that is an artifact of an empty
 * tree, and it would look exactly like "grounded verification hurts recall".
 *
 * So the harness materializes the fixtures' post-change contents into a
 * scratch tree and serves the bridge from there. Then a `Read` of
 * `src/lib/range.ts` returns the code the diff is about, and the number means
 * what it says.
 *
 * WHAT IS AND IS NOT FAITHFUL ABOUT THE RESULT, stated up front:
 *   - FAITHFUL: every path named in a fixture diff exists, with the exact
 *     post-change bytes the reviewer was shown. That is the head state of the
 *     PR, which is what a reviewer reads.
 *   - NOT FAITHFUL: there are no surrounding modules, no callers, no tests
 *     beyond those the fixtures name, and no git history. A verifier asking
 *     "who calls this?" gets a true but nearly empty answer. The tree can
 *     confirm a claim ABOUT THE CHANGED FILES and little else.
 *   - SHARED: all cases materialize into ONE tree, because every fixture path
 *     across the set is distinct. A `Grep` therefore sees the other cases'
 *     files too — which is realistic (a repo has many files) but means a
 *     cross-case match is possible. Recorded, not hidden.
 */

import type { GoldenCase } from './harness'

/** One file to write into the scratch working tree. */
export interface TreeFile {
  /** Repo-relative path, exactly as the fixture names it. */
  path: string
  /** The post-change bytes the reviewer was shown. */
  content: string
  /** Which golden case contributed it — for the manifest, and for collisions. */
  from: string
}

export interface GoldenTreePlan {
  files: TreeFile[]
  /**
   * Paths claimed by more than one case, with the case that won (last wins,
   * matching write order). Empty today; non-empty means two fixtures disagree
   * about one path's contents and any tool read of it is ambiguous.
   */
  collisions: { path: string; cases: string[] }[]
  /** Fixture entries with `contentAfter === null` (deleted files) — not written. */
  deleted: { path: string; from: string }[]
}

/**
 * Plan the scratch tree for a set of golden cases.
 *
 * Deleted files (`contentAfter === null`) are deliberately NOT written: the
 * head state of that PR has no such file, and inventing one so the tools find
 * something would be the opposite of grounding.
 */
export function planGoldenTree(cases: readonly GoldenCase[]): GoldenTreePlan {
  const byPath = new Map<string, TreeFile>()
  const claimants = new Map<string, string[]>()
  const deleted: { path: string; from: string }[] = []

  for (const c of cases) {
    for (const f of c.fixture.files) {
      if (f.contentAfter === null) {
        deleted.push({ path: f.path, from: c.name })
        continue
      }
      claimants.set(f.path, [...(claimants.get(f.path) ?? []), c.name])
      byPath.set(f.path, { path: f.path, content: f.contentAfter, from: c.name })
    }
  }

  const collisions = [...claimants.entries()]
    .filter(([, cs]) => cs.length > 1)
    .map(([path, cases]) => ({ path, cases }))

  return {
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    collisions,
    deleted,
  }
}

/**
 * A README dropped at the tree root, so nobody who stumbles into the directory
 * — or any CLI that reads it looking for project context — mistakes it for a
 * real project.
 */
export function goldenTreeReadme(plan: GoldenTreePlan, generatedAt: string): string {
  const lines = [
    '# Golden-fixture scratch tree — GENERATED, NOT A PROJECT',
    '',
    'Every file here was written by `eval/materialize-golden.mts` from the',
    '`contentAfter` of a golden fixture in `eval/golden/`. It exists so that an',
    'agentic bridge (`--root` pointed here) can actually READ the code the eval',
    'harness is reviewing, instead of getting "no such file" for every path.',
    '',
    'It is the head state of several unrelated synthetic PRs dropped into one',
    'directory. There are no callers, no build, no history and no dependencies.',
    'Do not edit it and do not read it as an example of anything.',
    '',
    `Generated: ${generatedAt}`,
    '',
    '| path | from golden case |',
    '| --- | --- |',
    ...plan.files.map((f) => `| \`${f.path}\` | \`${f.from}\` |`),
  ]
  if (plan.collisions.length > 0) {
    lines.push(
      '',
      '## Path collisions',
      '',
      'More than one fixture claims these paths, so a tool read of them is',
      'ambiguous. The LAST case written wins.',
      '',
      ...plan.collisions.map((c) => `- \`${c.path}\` — ${c.cases.join(', ')}`),
    )
  }
  if (plan.deleted.length > 0) {
    lines.push(
      '',
      '## Not written (deleted in the fixture)',
      '',
      ...plan.deleted.map((d) => `- \`${d.path}\` (from \`${d.from}\`)`),
    )
  }
  return lines.join('\n') + '\n'
}
