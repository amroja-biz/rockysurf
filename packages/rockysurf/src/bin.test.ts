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

/**
 * `--help` NAMES EVERY COMMAND THE BINARY DISPATCHES (rockysurf-3w2u).
 *
 * It used to name none of them. The help text lives in core's `runCli`, every subcommand is
 * dispatched in `cli.ts` before `runCli` is reached, and core may not import that package — so
 * an operator who had not read the docs could not discover a single command from the binary.
 *
 * The fix is structural rather than a list somebody has to remember: `SUBCOMMANDS` is both the
 * dispatch and the help, so the two cannot disagree. These tests pin the property that makes
 * that true, and the one thing that could still break it — a command dispatched by a hand-rolled
 * `if` above the table lookup, which would run without ever appearing in the help.
 */
describe('the help text and the dispatch table', () => {
  const cliSource = readFileSync(join(process.cwd(), 'src/cli.ts'), 'utf8')

  /** Every `name:` in the SUBCOMMANDS table, read from the source rather than imported. */
  const declared = (): string[] => {
    const table = cliSource.slice(cliSource.indexOf('const SUBCOMMANDS'), cliSource.indexOf('export async function runRockysurfCli'))
    return [...table.matchAll(/name: '([^']+)'/g)].map((m) => m[1]!)
  }

  it('declares the eight commands the CLI has, plus offerings', () => {
    // Not a list to keep in step — a floor. It fails if the table is emptied or gutted, which
    // is the way this could silently stop being a real check.
    expect(declared()).toEqual(
      expect.arrayContaining(['mcp', 'token', 'list', 'create', 'stop', 'ssh', 'ssh-config', 'offerings', 'pack']),
    )
  })

  it('gives every command a summary, since a name with no summary is a blank help line', () => {
    const table = cliSource.slice(cliSource.indexOf('const SUBCOMMANDS'), cliSource.indexOf('export async function runRockysurfCli'))
    expect([...table.matchAll(/summary: /g)]).toHaveLength(declared().length)
  })

  /**
   * THE ONE WAY THE PROPERTY CAN STILL BE BROKEN, so it is the one worth a test.
   *
   * Deriving the help from the table makes drift impossible for anything IN the table. A
   * `if (command === 'x') return …` written above the lookup would dispatch a command the help
   * has never heard of, which is exactly the shape the code had before this bead.
   */
  it('dispatches from the table alone, with no hand-rolled command comparison', () => {
    const dispatch = cliSource.slice(
      cliSource.indexOf('export async function runRockysurfCli'),
      cliSource.indexOf('NEITHER `mcp` NOR `token` MAY BOOT CORE'),
    )
    expect(dispatch).toContain('SUBCOMMANDS.find')
    expect(dispatch).not.toMatch(/command === '/)
  })

  it('hands the table to core, which is what puts it in the help', () => {
    expect(cliSource).toMatch(/subcommands: SUBCOMMANDS\.map/)
  })
})
