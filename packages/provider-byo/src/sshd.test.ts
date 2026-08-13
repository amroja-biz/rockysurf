import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { ProvisionSpec } from '@rockysurf/provider-sdk'
import { Client, Server, utils, type ParsedKey } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { byoConfigSchema } from './config.js'
import { asByoData, makeByoProvider } from './provider.js'
import { fingerprintFromBlob, fingerprintFromPublicKeyLine, publicKeyLineFromBlob } from './ssh.js'

/**
 * The BYO provider against a REAL SSH server.
 *
 * `provider.test.ts` fakes the connector, which is the right seam for behaviour but proves
 * nothing about the handshake — and the handshake is where this provider's only security-relevant
 * decision lives. So these tests stand up an in-process `ssh2` server with a real host key and
 * real public-key authentication, and drive the real client at it.
 *
 * What that buys, in order of importance:
 *
 *  1. the recorded fingerprint is the one the host actually presents, computed the same way
 *     `ssh-keygen -lf` computes it and the same way core's `fingerprintFromBlob` does;
 *  2. a mismatched pin is refused DURING the handshake, so the server never sees an
 *     authentication attempt — core's key does not reach the wrong machine;
 *  3. the keys the provider installs really do authorize a later connection made the way core's
 *     push path makes one: same client library, same strict host-key verification, same private
 *     key. That is the end-to-end claim in `docs/providers/capability-matrix.md` — that BYO is a
 *     subset of the push path both clouds already use — checked rather than asserted.
 */

interface TestKey {
  privatePem: string
  /** authorized_keys line: "<algo> <base64> <comment>". */
  publicLine: string
  parsed: ParsedKey
}

/** RSA, because Node exports it in a PEM `ssh2` parses directly. The algorithm is irrelevant here. */
function testKey(comment: string): TestKey {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw parsed
  return {
    privatePem: privateKey,
    publicLine: `${parsed.type} ${parsed.getPublicSSH().toString('base64')} ${comment}`,
    parsed,
  }
}

interface FakeSshd {
  port: number
  /** `SHA256:…` this server presents, as a client would compute it. */
  fingerprint: string
  /** The same key as a `known_hosts` line. */
  publicKey: string
  /** Public-key blobs the server will authenticate. Mutable: the box "honours" install scripts. */
  authorized: Buffer[]
  /** Every command it was asked to run. */
  execs: string[]
  /** TCP connections accepted, and authentication attempts seen. */
  connections: number
  authAttempts: number
  close(): Promise<void>
}

/**
 * An sshd that answers the two things this provider asks of a box: run a script, and prove who it
 * is. Commands are answered from a table rather than a shell — the shell is not what is under
 * test, and executing operator-supplied scripts inside a unit test would be its own hazard.
 */
async function startSshd(options: { hostKey?: TestKey; authorized?: Buffer[] } = {}): Promise<FakeSshd> {
  const host = options.hostKey ?? testKey('host@test')
  const state: Pick<FakeSshd, 'authorized' | 'execs' | 'connections' | 'authAttempts'> = {
    authorized: options.authorized ?? [],
    execs: [],
    connections: 0,
    authAttempts: 0,
  }

  const server = new Server({ hostKeys: [host.privatePem] }, (client) => {
    state.connections++
    client
      .on('authentication', (ctx) => {
        if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
        state.authAttempts++
        const offered = ctx.key.data
        if (!state.authorized.some((key) => key.equals(offered))) return ctx.reject()
        // A signature means this is the real attempt rather than the "would you accept this key"
        // probe; verifying it keeps the test honest about what authorized the session.
        if (ctx.signature && ctx.blob) {
          const parsed = utils.parseKey(`${ctx.key.algo} ${offered.toString('base64')}`)
          if (parsed instanceof Error || !parsed.verify(ctx.blob, ctx.signature, ctx.key.algo)) return ctx.reject()
        }
        ctx.accept()
      })
      .on('ready', () => {
        client.on('session', (acceptSession) => {
          acceptSession()
            .on('exec', (acceptExec, _reject, info) => {
              state.execs.push(info.command)
              const stream = acceptExec()
              stream.write(respond(info.command, state))
              stream.exit(0)
              stream.end()
            })
        })
      })
      .on('error', () => {
        // A refused handshake surfaces here. The client's assertion is the one that matters.
      })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

  return {
    port,
    fingerprint: fingerprintFromBlob(host.parsed.getPublicSSH()),
    /** The server's real host key as a known_hosts line — ground truth for E14. */
    publicKey: publicKeyLineFromBlob(host.parsed.getPublicSSH()),
    get authorized() {
      return state.authorized
    },
    get execs() {
      return state.execs
    },
    get connections() {
      return state.connections
    },
    get authAttempts() {
      return state.authAttempts
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * Stand in for the box actually running the script.
 *
 * The prepare script's whole purpose is to put keys into `authorized_keys`, so the simulation
 * that matters is exactly that: pull the keys back out of the script the provider sent, and start
 * authenticating them. If the provider ever stopped putting core's key in there, the push-path
 * test below would fail to log in — which is the failure it exists to catch.
 */
function respond(command: string, state: { authorized: Buffer[]; execs: string[] }): string {
  const match = /printf %s '([A-Za-z0-9+/=]+)'/.exec(command)
  const script = match?.[1] ? Buffer.from(match[1], 'base64').toString('utf8') : ''
  if (script.includes('nproc')) return '4\n8192000\nx86_64\n52428800\n'

  for (const [, line] of script.matchAll(/^add_key '(.+)'$/gm)) {
    const blob = line!.replaceAll(`'\\''`, "'").split(/\s+/)[1]
    if (blob) state.authorized.push(Buffer.from(blob, 'base64'))
  }
  return 'prepared\n'
}

const open: FakeSshd[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()))
})

async function sshd(options: Parameters<typeof startSshd>[0] = {}): Promise<FakeSshd> {
  const server = await startSshd(options)
  open.push(server)
  return server
}

function identityFileFor(key: TestKey): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-byo-'))
  const path = join(dir, 'id_rsa')
  writeFileSync(path, key.privatePem, { mode: 0o600 })
  return path
}

function spec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return {
    serverId: 'srv-abc123',
    name: 'dev-box',
    offeringId: 'workshop',
    arch: 'amd64',
    sshPublicKeys: [],
    userData: '',
    tags: { 'managed-by': 'rockysurf', 'server-id': 'srv-abc123' },
    idempotencyKey: 'gen1-abc',
    ...overrides,
  }
}

function byoFor(server: FakeSshd, admin: TestKey, fingerprint?: string) {
  return makeByoProvider({
    ...byoConfigSchema.parse({
      hosts: [
        {
          name: 'workshop',
          host: '127.0.0.1',
          port: server.port,
          user: 'root',
          identityFile: identityFileFor(admin),
          ...(fingerprint ? { fingerprint } : {}),
        },
      ],
    }),
    agentSocket: '',
  })
}

describe('against a real SSH server', () => {
  it('records the fingerprint the host actually presents (TOFU)', async () => {
    const admin = testKey('operator@laptop')
    const server = await sshd({ authorized: [admin.parsed.getPublicSSH()] })
    const core = testKey('rockysurf-core@srv-abc123')

    const result = await byoFor(server, admin).provision(spec({ sshPublicKeys: [core.publicLine] }))

    expect(asByoData(result.data).hostKeyFingerprint).toBe(server.fingerprint)
    expect(result.initial.hostKeyFingerprint).toBe(server.fingerprint)
    expect(server.execs).toHaveLength(1)

    // AND the key itself, captured from the same handshake (rockysurf-ftl9.14). This is the
    // assertion the fake fleet cannot make: the bytes here came off a real ssh2 handshake with a
    // real host key, and they are the ones a `known_hosts` file needs.
    expect(result.initial.hostPublicKey).toBe(server.publicKey)
    expect(asByoData(result.data).hostPublicKey).toBe(server.publicKey)
    expect(fingerprintFromPublicKeyLine(server.publicKey)).toBe(server.fingerprint)
  })

  it('accepts a matching fingerprint from config on the first connection', async () => {
    const admin = testKey('operator@laptop')
    const server = await sshd({ authorized: [admin.parsed.getPublicSSH()] })
    const core = testKey('rockysurf-core@srv-abc123')

    const result = await byoFor(server, admin, server.fingerprint).provision(
      spec({ sshPublicKeys: [core.publicLine] }),
    )
    expect(asByoData(result.data).hostKeyFingerprint).toBe(server.fingerprint)
  })

  it('refuses a mismatched pin during the handshake, so no credential ever reaches the host', async () => {
    const admin = testKey('operator@laptop')
    const server = await sshd({ authorized: [admin.parsed.getPublicSSH()] })
    const wrong = `SHA256:${'A'.repeat(43)}`

    await expect(byoFor(server, admin, wrong).provision(spec({ sshPublicKeys: ['ssh-rsa AAAA x'] }))).rejects.toMatchObject(
      { code: 'auth', providerCode: 'host_key_mismatch' },
    )

    // The connection was made and then dropped mid-handshake: the box saw a socket, never a key.
    expect(server.authAttempts).toBe(0)
    expect(server.execs).toEqual([])
  })

  it("installs core's key so core's own push connection can log in and verify strictly", async () => {
    const admin = testKey('operator@laptop')
    const server = await sshd({ authorized: [admin.parsed.getPublicSSH()] })
    const core = testKey('rockysurf-core@srv-abc123')

    const claimed = await byoFor(server, admin).provision(spec({ sshPublicKeys: [core.publicLine] }))
    const handle = asByoData(claimed.data)

    // Now connect the way `core/src/bootstrap/push.ts` does: same client, core's minted private
    // key, and a hostVerifier pinned to the fingerprint the provider reported — which is the
    // value core stores on the server row and hands its push target.
    const banner = await pushStyleConnect({
      port: handle.port,
      user: handle.sshUser,
      privateKey: core.privatePem,
      pin: handle.hostKeyFingerprint,
    })
    expect(banner).toContain('prepared')
    expect(server.authAttempts).toBeGreaterThan(1)
  })

  it("refuses core's style of connection when the pin does not match the host", async () => {
    const admin = testKey('operator@laptop')
    const server = await sshd({ authorized: [admin.parsed.getPublicSSH()] })
    const core = testKey('rockysurf-core@srv-abc123')
    const claimed = await byoFor(server, admin).provision(spec({ sshPublicKeys: [core.publicLine] }))

    await expect(
      pushStyleConnect({
        port: asByoData(claimed.data).port,
        user: 'rocky',
        privateKey: core.privatePem,
        pin: `SHA256:${'B'.repeat(43)}`,
      }),
    ).rejects.toThrow()
  })

  it('terminate opens no socket at all', async () => {
    const admin = testKey('operator@laptop')
    const server = await sshd({ authorized: [admin.parsed.getPublicSSH()] })
    const core = testKey('rockysurf-core@srv-abc123')

    const byo = byoFor(server, admin)
    const claimed = await byo.provision(spec({ sshPublicKeys: [core.publicLine] }))
    const connectionsAfterClaim = server.connections

    await byo.terminate(claimed.data)

    expect(server.connections).toBe(connectionsAfterClaim)
    expect(server.execs).toHaveLength(1)
    expect(await byo.listManaged()).toEqual([])
  })
})

/** One connection made exactly the way core's push bootstrap makes it. */
function pushStyleConnect(options: { port: number; user: string; privateKey: string; pin: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let mismatch: Error | undefined

    client
      .on('ready', () => {
        client.exec('echo prepared', (err, stream) => {
          if (err) return reject(err)
          let out = ''
          stream.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
          stream.on('close', () => {
            client.end()
            resolve(out)
          })
        })
      })
      .on('error', (err) => {
        client.end()
        reject(mismatch ?? err)
      })
      .connect({
        host: '127.0.0.1',
        port: options.port,
        username: options.user,
        privateKey: options.privateKey,
        readyTimeout: 10_000,
        hostVerifier: (key: Buffer) => {
          if (fingerprintFromBlob(key) === options.pin) return true
          mismatch = new Error('host key mismatch')
          return false
        },
      })
  })
}
