import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import {
  consumePlanToken,
  mintCallbackTokens,
  PLAN_TOKEN_USE_BUDGET,
  retirePlanToken,
  tokenMatches,
  verifyCallbackToken,
} from '../db/repositories/bootstrap-tokens.js'
import { getServer, insertServer, setInstallPlan, updateServerStatus } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import { createEventsService } from '../services/events.js'
import { resolveInstallPlan } from './resolver.js'
import { renderCallbackUserData, renderPushUserData, UserDataTooLargeError } from './user-data.js'

/**
 * Callback mode: the box-facing routes and the two-token discipline.
 *
 * The security properties are the point of this file, so they are asserted rather than
 * described — a wrong token is refused, a status token cannot buy a plan, an expired or
 * spent-out token is gone, and every use after the first leaves a mark on the row.
 */

const config: Config = configSchema.parse({})
const RUN_ID = 'run-abc'

let opened: OpenedDatabase
let created: CreatedApp
let server: ServerRow
let planToken: string
let callbackToken: string

const json = async (res: Response) => (await res.json()) as any

const post = (path: string, body: unknown) =>
  created.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function seedServer(): ServerRow {
  const user = upsertUserByGithubId(opened.db, { githubId: 'gh:1', githubUsername: 'someone' })
  const row = insertServer(opened.db, {
    userId: user.id,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'small',
    arch: 'arm64',
    idempotencyKey: `k-${Math.random()}`,
    bootstrapMode: 'callback',
  })
  const plan = resolveInstallPlan({
    serverId: row.id,
    runId: RUN_ID,
    mode: 'callback',
    callbackUrl: 'https://core.example/internal/servers/x/status',
    pack: { id: 'p', tools: [], requiresRdp: false },
    tools: [],
  })
  setInstallPlan(opened.db, row.id, plan)
  updateServerStatus(opened.db, row.id, 'provisioning')
  return getServer(opened.db, row.id)!
}

beforeEach(async () => {
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: 'pw-pw-pw-pw' })
  created = createApp({
    db: opened.db,
    config,
    secrets,
    events: createEventsService(),
    loadServerSecrets: async () => ({ GITHUB_TOKEN: 'ghp_secret', RDP_PASSWORD: 'hunter2' }),
  })
  server = seedServer()
  const minted = mintCallbackTokens(opened.db, server.id)
  planToken = minted.planToken
  callbackToken = minted.callbackToken
  server = getServer(opened.db, server.id)!
})

afterEach(() => opened.close())

describe('token storage', () => {
  it('stores hashes, never the tokens', () => {
    const row = getServer(opened.db, server.id)!
    expect(row.planTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.callbackTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(planToken)
    expect(JSON.stringify(row)).not.toContain(callbackToken)
  })

  it('mints two DIFFERENT tokens', () => {
    // Collapsing them is the natural mistake, and it means single-use loses: the plan token
    // ships in user-data and is metadata-readable for the life of the server.
    expect(planToken).not.toBe(callbackToken)
  })

  it('compares in constant time and rejects a wrong or absent secret', () => {
    const row = getServer(opened.db, server.id)!
    expect(tokenMatches(callbackToken, row.callbackTokenHash)).toBe(true)
    expect(tokenMatches(`${callbackToken}x`, row.callbackTokenHash)).toBe(false)
    expect(tokenMatches(callbackToken, null)).toBe(false)
    expect(tokenMatches('', row.callbackTokenHash)).toBe(false)
  })

  it('does not accept the status token where the plan token is required, or vice versa', () => {
    const row = getServer(opened.db, server.id)!
    expect(verifyCallbackToken(row, planToken)).toBe(false)
    expect(consumePlanToken(opened.db, row, callbackToken).ok).toBe(false)
  })
})

describe('plan token budget', () => {
  it('allows the budget and records every use after the first as a leak signal', () => {
    // A budget rather than strict single-use, because single-use and at-least-once delivery
    // do not compose: spend the token, lose the response, and the retry bricks the box.
    for (let i = 1; i <= PLAN_TOKEN_USE_BUDGET; i++) {
      const row = getServer(opened.db, server.id)!
      const outcome = consumePlanToken(opened.db, row, planToken)
      expect(outcome, `use ${i}`).toMatchObject({ ok: true, uses: i, replay: i > 1 })
    }
    const spent = getServer(opened.db, server.id)!
    expect(spent.planTokenUses).toBe(PLAN_TOKEN_USE_BUDGET)
    expect(spent.planTokenReplayedAt).toBeTruthy()
  })

  it('keeps the FIRST replay timestamp rather than smearing it', () => {
    consumePlanToken(opened.db, getServer(opened.db, server.id)!, planToken)
    consumePlanToken(opened.db, getServer(opened.db, server.id)!, planToken, new Date('2026-01-01T00:00:00.000Z'))
    const first = getServer(opened.db, server.id)!.planTokenReplayedAt
    consumePlanToken(opened.db, getServer(opened.db, server.id)!, planToken, new Date('2026-06-01T00:00:00.000Z'))
    expect(getServer(opened.db, server.id)!.planTokenReplayedAt).toBe(first)
  })

  it('refuses once the budget is exhausted, and still records the attempt', () => {
    for (let i = 0; i < PLAN_TOKEN_USE_BUDGET; i++) {
      consumePlanToken(opened.db, getServer(opened.db, server.id)!, planToken)
    }
    const outcome = consumePlanToken(opened.db, getServer(opened.db, server.id)!, planToken)
    expect(outcome).toEqual({ ok: false, reason: 'exhausted' })
    expect(getServer(opened.db, server.id)!.planTokenReplayedAt).toBeTruthy()
  })

  it('refuses an expired token', () => {
    const later = new Date(Date.now() + 60 * 60 * 1000)
    expect(consumePlanToken(opened.db, getServer(opened.db, server.id)!, planToken, later)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('stops working once retired, which is what ends the secrets window', () => {
    retirePlanToken(opened.db, server.id)
    expect(consumePlanToken(opened.db, getServer(opened.db, server.id)!, planToken)).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })
})

describe('POST /internal/servers/:id/status', () => {
  it('needs no session but does need the right token', async () => {
    expect((await post(`/internal/servers/${server.id}/status`, { step: 'installing_tools', token: 'nope' })).status).toBe(401)
    const ok = await post(`/internal/servers/${server.id}/status`, {
      step: 'installing_tools',
      token: callbackToken,
      runId: RUN_ID,
    })
    expect(ok.status).toBe(200)
    expect(getServer(opened.db, server.id)!.provisioningStep).toBe('installing_tools')
  })

  it('will not accept the plan token', async () => {
    const res = await post(`/internal/servers/${server.id}/status`, { step: 'installing_tools', token: planToken })
    expect(res.status).toBe(401)
  })

  it('looks the same for an unknown server as for a bad token', async () => {
    const res = await post('/internal/servers/srv-nope/status', { step: 'ready', token: callbackToken })
    expect(res.status).toBe(401)
  })

  it('accepts a stale run with 202 and does NOT move the row', async () => {
    // Without this a re-push reads the previous run's terminal status and reports success
    // before the agent has started (conformance item 4).
    const before = getServer(opened.db, server.id)!
    const res = await post(`/internal/servers/${server.id}/status`, {
      step: 'ready',
      token: callbackToken,
      runId: 'run-from-a-previous-attempt',
    })

    expect(res.status).toBe(202)
    expect(await json(res)).toMatchObject({ accepted: false, reason: 'stale_run', runId: RUN_ID })
    const after = getServer(opened.db, server.id)!
    expect(after.status).toBe(before.status)
    expect(after.provisioningStep).toBe(before.provisioningStep)
    expect(after.startedAt).toBeNull()
  })

  it('flips the server to running and stamps startedAt when the step is ready', async () => {
    const res = await post(`/internal/servers/${server.id}/status`, {
      step: 'ready',
      token: callbackToken,
      runId: RUN_ID,
    })
    expect(res.status).toBe(200)
    const row = getServer(opened.db, server.id)!
    expect(row.status).toBe('running')
    expect(row.startedAt).toBeTruthy()
  })

  it('retires the plan token the moment bootstrap completes', async () => {
    // The credential that buys secrets must not outlive the boot that needed it.
    await post(`/internal/servers/${server.id}/status`, { step: 'ready', token: callbackToken, runId: RUN_ID })

    expect(getServer(opened.db, server.id)!.planTokenHash).toBeNull()
    expect((await created.app.request(`/internal/servers/${server.id}/secrets?token=${planToken}`)).status).toBe(401)
    expect((await created.app.request(`/internal/servers/${server.id}/plan?token=${planToken}`)).status).toBe(401)
  })

  it('rejects a step the state machine does not know', async () => {
    const res = await post(`/internal/servers/${server.id}/status`, {
      step: 'making_coffee',
      token: callbackToken,
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('invalid provisioning step')
  })

  it('refuses reports once the server is no longer provisioning', async () => {
    await post(`/internal/servers/${server.id}/status`, { step: 'ready', token: callbackToken, runId: RUN_ID })
    const late = await post(`/internal/servers/${server.id}/status`, {
      step: 'installing_tools',
      token: callbackToken,
      runId: RUN_ID,
    })
    expect(late.status).toBe(400)
    expect((await json(late)).error).toContain('not in provisioning state')
  })

  it('records a first address without calling it a change', async () => {
    await post(`/internal/servers/${server.id}/status`, {
      step: 'instance_running',
      token: callbackToken,
      publicIp: '203.0.113.10',
    })
    const row = getServer(opened.db, server.id)!
    expect(row.publicIp).toBe('203.0.113.10')
    // Stamping previousIp on first assignment would fire the "your IP moved" notice on every
    // successful boot.
    expect(row.previousIp).toBeNull()
    expect(row.ipChangedAt).toBeNull()
  })

  it('broadcasts each accepted report to the owner', async () => {
    const events = createEventsService()
    const broadcast = vi.spyOn(events, 'broadcastToUser')
    created = createApp({ db: opened.db, config, secrets: new MemorySecretStore(), events })

    await post(`/internal/servers/${server.id}/status`, {
      step: 'installing_tools',
      token: callbackToken,
      stepId: 'tool:claude-code',
      runId: RUN_ID,
    })

    expect(broadcast).toHaveBeenCalledWith(
      server.userId,
      // Same type push mode emits: the SPA must not have to know which topology sent it.
      expect.objectContaining({ type: 'bootstrap-progress', serverId: server.id, stepId: 'tool:claude-code' }),
    )
  })
})

describe('GET /internal/servers/:id/plan', () => {
  it('serves the snapshotted plan and spends one use', async () => {
    const res = await created.app.request(`/internal/servers/${server.id}/plan?token=${planToken}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ version: 1, serverId: server.id, runId: RUN_ID })
    expect(getServer(opened.db, server.id)!.planTokenUses).toBe(1)
  })

  it('refuses the status token, a wrong token, and an unknown server alike', async () => {
    expect((await created.app.request(`/internal/servers/${server.id}/plan?token=${callbackToken}`)).status).toBe(401)
    expect((await created.app.request(`/internal/servers/${server.id}/plan?token=wrong`)).status).toBe(401)
    expect((await created.app.request(`/internal/servers/srv-nope/plan?token=${planToken}`)).status).toBe(401)
  })

  it('returns 410-style gone once the budget is spent', async () => {
    for (let i = 0; i < PLAN_TOKEN_USE_BUDGET; i++) {
      await created.app.request(`/internal/servers/${server.id}/plan?token=${planToken}`)
    }
    const res = await created.app.request(`/internal/servers/${server.id}/plan?token=${planToken}`)
    // Not a 401: the credential was real and is now gone, and the box must not replay a 4xx.
    expect(res.status).toBe(404)
    expect((await json(res)).error).toContain('budget is exhausted')
  })

  it('requires a token at all', async () => {
    expect((await created.app.request(`/internal/servers/${server.id}/plan`)).status).toBe(400)
  })
})

describe('GET /internal/servers/:id/secrets', () => {
  it('hands over secrets only for the plan token, and stops after retirement', async () => {
    const ok = await created.app.request(`/internal/servers/${server.id}/secrets?token=${planToken}`)
    expect(ok.status).toBe(200)
    expect(await json(ok)).toEqual({ secrets: { GITHUB_TOKEN: 'ghp_secret', RDP_PASSWORD: 'hunter2' } })
    expect(ok.headers.get('cache-control')).toBe('no-store')

    // The status token lives on the box for the whole bootstrap, so it must never buy this.
    expect((await created.app.request(`/internal/servers/${server.id}/secrets?token=${callbackToken}`)).status).toBe(401)

    retirePlanToken(opened.db, server.id)
    expect((await created.app.request(`/internal/servers/${server.id}/secrets?token=${planToken}`)).status).toBe(401)
  })

  it('serves an empty set rather than failing when nothing is wired up', async () => {
    created = createApp({ db: opened.db, config, secrets: new MemorySecretStore() })
    const res = await created.app.request(`/internal/servers/${server.id}/secrets?token=${planToken}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ secrets: {} })
  })
})

describe('callback user-data', () => {
  const spec = {
    planUrl: 'https://core.example/internal/servers/srv-1/plan?token=abc',
    callbackUrl: 'https://core.example/internal/servers/srv-1/status',
    callbackToken: 'status-token',
    agentScript: `#!/usr/bin/env bash\n${'# padding\n'.repeat(1200)}`,
    sshPublicKeys: ['ssh-ed25519 AAAA core'],
  }

  it('compresses the agent with cloud-init native gz+b64', () => {
    const result = renderCallbackUserData(spec, 32768)
    expect(result.compressed).toBe(true)
    expect(result.userData).toContain('encoding: gz+b64')
    // The point of the exercise: the verbatim agent does not fit AWS, the compressed one does.
    expect(result.bytes).toBeLessThan(Buffer.byteLength(spec.agentScript, 'utf8'))
  })

  it('refuses a document over the provider ceiling, at render time', () => {
    // On AWS this would otherwise arrive as a vendor-specific 400 at provision time, on AWS
    // only, invisible to unit tests and to Hetzner's larger limit.
    expect(() => renderCallbackUserData(spec, 512)).toThrow(UserDataTooLargeError)
    try {
      renderCallbackUserData(spec, 512)
    } catch (err) {
      expect((err as UserDataTooLargeError).limit).toBe(512)
      expect((err as Error).message).toContain('Move work out of user-data')
    }
  })

  it('keeps the control-plane token out of the environment install steps see', () => {
    const { userData } = renderCallbackUserData(spec, 32768)
    // callback.env is a separate 0600 file the agent never exports into a step (amendment E9).
    expect(userData).toContain('/var/lib/rockysurf/callback.env')
    expect(userData).toMatch(/callback\.env[\s\S]*?permissions: '0600'/)
    expect(userData).not.toContain('secrets.env')
  })

  it('fetches the plan only when the box has none, so a restart cannot re-spend', () => {
    const { userData } = renderCallbackUserData(spec, 32768)
    expect(userData).toContain('if [ ! -s "$STATE_DIR/plan.json" ]; then')
  })
})

/**
 * The two byte-changes rockysurf-55fx.11 made to the callback document, each asserted by name
 * so a future edit that drops one fails here rather than in production.
 */
describe('callback user-data matches push on security posture (55fx.11)', () => {
  const base = {
    planUrl: 'https://core.example/internal/servers/srv-1/plan?token=abc',
    callbackUrl: 'https://core.example/internal/servers/srv-1/status',
    callbackToken: 'status-token',
    agentScript: '#!/usr/bin/env bash\necho hi\n',
    sshPublicKeys: ['ssh-ed25519 AAAA core'],
  }
  const hostKeys = {
    ed25519Private: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----',
    ed25519Public: 'ssh-ed25519 AAAAHOST rockysurf-host@srv-1',
  }
  const push = { hostname: 'srv-1', sshPublicKeys: base.sshPublicKeys }

  // BYTE-CHANGE 1: `lock_passwd: true` added to the callback users: block.
  it('disables password login, as push already did', () => {
    expect(renderCallbackUserData(base, 32768).userData).toContain('lock_passwd: true')
  })

  it('still lets the remote-desktop flow set a password afterwards', () => {
    // The reason locking is safe: a requiresRdp pack gets a resolver-injected step that pipes
    // the password into chpasswd, which OVERWRITES the shadow field rather than preserving a
    // lock. Nothing in the document itself forecloses that.
    const { userData } = renderCallbackUserData(base, 32768)
    // The document neither sets a password nor runs chpasswd itself — it only declines to
    // leave one enabled. Setting it is the resolver's injected step, later, on the box.
    expect(userData).not.toContain('chpasswd')
    expect(userData).not.toMatch(/^\s*(password|plain_text_passwd|hashed_passwd):/m)
  })

  // BYTE-CHANGE 2: the shared `ssh_keys:` pinning block, emitted when hostKeys are supplied.
  it('pins the host key when one is supplied', () => {
    const { userData } = renderCallbackUserData({ ...base, hostKeys }, 32768)
    expect(userData).toContain('ssh_deletekeys: true')
    expect(userData).toContain('ssh_genkeytypes: [ed25519]')
    expect(userData).toContain('ed25519_private: |')
    expect(userData).toContain(hostKeys.ed25519Public)
  })

  it('omits the pinning block when the provider cannot carry a host key', () => {
    const { userData } = renderCallbackUserData(base, 32768)
    expect(userData).not.toContain('ssh_keys:')
    expect(userData).not.toContain('ssh_deletekeys')
  })

  it('emits a byte-identical pinning block in both modes, so they cannot drift', () => {
    const callback = renderCallbackUserData({ ...base, hostKeys }, 32768).userData
    const pushed = renderPushUserData({ ...push, hostKeys }, 32768).userData

    // From the first line of the block to the end of the ed25519_public line — the block
    // itself, without whatever each document happens to put after it.
    const block = (doc: string) => {
      const start = doc.indexOf('ssh_deletekeys')
      const end = doc.indexOf('\n', doc.indexOf('ed25519_public'))
      return doc.slice(start, end)
    }
    expect(block(callback)).toBe(block(pushed))
  })

  it('still fits the AWS ceiling with a host key added', () => {
    // The pinning block is ~500B; the point of checking is that adding it did not quietly
    // push a realistic callback document over the 16KB limit it was already close to.
    const withKeys = renderCallbackUserData({ ...base, hostKeys }, 16384)
    expect(withKeys.bytes).toBeLessThan(16384)
  })
})
