import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIREWALL_NAME,
  DEFAULT_IMAGE,
  digitaloceanConfigSchema,
  resolveSshCidrs,
  type ConfigIssue,
} from './config.js'
import { decodeTag, encodeTag, encodeTags } from './tags.js'

const base = { token: 'do-token', region: 'nyc3', sshAllowedCidr: '203.0.113.7/32' }

const issuesOf = (input: unknown): ConfigIssue[] => {
  try {
    digitaloceanConfigSchema.parse(input)
    return []
  } catch (err) {
    return (err as { issues?: ConfigIssue[] }).issues ?? [{ path: [], message: (err as Error).message }]
  }
}

describe('the config schema', () => {
  it('fills the defaults an operator should not have to type', () => {
    expect(digitaloceanConfigSchema.parse(base)).toEqual({
      token: 'do-token',
      region: 'nyc3',
      image: DEFAULT_IMAGE,
      sshAllowedCidr: ['203.0.113.7/32'],
      allowAllCidr: false,
      firewallName: DEFAULT_FIREWALL_NAME,
      managedBy: 'rockysurf',
    })
  })

  it('accepts its own output, because core re-parses on every reload', () => {
    const once = digitaloceanConfigSchema.parse(base)
    expect(digitaloceanConfigSchema.parse(once)).toEqual(once)
  })

  it('is strict, so a typo is a message naming the key rather than a silent default', () => {
    const [issue] = issuesOf({ ...base, regoin: 'nyc3' })
    expect(issue?.message).toContain('regoin')
    expect(issue?.message).toContain('remove it')
  })

  it('requires a region with no default, because a guess creates machines nobody chose', () => {
    const [issue] = issuesOf({ token: 't', sshAllowedCidr: '203.0.113.7/32' })
    expect(issue?.message).toContain('region is required')
  })

  it('requires a token and says where it comes from', () => {
    const [issue] = issuesOf({ region: 'nyc3', sshAllowedCidr: '203.0.113.7/32' })
    expect(issue?.message).toContain('DIGITALOCEAN_TOKEN')
  })

  it('reports every problem at once rather than only the first', () => {
    expect(issuesOf({}).length).toBeGreaterThan(1)
  })
})

describe('sshAllowedCidr — the two-act guard (ADR-0021)', () => {
  it('reads a bare string as a list of one, so an older file keeps loading', () => {
    expect(digitaloceanConfigSchema.parse(base).sshAllowedCidr).toEqual(['203.0.113.7/32'])
  })

  it('is required, and the refusal is an instruction', () => {
    const [issue] = issuesOf({ token: 't', region: 'nyc3' })
    expect(issue?.message).toContain('state which network may reach SSH')
    expect(issue?.message).toContain('allowAllCidr: true')
  })

  it('refuses an empty list, which is a lockout dressed as a setting', () => {
    const [issue] = issuesOf({ ...base, sshAllowedCidr: [] })
    expect(issue?.message).toContain('at least one network')
  })

  it('refuses something that is not a CIDR', () => {
    const [issue] = issuesOf({ ...base, sshAllowedCidr: '203.0.113.7' })
    expect(issue?.message).toContain('IPv4 CIDR')
  })

  it('folds exact duplicates and keeps overlapping ranges as written', () => {
    const parsed = digitaloceanConfigSchema.parse({
      ...base,
      sshAllowedCidr: [' 203.0.113.7/32 ', '203.0.113.7/32', '203.0.113.0/24'],
    })
    // The wide one is "the office" and the narrow one is "my laptop at the office"; collapsing
    // them would make a later removal take away the entry the operator did not click.
    expect(parsed.sshAllowedCidr).toEqual(['203.0.113.7/32', '203.0.113.0/24'])
  })

  it('needs two keys for 0.0.0.0/0, even buried in a list of careful ranges', () => {
    const [issue] = issuesOf({ ...base, sshAllowedCidr: ['203.0.113.7/32', '0.0.0.0/0'] })
    expect(issue?.message).toContain('two decisions, not one')
    expect(issuesOf({ ...base, sshAllowedCidr: ['0.0.0.0/0'], allowAllCidr: true })).toEqual([])
  })

  it('resolves to the whole internet only when it was asked for twice, in writing', () => {
    expect(resolveSshCidrs(digitaloceanConfigSchema.parse({ token: 't', region: 'nyc3', allowAllCidr: true }))).toEqual([
      '0.0.0.0/0',
    ])
  })
})

describe('tag encoding', () => {
  it('round-trips the pairs Rocky Surf uses', () => {
    expect(encodeTag('managed-by', 'rockysurf')).toBe('managed-by:rockysurf')
    expect(decodeTag('managed-by:rockysurf')).toEqual({ key: 'managed-by', value: 'rockysurf' })
    expect(decodeTag('server-id:dev-box')).toEqual({ key: 'server-id', value: 'dev-box' })
  })

  it('refuses a value carrying the separator rather than mangling it', () => {
    // Rewriting `a:b` to `a-b` would make two different tags collide, and the failure would be
    // committed at create time and discovered by a bill.
    expect(() => encodeTag('owner', 'a:b')).toThrow(/round trip/)
  })

  it('refuses a character DigitalOcean does not allow in a tag', () => {
    expect(() => encodeTag('owner', 'someone@example.com')).toThrow(/does not allow/)
  })

  it('refuses a tag over the documented 255-character limit', () => {
    expect(() => encodeTag('server-id', 'x'.repeat(250))).toThrow(/255/)
  })

  it('ignores a tag it did not write when decoding', () => {
    expect(decodeTag('production')).toBeUndefined()
    expect(encodeTags({ 'managed-by': 'rockysurf' })).toEqual(['managed-by:rockysurf'])
  })
})
