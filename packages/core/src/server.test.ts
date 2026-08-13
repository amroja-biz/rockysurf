import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_PASSWORD_ENV, ADMIN_PASSWORD_HASH_KEY } from './auth/admin.js'
import { DataDirLockError, dataDirLockPath } from './boot/data-dir-lock.js'
import { secretKeyPath } from './secrets/index.js'
import { boot, type BootedApp, type BootOptions } from './server.js'

/**
 * The boot path against a real temporary config and a real on-disk database — the one place
 * config loading, migrations, the secrets fallback and admin bootstrap are exercised together.
 * `listen: false` keeps it off a socket.
 */

let dir: string
let booted: BootedApp | undefined
let announced: string[]
let savedPassword: string | undefined

function writeConfig(body = ''): void {
  writeFileSync(join(dir, 'rockysurf.config.yaml'), `server:\n  dataDir: "${join(dir, 'data')}"\n${body}`)
}

const bootHere = () =>
  boot({ argv: [], cwd: dir, env: {}, listen: false, announce: (m) => announced.push(m) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-boot-'))
  announced = []
  // The generated-password path only runs when the operator has NOT set one.
  savedPassword = process.env[ADMIN_PASSWORD_ENV]
  delete process.env[ADMIN_PASSWORD_ENV]
  writeConfig()
})

afterEach(async () => {
  await booted?.close()
  booted = undefined
  if (savedPassword === undefined) delete process.env[ADMIN_PASSWORD_ENV]
  else process.env[ADMIN_PASSWORD_ENV] = savedPassword
  rmSync(dir, { recursive: true, force: true })
})

describe('boot', () => {
  it('loads config, migrates, and serves health', async () => {
    booted = await bootHere()

    expect(booted.config.server.dataDir).toBe(join(dir, 'data'))
    expect(existsSync(join(dir, 'data', 'rockysurf.db'))).toBe(true)

    const res = await booted.app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('generates and announces an admin password exactly once, on first boot only', async () => {
    booted = await bootHere()
    expect(announced).toHaveLength(1)

    const banner = announced[0]!
    expect(banner).toContain('first boot')
    expect(banner).toContain(ADMIN_PASSWORD_ENV)

    // The generated password logs in, which is the only proof that what was printed is what
    // was hashed.
    const password = banner.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z2-9]{20}$/.test(l))
    expect(password).toBeDefined()

    const res = await booted.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    expect(res.status).toBe(200)

    // Restart against the same data directory: the hash persisted, so nothing is announced.
    await booted.close()
    announced = []
    booted = await bootHere()
    expect(announced).toEqual([])
  })

  it('honours ROCKYSURF_ADMIN_PASSWORD instead of generating one', async () => {
    process.env[ADMIN_PASSWORD_ENV] = 'set-by-the-operator'
    booted = await bootHere()

    expect(announced).toEqual([])

    const ok = await booted.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'set-by-the-operator' }),
    })
    expect(ok.status).toBe(200)
  })

  it('opens the encrypted secrets store and mints its master key on first boot', async () => {
    booted = await bootHere()

    expect(existsSync(secretKeyPath(join(dir, 'data')))).toBe(true)

    // A round trip proves the key that was minted is the key the store is using.
    booted.secretsStore.putProviderToken('hetzner', 'hz_secret_value')
    expect(booted.secretsStore.getProviderToken('hetzner')).toBe('hz_secret_value')

    // And the same key still opens it after a restart.
    await booted.close()
    booted = await bootHere()
    expect(booted.secretsStore.getProviderToken('hetzner')).toBe('hz_secret_value')
  })

  it('keeps the admin password hash out of the encrypted store, where no kind fits it', async () => {
    booted = await bootHere()
    // It is one-way: there is no plaintext to protect, so it lives in `settings`.
    expect(booted.secretsStore.listSecretRefs()).toEqual([])
    expect(await booted.secrets.get(ADMIN_PASSWORD_HASH_KEY)).toMatch(/^scrypt\$/)
  })

  it('runs migrations on an existing database without complaint', async () => {
    booted = await bootHere()
    await booted.close()
    booted = await bootHere()
    expect((await booted.app.request('/health')).status).toBe(200)
  })

  it('takes the port from config, and lets a caller override it', async () => {
    writeConfig('  port: 4567\n')
    booted = await bootHere()
    expect(booted.port).toBe(4567)
    await booted.close()

    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, port: 9876, announce: () => {} })
    expect(booted.port).toBe(9876)
  })

  /**
   * WHICH FILE THIS PROCESS IS RUNNING ON, and who else is told (rockysurf-8wgm).
   *
   * The settings editor writes the config file, so it has to be handed the one `boot()` really
   * loaded — not a second, independent guess at which that was. Asserted through the route,
   * because the wiring is the claim: `boot()` resolving correctly and then passing the wrong
   * path to `createApp` would leave the page editing a file nobody reads.
   *
   * The `configPath` OPTION is rockysurf-nb6e: two call sites passed it, `LoadConfigOptions` had
   * no such field, and TypeScript did not object because excess-property checking does not see
   * through a spread. It was dropped, resolution fell back to `process.argv`, and the bug was
   * invisible for the binary — whose `process.argv` is the same arguments — while in-process it
   * meant a caller that named a scratch file could be reading the operator's real one. So this
   * passes `argv: []`: if the option were still ignored, there would be nothing left to find it
   * by, and the assertion below would fail rather than quietly pass through the process's own
   * command line.
   */
  describe('the config file boot loaded', () => {
    it('honours a programmatic configPath, over the file in cwd', async () => {
      const named = join(dir, 'named.yaml')
      writeFileSync(named, `server:\n  dataDir: "${join(dir, 'data')}"\n  port: 4711\n`)
      // The cwd file, which must lose — and would be found if `configPath` were ignored.
      writeConfig('  port: 4222\n')

      process.env[ADMIN_PASSWORD_ENV] = 'test-admin-password'
      booted = await boot({
        configPath: named,
        argv: [],
        cwd: dir,
        env: {},
        listen: false,
        announce: () => {},
      })
      expect(booted.config.server.port).toBe(4711)

      // ...and the settings editor was pointed at that same file.
      const login = await booted.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-admin-password' }),
      })
      expect(login.status).toBe(200)
      const { token } = (await login.json()) as { token: string }

      const settings = await booted.app.request('/api/v1/settings', {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(settings.status).toBe(200)
      expect(await settings.json()).toMatchObject({ file: { path: named, exists: true } })
    })
  })

  /**
   * THE BIND, asserted against the real socket (rockysurf-pii7).
   *
   * `config.server.host` reaching `serve()` is the entire fix, and a test that only checks the
   * parsed config would still pass if the wiring were deleted — `serve()` would go back to
   * binding every interface and nothing would say so. So these boot with a listener on an
   * ephemeral port and read the address off the server node actually opened.
   */
  describe('the listener binds what the config says', () => {
    const bootListening = async (options: Partial<BootOptions> = {}): Promise<AddressInfo> => {
      booted = await boot({ argv: [], cwd: dir, env: {}, port: 0, announce: () => {}, ...options })
      const server = booted.server!
      const address =
        server.address() ??
        (await new Promise((resolve) => server.once('listening', () => resolve(server.address()))))
      return address as AddressInfo
    }

    it('binds loopback by default — the whole point of the setting', async () => {
      const address = await bootListening()

      expect(booted!.host).toBe('127.0.0.1')
      expect(address.address).toBe('127.0.0.1')

      // And it is a real, serving socket, not just a bound one.
      const res = await fetch(`http://127.0.0.1:${address.port}/health`)
      expect(res.status).toBe(200)
    })

    it('binds every interface when the config asks for it — the container case', async () => {
      // What `docker/rockysurf.config.yaml` seeds, because a container's loopback is its own.
      writeConfig('  host: 0.0.0.0\n')
      const address = await bootListening()

      expect(booted!.host).toBe('0.0.0.0')
      expect(address.address).toBe('0.0.0.0')
    })

    it('lets a caller override the configured host', async () => {
      writeConfig('  host: 0.0.0.0\n')
      const address = await bootListening({ host: '127.0.0.1' })

      expect(address.address).toBe('127.0.0.1')
    })
  })

  it('close() is safe to call twice', async () => {
    booted = await bootHere()
    await booted.close()
    await expect(booted.close()).resolves.toBeUndefined()
  })

  /**
   * ONE CORE PER DATA DIRECTORY (rockysurf-utjq), proved through the real boot path rather
   * than against the lock module — module tests cannot see a missing composition (55fx.13).
   * WAL-mode SQLite happily lets two processes write, so the only thing standing between a
   * supervisor restart (or a second `npx rockysurf`) and two control planes settling each
   * other's rows is `boot()` actually taking this lock.
   */
  describe('one core per data directory', () => {
    const dataDir = () => join(dir, 'data')

    it('a second boot() refuses while the first is live, naming the holder and the directory', async () => {
      booted = await bootHere()

      const refusal = await bootHere().then(
        () => undefined,
        (err: unknown) => err,
      )

      expect(refusal).toBeInstanceOf(DataDirLockError)
      const message = (refusal as DataDirLockError).message
      expect(message).toContain(`pid ${process.pid}`)
      expect(message).toContain(dataDir())
      expect(message).toContain(dataDirLockPath(dataDir()))

      // The refusal was advisory-lock-shaped, not damage-shaped: the first core is still
      // serving off the same database.
      const res = await booted.app.request('/health')
      expect(res.status).toBe(200)
    })

    it('clean shutdown releases the lock, so sequential boots over one directory keep working', async () => {
      booted = await bootHere()
      expect(existsSync(dataDirLockPath(dataDir()))).toBe(true)

      await booted.close()
      expect(existsSync(dataDirLockPath(dataDir()))).toBe(false)

      // The pattern half the test suites in this package rely on: boot, close, boot again.
      booted = await bootHere()
      const res = await booted.app.request('/health')
      expect(res.status).toBe(200)
    })

    it('a lock left by a SIGKILLed core is reclaimed — a crash never bricks the next start', async () => {
      // A pid that certainly existed and certainly does not any more: spawnSync waits for the
      // child to exit before returning. This is the on-disk state a SIGKILL leaves behind —
      // SQLite recovers its WAL by design, and the lock must not be the less crash-safe part.
      const child = spawnSync(process.execPath, ['-e', ''])
      expect(child.status).toBe(0)
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(
        dataDirLockPath(dataDir()),
        `${JSON.stringify({ pid: child.pid, hostname: 'gone', startedAt: new Date().toISOString() })}\n`,
      )

      booted = await bootHere()

      const record = JSON.parse(readFileSync(dataDirLockPath(dataDir()), 'utf8')) as { pid: number }
      expect(record.pid).toBe(process.pid)
    })

    it('a boot that fails half-way releases the lock for the retry', async () => {
      await expect(
        boot({
          argv: [],
          cwd: dir,
          env: {},
          listen: false,
          announce: () => {},
          providers: () => {
            throw new Error('composition failed')
          },
        }),
      ).rejects.toThrow('composition failed')

      expect(existsSync(dataDirLockPath(dataDir()))).toBe(false)
      booted = await bootHere()
    })
  })

  it('serves a working SSE stream end to end from the booted app', async () => {
    booted = await bootHere()

    const banner = announced[0]!
    const password = banner.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z2-9]{20}$/.test(l))
    const login = await booted.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const { token, user } = (await login.json()) as { token: string; user: { id: string } }

    const res = await booted.app.request('/api/v1/events', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = decoder.decode((await reader.read()).value, { stream: true })

    // The events service the boot path built is the one the route is wired to.
    await booted.events.broadcastToUser(user.id, { type: 'booted' })
    for (let i = 0; i < 20 && !seen.includes('booted'); i++) {
      seen += decoder.decode((await reader.read()).value, { stream: true })
    }
    expect(seen).toContain('booted')

    await reader.cancel()
  })
})
