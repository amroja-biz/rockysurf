<p align="center">
  <img src="docs/media/logo.png" alt="Rocky Surf" width="400">
</p>

# Rocky Surf

Rocky Surf is an open-source productivity tool for software engineers. It provides a lightweight layer for creating and managing Linux VMs running on your own cloud accounts, pre-installed with your favorite AI coding agent harnesses and GitHub repos. The only costs are the ones from your cloud and coding agents.

## Installation

Requires Node 24 or newer.

```bash
npx -y rockysurf
```

## Features

- Works with AWS, GCP, Azure and Hetzner
- Web app and MCP server, both running on your own machine
- Create, stop, start and terminate Servers on every cloud you configured, from one list
- Pre-install your favorite agent harnesses and Tools with a Surge Pack. Eleven ship in the box,
  covering Claude Code, Codex CLI, Amp, OpenCode, Gas Town, Pi and others
- Pre-load public and private GitHub repos
- Reuse your existing SSH keys, or let Rocky Surf make one for you
- Restrict which network may reach SSH on your Servers
- Server count, create-rate and spend caps, enforced server-side so they cover the web app, the
  CLI and MCP alike
- Agent Skills for writing your own Surge Packs and Providers, in this repository
- Share custom Surge Packs and Providers through the Rocky Surf Shop

## Bring your own everything

- **BYOC — bring your own cloud.** Your AWS account, your Hetzner project, Azure, GCP, or a
  machine you already own. Rocky Surf holds the credential and calls the API. The resources and
  the bill are yours.
- **BYOK — bring your own keys.** Your Claude Code subscription, your Codex login, your API keys.
  Rocky Surf installs the agents; you sign them in.
- **BYOR — bring your own repos.** Your GitHub repositories, cloned onto the box during setup
  using a token you supply.

## Rocky Surf Principles

1. **Make it as easy as possible to create and manage cloud Servers for agentic coding.**
2. **Make it as easy as possible to create and reuse Tool bundles.**
3. **Make it as easy as possible to add new cloud Providers.**
4. **Make the lives of software engineers easier.**

## Surfaces

### Local web app

Rocky Surf is a Node app that runs on your computer. You access it from localhost.
No Saas, telemetry, or sneaky phoning home.

### MCP

When running, Rocky Surf is also accessible from your coding agents as a local MCP server. 

**Mint a token**

It is printed once.

```bash
npx -y rockysurf token
```

**Install MCP in Claude Code**

```bash
claude mcp add --scope user --env ROCKYSURF_TOKEN=the-token-you-just-minted \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

**Install MCP in Codex CLI**

```bash
codex mcp add rockysurf --env ROCKYSURF_TOKEN=the-token-you-just-minted \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

**MCP Permissions**

`mcp.scopes` in the config file governs permissions. Defaults are
`[read, stop]`

```yaml
mcp:
  scopes: [read, stop]                        # read, stop and start
  # scopes: [read, stop, create]              # ...and create Servers
  # scopes: [read, stop, create, terminate]   # ...and destroy them
```

`create` and `terminate` are configurable on Rocky Surf's Settings page.

A scope you have not granted means the tool is not offered at all. Tick `create` under
**Settings → MCP**, then reconnect the MCP client.

**Basic MCP usage**

> Create a new Rocky Surf EC2 on AWS, medium size, with the OpenCode Surge Pack. Clone
> https://github.com/pyjanitor-devs/pyjanitor. Use my standard ssh key.

> Show me all running Servers.

> Stop the OpenCode EC2.

## Agent Skills

Agent skills are available in the [source code](https://github.com/amroja-biz/rockysurf) under
[`.agents/skills/`](.agents/skills/README.md), not in the npm package. Clone the repository and
any Agent Skills–compatible agent can use them.

### Examples:

_Create a Personal Surge Pack_

> Make me a Surge Pack for Hermes, https://github.com/nousresearch/hermes-agent

_Add a cloud Provider_

> Make a Rocky Surf Provider for Digital Ocean.

## Configuring Cloud Providers

Every cloud is off by default. The setup wizard will help you configure one on first run and
you can add others later in the **Settings** page in the UI. 

Rocky Surf stores no cloud credentials. Each cloud authenticates through its own auth path:

| Cloud | Where the credential comes from | Minimum config under `providers:` |
|---|---|---|
| **Hetzner** | A read/write API token from console.hetzner.com, exported as `HETZNER_TOKEN` in the environment Rocky Surf starts from. | `hetzner: { enabled: true, token: "${HETZNER_TOKEN}", location: fsn1 }` |
| **AWS** | The standard AWS credential chain — environment, `AWS_PROFILE`, `aws sso login`, or an instance role. | `aws: { enabled: true, region: us-east-1, sshAllowedCidr: "203.0.113.7/32" }` |
| **Azure** | `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`, a managed identity, or `az login`. | `azure: { enabled: true, subscriptionId: …, resourceGroup: rocky-surf-rg, location: eastus, sshAllowedCidr: "203.0.113.7/32" }` |
| **GCP** | Application Default Credentials — `gcloud auth application-default login`, or a service-account key file at `keyFile`. | `gcp: { enabled: true, projectId: my-project-123456, zone: us-central1-a, sshAllowedCidr: "203.0.113.7/32" }` |

`sshAllowedCidr` is required for AWS, Azure and GCP. More than one can be added. `curl -s https://checkip.amazonaws.com`
Add `/32` suffix to restrict access to your IP, only.

Note that some networks, like mobile hotspots or corporate networks, may route SSH traffic
through a different port than standard web traffic. If you can't ssh into your Servers from 
another network, this may be why. Here's how to find your ssh port address:
`curl http://portquiz.net:22/`

## Where your Servers and settings are kept

Files and the Rocky Surf database (sqlite3) are written to `~/.rockysurf`.

| File | Description |
|---|---|
| `rockysurf.db` | SQLite: your Servers, packs, sessions and encrypted secrets |
| `secret.key` | The master key those secrets are encrypted with |
| `rockysurf.config.yaml` | Your configuration |
| `packs/` | Your own pack files, if you keep any |

## Security

Rocky Surf listens on `127.0.0.1` only, behind one password and no TLS, and it holds your cloud
credentials and an SSH key per Server. If you widen `server.host`, put a proxy or firewall in
front. Detail: [`SECURITY.md`](SECURITY.md).

## More

Additional documentation is available on the repo.

| Document | Audience | What it covers |
|---|---|---|
| [`docs/agent-quickstart.md`](docs/agent-quickstart.md) | Your coding agent | Installing and configuring Rocky Surf on your behalf, end to end |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Operators | Install paths, data, upgrades, backup and restore |
| [`SECURITY.md`](SECURITY.md) | Operators | Credential custody, SSH trust, the MCP threat model |
| [`docs/providers/capability-matrix.md`](docs/providers/capability-matrix.md) | Operators | What each Provider can do, and the evidence for it |
| [`docs/writing-a-surge-pack.md`](docs/writing-a-surge-pack.md) | Surge Pack authors | Writing a Surge Pack - how one runs, the four rules, a worked example, the checklist |
| [`docs/surge-pack-contract.md`](docs/surge-pack-contract.md) | Surge Pack authors | The normative half - file format, rules in full, environment, the CI smoke test |
| [`docs/adr/llms.txt`](docs/adr/llms.txt) | Contributors | The architecture decisions - start here for the design |
| [`docs/writing-a-provider.md`](docs/writing-a-provider.md) | Contributors | Adding a cloud against the frozen SDK |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributors | Development setup, gates, conventions |
| [`docs/contributing/TESTING.md`](docs/contributing/TESTING.md) | Contributors | The testing strategy - every layer, where it runs, and the nightly real-cloud run |
| [`docs/contributing/RELEASING.md`](docs/contributing/RELEASING.md) | The maintainer | Publishing to npm - the procedure, and the reasons behind each step |
| [`docs/RELEASE_SOP.md`](docs/RELEASE_SOP.md) | The maintainer | The release checklist - choosing the version number, the steps in order, and what to do when a run fails |

Rocky Surf is deliberately small: no devcontainers, no throwaway per-task sandboxes, no Windows,
no multi-tenancy.

## License

[MIT](LICENSE). **The Rocky Surf name and logo are not covered by it** - fork the code freely and
give the fork its own name. See [`TRADEMARK.md`](TRADEMARK.md).
