<p align="center">
  <img src="docs/media/logo.png" alt="Rocky Surf" width="400">
</p>

# Rocky Surf

<!-- HERO GIF: placeholder. Owned by rockysurf-o45s.1 — a <90s clip of compose up → paste a
     Hetzner token → pick the Claude Code pack → live install feed → ssh in → terminate. -->

Rocky Surf gives coding agents a real Linux server that stays put. It creates the box on your own
cloud account, installs your agents before you first log in, and hands you an SSH command. Stop it
tonight, start it tomorrow: your repo, your branches and your shell history are where you left
them. A stopped box costs storage, not compute.

One process you run yourself — web UI, HTTP API, SQLite file. One admin, no accounts, no
telemetry, nothing hosted.

## Bring your own cloud, keys and repos

- **BYOC — bring your own cloud.** Your AWS account, your Hetzner project, Azure, GCP, or a
  machine you already own. Rocky Surf holds the credential and calls the API. The resources and
  the bill are yours.
- **BYOK — bring your own keys.** Your Claude Code subscription, your Codex login, your API keys.
  Rocky Surf installs the agents; you sign them in.
- **BYOR — bring your own repos.** Your GitHub repositories, cloned onto the box during setup
  using a token you supply.

Rocky Surf resells nothing and sits in the middle of nothing. Proxying your cloud spend, pooling
your API keys, holding your code — out of bounds by definition, not by preference.

## Five principles

Every issue and pull request should name the principle it serves. Long version:
[CORE-PRINCIPLES.md](CORE-PRINCIPLES.md).

1. **Make it as easy as possible to create and manage cloud servers for agentic coding.** The
   distance between "I want a box" and "I am SSH'd into a box with my agents installed" is the
   number we are always shrinking.
2. **Make it as easy as possible to add a new cloud provider.** A new cloud is one package and one
   config block, never a change to core.
3. **Make it as easy as possible to create Surge Packs.** A pack is one YAML file. No
   registration, no gatekeeping, no build step.
4. **Make Rocky Surf easy to extend via modular components.** Extension happens behind seams — the
   provider SDK, packs as data, thin clients over one API — not through them.
5. **Make it easy to combine components without coding.** Composition is configuration. An
   operator wires up providers and caps spending without touching TypeScript.

## Install

Docker Compose, from a checkout — the path that works today:

```bash
git clone https://github.com/amroja-biz/rockysurf
cd rockysurf
docker compose up --build
```

It prints an admin password once:

```bash
docker compose logs rockysurf | grep -A3 'first boot'
```

Open <http://127.0.0.1:3000> and sign in with it. `npx rockysurf` (Node 24 or newer) arrives with
v0.1.0.

With no cloud configured you get an in-memory provider: create a server, watch it boot, terminate
it, before pasting a real token.

### Configuration

Settings live in one YAML file — `--config <path>`, else `./rockysurf.config.yaml`, else
`~/.rockysurf/config.yaml`. Rocky Surf prints the one it used and writes web-UI changes back to
it. Start from [`rockysurf.config.example.yaml`](rockysurf.config.example.yaml), where every value
is the default. Under Docker the live file is in the `rockysurf-data` volume, not your checkout.

Rocky Surf listens on `127.0.0.1` only, behind one password and no TLS, and it holds your cloud
credentials and an SSH key per server — widen `server.host` and put a proxy or firewall in front.
Detail: [`docs/self-hosting.md`](docs/self-hosting.md) and [`SECURITY.md`](SECURITY.md).

## Creating a server

### Pick a provider

Every provider ships switched off, so a fresh install cannot spend money by accident.

| Provider | Getting the credential |
|---|---|
| **Hetzner** | Quickest start. Mint a read/write API token at console.hetzner.com and export it. |
| **AWS** | The standard credential chain. Needs an IAM policy and an explicit `sshAllowedCidr`. |
| **Azure** | Environment, managed identity, or `az login`. Needs a resource group and a least-privilege role. |
| **GCP** | Application Default Credentials. Needs a project and an explicit `sshAllowedCidr`. |
| **BYO** | Machines you already have, over SSH. No cloud API. |

**A create can fail because your cloud login expired.** AWS, Azure and GCP use the same
credentials as the rest of your tooling, and for most people those expire: `aws sso login`,
`az login`, `gcloud auth application-default login`. Hetzner's token is long-lived. Setup per
provider: [`docs/providers/`](docs/providers/).

### Pick a Surge Pack

A **Surge Pack** is the software your box is built with, one YAML file:

```yaml
version: 1
pack:  { packId: rust-dev, name: Rust, tools: [build-essential, git, rustup] }
tools: [ … ]
```

A readable list of tools and install scripts — reviewable in a pull request, not baked into
someone else's image — and your box is built from it while you watch the install feed. Ten ship in
[`packs/`](packs/), covering Claude Code, Codex CLI, Amp, OpenCode, Gas Town and others.

Each pack carries a `guide`, shown once the box is running. No credential of yours reaches a box
during bootstrap, so that is where a pack tells you how to sign the agents in.

Scripts must be idempotent, architecture-aware and non-interactive; CI runs every shipped pack's
twice, on amd64 and arm64. Contract: [`docs/writing-a-pack.md`](docs/writing-a-pack.md) — or let
the repo's Claude Code skill write yours.

### Connect a GitHub repo

The create form's **Repositories** field takes one git URL per line, cloned into the box's home
directory. Public URLs clone anonymously; private ones need a GitHub token, and Settings takes one
two ways:

- **Connect GitHub** — press the button, enter the code it shows on github.com, approve. It asks
  for the `repo` scope: read and write on every repository the account can reach. The token is
  stored encrypted, not in the config file. You register the OAuth App yourself; Rocky Surf ships
  none of its own, because whoever registers one can revoke its tokens.
- **Access tokens** — paste a personal access token. One covers everything, or add tokens per
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

**Back up the whole directory** — the database and the key are useless without each other — and
**stop the process first**, because the database runs in WAL mode and copying it live can silently
lose the last few minutes.

```bash
tar czf rockysurf-backup-$(date +%F).tar.gz -C ~ .rockysurf

# Docker Compose: stop, then tar the volume out
docker run --rm -v rockysurf-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/rockysurf-backup-$(date +%F).tar.gz -C /data .
```

If you cannot stop it, use SQLite's online backup (`sqlite3 rockysurf.db ".backup out.db"`) and
copy `secret.key` alongside. Restoring is putting the directory back; migrations run on boot.

**The backup holds every provider credential and every server's private key**, next to the key
that decrypts them — so encrypt it, or keep `secret.key` outside the filesystem with
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

Set them, but do not stop there. The spend cap is an estimate from bundled price data, not a bill:
an offering your provider quotes no price for spends money the cap cannot see. And hitting it
blocks new servers without stopping running ones — a budget cap, not a sandbox.

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

## More

| Document | What it covers |
|---|---|
| [`docs/self-hosting.md`](docs/self-hosting.md) | Install paths, data, upgrades, backup and restore |
| [`SECURITY.md`](SECURITY.md) | Credential custody, SSH trust, the MCP threat model |
| [`docs/adr/llms.txt`](docs/adr/llms.txt) | The architecture decisions — start here for the design |
| [`docs/providers/capability-matrix.md`](docs/providers/capability-matrix.md) | What each provider can do, and the evidence for it |
| [`docs/writing-a-pack.md`](docs/writing-a-pack.md) | The pack-author contract |
| [`docs/writing-a-provider.md`](docs/writing-a-provider.md) | Adding a cloud against the frozen SDK |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, gates, conventions |

Rocky Surf is deliberately small: no devcontainers, no throwaway per-task sandboxes, no Windows,
no multi-tenancy. `rockysurf mcp` exposes the lifecycle as MCP tools, so an agent can create,
inspect, stop and destroy its own boxes — `create` and `terminate` are separate opt-in scopes.

## License

[MIT](LICENSE). **The Rocky Surf name and logo are not covered by it** — fork the code freely and
give the fork its own name. See [`TRADEMARK.md`](TRADEMARK.md).
