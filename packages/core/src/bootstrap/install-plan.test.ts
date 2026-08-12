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
