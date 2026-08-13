# `@rockysurf/provider-hetzner`

Runs Rocky Surf dev boxes as servers in your own Hetzner Cloud project. It talks to the
documented REST API with plain `fetch` — no vendor SDK, so there is no transitive dependency tree
to audit and nothing extra to download on an `npx` cold start. It creates servers and the SSH Key
objects they need, and nothing else.

- [How you get it](#how-you-get-it)
- [Configuration](#configuration)
- [Credentials](#credentials)
- [What it needs in your project](#what-it-needs-in-your-project)
- [Capabilities](#capabilities)
- [Prices](#prices)
- [Verified](#verified)
- [Writing your own provider](#writing-your-own-provider)

## How you get it

It is already there. The `rockysurf` CLI depends on this package, so `npx rockysurf` can reach
Hetzner as soon as you switch it on. Providers are constructed at boot, so a configuration change
takes effect at the next restart.

Install it directly only if you are embedding Rocky Surf's provider in something of your own:

```bash
pnpm add @rockysurf/provider-hetzner
```

```ts
import hetzner from '@rockysurf/provider-hetzner'

const config = hetzner.configSchema.parse({ token: process.env.HETZNER_TOKEN, location: 'fsn1' })
const provider = hetzner.createProvider(config)
```

`createProvider` is synchronous and does no I/O, so a caller can load the provider, show its
identity and validate its configuration before it holds anything live. The token is proven
separately, by `validateCredentials()`, which also checks that the configured location exists.

## Configuration

```yaml
providers:
  hetzner:
    enabled: true
    token: "${HETZNER_TOKEN}"
    location: fsn1
    # consoleProjectId: 1234567       # optional; only adds a link to the Hetzner Console
```

| field | default | what it does |
|---|---|---|
| `token` | none — **required** | read/write API token for one project |
| `location` | `fsn1` | the one location this provider manages. `fsn1`/`nbg1`/`hel1` in Europe, `ash`/`hil` in the US, `sin` in Singapore. Two locations means two providers; `listManaged()` is scoped at construction |
| `image` | `ubuntu-24.04` | base image, overridable for another Ubuntu LTS |
| `managedBy` | `rockysurf` | value of the `managed-by` label this provider owns. `listManaged()` filters on it and `validateSpec()` refuses a spec that disagrees |
| `consoleProjectId` | none | numeric project id, used only to link a server to its page in the console |

**`consoleProjectId` has to be typed in because the Cloud API never says it.** A token is scoped
to one project without any response naming that project, and the console URL is
`/projects/<id>/servers/<server id>/overview`. Leave it out and servers simply have no console
link; a guessed value would deep-link into somebody else's project. Open the project in the
console and read the number out of the address bar.

**arm64 stock is regional and real.** CAX types are sold in `fsn1`, `nbg1` and `hel1` only, and
Hetzner sells out of them — see [Prices](#prices) for what the provider does about that.

## Credentials

Create a project at [console.hetzner.com](https://console.hetzner.com), then an API token with
**read/write** access to it. Read-only is not enough: the provider creates and deletes servers
and SSH Key objects.

The token belongs in your environment, and the config file holds a reference to it:

```yaml
    token: "${HETZNER_TOKEN}"
```

That form is resolved before the value reaches this package, so the secret is never written to a
file people back up or paste into an issue. The first-run wizard is the other route — what you
paste there goes into Rocky Surf's encrypted secrets store instead, and a token in the config
file wins over a stored one, because the file is the copy an operator can see, diff and roll
back.

## What it needs in your project

Nothing to create beforehand and nothing to deploy. A Hetzner server is reachable over SSH the
moment it boots, so there is no firewall or network object to prepare — which also means these
boxes are exposed to the internet by default, unlike the AWS provider's, where you must name the
network allowed to reach SSH.

The provider does create one kind of secondary resource: an **SSH Key object per provision**,
because Hetzner's create call will not take raw key material inline. It owns those, reports them
as `server-owned`, and reaps them with the server. A key that matched something already in the
project is never claimed, because reaping it would break whoever else references it.

## Capabilities

| capability | value | what it means for you |
|---|---|---|
| `stop` | `true` | a box can be stopped and restarted with its disk intact |
| `ipStableAcrossStop` | `true` | the primary IPv4 survives a poweroff and poweron, so your SSH config keeps working |
| `canInjectHostKeys` | `true` | core mints the host key before the server exists and ships it in `#cloud-config`, then verifies it on the first connection — the one carrying your secrets file. There is no trust-on-first-use window |
| `userDataMaxBytes` | `32768` | the ceiling on the rendered document. Push-mode documents run about 2.1KB, so it has never been approached |
| `generatesUserData` | `true` | cloud-init does the pre-boot work |

Servers also report a `consoleUrl` when `consoleProjectId` is set, and none when it is not.

Evidence for each value is in
[`docs/providers/capability-matrix.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/capability-matrix.md).

## Prices

**Live, in the currency your project is billed in.** This provider is the documented exception to
Rocky Surf's bundled-prices rule, and the reason is narrow: Hetzner returns `prices[]` inline on
`GET /server_types`, the exact call `listOfferings()` already makes. Preferring a bundled number
would mean showing a figure known to be staler than one already in hand, having saved no request.

| source | when | `fetchedAt` |
|---|---|---|
| live | the type carries a price for your location, and `GET /pricing` reported a currency | now |
| bundled | `src/prices.generated.ts` has an entry | when the table was generated |
| neither | — | `hourly: null`, which the SDK defines as *unknown, never free* |

Two details that change what you see:

- **Currency comes from `GET /pricing`, not from an assumption.** Hetzner quotes in the project's
  billing currency, EUR for most accounts and USD for some, and a number without its currency is
  not a price. If that call fails — a read-only token, a blip — offerings still list; prices fall
  back to the bundled table rather than taking the whole catalogue down.
- **Net, not gross.** Gross folds in a per-account VAT rate, so two customers would see different
  "prices" for the same machine.

The bundled fallback ships **empty**, and refreshing it is opt-in
(`HETZNER_TOKEN=… node scripts/refresh-prices.mjs --hetzner`). Both follow from the same fact:
Hetzner quotes per project, so a table built from one account's numbers would be wrong for
another.

**Sold-out types are listed with `available: false` rather than hidden**, and availability is
read only from `locations[].available`, never inferred from a price. Hetzner publishes prices for
architectures it has no stock of — at the spike's capstone every CAX (arm64) type reported
`available: false` in all three ARM locations while still quoting a price, and a direct order in
each returned `412 resource_unavailable`.

## Verified

**A full lifecycle on real Hetzner Cloud, on 2026-08-12: `cpx12`, 149 seconds end to end, zero
orphans.** The run drove the shipped article — the `rockysurf` binary booted from a real config
file, then everything through core's own HTTP API — created a server, watched push bootstrap
report ready, ran `claude --version` over SSH on the box (2.1.228), stopped and started it,
terminated it, and then ran a reconciler-grade `listManaged()` audit showing no server-owned
instances left and the owned SSH Key objects reaped with the server. Transcript:
[`scripts/e2e/recordings/hetzner-lifecycle.log`](https://github.com/amroja-biz/rockysurf/blob/main/scripts/e2e/recordings/hetzner-lifecycle.log).

**It is re-run nightly**, at 07:00 UTC, by
[`.github/workflows/nightly-real-cloud.yml`](https://github.com/amroja-biz/rockysurf/blob/main/.github/workflows/nightly-real-cloud.yml),
against the same `cpx12`, with a terminate sweep that runs even when the run fails.

The spike's earlier capstone on `cpx12`/amd64 in `fsn1` is what proved the two claims this
provider makes about first boot: cloud-init consumed core's `#cloud-config`, with
`/var/lib/cloud/instance/user-data.txt` matching what core sent byte for byte (2138 bytes), and
the box presented exactly the host key core had minted. That transcript is
[`spike/recordings/hetzner-lifecycle.txt`](https://github.com/amroja-biz/rockysurf/blob/main/spike/recordings/hetzner-lifecycle.txt).

One value is weaker than the rest and worth naming. The lifecycle stops and starts a server, but
it does not re-read the address afterwards, so `ipStableAcrossStop: true` rests on Hetzner's
documented behaviour rather than on a recorded comparison. The AWS side of the same claim is
measured: its transcript shows the address changing across a restart.

## Writing your own provider

This package is one implementation of a frozen contract. To write another, start with
[`@rockysurf/provider-sdk`](https://github.com/amroja-biz/rockysurf/blob/main/packages/provider-sdk/README.md)
for the types and
[`docs/writing-a-provider.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/writing-a-provider.md)
for the workflow. Three things this port had to get right, each spelled out there: the server
**name** is the idempotency key (Hetzner has no `ClientToken`, so a replayed create is caught as
`uniqueness_error` and resolved to the original server), secondary resources must be tagged
`server-owned` or `shared` correctly, and `deleting` maps to `terminating` rather than `stopping`.
