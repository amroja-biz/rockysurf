import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeAccountAttributesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type InstanceStateName,
  type RunInstancesCommandInput,
} from '@aws-sdk/client-ec2'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import {
  assertDescribeAbsenceGrace,
  assertInstanceStateValid,
  assertManagedShape,
  assertOfferingsShape,
  assertProviderErrorShape,
  assertProviderShape,
  type AbsenceGraceHarness,
  type DescribeRead,
} from '@rockysurf/provider-conformance'
import {
  DESCRIBE_ABSENCE_GRACE,
  ProviderError,
  type ComputeProvider,
  type ProvisionSpec,
} from '@rockysurf/provider-sdk'
import { mockClient } from 'aws-sdk-client-mock'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { awsConfigSchema, type AwsProviderConfig } from './config.js'
import { mapAwsError } from './errors.js'
import { AWS_PRICES_FETCHED_AT } from './offerings.js'
import { ec2ConsoleUrl, makeAwsProvider } from './provider.js'

const AMI_ARM64 = 'ami-arm64test'
const AMI_AMD64 = 'ami-amd64test'
const VPC_ID = 'vpc-default'
const SUBNET_ID = 'subnet-default-a'
const SG_ID = 'sg-sharedssh'
const CIDR = '203.0.113.7/32'

const SSH_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY rockysurf@core'

const newEc2Mock = () => mockClient(EC2Client)
const newSsmMock = () => mockClient(SSMClient)

let ec2Mock: ReturnType<typeof newEc2Mock>
let ssmMock: ReturnType<typeof newSsmMock>
let provider: ComputeProvider
let byClientToken: Map<string, string>

function config(overrides: Partial<AwsProviderConfig> = {}): AwsProviderConfig {
  return awsConfigSchema.parse({ region: 'us-east-1', sshAllowedCidr: CIDR, ...overrides })
}

function build(overrides: Partial<AwsProviderConfig> = {}): ComputeProvider {
  return makeAwsProvider({
    config: config(overrides),
    ec2: new EC2Client({ region: 'us-east-1' }),
    ssm: new SSMClient({ region: 'us-east-1' }),
    // The propagation grace is real behaviour and is exercised below; the WAITING is not, so
    // the delay is zeroed rather than the retry count.
    sleep: async () => {},
  })
}

function spec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return {
    serverId: 'srv-abc123',
    name: 'dev-box',
    offeringId: 't4g.small',
    arch: 'arm64',
    sshPublicKeys: [SSH_KEY],
    userData: '#cloud-config\n',
    tags: { 'managed-by': 'rockysurf', 'server-id': 'srv-abc123' },
    idempotencyKey: 'idem-abc',
    ...overrides,
  }
}

function awsError(name: string, httpStatusCode = 400): Error {
  const err = new Error(`${name} (simulated)`)
  err.name = name
  ;(err as Error & { $metadata: unknown }).$metadata = { httpStatusCode }
  return err
}

const runInputs = (): RunInstancesCommandInput[] =>
  ec2Mock.commandCalls(RunInstancesCommand).map((c) => c.args[0].input as RunInstancesCommandInput)

beforeEach(() => {
  ec2Mock = newEc2Mock()
  ssmMock = newSsmMock()
  byClientToken = new Map()

  ssmMock.on(GetParameterCommand).callsFake((input: { Name?: string }) => ({
    Parameter: { Value: input.Name?.includes('/arm64/') ? AMI_ARM64 : AMI_AMD64 },
  }))

  ec2Mock.on(DescribeImagesCommand).resolves({ Images: [{ RootDeviceName: '/dev/sda1' }] })
  ec2Mock.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: VPC_ID }] })
  ec2Mock.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: SUBNET_ID }] })
  ec2Mock.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] })
  ec2Mock.on(CreateSecurityGroupCommand).resolves({ GroupId: SG_ID })
  ec2Mock.on(AuthorizeSecurityGroupIngressCommand).resolves({})
  ec2Mock.on(DescribeAccountAttributesCommand).resolves({})
  ec2Mock.on(TerminateInstancesCommand).resolves({})
  ec2Mock.on(StopInstancesCommand).resolves({})
  ec2Mock.on(StartInstancesCommand).resolves({})

  // Model EC2's ClientToken semantics: same token in, same instance out, no second launch.
  let seq = 0
  ec2Mock.on(RunInstancesCommand).callsFake((input: RunInstancesCommandInput) => {
    const token = input.ClientToken ?? ''
    const existing = byClientToken.get(token)
    if (existing) return { Instances: [{ InstanceId: existing, State: { Name: 'pending' } }] }
    const instanceId = `i-aws${++seq}`
    byClientToken.set(token, instanceId)
    return { Instances: [{ InstanceId: instanceId, State: { Name: 'pending' }, InstanceType: input.InstanceType }] }
  })

  provider = build()
})

describe('SDK conformance', () => {
  it('satisfies the shared provider shape checks', () => {
    assertProviderShape(provider)
  })

  it('offers only well-formed offerings', async () => {
    assertOfferingsShape(await provider.listOfferings())
  })

  it('reports only well-formed managed resources', async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' }, Tags: [{ Key: 'server-id', Value: 'srv-1' }] }] }],
    })
    ec2Mock.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: SG_ID }] })
    assertManagedShape(await provider.listManaged())
  })

  it('throws only ProviderErrors with frozen codes', async () => {
    ec2Mock.on(RunInstancesCommand).rejects(awsError('InsufficientInstanceCapacity', 500))
    await provider.provision(spec()).catch((err: unknown) => assertProviderErrorShape(err))
  })

  it('declares the capability profile from the matrix', () => {
    expect(provider.capabilities).toEqual({
      stop: true,
      ipStableAcrossStop: false,
      canInjectHostKeys: true,
      userDataMaxBytes: 16384,
      generatesUserData: true,
    })
  })
})

describe('offerings and prices', () => {
  it('prices in USD with a fetchedAt stamp (amendment B2)', async () => {
    const small = (await provider.listOfferings()).find((o) => o.id === 't4g.small')
    // The stamp is asserted against the exported constant rather than a literal: the table is
    // regenerated by `scripts/refresh-prices.mjs`, and a hardcoded date would turn every
    // refresh into a failing test for no reason. The AMOUNT is still pinned, because that is
    // the number a customer compares against their bill.
    expect(small?.hourly).toEqual({ amount: 0.0168, currency: 'USD', fetchedAt: AWS_PRICES_FETCHED_AT })
    expect(AWS_PRICES_FETCHED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('bundles catalogue breadth mechanically, not a hand-picked family list (rockysurf-tzzw)', async () => {
    const offerings = await provider.listOfferings()
    const ids = offerings.map((o) => o.id).sort()

    // The old t4g/t3-only allowlist is gone; the generator now ships whatever the feed's own
    // classification and the vCPU/memory ceiling allow, across every bundled region — hundreds
    // of types, not fourteen.
    expect(offerings.length).toBeGreaterThan(900)
    expect(ids).toContain('t4g.nano')
    expect(ids).toContain('t4g.2xlarge')
    expect(ids).toContain('t3.nano')
    expect(ids).toContain('t3.2xlarge')
    // Older generations the hand list would eventually have gone stale without — the whole
    // point of replacing it with a mechanical rule.
    expect(ids).toContain('m5.large')
    expect(ids).toContain('c5.large')

    // GPU / ML-ASIC / FPGA / media-accelerator families are excluded (Offering.gpu is
    // reserved-unpopulated and the bootstrap ships no drivers — see refresh-prices.mjs).
    expect(ids.some((id) => /^(p2|p3|p4|p5|p6|g3|g4|g5|g6|g7|gr6|f1|f2|dl1|inf1|inf2|trn1|vt1)/.test(id))).toBe(false)
    // Bare-metal is excluded by id.
    expect(ids.some((id) => id.includes('.metal'))).toBe(false)
    // The vCPU/memory ceiling excludes the multi-terabyte "u"/"u7i" high-memory family.
    expect(ids.some((id) => id.startsWith('u-') || id.startsWith('u7i'))).toBe(false)

    // Every offering listed for a BUNDLED region carries a real price — see buildOfferings()'s
    // long comment for why this is asserted as an exact invariant rather than "most of them": a
    // `hourly: null` row in a bundled region would be exactly the cap-blind defect breadth was
    // rejected for a live catalogue over. Graviton being cheaper than the x86 equivalent at the
    // same size is a sanity check on the join, not on AWS.
    expect(offerings.every((o) => o.hourly !== null)).toBe(true)
    const t4g = offerings.find((o) => o.id === 't4g.large')!.hourly!.amount
    const t3 = offerings.find((o) => o.id === 't3.large')!.hourly!.amount
    expect(t4g).toBeLessThan(t3)
  })

  it('omits a type from a bundled region entirely when that region genuinely does not sell it', async () => {
    // AWS_TYPES is the UNION of every bundled region's feed. Outside us-east-1, a large share of
    // it is absent from any one region's OWN feed — not unpriced, genuinely not offered there
    // (rockysurf-tzzw). Those types must not appear at all for that region, rather than showing
    // up with `hourly: null` and implying AWS would sell them there for an unknown price.
    const saoPaulo = build({ region: 'sa-east-1' })
    const offerings = await saoPaulo.listOfferings()
    expect(offerings.length).toBeGreaterThan(0)
    expect(offerings.every((o) => o.hourly !== null)).toBe(true)
    expect(offerings.length).toBeLessThan((await provider.listOfferings()).length)
  })

  it('reports hourly null in a region the table does not cover, rather than a wrong number', async () => {
    // eu-north-1 is a real AWS region that is deliberately NOT in the 12 bundled by
    // scripts/refresh-prices.mjs's AWS_REGIONS. Reusing a us-east-1 price for it would be
    // silently wrong; null means "unknown, never free" — see docs/providers/aws.md.
    const elsewhere = build({ region: 'eu-north-1' })
    expect((await elsewhere.listOfferings()).every((o) => o.hourly === null)).toBe(true)
  })

  it('carries an arch on every offering, both architectures represented', async () => {
    const offerings = await provider.listOfferings()
    expect(offerings.every((o) => o.arch === 'arm64' || o.arch === 'amd64')).toBe(true)
    expect(offerings.some((o) => o.arch === 'arm64')).toBe(true)
    expect(offerings.some((o) => o.arch === 'amd64')).toBe(true)
  })

  it('reports availability, which EC2 answers at RunInstances rather than in a list', async () => {
    expect((await provider.listOfferings()).every((o) => o.available)).toBe(true)
  })

  it('describes the disk core will actually attach', async () => {
    const custom = build({ rootVolumeGb: 50 })
    expect((await custom.listOfferings()).every((o) => o.diskGb === 50)).toBe(true)
  })
})

describe('validateSpec (amendment A7)', () => {
  const rejects = async (s: ProvisionSpec, match: RegExp) => {
    await expect(provider.validateSpec(s)).rejects.toMatchObject({ code: 'invalid_spec' })
    await expect(provider.validateSpec(s)).rejects.toThrow(match)
  }

  it('rejects an unknown offering', () => rejects(spec({ offeringId: 'm7i.metal-48xl' }), /no such offering/))
  it('rejects an arch mismatch', () => rejects(spec({ arch: 'amd64' }), /does not match offering/))
  it('rejects an empty key list', () => rejects(spec({ sshPublicKeys: [] }), /ssh public key/))
  it('rejects a missing idempotency key', () => rejects(spec({ idempotencyKey: '' }), /idempotencyKey/))

  it('rejects user-data over the 16KB ceiling', () =>
    rejects(spec({ userData: 'x'.repeat(16385) }), /16384B ceiling/))

  it('rejects a managed-by the reconciler would never find (amendment D3)', () =>
    rejects(spec({ tags: { 'managed-by': 'someone-else' } }), /reconciles 'rockysurf'/))

  it('accepts a valid spec', async () => {
    await expect(provider.validateSpec(spec())).resolves.toBeUndefined()
  })

  it('runs as part of provision, so a bad spec creates nothing', async () => {
    await expect(provider.provision(spec({ offeringId: 'nope' }))).rejects.toMatchObject({ code: 'invalid_spec' })
    expect(runInputs()).toHaveLength(0)
  })
})

describe('provision', () => {
  it('passes idempotencyKey as the ClientToken', async () => {
    await provider.provision(spec())
    expect(runInputs()[0]?.ClientToken).toBe('idem-abc')
  })

  it('returns {data, initial} so core needs no describe round trip (A6)', async () => {
    const result = await provider.provision(spec())
    expect(result.data).toEqual({ instanceId: 'i-aws1', region: 'us-east-1' })
    expect(result.initial.state).toBe('pending')
    expect(result.initial.offeringId).toBe('t4g.small')
  })

  it('replaying a token returns the same instance, with no client-side dedupe', async () => {
    const first = await provider.provision(spec())
    const second = await provider.provision(spec())
    expect(second.data['instanceId']).toBe(first.data['instanceId'])
    // Both calls really hit RunInstances: the dedupe under test is EC2's, not ours.
    expect(runInputs()).toHaveLength(2)
  })

  it('resolves the arch-appropriate Ubuntu AMI from SSM', async () => {
    await provider.provision(spec())
    await provider.provision(spec({ offeringId: 't3.small', arch: 'amd64', idempotencyKey: 'idem-2' }))

    const names = ssmMock.commandCalls(GetParameterCommand).map((c) => (c.args[0].input as { Name: string }).Name)
    expect(names).toContain('/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id')
    expect(names).toContain('/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id')
    expect(runInputs().map((i) => i.ImageId)).toEqual([AMI_ARM64, AMI_AMD64])
  })

  it('caches the AMI lookup per arch', async () => {
    await provider.provision(spec())
    await provider.provision(spec({ idempotencyKey: 'idem-2', serverId: 'srv-def456' }))
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1)
  })

  it('base64-encodes user-data', async () => {
    const s = spec({ userData: '#cloud-config\nhostname: dev-box\n' })
    await provider.provision(s)
    expect(Buffer.from(runInputs()[0]!.UserData!, 'base64').toString('utf8')).toBe(s.userData)
  })

  it('sizes the root volume off the AMI root device, delete-on-termination (D4)', async () => {
    await provider.provision(spec())
    expect(runInputs()[0]?.BlockDeviceMappings).toEqual([
      { DeviceName: '/dev/sda1', Ebs: { VolumeSize: 20, VolumeType: 'gp3', DeleteOnTermination: true } },
    ])
  })

  it('requires IMDSv2 with a single hop', async () => {
    await provider.provision(spec())
    expect(runInputs()[0]?.MetadataOptions).toEqual({
      HttpEndpoint: 'enabled',
      HttpTokens: 'required',
      HttpPutResponseHopLimit: 1,
    })
  })

  it('asks for a public IP through NetworkInterfaces, not the conflicting top-level fields', async () => {
    await provider.provision(spec())
    const input = runInputs()[0]!
    expect(input.NetworkInterfaces).toEqual([
      { DeviceIndex: 0, AssociatePublicIpAddress: true, DeleteOnTermination: true, SubnetId: SUBNET_ID, Groups: [SG_ID] },
    ])
    expect(input.SubnetId).toBeUndefined()
    expect(input.SecurityGroupIds).toBeUndefined()
  })

  it('never asks for an EC2 key pair', async () => {
    await provider.provision(spec())
    expect(runInputs()[0]?.KeyName).toBeUndefined()
  })

  /**
   * EVERY RESOURCE THE LAUNCH CREATES CARRIES THE TAGS (rockysurf-b14y).
   *
   * `RunInstances` can tag four types — instances, volumes, spot instance requests and network
   * interfaces — and this launch creates three of them. The ENI was the one left out, which cost
   * twice over: `listManaged()` walks by tag and so could not have seen an ENI that outlived its
   * instance, and the published IAM policy had to keep `network-interface/*` in the
   * UNCONDITIONED `RunInstances` statement, because `aws:RequestTag/managed-by` does not exist
   * for a resource the request does not tag. Tagging it lets that ARN move back under the tag
   * condition, which is what makes the policy tighter rather than merely tidier.
   */
  it('tags the instance, the volume AND the network interface the launch creates', async () => {
    await provider.provision(spec())
    const tagSpecs = runInputs()[0]?.TagSpecifications ?? []
    expect(tagSpecs.map((t) => t.ResourceType)).toEqual(['instance', 'volume', 'network-interface'])
    for (const ts of tagSpecs) {
      const tags = Object.fromEntries((ts.Tags ?? []).map((t) => [t.Key, t.Value]))
      expect(tags).toMatchObject({ 'managed-by': 'rockysurf', 'server-id': 'srv-abc123', Name: 'rockysurf-srv-abc123' })
    }
  })

  it('honours a configured managed-by prefix', async () => {
    const custom = makeAwsProvider({
      config: config({ managedBy: 'rockysurf-staging' }),
      ec2: new EC2Client({ region: 'us-east-1' }),
      ssm: new SSMClient({ region: 'us-east-1' }),
    })
    await custom.provision(spec({ tags: { 'managed-by': 'rockysurf-staging' } }))
    const tags = Object.fromEntries((runInputs()[0]?.TagSpecifications?.[0]?.Tags ?? []).map((t) => [t.Key, t.Value]))
    expect(tags['managed-by']).toBe('rockysurf-staging')
  })
})

describe('the shared security group', () => {
  it('creates it once, in the default VPC', async () => {
    await provider.provision(spec())
    const created = ec2Mock.commandCalls(CreateSecurityGroupCommand)[0]?.args[0].input as {
      GroupName: string
      VpcId: string
    }
    expect(created.GroupName).toBe('rockysurf-ssh')
    expect(created.VpcId).toBe(VPC_ID)
  })

  it('authorizes the CONFIGURED cidr, not the caller\'s own address', async () => {
    await provider.provision(spec())
    const auth = ec2Mock.commandCalls(AuthorizeSecurityGroupIngressCommand)[0]?.args[0].input as {
      IpPermissions: { IpProtocol: string; FromPort: number; ToPort: number; IpRanges: { CidrIp: string }[] }[]
    }
    expect(auth.IpPermissions[0]).toMatchObject({ IpProtocol: 'tcp', FromPort: 22, ToPort: 22 })
    expect(auth.IpPermissions[0]?.IpRanges[0]?.CidrIp).toBe(CIDR)
  })

  it('reuses the group on a second provision', async () => {
    await provider.provision(spec())
    await provider.provision(spec({ idempotencyKey: 'idem-2', serverId: 'srv-def456' }))
    expect(ec2Mock.commandCalls(CreateSecurityGroupCommand)).toHaveLength(1)
    expect(ec2Mock.commandCalls(AuthorizeSecurityGroupIngressCommand)).toHaveLength(1)
  })

  it('adopts a group left by an earlier process', async () => {
    ec2Mock.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: 'sg-frombefore' }] })
    await provider.provision(spec())
    expect(ec2Mock.commandCalls(CreateSecurityGroupCommand)).toHaveLength(0)
    expect(runInputs()[0]?.NetworkInterfaces?.[0]?.Groups).toEqual(['sg-frombefore'])
  })

  it('adopts the winner when two processes race', async () => {
    ec2Mock.on(CreateSecurityGroupCommand).rejects(awsError('InvalidGroup.Duplicate'))
    ec2Mock
      .on(DescribeSecurityGroupsCommand)
      .resolvesOnce({ SecurityGroups: [] })
      .resolves({ SecurityGroups: [{ GroupId: 'sg-racewinner' }] })

    await provider.provision(spec())
    expect(runInputs()[0]?.NetworkInterfaces?.[0]?.Groups).toEqual(['sg-racewinner'])
  })

  it('treats an already-present rule as success', async () => {
    ec2Mock.on(AuthorizeSecurityGroupIngressCommand).rejects(awsError('InvalidPermission.Duplicate'))
    await expect(provider.provision(spec())).resolves.toMatchObject({ data: { instanceId: 'i-aws1' } })
  })

  it('fails clearly when the region has no default VPC', async () => {
    ec2Mock.on(DescribeVpcsCommand).resolves({ Vpcs: [] })
    await expect(provider.provision(spec())).rejects.toThrow(/no default VPC/)
  })
})

describe('the sshAllowedCidr contract', () => {
  it('refuses a config that does not say who may reach SSH', () => {
    expect(() => awsConfigSchema.parse({ region: 'us-east-1' })).toThrow(/sshAllowedCidr is required/)
  })

  it('refuses 0.0.0.0/0 without the explicit escape hatch', () => {
    expect(() => awsConfigSchema.parse({ sshAllowedCidr: '0.0.0.0/0' })).toThrow(/allowAllCidr/)
  })

  it('allows 0.0.0.0/0 when the operator says so twice', () => {
    const parsed = awsConfigSchema.parse({ sshAllowedCidr: '0.0.0.0/0', allowAllCidr: true })
    expect(parsed.sshAllowedCidr).toBe('0.0.0.0/0')
  })

  it('rejects a malformed cidr', () => {
    expect(() => awsConfigSchema.parse({ sshAllowedCidr: '203.0.113.7' })).toThrow(/IPv4 CIDR/)
    expect(() => awsConfigSchema.parse({ sshAllowedCidr: 'everyone' })).toThrow(/IPv4 CIDR/)
  })

  it('never authorizes 0.0.0.0/0 by default', async () => {
    await provider.provision(spec())
    expect(JSON.stringify(ec2Mock.commandCalls(AuthorizeSecurityGroupIngressCommand)[0]?.args[0].input)).not.toContain(
      '0.0.0.0/0',
    )
  })

  it('authorizes 0.0.0.0/0 ONLY when both switches are set', async () => {
    const open = makeAwsProvider({
      config: awsConfigSchema.parse({ sshAllowedCidr: '0.0.0.0/0', allowAllCidr: true }),
      ec2: new EC2Client({ region: 'us-east-1' }),
      ssm: new SSMClient({ region: 'us-east-1' }),
    })
    await open.provision(spec())
    const auth = ec2Mock.commandCalls(AuthorizeSecurityGroupIngressCommand)[0]?.args[0].input as {
      IpPermissions: { IpRanges: { CidrIp: string }[] }[]
    }
    expect(auth.IpPermissions[0]?.IpRanges[0]?.CidrIp).toBe('0.0.0.0/0')
  })
})

describe('describe', () => {
  const data = { instanceId: 'i-aws1', region: 'us-east-1' }
  const withState = (name: string, extra: Record<string, unknown> = {}) =>
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: 'i-aws1', State: { Name: name as InstanceStateName }, ...extra }] }],
    })

  it.each([
    ['pending', 'pending'],
    ['running', 'running'],
    ['stopping', 'stopping'],
    ['stopped', 'stopped'],
    // The finding this provider produced, now with a field to live in (amendment A3).
    ['shutting-down', 'terminating'],
    ['terminated', 'terminated'],
  ])('maps EC2 %s to %s', async (ec2State, expected) => {
    withState(ec2State)
    const view = await provider.describe(data)
    expect(view.state).toBe(expected)
    assertInstanceStateValid(view.state)
  })

  it('maps an unrecognized state to unknown rather than guessing', async () => {
    withState('quantum-superposition')
    expect((await provider.describe(data)).state).toBe('unknown')
  })

  it('returns the address and instance type when running', async () => {
    withState('running', {
      PublicIpAddress: '54.1.2.3',
      PublicDnsName: 'ec2-54-1-2-3.compute-1.amazonaws.com',
      InstanceType: 't4g.small',
    })
    expect(await provider.describe(data)).toEqual({
      state: 'running',
      publicIp: '54.1.2.3',
      publicDns: 'ec2-54-1-2-3.compute-1.amazonaws.com',
      offeringId: 't4g.small',
      consoleUrl: 'https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#InstanceDetails:instanceId=i-aws1',
    })
  })

  it('returns terminated for NotFound rather than throwing, once the grace is exhausted', async () => {
    ec2Mock.on(DescribeInstancesCommand).rejects(awsError('InvalidInstanceID.NotFound'))
    await expect(provider.describe(data)).resolves.toEqual({ state: 'terminated' })
    // Believed only after the full grace — this is the difference between "gone" and "not
    // propagated yet", and the count is what makes it a decision rather than a guess.
    expect(ec2Mock.commandCalls(DescribeInstancesCommand)).toHaveLength(DESCRIBE_ABSENCE_GRACE.attempts)
  })

  it('returns terminated when the instance has aged out of DescribeInstances', async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [] })
    await expect(provider.describe(data)).resolves.toEqual({ state: 'terminated' })
    expect(ec2Mock.commandCalls(DescribeInstancesCommand)).toHaveLength(DESCRIBE_ABSENCE_GRACE.attempts)
  })

  /**
   * THE DATA-LOSS TRAP (amendment A4), caught by the gyp1.4 exit run.
   *
   * DescribeInstances is eventually consistent: it answered not-found 100ms after a SUCCESSFUL
   * launch, core wrote `terminated` onto a live box, and `terminate()` on an
   * already-terminated row is a no-op — so the instance kept running and billing with nothing
   * in the system pointing at it. This provider believed the first not-found because its
   * describe() delegated the grace to core, which never had one. The fake provider implemented
   * the grace itself, which is why 85 passing tests never noticed.
   */
  it('survives the eventual-consistency window instead of declaring a live instance dead', async () => {
    ec2Mock
      .on(DescribeInstancesCommand)
      .rejectsOnce(awsError('InvalidInstanceID.NotFound'))
      .rejectsOnce(awsError('InvalidInstanceID.NotFound'))
      .resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-aws1', State: { Name: 'running' } }] }] })

    await expect(provider.describe(data)).resolves.toMatchObject({ state: 'running' })
  })

  it('does not make a teardown wait out the grace it no longer needs', async () => {
    // Once an instance has been SEEN running, its absence is a real termination. Core polls
    // describe() in a loop while tearing down; retrying each of those is pure delay.
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: 'i-aws1', State: { Name: 'running' } }] }],
    })
    await provider.describe(data)

    ec2Mock.reset()
    ec2Mock.on(DescribeInstancesCommand).rejects(awsError('InvalidInstanceID.NotFound'))
    await expect(provider.describe(data)).resolves.toEqual({ state: 'terminated' })
    expect(ec2Mock.commandCalls(DescribeInstancesCommand)).toHaveLength(1)
  })

  it('still throws on a real failure', async () => {
    ec2Mock.on(DescribeInstancesCommand).rejects(awsError('RequestLimitExceeded', 503))
    await expect(provider.describe(data)).rejects.toMatchObject({ code: 'rate_limited', retryable: true })
  })
})

/**
 * The console deep link (ADR-0003, E16).
 *
 * Verified against the shape `link2aws` builds for an EC2 instance ARN
 * (`github.com/link2aws/link2aws.github.io`, `link2aws.js`): the regional console host, the
 * region ALSO in the query string, and the instance in the fragment. Both halves matter — the
 * query is what selects the region before the console resolves the fragment.
 */
describe('the console link (E16)', () => {
  it('builds the EC2 instance-details URL from the region and the instance id', () => {
    expect(ec2ConsoleUrl('eu-central-1', 'i-0abc123')).toBe(
      'https://eu-central-1.console.aws.amazon.com/ec2/home?region=eu-central-1#InstanceDetails:instanceId=i-0abc123',
    )
  })

  it.each([
    ['cn-north-1', 'https://cn-north-1.console.amazonaws.cn/ec2/home?region=cn-north-1#InstanceDetails:instanceId=i-1'],
    [
      'us-gov-west-1',
      'https://us-gov-west-1.console.amazonaws-us-gov.com/ec2/home?region=us-gov-west-1#InstanceDetails:instanceId=i-1',
    ],
  ])('sends %s to its own partition console', (region, expected) => {
    expect(ec2ConsoleUrl(region, 'i-1')).toBe(expected)
  })

  it('reports nothing for a region it does not recognise, rather than a wrong-partition link', () => {
    // A link into a partition the operator has no account in is worse than no link: the SDK
    // models absence, so absence is the honest answer.
    expect(ec2ConsoleUrl('not-a-region', 'i-1')).toBeUndefined()
    expect(ec2ConsoleUrl('us-east-1', '')).toBeUndefined()
  })

  it('is on the view the create call returns, so the link works while the box is still booting', async () => {
    const result = await provider.provision(spec())
    expect(result.initial.consoleUrl).toBe(
      'https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#InstanceDetails:instanceId=i-aws1',
    )
  })

  it('follows the configured region, not the one the last provider was built with', async () => {
    const frankfurt = build({ region: 'eu-central-1' })
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: 'i-aws1', State: { Name: 'running' } }] }],
    })
    expect((await frankfurt.describe({ instanceId: 'i-aws1', region: 'eu-central-1' })).consoleUrl).toBe(
      'https://eu-central-1.console.aws.amazon.com/ec2/home?region=eu-central-1#InstanceDetails:instanceId=i-aws1',
    )
  })

  it('carries no credential — only the identifiers the row already holds', async () => {
    const url = (await provider.provision(spec())).initial.consoleUrl!
    expect(url).not.toContain(SSH_KEY)
    expect(new URL(url).searchParams.size).toBe(1)
  })
})

describe('terminate', () => {
  const data = { instanceId: 'i-aws1', region: 'us-east-1' }

  it('terminates by id', async () => {
    await provider.terminate(data)
    const input = ec2Mock.commandCalls(TerminateInstancesCommand)[0]?.args[0].input as { InstanceIds: string[] }
    expect(input.InstanceIds).toEqual(['i-aws1'])
  })

  it('treats not-found as success', async () => {
    ec2Mock.on(TerminateInstancesCommand).rejects(awsError('InvalidInstanceID.NotFound'))
    await expect(provider.terminate(data)).resolves.toBeUndefined()
  })

  it('propagates anything else', async () => {
    ec2Mock.on(TerminateInstancesCommand).rejects(awsError('UnauthorizedOperation', 403))
    await expect(provider.terminate(data)).rejects.toMatchObject({ code: 'auth' })
  })
})

describe('listManaged', () => {
  it('returns live instances as server-owned and the SG as shared (amendment D1)', async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            { InstanceId: 'i-live', State: { Name: 'running' }, Tags: [{ Key: 'server-id', Value: 'srv-1' }] },
            { InstanceId: 'i-going', State: { Name: 'shutting-down' }, Tags: [{ Key: 'server-id', Value: 'srv-2' }] },
            { InstanceId: 'i-gone', State: { Name: 'terminated' }, Tags: [{ Key: 'server-id', Value: 'srv-3' }] },
          ],
        },
      ],
    })
    ec2Mock.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: SG_ID }] })

    const managed = await provider.listManaged()
    // `shutting-down` STAYS: it still exists and still holds its volume. Only `terminated` goes.
    expect(managed.filter((m) => m.kind === 'instance').map((m) => m.providerNativeId)).toEqual(['i-live', 'i-going'])
    expect(managed.find((m) => m.providerNativeId === 'i-live')).toMatchObject({
      ownership: 'server-owned',
      serverId: 'srv-1',
    })
    expect(managed.find((m) => m.kind === 'security-group')).toMatchObject({ ownership: 'shared' })
  })

  it('filters by the managed-by tag', async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [] })
    ec2Mock.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] })
    await provider.listManaged()

    const input = ec2Mock.commandCalls(DescribeInstancesCommand)[0]?.args[0].input as {
      Filters: { Name: string; Values: string[] }[]
    }
    expect(input.Filters).toEqual([{ Name: 'tag:managed-by', Values: ['rockysurf'] }])
  })

  it('follows NextToken', async () => {
    ec2Mock
      .on(DescribeInstancesCommand)
      .resolvesOnce({
        Reservations: [{ Instances: [{ InstanceId: 'i-page1', State: { Name: 'running' } }] }],
        NextToken: 'page-2',
      })
      .resolves({ Reservations: [{ Instances: [{ InstanceId: 'i-page2', State: { Name: 'running' } }] }] })
    ec2Mock.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] })

    expect((await provider.listManaged()).map((m) => m.providerNativeId)).toEqual(['i-page1', 'i-page2'])
  })
})

describe('stop and start', () => {
  const data = { instanceId: 'i-aws1', region: 'us-east-1' }

  it('are real on AWS, because the capability says so', async () => {
    expect(provider.capabilities.stop).toBe(true)
    await provider.stop(data)
    await provider.start(data)
    expect(ec2Mock.commandCalls(StopInstancesCommand)).toHaveLength(1)
    expect(ec2Mock.commandCalls(StartInstancesCommand)).toHaveLength(1)
  })

  it('map failures onto the taxonomy', async () => {
    ec2Mock.on(StopInstancesCommand).rejects(awsError('IncorrectInstanceState'))
    await expect(provider.stop(data)).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('error taxonomy', () => {
  it.each([
    ['AuthFailure', 'auth'],
    ['UnauthorizedOperation', 'auth'],
    ['InstanceLimitExceeded', 'quota'],
    ['InsufficientInstanceCapacity', 'capacity'],
    ['InvalidParameterValue', 'invalid_spec'],
    ['InvalidAMIID.Malformed', 'invalid_spec'],
    ['InvalidInstanceID.NotFound', 'not_found'],
    ['ParameterNotFound', 'not_found'],
    ['RequestLimitExceeded', 'rate_limited'],
    ['IdempotentParameterMismatch', 'conflict'],
    ['TimeoutError', 'network'],
    ['SomeBrandNewEc2Error', 'unknown'],
  ] as const)('maps %s to %s', (name, expected) => {
    expect(mapAwsError(awsError(name), 'ctx').code).toBe(expected)
  })

  it('carries the cloud\'s own code verbatim (amendment F1)', () => {
    const mapped = mapAwsError(awsError('InsufficientInstanceCapacity'), 'ec2:RunInstances')
    expect(mapped.providerCode).toBe('InsufficientInstanceCapacity')
    expect(mapped.code).toBe('capacity')
  })

  it('derives retryable from the code, with no field to contradict it (F2)', () => {
    expect(mapAwsError(awsError('RequestLimitExceeded'), 'ctx').retryable).toBe(true)
    expect(mapAwsError(awsError('InsufficientInstanceCapacity'), 'ctx').retryable).toBe(true)
    expect(mapAwsError(awsError('AuthFailure', 401), 'ctx').retryable).toBe(false)
  })

  it('keeps the cause and never rewraps a ProviderError', () => {
    const original = awsError('AuthFailure', 401)
    const mapped = mapAwsError(original, 'ec2:RunInstances')
    expect(mapped.cause).toBe(original)
    expect(mapAwsError(mapped, 'again')).toBe(mapped)
  })

  it('honours the SDK throttling hint for codes not in the table', () => {
    const err = awsError('SomeThrottleFlavour', 503)
    ;(err as Error & { $retryable: unknown }).$retryable = { throttling: true }
    expect(mapAwsError(err, 'ctx').code).toBe('rate_limited')
  })
})

/**
 * The shared behavioural case, run against this provider (rockysurf-5i28).
 *
 * The four hand-written grace tests above are this provider's own; this block is the suite
 * EVERY provider must pass, so the rule cannot be re-skipped by the next implementation the
 * way it was skipped by this one. All this file owes it is the stub wiring.
 */
describe('conformance: describe() absence grace', () => {
  const data = { instanceId: 'i-aws1', region: 'us-east-1' }
  const runningInstance = { Reservations: [{ Instances: [{ InstanceId: 'i-aws1', State: { Name: 'running' as InstanceStateName } }] }] }

  /** Answers `script` in order, repeating the last entry forever, and counts the calls. */
  function scriptDescribeInstances(script: readonly DescribeRead[]): () => number {
    let reads = 0
    ec2Mock.on(DescribeInstancesCommand).callsFake(() => {
      const answer = script[Math.min(reads, script.length - 1)]
      reads++
      if (answer === 'absent') throw awsError('InvalidInstanceID.NotFound')
      return runningInstance
    })
    return () => reads
  }

  const harness: AbsenceGraceHarness = {
    provider: 'aws',
    neverSeenRunning(script) {
      // A FRESH provider: `seenRunning` is per-instance state, and an instance this one has
      // never described is exactly the ambiguous case the grace is for.
      const provider = build()
      const reads = scriptDescribeInstances(script)
      return { run: async () => ({ view: await provider.describe(data), reads: reads() }) }
    },
    async goneAfterRunning() {
      const provider = build()
      ec2Mock.on(DescribeInstancesCommand).resolves(runningInstance)
      await provider.describe(data)

      const reads = scriptDescribeInstances(['absent'])
      return { run: async () => ({ view: await provider.describe(data), reads: reads() }) }
    },
  }

  it('honours the shared absence-grace contract', async () => {
    await assertDescribeAbsenceGrace(harness)
  })
})

describe('acceptance criteria a reviewer can grep for', () => {
  const sources = ['provider.ts', 'config.ts', 'errors.ts', 'offerings.ts', 'index.ts']
    .map((f) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8'))
    .join('\n')
  // Comments discuss CloudFormation and key pairs at length, explaining why neither is here.
  const code = sources.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('makes zero CloudFormation calls', () => {
    expect(code).not.toMatch(/cloudformation/i)
  })

  it('creates no key pairs and no per-server IAM', () => {
    expect(code).not.toMatch(/KeyPair|KeyName|IamInstanceProfile|InstanceProfile|CreateRole/)
  })

  it('gives sshAllowedCidr no default, so the operator must state it', () => {
    // A grep for the literal would only count the guard that REJECTS it; the property worth
    // asserting is behavioural — the field has no default and parsing without it fails.
    expect(() => awsConfigSchema.parse({})).toThrow(/sshAllowedCidr is required/)
    expect(awsConfigSchema.parse({ sshAllowedCidr: CIDR }).allowAllCidr).toBe(false)
  })

  it('does not look up the caller\'s own address to decide a firewall rule', () => {
    expect(code).not.toMatch(/checkip|ipify|whatismyip/i)
  })

  it('imports only the two AWS clients it needs', () => {
    const packages = [...code.matchAll(/from '(@aws-sdk\/[^']+)'/g)].map((m) => m[1])
    expect([...new Set(packages)].sort()).toEqual(['@aws-sdk/client-ec2', '@aws-sdk/client-ssm'])
  })
})
