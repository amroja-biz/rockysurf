# BYO — machines you already have

`@rockysurf/provider-byo` manages boxes that exist already: a workstation under a desk, a rack
in a colo, a VM someone else provisioned. There is no cloud API behind it. The API is `sshd`.

That removes most of a provider — nothing to create, nothing to bill, nothing to power-cycle —
and leaves a **registry** of hosts plus a **claim**: `provision()` takes a registered host and
prepares it, `terminate()` gives it back.

## Configuration

```yaml
providers:
  byo:
    enabled: true
    identityFile: ~/.ssh/id_ed25519      # default login key for every host below
    hosts:
      - name: workshop                   # its name in the UI, and how you pick it
        host: 10.0.0.9
        user: root                       # the ADMIN login Rocky Surf claims with
        port: 22
        fingerprint: "SHA256:…"          # optional — see "Host keys" below
        identityFile: ~/.ssh/workshop    # optional, overrides the default above
```

**Two accounts, and confusing them is the mistake worth avoiding.**

- `user` is the **admin login the provider claims with**. It needs root or passwordless sudo. It
  defaults to `root` because that is usually what an operator's existing access is.
- The account **Rocky Surf later connects as** is `rocky`, and you do not configure it. The
  provider creates it during the claim.

`port` is the box's real sshd port and defaults to 22. A host on another port is claimed on it
**and bootstrapped on it**: the provider reports the port to core (ADR-0003 amendment E13), so
core's push bootstrap dials it and the `ssh` command the UI and the CLI show you carries `-p`.
That was not true before `rockysurf-ftl9.12` — core dialled 22 regardless, and a host registered
anywhere else was claimed, prepared and then never bootstrapped.

Credentials are never stored. `identityFile` is a **path** — the key stays where your own SSH
already keeps it, and nothing copies it into the config file or the database. With an SSH agent
running you can omit it entirely: if you can already `ssh` to these boxes, that is enough.

## What claiming a host does to it

A cloud provider hands cloud-init a `#cloud-config` before the machine boots. There is no
pre-boot hook on a machine that is already running, so the provider does the same work over SSH,
once, at claim time:

1. create the `rocky` account if it is absent;
2. append Rocky Surf's public key to `~rocky/.ssh/authorized_keys` — **appended, never
   truncated**, so nothing you already had in that file is disturbed;
3. write `/etc/sudoers.d/90-rockysurf-rocky` granting it passwordless sudo.

Passwordless sudo is not a convenience: the bootstrap agent installs software as root and asks
systemd for liveness through `sudo systemctl is-active`. A box without it fails bootstrap several
minutes in, with an error that looks like a pack bug.

Every step is idempotent. Re-claiming, a retried create and a restart recovery pass all re-run it.

After that point BYO is the ordinary **push bootstrap**, byte for byte the same path both clouds
use after first boot.

## Host keys

`canInjectHostKeys` is `false`: with no user-data, core cannot mint the key the box will present.
So the key is **learned** instead.

- **With `fingerprint:` in the config** — strict verification from the very first connection.
  Read it off the box yourself:

  ```bash
  ssh-keyscan -t ed25519 10.0.0.9 | ssh-keygen -lf -
  ```

- **Without it** — trust-on-first-use. The key seen on the first connection is recorded and
  pinned; every connection after that is strict. A changed key is refused and never retried,
  because a box presenting a different key is not the box you registered.

**The key itself travels too, not only its fingerprint.** The handshake above hands the provider
the box's raw host key, so it keeps it and reports it alongside the pin (ADR-0003 amendment E14).
That is what lets `GET /api/v1/servers/:id/ssh-host-key` serve a real `known_hosts` entry for a
machine Rocky Surf did not create, exactly as it does for a cloud one — so `rockysurf ssh` and
the config written by `rockysurf ssh-config` both connect with `StrictHostKeyChecking yes`, with
no trust-on-first-use window and no weaker rule for BYO than for anything else.

The fingerprint stays the pin, and the key is checked against it every time it is read back out
of storage. If the two ever disagree, the pin wins, the key is dropped, and the route answers
`409` with the fingerprint rather than serving anything — the failure mode is "no entry", never
"the wrong entry" (`rockysurf-ftl9.13`, `rockysurf-ftl9.14`).

**The trusting happens in the provider, not in core.** The provider connects before core does, so
what reaches core is a fingerprint to verify against — a pin, not permission to trust. Core's own
verification stays strict, exactly as it is for a cloud box (ADR-0003 amendment E12,
`docs/bootstrap-contract.md` push #15).

## What it cannot do

- **`stop` / `start` are unsupported.** Core does not own the power state of a machine it did not
  create. Both methods exist and both throw, per ADR-0003 (A2); the UI hides the buttons because
  `capabilities.stop` is false.
- **No pre-boot configuration.** `userDataMaxBytes` is `0`, and a spec carrying any user-data at
  all is refused.
- **No liveness in `describe()`.** The claim is the state. A registered box that is powered off
  reports `running` until something tries to connect to it; bootstrap is what actually finds out,
  and the provisioning timeout is what bounds it.

## Releasing a host

`terminate()` **runs nothing on your machine — not one command, not one connection.** It releases
the claim and returns the host to the pool. That is a rule, not an omission: the machine is
yours, it was running before Rocky Surf existed, and a background reconciler sweep is the last
thing that should be deleting accounts on it.

The consequence is worth stating plainly: **the `rocky` account, its authorized key and its
sudoers file stay behind.** If you want them gone, remove them yourself:

```bash
sudo userdel -r rocky && sudo rm -f /etc/sudoers.d/90-rockysurf-rocky
```

It is also what makes `listManaged()` safe. A claim is reported as `server-owned`, so a claim with
no live server reads to the reconciler as a reap candidate — and reaping one costs a bookkeeping
record, never a machine.

## Sizes

`listOfferings()` reports one offering per registered host, because on BYO the host *is* the
machine type. Cores, memory, architecture and root-disk size are **read off the box** (`nproc`,
`/proc/meminfo`, `uname -m`, `df`) rather than declared in configuration, and cached for the life
of the process.

A claimed host is reported with `available: false` rather than hidden, so the size selector can
say "in use". A host that cannot be reached is omitted — inventing a core count to satisfy the
shape would be worse — and `validateCredentials()` is where an unreachable host is reported
loudly. Prices are `null`: Rocky Surf has no idea what your own hardware costs you, and `0` would
be presented as free.

## Limits

- One provider instance owns one registry. Two fleets means two configurations.
- Claims live in memory and are re-adopted from the database on restart, along with their pins.
- Only `x86_64` and `aarch64` are supported; anything else is refused rather than guessed at.
