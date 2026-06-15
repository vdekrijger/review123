import { describe, it, expect } from 'vitest'
import { extractChangedSymbols } from './symbols'
import type { PrFile } from '../github/types'

function file(filename: string, patch: string | undefined): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch }
}

const names = (f: PrFile) => extractChangedSymbols(f).map((s) => s.symbol).sort()

describe('extractChangedSymbols — hunk-header enclosing symbol', () => {
  it('Python async def from hunk header trailing context', () => {
    const patch = '@@ -318,7 +324,7 @@ async def send_slack_ai_subscription_report(\n     x = 1\n-    return a\n+    return b'
    expect(names(file('app/tasks.py', patch))).toContain('send_slack_ai_subscription_report')
  })

  it('Python def from hunk header', () => {
    const patch = '@@ -10,3 +10,3 @@ def compute_total(items):\n-    return 0\n+    return sum(items)'
    expect(names(file('billing.py', patch))).toContain('compute_total')
  })

  it('JS function from hunk header', () => {
    const patch = '@@ -5,3 +5,3 @@ function renderPanel(props) {\n-  return null\n+  return panel'
    expect(names(file('src/ui.ts', patch))).toContain('renderPanel')
  })

  it('Go func with receiver from hunk header', () => {
    const patch = '@@ -20,3 +20,3 @@ func (r *Repo) Save(ctx context.Context) error {\n-  return nil\n+  return err'
    expect(names(file('repo.go', patch))).toContain('Save')
  })

  it('Rust fn from hunk header', () => {
    const patch = '@@ -8,3 +8,3 @@ pub fn parse_config(raw: &str) -> Config {\n-  a\n+  b'
    expect(names(file('src/lib.rs', patch))).toContain('parse_config')
  })

  it('Java method from hunk header', () => {
    const patch = '@@ -12,3 +12,3 @@ public void handleRequest(Request req) {\n-  a;\n+  b;'
    expect(names(file('Handler.java', patch))).toContain('handleRequest')
  })

  it('Ruby def from hunk header', () => {
    const patch = '@@ -3,3 +3,3 @@ def calculate_tax(amount)\n-  amount\n+  amount * 1.2'
    expect(names(file('tax.rb', patch))).toContain('calculate_tax')
  })
})

describe('extractChangedSymbols — added definition lines', () => {
  it('JS: added const arrow function', () => {
    const patch = '@@ -1,2 +1,4 @@\n const a = 1\n+const buildKey = (x) => x + 1\n+function legacy() {}'
    const out = names(file('src/keys.ts', patch))
    expect(out).toContain('buildKey')
    expect(out).toContain('legacy')
  })

  it('JS: added class', () => {
    const patch = '@@ -1,1 +1,3 @@\n x\n+class Widget {\n+}'
    expect(names(file('src/w.ts', patch))).toContain('Widget')
  })

  it('Python: added def and class', () => {
    const patch = '@@ -1,1 +1,4 @@\n x = 1\n+def helper():\n+    pass\n+class Model:'
    const out = names(file('m.py', patch))
    expect(out).toContain('helper')
    expect(out).toContain('Model')
  })

  it('Go: added func', () => {
    const patch = '@@ -1,1 +1,2 @@\n package x\n+func NewClient() *Client { return nil }'
    expect(names(file('client.go', patch))).toContain('NewClient')
  })

  it('Rust: added pub fn', () => {
    const patch = '@@ -1,1 +1,2 @@\n x\n+pub fn run() {}'
    expect(names(file('main.rs', patch))).toContain('run')
  })

  it('Ruby: added def', () => {
    const patch = '@@ -1,1 +1,2 @@\n x\n+def greet(name)'
    expect(names(file('g.rb', patch))).toContain('greet')
  })
})

describe('extractChangedSymbols — negatives & conservatism', () => {
  it('no patch → empty', () => {
    expect(extractChangedSymbols(file('a.ts', undefined))).toEqual([])
  })

  it('unknown extension → empty (no lang)', () => {
    const patch = '@@ -1,1 +1,2 @@\n x\n+function foo() {}'
    expect(extractChangedSymbols(file('README.unknownext', patch))).toEqual([])
  })

  it('comment-only / whitespace changes → no symbols', () => {
    const patch = '@@ -1,2 +1,3 @@ function existing() {\n   const x = 1\n+  // just a comment\n+'
    // The enclosing header still names `existing`; but only-added comment/blank
    // lines must not invent NEW symbols.
    const out = names(file('src/a.ts', patch))
    expect(out).not.toContain('comment')
    expect(out).toContain('existing')
  })

  it('removed-only definition line does not count as added symbol', () => {
    const patch = '@@ -1,3 +1,1 @@\n x\n-function removed() {}\n-const gone = () => 1'
    const out = names(file('src/a.ts', patch))
    expect(out).not.toContain('removed')
    expect(out).not.toContain('gone')
  })

  it('dedupes the same symbol within a file', () => {
    const patch = '@@ -1,2 +1,3 @@ function foo() {\n-  a\n+  b\n+function foo2() {}\n@@ -10,2 +20,3 @@ function foo() {\n-  c\n+  d'
    const syms = extractChangedSymbols(file('src/a.ts', patch))
    const foo = syms.filter((s) => s.symbol === 'foo')
    expect(foo.length).toBe(1)
  })
})

describe('extractChangedSymbols — line ranges (RIGHT/new side)', () => {
  it('captures the changed new-side line range for the enclosing symbol', () => {
    // hunk starts new-side at line 324; one context, one added → added at 325
    const patch = '@@ -318,3 +324,4 @@ def f():\n     ctx\n-    old\n+    new1\n+    new2'
    const syms = extractChangedSymbols(file('a.py', patch))
    const f = syms.find((s) => s.symbol === 'f')
    expect(f).toBeDefined()
    // added lines are new-side 325 and 326
    expect(f!.lineRange.start).toBe(325)
    expect(f!.lineRange.end).toBe(326)
  })
})
