import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * The shipped binary, driven end to end (rockysurf-zrfb).
 *
 * These spawn the built `dist/bin.js` — the artifact `bin: { rockysurf }` publishes, the one
 * `docker/entrypoint.sh` and `scripts/e2e/*.mjs` run. Testing the source instead would not prove
 * the things that matter: that the shebang survives the build, that the compiled entry resolves
 * its own imports, that the composed CLI comes up with a provider registry, and that the process
 * exits cleanly on a signal.
 *
 * THEY USED TO LIVE IN `packages/core/src/cli.test.ts`, pointed at `packages/core/dist/bin.js`.
 * That source was deleted when the binary moved to this package (003296b), so the suite passed
 * only against a build artifact from before the move that nobody ever cleaned — seven tests
 * asserting on a binary that came up with no cloud provider at all, and a red suite on any
 * clean checkout. The other half of that — emptying `dist/` before each build, since a stale
 * artifact is what hid it — landed as rockysurf-hwfw.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(packageRoot, '..', '..')
const binPath = join(packageRoot, 'dist', 'bin.js')

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-bin-'))
  tempDirs.push(dir)
  return dir
}

function versionOf(packageDir: string): string {
  return (JSON.parse(readFileSync(join(repoRoot, packageDir, 'package.json'), 'utf8')) as { version: string }).version
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('the rockysurf binary', () => {
  // Built by `vitest.global-setup.ts`, which compiles this package and everything it imports
  // before any test file runs. See that file for why the build cannot live in a `beforeAll`.
  it('is built by the time these tests run', () => {
    expect(existsSync(binPath)).toBe(true)
  })

  it('keeps the shebang, so npm can link it as an executable', () => {
    const first = spawnSync('head', ['-1', binPath], { encoding: 'utf8' }).stdout.trim()
    expect(first).toBe('#!/usr/bin/env node')
  })

  it('prints its own version and exits 0', () => {
    const run = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    // THIS package's manifest — the version of the thing somebody installed and typed
    // (rockysurf-aor6). It used to be @rockysurf/core's, which is a dependency's number.
    expect(run.stdout.trim()).toBe(versionOf('packages/rockysurf'))
  })

  /**
   * The same claim, made in a way that can actually fail today (rockysurf-aor6).
   *
   * Every package in this workspace sits at 0.1.0, so the assertion above passes whichever
   * manifest the binary reads — it only becomes evidence once the two versions differ, which is
   * exactly the day the bug matters and much too late to find out. So this builds a package tree
   * where they DO differ: the real `dist/` and a manifest with a distinctive version, beside a
   * symlink to the real `node_modules` so `@rockysurf/core` still resolves to the workspace copy
   * at its own 0.1.0. If the CLI is answering with core's version, this prints 0.1.0 and fails.
   */
  it("reads that version from its own manifest, not from core's", () => {
    const overlay = tempDir()
    cpSync(join(packageRoot, 'dist'), join(overlay, 'dist'), { recursive: true })
    writeFileSync(
      join(overlay, 'package.json'),
      JSON.stringify({ name: 'rockysurf', version: '42.7.3-overlay', type: 'module' }),
    )
    symlinkSync(join(packageRoot, 'node_modules'), join(overlay, 'node_modules'))

    const run = spawnSync(process.execPath, [join(overlay, 'dist', 'bin.js'), '--version'], { encoding: 'utf8' })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('42.7.3-overlay')
    // The dependency is still at the workspace version, so this really did distinguish them.
    expect(versionOf('packages/core')).not.toBe('42.7.3-overlay')
  })

  it('prints usage and exits 0 for --help', () => {
    const run = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Usage')
    expect(run.stdout).toContain('--config')
  })

  /**
   * AND THE HELP NAMES THE COMMANDS (rockysurf-3w2u), from the shipped binary.
   *
   * It named none of them. The help text lives in core, every subcommand is dispatched in the
   * composed package before core is reached, and core may not import that package — so an
   * operator who had not read `docs/self-hosting.md` could not discover `mcp`, `token` or any
   * of the others from the thing they had just installed.
   *
   * Asserted against the real process rather than the `usage()` function because the seam being
   * proved is a composition: core renders what the composition root passes it, and a unit test
   * on either half would pass with the wiring missing.
   */
  it('lists every subcommand it dispatches, from the shipped binary', () => {
    const run = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' })
    expect(run.stdout).toContain('Commands')
    for (const command of ['mcp', 'token', 'list', 'create', 'stop', 'ssh', 'ssh-config', 'offerings', 'pack']) {
      expect(run.stdout, `--help does not mention \`rockysurf ${command}\``).toContain(`rockysurf ${command}`)
    }
    // The floor, which appears in no document in this repository — this line IS create's
    // documentation (rockysurf-zaqs).
    expect(run.stdout).toMatch(/--size is a floor/)
  })

  /**
   * A COMMAND WRITTEN AFTER THE OPTIONS (issue #112), from the shipped binary.
   *
   * `rockysurf --config <path> token` answered `unknown option: token` and then printed help
   * that lists `token` as a command — the error pointed away from its own fix, and the operator
   * who hit it during a real Azure setup had no way to tell what the rule was. The dispatch
   * happens on `argv[0]` in this package before core parses anything, so the order is a real
   * constraint; what changed is that it is now stated, both in the refusal and in the help.
   *
   * Spawned rather than unit-tested for the same reason as the block above: what is being
   * proved is that this package's subcommand table reaches core's parser.
   */
  it('says a command written after the options is misplaced, and prints the line that works', () => {
    const run = spawnSync(process.execPath, [binPath, '--config', '/nowhere.yaml', 'token'], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('token is a command, not an option')
    expect(run.stderr).toContain('rockysurf token --config /nowhere.yaml')
    expect(run.stderr).not.toContain('unknown option: token')
  })

  it('documents the command-first rule in the help itself', () => {
    const run = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' })
    expect(run.stdout).toContain('A command comes FIRST')
  })

  it('exits 2 with usage on an unknown option', () => {
    const run = spawnSync(process.execPath, [binPath, '--nope'], { encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('unknown option: --nope')
    expect(run.stderr).toContain('Usage')
  })

  it('passes a config refusal through verbatim and exits 1', () => {
    const dir = tempDir()
    const configPath = join(dir, 'broken.yaml')
    writeFileSync(configPath, 'server:\n  port: "not a port"\n')

    const run = spawnSync(process.execPath, [binPath, '--config', configPath], { encoding: 'utf8', timeout: 60_000 })
    expect(run.status).toBe(1)
    // The message names the file, because it was written to be printed.
    expect(run.stderr).toContain(configPath)
  })

  it('refuses a --config path with nothing at it, rather than starting on defaults', () => {
    // The other half of rockysurf-cf51: an absent DEFAULT file is a first run, an absent NAMED
    // file is a typo. Booting a server on defaults after someone asked for a specific file is
    // how an installation comes up with the wrong settings and nobody notices.
    const missing = join(tempDir(), 'nowhere.yaml')
    const run = spawnSync(process.execPath, [binPath, '--config', missing], { encoding: 'utf8', timeout: 60_000 })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('no config file at')
    expect(run.stderr).toContain(missing)
  })

  it('syncs the repository packs when started from a checkout', async () => {
    const dir = tempDir()
    const dataDir = join(dir, 'data')
    const port = 41000 + Math.floor(Math.random() * 2000)
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(configPath, `server:\n  port: ${port}\n  dataDir: ${dataDir}\n`)

    // cwd at the repository root, so the checkout branch of resolvePacksDir fires.
    const expected = readdirSync(join(repoRoot, 'packs')).filter((f) => f.endsWith('.yaml')).length

    // A known password, so the test can log in rather than scraping the generated one.
    const password = 'test-admin-password'
    const server = await startServer({
      args: ['--config', configPath],
      port,
      cwd: repoRoot,
      env: { ROCKYSURF_ADMIN_PASSWORD: password },
    })
    try {
      expect(server.read()).toMatch(/packs: \d+ pack\(s\)/)

      // The catalogue is behind the session, so this exercises login too.
      const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      expect(login.status).toBe(200)
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
      expect(cookie).not.toBe('')

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/surge-packs`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { surgePacks?: unknown[] } | unknown[]
      const packs = Array.isArray(body) ? body : (body.surgePacks ?? [])
      expect(packs).toHaveLength(expected)
    } finally {
      await stopServer(server)
    }
  }, 120_000)

  /**
   * A PERSONAL PROVIDER, LOADED BY THE REAL BINARY (ADR-0026). The unit tests prove the loader
   * and the composition each do their half; this is the whole-boot wiring test the repository's
   * own memory demands — the seam between `runRockysurfCli` loading once and `boot()` awaiting
   * the first composition is exactly the kind of gap unit tests cannot see.
   */
  it('loads a personal provider named by path in the config, and says so with the trust sentence', async () => {
    const dir = tempDir()
    const dataDir = join(dir, 'data')
    const port = 41000 + Math.floor(Math.random() * 2000)
    const providerDir = join(dir, 'nimbus-provider')
    mkdirSync(providerDir)
    writeFileSync(join(providerDir, 'package.json'), JSON.stringify({ name: 'nimbus', type: 'module', exports: { '.': { import: './index.js' } } }))
    writeFileSync(
      join(providerDir, 'index.js'),
      `export default {
  id: 'nimbus',
  displayName: 'Nimbus Cloud',
  configSchema: { parse: (input) => input },
  createProvider: () => ({
    id: 'nimbus', displayName: 'Nimbus Cloud',
    capabilities: { stop: true, ipStableAcrossStop: true, canInjectHostKeys: false, userDataMaxBytes: 0, generatesUserData: false, simulatedInstances: true },
    validateCredentials: async () => {}, validateSpec: async () => {},
    listOfferings: async () => [{ id: 'n-1', cpu: 2, memoryGb: 4, arch: 'amd64', hourly: null, available: true, region: 'sky' }],
    provision: async () => ({ data: { id: '1' }, initial: { state: 'running', publicIp: '203.0.113.9' } }),
    describe: async () => ({ state: 'running', publicIp: '203.0.113.9' }),
    terminate: async () => {}, listManaged: async () => [], stop: async () => {}, start: async () => {},
  }),
}
`,
    )
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(
      configPath,
      `server:\n  port: ${port}\n  dataDir: ${dataDir}\nproviders:\n  nimbus:\n    package: ${providerDir}\n    enabled: true\n`,
    )

    const password = 'test-admin-password'
    const server = await startServer({ args: ['--config', configPath], port, cwd: repoRoot, env: { ROCKYSURF_ADMIN_PASSWORD: password } })
    try {
      expect(server.read()).toContain(`nimbus: personal provider "${providerDir}"`)
      expect(server.read()).toContain("a provider runs with Rocky Surf's full access — install ones you trust.")
      expect(server.read()).toContain('nimbus: ready')

      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { providers: string[] }
      expect(health.providers).toEqual(['nimbus'])

      const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
      const providers = (await (await fetch(`http://127.0.0.1:${port}/api/v1/providers`, { headers: { cookie } })).json()) as {
        id: string
        displayName: string
        offerings: { id: string }[]
      }[]
      expect(providers.map((p) => [p.id, p.displayName])).toEqual([['nimbus', 'Nimbus Cloud']])
      expect(providers[0]?.offerings.map((o) => o.id)).toEqual(['n-1'])
    } finally {
      await stopServer(server)
    }
  }, 120_000)

  it('boots, serves, and shuts down cleanly — then does not regenerate the password', async () => {
    const dir = tempDir()
    const dataDir = join(dir, 'data')
    const port = 39000 + Math.floor(Math.random() * 2000)
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(configPath, `server:\n  port: ${port}\n  dataDir: ${dataDir}\n`)

    /* ---- first boot ---- */
    const first = await startServer({ args: ['--config', configPath], port })

    expect(first.stderr).toMatch(/first boot — your admin password is/i)
    expect(first.stderr).toContain(`http://127.0.0.1:${port}`)
    expect(first.stderr).toContain(dataDir)
    // With three places a config file can come from, a start names the one it read
    // (rockysurf-8wgm) — here, the one `--config` pointed at.
    expect(first.stderr).toContain(`config: ${configPath}`)

    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
    // The root serves a page rather than a 404, which is an acceptance criterion.
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)

    // First boot created everything, with the right permissions.
    expect(statSync(dataDir).mode & 0o777).toBe(DATA_DIR_MODE)
    expect(statSync(join(dataDir, 'secret.key')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dataDir, 'rockysurf.db'))).toBe(true)

    const firstExit = await stopServer(first)
    expect(firstExit.code).toBe(0)
    expect(firstExit.stderr).toContain('shutting down')

    /* ---- second boot, same data directory ---- */
    const second = await startServer({ args: ['--config', configPath], port })

    // The password is generated once and only once. Printing it again on every start would
    // train people to ignore it — and it is not recoverable, so a second banner would be a lie.
    expect(second.stderr).not.toMatch(/your admin password is/i)
    expect(second.stderr).not.toMatch(/A NEW ENCRYPTION KEY WAS GENERATED/i)
    expect(second.stderr).not.toContain('First boot')
    // ...but it still comes up and serves.
    expect(second.stderr).toContain(`http://127.0.0.1:${port}`)
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)

    const secondExit = await stopServer(second)
    expect(secondExit.code).toBe(0)

    // A clean shutdown checkpoints the WAL away, so the database file is the whole database.
    expect(existsSync(join(dataDir, 'rockysurf.db-wal'))).toBe(false)
  }, 120_000)

  /**
   * THE FIRST-RUN STORY (rockysurf-cf51), through the real entry point.
   *
   * `npx rockysurf` in a directory with no `rockysurf.config.yaml` used to print a refusal and
   * exit 1, which put the wizard — and the fake provider that exists precisely so someone can
   * watch a server boot before pasting a cloud token — behind copying an example file out of a
   * repository they were never asked to clone. Driven here rather than against `loadConfig`
   * because the unit test would have passed all along: what was broken was the whole path from
   * an empty directory to a served page.
   */
  it('starts on defaults in an empty directory, with no config file at all', async () => {
    const home = tempDir()
    const cwd = tempDir()
    const port = 43000 + Math.floor(Math.random() * 2000)
    const password = 'test-admin-password'

    // HOME is redirected because the default dataDir is `~/.rockysurf` — deliberately the
    // operator's home rather than wherever npx was run, and this test must not write into the
    // real one. The password is supplied so the wizard state can be read without scraping the
    // generated one out of the banner.
    const server = await startServer({
      args: ['--port', String(port)],
      port,
      cwd,
      env: { HOME: home, ROCKYSURF_ADMIN_PASSWORD: password },
    })
    try {
      // It says there is no config file, names BOTH paths one could go at — the working
      // directory and the durable home (rockysurf-8wgm) — and does not sound like a failure.
      expect(server.stderr).toContain(join(cwd, 'rockysurf.config.yaml'))
      expect(server.stderr).toContain(join(home, '.rockysurf', 'config.yaml'))
      expect(server.stderr).toMatch(/starting with defaults/i)

      // A provider registry is wired even with nothing configured, which is what makes the
      // "create a server before you have a cloud account" trial run reachable.
      expect(server.stderr).toContain('[providers] fake:')

      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)

      // The wizard is reachable and has something to say — this is where a first run lands.
      const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      expect(login.status).toBe(200)
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''

      const setup = await fetch(`http://127.0.0.1:${port}/api/v1/setup`, { headers: { cookie } })
      expect(setup.status).toBe(200)
      const body = (await setup.json()) as { data?: unknown }
      expect(body.data ?? body).toMatchObject({ complete: false, needsProvider: true })

      /**
       * AND THE FIRST SAVE FROM THE SETTINGS PAGE CREATES THE HOME FILE (rockysurf-8wgm).
       *
       * This is the other half of "npx must not litter": the run has no config file at all, so
       * the page has to write one somewhere, and the one place it must not be is the directory
       * the command was typed in — where it would silently become the config for whoever `cd`s
       * there next. The page is told the path before it writes, so it can say where the save
       * will land rather than making the operator guess.
       */
      const homeConfig = join(home, '.rockysurf', 'config.yaml')
      const settingsUrl = `http://127.0.0.1:${port}/api/v1/settings`
      const before = await fetch(settingsUrl, { headers: { cookie } })
      expect(before.status).toBe(200)
      expect(await before.json()).toMatchObject({ file: { path: homeConfig, exists: false, mtimeMs: null } })

      const saved = await fetch(settingsUrl, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ mtimeMs: null, changes: [{ path: ['limits', 'maxServers'], value: 7 }] }),
      })
      expect(saved.status, await saved.clone().text()).toBe(200)
      expect(readFileSync(homeConfig, 'utf8')).toContain('maxServers: 7')

      // Defaults put the data in ~/.rockysurf, not in the directory npx was run from — and
      // neither does the config file the page just created.
      expect(existsSync(join(home, '.rockysurf', 'rockysurf.db'))).toBe(true)
      expect(existsSync(join(cwd, 'rockysurf.config.yaml'))).toBe(false)
      expect(readdirSync(cwd)).toEqual([])
    } finally {
      const exit = await stopServer(server)
      expect(exit.code).toBe(0)
    }
  }, 120_000)

  /**
   * THE DURABLE HOME (rockysurf-8wgm), through the real binary and a real `$HOME`.
   *
   * The unit tests point the third tier at a scratch directory explicitly, which proves the
   * search order but not that the search reaches the operator's actual home — that part is
   * `homedir()`, and the only honest way to check it is to spawn a process with `HOME` set and
   * no other way to find the file: no `--config`, nothing in the working directory, and a port
   * that exists nowhere but in `~/.rockysurf/config.yaml`.
   */
  it('reads ~/.rockysurf/config.yaml when the working directory has no config file', async () => {
    const home = tempDir()
    const cwd = tempDir()
    const port = 45000 + Math.floor(Math.random() * 2000)
    const homeConfig = join(home, '.rockysurf', 'config.yaml')
    mkdirSync(join(home, '.rockysurf'), { recursive: true })
    writeFileSync(homeConfig, `server:\n  port: ${port}\n`)

    const server = await startServer({
      args: [],
      port,
      cwd,
      env: { HOME: home, ROCKYSURF_ADMIN_PASSWORD: 'test-admin-password' },
    })
    try {
      // It came up on a port that only the home file names, and it says which file that was.
      expect(server.stderr).toContain(`config: ${homeConfig}`)
      expect(server.stderr).not.toMatch(/starting with defaults/i)
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
      expect(readdirSync(cwd)).toEqual([])
    } finally {
      const exit = await stopServer(server)
      expect(exit.code).toBe(0)
    }
  }, 120_000)

  /**
   * `token` AND `mcp` IN SOMEBODY ELSE'S ENVIRONMENT (rockysurf-dd9q).
   *
   * These two are the only commands whose caller is not the operator's shell. A `.mcp.json`
   * launches `rockysurf mcp` with the variables that file sets and nothing else, so the export
   * set the config file was written against is simply absent — and boot's rule, that every
   * `${VAR}` the file names must be set, refused both commands over a repository token neither
   * of them reads. The workaround found on the night this was filed was exporting dummy values
   * for the operator's real PATs, which is the opposite of handing an agent the narrowest thing
   * that works.
   *
   * Spawned rather than unit-tested for the reason the whole file exists: what was broken was
   * the path from a config file to a running MCP server, and only a real process has an
   * environment to strip.
   */
  it('mints a token and serves MCP with the operator’s unrelated variables unset', async () => {
    const dir = tempDir()
    const dataDir = join(dir, 'data')
    const port = 47000 + Math.floor(Math.random() * 2000)
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(
      configPath,
      `server:\n  port: ${port}\n  dataDir: ${dataDir}\n` +
        'mcp:\n  scopes: [read, stop]\n' +
        'github:\n  tokens:\n    - repo: "acme/private-thing"\n      pat: "${ACME_PRIVATE_PAT}"\n',
    )

    // The operator's shell, which HAS the variable: core boots and creates the admin row that a
    // token is minted against. Nothing later in this test gets to see it.
    const server = await startServer({
      args: ['--config', configPath],
      port,
      env: { ACME_PRIVATE_PAT: 'ghp-not-a-real-token', ROCKYSURF_ADMIN_PASSWORD: 'test-admin-password' },
    })
    expect((await stopServer(server)).code).toBe(0)

    // The MCP client's environment, which does not.
    const stripped = { ...process.env }
    delete stripped['ACME_PRIVATE_PAT']
    delete stripped['ROCKYSURF_TOKEN']
    const run = (args: string[]) =>
      spawnSync(process.execPath, [binPath, ...args, '--config', configPath], {
        encoding: 'utf8',
        env: stripped,
        timeout: 60_000,
      })

    const token = run(['token'])
    expect(token.stderr).not.toContain('ACME_PRIVATE_PAT')
    expect(token.status, token.stderr).toBe(0)
    // stdout is only the token, so `ROCKYSURF_TOKEN=$(rockysurf token)` works.
    expect(token.stdout.trim()).not.toBe('')
    expect(token.stderr).toContain('Token minted')

    // `mcp` gets as far as needing a token of its own, which is proof it read the config: the
    // refusal it prints is the one about ROCKYSURF_TOKEN, not the one about somebody's PAT.
    const mcp = run(['mcp'])
    expect(mcp.status).toBe(1)
    expect(mcp.stderr).toContain('ROCKYSURF_TOKEN is not set')
    expect(mcp.stderr).not.toContain('ACME_PRIVATE_PAT')

    // And boot still refuses the very same file, so nothing was loosened where it matters.
    const boot = spawnSync(process.execPath, [binPath, '--config', configPath], {
      encoding: 'utf8',
      env: stripped,
      timeout: 60_000,
    })
    expect(boot.status).toBe(1)
    expect(boot.stderr).toContain('${ACME_PRIVATE_PAT}')
  }, 120_000)
})

/* ------------------------------------------------------------------ helpers */

/** Owner-only, the mode `ensureDataDir` gives the data directory. Asserted from the outside. */
const DATA_DIR_MODE = 0o700

/** stdin is 'ignore', so the child's stdin really is null — the type says so. */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>

interface RunningServer {
  child: ServerProcess
  stderr: string
  read(): string
}

interface StartOptions {
  /** Everything after the binary. A config path, a port override, or neither. */
  args: string[]
  /** The port the banner is expected to name, and where /health is polled. */
  port: number
  cwd?: string
  env?: Record<string, string>
}

/** Spawn the binary and wait until it reports the URL it is listening on. */
async function startServer(options: StartOptions): Promise<RunningServer> {
  const { args, port, cwd, env } = options
  const child: ServerProcess = spawn(process.execPath, [binPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })

  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  child.stdout.on('data', () => {})

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (stderr.includes(`http://127.0.0.1:${port}`)) {
      // The banner prints after serve() returns, but give the listener a moment to accept.
      await waitForHealth(port, deadline)
      return { child, stderr, read: () => stderr }
    }
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${stderr}`)
    await sleep(100)
  }
  child.kill('SIGKILL')
  throw new Error(`server never reported a URL within 60s:\n${stderr}`)
}

async function waitForHealth(port: number, deadline: number): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
    } catch {
      // not accepting connections yet
    }
    if (Date.now() >= deadline) throw new Error(`/health never answered on ${port}`)
    await sleep(100)
  }
}

async function stopServer(server: RunningServer): Promise<{ code: number | null; stderr: string }> {
  const exited = new Promise<number | null>((resolve) => server.child.once('exit', (code) => resolve(code)))
  server.child.kill('SIGTERM')

  const code = await Promise.race([
    exited,
    sleep(20_000).then(() => {
      server.child.kill('SIGKILL')
      return -1 as const
    }),
  ])
  return { code, stderr: server.read() }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
