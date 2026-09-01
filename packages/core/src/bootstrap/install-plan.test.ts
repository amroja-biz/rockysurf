import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type Db, type OpenedDatabase } from '../db/client.js'
import { upsertPack, upsertTool } from '../db/repositories/packs.js'
import { getServer, insertServer } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import type { ServerRow } from '../db/schema.js'
import { snapshotInstallPlan } from './install-plan.js'
import { parseInstallPlan } from './plan.js'

/**
 * Snapshotting the plan onto the row at create time (rockysurf-55fx.13).
 *
 * `resolveInstallPlan` and `setInstallPlan` both shipped with 55fx.4 and neither was ever
 * called outside tests, so every server the production stack created carried
 * `installPlan: null`. That broke BOTH topologies at once: the push runner refuses a row with
 * no plan, and callback's `/internal/servers/:id/plan` answers the box with a 404. The bug was
 * invisible to unit tests precisely because every unit test called `setInstallPlan` itself.
 */

let opened: OpenedDatabase
let db: Db
let userId: string

const server = (over: Partial<Parameters<typeof insertServer>[1]> = {}): ServerRow =>
  insertServer(db, {
    userId,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
    ...over,
  })

beforeEach(() => {
  opened = openTestDatabase()
  db = opened.db
  userId = upsertUserByGithubId(db, { githubId: '1', githubUsername: 'octocat' }).id

  const tool = (over: Partial<Parameters<typeof upsertTool>[1]>) =>
    upsertTool(db, {
      id: 'x',
      name: 'X',
      description: 'a tool',
      category: 'dev',
      url: 'https://example.com',
      installScript: 'true',
      enabled: true,
      installOrder: 10,
      bootstrap: false,
      runAs: 'rocky',
      ...over,
    })

  tool({ id: 'apt-basics', installScript: 'apt-get install -y curl', runAs: 'root', installOrder: 0, bootstrap: true })
  tool({ id: 'claude-code', installScript: 'npm i -g @anthropic-ai/claude-code' })
  upsertPack(db, {
    id: 'ai-coding-agents',
    name: 'AI coding agents',
    tools: ['claude-code'],
    displayOrder: 0,
    enabled: true,
    requiresRepos: false,
    requiresRdp: false,
  })
})

afterEach(() => {
  opened.close()
})

describe('what lands on the row', () => {
  it('writes a parseable plan carrying the pack\'s tools', () => {
    const row = server({ packId: 'ai-coding-agents' })
    snapshotInstallPlan(db, row, { mode: 'push' })

    const plan = parseInstallPlan(getServer(db, row.id)!.installPlan!)
    expect(plan.serverId).toBe(row.id)
    expect(plan.steps.map((s) => s.id)).toContain('tool:claude-code')
    // Base tools come whether or not the pack lists them.
    expect(plan.steps.map((s) => s.id)).toContain('tool:apt-basics')
  })

  it('always ends on a step that reports `ready`', () => {
    // That report is what promotes the row to `running` now that sync no longer does. A plan
    // with no such step would leave a healthy box provisioning until the timeout killed it.
    const row = server({ packId: 'ai-coding-agents' })
    const plan = snapshotInstallPlan(db, row, { mode: 'push' })
    expect(plan.steps.at(-1)?.reports).toBe('ready')
  })

  it('still produces a usable plan for a server whose pack is missing', () => {
    // An operator deleting a pack must not turn into "this server can never finish".
    const plan = snapshotInstallPlan(db, server({ packId: 'deleted-pack' }), { mode: 'push' })
    expect(plan.steps.map((s) => s.id)).toContain('tool:apt-basics')
    expect(plan.steps.at(-1)?.reports).toBe('ready')
  })

  it('honours an explicit per-server tool selection over the pack\'s list', () => {
    const row = server({ packId: 'ai-coding-agents', tools: [] })
    const plan = snapshotInstallPlan(db, row, { mode: 'push' })
    expect(plan.steps.map((s) => s.id)).toContain('tool:claude-code')
  })

  it('carries the repositories the user asked for', () => {
    const row = server({ packId: 'ai-coding-agents', repositories: ['https://github.com/octocat/hello.git'] })
    const plan = snapshotInstallPlan(db, row, { mode: 'push' })
    expect(plan.steps.map((s) => s.id)).toContain('repo:hello')
  })
})

describe("the shell-environment step's names (issue #244)", () => {
  it('takes the plain halves off the row and the secret halves from the caller — names only', () => {
    const row = server({
      packId: 'ai-coding-agents',
      packInputs: { HEADLONG_MODEL: 'large' },
      environment: { MY_ENDPOINT: 'https://api.example.com' },
    })
    const plan = snapshotInstallPlan(db, row, {
      mode: 'push',
      secretEnvironmentNames: { packInputs: ['HEADLONG_API_KEY'], environment: ['MY_TOKEN'] },
    })
    const step = plan.steps.find((s) => s.id === 'shell-environment')!
    expect(step.run).toContain("names=('HEADLONG_MODEL' 'HEADLONG_API_KEY' 'MY_ENDPOINT' 'MY_TOKEN' 'GITHUB_TOKEN')")
    // The plan is loggable: the value the row carries in the clear is still not in it.
    expect(step.run).not.toContain('https://api.example.com')
    expect(step.run).not.toContain('large')
  })

  it('renders the step with only GITHUB_TOKEN for a server that supplied nothing', () => {
    const plan = snapshotInstallPlan(db, server({ packId: 'ai-coding-agents' }), { mode: 'push' })
    expect(plan.steps.find((s) => s.id === 'shell-environment')?.run).toContain("names=('GITHUB_TOKEN')")
  })
})

describe('the supplied-key removal step (ADR-0008, issue #92)', () => {
  const USER_KEY = 'ssh-ed25519 AAAAuser me@laptop'
  const MANAGED_KEY = 'ssh-ed25519 AAAAmanaged rockysurf'

  it('renders when the row carries a supplied key and the caller passes the managed one', () => {
    const row = server({ packId: 'ai-coding-agents', userSuppliedPublicKey: USER_KEY })
    const plan = snapshotInstallPlan(db, row, { mode: 'push', managedPublicKey: MANAGED_KEY })
    expect(plan.steps.map((s) => s.id)).toContain('supplied-key-only')
    expect(plan.steps.at(-1)?.id).toBe('supplied-key-only')
    expect(plan.steps.at(-1)?.reports).toBe('ready')
  })

  it('is absent from a plain server, and absent when the caller omits managedPublicKey', () => {
    const plain = server({ packId: 'ai-coding-agents' })
    expect(snapshotInstallPlan(db, plain, { mode: 'push', managedPublicKey: MANAGED_KEY }).steps.map((s) => s.id)).not.toContain(
      'supplied-key-only',
    )

    // The caller not threading `managedPublicKey` through (a test, or a code path that snapshots
    // before keys exist) must not render a step whose script would embed `undefined`.
    const supplied = server({ packId: 'ai-coding-agents', userSuppliedPublicKey: USER_KEY })
    expect(snapshotInstallPlan(db, supplied, { mode: 'push' }).steps.map((s) => s.id)).not.toContain('supplied-key-only')
  })
})

describe('topology', () => {
  it('gives a callback plan the URL the box posts to, built from core\'s public URL', () => {
    const row = server({ packId: 'ai-coding-agents' })
    const plan = snapshotInstallPlan(db, row, { mode: 'callback', publicUrl: 'https://core.example/' })
    expect(plan.callbackUrl).toBe(`https://core.example/internal/servers/${row.id}/status`)
  })

  it('gives a push plan no URL at all', () => {
    // A push-mode box is never told a core URL and never handed a credential; a callbackUrl in
    // its plan would be the first half of exactly that.
    const row = server({ packId: 'ai-coding-agents' })
    const plan = snapshotInstallPlan(db, row, { mode: 'push', publicUrl: 'https://core.example' })
    expect(plan.callbackUrl).toBeUndefined()
    expect(plan.mode).toBe('push')
  })
})

/**
 * "Install this tool on every box", and the three ways a plan can be asked for (issue #295).
 *
 * The union lives in `resolvePack`, AFTER its three-way branch, and these are the three
 * branches. A union written inside any one of them would be a rule with two holes in it, and
 * the holes would be silent ones: the operator ticks "install on every box", creates a server
 * the other way round, and simply does not get it.
 */
describe('alwaysInstall (issue #295)', () => {
  const stepIds = (row: ServerRow): string[] =>
    parseInstallPlan(getServer(db, row.id)!.installPlan!).steps.map((s) => s.id)

  const everywhere = () =>
    upsertTool(db, {
      id: 'house-style',
      name: 'House style',
      description: 'every box gets this',
      category: 'dev',
      url: 'https://example.com',
      installScript: 'true',
      enabled: true,
      installOrder: 50,
      bootstrap: false,
      runAs: 'rocky',
      alwaysInstall: true,
    })

  it('reaches a plan built from a pack', () => {
    everywhere()
    const row = server({ packId: 'ai-coding-agents' })
    snapshotInstallPlan(db, row, { mode: 'push', branding: false })
    expect(stepIds(row)).toContain('tool:house-style')
    expect(stepIds(row)).toContain('tool:claude-code')
  })

  it('reaches a plan built from an explicit per-server tool selection', () => {
    everywhere()
    // The selection WINS over the pack's list — the pack is a default, not a floor — so this is
    // the branch where a union written beside `pack.tools` would silently do nothing.
    const row = server({ packId: 'ai-coding-agents', tools: ['claude-code'] })
    snapshotInstallPlan(db, row, { mode: 'push', branding: false })
    expect(stepIds(row)).toContain('tool:house-style')
  })

  it('reaches a plan built with no pack at all', () => {
    everywhere()
    const row = server({})
    snapshotInstallPlan(db, row, { mode: 'push', branding: false })
    expect(stepIds(row)).toContain('tool:house-style')
  })

  it('installs once when the pack already lists it', () => {
    upsertTool(db, {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'the agent',
      category: 'dev',
      url: 'https://example.com',
      installScript: 'npm i -g @anthropic-ai/claude-code',
      enabled: true,
      installOrder: 10,
      bootstrap: false,
      runAs: 'rocky',
      alwaysInstall: true,
    })
    const row = server({ packId: 'ai-coding-agents' })
    snapshotInstallPlan(db, row, { mode: 'push', branding: false })
    expect(stepIds(row).filter((id) => id === 'tool:claude-code')).toHaveLength(1)
  })

  it('does not install a disabled tool, even marked always-install', () => {
    upsertTool(db, {
      id: 'retired',
      name: 'Retired',
      description: 'switched off',
      category: 'dev',
      url: 'https://example.com',
      installScript: 'true',
      enabled: false,
      installOrder: 50,
      bootstrap: false,
      runAs: 'rocky',
      alwaysInstall: true,
    })
    const row = server({ packId: 'ai-coding-agents' })
    snapshotInstallPlan(db, row, { mode: 'push', branding: false })
    expect(stepIds(row)).not.toContain('tool:retired')
  })

  /**
   * THE SNAPSHOT IS THE PROMISE. The disclosure the UI shows says "every box you create from
   * now on", and this is the half of that sentence the code has to keep: a server that already
   * exists carries the plan it was created with, and flipping the flag afterwards does not
   * reach back and change it.
   */
  it('does not change a plan that was already snapshotted', () => {
    const row = server({ packId: 'ai-coding-agents' })
    snapshotInstallPlan(db, row, { mode: 'push', branding: false })
    const before = getServer(db, row.id)!.installPlan

    everywhere()

    expect(getServer(db, row.id)!.installPlan).toBe(before)
    expect(stepIds(row)).not.toContain('tool:house-style')
  })
})
