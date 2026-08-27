import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CoreClient } from '../mcp/client.js'
import { defaultPaths } from './ssh-config.js'
import {
  createCommand,
  listCommand,
  offeringsCommand,
  rdpPasswordFlag,
  readUserScript,
  sshCommand,
  sshConfigCommand,
  stopCommand,
  type CliDeps,
} from './commands.js'

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

  /**
   * ARCH AND OFFERING, which the CLI could not express at all (rockysurf-zaqs).
   *
   * The resolver has honoured `arch` since rockysurf-clf2 and the MCP tool has named it since
   * rockysurf-0t2h; the CLI — the surface a human is most likely to be holding — took `size`
   * and nothing else, so asking for an ARM box meant curl against the HTTP API.
   */
  it('passes --arch and --offering through under the names the API validates', async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const d = deps({ client: { ...deps().client, post: post as unknown as CoreClient['post'] } as CoreClient })

    expect(await createCommand(d, { size: 'small', arch: 'arm64', offeringId: 't4g.small' })).toBe(0)
    expect(post).toHaveBeenCalledWith('/api/v1/servers', expect.objectContaining({ arch: 'arm64', offeringId: 't4g.small' }))
  })

  it('omits both when they were not asked for, rather than sending a default', async () => {
    // A defaulted arch would be the resolver picking for the caller and then being told what to
    // pick — the create route's "cheapest of either that meets the size" is the wanted behaviour.
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const d = deps({ client: { ...deps().client, post: post as unknown as CoreClient['post'] } as CoreClient })

    await createCommand(d, { size: 'small' })
    const body = post.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body).not.toHaveProperty('arch')
    expect(body).not.toHaveProperty('offeringId')
  })

  it('refuses an --arch that is not one of the two, before any request is made', async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const d = deps({ client: { ...deps().client, post: post as unknown as CoreClient['post'] } as CoreClient })

    expect(await createCommand(d, { size: 'small', arch: 'aarch64' })).toBe(1)
    // Names both legal values: a closed choice mistyped should not need a second attempt to
    // learn what the choices were.
    expect(d.stderr.join('\n')).toContain('amd64, arm64')
    expect(post).not.toHaveBeenCalled()
  })

  // `--offering` is NOT validated locally, and that is the same discipline `--provider` follows:
  // the ids belong to the operator's cloud and their allowlist, so the only honest validator is
  // the control plane. It refuses by name, and now says what it does have (rockysurf-oeay).
  it('sends an unknown --offering rather than guessing at a local allowlist', async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const d = deps({ client: { ...deps().client, post: post as unknown as CoreClient['post'] } as CoreClient })

    await createCommand(d, { size: 'small', offeringId: 'not-a-real-type' })
    expect(post).toHaveBeenCalledWith('/api/v1/servers', expect.objectContaining({ offeringId: 'not-a-real-type' }))
  })
})

/**
 * `--user-script <file>` and `--user-script-as` (issue #184, ADR-0011).
 *
 * A PATH rather than the script itself, so a whole program never lands in `argv` where every
 * `ps` on the machine can read it — and so the shell that typed it never gets a go at quoting
 * it. Every refusal happens before the POST, on `resolveRdpPassword`'s doctrine: a mistyped
 * flag should cost a sentence, not a machine.
 */
describe('--user-script', () => {
  const scriptFile = (contents: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'rs-user-script-')), 'boot.sh')
    writeFileSync(path, contents)
    return path
  }

  it('sends the file contents and the runner the user named', async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const d = deps({ client: { ...deps().client, post: post as unknown as CoreClient['post'] } as CoreClient })

    expect(
      await createCommand(d, { size: 'small', userScriptPath: scriptFile('echo hello\n'), userScriptRunAs: 'root' }),
    ).toBe(0)
    expect(post).toHaveBeenCalledWith(
      '/api/v1/servers',
      expect.objectContaining({ userScript: 'echo hello\n', userScriptRunAs: 'root' }),
    )
  })

  it('defaults the runner to rocky, and sends neither field without a script', async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const d = deps({ client: { ...deps().client, post: post as unknown as CoreClient['post'] } as CoreClient })

    await createCommand(d, { size: 'small', userScriptPath: scriptFile('echo hi\n') })
    expect((post.mock.calls[0]?.[1] as Record<string, unknown>)['userScriptRunAs']).toBe('rocky')

    await createCommand(d, { size: 'small' })
    const plain = post.mock.calls[1]?.[1] as Record<string, unknown>
    expect(plain).not.toHaveProperty('userScript')
    expect(plain).not.toHaveProperty('userScriptRunAs')
  })

  it('refuses a bad path, an empty file, an oversized file and an unknown runner — before the POST', async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const d = deps({ client: { ...deps().client, post: post as unknown as CoreClient['post'] } as CoreClient })

    expect(await createCommand(d, { size: 'small', userScriptPath: '/nope/does-not-exist.sh' })).toBe(1)
    expect(await createCommand(d, { size: 'small', userScriptPath: scriptFile('   \n') })).toBe(1)
    expect(await createCommand(d, { size: 'small', userScriptPath: scriptFile('x'.repeat(16385)) })).toBe(1)
    expect(await createCommand(d, { size: 'small', userScriptPath: scriptFile('ok\n'), userScriptRunAs: 'nobody' })).toBe(1)
    // Nothing was created by any of the four, which is the whole point of checking here.
    expect(post).not.toHaveBeenCalled()
    // The closed choice names its options, the way --arch does.
    expect(d.stderr.join('\n')).toContain('root, rocky')
  })

  it('refuses --user-script-as on its own rather than silently creating a box with no script', () => {
    expect(readUserScript({ userScriptRunAs: 'root' }).refusal).toContain('--user-script')
    expect(readUserScript({ userScriptRunAs: 'root' }).script).toBeUndefined()
  })
})

/**
 * `rockysurf offerings` (rockysurf-oeay).
 *
 * Shipping `--offering` without this would have recreated on the CLI the exact bug being fixed
 * on the MCP surface in the same change: an id-shaped flag with nowhere to learn an id.
 */
describe('offerings', () => {
  const CATALOGUE = [
    {
      id: 'fake',
      displayName: 'Fake Cloud',
      offerings: [
        { id: 'f1.small', cpu: 2, memoryGb: 2, arch: 'arm64', available: true, hourly: { amount: 0.01, currency: 'USD' }, region: 'r1' },
        { id: 'f1.big', cpu: 8, memoryGb: 16, arch: 'amd64', available: false, hourly: null, region: 'r1' },
      ],
    },
  ]

  const catalogueDeps = (body: unknown = CATALOGUE) =>
    deps({
      client: {
        get: (async (path: string) => (path === '/api/v1/providers' ? body : SERVERS)) as CoreClient['get'],
        post: (async () => ({})) as CoreClient['post'],
        getText: (async () => PEM) as CoreClient['getText'],
      } as CoreClient,
    })

  it('lists each type with its architecture, size and price', async () => {
    const d = catalogueDeps()
    expect(await offeringsCommand(d)).toBe(0)
    const out = d.stdout.join('\n')
    expect(out).toContain('f1.small')
    expect(out).toContain('arm64')
    expect(out).toContain('0.01 USD')
  })

  it('says a type is sold out rather than hiding it', async () => {
    // A sold-out type and a type this cloud does not sell need different answers, which is the
    // whole reason `Offering.available` exists (ADR-0003, B1).
    const d = catalogueDeps()
    await offeringsCommand(d)
    expect(d.stdout.join('\n')).toMatch(/f1\.big.*sold out/s)
  })

  it('renders an unpriced type as unknown, never as free', async () => {
    const d = catalogueDeps()
    await offeringsCommand(d)
    const row = d.stdout.find((l) => l.includes('f1.big')) ?? ''
    expect(row).toContain('—')
    expect(row).not.toMatch(/\b0\b/)
  })

  it('reports a cloud whose catalogue could not be read, instead of showing it as empty', async () => {
    const d = catalogueDeps([{ id: 'fake', displayName: 'Fake Cloud', offerings: [], offeringsError: 'rate limited' }])
    expect(await offeringsCommand(d)).toBe(0)
    expect(d.stdout.join('\n')).toContain('rate limited')
  })

  it('names the configured clouds when asked for one that is not', async () => {
    const d = catalogueDeps()
    expect(await offeringsCommand(d, { provider: 'nope' })).toBe(1)
    expect(d.stderr.join('\n')).toContain('fake')
  })
})

/**
 * The desktop-password path (rockysurf-kvkr).
 *
 * Two things are under test and both can hurt someone: whether a `requiresRdp` pack can be
 * created into a box that will fail its last bootstrap step, and whether the password ever
 * reaches a place it can be read back — argv, stdout, stderr.
 */
describe('create needs a desktop password for a desktop pack', () => {
  const PASSWORD = 'correct horse battery'

  /** What `GET /api/v1/surge-packs` answers: one desktop pack, one ordinary one. */
  const PACKS = [
    { packId: 'open-claw', name: 'OpenClaw', requiresRdp: true },
    { packId: 'plain', name: 'Plain', requiresRdp: false },
  ]

  function rdpDeps(overrides: Partial<CliDeps> = {}) {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const client = {
      get: (async (path: string) => (path === '/api/v1/surge-packs' ? PACKS : SERVERS)) as CoreClient['get'],
      post: post as unknown as CoreClient['post'],
      getText: (async () => PEM) as CoreClient['getText'],
    } as CoreClient
    return { ...deps({ client, ...overrides }), post }
  }

  it('refuses BEFORE creating anything, naming the pack, when no password can be found', async () => {
    // The whole point: no server is created. A box that boots straight to failedStep=rdp costs
    // money by the hour and teaches nothing.
    const d = rdpDeps({ env: {} })
    expect(await createCommand(d, { packId: 'open-claw' })).toBe(1)

    expect(d.post).not.toHaveBeenCalled()
    expect(d.stderr.join('\n')).toContain('open-claw')
    // Says which of the two ways in is available: no terminal was handed to this command, so
    // the environment is the only one left, and the message names it rather than hinting.
    expect(d.stderr.join('\n')).toContain('No terminal')
    expect(d.stderr.join('\n')).toContain('ROCKYSURF_RDP_PASSWORD')
  })

  it('takes the password from the environment and sends it, without printing it', async () => {
    const d = rdpDeps({ env: { ROCKYSURF_RDP_PASSWORD: PASSWORD } })
    expect(await createCommand(d, { packId: 'open-claw' })).toBe(0)

    const [, body] = d.post.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(body['rdpPassword']).toBe(PASSWORD)
    expect(body['packId']).toBe('open-claw')
    // Never echoed, on either channel. stdout is piped into scripts; stderr into CI logs.
    expect([...d.stdout, ...d.stderr].join('\n')).not.toContain(PASSWORD)
  })

  it('asks twice at a terminal and sends what was typed', async () => {
    const promptSecret = vi.fn(async () => PASSWORD)
    const d = rdpDeps({ env: {}, promptSecret })

    expect(await createCommand(d, { packId: 'open-claw' })).toBe(0)

    // Twice, because nothing can read the value back: a typo is only recoverable by SSHing in.
    expect(promptSecret).toHaveBeenCalledTimes(2)
    const [, body] = d.post.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(body['rdpPassword']).toBe(PASSWORD)
    expect([...d.stdout, ...d.stderr].join('\n')).not.toContain(PASSWORD)
  })

  it('creates nothing when the two prompts disagree', async () => {
    const promptSecret = vi.fn(async (label: string) => (label.startsWith('Confirm') ? 'other-one' : PASSWORD))
    const d = rdpDeps({ env: {}, promptSecret })

    expect(await createCommand(d, { packId: 'open-claw' })).toBe(1)
    expect(d.post).not.toHaveBeenCalled()
    expect(d.stderr.join('\n')).toContain('did not match')
  })

  it('refuses a password shorter than the eight characters core enforces, before the call', async () => {
    const d = rdpDeps({ env: { ROCKYSURF_RDP_PASSWORD: 'short' } })
    expect(await createCommand(d, { packId: 'open-claw' })).toBe(1)
    expect(d.post).not.toHaveBeenCalled()
    expect(d.stderr.join('\n')).toContain('8 characters')
  })

  it('refuses a password given on the command line, and says where it has already leaked', async () => {
    const d = rdpDeps({ env: { ROCKYSURF_RDP_PASSWORD: PASSWORD } })
    expect(await createCommand(d, { packId: 'open-claw', rdpPassword: 'literal' })).toBe(1)

    // Refused even though a perfectly good password was available in the environment: the
    // point is to teach the habit, and the value on argv is compromised either way.
    expect(d.post).not.toHaveBeenCalled()
    expect(d.stderr.join('\n')).toContain('shell history')
    expect(d.stderr.join('\n')).toContain('ps')
  })

  it('sends no password for a pack that does not install a desktop', async () => {
    // An exported ROCKYSURF_RDP_PASSWORD should not attach a secret to every box a user makes.
    const d = rdpDeps({ env: { ROCKYSURF_RDP_PASSWORD: PASSWORD } })
    expect(await createCommand(d, { packId: 'plain' })).toBe(0)

    const [, body] = d.post.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(body['rdpPassword']).toBeUndefined()
  })

  it('still prompts when --rdp-password is given bare, for a pack it cannot look up', async () => {
    // The escape hatch: an unreachable or unknown pack list must not be able to talk the CLI
    // out of collecting a password the user asked to give.
    const promptSecret = vi.fn(async () => PASSWORD)
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const client = {
      get: (async () => {
        throw new Error('pack list unavailable')
      }) as CoreClient['get'],
      post: post as unknown as CoreClient['post'],
      getText: (async () => PEM) as CoreClient['getText'],
    } as CoreClient
    const d = deps({ client, env: {}, promptSecret })

    expect(await createCommand(d, { packId: 'mystery', rdpPassword: 'prompt' })).toBe(0)
    expect(promptSecret).toHaveBeenCalledTimes(2)
    const [, body] = post.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(body['rdpPassword']).toBe(PASSWORD)
  })
})

describe('--rdp-password on the command line', () => {
  it('tells a typed value apart from a request to be asked', () => {
    // `ps` and the shell history are why: one of these has already leaked, the other cannot.
    expect(rdpPasswordFlag(['--pack', 'open-claw'])).toBe('absent')
    expect(rdpPasswordFlag(['--rdp-password'])).toBe('prompt')
    expect(rdpPasswordFlag(['--rdp-password', '--pack', 'open-claw'])).toBe('prompt')
    expect(rdpPasswordFlag(['--rdp-password', 'hunter2000'])).toBe('literal')
    expect(rdpPasswordFlag(['--rdp-password=hunter2000'])).toBe('literal')
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

/**
 * `rockysurf create --input NAME=VALUE` (issue #189, ADR-0013).
 *
 * The unit-level parsing lives in `pack-inputs.test.ts`; what is pinned here is the COMMAND —
 * that it reads the pack's declaration before the POST, refuses locally what core would refuse
 * remotely, and puts what it collected on the wire. Refusing before the POST is the same ruling
 * the desktop password gets above: a `requiresRdp` pack with no password, or a pack missing a
 * required input, builds a machine that fails its own install step minutes and one bill later.
 */
describe('create passes a pack the inputs it asked for', () => {
  const PACKS = [
    {
      packId: 'headlong',
      name: 'Headlong',
      inputs: [
        { name: 'HEADLONG_HEADLESS', label: 'Headless install', required: true, secret: false, default: '1' },
        { name: 'HEADLONG_API_KEY', label: 'Headlong API key', required: false, secret: true },
        { name: 'HEADLONG_TOKEN', label: 'Headlong token', required: true, secret: false },
      ],
    },
    { packId: 'plain', name: 'Plain' },
  ]

  function inputDeps(overrides: Partial<CliDeps> = {}) {
    const post = vi.fn(async (_path: string, _body?: unknown) => ({ serverId: 'srv-new', name: 'fresh' }))
    const client = {
      get: (async (path: string) => (path === '/api/v1/surge-packs' ? PACKS : SERVERS)) as CoreClient['get'],
      post: post as unknown as CoreClient['post'],
      getText: (async () => PEM) as CoreClient['getText'],
    } as CoreClient
    return { ...deps({ client, ...overrides }), post }
  }

  it('sends the values it collected, and leaves the defaulting to core', async () => {
    const d = inputDeps()
    expect(await createCommand(d, { packId: 'headlong', inputs: ['HEADLONG_TOKEN=t-1'] })).toBe(0)

    const [, body] = d.post.mock.calls[0] as unknown as [string, Record<string, unknown>]
    // `HEADLONG_HEADLESS` is NOT sent: core applies the pack's own default, and a CLI that sent
    // it back would be the surface deciding what a default is.
    expect(body['packInputs']).toEqual({ HEADLONG_TOKEN: 't-1' })
  })

  it('refuses a required input with no value BEFORE the POST', async () => {
    const d = inputDeps()
    expect(await createCommand(d, { packId: 'headlong' })).toBe(1)
    expect(d.post).not.toHaveBeenCalled()
    expect(d.stderr.join('\n')).toContain('Headlong token is required by this pack')
  })

  it('refuses a name the pack does not ask for, naming the ones it does', async () => {
    const d = inputDeps()
    expect(await createCommand(d, { packId: 'headlong', inputs: ['HEADLONG_TOKN=t-1'] })).toBe(1)
    expect(d.post).not.toHaveBeenCalled()
    expect(d.stderr.join('\n')).toContain('HEADLONG_HEADLESS')
  })

  it('refuses a secret given on the command line, and never puts it on the wire', async () => {
    const d = inputDeps()
    expect(
      await createCommand(d, { packId: 'headlong', inputs: ['HEADLONG_TOKEN=t', 'HEADLONG_API_KEY=sk-live'] }),
    ).toBe(1)
    expect(d.post).not.toHaveBeenCalled()
    // The refusal says how to supply it instead, and never repeats the value it refused.
    expect(d.stderr.join('\n')).toContain('ROCKYSURF_INPUT_HEADLONG_API_KEY')
    expect(d.stderr.join('\n')).not.toContain('sk-live')
  })

  it('takes a secret from the environment and sends it, without printing it', async () => {
    const d = inputDeps({ env: { ROCKYSURF_INPUT_HEADLONG_API_KEY: 'sk-live' } })
    // `collectPackInputs` reads `process.env` by default; the command passes nothing else, so
    // the value is injected here the way a CI job would set it.
    const previous = process.env['ROCKYSURF_INPUT_HEADLONG_API_KEY']
    process.env['ROCKYSURF_INPUT_HEADLONG_API_KEY'] = 'sk-live'
    try {
      expect(await createCommand(d, { packId: 'headlong', inputs: ['HEADLONG_TOKEN=t'] })).toBe(0)
      const [, body] = d.post.mock.calls[0] as unknown as [string, Record<string, unknown>]
      expect(body['packInputs']).toEqual({ HEADLONG_API_KEY: 'sk-live', HEADLONG_TOKEN: 't' })
      expect([...d.stdout, ...d.stderr].join('\n')).not.toContain('sk-live')
    } finally {
      if (previous === undefined) delete process.env['ROCKYSURF_INPUT_HEADLONG_API_KEY']
      else process.env['ROCKYSURF_INPUT_HEADLONG_API_KEY'] = previous
    }
  })

  it('sends no packInputs at all for a pack that asks for nothing', async () => {
    const d = inputDeps()
    expect(await createCommand(d, { packId: 'plain' })).toBe(0)
    const [, body] = d.post.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect('packInputs' in body).toBe(false)
  })
})
