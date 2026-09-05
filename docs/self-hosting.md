# Self-hosting Rocky Surf

Rocky Surf is one process. It serves a web UI and an HTTP API on one port, keeps everything it
knows in one directory, and talks out to whichever cloud you configured. There is no queue, no
external database, no message bus and nothing to scale — the job loop runs in-process, and the
design is deliberately "your laptop can be the control plane"
([ADR-0001](adr/0001-single-portable-control-plane-app.md)).

That means the operational surface is small, and this page is most of it: how to run it, where
the data lives, what to back up, how to upgrade, and the handful of behaviours that surprise
people.

**Before you start, decide which cloud it will drive.** Every provider is disabled until you
enable it, so a fresh install cannot spend money by accident, and with none enabled it comes up
on an in-memory provider — enough to create a fake server, watch it boot and terminate it before
you point it at a real cloud account. Rocky Surf stores no cloud credentials — each cloud
authenticates through your own auth path, described in its row below.

| | |
|---|---|
| **Hetzner** | The quickest start. Create a project, mint a read/write API token, and export it as `HETZNER_TOKEN` in the environment Rocky Surf starts from — it is never pasted anywhere. No role to deploy and nothing to prepare — [`providers/hetzner.md`](providers/hetzner.md). |
| **AWS** | Uses the standard credential chain, never a key in the config file. Needs an IAM policy and an explicit `sshAllowedCidr` — [`providers/aws.md`](providers/aws.md). |
| **Azure** | Credentials from your environment, a managed identity, or `az login` — never from the config file. Needs a resource group you create, a least-privilege role and an explicit `sshAllowedCidr` — [`providers/azure.md`](providers/azure.md). |
| **GCP** | Uses Application Default Credentials — `gcloud auth application-default login`, a key file, or the metadata server — never a key in the config file. Needs a project and an explicit `sshAllowedCidr` — [`providers/gcp.md`](providers/gcp.md). |
| **BYO** | Machines you already have, over SSH. No cloud API — [see below](#bring-your-own-hosts). |
| **A cloud not listed here** | A provider you install yourself, written against the provider SDK — [Personal providers](#personal-providers). |

There are two ways to run it. Both give you the same thing: one process, one port, one data
directory.

## Docker Compose

```bash
git clone https://github.com/amroja-biz/rockysurf
cd rockysurf
docker compose up --build
```

That is the whole first run. It builds the image, starts the container, and prints the admin
password **once**:

```bash
docker compose logs rockysurf | grep -A3 'first boot'
```

Open <http://127.0.0.1:3000>, sign in with that password, and the first-run wizard asks which
clouds you want — never for a credential. Pick a cloud and switch it on; the wizard shows that
cloud's own auth path inline. For Hetzner that means exporting `HETZNER_TOKEN` where the
container can see it and restarting — the wizard detects the token when you come back and
finishes the step itself; AWS, Azure and GCP use their standard credential chains, with nothing
to type at all.

### Where the data lives

Everything that must outlive the container is in the `rockysurf-data` volume, mounted at
`/data`:

| File | What it is |
|---|---|
| `rockysurf.config.yaml` | Your configuration. Seeded from the image on first start, yours from then on. |
| `rockysurf.db` | The SQLite database: servers, packs, sessions, encrypted secrets. |
| `secret.key` | The master key those secrets are encrypted with. **Back this up.** |
| `packs/` | Your own pack files, if you keep any. Takes precedence over the ones the release ships. |

`docker compose down` keeps the volume. `docker compose down -v` destroys it, and with it every
stored credential and the SSH keys for boxes you already own — those boxes will still be
running and billing, and you will no longer be able to log into them.

### Changing the configuration

The live config file is inside the volume, not in your checkout:

```bash
docker compose cp rockysurf:/data/rockysurf.config.yaml ./rockysurf.config.yaml
$EDITOR rockysurf.config.yaml
docker compose cp ./rockysurf.config.yaml rockysurf:/data/rockysurf.config.yaml
docker compose restart
```

`docker/rockysurf.config.yaml` in the repository is only the seed for a volume that has none;
editing it changes nothing for a container that has already started once.

Three settings are container-specific and should stay as they are: `server.dataDir` must be
`/data` (the mount point), `server.port` must be `3000` (what the image publishes), and
`server.host` must be `0.0.0.0` — the default elsewhere is loopback, and a container's loopback
is its own, so the published port would connect to nothing. That is not the exposure it looks
like: the compose file publishes on the *host's* loopback, which is where the boundary lives.
To reach it on a different host port, set `ROCKYSURF_HOST_PORT` instead:

```bash
ROCKYSURF_HOST_PORT=8080 docker compose up -d
```

### Notes on the container

- **It runs as a non-root user** (`rocky`, uid 10001). The named volume inherits that ownership
  from the image, so nothing needs chowning. A **bind** mount does not: if you replace the
  volume with `- ./data:/data`, `chown -R 10001:10001 ./data` first or the process cannot
  create its own database.
- **The port is published on loopback only.** The UI is an admin surface with one password in
  front of it and no TLS of its own. Put a reverse proxy in front of it to expose it
  deliberately.
- **`ROCKYSURF_ADMIN_PASSWORD`** is passed through from your shell when set, so you can choose
  the password instead of reading it from the logs — or recover an installation whose password
  was lost, since it overwrites what is stored.
- **`HETZNER_TOKEN`** (and `HCLOUD_TOKEN`) are passed through the same way, so the wizard's
  Hetzner flow works in Docker: `HETZNER_TOKEN=... docker compose up -d` puts the token in the
  container's environment, where Rocky Surf reads it at startup and stores it nowhere.

### Verifying a change to the packaging

```bash
node scripts/docker-smoke.mjs
```

Builds the image under its own compose project and its own port, drives a real first run
through to the wizard, switches a cloud on through the wizard's endpoint (and proves the
endpoint refuses a credential), then restarts and recreates the container, checking that the
enable, the admin password and the master key all survived. It tears its own stack down on
every exit path and never touches a volume you are using.

## npx

```bash
npx rockysurf
```

> **Not published yet.** This path needs the ten packages on the public npm registry, which
> happens at the v0.1.0 launch ([`RELEASING.md`](RELEASING.md)). Until then, use Compose, or run
> `pnpm -r build` in a checkout and start `node packages/rockysurf/dist/bin.js` — the same binary
> `npx` will fetch.

Requires Node 24 or newer; the binary checks and says so if not. Nothing else: with no config
file anywhere it starts on defaults, says where a config file would go, and offers the
in-memory provider — so you can create a server, watch it boot and terminate it before
deciding whether to point it at a real cloud account.

### The commands

`rockysurf --help` is the list, and this document deliberately does not repeat it: the help is
rendered from the dispatch table itself (`SUBCOMMANDS` in `packages/rockysurf/src/cli.ts`), so a
command cannot exist without appearing there, and a copy here could fall behind on the next one
added. With no command it starts the control plane; everything else — serving MCP, minting a
token, and the thin commands that talk to a running control plane over HTTP — is one row in that
table with its own one-line summary.

The one worth naming out of order is `rockysurf token`: it mints the credential that the MCP
server and every client command require, and none of them work until you have exported one.

**`rockysurf mcp` needs a control plane already running** wherever `ROCKYSURF_URL` points —
`rockysurf serve` (or the bare `rockysurf` above, which is the same thing). It does not start one
itself: an MCP client is free to launch it first, but every tool call has to reach a live core to
do anything, and the first sign of that used to be a first tool call's failure rather than
anything at startup. A newer `rockysurf mcp` probes once after it connects and, if nothing
answers, says so on stderr — non-fatal, because the moment core comes up the next tool call
recovers on its own.

**A command comes first, and options follow it.** `rockysurf token --config ./rockysurf.config.yaml`
works; `rockysurf --config ./rockysurf.config.yaml token` does not, because the dispatch reads
the first argument before any option parsing happens. Written the wrong way round it refuses with
the command named as misplaced and prints the line that works, options and all.

### Where the config file is read from

First match wins, and a start prints the file it read on one line (`config: <path>`) so you
never have to guess which one is live:

| | Path | For |
| --- | --- | --- |
| 1 | `--config <path>` | Anywhere. A path with nothing at it is an error, not a silent fall back to defaults. |
| 2 | `./rockysurf.config.yaml` | The directory you run the command in — a checkout, or one directory per instance. |
| 3 | `~/.rockysurf/config.yaml` | The durable home, beside the data directory. Found wherever you happen to be. |

Copy `rockysurf.config.example.yaml` to either of the last two when you want to change
something. A file in the working directory wins over the home file, so an existing setup keeps
loading exactly the file it loaded before the home location existed — adding one does not
change what any directory already reads.

The home file is `~/.rockysurf/config.yaml` literally. It is not derived from `server.dataDir`,
even though that also defaults to `~/.rockysurf`: this file is what sets `dataDir`, so looking
for it inside `dataDir` would mean reading the config to find the config. Point `dataDir`
wherever you like and the config file stays where it is.

Settings you save from the web UI are written to whichever file was loaded. On a run that found
none, the first save creates `~/.rockysurf/config.yaml` — never a file in the directory you ran
`npx` in, which stays untouched.

Data goes to `~/.rockysurf` by default (`server.dataDir`), which holds the same database and
`secret.key` described above and deserves the same backup.

**It listens on `127.0.0.1` only.** Nothing outside the machine can reach it until you set
`server.host` to `0.0.0.0` (or a specific address) in the config file. Do that behind a reverse
proxy or a firewall — the UI has one password in front of it and no TLS of its own, and the
process holds your cloud credentials and the SSH key for every server it manages.

**The AWS SDK is not in the control plane's dependency closure.** It arrives only with
`@rockysurf/provider-aws`, which the composition root imports — enforced by
`scripts/check-npx-closure.mjs`, which fails if anything drags it into `@rockysurf/core` or
into the CLI by any other route.

## The Settings page

Whichever way you started it, the web UI edits that same config file — the one an editor would
open, comments and all — one section at a time: a column of tabs beside the form where the
window is wide enough for one, the same tabs as a strip above it where it is not. The tabs are
the file's own blocks — Server, GitHub access tokens, SSH public keys, one per cloud provider,
Your own machines, Limits, Preferences, MCP — and the open one is in the URL, so
`/settings?section=providers.aws`
is a link straight to the AWS settings and a reload comes back to the section you were on.

What you type is held until you press **Save to the file**, wherever on the page you typed it.
Moving between tabs never discards an edit, and a tab holding unsaved work — or a field the last
save was refused over — carries a dot, so nothing is left waiting on a section you have stopped
looking at. The GitHub tokens are the one exception, and each card says so: they save one entry
at a time, because removing an entry renumbers the ones after it.

**Saving applies straight away.** Rocky Surf re-reads the file the moment the page writes it
and adopts what it finds, so a cloud you have just switched on, a region you have just corrected
and a limit you have just raised are all in force before the save even answers — no restart.

Five settings cannot work that way, and each says so under its own box rather than leaving you
to guess:

| Setting | Why a restart |
| --- | --- |
| `server.port` | The socket this page arrived on is bound to the old port. |
| `server.host` | The listener is bound to the old interface. |
| `server.dataDir` | The database, the master key and the encrypted store are open from the old directory. |
| `auth.mode` | Every session open right now was issued by the mode the process started in. |
| `mcp.scopes` | Read by a *different* process — the one your MCP client starts with `rockysurf mcp`. Rocky Surf itself needs no restart; reconnect the MCP client. |

Saving one of those raises a banner naming it, read back from the file rather than shown as a
message a reload could lose, and it stays up until the restart has happened. Saving anything else
raises nothing, because there is nothing to wait for.

One case is neither: a token box that names an environment variable this process cannot see. The
file is written — that is the workflow the page asks for — but its values are not knowable, so
nothing is adopted and the page says which variable to export. See *Tokens the file names but the
process cannot see*, below.

## What Small, Medium and Large mean

A size is a **floor**, not a machine type: `small` asks for at least 2 vCPU and 2 GB, `medium`
for 2 and 4, `large` for 4 and 8, and Rocky Surf creates the cheapest machine the chosen cloud
sells that meets it. That is why one form serves clouds with completely different catalogues —
EC2's `t4g.small` and Hetzner's `cpx12` are not comparable by name, only by what they provide.

If you would rather it always used a particular type, say so once:

```yaml
preferences:
  tiers:
    aws:
      small: t4g.medium
      large: c7g.xlarge
    hetzner:
      small: cpx21
```

Set them on the **Preferences** tab of the Settings page — every box there opens the same
searchable catalogue the New Server page offers, so a type is picked from what the cloud
actually sells rather than typed from memory — or on the New Server page itself: pick a machine
type by hand and it offers to use that one every time you ask this cloud for a small, a medium
or a large. Both write the same lines into the same file.

A cloud that is switched off in this file has no catalogue to offer, so its boxes stay plain
text; so does a type Rocky Surf could not read the catalogue for. Leaving a box empty is always
available and always means the same thing: the cheapest type that meets the size's floor.

Three things worth knowing about them:

- **A saved type does not have to meet the size's floor.** "My small is `t4g.large`" is a
  perfectly good thing to want. The floors are there so someone who has expressed no opinion is
  not under-served; expressing one is the whole point of this block.
- **It falls back rather than failing.** If the saved type is sold out, quota-refused, or no
  longer sold, Rocky Surf creates the cheapest machine meeting the floor instead — and says
  which and why, on the New Server page and in the API response, rather than substituting in
  silence. An architecture you ask for explicitly also wins over a saved type of the other one.
- **It applies immediately**, to the next server you create — as almost everything in this file
  now does. `preferences` was the first block Rocky Surf re-read while running, and it is read
  straight from the file at create time rather than through the settings page, so it applies
  whether or not anybody saved it from the browser.

The saved type must be one this installation would actually create: if you have narrowed a cloud
with `providers.<cloud>.sizes`, a preference outside that list is refused when the file is read,
naming both settings. The preference is your default; the allowlist is the installation's
policy, and a default never steps over a policy.

The CLI and the MCP server go through the same resolution, so `rockysurf create --size small`
and an agent's `create_server` both get the type you saved.

## The data directory

Whichever path you used, one directory holds everything: `/data` in the container, `~/.rockysurf`
by default otherwise, `server.dataDir` in general.

It is created **owner-only (`0700`) on the first boot**, explicitly rather than through the
umask, because a typical umask yields `0755` and a world-readable directory containing
`secret.key` is exactly the quiet mistake self-hosting must not make. If the directory already
exists with looser permissions, Rocky Surf tightens it where it can and warns where it cannot —
a warning rather than a refusal, since an operator may have deliberate reasons.

Two of the things in it deserve separate thought:

- **`secret.key`** is the master key for every stored secret — per-server SSH private keys,
  remote-desktop passwords, the Connect-GitHub token (cloud provider credentials are not among
  them: Rocky Surf stores none, issue #280). Lose it and every one of them is unrecoverable and
  every server has to be recreated. Obtain it, and all of them decrypt. It is written `0600` and
  the process refuses to start if its permissions are looser than that. You can hold it outside
  the filesystem entirely by setting `ROCKYSURF_SECRET_KEY` (base64, exactly 32 bytes decoded),
  in which case nothing is written to disk.
- **`rockysurf.db`** is SQLite in WAL mode, so recent writes live in `rockysurf.db-wal` until a
  checkpoint folds them in. This matters for backups — see below.

### Terminating a server does not delete its row

**Nothing in Rocky Surf ever deletes a server row.** Terminating a box — or dismissing a failed
one — destroys the machine and its disk at the cloud, and moves the row to `terminated`. The row
itself stays in `rockysurf.db` for good, and it is the only place the configuration of a box that
no longer exists survives.

The Servers page turns that into something you can read. Its **Recent activity** list is derived
from the rows' own timestamps — created, started, stopped, terminated — and **every entry is a
link to that server's page**. Open one for a box that is gone and the page reports instead of
controlling: which cloud and region it was placed in, its size, machine type and architecture,
the Surge Pack and tools it was built with, the repositories it was created for, when it was
created and when it was terminated, its total uptime and final estimated cost, and the bootstrap
report if its install had anything to say. Stop, Start, Terminate, the SSH command, the key
download, the provider-console link and the rename are all absent — every one of them needs a
machine that is not there.

Two limits worth knowing, because the page cannot invent what the row never held:

- **A row records what Rocky Surf knew.** A server created by a version older than the one that
  introduced a column has nothing in it — placement, for one, was only stamped onto new rows from
  the release that added this page — and a fact that was never captured is shown as absent rather
  than guessed.
- **Secrets are not part of the record.** A terminated server's SSH private key and any
  remote-desktop password are of no further use, and the record does not offer them.

There is no pruning job and no retention setting. Rows are small — a few hundred bytes plus the
bootstrap report on the ones that have one — so a long-lived installation accumulates history
rather than weight. If you want a box's record gone, delete the row from `rockysurf.db` by hand
with the process stopped.

## Backup and restore

**What to back up: the whole data directory.** `secret.key` and `rockysurf.db` are useless
without each other. A database without its key is undecryptable ciphertext; a key without its
database knows nothing about your servers.

**Stop the process first.** A clean shutdown checkpoints the WAL with `wal_checkpoint(TRUNCATE)`
before closing, which empties and removes the WAL file rather than leaving it beside the
database. That is what makes a plain file copy safe: copy `rockysurf.db` from a *running*
installation and you may get a file that is silently missing the last few minutes of writes.

```bash
# npx / from-source install: stop it first (Ctrl-C, or `systemctl stop` if you run it as a unit)
tar czf rockysurf-backup-$(date +%F).tar.gz -C ~ .rockysurf

# Docker Compose
docker compose stop
docker run --rm -v rockysurf-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/rockysurf-backup-$(date +%F).tar.gz -C /data .
docker compose start
```

If you cannot stop it, take the backup with SQLite's own online backup
(`sqlite3 rockysurf.db ".backup /path/out.db"`) and copy `secret.key` alongside it. Do not copy
the `-wal` and `-shm` files and hope; back up all three together or none.

**Restoring** is putting the directory back and starting up. Migrations are applied on boot and
recorded, so an older database opened by a newer version is upgraded in place; the reverse is
not supported.

A restore does not un-terminate anything. What survives is Rocky Surf's *knowledge* — which
servers exist, their keys, your credentials. If a box was destroyed at the cloud while your
backup was cold, the reconciler notices the difference and reports it rather than resurrecting
anything.

**Treat the backup like the key it contains.** It holds every managed server's private key and
your Connect-GitHub token in encrypted form, with the key to decrypt them in the same archive —
and the configuration file, cleartext pasted tokens included. (Cloud provider credentials are
not in it, because Rocky Surf stores none — issue #280.) Encrypt it, or store `secret.key`
separately via `ROCKYSURF_SECRET_KEY` and back up only the database.

### Moving to a new computer: Settings → Backup

The tar above is the full-fidelity snapshot — everything, key included, process stopped. For
the ordinary migration ("I got a new laptop") there is a first-class path that needs neither
(issue #331, ADR-0023): **Settings → Backup** downloads one JSON artifact from the *running*
process (its reads are one database transaction, so the WAL caveat above does not apply), and
**Restore** on the new installation reads it back.

What makes the artifact safe to put wherever you keep files:

- **Stored secrets travel as the ciphertext they already are** — and the master key does not
  travel at all. Copy `secret.key` to the new machine yourself (or set
  `ROCKYSURF_SECRET_KEY`), and every restored secret decrypts in place; without it, everything
  else still restores and the report says how many secrets are sealed until the key arrives.
- **Cleartext GitHub tokens never travel.** Any literal `github.pat` / `github.tokens[].pat`
  in your configuration file is replaced with a `${VAR}` placeholder in the artifact; the
  restore report lists the redacted tokens by name so you know exactly which to paste back in.

Restore is a **merge, never a replace**: everything in the file is added, skipped because it
already exists, or refused with a reason (a pack or tool id your new release ships file-backed
is refused, ADR-0018's rule), and re-running the same restore is a no-op. The new machine's
own `server.port`, `server.host`, `server.dataDir` and `auth.mode` are kept. Your cloud
machines are untouched either way — they live in your cloud accounts; a restored server row is
a record, and the reconciler then reports any machine that no longer answers, exactly as it
does after a laptop was closed for a week. An artifact from an older Rocky Surf restores into
a newer one (the format carries a version and is upgraded on read); the reverse is refused
with an upgrade-first message.

## Upgrading

There is no upgrade command. Start the new version against the same data directory; database
migrations run on boot, are recorded in the database, and are idempotent.

```bash
# Docker Compose
git pull
docker compose up --build -d

# npx — once v0.1.0 is on npm; from a checkout it is `git pull && pnpm -r build` instead
npx rockysurf@latest
```

Your configuration is not touched by an upgrade. In the container it lives in the volume and is
only ever seeded when absent, so a new image never overwrites it — which also means a new
setting introduced by a release will not appear in your file. Diff
`rockysurf.config.example.yaml` against yours after a release; every value in the example is the
default, so anything you leave out keeps working.

**Take a backup before upgrading.** Migrations move forward only.

## Cloud prices

The hourly cost estimates for AWS, Azure and GCP machines are not part of the release you
installed (issue #100, [ADR-0009](adr/0009-prices-served-from-hosted-feed.md)). They come from a
hosted price feed — four JSON files the Rocky Surf repository's `price-feed` workflow
republishes to GitHub Pages daily:

```
https://amroja-biz.github.io/rockysurf/prices/v1/{index,aws,azure,gcp}.json
```

Your installation fetches its provider's document at runtime and caches it (`pricing.refreshHours`,
default 6), so a price a cloud changes today reaches you on the next publish plus one cache
refresh — no upgrade involved. Every estimate in the UI carries the feed's own "as of" stamp.

Six things worth knowing:

- **A stopped server stops costing on every cloud that ships here — and not on every cloud.** The
  estimate follows what the provider says a stopped machine costs: on a cloud whose provider
  declares that a stopped machine still bills at the running rate
  ([ADR-0025](adr/0025-billing-while-stopped-is-a-capability.md)), the meter keeps running through
  `stopped`, the server page says "Stopped, and still billing", and only terminating ends the
  charge. None of the five shipped providers is such a cloud; DigitalOcean is.
- **If the feed is unreachable, prices show as unavailable — and nothing else changes.** There
  is deliberately no stale bundled fallback: creating, stopping and terminating servers all
  work, the create form says prices are unavailable, and the spend cap reports the affected
  servers in its `unpricedServers` count instead of silently miscounting.
- **A document that fails validation is treated as a missing one, whole.** Your installation
  checks every price in the document it fetched and rejects the entire thing if even one is not
  a positive number, because the spend cap must degrade to *unpriced* rather than to *wrong*. So
  one cloud showing unavailable prices in **every** region, while the others are fine, means a
  rejected document rather than a failed fetch — and it is a bug in the publisher, worth
  [filing](https://github.com/amroja-biz/rockysurf/issues). Issue #140 was exactly this: Azure
  published thirty preview VM sizes at a price of zero, and thirty zeros unpriced all fourteen
  Azure regions until the publisher learned to refuse them.
- **Air-gapped?** Set `pricing.enabled: false` (prices show unavailable, no doomed fetches), or
  mirror the four files somewhere you control and point `pricing.feedUrl` at the mirror.
- **Hetzner is not on the feed.** Its API returns prices inline on the same call that lists
  machines, so there is nothing to publish.
- **GCP's dates are older than the others, on purpose.** AWS's and Azure's numbers are re-fetched
  from their public pricing APIs on every publish. Google has no such API that works without
  credentials, so GCP's prices are transcribed by hand from its published pricing page, and the
  feed carries **the day a person read them** rather than the day it was republished. A GCP
  estimate reading "as of" a date weeks ago is the system being honest, not stale plumbing. What
  the feed buys is the fix path: correcting a transcribed number reaches you on the next publish
  instead of the next release.

## Bring-your-own hosts

You do not need a cloud account at all. `@rockysurf/provider-byo` manages machines that already
exist — a workstation under a desk, a rack in a colo, a VM someone else provisioned. There is no
cloud API behind it; the API is `sshd`. Configuration, host-key trust and the full contract are
in [`providers/byo.md`](providers/byo.md).

Two consequences are worth knowing before you enable it, because they are properties of the box
rather than of Rocky Surf:

- **Claiming a host changes it.** The provider creates a `rocky` account, appends Rocky Surf's
  public key to that account's `authorized_keys` (appended, never truncated — your own access is
  in that file), and writes `/etc/sudoers.d/90-rockysurf-rocky` granting it passwordless sudo.
  The bootstrap agent installs software as root, so that sudo grant is load-bearing, not a
  convenience.
- **Releasing a host leaves that behind.** `terminate` on a BYO host **runs nothing on your
  machine — not one command, not one connection.** It releases the claim and returns the host to
  the pool. That is a rule, not an omission: the machine is yours, it was running before Rocky
  Surf existed, and a background reconciler sweep is the last thing that should be deleting
  accounts on it. So the `rocky` account, its authorized key and its sudoers file stay. Remove
  them yourself if you want them gone:

  ```bash
  sudo userdel -r rocky && sudo rm -f /etc/sudoers.d/90-rockysurf-rocky
  ```

`stop` and `start` are unsupported on BYO — core does not own the power state of a machine it did
not create — and the UI hides those buttons rather than offering them and failing.

## Personal providers

The five providers above ship with Rocky Surf. A cloud that is not among them can still be driven
by an installation you run, without a change to this repository: a **personal provider** is an
npm package written against
[`@rockysurf/provider-sdk`](../packages/provider-sdk/README.md) — yours, or somebody else's — that
you install and name in the config file
([ADR-0026](adr/0026-a-personal-provider-is-a-package-named-in-the-config-file.md)).

**A provider runs with Rocky Surf's full access — install ones you trust.** It is software running
inside the same process as your database, your master key and every cloud credential in your
environment. Nothing fences it, on purpose; the decision is yours, made when you install it.

Install the package under the data directory's `providers` folder, which is where a package name
in the config file is looked up. That folder is outside the application, so upgrading Rocky Surf
(`npx rockysurf@latest`, `git pull && pnpm -r build`, or rebuilding the container image) leaves it
alone:

```bash
mkdir -p ~/.rockysurf/providers && cd ~/.rockysurf/providers
npm init -y
npm install @someone/rockysurf-provider-digitalocean
```

In the container the folder is `/data/providers`, on the volume. Then add a section to the config
file, keyed by the provider's id, naming the package:

```yaml
providers:
  digitalocean:
    package: "@someone/rockysurf-provider-digitalocean"   # or a path: ~/code/my-provider
    enabled: true
    token: "${DO_TOKEN}"        # the provider's own fields, as its README describes them
    region: nyc3
```

`package` may also be a path to a built package directory or file — the shape for a provider you
are developing in a checkout beside this one. Everything else in the section belongs to the
provider and is validated by the provider's own schema when Rocky Surf starts; `sizes` is the
same allowlist every provider gets.

What to expect:

- **Packages load when Rocky Surf starts.** Adding a section, or changing which package it names,
  takes effect at the next restart. Enabling or disabling one takes effect on save, like every
  other provider — the package is loaded whether or not the section is enabled.
- **A package that cannot load never stops Rocky Surf starting.** Not installed, fails on import,
  not a provider factory, an id that does not match the section key: each is reported on the New
  Server page and in the boot log, in a sentence naming the section, and everything else keeps
  working.
- **The Settings page shows the section**, with its Enabled switch and the package it loads from —
  and, when the provider declares its settings
  ([ADR-0027](adr/0027-a-provider-declares-its-settings-and-the-page-is-built-from-them.md)), its
  own fields too: a token box that takes a variable name, its regions and options, the SSH
  whitelist if it has one, saved machine types under Preferences, and any notes its author wrote
  for you. A value under a personal section that the provider has not declared is masked on that
  page, never shown, because it could be a credential; edit it in the file.
- **Credentials work the way they do for Hetzner.** A token named in the file as `${VAR}` is read
  from your environment; a provider may also name the variable itself, so the first-run wizard
  can say when it has been detected. Rocky Surf stores none of it.
- **A misspelled shipped provider is still caught.** `providers.hetzer:` is refused with "did you
  mean hetzner?", not with advice to install a package.

### DigitalOcean, the one this repository ships as a personal provider

`@rockysurf/provider-digitalocean` is a real, complete provider that is deliberately NOT wired into
Rocky Surf's composition root: it lives in this repository at `packages/provider-digitalocean`, is
built and tested by CI like any other package, and is installed the way any personal provider is
(issue #368). It is what a personal provider looks like when it is finished, and it is the one to
copy.

```bash
mkdir -p ~/.rockysurf/providers && cd ~/.rockysurf/providers
npm init -y
npm install @rockysurf/provider-digitalocean
```

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

**It installs without a package manager too**, which matters because it is the artifact the
provider shop hands you and because an air-gapped or npm-less install is a real one:

```bash
mkdir -p ~/.rockysurf/providers/node_modules/@rockysurf/provider-digitalocean
tar -xzf rockysurf-provider-digitalocean-0.1.0.tgz \
  -C ~/.rockysurf/providers/node_modules/@rockysurf/provider-digitalocean --strip-components=1
```

That works because the package declares no runtime dependencies at all — the SDK helpers it uses
are compiled into its `dist/` — so there is nothing left to resolve once the files are on disk. A
personal provider that needs `npm install` to be usable is one an installer cannot check, and this
one is the worked example of the other shape. `packages/rockysurf/src/personal-provider-tarball.test.ts`
packs, extracts and boots it on every CI run, so the property is asserted rather than remembered.

Two things about DigitalOcean itself the provider's README says at more length, and which are the
reason it exists: **a powered-off droplet keeps billing at the full rate** — only destroying it
ends the charge, and Rocky Surf's meter and the New Server page both say so — and **removing a
network from `sshAllowedCidr` takes effect in one step**, because a DigitalOcean firewall rule
carries no record of who wrote it and Rocky Surf therefore owns the whole firewall object it named.

Writing one is described in [`docs/writing-a-provider.md`](writing-a-provider.md), and the
`adding-providers` skill in `.agents/skills/` walks an agent through it.

## SSH access on a new server

### Saving the keys you reuse

If you authorize the same laptop on every box, save it once instead. The Settings page's **SSH
public keys** tab keeps a list of name-and-key pairs, and the create form's "Use my own public
key" option then offers that list — pick `laptop` rather than going to find
`~/.ssh/id_ed25519.pub` again. One saved key is preselected; with several you choose, because
preselecting one would authorize a key you had not looked at.

**Pasting still works, and nothing about it changed.** "Paste a different public key…" is always
in the list, it is the default whenever there is more than one saved key, and an installation
that has saved none never sees a picker at all. What goes on the wire is the same either way:
the key itself, never the name it was chosen by, so a server is answerable to the key it actually
authorized and editing the list later cannot rewrite the history of a box.

**Public halves only, and this is enforced rather than requested.** Both the settings save and
the create form refuse anything containing `PRIVATE KEY`, by name, before they complain about
anything else — the mistake is a predictable one and "that is not a valid key" would be a useless
thing to say about it. Saved keys live in `ssh.keys` in the config file in plain text, because a
public key is published material and encrypting a copy of it would be theatre; see the inventory
in [`SECURITY.md`](../SECURITY.md#what-is-stored-and-what-is-never-stored). Saving one takes
effect at once — the next New Server page offers it, with no restart.

**An agent connected over MCP uses the same list, by name** (issue #360). `list_ssh_keys` returns
the names you saved — names only, never the key lines — and `create_server` takes `ssh_key_name`
to authorize one of them, or `ssh_public_key` for a key you never saved. Both end up in the same
`sshPublicKey` field the form posts, so an agent's box and yours are built the same way. A name
that is not on the list is refused, and the refusal names the ones that are: a box that came up
on Rocky Surf's own key still works, so quietly dropping the key would look like a bug in the
product rather than a typo in the request. If you have saved keys and an agent creates a box
without naming one, the result says so — a note, not a refusal, because the key is as optional
there as it is here.

Removing a key here changes nothing on a box it was already authorized on; that you do over SSH.

The create form's "Use my own public key" option pastes your key onto the box — but it does not
replace Rocky Surf's own generated key, it joins it, at first. Push-mode bootstrap installs
everything over Rocky Surf's own SSH connection, so that key has to be authorized while the box
is being built, regardless of what you supplied. See
[`SECURITY.md`](../SECURITY.md#managed-servers-pinned-with-no-trust-on-first-use-window) for
exactly how the pasted key is parsed and appended.

That is where it used to end: both keys, forever. It no longer does. Once bootstrap finishes, the
plan's last step removes Rocky Surf's own key from the box and core retires the private half it
had stored — your supplied key becomes the only one on it. The server page's Connect panel
reflects this live: while bootstrap is still running (or on a server created before this
existed), it leads with your key and keeps the generated `.pem` reachable as a disclosed recovery
path; once retirement is confirmed, that disclosure and every `.pem`-based command disappear, and
there is nothing left to download. If you ever lose your own key on a server whose bootstrap
finished, there is no generated key left to fall back to — that trade is the point.

### When a box reads as filtered but its network is already in the list

On AWS, Azure and Google Cloud, `sshAllowedCidr` is the firewall Rocky Surf manages, and it
allows exactly the networks you put in it. A box can still read as **filtered** — SSH times out
with no refusal, and "Test SSH Path" says as much — even though the CIDR you added *is* in the
list and the same box is reachable from some other network. That combination usually means
**per-port NAT**: on some networks (carrier-grade NAT, a few corporate and mobile gateways) web
traffic on ports 80 and 443 leaves by a different public address than everything else, SSH
included. A "what is my IP" page reports the web address, so that is the one you whitelist — and
the cloud correctly allows it while your SSH packets, carrying the *other* address, keep getting
dropped. The address the page gave you is precisely the one your SSH connection does not use.

Confirm it in two commands from the machine you SSH from, and compare the addresses:

```
curl -4 https://checkip.amazonaws.com     # your WEB address (what "what is my IP" shows)
curl http://portquiz.net:22/              # your SSH-path address (portquiz answers on any port
                                          #   and echoes back the source IP it saw on port 22)
```

If the two differ, that split is the bug: add the **port-22** address as a `/32` to
`sshAllowedCidr`, save, and reconnect. Two notes:

- **These NAT addresses can rotate.** If a network that used to work goes quiet, re-run the
  port-22 command and update the `/32`.
- **A quick check that it is the network, not the box:** if you can SSH in from a *different*
  network — a phone hotspot, say — the box is healthy and this egress split is the cause.

Rocky Surf never looks your address up itself, by design — you type the CIDR and it pushes what
you typed — so this is a check you run, not one the product can run for you. It cannot report the
offending address either: the firewall dropped the packet before it reached the box.

## Repositories, and how private ones clone

The Repositories field on the create-server form takes one git URL per line, and each one is
cloned into the home directory of the box during setup.

**Public URLs work with no credentials at all.** The clone runs anonymously; nothing needs
configuring, and this is the case the shipped packs are built around.

**Private repositories need a GitHub token, and there are two ways to give Rocky Surf one.** The
ordinary path is a button; the precise path is a token per repository. They layer — the most
specific match wins — so you can use either or both. [ADR-0007](adr/0007-github-credentials-two-paths.md)
records why each one lives where it does.

### The ordinary path: Connect GitHub

On the Settings page, on the *GitHub access tokens* tab, the first card is **Connect GitHub**.
Press it, and Rocky Surf shows a short code and a link to github.com; type the code there,
approve, and the token comes back to Rocky Surf. That is the whole of it — nothing to export,
no restart, and the next box you create carries the token.

Two things to know before you press it:

- **It asks for the `repo` scope**, which is read and write access to every repository your
  account can reach. That is the price of one click; `repo` is the classic OAuth scope covering
  private repository contents and there is no narrower one that does. If you want less than that,
  use the per-repository tokens below instead — the card says so too, above the button.
- **The token is stored encrypted, and it belongs to you** rather than to the installation. It
  goes into Rocky Surf's encrypted secrets store under your account, not into this file, and it
  lands on the boxes *you* create. Nothing needs restarting because that store is read at the
  moment a box is created.

**Disconnect forgets the token; it does not revoke it at GitHub.** Revoking needs a client secret
the device flow does not use, so if you want to be certain a token can no longer be used, remove
Rocky Surf at [github.com/settings/applications](https://github.com/settings/applications) as
well. The confirmation says the same thing.

**Connect GitHub is not a way to sign in to Rocky Surf.** It obtains a credential for cloning.
Signing in with GitHub (`auth.mode: github-device`) is a different, unimplemented feature that
happens to use the same OAuth mechanism — `local` is still the only login mode there is.

#### Registering the OAuth App (once, before the button works)

Rocky Surf ships no OAuth App of its own, deliberately: an app registered by someone else could
have its tokens revoked by them, and the authorize screen would name an organisation you have no
relationship with. So you register one, and it takes about a minute:

1. Go to [github.com/settings/applications/new](https://github.com/settings/applications/new).
   Name it whatever you like. The form requires a **Homepage URL** and a **callback URL**
   (shown as "Redirect URI"); the device flow never visits either, so `http://localhost:3000`
   satisfies both.
2. On the same form, tick **Enable Device Flow**. Without this, GitHub answers
   `device_flow_disabled` and the button says exactly that — it is the mistake nearly everybody
   makes once.
3. Leave **Expire user access tokens** unticked. An expiring token would need something phoning
   home to refresh it, which is not what this product is.
4. Copy the **Client ID** into the *OAuth App client ID* box on the Settings page's *GitHub
   access tokens* tab, or write it into the config file yourself. No restart: the routes behind
   the button read it per request, so the card is live as soon as the save lands.

```yaml
github:
  oauth:
    clientId: "Iv1.0123456789abcdef"
```

**A client ID is public.** It is safe in this file, safe in a screenshot and safe to commit — the
device flow uses no client secret at all, which is exactly why this is an ordinary string rather
than a credential. Until it is set, the Connect card still renders, disabled, showing these steps.

**GitHub Enterprise Server is not supported by the button yet.** The per-repository entries below
take a `host:`, so a self-hosted forge is not blocked — it just does not get a button.

### The precise path: a token per repository

Create a PAT on github.com and paste it into Settings, or write it into this file:

```yaml
github:
  pat: "ghp_yourTokenHere"
```

`github.pat` is the instance-wide fallback used for anything no scoped entry below matches. The
token needs whatever scope reads your repositories: `repo` on a classic PAT, or contents-read on
a fine-grained one.

**A pasted token is stored in this file, so treat this file as a credential** — the same way you
would an SSH private key. Rocky Surf creates it at mode `0600` and preserves that mode across
saves, but a backup, a copy to a second machine, or a paste into a bug report carries the token
with it.

**If you would rather the file carried nothing, it still supports that**, and always will:

```yaml
github:
  pat: "${GITHUB_PAT}"
```

`${GITHUB_PAT}` is interpolated from the environment when the config is read, so the token does
not sit in the file — export it in your shell, or put it in the `.env` you loaded before starting
(`GITHUB_PAT=` is already in `.env.example`). A `${VAR}` that is not set is a boot error naming
the variable rather than a silent empty token. Hand-edited references keep working, keep
round-tripping through the Settings page unchanged, and a token box holding one shows as *this
entry names an environment variable* with an empty box beneath it — leave it empty and the
reference stays exactly as you wrote it. What changed in the GUI is only what it asks you to
type; the file format did not change at all.

From there the path is already built: core hands the token to each box in `secrets.env`, a file
written at mode `0600`, and the clone authenticates with it through a `git -c credential.helper`
invocation that keeps it out of `ps` output and out of the checkout's `.git/config`
(`packages/core/src/bootstrap/resolver.ts`). Packs see it as `$GITHUB_TOKEN`, which is also the
name `gh` reads with no further configuration — see [writing-a-pack.md](writing-a-pack.md).

**One token per repository, when one token is not enough.** GitHub issues fine-grained PATs per
repository, so following its own advice leaves you holding several, and a single `pat:` line
cannot express that. `github.tokens` takes a list, and the box picks between them per clone:

```yaml
github:
  pat: "${GITHUB_PAT}"            # still the fallback for anything below matches
  tokens:
    - repo: "acme/widgets"        # one repository, named the way GitHub names it
      pat: "${ACME_WIDGETS_PAT}"
    - owner: acme                 # everything else under the acme account
      pat: "${ACME_PAT}"
    - host: git.example.com       # a self-hosted forge, any repository on it
      pat: "${ENTERPRISE_PAT}"
```

Each entry names as much or as little as you like — `host` (defaulting to `github.com`), `owner`,
and `repo` — and **the most specific match wins**: a repository beats an owner beats a host beats
`pat`. A clone that matches nothing uses `pat`, so adding this list never changes what an existing
config does. Matching ignores case as GitHub does, and every `pat` here goes through the same
`${VAR}` interpolation.

`repo: "acme/widgets"` is split into an owner and a repository as the file is read, so it is the
same entry as the longer form and you can write either:

```yaml
    - owner: acme
      repo: widgets
      pat: "${ACME_WIDGETS_PAT}"
```

A `repo` written without a slash still needs its own `owner` line — a bare repository name matches
nothing, since there is no such thing as "any repository called widgets". Writing a slashed `repo`
*and* an `owner` is refused rather than guessed at, because the two name different accounts.

The choice happens on the box rather than here, inside the credential helper git already runs:
one `secrets.env` serves every clone that box will ever do, including ones you type by hand later,
so core cannot know in advance which repository is being asked for. Git tells the helper, and the
helper picks. If no entry matches and there is no `pat`, the helper answers nothing at all — a
public clone from a box holding private-repo tokens is unaffected, and no token is ever offered to
a host you did not name.

`pat` remains the value packs see as `$GITHUB_TOKEN`. The `tokens` list is for cloning; it is not
a substitute, so if you configure only `tokens`, a pack that shells out to `gh` will find no token
— which is the honest answer, since none of them is the general-purpose one.

**A box is given only the tokens its own repositories need.** The list above describes the whole
installation; an individual server receives the entries that its declared repositories actually
select, and nothing else. A box created for `acme/widgets` gets the `acme/widgets` token; it does
not get `${ENTERPRISE_PAT}`, and a box created for nothing in particular gets no scoped token at
all. This is what makes it worth writing one entry per repository rather than one broad one: the
scope narrows what a token is *used for*, and now also *which machines hold it*.

`pat` is the exception and always ships, on every box, because it is the general-purpose
credential rather than a repository's — see the note above about `$GITHUB_TOKEN` and `gh`.

The trade is worth knowing before you meet it: **there is no way to add a token to a running
box.** `secrets.env` is written once. If you later clone a private repository nobody declared when
the server was created, the box has only what `pat` covers, and the options are to terminate and
recreate with that repository declared, or to authenticate that one clone by hand. Each server's
detail page lists the scopes it carries and says the same thing.

**The create form shows you all of this as you type.** Each repository URL is resolved live
against the same rules, and the form says which token will be used — by scope, and by the
environment variable it comes from when it comes from one — or that the repository is public and
needs none, or that nothing matches it yet. A token you added on the Settings page is in force
straight away, so the form resolves against it immediately. The exception is a `${VAR}` entry
naming a variable this process cannot see: the file holds the entry, nothing has been adopted,
and the form says which variable has to be exported before a restart (see the note about
`${VAR}` above).

**And it offers what you have already configured, so you do not retype it.** Every entry above
that names both an owner and a repository is a one-click chip on the create form: clicking it puts
that repository's HTTPS URL in the box, where it is resolved exactly like a URL you typed. An entry
naming only an account (`owner: acme`) or only a host is listed beside them but is not clickable —
it names an account or a forge, not a repository, and Rocky Surf has no way to list what is under
one — so type the repository's URL and it will be matched. An entry the file holds that this process could
not adopt — a `${VAR}` naming a variable nobody exported — is offered too, marked *after a
restart*.

### Repository URLs are checked before a machine is launched

A create that names repositories is refused if one of them does not open, and the refusal names
the URL. The check is git's own discovery request — the first thing `git clone` sends — made from
core, with the token *the box would use*: the same table, the same most-specific-wins rules. It
costs one HTTP request per repository and it saves the alternative, which is discovering a typo
after a full boot and a full install, on a box that then keeps running and keeps billing.

Core cannot tell a typo from a private repository from an expired token — GitHub deliberately
answers 404 to all three, so that a token cannot be used to enumerate private repositories — so
the message names all three rather than guessing. It also names the scope of the token that was
tried, which is the fastest way to spot a `tokens` entry that does not cover what you thought.

**One cause it does not have to guess at: no token matching the URL at all.** If you have scoped
`tokens` but none of them covers the repository, and no fallback `pat`, then the box would clone
anonymously — and a private repository refuses that. Core knows this for certain, because it ran
the same selection rules the box will run and got nothing back, so it says so directly and lists
the scopes you do have:

```
No configured token matches https://github.com/you/private-thing, so the box would clone it
anonymously — and github.com refused that (HTTP 401). Tokens are configured for:
github.com/acme/* — none covers github.com/you/private-thing. Add an entry under github.tokens
covering github.com/you/private-thing, or set a fallback github.pat.
```

This is worth knowing about because of what it looks like when it is *not* caught: the box's git
gets no credential, prompts for a username, finds no terminal, and fails with `could not read
Username for '...': No such device or address` — correct, and no help at all.

**You can create anyway.** The check is a prediction, not a guarantee: a forge can be briefly
unreachable, and the box makes its own credential choice at clone time. The SPA offers a *Create
anyway* checkbox once something has been refused, the API takes `"createAnyway": true`, and the
MCP `create_server` tool takes `create_anyway` — on an installation that has granted the `create`
scope, which is not the default (see *What an agent connected over MCP may do*).

**A self-hosted forge on a private network still gets checked**, but only because you named it.
Repository URLs are user-supplied text reaching a control plane that holds cloud credentials, so
every probe goes through the same SSRF screening as the pack importer — private, loopback and
link-local addresses are refused, including the cloud metadata endpoints. The one exemption is a
host you have written into `github.tokens`: naming it there is how you tell this installation the
address behind it is yours. A redirect away from such a host is screened again like anything
else, and the token is never sent across an origin change.

**The Settings page shows all of this as one list**, on its *GitHub access tokens* tab, because two
sections for one subject is not how anyone holding four PATs thinks about them. Each entry there
is one token and the repositories it opens; the entry with no scope is `pat`, labelled *All
repositories (fallback)*. Entries are added, changed and removed one at a time, each save going
straight to the file above.

**The GitHub token boxes take the token itself.** They are labelled *Token*, they are masked as
you type, and what you paste is written into the config file as you typed it. Three consequences
worth knowing:

- **Whatever is already in the file keeps working, and is never shown back to you.** A stored
  token reads as *a token is stored in the configuration file*; a `${VAR}` reference reads as
  *this entry names an environment variable* — and in both cases the box beside it is EMPTY. An
  empty box means *keep what is there*, so opening Settings and saving something else cannot
  overwrite either one. See [SECURITY.md](../SECURITY.md).
- **The file is now a credential when you use these boxes**, which is the trade the button above
  avoids by never writing to the file at all.
- **The other credential boxes are unchanged.** Hetzner's API token box still takes the NAME of
  an environment variable, still refuses a literal where you typed it, and still writes
  `${HETZNER_TOKEN}` into the file. Only the two GitHub token boxes changed.

Three properties worth knowing before you set any of this, and they hold for `pat` and for every
entry of `tokens` alike:

- **Rotating a token in this file is an edit, and that is all.** Tokens written here are read
  from the file when a box is created and passed straight through; none is ever copied into the
  database. Change the value and the next box gets the new token — no restart. Changing the
  environment variable *behind* a `${VAR}` entry is the one case that still needs one, because a
  running process cannot be handed a new environment. Boxes already provisioned keep the tokens
  they were built with — `secrets.env` is on the box. A connected account behaves the same way:
  that token lives in the encrypted store, read at the moment a box is created.
- **Every token in this file is instance-wide, so scope each one like it.** Every server created
  on this installation gets all of them, whoever created it — a repo-scoped entry narrows which
  repository a token is *used for*, not which people receive it. On a single-admin install that
  is exactly what you want; on an installation where other people can hold accounts, understand
  that you are handing your tokens to boxes they have root on. **A connected account is the
  exception**, and the better answer for that case: the token the Connect button obtains is
  stored per user and reaches only the boxes that user creates. When both exist, the connected
  token wins, and the Settings page says so on the fallback card.
- **Nothing reads a `GITHUB_TOKEN` from core's own environment.** Setting that variable where
  core runs does nothing; the config key is the mechanism. (`ROCKYSURF_SECRET_KEY` and
  `ROCKYSURF_ADMIN_PASSWORD` are, along with `ROCKYSURF_PUBLIC_DIR`, the only variables core
  reads directly.)

If a clone still fails, the bootstrap log for that server carries git's own message. The fastest
way to tell the two causes apart is to SSH to the box and look at
`/var/lib/rockysurf/secrets.env`: no `GITHUB_TOKEN` line means core had no token to send, so the
problem is on this end; a line that is there while the clone still 403s means the token itself
is wrong or under-scoped. With a `tokens` list the same file also carries
`ROCKYSURF_GITHUB_TOKEN_COUNT` and a `ROCKYSURF_GITHUB_TOKEN_<n>_SCOPE` per entry, written
`host/owner/repo` with `*` for the parts an entry left open — read those scopes against the URL
that failed and you can see which token the box would have chosen. (Those names are core's own
plumbing for the credential helper, not something a pack should read; `$GITHUB_TOKEN` is the
name packs are promised.)

The set in that file is this box's, not the installation's, so a scope you expected and cannot
find usually means the repository was not declared when the server was created — the server's
detail page lists what it carries, and the answer is the same either way: recreate with the
repository declared, or authenticate that clone by hand.

## Your own startup script on a new server

The create form's **Startup script** field takes a shell script that the box runs once, during
setup, before it is handed to you. It is Rocky Surf's answer to
[EC2 user data](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html), with one
thing EC2 does not offer: you choose whether it runs as `root` or as `rocky`, the unprivileged
account you SSH in as. `rocky` is the default, because that is the account whose home directory,
`PATH` and toolchain the pack just finished building.

The field is on the form for every pack. A pack neither grants it nor knows about it — it is your
instruction to your own box.

**The contract, exactly:**

| | |
|---|---|
| **When it runs** | Once, near the end of setup: after every tool in the pack is installed, after your repositories are cloned, and after each tool's setup script. Before the login banner, the desktop password and the SSH-key retirement, which are Rocky Surf's own last steps. |
| **As whom** | `root` or `rocky`, as you chose. Rocky Surf drops privilege for you; do not write `sudo -u rocky` wrappers of your own. |
| **What it gets** | The same environment a pack script gets: `$ARCH`, `$HOME` (of whoever is running it), `$REPOS` (comma-separated clone URLs, possibly empty), `DEBIAN_FRONTEND=noninteractive`, `$GITHUB_TOKEN` and `$RDP_PASSWORD` when they are configured, and git's credential environment so a `git clone` of a private repository authenticates the way the plan's own clones did. |
| **How it is run** | With `bash`. Nothing is added to your script except that environment — in particular **no `set -e`**: the step's exit status is your script's own, exactly as with EC2 user data. Write `set -euo pipefail` at the top yourself if that is what you want. |
| **If it fails** | The server still comes up. A failed script is recorded as a **warning**, with its whole log, on the server's page — the same treatment a repository that would not clone gets, and for the same reason ([ADR-0010](adr/0010-failed-tool-install-terminates-the-box.md)): everything you actually ordered is on the box, and you need the box in order to fix the script. Only a failed *tool install* releases a machine. |
| **How long it may take** | 30 minutes, after which the step is killed and recorded as a warning. |
| **How big it may be** | 16 KiB, the same ceiling EC2 puts on user data. Anything larger belongs in a repository the box clones — have the script run *that*. |
| **Run once, or every boot?** | Once, during setup, and never again. It is a step in the install plan, not a boot hook. If you want something to run on every boot, have the script install a systemd unit that does. |

**It is not a place for secrets.** The script is stored in Rocky Surf's database and sent to the
box in plain text, exactly like a pack's install script, and it is visible to anyone who can read
either. Credentials reach a box through the mechanisms built for them — the GitHub token above,
and the desktop password — never through this field.

From the CLI, the script is a file rather than an argument, because an argument would be readable
through `ps` on the machine you typed it on:

```bash
rockysurf create --pack ai-coding-agents --user-script ./boot.sh
rockysurf create --pack ai-coding-agents --user-script ./boot.sh --user-script-as root
```

A bad path, an empty file or one over 16 KiB is refused before anything is provisioned.

While the box comes up, the creation screen shows this step as **Running your script**, so a long
one reads as progress rather than as a hang.

[ADR-0011](adr/0011-user-script-at-create-time.md) records why the step sits where it does, and
why a failure is a warning rather than a dead machine.

## Settings a pack asks you for

A pack can need a value before it installs anything — an API key, an endpoint, a flag that picks
between two install modes. It declares them in its own file, so the create form grows a field per
value with nobody editing the app: the same mechanism that gives a desktop pack its password
field. A pack that asks for nothing shows no such section, which is every pack Rocky Surf ships
today.

What you type is delivered to that pack's install scripts as **environment variables**, in the
same `0600` file the GitHub token and desktop password arrive in — and, once the box is up, it
is in your shell too: an SSH login, `ssh box 'command'`, tmux and the desktop session all see
`$NAME` with the value you gave (issue #244; the how and where is under
[Your own environment on a box](#your-own-environment-on-a-box)). It is not a secret store you
can read back through the app.

**Where the values live afterwards:**

| | |
|---|---|
| **An ordinary value** | Stored on the server's row and shown on its page, so "what was this box built with" has an answer after the create screen is gone. |
| **A value the pack marked secret** | Stored encrypted, beside the desktop password, and returned by **no** route — not the server page, not the API, not the list. Rocky Surf will not show it back to you, so keep your own copy. (The box has it: it is in `rocky`'s shell and in `~/.config/rockysurf/environment` there. What refuses to hand it back is the control plane, not the machine you put it on.) |
| **Either** | Never written into the install plan, which is stored in the clear and quoted in failure reports. |

**A required setting with nothing in it refuses the create**, before a machine is launched. That
is deliberate: the alternative is a box that boots, installs everything, and then fails the
pack's own step — minutes later, and billed by the hour.

**Changing a pack after a server exists changes nothing about that server.** The values are the
ones its creator gave, kept on its row; if the pack later adds a setting, an existing box simply
does not have it, and if the pack drops one, the box keeps it. Only new servers are asked the new
questions.

From the CLI, one flag per value, or a file:

```bash
rockysurf create --pack headlong --input HEADLONG_HEADLESS=1 --input HEADLONG_MODEL=large
rockysurf create --pack headlong --inputs-file ./headlong.env
ROCKYSURF_INPUT_HEADLONG_API_KEY=... rockysurf create --pack headlong --input HEADLONG_HEADLESS=1
```

`--inputs-file` is `NAME=VALUE` per line with `#` comments — nothing in it is expanded or run.
A **secret** setting is refused on the command line, exactly as `--rdp-password <value>` is: an
argument is readable through `ps` by every process on the machine and is written to your shell's
history file. Supply it in a file or in `ROCKYSURF_INPUT_<NAME>`. Everything is checked against
the pack's declaration before anything is created, so a misspelled name costs a sentence.

[ADR-0013](adr/0013-packs-declare-their-inputs.md) records the contract; pack authors should read
the `inputs` section of [`writing-a-pack.md`](writing-a-pack.md#inputs--what-your-pack-asks-the-user-for).

## Your own environment on a box

A pack asks for what *it* needs. **Environment**, the field above the startup script on the create
form, is for what *you* need — a token your startup script reads, an endpoint for something you
install by hand, a `GIT_AUTHOR_NAME` for the box. One `KEY=value` per line:

```
MY_ENDPOINT=https://api.example.com
GIT_AUTHOR_NAME=Ada Lovelace
secret:MY_API_TOKEN=…
```

Every line becomes an environment variable in **every step of that box's setup**, including your
startup script — which is why the startup script's hint tells you to put a token here and read
`$MY_API_TOKEN` there, rather than typing it into the script itself. The script is stored and
pushed in plain text; this is not.

**And it is in your shell on the box, by default.** Every line, and every setting the pack asked
for, is exported into each shell `rocky` gets: an interactive SSH login, `ssh box 'command'`, a
tmux session, and the remote-desktop session when the pack has one — with the values setup saw.
Type `secret:ANTHROPIC_API_KEY=…` here, SSH in, and the harness that reads that variable finds
it; nothing to export first. `$GITHUB_TOKEN` is there too when the operator configured one, so
`gh` works as it is. The desktop password and Rocky Surf's own plumbing are not.

Where it lives: `~/.config/rockysurf/environment`, owned by `rocky`, mode `0600`, written once
at the end of setup as `export KEY='value'` lines and sourced by two files Rocky Surf installs —
`/etc/profile.d/rockysurf-environment.sh`, and a marked block at the top of `/etc/bash.bashrc`
(above Ubuntu's "if not running interactively" line, which is what makes `ssh box 'command'`
work). Your own `~/.bashrc` runs after both, so an `export` there wins, and you can replace your
dotfiles wholesale without losing anything. A `secret:` value is therefore on disk in your home
directory in the clear: this is your box, the same value was already handed to every install
step, and `rocky` has `sudo` regardless — but it is worth knowing before you back the home
directory up somewhere else.

**A line starting with `secret:` is stored encrypted** and returned by no route: not the server
page, not the API, not the list. Rocky Surf will not show it back to you, so keep your own copy —
the box will, in the file above, to anyone who can open a shell on it. A line
without the marker is stored in the clear and shown on the server's page, so you can answer "what
was this box built with" months later.

A few rules, and why:

| | |
|---|---|
| **Names** | `UPPER_SNAKE_CASE`. Names Rocky Surf itself exports are refused — `HOME`, `PATH`, `GITHUB_TOKEN`, `RDP_PASSWORD`, `REPOS`, anything starting with `ROCKYSURF_`, and the four `GIT_*` names the clone step writes. Everything else git reads is yours. |
| **A name the pack already asks for** | Refused, naming the key. Both fields would write one variable and only one value could reach the box, so the create is refused rather than one of your answers being dropped silently. |
| **Values** | One line, at most 4 KiB each. Spaces, `$`, backticks and quotes are all safe — values are quoted on the way to the box, never interpreted. |
| **Afterwards** | There is no way to change any of it through Rocky Surf on a running box. The environment is written once, when the box is built; on the box itself, `~/.config/rockysurf/environment` is a file you own, and `~/.bashrc` overrides it. |

From the CLI, one flag per line, or a file in the same format the form's box takes:

```bash
rockysurf create --pack claude-code --env MY_ENDPOINT=https://api.example.com
rockysurf create --pack claude-code --env-file ./env.txt
```

A `secret:` value is refused on the command line, exactly as `--rdp-password <value>` is: an
argument is readable through `ps` by every process on the machine and is written to your shell's
history file. Put it in the file instead.

[ADR-0014](adr/0014-per-server-environment-at-create-time.md) records the contract.

## Surge Packs, and what happens when one breaks

Surge Packs are the software bundles a server is created with, loaded from YAML files in `packs/`
and synced into the database on boot. The files are the source of truth; the database is a cache
and edit layer. (The product says "Surge Pack"; the directory, the `packId` key and the code all
say `pack`. Both spellings are load-bearing and neither is changing.)

**If a pack file fails validation, its packs disappear from the picker until the file is
fixed** — as long as the rest of the set still loads. A broken file is excluded from the
reconcile, and because the reconcile deletes file-backed rows it no longer sees, the pack is
dropped from the database rather than left serving its last-good definition. Nothing is lost permanently — fix the file, restart, and the
pack returns. **A bad file never stops the server from starting**; the issues are printed
verbatim at boot, each naming its file and what is wrong with it.

That is a deliberate choice (`rockysurf-a0ss`), not an accident of the implementation. The
alternative — freezing the last-good version whenever a file breaks — would let a pack that no
longer validates keep installing software indefinitely, with the divergence invisible. Nothing
installable should exist that cannot validate.

**The part that surprises people: a broken file can take other packs down with it.** Packs share
tool definitions by referencing ids across files, and a reference to a tool that is not defined
anywhere is itself a validation issue — charged to the file doing the *referencing*. So breaking
a file that defines shared tools invalidates every file that depends on it.

That is not hypothetical with the shipped set. `ai-coding-agents.yaml` defines the 16-tool base
toolchain, and the other five packs reference 15 to 18 tools apiece that are defined outside
themselves — `amp-agents`, `codex-cli`, `open-claw` and `open-code` each pull 15 from
`ai-coding-agents`, and `gas-town` pulls 18 from three different files. A syntax error in
`ai-coding-agents.yaml` alone therefore invalidates every shipped pack, and the boot log will
name all six files rather than the one you edited. **Read the log from the top: the first file
listed is usually the one to fix.**

### When a server's setup fails

A server is only `running` once every required step of its install plan has finished. When a
**tool install** fails — a package mirror down, a script that exits non-zero — Rocky Surf
**terminates the machine** and fails the server with a complete report: which tool, why (in words,
with the decisive lines from the log), the whole log of that step, and what happened to the
machine. Nothing the user made exists on a box before it is ready, so there is nothing to keep, and
a half-installed box would only bill. The failed server stays on the dashboard with its report
until you dismiss it, and is not billing.

When a **repository fails to clone**, the box is delivered anyway — that is a warning on the
running server, naming the repository and the reason, not a failure. Other finishing steps that
fail (the login banner, the remote-desktop password) keep the machine up with the still-billing
notice, as before.

To keep a failed box up for hands-on debugging — a pack author's need, not a user's — set:

```yaml
bootstrap:
  onFailure: keep   # default: terminate
```

See ADR-0010 for the reasoning, and `docs/writing-a-pack.md` for the debugging workflow.

### Where the pack files come from

First match wins, and the boot notice names which one it used:

| | Source | When |
|---|---|---|
| 1 | `./packs` in the working directory | You are running from a checkout. |
| 2 | `<dataDir>/packs` | It holds pack files — you are running your own catalog. |
| 3 | The packs the release ships | Everything else, which is what `npx rockysurf` and the image do. |

Tier 3 is why "official" means something: an official pack is one that **shipped with the release
you are running**. It is read out of the installed package rather than copied into your data
directory, so upgrading brings the new set and retires anything dropped upstream — a copy would
have frozen your catalog at whatever your first install happened to ship.

**One directory wins.** If you put pack files in `<dataDir>/packs`, you are running your own
catalog and the shipped ones are not merged in underneath. That is the rule this has always had
between a checkout and the data directory, extended by one tier rather than changed. It also
means a pack that exists only in a checkout is removed by a boot taken outside that checkout —
recoverable by booting from the checkout again, and the same rule as any other file the source no
longer offers.

To edit a shipped pack, export it from the admin UI, change it, and import it back — the path
[ADR-0004](adr/0004-packs-as-pr-able-yaml.md) describes. The files inside the installed package
are not meant to be edited in place.

**What none of this does is empty the picker.** Deleting a pack's rows is a conclusion drawn from
a source that was read successfully, so a boot that loaded no pack at all — every file broken, or
an empty `packs/` directory in a release that ships none — draws no conclusion and changes
nothing. The database keeps what it has and the boot says so:

```
packs: no checkout detected (no packs/ in /home/you, none in /home/you/.rockysurf/packs) — leaving 6 database pack(s) as they are
```

That boundary is `rockysurf-96ce`, and it is why running `rockysurf` from your home directory is
safe. It matters for the same reason at install time: an `npx` installation never has a checkout,
so pack sync there is a no-op rather than a mass delete. The narrow thing it costs you is
emptying the catalogue by deleting every pack file at once — do that from the admin UI, one pack
at a time, where it is unambiguous.

## The pack registry

Packs also come from a **registry** — a separate repository of pack files plus a generated
`index.json`. The default is
[`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop). Browsing it and
installing from it happen in the admin UI, and an installed pack appears in the picker
immediately: no restart.

```yaml
registry:
  enabled: true
  sources:
    - name: Rocky Surf Pack Shop
      url: https://raw.githubusercontent.com/amroja-biz/rockysurf-shop/main
      trust: community
    - name: My packs
      url: https://raw.githubusercontent.com/me/my-packs/main/my-pack.yaml
      trust: community
  cacheTtlSeconds: 300
```

`sources` is a list, so an organisation can serve packs internally without giving up the public
shop — and so can one person, with packs of their own.

### Three ways to get your own pack onto your instance

All three end in the same place: a database row the boot reconcile never overwrites and never
deletes. What differs is who else can get the pack, and whether Rocky Surf remembers where it
came from.

Surge Packs (`/packs`) → **Personal** → **New Surge Pack** opens a chooser between the first and
third of these; the second is a config-file thing, not a button on this page.

1. **Upload a file.** One `.yaml` file, one time, nothing recorded about its origin because there
   is nothing true to record — the bytes came from your own machine.
2. **Add it as a source.** A line in `registry.sources` — or the **Pack sources** tab of the
   admin Settings page, which writes the same file. A source URL ending in `.yaml`/`.yml` is a
   one-file pack, fetched exactly like a directory-backed registry; either way the pack appears
   in Community's catalogue, refreshes when you press Refresh, and can be reinstalled after you
   have edited it. This is the option for a pack you are still working on, and the only one
   somebody else can subscribe to — a one-off `https` URL import used to be a second button on
   this page, and issue #204 retired it in favour of this: a source you add once is remembered
   and reinstallable, where a one-time fetch of the same URL was neither.
3. **Start from an existing pack.** New Surge Pack's third choice: pick any pack already on this
   installation — official, community or personal — and the same create form as **Start from
   scratch** opens, seeded with a new `packId` and name and the source's own tools already
   checked. This is also what happens when you add one of your tools to an official pack from the
   Tools page: **an official pack is never changed, it is copied.** The copy remembers what it
   started from, keeps that pack's mark with a small bright **∆** on it, and appears on Personal —
   while the official pack stays on Official, unchanged and still selectable. **Only your copy
   gets the ∆**: it is the one that was modified, and it is wearing artwork that belongs to the
   official pack, so the ∆ is what says so. The official pack gets a different and quieter mark in
   the opposite corner — a small outlined **⧉** — meaning "a personal version of this exists",
   never "this was changed". Rest on either mark to see which pack it means. Nothing syncs between them: the copy's list of tools is yours from that moment, though
   the tools themselves stay up to date, because a pack references tools rather than containing
   them. A copy you **export** carries no mark and no borrowed artwork — the person you send it to
   has not forked anything, so official-looking art on their installation would be a lie. Deliberately not `Export`'s output: Export inlines a full definition for every tool
   the pack references, and importing that back would redefine — not reference — every one of
   them, up to and including the shared base tools other packs depend on. This seeds from the
   pack's tool **ids** instead, the same as picking them by hand, which is the UI version of
   `docs/writing-a-pack.md` § "Building on an existing pack".

A source's URL says what shape it is. **Ending in `.yaml` or `.yml`, the URL is the pack** — one
file, the way you publish one of your own. **Anything else is a directory** serving `index.json`
beside its pack files, exactly as the shop does; that is the format to use when you have several,
and `rockysurf pack index` generates it.

**A source URL must be `https`.** A pack is install scripts that run as **root** on every box you
create with it, and over plain http anything on the path can rewrite them in transit — including
the digest that is meant to catch that, since it arrives over the same connection. A source is
also **admin-only** to add, in the config file and on the Settings page alike, and the page saves
the same way every other setting does: **it takes effect as soon as it is saved**, on the next
listing the shop fetches.

**Adding a source fetches nothing and runs nothing.** It records a URL. The pack behind it is
fetched when an admin opens the shop, and it is installed only after they have read every script
it would run — and installing is still only writing rows. Nothing from a source executes until
you create a box with that pack. Refreshing the shop refetches the listing; it never runs
anything, and it never installs anything on its own.

One thing a one-file source does not get: an index somebody else generated. For a directory, the
digest pins each pack file to a listing that was made separately, so a file swapped without
regenerating the listing is refused. For a single file, both halves come from the same fetch, so
what the digest still buys you is narrower and worth stating exactly — the file is refetched at
install and refused if it no longer matches what you were shown, so the scripts you read are the
scripts you get.

**Nothing here is read at boot.** A registry is fetched when you open the shop, never during
startup, so a control plane behind a proxy or off the internet entirely starts exactly as it does
now. Set `enabled: false` for an air-gapped installation — the shop then says it is switched off,
which is deliberately a different message from a registry it could not reach. **One registry
being down never blanks out the others**; each shelf reports its own packs or its own reason for
having none.

Fetches are plain file GETs against a source's `url`: `<url>/index.json` for the listing, then
the paths that listing names — or, for a source that is itself a `.yaml` file, that one URL and
nothing else. **Not the GitHub API**, whose unauthenticated quota is 60 requests
per hour shared across everything on one source IP — a control plane behind a corporate NAT would
spend that before it had listed the shop once. Every URL goes through the same SSRF guard as pack
import (see [`SECURITY.md`](../SECURITY.md) § Server-side fetch policy), so one resolving to a
private address is refused whatever you set. That includes an internal registry on an RFC1918
address: vouching for a host is not supported here yet.

### Official packs are not in a registry

This is the split-horizon arrangement, and it is worth being precise about because the labels
only mean something under it.

- **Official packs ship in the Rocky Surf tarball**, in `packs/`, and are what the picker has
  before you have browsed anything. No registry supplies one, and no registry can.
- **A registry's packs carry the label YOU gave that registry** in `sources[].trust`: `community`
  or `internal`. There is no `official` value, because a registry claiming it would be a third
  party dressed as first party.

The label is deliberately **not** something a registry publishes about itself. A trust field
inside a registry's own index would be a claim about trustworthiness written by the party being
trusted, and no better than the document containing it. Yours lives in your config file, next to
the URL you chose to add.

The shop page shows bundled and registry packs together, each labelled with where it came from.

### What the checks prove

A pack in the shop has passed `rockysurf pack lint` and `rockysurf pack check` in the registry's
CI, and been read by that registry's maintainers. Those checks prove a pack is **well-formed and
survives being resumed**. They do not prove it is safe, and nothing in Rocky Surf claims they do:
an install script is arbitrary shell that runs as **root** on your box, and no schema check can
decide whether it is benign.

Before installing anything from a registry the admin UI shows you every script it will run,
verbatim, along with which steps run as root and every URL they fetch. That disclosure is the
control. Read it.

It lives at **Surge Packs** (`/packs`), which is also where you can see what you already have and
where each of it came from: `official` for the packs that shipped with your release, `registry`
for anything that arrived from off this machine, and `local` for packs you created yourself. Three
tabs carry those three words as their name — **Official**, **Community**, **Personal**, Official
shown first — and a card's badge reads the same word its tab does (`registry` shows as COMMUNITY,
`local` as PERSONAL; the value behind the badge does not change, only what you read). The tab is
in the URL (`?tab=community`), so a link lands on the one it names.

Two different marks can appear on a pack's icon, and they mean different things. A small bright
**∆** on the top right means *this pack is a copy of another one* — only a pack you made carries
it, never an official pack. A quieter outlined **⧉** on the bottom right means *a personal version
of this pack exists*; that is the one an official pack gets, and it never means the official pack
was changed. A copy that has itself been copied shows both, which is why they sit in opposite
corners. They are marks and nothing more — they filter nothing and disable nothing, and no
official pack is ever written to.

**Putting one tool on every box.** A tool reaches a box only through a Surge Pack, so registering
one installs nothing by itself; the Tools page's **Add to a pack…** is how it gets somewhere. It
adds the tool to a pack of your own outright, and offers to copy an official one for you. Beside
those is the other option — **install it on every box you create from now on** — which is one
setting rather than an edit to every pack, so a pack you make next month gets it too. It is asked
for explicitly, because the blast radius is every server you create afterwards: a tool set this way
must not depend on anything a particular pack installs, since **a tool that fails to install
terminates the box**, and one that is wrong here breaks every new server rather than one. Servers
that already exist never change — a server's install plan is written when it is created. The New
Server page lists these under the pack chooser so what you are about to install is on the screen
before you install it, and deleting such a tool warns you, because the guard that refuses to delete
a tool a pack is using cannot see this one: no pack lists it.

Community carries a fixed caption naming where its catalogue comes from — *Community packs from
Rocky Surf Shop* — and a filter — **All** / **Installed** / **Not installed**, defaulting to
**Installed** — rather than an installed registry pack and its catalogue listing being two
different things to scroll past. **Not installed** is where the catalogue's Review button, and
installing, still happen. A card carries the pack's mark, its name and that badge; open the pack
for the rest. On a pack's own page an admin also sees the source **and its URL** — or, for a
one-off import, the URL it was fetched from. There is no install button anywhere except below
those scripts.

Resting on **any** pack's card for a second opens what it installs, with a button to create a
server with it and one to export its file. Every pack's own page also shows that file in full,
read-only, with **Export** beside it as a file to drop into `packs/` and commit — for an official
pack because it shipped in your release and there is nothing in it you cannot already read in
`packs/`, and for a pack you created or installed from a registry because the same route already
answered `Export`, so withholding the read-only view of the same bytes was never protecting
anything.

One thing the summary on that page says about itself, worth repeating here: the list of URLs is
derived by reading the scripts, so a script that builds a URL out of a variable will not appear
in it. The scripts are the ground truth and the summary is a reading aid.

Each index entry pins its pack file by SHA-256, and a file that does not match the digest the
registry published is refused rather than installed. That catches a pack changed without the
index being regenerated. It is **not** a signature — whoever can write the index can write both
halves — so the trust chain is the registry repository's branch and its host's account controls,
and no more than that.

A pack installed from a registry lands as a **database row with no `sourceFile`**, exactly like
one you create in the admin UI. The boot reconcile described above never touches it: it deletes
file-backed rows whose files have gone, and a registry pack was never file-backed. So it survives
restarts, and removing it is something you do explicitly in the admin UI.

## What an agent connected over MCP may do

`mcp.scopes` decides, and it defaults to `[read, stop]`. That grant advertises everything that
reads (`list_servers`, `get_server`, `get_ssh_command`, `list_offerings`, `list_packs`,
`list_providers`, `get_provider`, `list_ssh_keys`) and the pause/resume pair (`stop_server`,
`start_server`).
`create_server` needs `create`, and `terminate_server` needs `terminate`: both are opt-in,
because making a box costs money and destroying one costs work that does not come back.

**An agent reporting that there is no `create_server` tool is reporting this setting.** The tool
exists and has since the MCP server did; the default grant withholds it, and a tool the
installation has not granted is not offered to the client at all. Under a grant that withholds
it, the tools that do get offered say so in their own descriptions rather than leaving the
absence to be guessed at.

To grant it: tick `create` under **Settings → MCP** (or add it to `mcp.scopes` in the config
file), then **reconnect the MCP client**. Scopes are read by the separate process your client
starts with `rockysurf mcp`, when that process starts — Rocky Surf itself needs no restart, and
nothing changes for an already-connected client until it reconnects. In Claude Code that means
restarting the session.

The blast radius each scope buys, and why the split is where it is, is in
[`SECURITY.md`](../SECURITY.md#the-scope-split).

## Security

The short version: it binds loopback, it has no TLS of its own, one password guards the UI, and
the process holds every credential you have given it. Widening `server.host` is a deliberate act
that should be paired with a reverse proxy or a firewall.

The long version — credential custody, SSH host-key pinning, the box-facing callback routes, the
MCP threat model, and the residual risks — is [`SECURITY.md`](../SECURITY.md). Read it before
you expose this to anything.
