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
| **Hetzner** | The quickest start. Create a project, mint a read/write API token, paste it. No role to deploy and nothing to prepare — [`providers/hetzner.md`](providers/hetzner.md). |
| **AWS** | Uses the standard credential chain, never a key in the config file. Needs an IAM policy and an explicit `sshAllowedCidr` — [`providers/aws.md`](providers/aws.md). |
| **Azure** | Credentials from your environment, a managed identity, or `az login` — never from the config file. Needs a resource group you create, a least-privilege role and an explicit `sshAllowedCidr` — [`providers/azure.md`](providers/azure.md). |
| **GCP** | Uses Application Default Credentials — `gcloud auth application-default login`, a key file, or the metadata server — never a key in the config file. Needs a project and an explicit `sshAllowedCidr` — [`providers/gcp.md`](providers/gcp.md). |
| **BYO** | Machines you already have, over SSH. No cloud API — [see below](#bring-your-own-hosts). |

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

> **Not published yet.** This path needs the nine packages on the public npm registry, which
> happens at the v0.1.0 launch ([`RELEASING.md`](RELEASING.md)). Until then, use Compose, or run
> `pnpm -r build` in a checkout and start `node packages/rockysurf/dist/bin.js` — the same binary
> `npx` will fetch.

Requires Node 24 or newer; the binary checks and says so if not. Nothing else: with no config
file anywhere it starts on defaults, says where a config file would go, and offers the
in-memory provider — so you can create a server, watch it boot and terminate it before
deciding whether to paste a cloud token.

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

# npx — once v0.1.0 is on npm; from a checkout it is `git pull && pnpm -r build` instead
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

## Repositories, and how private ones clone

The Repositories field on the create-server form takes one git URL per line, and each one is
cloned into the home directory of the box during setup.

**Public URLs work with no credentials at all.** The clone runs anonymously; nothing needs
configuring, and this is the case the shipped packs are built around.

**Private repositories need a GitHub token, and `github.pat` is where it goes:**

```yaml
github:
  pat: "${GITHUB_PAT}"
```

`${GITHUB_PAT}` is interpolated from the environment when the config is read, so the token does
not sit in the file — export it in your shell, or put it in the `.env` you loaded before starting
(`GITHUB_PAT=` is already in `.env.example`). **Write the reference rather than the token.** This
file gets backed up, copied to a second machine and pasted into a bug report; a reference survives
all of that and carries nothing, and a `${VAR}` that is not set is a boot error naming the variable
rather than a silent empty token. The parser will accept a literal string if you hand-edit one in —
the Settings page will not write one, and shows any literal it finds as *stored* with a note
suggesting you move it out. The token needs whatever scope reads your repositories: `repo` on a
classic PAT, or contents-read on a fine-grained one.

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
environment variable it comes from — or that the repository is public and needs none, or that
nothing matches it yet. If you have just added a token on the Settings page, it will also tell you
that the entry exists but this process has not restarted into it, and whether the variable it
names is exported (if it is not, that restart will refuse to start — see the note about `${VAR}`
above).

**And it offers what you have already configured, so you do not retype it.** Every entry above
that names both an owner and a repository is a one-click chip on the create form: clicking it puts
that repository's HTTPS URL in the box, where it is resolved exactly like a URL you typed. An entry
naming only an account (`owner: acme`) or only a host is listed beside them but is not clickable —
it names an account or a forge, not a repository, and Rocky Surf has no way to list what is under
one — so type the repository's URL and it will be matched. An entry the file holds that this
process has not restarted into is offered too, marked *after a restart*.

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
MCP tool takes `create_anyway`.

**A self-hosted forge on a private network still gets checked**, but only because you named it.
Repository URLs are user-supplied text reaching a control plane that holds cloud credentials, so
every probe goes through the same SSRF screening as the pack importer — private, loopback and
link-local addresses are refused, including the cloud metadata endpoints. The one exemption is a
host you have written into `github.tokens`: naming it there is how you tell this installation the
address behind it is yours. A redirect away from such a host is screened again like anything
else, and the token is never sent across an origin change.

**The Settings page shows all of this as one list**, under *GitHub access tokens*, because two
sections for one subject is not how anyone holding four PATs thinks about them. Each entry there
is one token and the repositories it opens; the entry with no scope is `pat`, labelled *All
repositories (fallback)*. Entries are added, changed and removed one at a time, each save going
straight to the file above.

**Every token box in the UI takes the name of an environment variable, not a token.** The box is
labelled *Token Environment Variable* and holds `GITHUB_PAT`; the file gets `${GITHUB_PAT}`. Paste
the `${GITHUB_PAT}` form if that is what you copied and it is normalised to the same thing;
anything that is not a variable name — a token, a URL, two words — is refused where you typed it,
with the reason. That keeps the GUI from putting key material into a file it also tells you to back
up. Two consequences worth knowing:

- **A literal already in the file still works and is still never shown.** It loads as before, the
  box reads *a literal token is stored in the configuration file*, and naming a variable replaces
  it. Rocky Surf will not display it back to you — see [SECURITY.md](../SECURITY.md).
- **The check is on the shape of what you typed.** A GitHub token is spelled like a legal variable
  name (`ghp_A1b2c3`), so a paste of one passes the check and lands in the file as
  `${ghp_A1b2c3}` — a variable nobody exported, which fails loudly at the next start naming that
  "variable". Guessing at values instead would refuse real variable names, so the rule stays
  syntactic and this is the honest cost of it.

Three properties worth knowing before you set any of this, and they hold for `pat` and for every
entry of `tokens` alike:

- **Rotating a token is an edit and a restart.** Tokens are read from the config file at boot and
  passed straight through; none is ever copied into the database. Change the value (or the
  environment variable behind it), restart Rocky Surf, and the next box gets the new token.
  Boxes already provisioned keep the tokens they were built with — `secrets.env` is on the box.
- **Every token is instance-wide, so scope each one like it.** Every server created on this
  installation gets all of them, whoever created it — a repo-scoped entry narrows which
  repository a token is *used for*, not which people receive it. On a single-admin install that
  is exactly what you want; in `github-device` auth mode, where other people can hold accounts,
  understand that you are handing your tokens to boxes they have root on. A per-user token
  stored through the UI does not exist yet.
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
  cacheTtlSeconds: 300
```

`sources` is a list, so an organisation can serve packs internally without giving up the public
shop. Adding one is a config change on purpose: a registry is a thing an operator should have to
write down.

**Nothing here is read at boot.** A registry is fetched when you open the shop, never during
startup, so a control plane behind a proxy or off the internet entirely starts exactly as it does
now. Set `enabled: false` for an air-gapped installation — the shop then says it is switched off,
which is deliberately a different message from a registry it could not reach. **One registry
being down never blanks out the others**; each shelf reports its own packs or its own reason for
having none.

Fetches are plain file GETs against a source's `url`: `<url>/index.json` for the listing, then
the paths that listing names. **Not the GitHub API**, whose unauthenticated quota is 60 requests
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

It lives at **Admin → Pack Shop**, which is also where you can see what you already have and
where each of it came from: `official` for the packs that shipped with your release, the label
you gave a registry for anything installed from one, and `local` for packs you created yourself.
There is no install button anywhere except below those scripts.

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

## Security

The short version: it binds loopback, it has no TLS of its own, one password guards the UI, and
the process holds every credential you have given it. Widening `server.host` is a deliberate act
that should be paired with a reverse proxy or a firewall.

The long version — credential custody, SSH host-key pinning, the box-facing callback routes, the
MCP threat model, and the residual risks — is [`SECURITY.md`](../SECURITY.md). Read it before
you expose this to anything.
