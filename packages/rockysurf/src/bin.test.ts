import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The binary's Node-version gate.
 *
 * Moved here from `@rockysurf/core` with the binary itself (rockysurf-55fx.12): core cannot
 * wire providers, so a `rockysurf` command that ran core alone would come up with no cloud
 * provider at all. The published package owns the entry point, and its test came with it.
 */

const source = readFileSync(join(process.cwd(), 'src/bin.ts'), 'utf8')

describe('the Node version gate', () => {
  it('runs the check BEFORE the CLI is imported', () => {
    // Static imports are hoisted and evaluated before any statement, so a top-level import of
    // the CLI would defeat the gate: an old Node would throw a SyntaxError from a module the
    // operator has never heard of, before this check ever ran.
    const gateAt = source.indexOf('MIN_NODE_MAJOR')
    const importAt = source.indexOf("import('./cli.js')")

    expect(gateAt).toBeGreaterThan(-1)
    expect(importAt).toBeGreaterThan(gateAt)
    expect(source).not.toMatch(/^import .* from '\.\/cli\.js'/m)
  })

  it('names the version it needs and how to get it', () => {
    // A version error that does not say what to install is a version error that costs a
    // support round trip.
    expect(source).toContain('nvm install 24')
    expect(source).toMatch(/needs Node \$\{MIN_NODE_MAJOR\} or newer/)
  })

  it('reaches the composed CLI, not core’s', () => {
    // The whole point of the move: this entry point must go through the wrapper that supplies
    // the provider registry.
    expect(source).toContain('runRockysurfCli')
  })
})
