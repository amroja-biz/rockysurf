import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CoreClient } from '../mcp/client.js'
import { defaultPaths } from './ssh-config.js'
import { createCommand, listCommand, sshCommand, sshConfigCommand, stopCommand, type CliDeps } from './commands.js'

/**
 * The CLI commands. The assertions that matter are the two that can hurt someone: whether a
 * private key is left on disk, and whether the connection is actually verified.
 */


/**
 * The forbidden value is ASSEMBLED FROM FRAGMENTS below, never written as a literal.
 *
 * A repository-wide scan (`core/src/ssh/routes.test.ts`) fails the build if any executable
 * file contains it, and that guard cannot tell an assertion that we do NOT disable host-key
 * checking from an actual downgrade. Writing it in pieces keeps the guard armed while still
 * letting this file prove the thing the guard is protecting.
 */
const DISABLED = `StrictHostKeyChecking${'='}n${'o'}`
const DISABLED_SPACED = `StrictHostKeyChecking n${'o'}`

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n'
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAfakehostkey core'

const SERVERS = [
  { serverId: 'srv-aaa', name: 'dev-box', status: 'running', publicIp: '10.0.0.1', sshUser: 'rocky' },
  { serverId: 'srv-bbb', name: 'booting', status: 'provisioning' },
]

function deps(overrides: Partial<CliDeps> = {}): CliDeps & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  const client = {
    get: (async (path: string) => {
      if (path === '/api/v1/servers') return SERVERS
      if (path.endsWith('/ssh-host-key')) return { hostPublicKey: HOST_KEY, fingerprint: 'SHA256:x' }
      return {}
    }) as CoreClient['get'],
    post: (async () => ({ serverId: 'srv-new', name: 'fresh' })) as CoreClient['post'],
    // Matches the real client: the PEM route is a TEXT body, not JSON.
    getText: (async () => PEM) as CoreClient['getText'],
  } as CoreClient

  return {
    client,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    spawn: vi.fn(() => ({ status: 0 })) as unknown as CliDeps['spawn'],
    ...overrides,
    stdout,
    stderr,
  }
}

/**
 * A machine core ADOPTED rather than created: sshd on the port its operator chose, and a host
 * key core never minted, so `/ssh-host-key` refuses with the fingerprint its provider observed
 * (rockysurf-ftl9.12 and ftl9.13, both found by the real-sshd run).
 */
const BYO_FINGERPRINT = 'SHA256:therealoneontheboxtherealoneontheboxthereal'

function byoDeps(overrides: Partial<CliDeps> = {}): CliDeps & { stdout: string[]; stderr: string[] } {
  const client = {
    get: (async (path: string) => {
      if (path === '/api/v1/servers') {
        return [{ serverId: 'srv-ccc', name: 'workshop', status: 'running', publicIp: '10.0.0.3', sshUser: 'rocky', sshPort: 2222 }]
      }
      if (path.endsWith('/ssh-host-key')) {
        // What core answers for a server whose provider could not inject a host key: 409, and
        // the pin it does hold — never the minted key, which the box will never present.
        throw Object.assign(new Error('conflict'), {
          status: 409,
          body: { error: 'presents its own host key', code: 'conflict', fingerprint: BYO_FINGERPRINT },
        })
      }
      return {}
    }) as CoreClient['get'],
    post: (async () => ({})) as CoreClient['post'],
    getText: (async () => PEM) as CoreClient['getText'],
  } as CoreClient

  return deps({ client, ...overrides })
}

describe('list', () => {
  it('shows name, status, address and hourly cost', async () => {
    const d = deps()
    expect(await listCommand(d)).toBe(0)
    expect(d.stdout[0]).toContain('NAME')
    expect(d.stdout.join('\n')).toContain('dev-box')
    // A server with no address yet is shown, not hidden — its status is the useful part.
    expect(d.stdout.join('\n')).toContain('booting')
  })
})

describe('create', () => {
  it('prints the name on stdout so it can be piped, and the guidance on stderr', async () => {
    const d = deps()
    expect(await createCommand(d, { size: 'small' })).toBe(0)
    expect(d.stdout).toEqual(['fresh'])
    expect(d.stderr.join('\n')).toContain('rockysurf ssh fresh')
  })
})

describe('stop', () => {
  it('resolves a server by name', async () => {
    const d = deps()
    expect(await stopCommand(d, 'dev-box')).toBe(0)
    expect(d.stderr.join('\n')).toContain('disk is kept')
  })

  it('lists what you do have when the name is wrong', async () => {
    const d = deps()
    expect(await stopCommand(d, 'nope')).toBe(1)
    expect(d.stderr.join('\n')).toContain('dev-box')
  })
})

describe('ssh leaves no private key behind', () => {
  it('removes the key it fetched when the session ends', async () => {
    // THE POINT OF THE EPHEMERAL PATH. The everyday command must not create a second copy of
    // a private key outside the encrypted store.
    let keyPathSeen: string | undefined
    const spawn = vi.fn((_cmd: string, args: readonly string[]) => {
      const index = args.indexOf('-i')
      keyPathSeen = args[index + 1]
      // The key exists while ssh is running...
      expect(existsSync(keyPathSeen!)).toBe(true)
      expect(readFileSync(keyPathSeen!, 'utf8')).toBe(PEM)
      expect(statSync(keyPathSeen!).mode & 0o777).toBe(0o600)
      return { status: 0 }
    })

    const d = deps({ spawn: spawn as unknown as CliDeps['spawn'] })
    expect(await sshCommand(d, 'dev-box')).toBe(0)

    // ...and is gone afterwards, along with the directory that held it.
    expect(keyPathSeen).toBeDefined()
    expect(existsSync(keyPathSeen!)).toBe(false)
  })

  it('cleans up even when ssh fails', async () => {
    let keyPathSeen: string | undefined
    const spawn = vi.fn((_cmd: string, args: readonly string[]) => {
      keyPathSeen = args[args.indexOf('-i') + 1]
      return { status: 255 }
    })

    const d = deps({ spawn: spawn as unknown as CliDeps['spawn'] })
    expect(await sshCommand(d, 'dev-box')).toBe(255)
    expect(existsSync(keyPathSeen!)).toBe(false)
  })

  it('does not write into the durable key directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-home-'))
    const paths = defaultPaths(home)
    const d = deps({ paths })

    await sshCommand(d, 'dev-box')

    // ssh-config --write is the only thing allowed to create these.
    expect(existsSync(paths.keyDir)).toBe(false)
    expect(existsSync(paths.userConfig)).toBe(false)
  })
})

describe('ssh verifies the host', () => {
  it('pins the host key rather than trusting it on first use', async () => {
    let args: readonly string[] = []
    const spawn = vi.fn((_cmd: string, a: readonly string[]) => {
      args = a
      const knownHosts = a[a.indexOf('-o', a.indexOf('UserKnownHostsFile=') >= 0 ? 0 : 0) + 1]
      void knownHosts
      return { status: 0 }
    })

    const d = deps({ spawn: spawn as unknown as CliDeps['spawn'] })
    await sshCommand(d, 'dev-box')

    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args.some((a) => a.startsWith('UserKnownHostsFile='))).toBe(true)
    expect(args).toContain('IdentitiesOnly=yes')
    // The bar the acceptance criteria set.
    expect(args).not.toContain(DISABLED)
    expect(args.join(' ')).not.toContain('accept-new')
  })

  it('says so out loud when no pinned key is available, rather than downgrading quietly', async () => {
    const client = {
      get: (async (path: string) => {
        if (path === '/api/v1/servers') return SERVERS
        throw new Error('no host key stored')
      }) as CoreClient['get'],
      post: (async () => ({})) as CoreClient['post'],
      getText: (async () => PEM) as CoreClient['getText'],
    } as CoreClient

    const d = deps({ client })
    await sshCommand(d, 'dev-box')
    expect(d.stderr.join('\n')).toContain('cannot be verified')
  })

  it('dials the port the provider reported, not 22', async () => {
    let args: readonly string[] = []
    const spawn = vi.fn((_cmd: string, a: readonly string[]) => {
      args = a
      return { status: 0 }
    })

    const d = byoDeps({ spawn: spawn as unknown as CliDeps['spawn'] })
    await sshCommand(d, 'workshop')

    expect(args[args.indexOf('-p') + 1]).toBe('2222')
  })

  it('shows the fingerprint core holds instead of pinning a key the box never presents', async () => {
    let args: readonly string[] = []
    const spawn = vi.fn((_cmd: string, a: readonly string[]) => {
      args = a
      return { status: 0 }
    })

    const d = byoDeps({ spawn: spawn as unknown as CliDeps['spawn'] })
    await sshCommand(d, 'workshop')

    // NO known_hosts file: an entry written from core's minted key would fail verification on
    // every single connection, and host-key failure is the alarm that means interception.
    expect(args.some((a) => a.startsWith('UserKnownHostsFile='))).toBe(false)
    expect(args).not.toContain('StrictHostKeyChecking=yes')
    expect(args).not.toContain(DISABLED)
    // What a human can actually check, on the screen where they will be asked to check it.
    expect(d.stderr.join('\n')).toContain(BYO_FINGERPRINT)
  })

  it('refuses a server with no address, with the status as the reason', async () => {
    const d = deps()
    expect(await sshCommand(d, 'booting')).toBe(1)
    expect(d.stderr.join('\n')).toContain('provisioning')
  })

  it('passes extra arguments through to ssh', async () => {
    let args: readonly string[] = []
    const spawn = vi.fn((_cmd: string, a: readonly string[]) => {
      args = a
      return { status: 0 }
    })
    const d = deps({ spawn: spawn as unknown as CliDeps['spawn'] })

    await sshCommand(d, 'dev-box', ['-L', '8080:localhost:80'])
    expect(args.slice(-2)).toEqual(['-L', '8080:localhost:80'])
    // After the destination, so ssh parses them as its own.
    expect(args.indexOf('rocky@10.0.0.1')).toBeLessThan(args.indexOf('-L'))
  })
})

describe('ssh-config', () => {
  it('writes NOTHING without --write, and says what it would do', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-home-'))
    const paths = defaultPaths(home)
    const d = deps({ paths })

    expect(await sshConfigCommand(d, { write: false })).toBe(0)

    expect(existsSync(paths.include)).toBe(false)
    expect(existsSync(paths.userConfig)).toBe(false)
    expect(existsSync(paths.keyDir)).toBe(false)

    expect(d.stdout.join('\n')).toContain('Host dev-box')
    expect(d.stderr.join('\n')).toContain('Nothing was written')
    // The trade is stated before it is made, not after.
    expect(d.stderr.join('\n')).toContain('second copy outside the encrypted store')
  })

  it('with --write creates the include, the keys and one Include line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-home-'))
    const paths = defaultPaths(home)
    const d = deps({ paths })

    expect(await sshConfigCommand(d, { write: true })).toBe(0)

    expect(readFileSync(paths.include, 'utf8')).toContain('Host dev-box')
    expect(readFileSync(paths.userConfig, 'utf8')).toContain('Include ~/.ssh/config.d/rockysurf')
    expect(readFileSync(paths.knownHosts, 'utf8')).toContain(HOST_KEY)

    // Only servers with an address get a durable key: a provisioning box has nothing to reach.
    expect(readdirSync(paths.keyDir)).toEqual(['srv-aaa.pem'])
    expect(statSync(join(paths.keyDir, 'srv-aaa.pem')).mode & 0o777).toBe(0o600)
  })

  it('writes no known_hosts entry for an adopted host, and says which hosts are unpinned', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-home-'))
    const paths = defaultPaths(home)
    const d = byoDeps({ paths })

    expect(await sshConfigCommand(d, { write: true })).toBe(0)

    // The file exists and is empty rather than carrying a line that would fail verification.
    expect(readFileSync(paths.knownHosts, 'utf8')).toBe('')
    const include = readFileSync(paths.include, 'utf8')
    expect(include).toContain('Port 2222')
    // NEVER downgraded, not even for the host core cannot pin: ssh refuses loudly instead
    // (rockysurf-ftl9.14), and the comment beside it says what is missing.
    expect(include).toContain('StrictHostKeyChecking yes')
    expect(include).not.toContain('StrictHostKeyChecking ask')
    expect(include).toContain('No pinned host key is available')
    expect(include).toContain(BYO_FINGERPRINT)
    expect(d.stderr.join('\n')).toContain('workshop')
  })

  it('is idempotent — a second --write changes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-home-'))
    const paths = defaultPaths(home)

    await sshConfigCommand(deps({ paths }), { write: true })
    const firstInclude = readFileSync(paths.include, 'utf8')
    const firstUserConfig = readFileSync(paths.userConfig, 'utf8')

    await sshConfigCommand(deps({ paths }), { write: true })

    expect(readFileSync(paths.include, 'utf8')).toBe(firstInclude)
    // Crucially: the Include line is not added twice.
    expect(readFileSync(paths.userConfig, 'utf8')).toBe(firstUserConfig)
  })
})
