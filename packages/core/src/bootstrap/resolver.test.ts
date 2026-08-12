import { describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/client.js'
import { getServer, insertServer, setInstallPlan } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import type { ToolRow } from '../db/schema.js'
import { installPlanSchema, parseInstallPlan, serializeInstallPlan } from './plan.js'
import { repoDirName, resolveInstallPlan, type ResolveInstallPlanInput } from './resolver.js'

/**
 * Plan rendering, against `docs/bootstrap-contract.md` § Step ordering and its conformance
 * checklist. The two properties worth more than the rest: the phase order, and determinism —
 * a snapshotted plan that renders differently the second time makes resume skip the wrong
 * work, which is the failure the run id and the journal exist to prevent.
 */

const NOW = '2026-08-12T00:00:00.000Z'

const tool = (over: Partial<ToolRow> & { id: string }): ToolRow => ({
  name: over.id,
  description: 'a tool',
  category: 'base',
  url: 'https://example.com',
  installScript: `install ${over.id}\n`,
  setupScript: null,
  enabled: true,
  installOrder: 10,
  bootstrap: false,
  runAs: 'root',
  sourceFile: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const base = (over: Partial<ResolveInstallPlanInput> = {}): ResolveInstallPlanInput => ({
  serverId: 'srv-abc123',
  runId: 'run-1',
  mode: 'push',
  pack: { id: 'p', tools: ['claude-code'], requiresRdp: false },
  tools: [tool({ id: 'claude-code', installOrder: 40, runAs: 'rocky' })],
  ...over,
})

const ids = (input: ResolveInstallPlanInput) => resolveInstallPlan(input).steps.map((s) => s.id)

describe('phase ordering', () => {
  it('renders the six phases in the documented order with namespaced ids', () => {
    const plan = resolveInstallPlan(
      base({
        pack: { id: 'p', tools: ['node', 'claude-code'], requiresRdp: true, desktop: 'xfce' },
        tools: [
          tool({ id: 'guaranteed', bootstrap: true, installOrder: 0 }),
          tool({ id: 'node', installOrder: 20 }),
          tool({ id: 'claude-code', installOrder: 40, runAs: 'rocky', setupScript: 'setup claude\n' }),
        ],
        repositories: ['https://github.com/example/thing.git'],
      }),
    )

    expect(plan.steps.map((s) => s.id)).toEqual([
      'tool:guaranteed', // 1 runtime-guaranteed, even though the pack never listed it
      'tool:node', // 2 pack tools by installOrder
      'tool:claude-code',
      'repo:thing', // 3 clones
      'tool-setup:claude-code', // 4 setup, after clones so it can read $REPOS
      'branding', // 5
      'rdp', // 6 only because requiresRdp
    ])
  })

  it('breaks installOrder ties on toolId ascending', () => {
    // The rule the pack contract and the bootstrap contract agree on: a determinism guarantee
    // for the renderer, never a dependency mechanism for authors.
    const tools = ['zebra', 'apple', 'mango'].map((id) => tool({ id, installOrder: 30 }))
    expect(ids(base({ pack: { id: 'p', tools: ['zebra', 'apple', 'mango'], requiresRdp: false }, tools }))).toEqual([
      'tool:apple',
      'tool:mango',
      'tool:zebra',
      'branding',
    ])
  })

  it('orders by installOrder before toolId', () => {
    const tools = [tool({ id: 'zzz', installOrder: 10 }), tool({ id: 'aaa', installOrder: 20 })]
    expect(ids(base({ pack: { id: 'p', tools: ['aaa', 'zzz'], requiresRdp: false }, tools }))).toEqual([
      'tool:zzz',
      'tool:aaa',
      'branding',
    ])
  })

  it('skips a disabled tool rather than failing the render', () => {
    const tools = [tool({ id: 'on' }), tool({ id: 'off', enabled: false })]
    expect(ids(base({ pack: { id: 'p', tools: ['on', 'off'], requiresRdp: false }, tools }))).toEqual([
      'tool:on',
      'branding',
    ])
  })

  it('ignores a pack reference to a tool that does not exist', () => {
    expect(ids(base({ pack: { id: 'p', tools: ['claude-code', 'ghost'], requiresRdp: false } }))).toEqual([
      'tool:claude-code',
      'branding',
    ])
  })

  it('omits rdp unless the pack asks for it, and branding when told to', () => {
    expect(ids(base({ branding: false }))).toEqual(['tool:claude-code'])
    expect(ids(base({ pack: { id: 'p', tools: ['claude-code'], requiresRdp: true }, branding: false }))).toEqual([
      'tool:claude-code',
      'rdp',
    ])
  })

  it('renders setup scripts in the same order as their install steps', () => {
    const tools = [
      tool({ id: 'b', installOrder: 20, setupScript: 'setup b\n' }),
      tool({ id: 'a', installOrder: 30, setupScript: 'setup a\n' }),
    ]
    expect(ids(base({ pack: { id: 'p', tools: ['a', 'b'], requiresRdp: false }, tools, branding: false }))).toEqual([
      'tool:b',
      'tool:a',
      'tool-setup:b',
      'tool-setup:a',
    ])
  })
})

describe('step content', () => {
  it('gives setup scripts $REPOS, which is where the contract says it comes from', () => {
    const plan = resolveInstallPlan(
      base({
        tools: [tool({ id: 'claude-code', runAs: 'rocky', setupScript: 'echo "$REPOS"\n' })],
        repositories: ['https://github.com/example/one.git', 'https://github.com/example/two'],
      }),
    )
    const setup = plan.steps.find((s) => s.id === 'tool-setup:claude-code')!
    expect(setup.run).toBe("export REPOS='https://github.com/example/one.git,https://github.com/example/two'\necho \"$REPOS\"\n")
    expect(setup.runAs).toBe('rocky')
  })

  it('clones idempotently, because an interrupted step re-runs from the top', () => {
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    const clone = plan.steps.find((s) => s.id === 'repo:thing')!
    expect(clone.run).toContain('if [ -d "$dir/.git" ]; then')
    // The clone now carries an optional auth array, so match the command rather than a literal.
    expect(clone.run).toMatch(/git .*clone "\$url" "\$dir"/)
    expect(clone.runAs).toBe('rocky')
  })

  it('authenticates a clone with GITHUB_TOKEN when one is present, and anonymously when not', () => {
    // rockysurf-55fx.14: delivering a token nothing consumes would have left private-repo
    // cloning just as broken, only with a credential now sitting on the box.
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    const clone = plan.steps.find((s) => s.id === 'repo:thing')!

    expect(clone.run).toContain('if [ -n "${GITHUB_TOKEN:-}" ]; then')
    expect(clone.run).toContain('credential.helper=')
    // The token is read at run time inside the helper — never an argv value, which `ps` would
    // expose to every unprivileged step this agent runs next.
    expect(clone.run).not.toMatch(/clone .*\$GITHUB_TOKEN/)
    // And never written into the checkout's own config, where it would outlive the box.
    expect(clone.run).not.toMatch(/remote set-url .*GITHUB_TOKEN/)
  })

  it('quotes a repository url that tries to escape the script', () => {
    const nasty = "https://example.com/x'; rm -rf /; echo '.git"
    const plan = resolveInstallPlan(base({ repositories: [nasty] }))
    const clone = plan.steps.find((s) => s.id.startsWith('repo:'))!
    // Single-quoted with embedded quotes escaped: the payload is data, not another command.
    expect(clone.run).toContain(`url='https://example.com/x'\\''; rm -rf /; echo '\\''.git'`)
    expect(clone.run).not.toMatch(/^rm -rf/m)
  })

  it('never puts the rdp password in argv', () => {
    const plan = resolveInstallPlan(base({ pack: { id: 'p', tools: [], requiresRdp: true } }))
    const rdp = plan.steps.find((s) => s.id === 'rdp')!
    // Everything in argv is readable through `ps` by the unprivileged steps this same agent
    // runs, so the password goes to chpasswd on stdin and comes from the environment.
    expect(rdp.run).toContain('| chpasswd')
    expect(rdp.run).toContain('"$RDP_PASSWORD"')
    expect(rdp.run).not.toMatch(/chpasswd\s+\S/)
    expect(rdp.runAs).toBe('root')
  })

  it('marks branding optional — a plain MOTD is not a failed bootstrap', () => {
    expect(resolveInstallPlan(base()).steps.find((s) => s.id === 'branding')?.optional).toBe(true)
  })

  it.each([
    ['https://github.com/a/b.git', 'b'],
    ['https://github.com/a/b', 'b'],
    ['https://github.com/a/b/', 'b'],
    ['git@github.com:a/b.git', 'b'],
  ])('derives the clone directory %s → %s', (url, expected) => {
    expect(repoDirName(url)).toBe(expected)
  })
})

describe('the plan document', () => {
  it('validates against the frozen schema', () => {
    expect(installPlanSchema.safeParse(resolveInstallPlan(base())).success).toBe(true)
  })

  it('renders identically for identical inputs', () => {
    // The conformance requirement: a snapshot that re-renders differently makes resume skip
    // the wrong work.
    const input = base({
      pack: { id: 'p', tools: ['claude-code', 'node'], requiresRdp: true },
      tools: [tool({ id: 'node', installOrder: 20 }), tool({ id: 'claude-code', installOrder: 40, runAs: 'rocky' })],
      repositories: ['https://github.com/example/thing.git'],
    })
    expect(serializeInstallPlan(resolveInstallPlan(input))).toBe(serializeInstallPlan(resolveInstallPlan(input)))
  })

  it('round-trips through serialize and parse', () => {
    const plan = resolveInstallPlan(base())
    expect(parseInstallPlan(serializeInstallPlan(plan))).toEqual(plan)
  })

  it('rejects a version other than 1', () => {
    expect(() => parseInstallPlan({ ...resolveInstallPlan(base()), version: 2 })).toThrow()
  })

  it('rejects duplicate step ids, which are the journal keys', () => {
    const plan = resolveInstallPlan(base())
    const dupe = { ...plan, steps: [...plan.steps, plan.steps[0]!] }
    expect(installPlanSchema.safeParse(dupe).success).toBe(false)
  })

  it('requires a callbackUrl in callback mode and allows its absence in push', () => {
    expect(installPlanSchema.safeParse(resolveInstallPlan(base({ mode: 'callback' }))).success).toBe(false)
    const withUrl = resolveInstallPlan(base({ mode: 'callback', callbackUrl: 'https://core.example/x' }))
    expect(installPlanSchema.safeParse(withUrl).success).toBe(true)
  })

  it('rejects a step id that is not namespaced', () => {
    const plan = resolveInstallPlan(base())
    const bad = { ...plan, steps: [{ ...plan.steps[0]!, id: 'claude-code' }] }
    expect(installPlanSchema.safeParse(bad).success).toBe(false)
  })
})

describe('snapshotting onto the server row', () => {
  it('survives the round trip through the database unchanged', () => {
    const opened = openTestDatabase()
    try {
      const user = upsertUserByGithubId(opened.db, { githubId: 'gh:1', githubUsername: 'someone' })
      const server = insertServer(opened.db, {
        userId: user.id,
        name: 'dev-box',
        provider: 'fake',
        offeringId: 'small',
        arch: 'arm64',
        size: 'small',
        region: 'x',
        idempotencyKey: 'k1',
      })

      const plan = resolveInstallPlan(base({ serverId: server.id }))
      setInstallPlan(opened.db, server.id, plan)

      const stored = getServer(opened.db, server.id)!.installPlan
      expect(parseInstallPlan(stored)).toEqual(plan)

      // The snapshot is what a re-push executes: rendering again from changed pack data must
      // not silently replace it.
      const drifted = resolveInstallPlan(base({ serverId: server.id, branding: false }))
      expect(parseInstallPlan(getServer(opened.db, server.id)!.installPlan)).not.toEqual(drifted)
    } finally {
      opened.close()
    }
  })
})
