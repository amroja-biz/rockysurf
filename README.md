<p align="center">
  <img src="docs/media/logo.png" alt="Rocky Surf" width="400">
</p>

# Rocky Surf

**Persistent cloud dev boxes for coding agents, on your own cloud account, under your own budget
cap.** One process you run yourself. It creates a real Linux server, installs your coding agents
on it, and hands you an SSH command — then stops the box when you are done and starts it again
tomorrow with everything still there.

**BYOC, BYOK, and BYOR**: bring your own cloud, your own AI coding keys, your own repos.
Rocky Surf just makes it easy to stand up boxes on a cloud of your choice, with your favorite
coding agents and your GitHub repos — it resells nothing and holds nothing of yours.

Five principles govern every feature: **[CORE-PRINCIPLES.md](CORE-PRINCIPLES.md)**. Read it
before proposing or building anything.

<!-- HERO GIF: placeholder. Owned by rockysurf-o45s.1 — a <90s clip of compose up → paste a
     Hetzner token → pick the Claude Code pack → live install feed → ssh in → terminate. -->

---

## Why

Coding agents want a machine. Not a container that dies with the tab, and not your laptop.

- **Persistent.** Stop a box and its disk survives; start it and your repo, your branches, your
  half-finished work and your shell history are where you left them. Stopped boxes cost storage,
  not compute.
- **Yours.** Single admin, no accounts, no tenant, no telemetry, no hosted anything. The control
  plane is one Node process with a SQLite file next to it.
- **Your cloud.** Your AWS account, your Hetzner project, or a machine you already own. Rocky
  Surf holds the credential and calls the API; the resources and the bill are yours.
- **Agents preloaded.** A box is created *from a Surge Pack* — Claude Code, Codex CLI, Amp and friends
  are installed and ready before you first log in, instead of after twenty minutes of `apt`.
- **Budget-capped.** Server count, creates-per-hour and estimated monthly spend are enforced
  server-side, which is what makes it safe to hand an agent the MCP tools and let it create its
  own box.

## Quickstart

Docker Compose, from a checkout. This works today, with no npm publish involved:

```bash
git clone https://github.com/amroja-biz/rockysurf
cd rockysurf
docker compose up --build
```

It prints an admin password **once** (`docker compose logs rockysurf | grep -A3 'first boot'`).
Open <http://127.0.0.1:3000>, sign in, and the first-run wizard asks for a cloud credential.

Once v0.1.0 is on npm, the same thing without a checkout:

```bash
npx rockysurf
```

> **Not yet published.** The `npx` path needs the nine packages on the public registry, which
> happens at the v0.1.0 launch — see [`docs/RELEASING.md`](docs/RELEASING.md). Until then, use
> the Compose path above, or run `pnpm -r build` in a checkout and start
> `node packages/rockysurf/dist/bin.js` — the same binary `npx` will fetch.

Requires Node 24 or newer for the `npx` path; the Compose image brings its own. With no cloud
configured it still comes up on an in-memory provider, so you can create a server, watch it boot
and terminate it before deciding whether to paste a real token.

Full instructions, including where the data lives and what to back up:
[`docs/self-hosting.md`](docs/self-hosting.md).

## Providers

You bring the cloud. Every provider is disabled until you enable it, so a fresh install cannot
spend money by accident.

| Provider | What it is | Stop/start | Host key | Docs |
|---|---|---|---|---|
| **Hetzner** | Hetzner Cloud, plain REST — the cheapest way to start | yes, IP survives | minted before boot | [`docs/providers/hetzner.md`](docs/providers/hetzner.md) |
| **AWS** | EC2 via `RunInstances`, no CloudFormation | yes, **public IP changes** | minted before boot | [`docs/providers/aws.md`](docs/providers/aws.md) |
| **Azure** | ARM REST, no vendor SDK; one resource group you own | yes, IP survives | minted before boot* | [`docs/providers/azure.md`](docs/providers/azure.md) |
| **GCP** | Compute Engine v1 REST, no vendor SDK | yes, **public IP changes*** | minted before boot | [`docs/providers/gcp.md`](docs/providers/gcp.md) |
| **BYO** | Machines you already have, managed over SSH | **no** — not our power state | trust-on-first-use, or pin it | [`docs/providers/byo.md`](docs/providers/byo.md) |

The full table, with what each value was measured against, is in
[`docs/providers/capability-matrix.md`](docs/providers/capability-matrix.md). Writing your own is
[`docs/writing-a-provider.md`](docs/writing-a-provider.md).

**\* Azure and GCP are newer than the rest, and they are no longer newer in the same way.**
**GCP has now been run against real Compute Engine** — create, bootstrap and terminate on both
architectures, with the host key core minted presented on first contact and no orphans left
behind — so its host-key claim is measured. What that run never did is stop and start a box, so
GCP's stop/start row and its "public IP changes" are still reasoned rather than observed.
**Azure has had no run against real infrastructure at all**; its values are reasoned from
Microsoft's documentation and enforced by tests against an in-memory cloud, and its host-key
claim is expected rather than measured. The capability matrix marks exactly which values are
which.

**On BYO specifically:** claiming one of your machines creates a `rocky` account on it with
passwordless sudo and appends Rocky Surf's key to that account's `authorized_keys`. Releasing the
host **does not undo that** — `terminate` gives the host back to the pool and deliberately runs
nothing on a machine Rocky Surf does not own. Remove the account yourself if you want it gone.

## Surge Packs

A **Surge Pack** is the software a box is created with, written as YAML and reviewable in a pull
request:

```yaml
version: 1
pack:  { packId: rust-dev, name: Rust, tools: [build-essential, git, rustup] }
tools: [ … ]
```

Six ship in [`packs/`](packs/README.md): `ai-coding-agents` (Claude Code), `amp-agents`,
`codex-cli`, `gas-town`, `open-claw` and `open-code`. They share one base toolchain by
referencing tool ids rather than redefining them.

Each one also carries a `guide`: the post-boot instructions its own author wrote, shown on the
server's page the moment the box is running. No credential of yours reaches a box during
bootstrap, so this is where a pack tells you how to sign the agents in — and where it admits
anything the install could not finish on your behalf.

Every install script must be idempotent, `$ARCH`-aware, non-interactive and honest about which
user it runs as. The mechanical half of that is checked on every test run against the shipped
pack files (`packages/core/src/packs/packs.test.ts`): no hardcoded architectures, no `apt-get
install` without `-y`, no `sudo` inside a `runAs: rocky` script, no unguarded append to a file.
Idempotency is the rule that catches people out, and the harness proves it: every shipped
pack's scripts run **twice in the same container**, on amd64 and arm64, with the resume journal
discarded between runs (`scripts/pack-smoke.mjs`, run by CI on every pull request — and
runnable locally with one command per pack).

The authoring contract is [`docs/writing-a-pack.md`](docs/writing-a-pack.md). If you use Claude
Code you can hand that contract to your own session instead of reading it: this repository ships
the [`creating-surge-packs`](.claude/skills/creating-surge-packs/) Agent Skill, which a session
started in a checkout picks up with no install step. Describe the box you want and it interviews
you, writes the file, and drives the same loader test and smoke harness CI does.

## Agents can drive it

`rockysurf mcp` exposes the lifecycle as MCP tools, so an agent can create, inspect, stop and
destroy its own boxes. It speaks HTTP to the control plane exactly as a browser does, so every
limit applies to it by construction — there is no second code path.

Scopes come from your config file, not from the MCP client's launch command, and default to
`[read, stop]`. `create` and `terminate` are separate opt-in scopes: making a box costs money,
destroying one costs work, and only one of those is recoverable.

The honest claim is **budget-capped, not sandboxed**. What that does and does not protect against
is written out in [`SECURITY.md`](SECURITY.md#the-mcp-server-threat-model).

## How it compares to Coder

[Coder](https://coder.com) is a mature, multi-user workspace platform with Terraform templates,
RBAC and an enterprise story; Rocky Surf is a single-admin binary that does one much smaller
thing — persistent agent boxes on your own cloud, with a spend cap and an MCP surface — and if
you need teams, templates or SSO today, use Coder.

## Non-goals

Stated so nobody deploys this expecting them:

- **Not devcontainers.** A box is a whole machine with a persistent disk, not a container
  definition tracked in your repo. There is no `devcontainer.json` support and none planned.
- **Not ephemeral sandboxes.** Rocky Surf optimises for boxes that live for weeks. If you want
  per-task throwaway compute that boots in a second, this is the wrong shape.
- **Not Windows targets.** The boxes are Ubuntu 24.04; every pack is `apt`-based and the
  bootstrap agent assumes systemd and POSIX. Windows dev boxes are not supported.
- **Not multi-tenant.** One admin, one password, no privilege separation inside the process. Do
  not put it in front of a team and treat the login as a boundary.

## Security

The control plane holds your cloud credentials and an SSH private key for every server it
creates. Briefly:

- **It listens on `127.0.0.1` by default.** There is no TLS of its own and one password in front
  of the UI. Widening `server.host` is a deliberate act that should be paired with a reverse
  proxy or a firewall.
- **Secrets are sealed with AES-256-GCM** under a master key in `<dataDir>/secret.key` (or
  `ROCKYSURF_SECRET_KEY`). **Back that file up** — losing it means recreating every server.
- **No HTTP route returns decrypted secret material**, with exactly one audited, ownership-checked
  exemption: downloading the private key for a server you own. A test enforces the rule against
  the source tree rather than trusting review.
- **Host keys are pinned with no trust-on-first-use window** on both clouds — core mints the
  host key before the instance exists and verifies it on the first connection, which is the one
  carrying secrets.

Everything above in full, plus the residual risks and how to report a vulnerability:
[`SECURITY.md`](SECURITY.md).

## Provenance

Rocky Surf started as a hosted, AWS-serverless product and was rewritten as a portable
self-hosted control plane. That rewrite was preceded by a throwaway de-risking spike that built
and destroyed real servers on two clouds before any interface was frozen; its findings memo
became [the ADRs](docs/adr/llms.txt), and its transcripts are still in
[`spike/recordings/`](spike/recordings/). The claims in the capability matrix are measurements
from those runs, not intentions — and the one column with no real-infrastructure run behind it
says so. The development story, warts included, is in
[`docs/history/DEVLOG.md`](docs/history/DEVLOG.md).

## Roadmap

Wanted, deliberately not in v0.1:

- **Idle auto-stop** — stop a box that nobody has touched, which is the single biggest saving
  left on the table.
- **More providers** — GCP and DigitalOcean, against the same frozen SDK.
- **A GitHub App** — so repo access does not mean pasting a personal access token.
- **Multi-user** — real accounts and per-user ownership, rather than one admin password.

## Contributing

Development setup, the gates, and how the pieces fit: [`CONTRIBUTING.md`](CONTRIBUTING.md).

```bash
pnpm install
pnpm run check      # lint + typecheck + test across the workspace
```

The one architectural rule worth knowing before you read the code: **`@rockysurf/core` may import
`@rockysurf/provider-sdk` and nothing else from this workspace.** Providers are loaded at runtime
through configuration, and [`scripts/check-core-deps.mjs`](scripts/check-core-deps.mjs) enforces
it in CI rather than in review.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/self-hosting.md`](docs/self-hosting.md) | Running it: both install paths, data, upgrades, backup and restore |
| [`SECURITY.md`](SECURITY.md) | Credential custody, SSH trust, network defaults, the MCP threat model, reporting |
| [`docs/adr/llms.txt`](docs/adr/llms.txt) | Index of architecture decisions — start here for the design |
| [`docs/providers/capability-matrix.md`](docs/providers/capability-matrix.md) | What each provider can do, and the evidence |
| [`docs/providers/hetzner.md`](docs/providers/hetzner.md) | Hetzner: the token, locations and arm64 stock, what terminate leaves behind |
| [`docs/providers/aws.md`](docs/providers/aws.md) | AWS: the minimal IAM policy, credentials, SSH access |
| [`docs/providers/azure.md`](docs/providers/azure.md) | Azure: the least-privilege role, credentials, what terminate deletes |
| [`docs/providers/byo.md`](docs/providers/byo.md) | BYO: claiming a host, host keys, what release leaves behind |
| [`docs/writing-a-provider.md`](docs/writing-a-provider.md) | Adding a compute provider against the frozen SDK |
| [`docs/writing-a-pack.md`](docs/writing-a-pack.md) | The pack-author contract — normative, CI-enforced |
| [`.claude/skills/`](.claude/skills/README.md) | Agent Skills that teach a Claude Code session these contracts — live in a checkout, no install |
| [`docs/RELEASING.md`](docs/RELEASING.md) | Publishing the nine packages to npm |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, gates, conventions |

## License

[MIT](LICENSE).

**The Rocky Surf name and logo are not covered by the MIT license.** Fork the code freely; give
the fork its own name. See [`TRADEMARK.md`](TRADEMARK.md).
