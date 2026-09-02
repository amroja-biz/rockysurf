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
  type Instance,
  type Tag,
  type _InstanceType,
} from '@aws-sdk/client-ec2'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import {
  DESCRIBE_ABSENCE_GRACE,
  ProviderError,
  unsupportedOperationError,
  type Architecture,
  type ComputeProvider,
  type InstanceState,
  type InstanceView,
  type ManagedResource,
  type Offering,
  type ProviderCapabilities,
  type ProviderData,
  type ProvisionResult,
  type ProvisionSpec,
  type SshAccessSyncResult,
} from '@rockysurf/provider-sdk'
import { resolveSshCidrs, type AwsProviderConfig } from './config.js'
import { awsErrorCode, isNotFound, mapAwsError } from './errors.js'
import { PriceFeedClient, type PriceFeedDoc } from './feed.js'
import { buildOfferings } from './offerings.js'

/**
 * AWS EC2, as plain API calls.
 *
 * NO CLOUDFORMATION anywhere — that is the point of the design, not an omission. The
 * per-server stack existed so the box could read DynamoDB and Secrets Manager through a
 * per-server IAM role; the push bootstrap removed that need, so the whole apparatus
 * (`pollStackStatus.ts`, the EventBridge rules, the S3-hosted templates) goes with it. What
 * is left is RunInstances plus one shared security group.
 *
 * Ported from `spike/src/providers/aws.ts`, which ran two verified real lifecycles
 * (`spike/recordings/aws-lifecycle.txt`), onto the frozen SDK.
 */

/**
 * The description stamped on every ingress range this provider authorizes — and the ONLY thing
 * that makes a range safe to remove later.
 *
 * A shared security group is not ours alone: an operator may have added their office range by
 * hand, and an older Rocky Surf authorized ranges before this release existed. Removing one of
 * those because it is absent from the config file would be the product deleting access it never
 * created and cannot explain. So the stamp is the proof of authorship, `syncSshAccess()` will
 * only ever revoke a range carrying it, and everything else is reported to the operator with the
 * command that would remove it.
 *
 * Changing this string orphans every range a previous release stamped. Don't.
 *
 * Exported because the ownership check is not the provider's alone: the nightly CI sweep and the
 * one-time cleanup script (issue #320) decide what they may safely remove from the shared group by
 * exactly this stamp, and a second copy of the literal in a script is a second thing to forget to
 * change. One constant, imported wherever the question "did Rocky Surf author this rule?" is asked.
 */
export const SSH_RULE_DESCRIPTION = 'rockysurf sshAllowedCidr'

const CAPABILITIES: ProviderCapabilities = {
  stop: true,
  /** A new public IPv4 on every start, absent an Elastic IP — which we deliberately do not allocate. */
  ipStableAcrossStop: false,
  canInjectHostKeys: true,
  /** EC2's hard limit, measured on the RAW bytes before base64. */
  userDataMaxBytes: 16384,
  generatesUserData: true,
  /** One shared security group per region, and `syncSshAccess()` brings it in line on demand. */
  managesSshAccess: true,
}

/**
 * EC2 states onto the frozen `InstanceView` vocabulary.
 *
 * `shutting-down` → `terminating` is the fix for the finding this provider itself produced in
 * the spike. With nowhere to put that state, the two spike providers picked two DIFFERENT
 * wrong answers — this one said `terminated`, which made zero-orphan audits falsely green for
 * about a minute while the instance still existed and still held its volume. Amendment A3
 * added the state; this is it being used.
 */
const STATE_MAP: Record<string, InstanceState> = {
  pending: 'pending',
  running: 'running',
  stopping: 'stopping',
  stopped: 'stopped',
  'shutting-down': 'terminating',
  terminated: 'terminated',
}

const MANAGED_BY_TAG = 'managed-by'
const SERVER_ID_TAG = 'server-id'

/**
 * The AWS Management Console host, per partition.
 *
 * A region prefix is the only thing that decides this, and an unrecognised one is answered with
 * `undefined` rather than the commercial host: a link into the wrong partition is a link to an
 * account the operator does not have, which is worse than the no-link case the SDK already
 * models (ADR-0003, E16).
 */
function consoleHost(region: string): string | undefined {
  if (region.startsWith('cn-')) return 'console.amazonaws.cn'
  if (region.startsWith('us-gov-')) return 'console.amazonaws-us-gov.com'
  if (/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) return 'console.aws.amazon.com'
  return undefined
}

/**
 * The EC2 instance-details page for one instance (ADR-0003, E16).
 *
 * The region appears twice on purpose — once in the host, which is what picks the console's
 * regional endpoint, and once in the query, which is what the console itself reads to select
 * the region before resolving the fragment. Dropping either one lands on the last region the
 * browser had selected, showing "instance not found" for an instance that exists.
 */
export function ec2ConsoleUrl(region: string, instanceId: string): string | undefined {
  const host = consoleHost(region)
  if (!host || !instanceId) return undefined
  return `https://${region}.${host}/ec2/home?region=${region}#InstanceDetails:instanceId=${instanceId}`
}

export interface AwsProviderOptions {
  config: AwsProviderConfig
  /** Injected by tests; production builds its own from the config. */
  ec2?: EC2Client
  ssm?: SSMClient
  /** Injected by tests, so the propagation grace costs no wall-clock time. */
  absenceGrace?: { attempts: number; delayMs: number }
  sleep?: (ms: number) => Promise<void>
  /** Injected by tests; production builds a `PriceFeedClient` from the config. */
  priceFeed?: { get(): Promise<PriceFeedDoc | null> }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const tagsToRecord = (tags: Tag[] | undefined): Record<string, string> =>
  Object.fromEntries((tags ?? []).flatMap((t) => (t.Key ? [[t.Key, t.Value ?? '']] : [])))

const recordToTags = (tags: Record<string, string>): Tag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))

export function makeAwsProvider(options: AwsProviderOptions): ComputeProvider {
  const { config } = options
  const region = config.region
  const clientConfig = { region, ...(config.profile ? { profile: config.profile } : {}) }
  const ec2 = options.ec2 ?? new EC2Client(clientConfig)
  const ssm = options.ssm ?? new SSMClient(clientConfig)

  const grace = options.absenceGrace ?? DESCRIBE_ABSENCE_GRACE
  const sleep = options.sleep ?? defaultSleep

  /**
   * Instances this provider has observed running, which is what keeps the propagation grace
   * cheap where it does not matter. An instance seen running and now absent really is gone —
   * believe it immediately. One never seen running might be a create that has not propagated.
   */
  const seenRunning = new Set<string>()

  /** Per-process caches. Everything here is cheap to rebuild and safe to lose. */
  const amiCache = new Map<Architecture, { imageId: string; rootDeviceName: string }>()
  let defaultVpc: { vpcId: string; subnetId: string } | undefined
  let sharedSgId: string | undefined

  async function send<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      throw mapAwsError(err, what)
    }
  }

  const amiParameter = (arch: Architecture) => `${config.amiParameterPrefix}/${arch}/hvm/ebs-gp3/ami-id`

  /**
   * Resolve the AMI, AND its root device name.
   *
   * The device name is not incidental. Sizing the root volume requires naming the device, and
   * naming the wrong one silently attaches a SECOND volume that survives termination — an
   * orphan invisible to any audit that only walks instances (ADR-0003, D4). So it is read off
   * the AMI rather than assumed to be `/dev/sda1`.
   *
   * NOTE FOR THE IAM POLICY (gyp1.2): this needs `ssm:GetParameter` on
   * `arn:aws:ssm:*::parameter/aws/service/*` — the public namespace, with an empty account id.
   */
  async function resolveAmi(arch: Architecture) {
    const cached = amiCache.get(arch)
    if (cached) return cached

    const name = amiParameter(arch)
    const parameter = await send(`ssm:GetParameter ${name}`, () => ssm.send(new GetParameterCommand({ Name: name })))
    const imageId = parameter.Parameter?.Value
    if (!imageId) throw new ProviderError('not_found', `SSM parameter ${name} has no value`)

    const images = await send(`ec2:DescribeImages ${imageId}`, () =>
      ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] })),
    )
    const rootDeviceName = images.Images?.[0]?.RootDeviceName
    if (!rootDeviceName) throw new ProviderError('not_found', `AMI ${imageId} reports no RootDeviceName`)

    const resolved = { imageId, rootDeviceName }
    amiCache.set(arch, resolved)
    return resolved
  }

  async function resolveDefaultVpc() {
    if (defaultVpc) return defaultVpc

    const vpcs = await send('ec2:DescribeVpcs (default)', () =>
      ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'is-default', Values: ['true'] }] })),
    )
    const vpcId = vpcs.Vpcs?.[0]?.VpcId
    if (!vpcId) {
      throw new ProviderError(
        'invalid_spec',
        `no default VPC in ${region}. This provider does not create networking; create a default VPC or use a region that has one.`,
      )
    }

    const subnets = await send('ec2:DescribeSubnets (default-for-az)', () =>
      ec2.send(
        new DescribeSubnetsCommand({
          Filters: [
            { Name: 'vpc-id', Values: [vpcId] },
            { Name: 'default-for-az', Values: ['true'] },
          ],
        }),
      ),
    )
    const subnetId = subnets.Subnets?.[0]?.SubnetId
    if (!subnetId) throw new ProviderError('invalid_spec', `default VPC ${vpcId} has no default subnet`)

    defaultVpc = { vpcId, subnetId }
    return defaultVpc
  }

  async function findSharedSg(vpcId: string): Promise<string | undefined> {
    const found = await send('ec2:DescribeSecurityGroups (shared ssh)', () =>
      ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: 'group-name', Values: [config.securityGroupName] },
            { Name: 'vpc-id', Values: [vpcId] },
          ],
        }),
      ),
    )
    return found.SecurityGroups?.[0]?.GroupId
  }

  /**
   * One shared SSH group per region, created on first provision and reused forever after.
   *
   * Per-server security groups were the other half of the per-server CloudFormation stack;
   * this replaces them. It is `shared` in `listManaged()` for the same reason — a reconciler
   * treating the managed list as a delete-list would otherwise tear it out from under every
   * running instance (ADR-0003, D1).
   *
   * The ingress comes from CONFIGURATION, never from a runtime lookup of the caller's own
   * address. See `config.ts` for why that matters.
   */
  async function ensureSecurityGroup(): Promise<string> {
    const { vpcId } = await resolveDefaultVpc()

    if (!sharedSgId) sharedSgId = await findSharedSg(vpcId)

    if (!sharedSgId) {
      try {
        const created = await ec2.send(
          new CreateSecurityGroupCommand({
            GroupName: config.securityGroupName,
            Description: 'rockysurf: SSH to managed dev boxes. Shared across servers; safe to reuse.',
            VpcId: vpcId,
            TagSpecifications: [
              {
                ResourceType: 'security-group',
                Tags: recordToTags({ [MANAGED_BY_TAG]: config.managedBy, Name: config.securityGroupName }),
              },
            ],
          }),
        )
        sharedSgId = created.GroupId
      } catch (err) {
        // Two concurrent provisions race here; the loser adopts the winner's group.
        if (awsErrorCode(err) !== 'InvalidGroup.Duplicate') throw mapAwsError(err, 'ec2:CreateSecurityGroup')
        sharedSgId = await findSharedSg(vpcId)
      }
    }
    if (!sharedSgId) throw new ProviderError('unknown', `could not create or find ${config.securityGroupName}`)

    // Every configured CIDR, every provision. This used to sit behind an `ingressEnsured` latch
    // that was set for the LIFETIME OF THE PROCESS, which meant a `sshAllowedCidr` corrected on
    // the Settings page did not reach EC2 even on the next launch — only after a restart. The
    // call is idempotent and a duplicate is the success case, so the latch bought one skipped
    // API call per boot and cost the operator the fix they had just made (issue #304).
    //
    // Provision is ADDITIVE and stays that way: it never revokes. Widening access is a safe thing
    // to do while someone is waiting for a box to come up; narrowing it is not, and belongs to
    // the explicit, itemized `syncSshAccess()` path where the operator has asked for it.
    await authorizeSshRanges(sharedSgId, resolveSshCidrs(config))

    return sharedSgId
  }

  /**
   * Authorize each CIDR, treating "already there" as success.
   *
   * One call per range rather than one call carrying all of them: EC2 rejects the WHOLE request
   * with `InvalidPermission.Duplicate` if any single range in it is already authorized, so a
   * batch would mean one pre-existing entry silently prevented every new one from landing.
   */
  async function authorizeSshRanges(groupId: string, cidrs: readonly string[]): Promise<string[]> {
    const authorized: string[] = []
    for (const cidr of cidrs) {
      try {
        await ec2.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: groupId,
            IpPermissions: [
              {
                IpProtocol: 'tcp',
                FromPort: 22,
                ToPort: 22,
                IpRanges: [{ CidrIp: cidr, Description: SSH_RULE_DESCRIPTION }],
              },
            ],
          }),
        )
        authorized.push(cidr)
      } catch (err) {
        // Already authorized — by a previous boot, another process, or the operator — is success.
        // Note this also means a hand-added range KEEPS the operator's own description rather
        // than acquiring ours, which is why `syncSshAccess()` can still tell the two apart.
        if (awsErrorCode(err) === 'InvalidPermission.Duplicate') continue

        // The full-group case, named rather than left generic (issue #320). A shared group has a
        // hard ceiling of 60 inbound rules, and the way it fills up in practice is stale one-off
        // /32s that nothing ever removed — the nightly CI runner's fresh public IP every night was
        // the discovered offender. `mapAwsError` would land this on the right `quota` code but with
        // EC2's own opaque wording; a self-hoster whose Settings save "silently failed to reach
        // AWS" is better served by an error that says which group is full and what the ceiling is.
        if (awsErrorCode(err) === 'RulesPerSecurityGroupLimitExceeded') {
          throw new ProviderError(
            'quota',
            `${config.securityGroupName} (${groupId}) is at AWS's limit of 60 inbound rules, so ` +
              `${cidr} could not be authorized. Stale one-off rules stamped '${SSH_RULE_DESCRIPTION}' ` +
              'from earlier runs are the usual cause — remove the ones no longer in use and try ' +
              'again. This does not touch any rule the operator added by hand.',
            { providerCode: 'RulesPerSecurityGroupLimitExceeded', cause: err },
          )
        }

        throw mapAwsError(err, 'ec2:AuthorizeSecurityGroupIngress')
      }
    }
    return authorized
  }

  /** Every port-22 IPv4 range currently on the shared group, with whatever description it carries. */
  async function describeSshRanges(groupId: string): Promise<Map<string, string | undefined>> {
    const described = await send('ec2:DescribeSecurityGroups', () =>
      ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] })),
    )
    const ranges = new Map<string, string | undefined>()
    for (const permission of described.SecurityGroups?.[0]?.IpPermissions ?? []) {
      if (permission.IpProtocol !== 'tcp' || permission.FromPort !== 22 || permission.ToPort !== 22) continue
      for (const range of permission.IpRanges ?? []) {
        if (range.CidrIp) ranges.set(range.CidrIp, range.Description)
      }
    }
    return ranges
  }

  function viewOf(instance: Instance): InstanceView {
    const raw = instance.State?.Name ?? ''
    const state = STATE_MAP[raw] ?? 'unknown'
    if (state === 'running' && instance.InstanceId) seenRunning.add(instance.InstanceId)
    const consoleUrl = instance.InstanceId ? ec2ConsoleUrl(region, instance.InstanceId) : undefined
    return {
      state,
      ...(instance.PublicIpAddress ? { publicIp: instance.PublicIpAddress } : {}),
      ...(instance.PublicDnsName ? { publicDns: instance.PublicDnsName } : {}),
      ...(instance.InstanceType ? { offeringId: instance.InstanceType } : {}),
      // Available from the RunInstances response onward, so the link works while the box is
      // still booting — which is exactly when somebody wants to look at it (E16).
      ...(consoleUrl ? { consoleUrl } : {}),
      // EC2 has no `failed` instance state; a launch that fails fails at RunInstances, and a
      // running instance that breaks stays `running` as far as EC2 is concerned. So
      // `failureReason` is only ever set from a StateReason on an unexpected state.
      ...(state === 'unknown' && instance.StateReason?.Message
        ? { failureReason: instance.StateReason.Message }
        : {}),
    }
  }

  const priceFeed = options.priceFeed ?? new PriceFeedClient(config.pricesUrl, config.pricesRefreshHours)
  const offerings = async () => buildOfferings(region, config.rootVolumeGb, await priceFeed.get())

  const provider: ComputeProvider = {
    id: 'aws',
    displayName: 'Amazon EC2',
    capabilities: CAPABILITIES,

    async validateCredentials() {
      // The cheapest authenticated EC2 call there is; also proves the region is reachable.
      await send('ec2:DescribeAccountAttributes', () =>
        ec2.send(new DescribeAccountAttributesCommand({ AttributeNames: ['supported-platforms'] })),
      )
    },

    async validateSpec(spec: ProvisionSpec) {
      const offering = (await offerings()).find((o) => o.id === spec.offeringId)
      if (!offering) {
        throw new ProviderError('invalid_spec', `no such offering: ${spec.offeringId}`)
      }
      if (offering.arch !== spec.arch) {
        throw new ProviderError(
          'invalid_spec',
          `arch ${spec.arch} does not match offering ${offering.id} (${offering.arch})`,
        )
      }
      if (spec.sshPublicKeys.length === 0) {
        throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
      }
      if (!spec.idempotencyKey) {
        throw new ProviderError('invalid_spec', 'idempotencyKey is required — it becomes the EC2 ClientToken')
      }

      const bytes = Buffer.byteLength(spec.userData, 'utf8')
      if (bytes > CAPABILITIES.userDataMaxBytes) {
        throw new ProviderError(
          'invalid_spec',
          `userData is ${bytes}B against EC2's ${CAPABILITIES.userDataMaxBytes}B ceiling. ` +
            'Move work out of user-data rather than raising the limit.',
        )
      }

      // Amendment D3. Without this an instance can be created that `listManaged()` will never
      // see, which makes it an orphan from birth — invisible to every audit built on the tag.
      const managedBy = spec.tags[MANAGED_BY_TAG]
      if (managedBy !== undefined && managedBy !== config.managedBy) {
        throw new ProviderError(
          'invalid_spec',
          `tags['${MANAGED_BY_TAG}'] is '${managedBy}' but this provider reconciles '${config.managedBy}'`,
        )
      }
    },

    async listOfferings(): Promise<Offering[]> {
      return offerings()
    },

    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      await provider.validateSpec(spec)

      const [{ imageId, rootDeviceName }, { subnetId }] = await Promise.all([
        resolveAmi(spec.arch),
        resolveDefaultVpc(),
      ])
      const securityGroupId = await ensureSecurityGroup()

      const tags = recordToTags({
        ...spec.tags,
        [MANAGED_BY_TAG]: config.managedBy,
        [SERVER_ID_TAG]: spec.serverId,
        Name: `${config.managedBy}-${spec.serverId}`,
      })

      const run = await send('ec2:RunInstances', () =>
        ec2.send(
          new RunInstancesCommand({
            // The whole idempotency story: EC2 dedupes on this for 24 hours, so a replay
            // returns the ORIGINAL instance instead of launching a second one, and a replay
            // with different parameters is refused as IdempotentParameterMismatch.
            ClientToken: spec.idempotencyKey,
            ImageId: imageId,
            // `Offering.id` is a provider-native string by design (ADR-0003, B3), while the
            // SDK types InstanceType as a generated closed union a new family only joins on
            // the next release. The cast is the honest move; validateSpec above is the check
            // that actually matters.
            InstanceType: spec.offeringId as _InstanceType,
            MinCount: 1,
            MaxCount: 1,
            UserData: Buffer.from(spec.userData, 'utf8').toString('base64'),
            // No KeyName: SSH keys ride in the cloud-config, so there is no EC2 key pair to
            // create, tag, reap or leak.
            //
            // Asking for a public IP forces the NetworkInterfaces form, and EC2 then REFUSES
            // top-level SubnetId/SecurityGroupIds as a conflicting parameter combination —
            // both must move inside.
            NetworkInterfaces: [
              {
                DeviceIndex: 0,
                AssociatePublicIpAddress: true,
                DeleteOnTermination: true,
                SubnetId: subnetId,
                Groups: [securityGroupId],
              },
            ],
            BlockDeviceMappings: [
              {
                DeviceName: rootDeviceName,
                Ebs: { VolumeSize: config.rootVolumeGb, VolumeType: 'gp3', DeleteOnTermination: true },
              },
            ],
            MetadataOptions: {
              HttpEndpoint: 'enabled',
              // IMDSv2 only, one hop. These boxes run agent-authored code: a hop limit above
              // 1 lets a container on the box reach the instance metadata service, and
              // IMDSv1 lets anything that can forge a GET read it.
              HttpTokens: 'required',
              HttpPutResponseHopLimit: 1,
            },
            // Volumes and the launch-created network interface carry the same tags, so a leaked
            // one is still attributable and the zero-orphan audit can find it by tag rather than
            // by walking instances.
            //
            // THE ENI IS HERE FOR A SECOND REASON (rockysurf-b14y), and it is the one that shows
            // up in the published policy. `aws:RequestTag/managed-by` does not exist for a
            // resource the request does not tag, so a tag-conditioned statement matches nothing
            // and `network-interface/*` had to sit in the UNCONDITIONED RunInstances statement —
            // found the hard way by the gyp1.5 restricted-principal run, where every launch
            // failed with UnauthorizedOperation until that ARN was moved out. Tagging it here
            // lets the ARN move back under the condition, which is strictly tighter.
            //
            // RunInstances tags exactly four resource types — instances, volumes, spot instance
            // requests and network interfaces (EC2 API reference, RunInstances § TagSpecification.N,
            // checked 2026-08-15) — so this is the whole of what a launch can attribute.
            TagSpecifications: [
              { ResourceType: 'instance', Tags: tags },
              { ResourceType: 'volume', Tags: tags },
              { ResourceType: 'network-interface', Tags: tags },
            ],
          }),
        ),
      )

      const instance = run.Instances?.[0]
      if (!instance?.InstanceId) throw new ProviderError('unknown', 'RunInstances returned no instance id')

      // A6: hand back what the create call already knows, so core does not immediately call
      // describe() — a round trip that on EC2 lands straight in the eventual-consistency
      // window that amendment A4 exists to survive.
      return { data: { instanceId: instance.InstanceId, region }, initial: viewOf(instance) }
    },

    /**
     * Read one instance's state.
     *
     * ABSENCE IS NOT PROOF OF TERMINATION, AND THE RETRY LIVES HERE. This provider is the
     * reason that rule is in the SDK: in `spike/verify-aws.run1.log`, a `describe()` 0.1
     * seconds after a SUCCESSFUL launch returned not-found, because DescribeInstances is
     * eventually consistent. Read literally, "not found means terminated" marks a healthy,
     * booting, BILLING instance dead — and core then never terminates it, because terminating
     * an already-terminated row is a no-op. A live instance nobody can see and nobody stops.
     *
     * This method used to delegate the grace to core, on the belief that core's lifecycle
     * applied `DESCRIBE_ABSENCE_GRACE` around `describe()`. IT DOES NOT — the grace is the
     * PROVIDER's, which is how `provider-hetzner` and core's own fake have always implemented
     * it, and the fake implementing it is why every test passed while the real thing lost
     * boxes. The gyp1.4 exit run caught it on the second AWS launch of the night: core said
     * `terminated` 100ms after create while EC2 said `running`.
     */
    async describe(data: ProviderData): Promise<InstanceView> {
      const instanceId = String(data['instanceId'] ?? '')
      // An instance already seen running gets no grace: its absence is a real termination,
      // and waiting eight seconds to confirm a teardown core polls in a loop is pure delay.
      const attempts = seenRunning.has(instanceId) ? 1 : Math.max(1, grace.attempts)

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
          const instance = res.Reservations?.[0]?.Instances?.[0]
          // A reaped instance drops out of DescribeInstances entirely, about an hour after
          // termination, without erroring — so an empty result means the same as NotFound.
          if (instance) return viewOf(instance)
          if (attempt < attempts) {
            await sleep(grace.delayMs)
            continue
          }
          return { state: 'terminated' }
        } catch (err) {
          if (!isNotFound(err)) throw mapAwsError(err, `ec2:DescribeInstances ${instanceId}`)
          if (attempt < attempts) {
            await sleep(grace.delayMs)
            continue
          }
          // Absence, believed. A vanished instance is a normal teardown outcome, never an
          // error: core polls this in a loop and throwing would make success an error path.
          return { state: 'terminated' }
        }
      }

      return { state: 'terminated' }
    },

    async terminate(data: ProviderData): Promise<void> {
      const instanceId = String(data['instanceId'] ?? '')
      try {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
      } catch (err) {
        if (isNotFound(err)) return // idempotent: not-found is success
        throw mapAwsError(err, `ec2:TerminateInstances ${instanceId}`)
      }
    },

    async listManaged(): Promise<ManagedResource[]> {
      const resources: ManagedResource[] = []

      let nextToken: string | undefined
      do {
        const page = await send('ec2:DescribeInstances (managed)', () =>
          ec2.send(
            new DescribeInstancesCommand({
              Filters: [{ Name: `tag:${MANAGED_BY_TAG}`, Values: [config.managedBy] }],
              ...(nextToken ? { NextToken: nextToken } : {}),
            }),
          ),
        )
        for (const reservation of page.Reservations ?? []) {
          for (const instance of reservation.Instances ?? []) {
            if (!instance.InstanceId) continue
            // `terminating` instances STAY in this list: they still exist and still hold
            // their volume, so the reconciler must see them. Only `terminated` is gone. This
            // is the transitional workaround from D5 retired by A3 landing.
            if ((STATE_MAP[instance.State?.Name ?? ''] ?? 'unknown') === 'terminated') continue
            const tags = tagsToRecord(instance.Tags)
            resources.push({
              kind: 'instance',
              providerNativeId: instance.InstanceId,
              ownership: 'server-owned',
              ...(tags[SERVER_ID_TAG] ? { serverId: tags[SERVER_ID_TAG] } : {}),
            })
          }
        }
        nextToken = page.NextToken
      } while (nextToken)

      // The shared SSH group. Reported so an audit can account for it, NOT so a reconciler
      // can reap it — deleting this breaks every running instance that uses it.
      const groups = await send('ec2:DescribeSecurityGroups (managed)', () =>
        ec2.send(
          new DescribeSecurityGroupsCommand({
            Filters: [{ Name: `tag:${MANAGED_BY_TAG}`, Values: [config.managedBy] }],
          }),
        ),
      )
      for (const group of groups.SecurityGroups ?? []) {
        if (!group.GroupId) continue
        resources.push({ kind: 'security-group', providerNativeId: group.GroupId, ownership: 'shared' })
      }

      return resources
    },

    async stop(data: ProviderData): Promise<void> {
      if (!CAPABILITIES.stop) throw unsupportedOperationError('aws', 'stop')
      const instanceId = String(data['instanceId'] ?? '')
      await send(`ec2:StopInstances ${instanceId}`, () =>
        ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] })),
      )
    },

    async start(data: ProviderData): Promise<void> {
      if (!CAPABILITIES.stop) throw unsupportedOperationError('aws', 'start')
      const instanceId = String(data['instanceId'] ?? '')
      await send(`ec2:StartInstances ${instanceId}`, () =>
        ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] })),
      )
    },

    /**
     * Bring the shared group in line with `sshAllowedCidr`, without provisioning anything.
     *
     * The call issue #304 exists for. Before it, the only thing that ever wrote this operator's
     * CIDR to EC2 was a launch, so "I moved house" was fixed by starting a box nobody wanted.
     *
     * Authorize-before-revoke is deliberate and load-bearing: if the second half fails the
     * operator is left with MORE access than they started with, never less. A sync that died
     * halfway through the other order could lock them out of every box in the account.
     */
    async syncSshAccess(): Promise<SshAccessSyncResult> {
      const desired = resolveSshCidrs(config)
      const { vpcId } = await resolveDefaultVpc()
      const groupId = sharedSgId ?? (await findSharedSg(vpcId))

      if (!groupId) {
        return {
          status: 'skipped',
          applied: [],
          reported: [],
          detail:
            `No ${config.securityGroupName} security group exists in ${region} yet, so there is ` +
            'nothing to update. Rocky Surf creates it at the first launch, with these CIDRs ' +
            'already in it.',
        }
      }
      sharedSgId = groupId

      const actual = await describeSshRanges(groupId)
      const missing = desired.filter((cidr) => !actual.has(cidr))
      const authorized = await authorizeSshRanges(groupId, missing)

      // Anything on the group the config no longer names, split by who authorized it.
      const extra = [...actual.entries()].filter(([cidr]) => !desired.includes(cidr))
      const ours = extra.filter(([, description]) => description === SSH_RULE_DESCRIPTION).map(([cidr]) => cidr)
      const theirs = extra.filter(([, description]) => description !== SSH_RULE_DESCRIPTION).map(([cidr]) => cidr)

      const notes: string[] = []
      if (ours.length > 0) {
        notes.push(
          `${ours.length} range(s) Rocky Surf authorized earlier are still on ` +
            `${config.securityGroupName} and are no longer in your list: ${ours.join(', ')}. ` +
            'They have been left alone — keep them by adding them back to sshAllowedCidr, or ' +
            'remove them deliberately.',
        )
      }
      if (theirs.length > 0) {
        notes.push(
          `${theirs.join(', ')} is still authorized on ${config.securityGroupName}. Rocky Surf ` +
            'did not create that rule and will not remove it. To remove it yourself, run: ' +
            `aws ec2 revoke-security-group-ingress --group-id ${groupId} --protocol tcp ` +
            `--port 22 --cidr ${theirs[0] ?? ''} --region ${region}`,
        )
      }

      return {
        status: authorized.length > 0 ? 'updated' : 'unchanged',
        applied: desired,
        reported: [...ours, ...theirs],
        detail:
          (authorized.length > 0
            ? `Authorized ${authorized.join(', ')} on ${config.securityGroupName}.`
            : `${config.securityGroupName} already allowed ${desired.join(', ')}.`) +
          (notes.length > 0 ? ' ' + notes.join(' ') : ''),
      }
    },
  }

  return provider
}
