// @vitest-environment node
/**
 * bundle.test.ts — guards on the single-file release artifact.
 *
 * Running esbuild here would need the network and ~10 s, so the bundling
 * itself is not under test. What IS under test is everything that decides
 * whether the published file is HONEST: the version it claims, and the header
 * that tells whoever downloads it what they are about to run.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ENTRY,
  BRIDGE_DIR,
  ESBUILD_VERSION,
  SOURCE_URL,
  assertVersionsAgree,
  buildHeader,
  esbuildArgs,
  readCliVersion,
  stripLeadingHashbang,
} from './bundle.mjs'
import { join } from 'node:path'

describe('version pinning', () => {
  it('reads BRIDGE_VERSION out of cli.ts', () => {
    expect(readCliVersion("export const BRIDGE_VERSION = '1.2.3'\n")).toBe('1.2.3')
  })

  it('throws rather than guess when BRIDGE_VERSION is gone', () => {
    expect(() => readCliVersion('const x = 1')).toThrow(/BRIDGE_VERSION/)
  })

  it('refuses to build when package.json and cli.ts disagree', () => {
    expect(() => assertVersionsAgree('0.1.0', '0.2.0')).toThrow(/version drift/)
  })

  it('passes the version through when they agree', () => {
    expect(assertVersionsAgree('0.1.0', '0.1.0')).toBe('0.1.0')
  })

  // The one that actually protects a release: an artifact whose header says
  // 0.1.0 while /v1/health reports 0.2.0 makes every bug report ambiguous.
  it('the REAL cli.ts and package.json agree today', () => {
    const pkg = JSON.parse(readFileSync(join(BRIDGE_DIR, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(() => assertVersionsAgree(pkg.version, readCliVersion(readFileSync(ENTRY, 'utf8')))).not.toThrow()
  })
})

describe('bundle header', () => {
  const header = buildHeader({ version: '0.1.0', sha: 'abc1234' })

  it('starts with a hashbang so the file is also directly executable', () => {
    expect(header.split('\n')[0]).toBe('#!/usr/bin/env node')
  })

  it('names the version, the commit and the bundler version', () => {
    expect(header).toContain('review123 local bridge 0.1.0')
    expect(header).toContain('abc1234')
    expect(header).toContain(ESBUILD_VERSION)
  })

  it('points back at the source it was built from', () => {
    expect(header).toContain(SOURCE_URL)
  })

  it('shows the command it is meant to be run with', () => {
    expect(header).toContain('node bridge.mjs --root .')
  })

  // This file is code that hands a web origin read access to a repo. Someone
  // who opens it must not have to go looking for that fact.
  it('states the access it grants and that it binds loopback only', () => {
    expect(header).toContain('https://review123.dev read access to that repo')
    expect(header).toContain('pairing token')
    expect(header).toContain('binds 127.0.0.1 only')
  })
})

describe('esbuild invocation', () => {
  const args = esbuildArgs('/out/bridge.mjs')

  it('pins the bundler version instead of floating on latest', () => {
    expect(args).toContain(`esbuild@${ESBUILD_VERSION}`)
  })

  // Left to itself esbuild walks up to the repo-root tsconfig — the browser
  // SPA's, which extends a package a fresh clone has not installed. A Node
  // artifact must not inherit its compile settings from the web app.
  it('pins the bridge’s own tsconfig, not the repo-root SPA one', () => {
    expect(args).toContain(`--tsconfig=${join(BRIDGE_DIR, 'tsconfig.json')}`)
  })

  it('targets Node 22 ESM, matching the package engines field', () => {
    expect(args).toEqual(expect.arrayContaining(['--platform=node', '--target=node22', '--format=esm']))
  })
})

describe('stripLeadingHashbang', () => {
  it('drops esbuild’s copy of the entry hashbang', () => {
    expect(stripLeadingHashbang('#!/usr/bin/env node\nconst a = 1\n')).toBe('const a = 1\n')
  })

  it('leaves code that has none alone', () => {
    expect(stripLeadingHashbang('const a = 1\n')).toBe('const a = 1\n')
  })
})
