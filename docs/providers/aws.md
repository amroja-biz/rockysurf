# Running Rocky Surf on AWS

What you need to give Rocky Surf so it can create, stop, start and destroy EC2 dev boxes in
your own account — and nothing beyond that.

- [Credentials](#credentials)
- [The IAM policy](#the-iam-policy)
- [Deploying the role](#deploying-the-role)
- [What each statement is for](#what-each-statement-is-for)
- [Who can reach SSH](#who-can-reach-ssh)
- [Testing the policy](#testing-the-policy)
- [The nightly real-cloud run (maintainers)](#the-nightly-real-cloud-run-maintainers)
- [What is deliberately absent](#what-is-deliberately-absent)
- [The machine catalogue and priced regions](#the-machine-catalogue-and-priced-regions)

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
        "arn:aws:ec2:REGION:ACCOUNT_ID:volume/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:network-interface/*"
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
        "arn:aws:ec2:REGION:ACCOUNT_ID:security-group/*"
      ]
    },
    {
      "Sid": "TagOnCreate",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": [
        "arn:aws:ec2:REGION:ACCOUNT_ID:instance/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:volume/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:security-group/*",
        "arn:aws:ec2:REGION:ACCOUNT_ID:network-interface/*"
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
> `network-interface/*` sat in the tag-conditioned statement, where it could never match, because
> nothing tagged the ENI; every first launch under the previously published version failed with
> `UnauthorizedOperation`. See [the note below](#three-things-that-trip-people-up).
>
> **The policy has since been tightened further** (`rockysurf-b14y`): the provider now tags the
> ENI at launch, so that ARN sits under the tag condition in the RunInstances statement AND in
> `TagOnCreate` — it takes both halves, and the first shipped without the second, which failed
> every real launch for five nightlies while every in-repo check stayed green. **Measured** on
> 2026-08-19: a restricted-principal run under the corrected role passed the full lifecycle on
> both architectures. Everything above stands as proved.
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

**The network interface sits with the tagged resources, and getting there took two goes.** An ENI
is created by the launch, so it looks like it belongs with the instance and the volume — but for
a while Rocky Surf's `TagSpecifications` covered the instance and the volume only. Nothing tagged
the ENI, so `aws:RequestTag/managed-by` did not exist for it, the tag-conditioned statement
matched nothing, and every launch failed with `UnauthorizedOperation` on `network-interface/*`.
That is worth stating as a rule, because it is the trap: **"created by the call" and "tagged by
the call" are not the same set, and only the second can carry a `RequestTag` condition.** The
restricted-principal run refused to create a single server until the ARN was moved out to the
unconditioned statement.

Moving it out was the right fix for the symptom and the wrong one for the cause. `RunInstances`
tags four resource types — instances, volumes, spot instance requests and network interfaces —
so the ENI could have been in the tagged set all along. It now is (`rockysurf-b14y`), which lets
the ARN move back under the condition: strictly tighter than the version that shipped, and it
also means an ENI that ever outlives its instance is visible to `listManaged()` and to the
zero-orphan audit, which walk resources by tag. In practice launch-created ENIs carry
`DeleteOnTermination=true` and go with the instance, so this is not a known leak — it is the
untagged-volume case, closed before it happens rather than after.

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

Rocky Surf creates **one** shared security group (`rockysurf-ssh` by default) whose inbound
rules are TCP 22 from the CIDRs **you specify**, and nothing else.

```yaml
providers:
  aws:
    sshAllowedCidr:                    # required — no default
      - 203.0.113.7/32                 # home
      - 198.51.100.0/24                # the office
```

**`sshAllowedCidr` is a list**, and a bare string is still read as a list of one, so an existing
config file keeps working untouched. The list may not be empty — an empty list is refused by the
schema rather than quietly meaning "nobody", which would produce a security group nobody can get
through. Exact duplicates are folded away; **overlapping ranges are deliberately left alone**,
because `203.0.113.7/32` inside `198.51.100.0/24` means something to the person maintaining the
file (the wide one is the office, the narrow one is that laptop) and collapsing them would make
removing one of them do something other than what it says.

There is no default, and startup fails with an explanation if you omit it. That is deliberate.
An earlier prototype discovered the operator's address at runtime by calling an external
"what is my IP" service, which is fine for a throwaway script and wrong for something you run
continuously: it breaks silently the moment your network changes, it makes a third party's
availability decide your firewall rule, and it hides a security decision inside runtime
behaviour where no reviewer ever sees it. In a config file it is written down, diffable, and
reviewable. **That ruling is unchanged.** Nothing on this page discovers an address for you: you
type the CIDR, it lands in your file, and Rocky Surf pushes what you typed.

Opening SSH to the whole internet takes **two** deliberate settings, not one typo:

```yaml
    sshAllowedCidr: [0.0.0.0/0]
    allowAllCidr: true                 # required to accept 0.0.0.0/0
```

`0.0.0.0/0` **anywhere in the list** triggers that guard, not only a list whose single entry is
`/0`. A list of five careful office ranges with a `/0` appended is open to the entire internet,
and the four careful entries change nothing about that.

These boxes run agent-authored code and hold your git credentials. A `/0` that arrives by
accident is the difference between a dev box and an incident, so it cannot arrive by accident.

### The change reaches EC2 on save

Until issue #304, the only thing that ever wrote your CIDR to EC2 was `provision()` — so editing
the setting fixed your file and left the security group exactly as it was, and the way to fix
your SSH was to launch a server you did not want. Worse, the authorize call sat behind a latch
set for the lifetime of the process, so a corrected CIDR did not reach EC2 **even on the next
launch**; it took a restart. The latch is gone, and provision now authorizes every configured
CIDR on every provision.

Saving the setting also pushes it, without provisioning anything. The save stays local and
atomic (ADR-0017): the Settings page writes your file, this process adopts it, and *then*, if the
save changed a CIDR list, a second and separate call goes out —
`POST /api/v1/network/ssh-access/sync`. The per-cloud result renders on the Settings page under
**SSH access at the cloud**, which is where you find out whether an earlier save actually landed.
A **`Push SSH access to the clouds`** button in the Settings page footer runs the same call on
demand, without requiring unsaved edits — which is what you want when the group drifted and your
file did not. `rockysurf network sync` is the CLI equivalent.

**Rocky Surf adds and reports; it does not revoke.** This is the part worth reading carefully,
because it is the one place where the three clouds' behaviour differs in a way you can see.

- Every CIDR in your list that is not already authorized is authorized, one call per range —
  EC2 rejects a whole request containing one duplicate, so a batch would mean one pre-existing
  entry silently blocking every new one.
- Anything on the group that your list no longer names is **left in place and reported**. There is
  no `ec2:RevokeSecurityGroupIngress` in the published policy and Rocky Surf makes no such call.
- The report tells the two kinds of leftover apart, using the description Rocky Surf stamps on
  every range it authorizes (`rockysurf sshAllowedCidr`). A range carrying that stamp is one an
  earlier Rocky Surf added, and you are told which, so you can put it back in the list or remove
  it deliberately. A range **without** it was added by you, by your own tooling, or by a release
  older than the stamp, and removing it silently would be the product deleting access it did not
  create and cannot explain.
- For anything it will not remove, you get the exact command:

```bash
aws ec2 revoke-security-group-ingress \
  --group-id sg-0123456789abcdef0 --protocol tcp --port 22 \
  --cidr 198.51.100.0/24 --region us-east-1
```

**So a CIDR you delete from the list is still authorized on EC2 until you run that.** That is
stated here rather than hidden. Removing a range is currently a two-step operation on AWS and on
[GCP](gcp.md#the-change-reaches-google-cloud-on-save), which keeps its extras for the same
reason, and a one-step operation only on [Azure](azure.md#who-can-reach-ssh), where the whole rule
is Rocky Surf's own and is rewritten wholesale every time. Converging the group to exactly your
list — revoking the stamped extras — is deliberately not in this release; see
[ADR-0021](../adr/0021-ssh-access-is-pushed-on-save-not-only-on-provision.md).

**No new IAM permission was needed for any of this.** `ec2:DescribeSecurityGroups` and
`ec2:AuthorizeSecurityGroupIngress` were already in the published policy, because provision has
always needed them, and nothing revokes. If you have an older role, it already grants everything
this path uses.

**Removing a CIDR ends new SSH connections from that network as soon as the revoke lands.**
Established sessions survive — a security group is evaluated on connection setup — and the boxes
keep running. This is reachability, not data.

Rocky Surf does **not** create EC2 key pairs. SSH keys are generated per server, the public half
is injected through cloud-init, and the private half stays encrypted in Rocky Surf's own store.
There is no key pair in your account to manage or leak.

---

## Testing the policy

The quickest real check is to start Rocky Surf and let it validate:

```bash
AWS_PROFILE=my-profile node packages/rockysurf/dist/bin.js
```

**That is the `rockysurf` command until v0.1.0 is on npm.** The published form is
`AWS_PROFILE=my-profile npx rockysurf`, but npm cannot supply a package that has not been
published yet; from a checkout you have run `pnpm -r build` in,
`packages/rockysurf/dist/bin.js` is the identical binary. The Docker Compose path in the
[README](../../README.md#quickstart) works today too. See
[`docs/RELEASING.md`](../RELEASING.md).

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

## The nightly real-cloud run (maintainers)

This section is for whoever maintains this repository, not for self-hosters. Nothing here changes
what you deploy.

[`.github/workflows/nightly-real-cloud.yml`](../../.github/workflows/nightly-real-cloud.yml)
creates and destroys two real EC2 boxes every morning — both architectures, sequentially, each
through the full create → bootstrap → SSH → stop → start → terminate → zero-orphan path — **under
the exact policy published above** (`rockysurf-evo1`). That is the whole point of wiring it this
way: the policy on this page was proved *once, by hand*, and a policy proved once is a policy that
*was* true once. Add an EC2 call to `@rockysurf/provider-aws` and forget to add its action here,
and without the leg nothing turns red until a self-hoster's next launch fails.

**Turning it on is one command.** Sign in with the `aws` CLI and `gh auth login`, then run
[`./deploy/aws/setup-nightly.sh`](../../deploy/aws/setup-nightly.sh). It does everything below and
asks you for nothing else. [`./deploy/aws/teardown-nightly.sh`](../../deploy/aws/teardown-nightly.sh)
undoes it. The rest of this section is what those two scripts do, and why.

### Use a dedicated, CI-only account

This is the one rule that matters, and it is the same rule the [GCP
page](gcp.md#the-nightly-real-cloud-run-maintainers) states for its project and the [Azure
page](azure.md#the-nightly-real-cloud-run-maintainers) for its subscription. The sweep that runs
after each leg is deliberately narrow — it terminates only the instance ids the run itself
recorded, and merely *reports* everything else tagged `managed-by=rockysurf` — but that narrowness
is the second line of defence. The first is that nothing anybody cares about is in the account at
all. On 2026-08-12 the Hetzner leg destroyed the owner's own live server, launched from their
laptop against the same project 37 seconds earlier, and reported it as a leak it had helpfully
cleaned up. A self-hoster's production box and this nightly can share one AWS account far more
easily than one Hetzner project.

### No access key exists anywhere on this path

GitHub mints a short-lived OIDC token for the run, and an IAM identity provider in the account is
what makes AWS accept it. There is no AWS access key in this repository, nothing to rotate, and
nothing to leak.

### Wiring it, once

```bash
aws sso login --profile my-ci-account   # or however you sign in
gh auth login                           # if you are not already signed in

./deploy/aws/setup-nightly.sh --dry-run     # optional: shows every step, changes nothing
./deploy/aws/setup-nightly.sh
```

It offers to start a run at the end. To undo everything it made:

```bash
./deploy/aws/teardown-nightly.sh
```

**Run it as often as you like.** Every step checks before it creates, so a second run says what is
already there and changes nothing else — a CloudFormation deployment with nothing to change works
out an empty change set, deletes it, and touches no resource.

**Nothing it makes costs money.** Two IAM roles and a sign-in provider are free. Only the nightly's
own machines bill, at under half a cent a night — see [what the nightly
costs](gcp.md#what-the-nightly-costs--measured-2026-08-26), which is where the measured numbers
live.

**It creates no access key, and prints none.** There is nothing to rotate.

#### What it does, in order

You do not have to read this to run it. It is here so the permissions it grants are auditable
without running anything.

| Step | What it makes | Why |
|---|---|---|
| 1 | nothing | Checks you are signed in to AWS and to GitHub, and works out which repository this is. |
| 2 | nothing | Names the account it is about to change, and says to use one that holds nothing else. |
| 3 | nothing | Looks for the GitHub sign-in provider. There can be only one per account, and every workflow that signs in this way shares it. |
| 4 | the CI entry role, and that sign-in provider if the account had none | [`nightly-ci.yaml`](../../deploy/aws/nightly-ci.yaml): may assume the role below, may see and terminate leftovers, and nothing else. Its trust names this repository and no other. |
| 5 | the role under test | [`iam-role.yaml`](../../deploy/aws/iam-role.yaml), **unmodified** — the file a self-hoster deploys, which is the whole point of the leg. |
| 6 | nothing | Reads the second role's trust policy back and confirms the first one is named in it. |
| 7 | nothing | Checks the region has a default VPC (Rocky Surf never creates networking) and enough on-demand vCPUs for two small boxes. |
| 8 | one repository secret and one variable | Both are role names. Neither grants anything by itself. |
| 9 | nothing | Offers to start a run. |

The settings it saves:

| Name | What it is |
|---|---|
| `AWS_NIGHTLY_ROLE_ARN` (secret) | the CI entry role GitHub signs in as. It is a secret because that is where the workflow reads it from; an ARN is a name, not a credential. |
| `AWS_PROVIDER_ROLE_ARN` (variable) | the role carrying the published policy — the identity under test |

`AWS_PROVIDER_ROLE_NAME` is left unset unless you rename the role with `--role-name`: the workflow
already expects `rocky-surf-provider`, and writing the default would change your repository for
nothing.

Defaults are overridable: `--repo`, `--branch`, `--region`, `--stack-region`, `--role-name`.

#### Two hops, not one, and why the sweep uses the first

The run signs in as the entry role and then *becomes* the role under test, so every EC2 call the
lifecycle makes runs under exactly the permissions this page publishes. The zero-orphan audit and
the terminate sweep stay on the **first** role, because `ec2:DescribeVolumes` is a call the
provider never makes and this page therefore never grants — an orphan the credentials under test
cannot see would be an orphan the audit reports as clean, and a sweep wired through the identity
being tested goes blind at exactly the moment that identity is what broke (`rockysurf-ufwn`).

#### The one thing a script cannot do for you

AWS decides how many on-demand vCPUs your account may run, per region, and a brand-new account is
sometimes allowed very few. No API grants that to yourself, so step 7 reads the quota and says in
plain words what to click if it is short. The same step checks for a default VPC, which *can* be
made back with the one command the script prints.

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

---

## The machine catalogue and priced regions

`listOfferings()` returns roughly a thousand EC2 instance types, generated mechanically by
[`scripts/refresh-prices.mjs`](../../scripts/refresh-prices.mjs) from AWS's own public,
credential-free EC2 on-demand pricing feed — the same JSON the pricing page itself renders. Every
type is included unless it is a GPU / Machine Learning ASIC / FPGA / media-accelerator instance
(this bootstrap ships no drivers for one, and `Offering.gpu` is reserved and unpopulated, so
selling one would be dishonest), a bare-metal (`.metal`) id, or above the ceiling of 128 vCPU /
1024 GiB. There is deliberately no "current generation" hand list — a family list goes stale
silently; a mechanical rule regenerated from the live feed does not.

**Prices are not bundled — they come from the hosted price feed** (issue #100,
[ADR-0009](../adr/0009-prices-served-from-hosted-feed.md)): a JSON document this repository's
`price-feed` workflow regenerates from the same public AWS feed and republishes to GitHub Pages
daily. Your installation fetches it at runtime (see `pricing` in
[self-hosting](../self-hosting.md)), so a price AWS changes today reaches you on the next
publish + cache refresh — no Rocky Surf release involved. Every `hourly` field carries the
feed's own `fetchedAt`, which is what the "estimate based on prices as of …" label renders.

**Twelve regions are covered with real prices:**

| | |
|---|---|
| `us-east-1` (N. Virginia) | `us-east-2` (Ohio) |
| `us-west-2` (Oregon) | `eu-west-1` (Ireland) |
| `eu-west-2` (London) | `eu-west-3` (Paris) |
| `eu-central-1` (Frankfurt) | `ap-southeast-1` (Singapore) |
| `ap-southeast-2` (Sydney) | `ap-northeast-1` (Tokyo) |
| `ca-central-1` (Central Canada) | `sa-east-1` (São Paulo) |

**Any other region is a documented degraded state, not a silent one.** EC2 will happily create an
instance in `ap-south-1` or `eu-north-1` — Rocky Surf does not restrict `region` to this list —
but every offering's `hourly` comes back `null`, which the SDK defines as "unknown, never free"
rather than reusing another region's number. That has one binding consequence worth stating
plainly: **the spend cap cannot see those boxes.** `hourlyCostAmount` is null for an unpriced
offering, so a server in an uncovered region counts toward nobody's spend total — it is real,
billing, and invisible to the one feature meant to bound cost. If you run in a region not in the
table above, budget for it the way you would for a provider Rocky Surf could not price at all.

**When the feed is unreachable, prices are unavailable — deliberately.** There is no bundled
fallback (ADR-0009): every offering lists with `hourly: null`, the create form shows one
"prices are currently unavailable" notice, and creating servers keeps working. If your
installation cannot reach a public GitHub Pages URL, either its internet is gone or GitHub is
down; a stale price pretending to be current was judged worse than an honest "unavailable".
Air-gapped? Set `pricing.enabled: false`, or point `pricing.feedUrl` at your own mirror.

To add a region: add a row to `AWS_REGIONS` in `scripts/refresh-prices.mjs` (the region id and
the exact label the pricing page uses for it — there is no feed index to read this from, so the
generator hard-fails on a bad label rather than silently skipping the region). The next
`price-feed` publish carries it; re-run `node scripts/refresh-prices.mjs` too if the catalogue
of type shapes should pick up new types.
