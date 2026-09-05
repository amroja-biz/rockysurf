# @rockysurf/provider-digitalocean

DigitalOcean droplets for [Rocky Surf](https://github.com/amroja-biz/rockysurf), driven with a
personal access token over the public REST API — plain `fetch`, no vendor library, and no runtime
dependencies of any kind. It creates droplets, one cloud firewall that decides who may reach SSH,
and the SSH key objects a create has to reference; it reaps what it created. It does not manage
DigitalOcean projects, load balancers, volumes, reserved IPs or databases, and it will not create
its firewall from a settings save.

**A provider runs with Rocky Surf's full access — install ones you trust.**

## How you get it

This is a *personal* provider: it is not shipped inside the `rockysurf` CLI, and installing it is
two steps — put the package under your data directory, then name it in your config file.

Either install it with npm:

```sh
mkdir -p ~/.rockysurf/providers
cd ~/.rockysurf/providers
npm init -y
npm install @rockysurf/provider-digitalocean
```

…or extract a tarball, with no package manager at all:

```sh
mkdir -p ~/.rockysurf/providers/node_modules/@rockysurf/provider-digitalocean
tar -xzf rockysurf-provider-digitalocean-0.1.0.tgz \
  -C ~/.rockysurf/providers/node_modules/@rockysurf/provider-digitalocean --strip-components=1
```

Both work because **the tarball is self-contained**: the package declares no runtime dependencies,
and the SDK helpers it uses are bundled into `dist/index.js` at build time. There is nothing left
to resolve after the extraction, which is what lets an installer that never runs npm accept it.

Then a section in `rockysurf.config.yaml`, and a restart:

```yaml
providers:
  digitalocean:
    package: "@rockysurf/provider-digitalocean"
    enabled: true
    token: "${DIGITALOCEAN_TOKEN}"
    region: nyc3
    sshAllowedCidr:
      - "203.0.113.7/32"
```

The data directory is `~/.rockysurf` by default and `/data` in the container, so `npx
rockysurf@latest`, a `git pull`, and a Docker image rebuild all leave the installed provider where
it is.

## Configuration

Every field the section accepts, from `src/config.ts` — which is the schema that actually parses
it. `enabled`, `package` and `sizes` are Rocky Surf's own fields and belong to every provider
section.

| field | required | default | what it is |
|---|---|---|---|
| `token` | yes | — | The DigitalOcean personal access token, read/write. Write `"${DIGITALOCEAN_TOKEN}"` — the variable's name — rather than the token itself |
| `region` | yes | — | The region droplets are created in: `nyc3`, `fra1`, `lon1`, `sgp1`… There is deliberately no default |
| `sshAllowedCidr` | yes | — | The networks allowed to reach port 22, as a list of IPv4 CIDRs. A bare string is read as a list of one |
| `allowAllCidr` | no | `false` | The second act required before `0.0.0.0/0` is accepted anywhere in that list |
| `image` | no | `ubuntu-24-04-x64` | The image slug droplets boot from. It has to be a cloud-init image |
| `firewallName` | no | `rockysurf-ssh` | The name of the one cloud firewall this provider owns and rewrites |
| `managedBy` | no | `rockysurf` | The `managed-by` tag value it stamps on everything and refuses to disagree with |
| `vpcUuid` | no | — | The VPC new droplets join. Left out, they join the region's default VPC |

## Credentials

The token comes from the config file first and from the environment second, and Rocky Surf keeps
no copy of it anywhere. `token: "${DIGITALOCEAN_TOKEN}"` in the file is the form to prefer: it is
the one an operator can see, diff and roll back. With the field left empty, the token is read from
`DIGITALOCEAN_TOKEN` in the environment of the Rocky Surf process — which means a variable exported
after boot takes effect at the next restart, because a variable cannot appear inside a running
process.

Mint the token at **API → Tokens** in the DigitalOcean control panel, with read **and** write
scope. A read-only token authenticates and then fails at the first create.

## What it needs in your account

- A region that sells the sizes you want. `validateCredentials()` fails with the list of real
  region slugs if the configured one does not exist, and reports `capacity` if it exists and is
  closed to new droplets.
- Nothing else pre-created. The provider makes its own firewall at the first launch and its own SSH
  key objects per server.

Two documented DigitalOcean limits are worth knowing before you scale up, because this provider
does not work around either:

- **A firewall holds up to 50 rules in total, and a rule's `Sources` field up to 1,000 entries.**
  This provider writes exactly one inbound rule, so the CIDR list is bounded by the second number.
- **"You can have a maximum of 10 Droplets per firewall and 5 tags per firewall."** The firewall
  targets the `managed-by` tag rather than individual droplets, which is one tag; the droplet
  figure is DigitalOcean's and an installation that outgrows it needs a second firewall this
  provider will not create for you.

## Capabilities

The values `ProviderCapabilities` declares in `src/provider.ts`, and what each costs you. **Every
one is read from DigitalOcean's documentation. None has been observed against the real API** — see
Verified.

| capability | value | what it means here |
|---|---|---|
| `stop` | `true` | `shutdown` and `power_on` droplet actions, disk intact |
| `billsWhileStopped` | `true` | **A powered-off droplet still costs the full hourly rate.** "You are still billed for bundled-plan CPU Droplets that are powered off because the compute resources stay reserved on the hypervisor… To end billing, destroy the Droplet." Rocky Surf's meter keeps running through `stopped`, the server page says so, and the New Server page warns before the machine exists |
| `ipStableAcrossStop` | `true` | "The IPv4 and IPv6 addresses assigned to a Droplet remain static for the life of the Droplet." Stop and start, and the address you had is the address you have |
| `canInjectHostKeys` | `true` | The box comes up presenting a host key Rocky Surf minted, carried in cloud-init user data, so the first connection — the one holding the secrets file — is verified rather than trusted on sight |
| `userDataMaxBytes` | `65536` | DigitalOcean's create endpoint documents `user_data` as "plain text and may not exceed 64 KiB in size". Plain text, so that ceiling is on the rendered document with no encoding step to allow for |
| `generatesUserData` | `true` | cloud-init on the official Ubuntu images |
| `managesSshAccess` | `true` | One cloud firewall, named by `firewallName`, that a settings save pushes your CIDR list at without launching anything |

### Who can reach SSH

`sshAllowedCidr` is a list, required, with no default: a firewall rule is a security decision and
Rocky Surf will not infer one from whatever address you happen to have today. An empty list is
refused. `0.0.0.0/0` takes a second key, `allowAllCidr: true`, because opening SSH to the internet
is two decisions rather than one.

Saving the list pushes it. **A DigitalOcean firewall rule is `{ protocol, ports, sources }` and has
no name or description**, so there is no way to prove, CIDR by CIDR, who wrote what. Authorship
therefore belongs to the whole firewall object Rocky Surf created and named, and the sync writes
that object once, to exactly your list. Two consequences worth stating plainly:

- **Removing a network takes effect in one step.** There is no keep-or-remove prompt here, because
  there is no stamped extra to offer — the sync's `reported` and `removable` lists are always
  empty.
- **A firewall you made yourself is never the one Rocky Surf converges.** It is found by name.
  Rename `firewallName` and Rocky Surf makes and manages a different object.

A launch is different: it is additive and never revokes, so starting a box can only widen access.
The firewall is created only by a launch, never by a settings save, and it is never deleted — it is
shared by every droplet in the account, including the one you might be connected to.

It also carries permissive outbound rules, deliberately: a DigitalOcean firewall with no outbound
rules blocks all egress, and a box that cannot fetch a package fails in a way that points nowhere
near the firewall.

## Prices

**Live, in US dollars.** `GET /v2/sizes` returns `price_hourly` inline on the very call
`listOfferings()` already makes, so preferring a bundled table would mean showing a number known to
be staler, having saved no request. Each price is stamped with the moment it was read. A size whose
price the API does not carry is reported as unknown, never as free.

DigitalOcean sells no arm64 droplets, so every size reported is `amd64`. Sizes that are listed for
your region but not orderable are reported as unavailable rather than hidden, so "this cloud has no
ARM" and "this size is sold out" stay different answers.

## Verified

**Nothing in this package has been run against the real DigitalOcean API.** It was written from
DigitalOcean's published documentation and its public OpenAPI description, read on 2026-09-04, and
tested against a fake of that API. Every value in the table above and every value in Rocky Surf's
capability matrix is therefore marked as reasoned rather than measured. A fake asserts that the
provider does what its author believed; only real infrastructure asserts that the belief was right.

### How to verify live

With a read/write token in `DIGITALOCEAN_TOKEN`, these three calls settle most of the table. None
of them creates anything.

```sh
# 1. The token, the region list, and the size catalogue with its inline hourly prices.
curl -sS -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
  'https://api.digitalocean.com/v2/sizes?per_page=200' | head -c 2000

# 2. The firewall shape: confirm an inbound rule really carries no name and no description
#    field, which is the ruling the whole sync design rests on.
curl -sS -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
  'https://api.digitalocean.com/v2/firewalls' | head -c 2000

# 3. The tag charset, which decides whether `key:value` round-trips. Creating a tag costs
#    nothing and deleting it costs nothing.
curl -sS -X POST -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"managed-by:rockysurf"}' \
  'https://api.digitalocean.com/v2/tags'
curl -sS -X DELETE -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
  'https://api.digitalocean.com/v2/tags/managed-by:rockysurf'
```

The user-data ceiling is the one cheap-looking check that is not free: settling it means posting
a real create with 65,537 bytes of user data and reading the refusal, and DigitalOcean has no
dry-run on that endpoint. Do it only if you are willing to pay for and destroy the droplet the
65,536-byte control case creates.

The rest — that `off` really is a restartable droplet, that the address survives a power cycle,
that cloud-init honours an injected host key, and that a powered-off droplet keeps billing — needs
one droplet, run through a full lifecycle, and is a nightly job rather than a curl.

## Writing your own provider

The contract is `@rockysurf/provider-sdk`: its README ships inside the tarball, and the type
definitions carry the reasoning behind every field. The workflow standard is
`docs/writing-a-provider.md` in the Rocky Surf repository, and the `adding-providers` skill walks
it end to end.
