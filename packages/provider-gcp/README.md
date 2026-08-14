# @rockysurf/provider-gcp

Google Compute Engine for [Rocky Surf](https://github.com/amroja-biz/rockysurf). It talks to the
Compute Engine v1 REST API with plain `fetch` and authenticates through Application Default
Credentials. It creates instances, one shared SSH firewall rule, and nothing else — no
Deployment Manager, no instance templates, no managed instance groups, and no service account on
the machines it makes.

## How you get it

It ships inside the `rockysurf` CLI. There is nothing to install: switch it on in configuration.

```bash
npx rockysurf
```

## Configuration

```yaml
providers:
  gcp:
    enabled: true
    projectId: my-project-123456
    zone: us-central1-a
    sshAllowedCidr: 203.0.113.7/32
```

| field | default | what it is |
|---|---|---|
| `projectId` | **none — required** | The project every resource lives in. Nothing is inferred: a Google credential can be valid for many projects and names none of them. |
| `zone` | `us-central1-a` | The single zone this provider manages. One zone per provider; two zones means two providers. |
| `sshAllowedCidr` | **none — required** | Who may reach SSH. No default, deliberately. |
| `allowAllCidr` | `false` | Required alongside `sshAllowedCidr: 0.0.0.0/0`. Opening SSH to the internet is two decisions. |
| `keyFile` | unset | Path to a service-account key file. Omit for the ambient credential chain. |
| `managedBy` | `rockysurf` | The `managed-by` label this provider reconciles, and the prefix of every instance name. |
| `firewallRuleName` | `rockysurf-ssh` | The shared SSH rule, which doubles as the network tag it matches on. |
| `network` | `default` | The VPC network instances join. |
| `bootDiskGb` | `20` | Boot disk size. Billed separately from the instance. |
| `bootDiskType` | `pd-balanced` | `pd-balanced`, `pd-standard` or `pd-ssd`. |
| `imageProject` | `ubuntu-os-cloud` | The project publishing the base image. |
| `imageFamilyPrefix` | `ubuntu-2404-lts` | Image family without its architecture suffix; `-amd64` or `-arm64` is appended. |

Why `us-central1-a` rather than the more obvious `us-central1-c`: arm64 (Tau T2A) exists in only
eight zones, and `us-central1-c` is not one of them.

## Credentials

**Application Default Credentials, the same chain `gcloud` uses.** There is no field in this
schema that can hold key material — the object is strict, so a pasted private key is a startup
error rather than a secret in a config file.

```bash
gcloud auth application-default login          # a user session
export GOOGLE_APPLICATION_CREDENTIALS=...      # a key file, by path
```

Or nothing at all, when core runs on GCE, Cloud Run or GKE with a service account attached —
then no key exists anywhere to leak. If you must name a key file in configuration, name it by
**path**, never by contents:

```yaml
providers:
  gcp:
    keyFile: ~/keys/rockysurf-sa.json
```

## What it needs in your account

A **custom IAM role with 22 permissions**, and no predefined role. It ships as deployable IaC:

```bash
./deploy/gcp/setup.sh --project=my-project-123456
```

That creates the role, a service account, and the binding. `gcloud` is the only prerequisite.
[`docs/providers/gcp.md`](../../docs/providers/gcp.md) publishes every permission with the call
that needs it, and a lint keeps the published list and the deployed file from drifting apart.

Two things worth knowing before the first launch:

- **Your default VPC probably already allows SSH from anywhere.** Google's auto-created
  `default-allow-ssh` rule opens port 22 to `0.0.0.0/0` for every instance in the network. This
  provider never touches that rule, and never widens anything — but it is worth a look.
- **The boxes carry no Google Cloud identity.** No service account is attached, so they cannot
  read any Google API and need no permission to.

## Capabilities

| capability | value | what it costs you |
|---|---|---|
| `stop` | `true` | Boxes can be stopped and restarted with the disk intact. The disk keeps billing while stopped. **Not yet exercised on real Google Cloud** — see below. |
| `ipStableAcrossStop` | `false` | A stopped box comes back on a **different** external IP. Core re-reads it and tells you your SSH config is stale. **Not yet exercised on real Google Cloud** — see below. |
| `canInjectHostKeys` | `true` | The box comes up presenting a host key core minted, so the first connection is strictly verified with no trust-on-first-use window. Verified on real Google Cloud. |
| `userDataMaxBytes` | `262144` | Google's per-metadata-value ceiling. Sixteen times AWS's, and nothing core renders comes close. |
| `generatesUserData` | `true` | The cloud-config document reaches the box through the `user-data` metadata key, which cloud-init's GCE datasource reads. |

## Prices

**Bundled and stamped with a `fetchedAt`, in USD**, for `us-central1` only. Any other region
reports its prices as `null` — unknown, never free — rather than reusing a number that would be
wrong.

They were **transcribed by hand** from Google's published pricing page rather than machine-read,
because Google publishes no credential-free price feed. The generated file records the URL, the
date and the method. The boot disk is billed separately and is **not** included in the hourly
figure.

`e2-*` is amd64 and available everywhere. `t2a-*` is arm64, meaningfully cheaper per vCPU, and
exists in eight zones only — in a zone without it, those machines are reported as unavailable
rather than silently omitted, so a size selector can explain itself.

## Verified

**A full create → bootstrap → terminate lifecycle on real Google Cloud, on 2026-08-14, on both
architectures** (`e2-small` and `e2-micro` amd64, `t2a-standard-1` arm64), with zero orphans left
behind — audited afterwards as no instances and no disks. The two claims that were previously
inferences from documentation are now observations: the boxes presented exactly the host key core
minted, so `canInjectHostKeys: true` holds on Google's Ubuntu images, and the published
permission list is *sufficient* to launch under, including the first-launch-in-a-fresh-project
path that creates the shared SSH firewall rule. That second one is the check the AWS policy
failed the first time it was tried for real.

Every method is also exercised against an in-memory Compute Engine driven through the real HTTP
client, so request construction, error mapping, operation polling and the state machine are all
under test, and the package passes `@rockysurf/provider-conformance` including the `describe()`
absence-grace probe.

**`stop` and `start` are the exception.** No box has been stopped and restarted on real GCE, so
those two methods and `ipStableAcrossStop: false` are still read from Google's documentation
rather than watched.

See [the status block in `docs/providers/gcp.md`](../../docs/providers/gcp.md#status-proven-on-real-google-cloud-except-stopstart).

## Writing your own provider

The contract is `@rockysurf/provider-sdk`; the workflow is
[`docs/writing-a-provider.md`](../../docs/writing-a-provider.md).
