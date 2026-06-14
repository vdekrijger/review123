import { describe, it, expect } from 'vitest'
import { langForFilename, classifyNoise, type CodeLang } from './codeNoise'

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
