# `@rockysurf/provider-aws`

Runs Rocky Surf dev boxes as EC2 instances in your own AWS account. It calls `RunInstances`
directly — **no CloudFormation** — so there is no stack to drift, no template to reconcile, and
nothing left behind that Rocky Surf's own reaper cannot see. It creates instances, one shared SSH
security group per region, and nothing else.

- [How you get it](#how-you-get-it)
- [Configuration](#configuration)
- [Credentials](#credentials)
- [What it needs in your account](#what-it-needs-in-your-account)
- [Capabilities](#capabilities)
- [Prices](#prices)
- [Verified](#verified)
- [Writing your own provider](#writing-your-own-provider)

## How you get it

It is already there. The `rockysurf` CLI depends on this package, so `npx rockysurf` can reach
AWS as soon as you switch it on. Providers are constructed at boot, so a configuration change
takes effect at the next restart.

Install it directly only if you are embedding Rocky Surf's provider in something of your own:

```bash
pnpm add @rockysurf/provider-aws
```

```ts
import aws from '@rockysurf/provider-aws'

const config = aws.configSchema.parse({ region: 'us-east-1', sshAllowedCidr: '203.0.113.7/32' })
const provider = aws.createProvider(config)
```

`createProvider` is synchronous and does no I/O, so a caller can load the provider, show its
identity and validate its configuration before it holds anything live. Credentials are proven
separately, by `validateCredentials()`.

## Configuration

```yaml
providers:
  aws:
    enabled: true
    region: us-east-1
    sshAllowedCidr: "203.0.113.7/32"   # required — see below
    profile: my-profile                # optional; omit to use the default credential chain
```

| field | default | what it does |
|---|---|---|
| `region` | `us-east-1` | the one region this provider manages. Two regions means two providers; `listManaged()` is scoped at construction |
| `sshAllowedCidr` | none — **required** | which network may reach SSH on your boxes |
| `allowAllCidr` | `false` | the second signature `0.0.0.0/0` needs |
| `profile` | none | named profile from your shared credentials file |
| `managedBy` | `rockysurf` | value of the `managed-by` tag this provider owns. `listManaged()` filters on it and `validateSpec()` refuses a spec that disagrees |
| `securityGroupName` | `rockysurf-ssh` | the shared SSH group, one per region, reused by every server |
| `rootVolumeGb` | `20` | root volume size in GiB, 8 to 16384 |
| `amiParameterPrefix` | `/aws/service/canonical/ubuntu/server/24.04/stable/current` | SSM public parameter path for the base image, with `{arch}` substituted |

**`sshAllowedCidr` has no default, and that is the security decision of the package.** Enabling
`aws` without it means the provider refuses its own section and is dropped at startup; the app
still comes up, says why on the New Server page, and names it in the boot log. Opening SSH to the
whole internet takes two lines rather than one typo:

```yaml
    sshAllowedCidr: "0.0.0.0/0"
    allowAllCidr: true
```

These boxes run agent-authored code and hold a git token, so a `/0` that arrives by accident is
the difference between a dev box and an incident.

## Credentials

The **standard AWS credential chain**, in the SDK's usual order. There is nowhere in
`rockysurf.config.yaml` to paste an access key, and nothing asks you for one.

```bash
aws sso login --profile my-profile          # SSO / IAM Identity Center
export AWS_PROFILE=my-profile               # a named profile
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
# or nothing at all, if you run core on an EC2 instance with an instance role
```

If `aws sts get-caller-identity` works in your shell, this provider authenticates the same way.

## What it needs in your account

A policy covering the EC2 and SSM calls the provider makes, and nothing wider.
[`docs/providers/aws.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/aws.md)
carries the JSON, statement by statement, with the reason for each.
[`deploy/aws/iam-role.yaml`](https://github.com/amroja-biz/rockysurf/blob/main/deploy/aws/iam-role.yaml)
deploys it as a role.

Two things keep that document honest rather than aspirational. `scripts/check-iam-policy.mjs`
asserts the published policy still covers every API call the source makes, so a new call with no
matching action fails lint instead of failing in a stranger's account. The nightly real-cloud job
then runs the full lifecycle under a principal holding exactly that policy.

The region also needs a **default VPC** with a default subnet, which is what an account comes
with unless someone removed it. This provider does not create networking: without one it refuses
the launch and says so. It does create the shared SSH security group on first launch if it is
absent.

## Capabilities

| capability | value | what it means for you |
|---|---|---|
| `stop` | `true` | a box can be stopped and restarted with its disk intact |
| `ipStableAcrossStop` | `false` | a restarted instance gets a **new public IPv4**. Rocky Surf re-reads the address and tells you your SSH config is stale. No Elastic IP is allocated: it would be one more per-server resource to create, tag and reap |
| `canInjectHostKeys` | `true` | core mints the host key before the box exists and ships it in `#cloud-config`, then verifies it on the first connection — the one carrying your secrets file. There is no trust-on-first-use window |
| `userDataMaxBytes` | `16384` | EC2's hard limit, measured on the raw bytes before base64. Push-mode documents run about 2.1KB, so the ceiling is not a live constraint |
| `generatesUserData` | `true` | cloud-init does the pre-boot work |

Instances also report a `consoleUrl`, so a server links to its EC2 page from the moment
`RunInstances` returns. Nothing extra needs configuring for that: region plus instance id is the
whole URL.

Evidence for each value is in
[`docs/providers/capability-matrix.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/capability-matrix.md).

## Prices

**Bundled, not live.** AWS publishes its price list through a separate service, so reading it at
runtime would add a dependency for a number that changes a few times a year. The table ships with
14 burstable types (`t3.*` amd64, `t4g.*` arm64) priced in **USD for `us-east-1` only**, stamped
with the time it was read and the time AWS published it. Everywhere else `hourly` is `null`, which
the SDK defines as *unknown, never free* rather than zero.

The table is generated from the same public feed the EC2 on-demand pricing page renders — no
credentials, no account, no SDK — so nothing in it was rounded by hand:

```bash
node scripts/refresh-prices.mjs            # AWS is the default; --check asserts it is current
```

## Verified

**A full lifecycle on real EC2, on 2026-08-12, under a principal holding the published IAM policy
and nothing else.** Create, bootstrap, SSH, stop, start and terminate ran on both architectures —
`t4g.small`/arm64 in 333s and `t3.small`/amd64 in 255s, us-east-1 — each ending in a zero-orphan
audit. That run found a real bug in the published policy, which is why it was worth doing.

**It is re-run nightly**, at 07:00 UTC, by
[`.github/workflows/nightly-real-cloud.yml`](https://github.com/amroja-biz/rockysurf/blob/main/.github/workflows/nightly-real-cloud.yml),
under credentials that chain into the role deployed from `deploy/aws/iam-role.yaml`; the job
asserts that identity is in force before it launches anything. A provider call the published
policy does not cover fails the nightly the first morning after it lands.

Two limits worth stating. The nightly exercises what the lifecycle exercises, so a code path no
end-to-end run reaches is still unproven. And an account that has run Rocky Surf before already
owns the shared security group, so `CreateSecurityGroup` and `AuthorizeSecurityGroupIngress` —
the two calls a *first* launch makes — are covered by EC2 dry-run probes rather than by the
nightly.

## Writing your own provider

This package is one implementation of a frozen contract. To write another, start with
[`@rockysurf/provider-sdk`](https://github.com/amroja-biz/rockysurf/blob/main/packages/provider-sdk/README.md)
for the types and
[`docs/writing-a-provider.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/writing-a-provider.md)
for the workflow.

One local detail if you are auditing dependencies: this is the only package in the workspace that
pulls in `@aws-sdk/*`, and `scripts/check-npx-closure.mjs` enforces that every AWS SDK package in
the shipped CLI closure arrives through this one. Dropping this provider drops all of them.
