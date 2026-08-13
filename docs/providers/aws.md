# Running Rocky Surf on AWS

What you need to give Rocky Surf so it can create, stop, start and destroy EC2 dev boxes in
your own account — and nothing beyond that.

- [Credentials](#credentials)
- [The IAM policy](#the-iam-policy)
- [Deploying the role](#deploying-the-role)
- [What each statement is for](#what-each-statement-is-for)
- [Who can reach SSH](#who-can-reach-ssh)
- [Testing the policy](#testing-the-policy)
- [What is deliberately absent](#what-is-deliberately-absent)

---

## Credentials

Rocky Surf uses the **standard AWS credential chain**. It never asks you to paste an access key
into its config file, and there is nowhere in `rockysurf.config.yaml` to put one.

That means any of these work, in the SDK's normal order of preference:

```bash
# an SSO / IAM Identity Center session
aws sso login --profile my-profile

# a named profile from ~/.aws/credentials
export AWS_PROFILE=my-profile

# plain environment variables
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...

# or nothing at all, if you run core on an EC2 instance with an instance role
```

Point the provider at a profile in your config if you use more than one:

```yaml
providers:
  aws:
    enabled: true
    region: us-east-1
    profile: my-profile          # optional; omit to use the default chain
    sshAllowedCidr: 203.0.113.7/32
```

**Credentials live where your other AWS tooling keeps them.** If `aws sts get-caller-identity`
works in your shell, Rocky Surf will authenticate the same way.

---

## The IAM policy

Create a policy from the JSON below, attach it to the user or role Rocky Surf runs as, and
replace the two placeholders:

- `REGION` — the region in your config, e.g. `us-east-1`
- `ACCOUNT_ID` — your 12-digit AWS account id

If you changed `managedBy` in your config (it defaults to `rockysurf`), replace `rockysurf` in
the tag conditions to match.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadOnlyDiscovery",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeAccountAttributes",
        "ec2:DescribeInstances",
        "ec2:DescribeImages",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ResolveUbuntuAmiFromPublicSsm",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:*::parameter/aws/service/canonical/*"
    },
    {
      "Sid": "LaunchTaggedInstances",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": [
        "arn:aws:ec2:REGION:ACCOUNT_ID:instance/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:volume/*"
      ],
      "Condition": {
        "StringEquals": { "aws:RequestTag/managed-by": "rockysurf" }
      }
    },
    {
      "Sid": "LaunchUsingExistingNetworkAndImage",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": [
        "arn:aws:ec2:REGION::image/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:subnet/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:security-group/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:network-interface/*"
      ]
    },
    {
      "Sid": "TagOnCreate",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": [
        "arn:aws:ec2:REGION:ACCOUNT_ID:instance/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:volume/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:security-group/*"
      ],
      "Condition": {
        "StringEquals": {
          "ec2:CreateAction": ["RunInstances", "CreateSecurityGroup"]
        }
      }
    },
    {
      "Sid": "ManageOwnInstancesOnly",
      "Effect": "Allow",
      "Action": ["ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances"],
      "Resource": "arn:aws:ec2:REGION:ACCOUNT_ID:instance/*",
      "Condition": {
        "StringEquals": { "ec2:ResourceTag/managed-by": "rockysurf" }
      }
    },
    {
      "Sid": "CreateTheSharedSshGroup",
      "Effect": "Allow",
      "Action": "ec2:CreateSecurityGroup",
      "Resource": [
        "arn:aws:ec2:REGION:ACCOUNT_ID:security-group/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:vpc/*"
      ]
    },
    {
      "Sid": "AuthorizeSshOnOwnGroupOnly",
      "Effect": "Allow",
      "Action": "ec2:AuthorizeSecurityGroupIngress",
      "Resource": "arn:aws:ec2:REGION:ACCOUNT_ID:security-group/*",
      "Condition": {
        "StringEquals": { "ec2:ResourceTag/managed-by": "rockysurf" }
      }
    }
  ]
}
```

> **Status: verified under a restricted principal on 2026-08-12.** Both halves — the list of
> actions and the scoping of every ARN and condition — have been run, not just reasoned about.
>
> The verification deployed [`deploy/aws/iam-role.yaml`](../../deploy/aws/iam-role.yaml) into a
> real account, assumed the role it creates — a principal holding **exactly** this policy and
> nothing else — and ran the full create → bootstrap → SSH → stop → start → terminate lifecycle
> under those credentials on both architectures (`t4g.small`/arm64 in 333s and `t3.small`/amd64
> in 255s, us-east-1), each ending in a zero-orphan audit. `CreateSecurityGroup` and
> `AuthorizeSecurityGroupIngress` were covered by EC2 dry-run probes, because an account that has
> run Rocky Surf before already has the shared group and so never calls them — and those are
> exactly the two calls a *first* launch makes.
>
> **That run found a bug in this policy, which is the entire reason it was worth doing.**
> `network-interface/*` sat in the tag-conditioned statement, where it can never match; every
> first launch under the previously published version failed with `UnauthorizedOperation`. See
> [the note below](#three-things-that-trip-people-up). What is printed above is the corrected
> policy, and it is the one that passed.
>
> **The verification is continuous, not dated.** A policy proved once is a policy that was true
> once: add an API call to the provider and this document silently becomes wrong, every
> self-hoster's next launch fails with `UnauthorizedOperation`, and CI stays green. So the
> nightly real-cloud job runs the same lifecycle under this same policy — its AWS credentials
> chain into the role deployed from `deploy/aws/iam-role.yaml`, and it asserts that is the
> identity actually in force before it launches anything. A provider call this document does not
> cover fails the nightly the first morning after it lands (`rockysurf-evo1`;
> `.github/workflows/nightly-real-cloud.yml` carries the setup, and the assertion is what stops
> a wider role being substituted).
>
> One part of that run deliberately does *not* use this policy: the zero-orphan audit reads
> volumes with `ec2:DescribeVolumes`, which the provider never calls and this document therefore
> never grants. The audit runs as a separate, stronger principal instead, and the run refuses to
> start if it cannot prove the two are different identities — an orphan the credentials under test
> cannot see would be an orphan the audit reports as clean. If a future nightly fails there, the
> fix is that principal's credentials, never adding `ec2:DescribeVolumes` to what is published
> above (`rockysurf-ufwn`).
>
> Two limits worth stating. The nightly exercises what the lifecycle exercises, so a code path
> no end-to-end run reaches is still unproven. And an account that has run Rocky Surf before
> already owns the shared security group, so `CreateSecurityGroup` and
> `AuthorizeSecurityGroupIngress` — the two calls a *first* launch makes — stay covered by
> dry-run probes rather than by the nightly. If you hit an `UnauthorizedOperation`, the error
> names the action it wanted, and we would like to hear about it.

---

## Deploying the role

You do not have to transcribe that JSON. It ships as CloudFormation —
[`deploy/aws/iam-role.yaml`](../../deploy/aws/iam-role.yaml) — which creates one IAM role
carrying exactly the policy above and nothing else.

```bash
aws cloudformation deploy \
  --template-file deploy/aws/iam-role.yaml \
  --stack-name rocky-surf-iam-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      TrustedPrincipalArn=arn:aws:iam::ACCOUNT_ID:user/you \
      ProviderRegion=us-east-1 \
  --profile my-profile
```

| Parameter | Default | What it is |
|---|---|---|
| `TrustedPrincipalArn` | **none — required** | Who may assume the role. An IAM user ARN, a role ARN (including an Identity Center permission set), or your account root to delegate the decision to your own policies. |
| `ProviderRegion` | `us-east-1` | The region in your config. Every resource-scoped statement is pinned to it. IAM is global, so the stack itself can be deployed in any region — this parameter is what the policy grants against. |
| `ManagedByTag` | `rockysurf` | Must match `managedBy` in your config. A mismatch means Rocky Surf can create instances it is then not allowed to stop or terminate. |
| `SsmParameterArn` | Canonical's namespace | Widen it if you change `amiParameterPrefix`. |
| `RoleName` | `rocky-surf-provider` | IAM role names are global per account, so a second Rocky Surf against the same account needs a second name. |

Point Rocky Surf at the role the way you point any AWS tool at one — a profile that assumes it:

```ini
# ~/.aws/config
[profile rockysurf]
role_arn = arn:aws:iam::ACCOUNT_ID:role/rocky-surf-provider
source_profile = my-profile
region = us-east-1
```

```yaml
providers:
  aws:
    profile: rockysurf
```

**The role is optional.** Rocky Surf uses the standard credential chain, so attaching the same
policy to an IAM user works identically. The role exists because assuming a scoped role is the
least-privilege way to run it — and because a role is the only form the verification below can
assume.

**The template and the JSON above cannot drift apart.** `node scripts/check-iam-policy.mjs` runs
in `pnpm run lint` and compares them statement by statement, resolving the template's parameters
to the doc's placeholders. Change one without the other and CI fails, naming the statement that
differs. Two copies of a security boundary are otherwise exactly the situation in which the
published policy quietly stops being the policy anyone has tested.

---

## What each statement is for

The provider makes **thirteen** distinct API calls. Here is every one of them and why.

| Call | Statement | Why it is needed |
|---|---|---|
| `ec2:DescribeAccountAttributes` | ReadOnlyDiscovery | The cheapest authenticated call there is. `validateCredentials()` uses it to prove your credentials and region work before anything is created. |
| `ec2:DescribeInstances` | ReadOnlyDiscovery | Reading a server's state, and listing everything tagged `managed-by` for the reconciler. |
| `ec2:DescribeImages` | ReadOnlyDiscovery | Reading the AMI's **root device name**. See the note below — this is not optional. |
| `ec2:DescribeVpcs`, `ec2:DescribeSubnets` | ReadOnlyDiscovery | Finding your default VPC and a default subnet. Rocky Surf does not create networking. |
| `ec2:DescribeSecurityGroups` | ReadOnlyDiscovery | Finding the shared SSH group, and reporting it to the reconciler. |
| `ssm:GetParameter` | ResolveUbuntuAmiFromPublicSsm | Resolving the current Ubuntu 24.04 AMI for the requested architecture. |
| `ec2:RunInstances` | LaunchTaggedInstances + LaunchUsingExistingNetworkAndImage | Creating the box. Split into two statements — see below. |
| `ec2:CreateTags` | TagOnCreate | Required even though the provider never calls it directly. See below. |
| `ec2:TerminateInstances`, `ec2:StopInstances`, `ec2:StartInstances` | ManageOwnInstancesOnly | Destroying and power-cycling boxes Rocky Surf created. |
| `ec2:CreateSecurityGroup` | CreateTheSharedSshGroup | Creating the one shared SSH group, on first launch only. |
| `ec2:AuthorizeSecurityGroupIngress` | AuthorizeSshOnOwnGroupOnly | Adding the SSH rule to that group. |

### Three things that trip people up

**`ec2:CreateTags` is required even though Rocky Surf never calls `CreateTags`.** Tags are
applied through `TagSpecifications` on the create call itself, which is the safe way to do it —
there is no window where an untagged instance exists. But AWS still evaluates it as a
`CreateTags` permission. Without this statement, `RunInstances` fails with
`UnauthorizedOperation` and a message about tags, which is a confusing way to learn this. The
`ec2:CreateAction` condition keeps the grant to tagging-at-creation; it does not let anything
re-tag an existing resource.

**`RunInstances` is split into two statements on purpose.** A single statement with a tag
condition does not work. `RunInstances` is authorized against *every* resource it touches —
the instance and volume it creates, and the image, subnet, security group and network interface
it references or creates alongside them. `aws:RequestTag` only exists for resources the request
actually tags, so a statement-wide tag condition evaluates to false on the image and subnet and
denies the whole call. Splitting them lets the tagged resources carry a tag requirement while
the rest stay unconditioned.

**The network interface is in the *unconditioned* statement, and that placement is the one thing
this policy originally got wrong.** An ENI is created by the launch, so it looks like it belongs
with the instance and the volume — but Rocky Surf's `TagSpecifications` cover the instance and
the volume only. Nothing tags the ENI, so `aws:RequestTag/managed-by` does not exist for it, the
tag-conditioned statement matches nothing, and every launch fails with `UnauthorizedOperation` on
`network-interface/*`. "Created by the call" and "tagged by the call" are not the same set, and
only the second one can carry a `RequestTag` condition. This cost nothing to find and would have
cost every self-hoster their first launch: the restricted-principal run refused to create a
single server until it was fixed.

**The SSM scope follows your `amiParameterPrefix`.** The statement above is scoped to
Canonical's namespace, which matches the default Ubuntu 24.04 prefix. If you point
`amiParameterPrefix` at a different vendor's public parameters, widen it to
`arn:aws:ssm:*::parameter/aws/service/*` or you will get `AccessDeniedException` from SSM
before any instance is attempted.

**The AMI ARN has an empty account field** — `arn:aws:ec2:REGION::image/*`, with two colons.
Ubuntu AMIs are owned by Canonical, not by you. The same applies to the SSM parameter ARN:
`arn:aws:ssm:*::parameter/aws/service/canonical/*` is the AWS public parameter namespace, which
lives outside any account. Writing your account id into either of these produces a policy that
denies everything with no obvious explanation.

### Where `*` is unavoidable

**The `Describe*` actions.** EC2's read APIs do not support resource-level permissions at all —
you cannot say "describe only instances tagged X". This is an AWS limitation, not a shortcut.
The practical exposure is that Rocky Surf can *see* other instances in the region; it cannot
touch them, because every mutating statement is either tag-conditioned or limited to creating
new resources.

**`ec2:CreateSecurityGroup`.** A group that does not exist yet has no tags to match on, and
`aws:RequestTag` support for this action is inconsistent. It is scoped to your account and
region. If you want it tighter, create the group yourself, tag it `managed-by=rockysurf`, and
drop this statement entirely — Rocky Surf adopts an existing group with the configured name.

### Why `DescribeImages` matters more than it looks

Sizing the root volume means naming the device, and the correct device name comes from the AMI.
Guessing `/dev/sda1` on an image whose root device is something else silently attaches a
**second** volume that survives instance termination — an orphan that never appears in any
audit that walks instances, and that quietly bills forever. Rocky Surf reads
`RootDeviceName` from the AMI instead of assuming it.

---

## Who can reach SSH

Rocky Surf creates **one** shared security group (`rockysurf-ssh` by default) with a single
inbound rule: TCP 22, from a CIDR **you specify**.

```yaml
providers:
  aws:
    sshAllowedCidr: 203.0.113.7/32     # required — no default
```

There is no default, and startup fails with an explanation if you omit it. That is deliberate.
An earlier prototype discovered the operator's address at runtime by calling an external
"what is my IP" service, which is fine for a throwaway script and wrong for something you run
continuously: it breaks silently the moment your network changes, it makes a third party's
availability decide your firewall rule, and it hides a security decision inside runtime
behaviour where no reviewer ever sees it. In a config file it is written down, diffable, and
reviewable.

Opening SSH to the whole internet takes **two** deliberate settings, not one typo:

```yaml
    sshAllowedCidr: 0.0.0.0/0
    allowAllCidr: true                 # required to accept 0.0.0.0/0
```

These boxes run agent-authored code and hold your git credentials. A `/0` that arrives by
accident is the difference between a dev box and an incident, so it cannot arrive by accident.

Rocky Surf does **not** create EC2 key pairs. SSH keys are generated per server, the public half
is injected through cloud-init, and the private half stays encrypted in Rocky Surf's own store.
There is no key pair in your account to manage or leak.

---

## Testing the policy

The quickest real check is to start Rocky Surf and let it validate:

```bash
AWS_PROFILE=my-profile npx rockysurf
```

`validateCredentials()` runs during the first provider call and fails with a plain message if
the credentials or region are wrong.

To check the policy without creating anything, simulate it:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::ACCOUNT_ID:user/rockysurf \
  --action-names ec2:RunInstances ec2:CreateTags ec2:TerminateInstances \
                 ec2:DescribeInstances ec2:CreateSecurityGroup \
                 ec2:AuthorizeSecurityGroupIngress ssm:GetParameter \
  --output table
```

Every row should read `allowed`. Note that `simulate-principal-policy` does not evaluate
`aws:RequestTag` conditions the way a real call does, so a green simulation is necessary but
not sufficient — the honest test is creating one server and destroying it.

The end-to-end check is simply: create a server in the UI, wait for it to reach ready, SSH in,
then terminate it. If the policy is short something, the failure surfaces as a
`ProviderError` with `providerCode: UnauthorizedOperation`, and the message names the action
that was refused.

That check is also scripted, and it is what produced the status above:

```bash
node scripts/e2e/restricted-principal.mjs --profile my-profile
```

It deploys the template, assumes the role, and runs the full lifecycle on both architectures
under those credentials and nothing else — then deletes the stack and sweeps the account for
anything left running. **It spends money**: one small instance per architecture, a few minutes
each. `--profile` is required and has no default, because a run that silently used the wrong
account would report a confident wrong answer rather than an error.

Two statements cannot be reached by a lifecycle run in an account that has run Rocky Surf
before — the shared SSH group already exists, so nothing calls `CreateSecurityGroup` or
`AuthorizeSecurityGroupIngress`, which are exactly the calls a *first* launch makes. The script
covers those with EC2 `--dry-run` probes, which perform the full authorization evaluation and
stop before any side effect. It probes in the deny direction too: `ec2:DescribeVolumes` must be
refused (the provider never calls it), and `ec2:CreateTags` on an existing resource must be
refused (the `ec2:CreateAction` condition is supposed to confine tagging to creation). A
condition that matches nothing and a condition that is absent look identical from a passing
run — only a call that is supposed to fail tells them apart.

---

## What is deliberately absent

**No `cloudformation:*`.** Rocky Surf creates instances with plain `RunInstances`. An earlier
design wrapped every server in its own CloudFormation stack; that existed only so the box could
read DynamoDB and Secrets Manager through a per-server IAM role, and the current bootstrap
removed that need entirely.

**No `iam:*` at all** — no `CreateRole`, no `PassRole`, no instance profiles. The boxes carry no
AWS identity. They do not read AWS APIs, so they need no permission to.

**No `autoscaling:*`, no launch templates, no spot.** Spot instances are out of v0.1: an
interrupted box with an agent mid-task undercuts the whole point of a persistent dev box, and
idle auto-stop is the cost lever instead.

The size of that removal is easy to understand and worth stating plainly. Counting distinct
actions granted for compute provisioning in the previous architecture — `ec2`, `iam`,
`autoscaling`, `cloudformation`, `ssm` and `secretsmanager` — the old policy needed **83**.
This one needs **14**.

That is not just a smaller policy. It is a smaller blast radius: nothing here can create an IAM
role, mutate a resource it did not tag, or touch a stack.
