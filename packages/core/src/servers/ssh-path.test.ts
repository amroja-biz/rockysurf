import { EventEmitter } from 'node:events'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { ComputeProvider } from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { markBootstrapReady } from '../bootstrap/supervisor.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer, updateServerStatus } from '../db/repositories/servers.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createEventsService, type EventsService } from '../services/events.js'
import {
  assessSshPath,
  classifyRecordedSshFailure,
  probeSshPath,
  type ProbeOutcome,
  type RecordedSshFailure,
} from './ssh-path.js'

/**
 * The SSH-path diagnosis (issue #304).
 *
 * What is being defended here is mostly the SILENCES. It is easy to write a check that tells
 * everyone with a broken SSH session to go and edit their firewall; the value is entirely in
 * the cases where it does not — an authentication failure, a host-key mismatch, a box that is
 * switched off, a cloud with no whitelist to edit. Each of those has a test below, because each
 * of them is a way the feature could become worse than nothing.
 */

/* ------------------------------------------------------------------ the record */

/** The shape `provision-ticker.ts` writes onto a row when a push drive never got in. */
const failedRow = (message: string) =>
  ({ status: 'failed', errorMessage: message, bootstrapMode: 'push', bootstrapReport: null }) as const

describe('what the last SSH failure core wrote down actually means', () => {
  it('reads a connect timeout as a path that never answered', () => {
    expect(
      classifyRecordedSshFailure(
        failedRow(
          'bootstrap failed after 3 attempts: Error: SSH never became ready on 203.0.113.7 after 12 attempts: connect ETIMEDOUT 203.0.113.7:22',
        ),
      ),
    ).toBe<RecordedSshFailure>('no-answer')
  })

  it("reads ssh2's handshake timeout the same way, because that is what a dropped SYN looks like", () => {
    // `readyTimeout` is 10s and the kernel's own connect timeout is minutes, so THIS is the
    // message a filtered path usually leaves behind — not ETIMEDOUT.
    expect(
      classifyRecordedSshFailure(
        failedRow('bootstrap failed after 3 attempts: Error: SSH never became ready on 203.0.113.7 after 12 attempts: Timed out while waiting for handshake'),
      ),
    ).toBe<RecordedSshFailure>('no-answer')
  })

  it('refuses to call an authentication failure a network problem, however the outer sentence reads', () => {
    // THE WHOLE POINT. `waitForSsh` retries auth failures, so a box with the wrong key also dies
    // saying "SSH never became ready" — and telling its owner to widen a firewall rule would be
    // sending them to loosen the one control protecting a box that holds a git token.
    expect(
      classifyRecordedSshFailure(
        failedRow(
          'bootstrap failed after 3 attempts: Error: SSH never became ready on 203.0.113.7 after 12 attempts: All configured authentication methods failed',
        ),
      ),
    ).toBe<RecordedSshFailure>('auth')
  })

  it('reads a host-key mismatch as proof the packets arrived', () => {
    expect(
      classifyRecordedSshFailure(failedRow('host key mismatch: expected SHA256:aaa, host presented SHA256:bbb')),
    ).toBe<RecordedSshFailure>('host-key')
  })

  it('reads a refusal as its own thing, because a whitelist drops and does not refuse', () => {
    expect(
      classifyRecordedSshFailure(failedRow('SSH never became ready on 203.0.113.7: connect ECONNREFUSED 203.0.113.7:22')),
    ).toBe<RecordedSshFailure>('refused')
  })

  it('says nothing about a box that is switched off or gone', () => {
    const message = 'connect ETIMEDOUT 203.0.113.7:22'
    for (const status of ['stopped', 'terminated', 'requested'] as const) {
      expect(
        classifyRecordedSshFailure({ ...failedRow(message), status }),
      ).toBe<RecordedSshFailure>('none')
    }
  })

  it('says nothing when a push drive came back with a report, which is proof SSH worked', () => {
    // Core read that journal off the box over SSH. Whatever the failure was, the path was open.
    expect(
      classifyRecordedSshFailure({
        status: 'failed',
        errorMessage: 'connect ETIMEDOUT 203.0.113.7:22',
        bootstrapMode: 'push',
        bootstrapReport: '{"failure":{"stepId":"tool:beads"}}',
      }),
    ).toBe<RecordedSshFailure>('none')
  })

  it('says nothing about a message it cannot place', () => {
    expect(classifyRecordedSshFailure(failedRow('provisioning did not complete within 30 minutes'))).toBe<RecordedSshFailure>(
      'none',
    )
    expect(classifyRecordedSshFailure({ ...failedRow('x'), errorMessage: null })).toBe<RecordedSshFailure>('none')
  })
})

/* ------------------------------------------------------------------ the probe */

describe('one TCP connection, and what it can honestly conclude', () => {
  let listener: Server
  let port: number

  beforeEach(async () => {
    listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    port = (listener.address() as AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      listener.close(() => resolve())
    })
  })

  it('reports a port that answers as open', async () => {
    // A real socket to a real listener: the probe completes the handshake and drops it, which is
    // the entire question it asks. Nothing is read, nothing is sent.
    const outcome = await probeSshPath({ host: '127.0.0.1', port })
    expect(outcome.result).toBe('open')
    expect(outcome.port).toBe(port)
  })

  it('reports a reset as refused, which is proof the whitelist is not the problem', async () => {
    await new Promise<void>((resolve) => {
      listener.close(() => resolve())
    })
    const outcome = await probeSshPath({ host: '127.0.0.1', port })
    expect(outcome.result).toBe('refused')
  })

  it('reports silence for the whole budget as filtered', async () => {
    // A socket that connects to nothing and never errors — the shape of a dropped SYN, which no
    // loopback address can produce. Everything else in this file is a real connection.
    const stalled = () => {
      const fake = new EventEmitter() as EventEmitter & Partial<Socket>
      fake.setTimeout = ((ms: number) => {
        setTimeout(() => fake.emit('timeout'), ms)
        return fake as Socket
      }) as Socket['setTimeout']
      fake.destroy = (() => fake as Socket) as Socket['destroy']
      return fake as unknown as Socket
    }

    const outcome = await probeSshPath({ host: '203.0.113.7', port: 22, timeoutMs: 20 }, stalled)
    expect(outcome.result).toBe('filtered')
    expect(outcome.detail).toContain('no answer')
  })
})

/* ------------------------------------------------------------------ the verdict */

const probed = (result: ProbeOutcome['result']): ProbeOutcome => ({ result, port: 22, elapsedMs: 1 })

describe('the verdict, and every way it stays quiet', () => {
  it('says nothing when the port answers, however the last bootstrap ended', () => {
    for (const recorded of ['no-answer', 'auth', 'host-key', 'refused', 'none'] as const) {
      expect(assessSshPath({ probe: probed('open'), recorded, whitelistManaged: true }).advisory).toBeNull()
    }
  })

  it('reports a filtered path, and says whether this cloud has a whitelist to point at', () => {
    const managed = assessSshPath({ probe: probed('filtered'), recorded: 'none', whitelistManaged: true })
    expect(managed.advisory).toEqual({ kind: 'filtered', source: 'probe', whitelistManaged: true })

    // Hetzner has no firewall object at all, so the same observation must not become the same
    // advice: there is no `sshAllowedCidr` there that editing would fix.
    const unmanaged = assessSshPath({ probe: probed('filtered'), recorded: 'none', whitelistManaged: false })
    expect(unmanaged.advisory).toEqual({ kind: 'filtered', source: 'probe', whitelistManaged: false })
  })

  it('keeps a refusal separate from a filtered path', () => {
    expect(assessSshPath({ probe: probed('refused'), recorded: 'none', whitelistManaged: true }).advisory?.kind).toBe(
      'refused',
    )
  })

  it('says nothing when the probe itself failed to mean anything', () => {
    expect(assessSshPath({ probe: probed('error'), recorded: 'none', whitelistManaged: true }).advisory).toBeNull()
  })

  it('falls back to the record only when nothing was dialled', () => {
    const fromRecord = assessSshPath({ probe: probed('not-attempted'), recorded: 'no-answer', whitelistManaged: true })
    expect(fromRecord.advisory).toEqual({ kind: 'filtered', source: 'record', whitelistManaged: true })
  })

  it('never advises from an auth or host-key record, which are proof the path is open', () => {
    for (const recorded of ['auth', 'host-key', 'none'] as const) {
      expect(assessSshPath({ probe: probed('not-attempted'), recorded, whitelistManaged: true }).advisory).toBeNull()
    }
  })
})

/* ------------------------------------------------------------------ the route */

const PASSWORD = 'correct-horse-battery-staple'
const config: Config = configSchema.parse({})
const CREATE = { size: 'small' as const, spotInstance: false, packId: 'ai-coding-agents' }

let opened: OpenedDatabase
let app: ReturnType<typeof createApp>['app']
let events: EventsService
let cookie: string

/**
 * The fake provider, told where the box really is.
 *
 * `describe()` is what core folds the address and the sshd port off (ADR-0003, E13), so
 * overriding it here points a real row at a real local socket — which is how these tests dial
 * something without asking the network for permission. `managesSshAccess` is set the same way
 * the real clouds set it, because the route reads THE CAPABILITY and never a provider id.
 */
function fakeReachableAt(target: { host: string; port: number; managesSshAccess: boolean }): ComputeProvider {
  const base = makeFakeProvider()
  return {
    ...base,
    capabilities: { ...base.capabilities, managesSshAccess: target.managesSshAccess },
    describe: async (data) => ({ ...(await base.describe(data)), publicIp: target.host, sshPort: target.port }),
  }
}

async function build(provider: ComputeProvider): Promise<void> {
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  events = createEventsService()
  app = createApp({ db: opened.db, config, secrets, events, providers: new ProviderRegistry([provider]) }).app
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

async function createServerRow(): Promise<string> {
  const res = await app.request('/api/v1/servers', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(CREATE),
  })
  return ((await res.json()) as { serverId: string }).serverId
}

const sshPath = (serverId: string) => app.request(`/api/v1/servers/${serverId}/ssh-path`, { headers: { cookie } })

describe('GET /api/v1/servers/:serverId/ssh-path', () => {
  let listener: Server
  let port: number

  beforeEach(async () => {
    listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    port = (listener.address() as AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      listener.close(() => resolve())
    })
    opened.close()
  })

  it('requires a session, like every other route on a server', async () => {
    await build(fakeReachableAt({ host: '127.0.0.1', port, managesSshAccess: true }))
    const serverId = await createServerRow()
    expect((await app.request(`/api/v1/servers/${serverId}/ssh-path`)).status).toBe(401)
    expect((await sshPath('srv-nope')).status).toBe(404)
  })

  it('dials nothing at all while the box is still building, and says why', async () => {
    await build(fakeReachableAt({ host: '127.0.0.1', port, managesSshAccess: true }))
    const serverId = await createServerRow()

    const body = (await (await sshPath(serverId)).json()) as Record<string, never>
    expect(body['probe']).toMatchObject({ result: 'not-attempted' })
    expect(String(body['probe']!['detail'])).toContain('provisioning')
    expect(body['advisory']).toBeNull()
  })

  it('probes a running box and stays quiet when the port answers', async () => {
    await build(fakeReachableAt({ host: '127.0.0.1', port, managesSshAccess: true }))
    const serverId = await createServerRow()
    await sshPath(serverId) // syncs the address off the provider
    await markBootstrapReady(opened.db, events, getServer(opened.db, serverId)!)

    const body = (await (await sshPath(serverId)).json()) as Record<string, never>
    expect(body['probe']).toMatchObject({ result: 'open', port })
    expect(body['advisory']).toBeNull()
  })

  it('reports a running box whose port refuses as a refusal, not as a whitelist problem', async () => {
    await build(fakeReachableAt({ host: '127.0.0.1', port, managesSshAccess: true }))
    const serverId = await createServerRow()
    await sshPath(serverId)
    await markBootstrapReady(opened.db, events, getServer(opened.db, serverId)!)
    await new Promise<void>((resolve) => {
      listener.close(() => resolve())
    })

    const body = (await (await sshPath(serverId)).json()) as Record<string, never>
    expect(body['probe']).toMatchObject({ result: 'refused' })
    expect(body['advisory']).toMatchObject({ kind: 'refused', source: 'probe' })
  })

  it('tells a failed row whose SSH never answered that the path appears filtered, on a cloud with a whitelist', async () => {
    await build(fakeReachableAt({ host: '127.0.0.1', port, managesSshAccess: true }))
    const serverId = await createServerRow()
    updateServerStatus(opened.db, serverId, 'failed', {
      errorMessage:
        'bootstrap failed after 3 attempts: Error: SSH never became ready on 203.0.113.7 after 12 attempts: Timed out while waiting for handshake',
    })

    const body = (await (await sshPath(serverId)).json()) as Record<string, never>
    expect(body['recorded']).toBe('no-answer')
    expect(body['advisory']).toMatchObject({ kind: 'filtered', source: 'record', whitelistManaged: true })
  })

  it('never claims a whitelist on a cloud that has none, however filtered the path looks', async () => {
    // Hetzner's shape: no firewall object, so `managesSshAccess` is absent. The observation is
    // the same and the advice must not be.
    await build(fakeReachableAt({ host: '127.0.0.1', port, managesSshAccess: false }))
    const serverId = await createServerRow()
    updateServerStatus(opened.db, serverId, 'failed', {
      errorMessage: 'SSH never became ready on 203.0.113.7 after 12 attempts: connect ETIMEDOUT 203.0.113.7:22',
    })

    const body = (await (await sshPath(serverId)).json()) as Record<string, never>
    expect(body['advisory']).toMatchObject({ kind: 'filtered', whitelistManaged: false })
  })

  it('says nothing to a failed row that got as far as authenticating', async () => {
    await build(fakeReachableAt({ host: '127.0.0.1', port, managesSshAccess: true }))
    const serverId = await createServerRow()
    updateServerStatus(opened.db, serverId, 'failed', {
      errorMessage:
        'bootstrap failed after 3 attempts: Error: SSH never became ready on 203.0.113.7 after 12 attempts: All configured authentication methods failed',
    })

    const body = (await (await sshPath(serverId)).json()) as Record<string, never>
    expect(body['recorded']).toBe('auth')
    expect(body['advisory']).toBeNull()
  })
})
