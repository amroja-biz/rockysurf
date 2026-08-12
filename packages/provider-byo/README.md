# `@rockysurf/provider-byo`

Bring-your-own-host provider — the machines the operator already has. The only provider with no
cloud API behind it: the API is `sshd` on a box that was running before Rocky Surf existed.

```ts
import byo from '@rockysurf/provider-byo'

const config = byo.configSchema.parse({
  // `user` is the admin login the PROVIDER claims with; `sshUser` is the account it creates for
  // core to connect as, and must match core's `servers.ssh_user`.
  hosts: [{ name: 'workhorse', host: '10.0.0.7', user: 'ubuntu' }],
  sshUser: 'rocky',
})
const provider = byo.createProvider(config)
```

`createProvider` is synchronous and side-effect free — it opens no connection and reads no key
file — so core can load this provider and show its identity before anything is asked of the
operator's machines. Reachability is proven separately, by `validateCredentials()`.

## A registry plus a claim

With nothing to create, nothing to bill and nothing to power-cycle, what is left of a provider is
a **registry** of hosts and a **claim**. `provision()` takes a registered host by name — the
offering id *is* the host name, so it is a deterministic claim rather than "any free box" —
prepares it, and marks it held. `terminate()` gives it back.

`terminate()` **never runs anything on the host.** It is the operator's machine; releasing a
claim is bookkeeping, not demolition. The account and sudoers file the provider installed stay
behind; [docs/providers/byo.md](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/byo.md)
carries the `userdel` line that removes them.

## Three honest capabilities

- **`generatesUserData: false`.** No pre-boot hook, so `provision()` does over SSH what cloud-init
  does before boot: create the account core connects as, append core's key to `authorized_keys`
  (appended, never truncated — the operator's own access is in that file), grant passwordless
  sudo. Everything after that is the same push bootstrap both clouds run.
- **`canInjectHostKeys: false`,** which follows: with no user-data there is nowhere to put a host
  key before first contact. The key is **learned** instead — trust-on-first-use inside this
  package, pinned from then on, a later mismatch refused during the handshake. What reaches core
  is a fingerprint to verify strictly, not a trust decision to make, so core's rule that it has
  no TOFU path stays literally true.
- **`stop: false`.** Core does not own the power state of a machine it did not create. Per
  ADR-0003 (A2) both methods still exist and both throw.

`hourly` is `null` for every offering: Rocky Surf has no idea what your own hardware costs you,
and `0` would read as free.

## Development

```bash
pnpm --filter @rockysurf/provider-byo test        # unit + a real ssh2 client against a real ssh2 server
pnpm --filter @rockysurf/provider-byo typecheck
```

The integration suite drives a real `ssh2` client against a real in-process `ssh2` server with a
real host key and real public-key auth, because the handshake is where the only
security-relevant decision lives.
