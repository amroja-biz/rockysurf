import { describe, expect, it } from 'vitest'
import { gcpConfigSchema, regionOf, resolveSshCidr } from './config.js'

const valid = { projectId: 'demo-project', sshAllowedCidr: '203.0.113.7/32' }

describe('required fields', () => {
  it('requires projectId, because GCP has no implicit project', () => {
    // A credential can be valid for many projects and names none of them, so a default here
    // would mean creating billable machines somewhere the operator did not choose.
    expect(() => gcpConfigSchema.parse({ sshAllowedCidr: '203.0.113.7/32' })).toThrow()
  })

  it('accepts a well-formed project id and rejects a malformed one', () => {
    expect(gcpConfigSchema.parse(valid).projectId).toBe('demo-project')
    expect(() => gcpConfigSchema.parse({ ...valid, projectId: 'Not_A_Project' })).toThrow()
    expect(() => gcpConfigSchema.parse({ ...valid, projectId: 'ab' })).toThrow()
  })

  it('defaults the zone to one that actually has arm64', () => {
    // us-central1-c is the trap: three of four us-central1 zones carry T2A and -c does not,
    // so an innocent-looking default would produce a silently amd64-only installation.
    expect(gcpConfigSchema.parse(valid).zone).toBe('us-central1-a')
  })

  it('rejects something that is not a zone', () => {
    // A region is the mistake worth catching: `us-central1` is not a zone.
    expect(() => gcpConfigSchema.parse({ ...valid, zone: 'us-central1' })).toThrow()
    expect(gcpConfigSchema.parse({ ...valid, zone: 'europe-west4-b' }).zone).toBe('europe-west4-b')
  })
})

describe('the SSH ingress rule', () => {
  it('refuses a section that does not say who may reach SSH', () => {
    const result = gcpConfigSchema.safeParse({ projectId: 'demo-project' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('sshAllowedCidr is required')
  })

  it('refuses 0.0.0.0/0 unless it is asked for twice', () => {
    const once = gcpConfigSchema.safeParse({ projectId: 'demo-project', sshAllowedCidr: '0.0.0.0/0' })
    expect(once.success).toBe(false)
    expect(JSON.stringify(once.error?.issues)).toContain('allowAllCidr')

    const twice = gcpConfigSchema.parse({
      projectId: 'demo-project',
      sshAllowedCidr: '0.0.0.0/0',
      allowAllCidr: true,
    })
    expect(resolveSshCidr(twice)).toBe('0.0.0.0/0')
  })

  it('rejects a CIDR that is not one', () => {
    expect(() => gcpConfigSchema.parse({ ...valid, sshAllowedCidr: '203.0.113.7' })).toThrow()
  })
})

describe('credentials', () => {
  it('takes a key file as a PATH', () => {
    const config = gcpConfigSchema.parse({ ...valid, keyFile: '~/keys/sa.json' })
    expect(config.keyFile).toBe('~/keys/sa.json')
  })

  it('has nowhere to put key material at all', () => {
    // THE POINT OF THIS TEST. The schema is strict, so every shape somebody might paste a
    // private key into is a parse error rather than a secret committed to a config file. If a
    // future field made any of these legal, this fails.
    for (const shape of [
      { privateKey: '-----BEGIN PRIVATE KEY-----' },
      { private_key: '-----BEGIN PRIVATE KEY-----' },
      { credentials: { type: 'service_account', private_key: 'x' } },
      { serviceAccountKey: '{"type":"service_account"}' },
      { clientEmail: 'sa@demo-project.iam.gserviceaccount.com', privateKey: 'x' },
    ]) {
      expect(gcpConfigSchema.safeParse({ ...valid, ...shape }).success).toBe(false)
    }
  })
})

describe('defaults', () => {
  it('produces a complete, usable configuration from the two required answers', () => {
    expect(gcpConfigSchema.parse(valid)).toEqual({
      projectId: 'demo-project',
      sshAllowedCidr: '203.0.113.7/32',
      allowAllCidr: false,
      zone: 'us-central1-a',
      managedBy: 'rockysurf',
      firewallRuleName: 'rockysurf-ssh',
      network: 'default',
      bootDiskGb: 20,
      bootDiskType: 'pd-balanced',
      imageProject: 'ubuntu-os-cloud',
      imageFamilyPrefix: 'ubuntu-2404-lts',
    })
  })

  it('rejects an unknown key rather than ignoring it', () => {
    expect(gcpConfigSchema.safeParse({ ...valid, zonee: 'us-central1-a' }).success).toBe(false)
  })

  it('requires managedBy to be a legal name, because it prefixes every instance name', () => {
    expect(() => gcpConfigSchema.parse({ ...valid, managedBy: '9lives' })).toThrow()
    expect(() => gcpConfigSchema.parse({ ...valid, managedBy: 'Rocky_Surf' })).toThrow()
  })
})

describe('regionOf', () => {
  it('drops the zone letter to get the region the price table is keyed by', () => {
    expect(regionOf('us-central1-a')).toBe('us-central1')
    expect(regionOf('europe-west4-b')).toBe('europe-west4')
    expect(regionOf('asia-southeast1-c')).toBe('asia-southeast1')
  })
})
