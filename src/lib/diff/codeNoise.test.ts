import { describe, it, expect } from 'vitest'
import { langForFilename, classifyNoise, classifyNoiseLines, type CodeLang } from './codeNoise'

describe('langForFilename', () => {
  const cases: [string, CodeLang][] = [
    ['src/foo.ts', 'js'],
    ['src/foo.tsx', 'js'],
    ['a/b/foo.js', 'js'],
    ['foo.jsx', 'js'],
    ['foo.mjs', 'js'],
    ['foo.cjs', 'js'],
    ['foo.svelte', 'js'],
    ['foo.vue', 'js'],
    ['script.py', 'python'],
    ['main.go', 'go'],
    ['Main.java', 'java'],
    ['Main.kt', 'kotlin'],
    ['lib.rs', 'rust'],
    ['app.rb', 'ruby'],
    ['styles.css', 'css'],
    ['styles.scss', 'css'],
    ['query.sql', 'sql'],
    ['page.html', 'html'],
    ['page.xml', 'html'],
    ['run.sh', 'shell'],
    ['run.bash', 'shell'],
  ]
  for (const [name, lang] of cases) {
    it(`maps ${name} → ${lang}`, () => {
      expect(langForFilename(name)).toBe(lang)
    })
  }

  it('returns null for unknown extensions', () => {
    expect(langForFilename('data.bin')).toBeNull()
    expect(langForFilename('LICENSE')).toBeNull()
    expect(langForFilename('noext')).toBeNull()
  })

  it('is case-insensitive on the extension', () => {
    expect(langForFilename('Foo.TS')).toBe('js')
    expect(langForFilename('Main.PY')).toBe('python')
  })
})

describe('classifyNoise — imports (positive)', () => {
  const positives: [CodeLang, string][] = [
    ['js', "import foo from 'bar'"],
    ['js', 'import { a, b } from "x"'],
    ['js', 'import * as ns from "x"'],
    ['js', "export { a } from './m'"],
    ['js', "export * from './m'"],
    ['js', 'const x = require("y")'],
    ['js', "  let mod = require('y')"],
    ['python', 'import os'],
    ['python', 'from os import path'],
    ['python', '  import sys'],
    ['go', 'import "fmt"'],
    ['go', 'import ('],
    ['go', '\t"fmt"'],
    ['java', 'import java.util.List;'],
    ['kotlin', 'import kotlin.collections.List'],
    ['rust', 'use std::collections::HashMap;'],
    ['rust', '  pub use crate::foo;'],
    ['ruby', "require 'json'"],
    ['ruby', "require_relative '../foo'"],
    ['css', "@import 'reset.css';"],
  ]
  for (const [lang, text] of positives) {
    it(`[${lang}] dims import: ${text.trim()}`, () => {
      expect(classifyNoise(text, lang)).toBe('import')
    })
  }
})

describe('classifyNoise — imports (negative)', () => {
  const negatives: [CodeLang, string][] = [
    ['js', 'const importMap = {}'], // identifier starting with import
    ['js', 'function importData() {}'],
    ['js', 'foo.require("x")'], // method call, not const require
    ['js', 'const label = "import this"'], // string content
    ['python', 'imports = []'],
    ['python', 'fromage = 1'],
    ['rust', 'used = true'],
    ['ruby', 'requirement = 1'],
    ['go', 'imported := true'],
    ['java', 'important = 1;'],
  ]
  for (const [lang, text] of negatives) {
    it(`[${lang}] does NOT dim: ${text.trim()}`, () => {
      expect(classifyNoise(text, lang)).not.toBe('import')
    })
  }
})

describe('classifyNoise — comments (positive)', () => {
  const positives: [CodeLang, string][] = [
    ['js', '// a comment'],
    ['js', '  // indented comment'],
    ['js', '/* block */'],
    ['js', '/** jsdoc'],
    ['js', ' * continuation of block'],
    ['js', ' */'],
    ['python', '# python comment'],
    ['python', '  # indented'],
    ['ruby', '# ruby comment'],
    ['shell', '# shell comment'],
    ['sql', '-- sql comment'],
    ['css', '/* css comment */'],
    ['html', '<!-- html comment -->'],
    ['rust', '// rust comment'],
    ['go', '// go comment'],
    ['java', '// java'],
  ]
  for (const [lang, text] of positives) {
    it(`[${lang}] dims comment: ${text.trim()}`, () => {
      expect(classifyNoise(text, lang)).toBe('comment')
    })
  }
})

describe('classifyNoise — comments (negative, token inside string/code)', () => {
  const negatives: [CodeLang, string][] = [
    ['js', 'const url = "http://example.com"'], // // inside string
    ['js', 'const x = a / b // not first'], // // not line-leading
    ['python', 'x = "# not a comment"'], // # inside string
    ['python', 'd = { "a": 1 }  # trailing not counted (conservative)'],
    ['sql', 'SELECT a - b FROM t'], // single dash, not --
    ['shell', 'echo "# hi"'],
    ['css', 'color: red; /* trailing */'], // not line-leading
  ]
  for (const [lang, text] of negatives) {
    it(`[${lang}] does NOT dim as comment: ${text.trim()}`, () => {
      expect(classifyNoise(text, lang)).not.toBe('comment')
    })
  }
})

describe('classifyNoise — null language and blanks', () => {
  it('returns null when lang is null', () => {
    expect(classifyNoise('import x', null)).toBeNull()
  })
  it('returns null for blank lines', () => {
    expect(classifyNoise('   ', 'js')).toBeNull()
    expect(classifyNoise('', 'js')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Span-aware classification (multi-line imports + block comments)
// ---------------------------------------------------------------------------

/** Convenience: assert every line of `lines` classified to `kind`. */
function allKinds(lines: string[], lang: CodeLang) {
  return classifyNoiseLines(lines, lang)
}

describe('classifyNoiseLines — multi-line imports', () => {
  it('[js/tsx] the exact reported TSX case: import { \\n names \\n } from — all lines import', () => {
    const lines = [
      "import { DetectiveHog } from 'lib/components/hedgehogs'",
      'import {',
      '    WIDGET_LIST_COUNT_EVENTS,',
      '    WidgetCardBodyMessage,',
      '    WidgetCardContent,',
      "} from '../../components/WidgetCard'",
    ]
    expect(allKinds(lines, 'js')).toEqual([
      'import',
      'import',
      'import',
      'import',
      'import',
      'import',
    ])
  })

  it('[js] import x, { … } default + named multi-line', () => {
    const lines = ['import React, {', '  useState,', '  useEffect,', "} from 'react'"]
    expect(allKinds(lines, 'js')).toEqual(['import', 'import', 'import', 'import'])
  })

  it('[js] lone `}` then a separate `from` line is included', () => {
    const lines = ['import {', '  a,', '  b,', '}', "from './m'"]
    expect(allKinds(lines, 'js')).toEqual(['import', 'import', 'import', 'import', 'import'])
  })

  it('[js] dynamic import( … ) spanning lines (line-leading)', () => {
    const lines = ['import(', "  './lazy'", ')', 'const x = 1']
    const k = allKinds(lines, 'js')
    expect(k.slice(0, 3)).toEqual(['import', 'import', 'import'])
    expect(k[3]).toBeNull()
  })

  it('[js] single-line imports still detected; span closes before real code', () => {
    const lines = [
      "import { a } from 'x'",
      'import {',
      '  b,',
      "} from 'y'",
      'const real = doWork()',
      'function f() {}',
    ]
    const k = allKinds(lines, 'js')
    expect(k.slice(0, 4)).toEqual(['import', 'import', 'import', 'import'])
    expect(k[4]).toBeNull()
    expect(k[5]).toBeNull()
  })

  it('[go] import ( … ) block — all lines import, closes on )', () => {
    const lines = ['import (', '\t"fmt"', '\t"os"', ')', 'func main() {}']
    const k = allKinds(lines, 'go')
    expect(k.slice(0, 4)).toEqual(['import', 'import', 'import', 'import'])
    expect(k[4]).toBeNull()
  })

  it('[python] from x import ( … ) paren block', () => {
    const lines = ['from os.path import (', '    join,', '    exists,', ')', 'x = 1']
    const k = allKinds(lines, 'python')
    expect(k.slice(0, 4)).toEqual(['import', 'import', 'import', 'import'])
    expect(k[4]).toBeNull()
  })

  it('[python] backslash-continued from import', () => {
    const lines = ['from mod import a, \\', '    b, \\', '    c', 'x = 1']
    const k = allKinds(lines, 'python')
    expect(k.slice(0, 3)).toEqual(['import', 'import', 'import'])
    expect(k[3]).toBeNull()
  })

  it('[rust] use a::{ … }; multi-line', () => {
    const lines = ['use std::collections::{', '    HashMap,', '    HashSet,', '};', 'fn main() {}']
    const k = allKinds(lines, 'rust')
    expect(k.slice(0, 4)).toEqual(['import', 'import', 'import', 'import'])
    expect(k[4]).toBeNull()
  })

  it('multi-line import immediately followed by real code — code NOT dimmed', () => {
    const lines = ['import {', '  Foo,', "} from 'foo'", 'export const VALUE = { a: 1 }']
    const k = allKinds(lines, 'js')
    expect(k[3]).toBeNull()
  })
})

describe('classifyNoiseLines — negative (no false spans)', () => {
  it('[js] const importType = ... does not open a span', () => {
    const lines = ['const importType = {', '  kind: 1,', '}', 'const next = 2']
    expect(allKinds(lines, 'js').every((k) => k === null)).toBe(true)
  })

  it('[js] a string containing "import {" does not open a span', () => {
    const lines = ["const s = 'import {'", 'const next = 2', 'const again = 3']
    expect(allKinds(lines, 'js').every((k) => k === null)).toBe(true)
  })

  it('[js] single-line import { a } from does not start a span (next code stays bright)', () => {
    const lines = ["import { a } from 'x'", 'const real = 1']
    const k = allKinds(lines, 'js')
    expect(k[0]).toBe('import')
    expect(k[1]).toBeNull()
  })
})

describe('classifyNoiseLines — multi-line block comments', () => {
  it('[js] /* … */ block comment dims the full span', () => {
    const lines = ['/*', ' * a doc block', ' * over lines', ' */', 'const real = 1']
    const k = allKinds(lines, 'js')
    expect(k.slice(0, 4)).toEqual(['comment', 'comment', 'comment', 'comment'])
    expect(k[4]).toBeNull()
  })

  it('[js] block comment opened with text on the opening line', () => {
    const lines = ['/* opening text', 'middle', 'closing */', 'const x = 1']
    const k = allKinds(lines, 'js')
    expect(k.slice(0, 3)).toEqual(['comment', 'comment', 'comment'])
    expect(k[3]).toBeNull()
  })

  it('[css] /* … */ multi-line', () => {
    const lines = ['/* theme', '   tokens */', '.a { color: red }']
    const k = allKinds(lines, 'css')
    expect(k.slice(0, 2)).toEqual(['comment', 'comment'])
    expect(k[2]).toBeNull()
  })

  it('single-line /* … */ does not open a span', () => {
    const lines = ['/* one line */', 'const real = 1']
    const k = allKinds(lines, 'js')
    expect(k[0]).toBe('comment')
    expect(k[1]).toBeNull()
  })
})

describe('classifyNoiseLines — passthrough behaviour', () => {
  it('returns all-null for null language', () => {
    expect(classifyNoiseLines(['import x', 'foo'], null)).toEqual([null, null])
  })
  it('preserves single-line comment + import classification per line', () => {
    const lines = ["import os", "# a comment", "x = 1"]
    expect(classifyNoiseLines(lines, 'python')).toEqual(['import', 'comment', null])
  })
})
