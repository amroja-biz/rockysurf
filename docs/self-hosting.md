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
you paste a real token.

| | |
|---|---|
| **Hetzner** | The quickest start. Create a project, mint a read/write API token, paste it. |
| **AWS** | Uses the standard credential chain, never a key in the config file. Needs an IAM policy and an explicit `sshAllowedCidr` — [`providers/aws.md`](providers/aws.md). |
| **BYO** | Machines you already have, over SSH. No cloud API — [see below](#bring-your-own-hosts). |

There are two ways to run it. Both give you the same thing: one process, one port, one data
directory.

## Docker Compose

```bash
git clone https://github.com/amroja-biz/rockysurf
cd rockysurf-open
docker compose up --build
```

That is the whole first run. It builds the image, starts the container, and prints the admin
password **once**:

```bash
docker compose logs rockysurf | grep -A3 'first boot'
```

Open <http://127.0.0.1:3000>, sign in with that password, and the first-run wizard asks for a
cloud credential. Paste a Hetzner token, then enable the provider in the config file and
restart — the wizard says the same thing when you get there.

### Where the data lives

Everything that must outlive the container is in the `rockysurf-data` volume, mounted at
`/data`:

| File | What it is |
|---|---|
| `rockysurf.config.yaml` | Your configuration. Seeded from the image on first start, yours from then on. |
| `rockysurf.db` | The SQLite database: servers, packs, sessions, encrypted secrets. |
| `secret.key` | The master key those secrets are encrypted with. **Back this up.** |
| `packs/` | Only used when the image has no `packs/` of its own. |

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

### Verifying a change to the packaging

```bash
node scripts/docker-smoke.mjs
```

Builds the image under its own compose project and its own port, drives a real first run
through to the wizard, stores a credential, restarts the container and reads the credential
back. It tears its own stack down on every exit path and never touches a volume you are using.

## npx

```bash
npx rockysurf
```

> **Not published yet.** This path needs the six packages on the public npm registry, which
> happens at the v0.1.0 launch ([`RELEASING.md`](RELEASING.md)). Until then, use Compose or run
> from a checkout.

Requires Node 24 or newer; the binary checks and says so if not. Nothing else: with no
`rockysurf.config.yaml` in the working directory it starts on defaults, says where a config
file would go, and offers the in-memory provider — so you can create a server, watch it boot
and terminate it before deciding whether to paste a cloud token. Write a config file when you
want to change something: copy `rockysurf.config.example.yaml` to `rockysurf.config.yaml`, or
keep one anywhere and pass `--config <path>`. A `--config` path with nothing at it is an error,
not a silent fall back to defaults.

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

## The data directory

Whichever path you used, one directory holds everything: `/data` in the container, `~/.rockysurf`
by default otherwise, `server.dataDir` in general.

It is created **owner-only (`0700`) on the first boot**, explicitly rather than through the
umask, because a typical umask yields `0755` and a world-readable directory containing
`secret.key` is exactly the quiet mistake self-hosting must not make. If the directory already
exists with looser permissions, Rocky Surf tightens it where it can and warns where it cannot —
a warning rather than a refusal, since an operator may have deliberate reasons.

Two of the things in it deserve separate thought:

- **`secret.key`** is the master key for every stored secret — provider credentials, per-server
  SSH private keys, remote-desktop passwords. Lose it and every one of them is unrecoverable and
  every server has to be recreated. Obtain it, and all of them decrypt. It is written `0600` and
  the process refuses to start if its permissions are looser than that. You can hold it outside
  the filesystem entirely by setting `ROCKYSURF_SECRET_KEY` (base64, exactly 32 bytes decoded),
  in which case nothing is written to disk.
- **`rockysurf.db`** is SQLite in WAL mode, so recent writes live in `rockysurf.db-wal` until a
  checkpoint folds them in. This matters for backups — see below.

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

**Treat the backup like the key it contains.** It holds every provider credential and every
managed server's private key in encrypted form, with the key to decrypt them in the same
archive. Encrypt it, or store `secret.key` separately via `ROCKYSURF_SECRET_KEY` and back up
only the database.

## Upgrading

There is no upgrade command. Start the new version against the same data directory; database
migrations run on boot, are recorded in the database, and are idempotent.

```bash
# Docker Compose
git pull
docker compose up --build -d

# npx
npx rockysurf@latest
```

Your configuration is not touched by an upgrade. In the container it lives in the volume and is
only ever seeded when absent, so a new image never overwrites it — which also means a new
setting introduced by a release will not appear in your file. Diff
`rockysurf.config.example.yaml` against yours after a release; every value in the example is the
default, so anything you leave out keeps working.

**Take a backup before upgrading.** Migrations move forward only.

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

## Packs, and what happens when one breaks

Packs are the software bundles a server is created with, loaded from YAML files in `packs/` and
synced into the database on boot. The files are the source of truth; the database is a cache and
edit layer.

**If a pack file fails validation, its packs disappear from the picker until the file is
fixed.** A broken file is excluded from the reconcile, and because the reconcile deletes
file-backed rows it no longer sees, the pack is dropped from the database rather than left
serving its last-good definition. Nothing is lost permanently — fix the file, restart, and the
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

That is not hypothetical with the shipped set. `ai-coding-agents.yaml` defines the 15-tool base
toolchain, and the other four packs reference 14 to 17 tools apiece that are defined outside
themselves — `amp-agents`, `codex-cli` and `open-claw` each pull 14 from `ai-coding-agents`, and
`gas-town` pulls 17 from three different files. A syntax error in `ai-coding-agents.yaml` alone
therefore empties the picker completely, and the boot log will name all five files rather than
the one you edited. **Read the log from the top: the first file listed is usually the one to
fix.**

## Security

The short version: it binds loopback, it has no TLS of its own, one password guards the UI, and
the process holds every credential you have given it. Widening `server.host` is a deliberate act
that should be paired with a reverse proxy or a firewall.

The long version — credential custody, SSH host-key pinning, the box-facing callback routes, the
MCP threat model, and the residual risks — is [`SECURITY.md`](../SECURITY.md). Read it before
you expose this to anything.
