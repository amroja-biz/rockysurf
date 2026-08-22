<p align="center">
  <img src="docs/media/logo.png" alt="Rocky Surf" width="400">
</p>

# Rocky Surf

<!-- HERO GIF: placeholder. Owned by rockysurf-o45s.1 — a <90s clip of compose up → paste a
     Hetzner token → pick the Claude Code pack → live install feed → ssh in → terminate. -->

Rocky Surf gives coding agents a real Linux server that stays put. It creates the box on your own
cloud account, installs your agents and their tools before you first log in, and hands you an SSH
command. Stop the box when you are done for the day; start it tomorrow and your repo, your
branches and your shell history are where you left them. A stopped box costs storage, not compute.

It is one process you run yourself: a web UI, an HTTP API, and a SQLite file beside them. One
admin, no accounts, no tenant, no telemetry, nothing hosted anywhere.

## Bring your own cloud, keys and repos

- **BYOC — bring your own cloud.** Your AWS account, your Hetzner project, Azure, GCP, or a
  machine you already own. Rocky Surf holds the credential and calls the API. The resources and
  the bill are yours.
- **BYOK — bring your own keys.** Your Claude Code subscription, your Codex login, your API keys.
  Rocky Surf installs the agents; you sign them in.
- **BYOR — bring your own repos.** Your GitHub repositories, cloned onto the box during setup
  using a token you supply.

Rocky Surf resells nothing and sits in the middle of nothing. Any feature that would make it a
party to those relationships — proxying your cloud spend, pooling your API keys, holding your
code — is out of bounds by definition, not by preference.

## Five principles

These five principles decide what gets built. The long version is in
[CORE-PRINCIPLES.md](CORE-PRINCIPLES.md), and issues and pull requests should name the principle
they serve.

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

Open <http://127.0.0.1:3000> and sign in with it.

Once v0.1.0 is on npm there is a second path, `npx rockysurf`, which needs Node 24 or newer. It is
not published yet — until then use Compose, or run `pnpm -r build` in a checkout and start
`node packages/rockysurf/dist/bin.js`, which is the same binary `npx` will fetch.

With no cloud configured, Rocky Surf still starts on an in-memory provider, so you can create a
server, watch it boot and terminate it before deciding whether to paste a real token.

### Configuration

Settings live in one YAML file. Rocky Surf reads the first of these it finds and prints the path
it used on startup:

1. `--config <path>`
2. `./rockysurf.config.yaml`, in the directory you ran the command from
3. `~/.rockysurf/config.yaml`

Copy [`rockysurf.config.example.yaml`](rockysurf.config.example.yaml) to one of the last two and
edit it. Every value in the example is the default, so delete whatever you do not care about.
Rocky Surf writes settings you save from the web UI back into whichever file it loaded.

Under Docker the live config is inside the `rockysurf-data` volume at
`/data/rockysurf.config.yaml`, not in your checkout. Copy it out, edit, copy it back, restart:

```bash
docker compose cp rockysurf:/data/rockysurf.config.yaml ./rockysurf.config.yaml
$EDITOR rockysurf.config.yaml
docker compose cp ./rockysurf.config.yaml rockysurf:/data/rockysurf.config.yaml
docker compose restart
```

Rocky Surf listens on `127.0.0.1` only. It holds your cloud credentials and an SSH private key for
every server it creates, and it has one password in front of it and no TLS of its own — so if you
widen `server.host`, put a reverse proxy or a firewall in front of it. Full detail:
[`docs/self-hosting.md`](docs/self-hosting.md) and [`SECURITY.md`](SECURITY.md).

## Creating a server

### Pick a provider

Rocky Surf ships every provider switched off until you enable it in the config file, so a fresh
install cannot spend money by accident.

| Provider | Getting the credential |
|---|---|
| **Hetzner** | The quickest start. Make a project at console.hetzner.com, mint a read/write API token, and export it — the config file references the environment variable. |
| **AWS** | The standard credential chain, never a key in the config file. Needs an IAM policy and an explicit `sshAllowedCidr`. |
| **Azure** | Your environment, a managed identity, or `az login`. Needs a resource group you create and a least-privilege role. |
| **GCP** | Application Default Credentials. Needs a project and an explicit `sshAllowedCidr`. |
| **BYO** | Machines you already have, driven over SSH. No cloud API involved. |

**You may need a live session with your cloud before a create will work.** AWS, Azure and GCP read
credentials from the same place the rest of your tooling keeps them, which for most people is a
login that expires: `aws sso login`, `az login`, `gcloud auth application-default login`. If that
session has lapsed, so has Rocky Surf's access, and the fix is to log in again rather than to
change anything here. Hetzner is the exception — its token is a long-lived string you paste once.

Per-provider setup, including the IAM policy and the least-privilege roles, is in
[`docs/providers/`](docs/providers/).

### Pick a Surge Pack

A **Surge Pack** is the software your box is built with, written as one YAML file:

```yaml
version: 1
pack:  { packId: rust-dev, name: Rust, tools: [build-essential, git, rustup] }
tools: [ … ]
```

A pack is a readable list of tools and their install scripts, reviewable in a pull request rather
than baked into an image someone else built months ago, and your box is assembled from it while
you watch the install feed. Ten ship in [`packs/`](packs/), covering Claude Code, Codex CLI, Amp,
OpenCode, Gas Town and others, and they share one base toolchain by referencing tool ids rather
than redefining them.

Each pack carries a `guide` its author wrote, shown on the server's page the moment the box is
running. No credential of yours reaches a box during bootstrap, so the guide is where a pack tells
you how to sign the agents in, and where it admits anything the install could not finish for you.

Every install script has to be idempotent, architecture-aware, non-interactive and honest about
which user it runs as. CI proves it the tedious way: every shipped pack's scripts run twice in the
same container, on amd64 and arm64, with the resume journal thrown away in between.

The authoring contract is [`docs/writing-a-pack.md`](docs/writing-a-pack.md), and the repository
ships a Claude Code skill that will interview you and write the file for you.

### Connect a GitHub repo

The create form has a **Repositories** field: one git URL per line, each cloned into the home
directory of the box during setup. Public URLs clone anonymously, with no credentials and nothing
to configure.

Private repositories need a GitHub token, and the Settings page takes one two ways:

- **Connect GitHub** — press the button, type the short code it shows on github.com, approve, and
  the token comes back. Nothing to export and no restart. It asks for the `repo` scope, which is
  read and write on every repository the account can reach, and Rocky Surf stores that token
  encrypted under your account instead of writing it to the config file. The button needs a GitHub
  OAuth App you register yourself, which takes about a minute — Rocky Surf ships none of its own,
  because an app somebody else registered could have its tokens revoked by them. The card walks you
  through it and stays visible, disabled, until you paste the client ID.
- **Access tokens** — paste a personal access token instead. One instance-wide token covers
  everything, and you can add a token per repository, owner or host when a fine-grained PAT only
  reaches one repo. Most specific match wins. The settings page writes these into the config file,
  so treat that file as a credential once you have used them, or point it at an environment
  variable with `${GITHUB_PAT}` and keep the token out of the file entirely.

The box receives the token in a `0600` file and clones with it in a way that keeps it out of `ps`
output and out of the checkout's `.git/config`. Packs read it as `$GITHUB_TOKEN`, which is also
the name `gh` picks up with no further setup.

## Where your servers and settings are kept

One directory holds everything Rocky Surf knows: `~/.rockysurf` by default, `/data` inside the
container, `server.dataDir` in general. Rocky Surf creates it owner-only on first boot.

| File | What it is |
|---|---|
| `rockysurf.db` | SQLite: your servers, packs, sessions and encrypted secrets |
| `secret.key` | The master key those secrets are encrypted with |
| `rockysurf.config.yaml` | Your configuration |
| `packs/` | Your own pack files, if you keep any |

**Back up the whole directory.** The database and the key are useless without each other: a
database without its key is undecryptable, and a key without its database knows nothing about your
servers.

**Stop the process before you copy it.** The database runs in WAL mode, and a clean shutdown folds
the write-ahead log back in. Copy `rockysurf.db` from a running installation and you may get a
file quietly missing the last few minutes.

```bash
# npx or from source — stop it first (Ctrl-C, or systemctl stop)
tar czf rockysurf-backup-$(date +%F).tar.gz -C ~ .rockysurf

# Docker Compose
docker compose stop
docker run --rm -v rockysurf-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/rockysurf-backup-$(date +%F).tar.gz -C /data .
docker compose start
```

If you cannot stop it, use SQLite's own online backup (`sqlite3 rockysurf.db ".backup out.db"`)
and copy `secret.key` alongside. Restoring is putting the directory back and starting up;
migrations run on boot.

**The backup holds every provider credential and every server's private key**, with the key to
decrypt them sitting in the same archive — so encrypt it, or hold `secret.key` outside the
filesystem with `ROCKYSURF_SECRET_KEY` and back up only the database. And **`docker compose down
-v` destroys the volume**, taking your credentials and the SSH keys for boxes that are still
running and still billing.

## Put a safety net under your cloud account

Rocky Surf enforces its own guardrails server-side, so they apply to the web UI, the CLI and an
agent driving the MCP tools alike:

```yaml
limits:
  maxServers: 5
  createRatePerHour: 4
  spendCap:
    amount: 50
    currency: USD
```

Those limits are worth setting, but they should not be your only defence. The spend cap is an
estimate, not a bill: it is computed from bundled price data, and an offering your provider quotes
no price for contributes real spend the cap cannot see. Hitting the cap blocks new servers without
stopping the ones already running, which is the difference between a budget cap and a sandbox.

Set limits at the cloud too, where the numbers come from your actual bill:

- **Billing alerts and budgets.** AWS Budgets with an alert threshold, plus Cost Anomaly
  Detection; budgets in Azure Cost Management; budget alerts on your GCP billing account. Most of
  them notify rather than stop, so set the threshold well below the number that would hurt.
- **A blast radius you chose.** Give Rocky Surf its own AWS account, Azure subscription, GCP
  project or Hetzner project. A mistake then costs you that project and nothing else, and the
  bill tells you which spending was Rocky Surf's.
- **A credential that can only do this job.** The AWS role in
  [`deploy/aws/iam-role.yaml`](deploy/aws/iam-role.yaml) and the least-privilege roles in the
  provider docs exist so the token in Rocky Surf's hands cannot reach the rest of your account.
- **An occasional look at the console.** Rocky Surf reconciles what it believes against what the
  cloud reports and tells you when the two disagree, but it only knows about resources it created.

## More

| Document | What it covers |
|---|---|
| [`docs/self-hosting.md`](docs/self-hosting.md) | Both install paths, data, upgrades, backup and restore |
| [`SECURITY.md`](SECURITY.md) | Credential custody, SSH trust, network defaults, the MCP threat model |
| [`docs/adr/llms.txt`](docs/adr/llms.txt) | The architecture decisions — start here for the design |
| [`docs/providers/capability-matrix.md`](docs/providers/capability-matrix.md) | What each provider can do, and the evidence behind each claim |
| [`docs/writing-a-pack.md`](docs/writing-a-pack.md) | The pack-author contract |
| [`docs/writing-a-provider.md`](docs/writing-a-provider.md) | Adding a cloud against the frozen SDK |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, gates, conventions |

Rocky Surf is deliberately small: there is no devcontainer support, no per-task throwaway
sandboxes, no Windows targets and no multi-tenancy — one admin, one password, no privilege
separation inside the process. `rockysurf mcp` exposes the lifecycle as MCP tools so an agent can
create, inspect, stop and destroy its own boxes, with `create` and `terminate` as separate opt-in
scopes.

## License

[MIT](LICENSE). **The Rocky Surf name and logo are not covered by it** — fork the code freely and
give the fork its own name. See [`TRADEMARK.md`](TRADEMARK.md).
