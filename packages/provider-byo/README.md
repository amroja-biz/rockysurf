# `@rockysurf/provider-byo`

Runs Rocky Surf dev boxes on machines you already own: a workstation under a desk, a rack in a
colo, a VM somebody else provisioned. There is no cloud API behind it — the API is `sshd`. It
creates nothing and destroys nothing; it keeps a **registry** of your hosts and hands one out at
a time.

- [How you get it](#how-you-get-it)
- [Configuration](#configuration)
- [Credentials](#credentials)
- [What it needs on your machines](#what-it-needs-on-your-machines)
- [Capabilities](#capabilities)
- [Prices](#prices)
- [Verified](#verified)
- [Writing your own provider](#writing-your-own-provider)

## How you get it

It is already there. The `rockysurf` CLI depends on this package, so `npx rockysurf` can claim
your own hardware as soon as you switch it on. Providers are constructed at boot, so a
configuration change takes effect at the next restart.

Install it directly only if you are embedding Rocky Surf's provider in something of your own:

```bash
pnpm add @rockysurf/provider-byo
```

```ts
import byo from '@rockysurf/provider-byo'

const config = byo.configSchema.parse({
  hosts: [{ name: 'workhorse', host: '10.0.0.7', user: 'ubuntu' }],
  sshUser: 'rocky',
})
const provider = byo.createProvider(config)
```

`createProvider` opens no connection and reads no key file, so a caller can load this provider
and show its identity before anything is asked of your machines. Reachability is proven
separately, by `validateCredentials()`, which connects to every registered host and reports the
ones that do not answer.

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
        fingerprint: "SHA256:…"          # optional — see Credentials
        identityFile: ~/.ssh/workshop    # optional, overrides the default above
```

Per host:

| field | default | what it does |
|---|---|---|
| `name` | none — **required** | what you call this box. Also its offering id and its identity in `listManaged()` |
| `host` | none — **required** | hostname or IP that both the provider and core connect to |
| `user` | `root` | the **admin** login the provider claims with. Needs root or passwordless sudo |
| `port` | `22` | the box's real sshd port. A host on another port is claimed **and bootstrapped** on it, and the `ssh` command the UI and CLI show you carries `-p` |
| `fingerprint` | none | `SHA256:…` the host must present. Supplying it changes the security posture; see below |
| `identityFile` | falls back to the provider's | path to the private key for this host |

Per provider:

| field | default | what it does |
|---|---|---|
| `hosts` | `[]` | the registry |
| `identityFile` | none | default key for hosts that name none. With an SSH agent running you can omit it entirely |
| `sshUser` | `rocky` | the account **core** connects as, which this provider creates on each host it claims. It must match core's `servers.ssh_user`, which has no per-server override |
| `managedBy` | `rockysurf` | tag value this provider owns; `validateSpec()` refuses a spec that disagrees |
| `region` | `on-prem` | the label reported on every offering, because `Offering.region` is required and hardware in a rack has no cloud region |

**There are two accounts here, and confusing them is the mistake worth avoiding.** `user` is the
existing admin login the provider uses to claim the box. `sshUser` is the account it creates for
core to use afterwards.

## Credentials

There is no credential to issue, so what stands in for one is your own SSH access. `identityFile`
is a **path**: the key stays where your SSH already keeps it, and nothing copies it into the
config file or the database. With an agent running, `SSH_AUTH_SOCK` is enough — if you can
already `ssh` to these boxes, so can Rocky Surf.

Host keys go the other way, and the `fingerprint:` field decides how much you are trusting:

- **Supplied** — strict verification from the first connection onward. Read it off the box
  yourself:

  ```bash
  ssh-keyscan -t ed25519 10.0.0.9 | ssh-keygen -lf -
  ```

- **Omitted** — trust on first use. The key seen on the first connection is recorded and pinned,
  and every connection after that is strict.

A changed key is refused either way and never retried, because a box presenting a different key
is not the box you registered. **The trusting happens inside this package, not in core**: the
provider connects before core does, so what reaches core is a pin to verify against rather than
permission to trust. Core's own verification stays strict, exactly as it is for a cloud box.

## What it needs on your machines

An `sshd` you can already reach, and an admin login with root or passwordless sudo. Claiming a
host does over SSH what cloud-init does before boot on a cloud, once:

1. create the `rocky` account if it is absent;
2. append core's public key to `~rocky/.ssh/authorized_keys` — **appended, never truncated**, so
   your own access to that file is untouched;
3. write `/etc/sudoers.d/90-rockysurf-rocky` granting it passwordless sudo, which the bootstrap
   agent needs to install anything.

Every step is idempotent, so re-claiming, a retried create and a restart recovery pass all re-run
it safely.

**Releasing a host runs nothing on it.** `terminate()` opens no connection at all: it releases
the claim and returns the host to the pool. The machine is yours and was running before Rocky
Surf existed, so a background reconciler sweep is the last thing that should be deleting accounts
on it. The consequence is that the `rocky` account, its authorized key and its sudoers file stay
behind. Remove them yourself when you want them gone:

```bash
sudo userdel -r rocky && sudo rm -f /etc/sudoers.d/90-rockysurf-rocky
```

[`docs/providers/byo.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/byo.md)
covers the rest, including what `describe()` can and cannot tell you about a box that is switched
off.

## Capabilities

| capability | value | what it means for you |
|---|---|---|
| `stop` | `false` | Rocky Surf does not own the power state of a machine it did not create. Both methods exist and both throw; the UI hides the buttons |
| `ipStableAcrossStop` | `true` | trivially: the address is the one you configured, and nothing changes it |
| `canInjectHostKeys` | `false` | with no pre-boot hook there is nowhere to put a key before first contact, so the key is learned instead. This is the posture the `fingerprint:` field above governs |
| `userDataMaxBytes` | `0` | there is no pre-boot hook, and a spec carrying user-data is refused |
| `generatesUserData` | `false` | bootstrap is SSH push only — the same path both clouds use after their first boot |

Instances report the registry's `sshPort`, so core dials the sshd this provider just claimed
instead of assuming 22. They never report a `consoleUrl`: your machine has no management console
for Rocky Surf to link to.

Evidence for each value is in
[`docs/providers/capability-matrix.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/capability-matrix.md).

## Prices

`hourly` is `null` on every offering, which the SDK defines as *unknown, never free*. Rocky Surf
has no idea what your own hardware costs you, and `0` would be presented as free.

Sizes are not configured either. `listOfferings()` reports one offering per registered host —
on BYO the host *is* the machine type — and reads cores, memory, architecture and root-disk size
off the box with `nproc`, `/proc/meminfo`, `uname -m` and `df`. A claimed host is reported with
`available: false` rather than hidden, so the size selector can say "in use". A host that cannot
be reached is omitted rather than described with invented numbers.

## Verified

**Against a real OpenSSH server, on 2026-08-12: 75 checks, no failures.**
[`scripts/e2e/byo-host.mjs`](https://github.com/amroja-biz/rockysurf/blob/main/scripts/e2e/byo-host.mjs)
boots the shipped `rockysurf` binary from a real config file and drives everything through core's
HTTP API against an `ubuntu:24.04` container running `openssh-server` on a non-22 port.
Transcript:
[`scripts/e2e/recordings/byo-container.log`](https://github.com/amroja-biz/rockysurf/blob/main/scripts/e2e/recordings/byo-container.log).

What that run establishes, which the package's own tests cannot:

- a real `useradd` created the account, and **sudo itself** parsed the sudoers drop-in —
  `sudo -n id -un` as `rocky` answers `root`;
- real sshd consulted `authorized_keys`, for both a command-line `ssh -i` login and the push
  bootstrap, and the first claim **appended** to that file rather than replacing it;
- the hardware probe agrees with `docker exec` on cores, memory and architecture;
- terminate is bookkeeping, measured: sshd's own verbose log shows the connection count unchanged
  across it, and the passwd entry, sudoers file, authorized keys, home directory and process
  table are byte-identical afterwards — including a workload started before Rocky Surf ever
  connected;
- a second claim adds no duplicate key line, no second account and no second sudoers line;
- after `ssh-keygen -A` gives the box new host keys, both a TOFU-learned pin and a configured
  fingerprint refuse it, inside a real handshake, with the accepted-login count unchanged. No
  credential reached the changed host.

**Nobody has pointed this provider at a rack.** A container on the same machine, reached over
loopback, is a real sshd with a real PAM stack — and it is not remote hardware on a real network.
The run is also manual rather than nightly: it needs Docker, so `pnpm run check` never sees it.
