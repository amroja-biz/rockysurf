import { boot, DataDirLockError, issueSession, makeFakeProvider, ProviderRegistry } from '@rockysurf/core'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRockysurfCli } from '../cli.js'
import { MCP_TOKEN_ENV } from '../mcp/server.js'

/**
 * `rockysurf mcp` and `rockysurf token` run against a LIVE control plane (rockysurf-o2t5).
 *
 * That is not an edge case, it is the only case: an MCP client and a token are useful exactly
 * when core is running. Both commands used to call `boot({ listen: false })` to reach one
 * value, which ran the startup recovery pass — a second core waking up on a live data
 * directory and passing judgement on the first one's in-flight servers. The clip agent watched
 * a provisioning fleet get settled as `terminated` by a command whose job was to print a token.
 *
 * The first test here was the CONTROL: it proved the hazard was still real by booting a second
 * core over the live data directory and asserting it wrecked both rows. rockysurf-utjq then
 * closed the hazard structurally — `boot()` takes an advisory lock on the data directory and a
 * second core refuses to start at all — so the control now asserts the refusal: a second
 * `boot()` throws `DataDirLockError` before it has opened the database, and every seeded row is
 * exactly as the live core left it. The command tests that follow still matter on their own
 * terms: `mcp` and `token` must not merely be SAVED from booting a second core, they must not
 * try — `token` has to work against a live directory the lock would refuse them, and `mcp`
 * must not even create the directory.
 *
 * The two seeded rows are two of the three ways this hurt someone:
 *
 *  - `watch-fake` provisions on a provider the second process CAN build but whose in-memory
 *    instance map it does not share, so `describe()` reports absence and the row is settled
 *    `terminated` — the observed failure, and the orphan the reconciler exists to prevent;
 *  - `watch-aws` provisions on a provider the second process CANNOT build at all (the same
 *    shape as a credential that is unreadable from this process, or an API that is down), so
 *    `registry.get()` throws and a healthy row is marked `failed` with "recovery failed: …".
 */

const dirs: string[] = []
const opened: { close(): Promise<void> }[] = []

afterEach(async () => {
  for (const core of opened.splice(0)) await core.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  delete process.env[MCP_TOKEN_ENV]
})

interface LiveCore {
  configPath: string
  dataDir: string
  booted: Awaited<ReturnType<typeof boot>>
  /** The seeded rows, both left mid-flight in `provisioning`. */
  rows: { fake: string; aws: string }
  status(id: string): { status: string; errorMessage: string | null } | undefined
  recoveryEvents(): string[]
}

/**
 * A running control plane with two servers mid-provision, on a scratch data directory.
 *
 * `listen: false` only because a test does not need a socket — this core is otherwise the real
 * thing: real routes, real lifecycle, real rows. Two providers are registered so that one row
 * can name a provider a second process would fail to build.
 */
async function liveCore(): Promise<LiveCore> {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-o2t5-'))
  dirs.push(dir)
  const configPath = join(dir, 'rockysurf.config.yaml')
  const dataDir = join(dir, 'data')
  writeFileSync(configPath, `server:\n  dataDir: ${dataDir}\nmcp:\n  scopes: [read, create]\n`)

  const booted = await boot({
    argv: ['--config', configPath],
    listen: false,
    announce: () => {},
    log: () => {},
    providers: () => new ProviderRegistry([makeFakeProvider(), makeFakeProvider({ id: 'aws' })]),
  })
  opened.push(booted)

  const [admin] = booted.db.sqlite
    .prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1')
    .all() as { id: string }[]
  const { token } = issueSession(booted.db.db, admin!.id)

  const create = async (name: string, provider: string): Promise<string> => {
    const response = await booted.app.request('/api/v1/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, size: 'small', provider }),
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { serverId: string }
    return body.serverId
  }

  const rows = { fake: await create('watch-fake', 'fake'), aws: await create('watch-aws', 'aws') }

  const core: LiveCore = {
    configPath,
    dataDir,
    booted,
    rows,
    status(id) {
      const [row] = booted.db.sqlite
        .prepare('SELECT status, error_message AS errorMessage FROM servers WHERE id = ?')
        .all(id) as { status: string; errorMessage: string | null }[]
      return row
    },
    recoveryEvents() {
      return (
        booted.db.sqlite.prepare(`SELECT type FROM events WHERE type LIKE 'recovery.%'`).all() as {
          type: string
        }[]
      ).map((e) => e.type)
    },
  }

  // The premise of every test below: both rows really are mid-flight. The fake provider does
  // not promote a row on its own — a provider reporting a booted VM is not a bootstrap.
  expect(core.status(rows.fake)?.status).toBe('provisioning')
  expect(core.status(rows.aws)?.status).toBe('provisioning')
  return core
}

/** Run a CLI command with stdout and stderr captured rather than printed. */
async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  try {
    const code = await runRockysurfCli(argv)
    return { code, stdout: stdout.join(''), stderr: stderr.join('') }
  } finally {
    vi.restoreAllMocks()
  }
}

describe('a CLI command must not wake a second core on a live data directory', () => {
  it('CONTROL: a second boot() over the same data directory refuses instead of settling the fleet', async () => {
    const core = await liveCore()

    // Exactly what the two commands used to do, and what a supervisor restarting core before
    // the old process exits still does. Before rockysurf-utjq this call succeeded and settled
    // both rows — `fake` terminated, `aws` failed with "recovery failed: …".
    const refusal = await boot({
      argv: ['--config', core.configPath],
      listen: false,
      announce: () => {},
      log: () => {},
    }).then(
      () => undefined,
      (err: unknown) => err,
    )

    // Refused as the second core, with a message naming the holder and the directory — the
    // operator-facing contract, since the CLI prints this verbatim.
    expect(refusal).toBeInstanceOf(DataDirLockError)
    const message = (refusal as DataDirLockError).message
    expect(message).toContain(`pid ${process.pid}`)
    expect(message).toContain(core.dataDir)

    // And the refusal came before the damage, not after: both rows are exactly as the live
    // core left them, and no second recovery pass ran (the startup recovery pass belongs to
    // the process holding the lock, and only ever ran there).
    expect(core.status(core.rows.fake)?.status).toBe('provisioning')
    expect(core.status(core.rows.aws)?.status).toBe('provisioning')
    expect(core.status(core.rows.aws)?.errorMessage).toBeNull()
    expect(core.recoveryEvents()).toEqual([])
  }, 30_000)

  it('rockysurf token leaves every in-flight row exactly as it found it', async () => {
    const core = await liveCore()

    const { code, stdout } = await run(['token', '--config', core.configPath])

    expect(code).toBe(0)
    // It still did its job: stdout is the token and nothing else, so `$(rockysurf token)` works.
    expect(stdout.trim()).toMatch(/^[0-9a-f]{64}$/)

    expect(core.status(core.rows.fake)?.status).toBe('provisioning')
    expect(core.status(core.rows.aws)?.status).toBe('provisioning')
    expect(core.status(core.rows.aws)?.errorMessage).toBeNull()
    // No recovery pass ran at all — not one that happened to decide correctly.
    expect(core.recoveryEvents()).toEqual([])

    // The token is a real session in the live core's database, usable against the API it names.
    const hash = createHash('sha256').update(stdout.trim()).digest('hex')
    const [session] = core.booted.db.sqlite
      .prepare('SELECT user_id AS userId FROM sessions WHERE token_hash = ?')
      .all(hash) as { userId: string }[]
    expect(session).toBeDefined()
  }, 30_000)

  it('rockysurf mcp reads the config file and never opens the data directory', async () => {
    const core = await liveCore()

    // No token, so `runMcpServer` refuses before it connects a stdio transport. Everything the
    // bug lived in — resolving the config, reaching the data directory — happens first, so
    // this exercises the whole dangerous half of the command without hanging the suite.
    const { code, stderr } = await run(['mcp', '--config', core.configPath])

    expect(code).toBe(1)
    expect(stderr).toContain(MCP_TOKEN_ENV)

    expect(core.status(core.rows.fake)?.status).toBe('provisioning')
    expect(core.status(core.rows.aws)?.status).toBe('provisioning')
    expect(core.recoveryEvents()).toEqual([])
  }, 30_000)

  it('rockysurf mcp creates nothing when the data directory does not exist yet', async () => {
    // The sharper form of "never opens the data directory": pointed at a config whose dataDir
    // has never existed, the command must leave the filesystem alone. Booting created the
    // directory, the master key and the database as a side effect of reading one config value.
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-o2t5-cold-'))
    dirs.push(dir)
    const configPath = join(dir, 'rockysurf.config.yaml')
    const dataDir = join(dir, 'never-created')
    writeFileSync(configPath, `server:\n  dataDir: ${dataDir}\n`)

    const { code } = await run(['mcp', '--config', configPath])

    expect(code).toBe(1)
    expect(existsSync(dataDir)).toBe(false)
  })
})

describe('the same commands with core stopped', () => {
  it('rockysurf token still mints against a data directory nobody is serving', async () => {
    const core = await liveCore()
    const { configPath } = core
    // Stop core the way an operator would, then mint. This is the cold path the old code was
    // written for, and it has to keep working.
    await core.booted.close()
    opened.length = 0

    const { code, stdout, stderr } = await run(['token', '--config', configPath])

    expect(code).toBe(0)
    expect(stdout.trim()).toMatch(/^[0-9a-f]{64}$/)
    expect(stderr).toContain('Token minted')
  }, 30_000)

  it('rockysurf token says what to do when core has never run here', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-o2t5-empty-'))
    dirs.push(dir)
    const configPath = join(dir, 'rockysurf.config.yaml')
    const dataDir = join(dir, 'never-created')
    writeFileSync(configPath, `server:\n  dataDir: ${dataDir}\n`)

    const { code, stderr } = await run(['token', '--config', configPath])

    expect(code).toBe(1)
    expect(stderr).toContain('start Rocky Surf once first')
    // And it did not leave an empty database behind for the next boot to find.
    expect(existsSync(dataDir)).toBe(false)
  })
})
