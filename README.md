<p align="center">
  <img src="docs/media/logo.png" alt="Rocky Surf" width="400">
</p>

# Rocky Surf

<!-- HERO GIF: placeholder. Owned by rockysurf-o45s.1 — a <90s clip of compose up → switch on
     Hetzner in the wizard → pick the Claude Code pack → live install feed → ssh in → terminate. -->

Rocky Surf creates a Linux box on your own cloud account, installs your coding agents on it, and
hands you an SSH command.

## Quick Start

**Quick Start for Agents.** Have a coding agent do all of this for you — Claude Code, Codex CLI,
or any other:

1. Point your agent at
   <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/docs/agent-quickstart.md>.
2. Tell it to install and configure Rocky Surf for you.
3. Answer its questions: which cloud, which region, which network may reach SSH, what limits you
   want, and what an agent connected over MCP may do.

Your agent never touches your cloud account — it prints the commands that do, and you run them.
The rest of this Quick Start is the same install by hand.

### 1. Install

Requires Node 24 or newer.

```bash
npx -y rockysurf
```

It prints an admin password **once** on first boot — save it. Open <http://127.0.0.1:3000> and
sign in with it. It listens on `127.0.0.1` only.

With no cloud configured it runs an in-memory provider, so you can create a server, watch it boot
and terminate it before pasting a real token.

Docker Compose instead:

```bash
git clone https://github.com/amroja-biz/rockysurf
cd rockysurf
docker compose up --build
docker compose logs rockysurf | grep -A3 'first boot'   # the admin password
```

### 2. Configure a cloud

Every cloud is off until you turn it on. Use the first-run wizard, or **Settings** (one tab per
cloud), or edit the config file directly: `--config <path>`, else `./rockysurf.config.yaml`, else
`~/.rockysurf/config.yaml`. Rocky Surf prints the file it read on startup and writes Settings
changes back to it. Start from [`rockysurf.config.example.yaml`](rockysurf.config.example.yaml).

Rocky Surf stores no cloud credentials. Each cloud authenticates through its own auth path:

| Cloud | Where the credential comes from | Minimum config under `providers:` |
|---|---|---|
| **Hetzner** | A read/write API token from console.hetzner.com, exported as `HETZNER_TOKEN` in the environment Rocky Surf starts from. | `hetzner: { enabled: true, token: "${HETZNER_TOKEN}", location: fsn1 }` |
| **AWS** | The standard AWS credential chain — environment, `AWS_PROFILE`, `aws sso login`, or an instance role. | `aws: { enabled: true, region: us-east-1, sshAllowedCidr: "203.0.113.7/32" }` |
| **Azure** | `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`, a managed identity, or `az login`. | `azure: { enabled: true, subscriptionId: …, resourceGroup: rocky-surf-rg, location: eastus, sshAllowedCidr: "203.0.113.7/32" }` |
| **GCP** | Application Default Credentials — `gcloud auth application-default login`, or a service-account key file at `keyFile`. | `gcp: { enabled: true, projectId: my-project-123456, zone: us-central1-a, sshAllowedCidr: "203.0.113.7/32" }` |

`sshAllowedCidr` is required for AWS, Azure and GCP and has no default: it is which network may
reach SSH on your boxes, and a list is accepted. Your address is
`curl -s https://checkip.amazonaws.com`, as a `/32`.

AWS needs an IAM policy ([`deploy/aws/iam-role.yaml`](deploy/aws/iam-role.yaml)); Azure needs a
resource group you create yourself (`az group create --name rocky-surf-rg --location eastus`) and
a role scoped to it. Full per-cloud setup, including the least-privilege roles:
[`docs/providers/`](docs/providers/).

### 3. Configure MCP

`rockysurf mcp` exposes the server lifecycle as MCP tools. Rocky Surf itself must already be
running; the MCP server talks to it over HTTP.

Mint a token — it is printed once:

```bash
npx -y rockysurf token
```

Point your client at it. Any MCP client wants the same `command`, `args`, and `env` — Claude Code
and Codex CLI are given here as the two representative examples; the shapes below carry over to
another client. Each has a user (or global) scope, the recommended default for a tool that
manages servers regardless of which repo you're in, and a project scope for a team that wants the
server checked into the repo.

**Claude Code**, user scope:

```bash
claude mcp add --scope user --env ROCKYSURF_TOKEN=the-token-you-just-minted \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

Project scope uses this JSON object in `.mcp.json` at your project root; the same object also
works in Claude Code's user-scope file (`~/.claude.json`) and in Claude Desktop's configuration
file, which is global by nature:

```json
{
  "mcpServers": {
    "rockysurf": {
      "command": "npx",
      "args": ["-y", "rockysurf", "mcp"],
      "env": {
        "ROCKYSURF_TOKEN": "the-token-you-just-minted",
        "ROCKYSURF_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

**Codex CLI**, user scope (Codex calls it the global config — `codex mcp add` writes to
`~/.codex/config.toml`):

```bash
codex mcp add rockysurf --env ROCKYSURF_TOKEN=the-token-you-just-minted \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

Project scope is a `.codex/config.toml` at your repository root, loaded only for a project you
have marked trusted. Codex CLI reads a project-scoped file, but as of Codex CLI 0.153 `codex mcp
add` has no flag to write one there — add this table by hand:

```toml
[mcp_servers.rockysurf]
command = "npx"
args = ["-y", "rockysurf", "mcp"]
env = { ROCKYSURF_TOKEN = "the-token-you-just-minted", ROCKYSURF_URL = "http://127.0.0.1:3000" }
```

The token grants nothing by itself. What an agent may do is `mcp.scopes` in the config file,
which defaults to `[read, stop]`:

```yaml
mcp:
  scopes: [read, stop]                        # read, stop and start
  # scopes: [read, stop, create]              # ...and create servers
  # scopes: [read, stop, create, terminate]   # ...and destroy them
```

A scope you have not granted means the tool is not offered at all — an agent reporting no
`create_server` is reporting this setting. Tick `create` under **Settings → MCP**, then reconnect
the MCP client; the scopes are read when your client starts `rockysurf mcp`.

## What Rocky Surf is

One process you run yourself (web UI, HTTP API, SQLite file). One admin, no accounts, no
telemetry, nothing hosted. Stop a box tonight, start it tomorrow: your repo, your branches and
your shell history are where you left them. A stopped box costs storage, not compute.

## Bring your own cloud, keys and repos

- **BYOC — bring your own cloud.** Your AWS account, your Hetzner project, Azure, GCP, or a
  machine you already own. Rocky Surf holds the credential and calls the API. The resources and
  the bill are yours.
- **BYOK — bring your own keys.** Your Claude Code subscription, your Codex login, your API keys.
  Rocky Surf installs the agents; you sign them in.
- **BYOR — bring your own repos.** Your GitHub repositories, cloned onto the box during setup
  using a token you supply.

Rocky Surf resells nothing and sits in the middle of nothing. It won't proxy your cloud spend,
pool your API keys, or hold your code, and features that would need it to get refused.

## Rocky Surf Principles

1. **Make it as easy as possible to create and manage cloud servers for agentic coding.**
2. **Make it as easy as possible to add a new cloud provider.**
3. **Make it as easy as possible to create Surge Packs.**
4. **Make Rocky Surf easy to extend via modular components.**
5. **Make it easy to combine components without coding.**

## Creating a server

**A create can fail because your cloud login expired.** AWS, Azure and GCP use the same
credentials as the rest of your tooling, and for most people those expire: `aws sso login`,
`az login`, `gcloud auth application-default login`. Hetzner's token is long-lived.

### Pick a Surge Pack

A **Surge Pack** is a software bundle that gets installed on your box, defined in a YAML file:

```yaml
version: 1
pack:  { packId: rust-dev, name: Rust, tools: [build-essential, git, rustup] }
tools: [ … ]
```

It's just a list of tools and install scripts. You can read the whole file in a pull request
before trusting it, and you watch the install feed while your box is built from it. Eleven ship
in [`packs/`](packs/), covering Claude Code, Codex CLI, Amp, OpenCode, Gas Town, Pi and others.

Each pack carries a `guide`, shown once the box is running. No credential of yours reaches a box
during bootstrap, so the guide is where a pack tells you how to sign the agents in.

Scripts must be idempotent, architecture-aware and non-interactive; CI runs every shipped pack
twice, on amd64 and arm64. The guide is
[`docs/writing-a-surge-pack.md`](docs/writing-a-surge-pack.md) and the normative contract is
[`docs/surge-pack-contract.md`](docs/surge-pack-contract.md), or let the repo's `create-surge-pack`
Agent Skill write yours — any Agent Skills–compatible agent, Claude Code and Codex CLI included.
Clone the repository to use it; the skills live only there, not in the published npm package. See
[`.agents/skills/README.md`](.agents/skills/README.md) for the full procedure.

### Connect a GitHub repo

The create form's **Repositories** field takes one git URL per line, cloned into the box's home
directory. Public URLs clone anonymously; private ones need a GitHub token, and Settings takes one
two ways:

- **Connect GitHub** - press the button, enter the code it shows on github.com, approve. It asks
  for the `repo` scope: read and write on every repository the account can reach. The token is
  stored encrypted (it never lands in the config file). You register the OAuth App yourself; Rocky
  Surf ships none of its own, because whoever registers one can revoke its tokens.
- **Access tokens** - paste a personal access token. One covers everything, or add tokens per
  repository, owner or host; most specific wins. These land in the config file, so treat it as a
  credential, or point it at `${GITHUB_PAT}`.

Packs read the token as `$GITHUB_TOKEN`, kept out of `ps` output and `.git/config`.

## Where your servers and settings are kept

One directory holds everything: `~/.rockysurf`, `/data` in the container, `server.dataDir` in
general. Created owner-only on first boot.

| File | What it is |
|---|---|
| `rockysurf.db` | SQLite: your servers, packs, sessions and encrypted secrets |
| `secret.key` | The master key those secrets are encrypted with |
| `rockysurf.config.yaml` | Your configuration |
| `packs/` | Your own pack files, if you keep any |

**Back up the whole directory** (the database and the key are useless without each other), and
**stop the process first**: the database runs in WAL mode, and copying it live can silently lose
the last few minutes.

```bash
tar czf rockysurf-backup-$(date +%F).tar.gz -C ~ .rockysurf

# Docker Compose: stop, then tar the volume out
docker run --rm -v rockysurf-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/rockysurf-backup-$(date +%F).tar.gz -C /data .
```

If you can't stop it, use SQLite's online backup (`sqlite3 rockysurf.db ".backup out.db"`) and
copy `secret.key` alongside. Restoring is putting the directory back; migrations run on boot.

**The backup holds every provider credential and every server's private key**, next to the key
that decrypts them. Encrypt it, or keep `secret.key` outside the filesystem with
`ROCKYSURF_SECRET_KEY`. And **`docker compose down -v` destroys the volume**, taking the SSH keys
for boxes that may still be running and billing.

## Put a safety net under your cloud account

Rocky Surf enforces guardrails server-side, so they cover the web UI, the CLI and the MCP tools
alike:

```yaml
limits:
  maxServers: 5
  createRatePerHour: 4
  spendCap:
    amount: 50
    currency: USD
```

Set them, but don't stop there. The spend cap is an estimate from bundled price data, and an
offering your provider quotes no price for spends money the cap can't see. Hitting the cap blocks
new servers without stopping running ones - a budget cap, not a sandbox.

Set limits at the cloud too, where the numbers come from your actual bill:

- **Billing alerts and budgets.** AWS Budgets and Cost Anomaly Detection; Azure Cost Management;
  GCP billing alerts. Most notify rather than stop, so set the threshold well below the number
  that would hurt.
- **A blast radius you chose.** Give Rocky Surf its own AWS account, Azure subscription, GCP or
  Hetzner project, and a mistake costs you that project and nothing else.
- **A credential that can only do this job.** The AWS role in
  [`deploy/aws/iam-role.yaml`](deploy/aws/iam-role.yaml), and the least-privilege roles in the
  provider docs.
- **An occasional look at the console.** Rocky Surf flags disagreements between its records and
  the cloud's, but it only knows about resources it created.

## Security

Rocky Surf listens on `127.0.0.1` only, behind one password and no TLS, and it holds your cloud
credentials and an SSH key per server. If you widen `server.host`, put a proxy or firewall in
front. Detail: [`SECURITY.md`](SECURITY.md).

## More

Every document below opens with the audience it was written for.

| Document | Audience | What it covers |
|---|---|---|
| [`docs/agent-quickstart.md`](docs/agent-quickstart.md) | Your coding agent | Installing and configuring Rocky Surf on your behalf, end to end |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Operators | Install paths, data, upgrades, backup and restore |
| [`SECURITY.md`](SECURITY.md) | Operators | Credential custody, SSH trust, the MCP threat model |
| [`docs/providers/capability-matrix.md`](docs/providers/capability-matrix.md) | Operators | What each provider can do, and the evidence for it |
| [`docs/writing-a-surge-pack.md`](docs/writing-a-surge-pack.md) | Surge pack authors | Writing a surge pack - how one runs, the four rules, a worked example, the checklist |
| [`docs/surge-pack-contract.md`](docs/surge-pack-contract.md) | Surge pack authors | The normative half - file format, rules in full, environment, the CI smoke test |
| [`docs/adr/llms.txt`](docs/adr/llms.txt) | Contributors | The architecture decisions - start here for the design |
| [`docs/writing-a-provider.md`](docs/writing-a-provider.md) | Contributors | Adding a cloud against the frozen SDK |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributors | Development setup, gates, conventions |
| [`docs/contributing/TESTING.md`](docs/contributing/TESTING.md) | Contributors | The testing strategy - every layer, where it runs, and the nightly real-cloud run |
| [`docs/contributing/RELEASING.md`](docs/contributing/RELEASING.md) | The maintainer | Publishing to npm - the procedure, and the reasons behind each step |

Rocky Surf is deliberately small: no devcontainers, no throwaway per-task sandboxes, no Windows,
no multi-tenancy.

## License

[MIT](LICENSE). **The Rocky Surf name and logo are not covered by it** - fork the code freely and
give the fork its own name. See [`TRADEMARK.md`](TRADEMARK.md).
