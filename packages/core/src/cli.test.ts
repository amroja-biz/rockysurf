import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DATA_DIR_MODE, ensureDataDir } from './boot/data-dir.js'
import { MIN_NODE_MAJOR, nodeVersionError, parseArgs, readVersion, runCli } from './cli.js'

/**
 * Core's half of the CLI: the pure units it owns.
 *
 * The suite that SPAWNED a built binary lives in `packages/rockysurf/src/bin.e2e.test.ts`
 * (rockysurf-zrfb). It used to be here, pointed at `packages/core/dist/bin.js` — a file whose
 * source was deleted when the binary moved to the composition root (003296b), so it passed only
 * against a stale build artifact and failed on every clean checkout. Core ships no binary; the
 * package that does owns those tests.
 */

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-cli-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ pure units */

describe('argument parsing', () => {
  it('defaults to serve', () => {
    expect(parseArgs([])).toEqual({ command: 'serve' })
    expect(parseArgs(['serve'])).toEqual({ command: 'serve' })
  })

  it.each([['--help'], ['-h']])('%s asks for help', (flag) => {
    expect(parseArgs([flag])).toEqual({ command: 'help' })
  })

  it.each([['--version'], ['-v']])('%s asks for the version', (flag) => {
    expect(parseArgs([flag])).toEqual({ command: 'version' })
  })

  it('takes a config path', () => {
    expect(parseArgs(['--config', '/etc/rockysurf.yaml'])).toMatchObject({ configPath: '/etc/rockysurf.yaml' })
  })

  it('takes a port override', () => {
    expect(parseArgs(['--port', '8080'])).toMatchObject({ port: 8080 })
  })

  it.each([
    [['--config'], /--config needs a path/],
    [['--port'], /--port needs a number/],
    [['--port', 'http'], /--port needs a number/],
    [['--port', '70000'], /--port needs a number/],
    [['--wat'], /unknown option: --wat/],
  ])('rejects %j', (argv, message) => {
    expect(parseArgs(argv).error).toMatch(message)
  })

  it('reports the package version', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

/**
 * Whose version `--version` answers with (rockysurf-aor6).
 *
 * Core is a dependency of the published CLI, not the thing anyone installs, so it must be
 * possible for the composition root to answer for itself. These use a distinctly non-core
 * version string, because the two packages sit at the same number today and an assertion that
 * cannot tell them apart would prove nothing.
 */
describe('the version the CLI reports', () => {
  const collect = () => {
    const out: string[] = []
    return { out, io: { out: (m: string) => out.push(m), err: () => {} } }
  }

  it('is the one the caller supplied', async () => {
    const { out, io } = collect()
    expect(await runCli(['--version'], { io, version: '9.9.9-composed' })).toBe(0)
    expect(out).toEqual(['9.9.9-composed'])
    // Specifically NOT core's own, which is what the bug printed.
    expect(out[0]).not.toBe(readVersion())
  })

  it("falls back to core's own when nobody supplied one", async () => {
    const { out, io } = collect()
    expect(await runCli(['--version'], { io })).toBe(0)
    expect(out).toEqual([readVersion()])
  })
})

describe('the Node version gate', () => {
  it('passes anything new enough', () => {
    expect(nodeVersionError(`v${MIN_NODE_MAJOR}.0.0`)).toBeUndefined()
    expect(nodeVersionError('v30.1.2')).toBeUndefined()
    expect(nodeVersionError(process.version)).toBeUndefined()
  })

  it('explains itself on an old Node instead of crashing', () => {
    const message = nodeVersionError('v20.19.0')
    expect(message).toContain('needs Node 24 or newer')
    expect(message).toContain('v20.19.0')
    // The whole point: it tells them what to do next.
    expect(message).toContain('nvm install 24')
  })

  it('says nothing on an unparseable version rather than blocking a boot', () => {
    expect(nodeVersionError('not-a-version')).toBeUndefined()
  })

  // The `bin.js` Node-version gate moved to the composition root with the binary itself
  // (rockysurf-55fx.12): core can no longer wire providers, so a `rockysurf` command that ran
  // core alone would boot with no cloud. Its test moved too — see
  // `packages/rockysurf/src/bin.test.ts`.
})

describe('the data directory', () => {
  it('is created owner-only', () => {
    const dir = join(tempDir(), 'data')
    const result = ensureDataDir(dir)

    expect(result.created).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(DATA_DIR_MODE)
  })

  it('tightens a directory that already exists too loosely', () => {
    const dir = join(tempDir(), 'data')
    ensureDataDir(dir)
    spawnSync('chmod', ['755', dir])
    expect(statSync(dir).mode & 0o777).toBe(0o755)

    const result = ensureDataDir(dir)
    expect(result.created).toBe(false)
    expect(statSync(dir).mode & 0o777).toBe(DATA_DIR_MODE)
  })

  it('is idempotent', () => {
    const dir = join(tempDir(), 'data')
    expect(ensureDataDir(dir).created).toBe(true)
    expect(ensureDataDir(dir).created).toBe(false)
  })

  it('creates intermediate directories', () => {
    const dir = join(tempDir(), 'a', 'b', 'c')
    ensureDataDir(dir)
    expect(existsSync(dir)).toBe(true)
  })
})
