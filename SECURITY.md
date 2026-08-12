# Security

Rocky Surf is a control plane you run yourself. It holds cloud credentials, mints and stores an
SSH private key for every server it creates, and — through its MCP server — lets a coding agent
spend real money on real machines. This document says what protects that, what does not, and
where to send a report when something here turns out to be wrong.

Everything below describes v0.1 and is written against the code, not against intent. Where a
control is weaker than it sounds, it is listed under [Residual risks](#residual-risks) rather
than softened in place.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on
[`amroja-biz/rockysurf`](https://github.com/amroja-biz/rockysurf): **Security → Report a
vulnerability**. That opens a private advisory visible only to you and the maintainers.

Please do not open a public issue for a security problem, and please do not disclose it publicly
before a fix ships.

Useful in a report: the version or commit, the configuration that reproduces it (redact your
`sshAllowedCidr`, tokens and key material), what an attacker gains, and whether you needed an
existing session to do it.

Expect an acknowledgement within a few days. v0.1 is pre-1.0 and maintained by a small team;
there is no paid bounty and no committed remediation SLA. Fixes ship on the default branch, and a
security advisory is published for anything that affects a released version.

## Trust boundaries

Four boundaries matter, and the rest of this document is organised around them.

1. **The control plane process** holds the master encryption key and, through it, every stored
   secret. Anyone who can read its data directory or its process environment has everything. It
   is a single-admin application; there is no privilege separation inside it.
2. **The HTTP API** requires a session for everything under `/api/v1` except login. Exactly one
   route returns decrypted secret material, and it is an audited, owner-checked download.
3. **The servers themselves** run agent-authored code. They are treated as hostile-ish: core
   authenticates to them with a pinned host key, and the metadata service on them is locked down.
4. **The MCP server** is a translation layer with no privileges of its own. It reaches core over
   the same HTTP API a browser uses, so every limit applies to it by construction.

## Credential custody

### Encryption at rest

Every stored secret is sealed with AES-256-GCM — a 256-bit master key, a fresh 96-bit nonce per
encryption, and a 128-bit authentication tag (`packages/core/src/secrets/crypto.ts`). There is no
unverified read path: wrong key, flipped ciphertext bit and flipped tag bit all surface as the
same authentication failure, and the error message never quotes the ciphertext, the key or the
associated data.

Each row's identity is bound into the GCM associated data as `keyId kind ownerId`. Copying the
`server-ssh-key` blob from server A onto server B does not yield A's key under B's name; it fails
to decrypt. Rotation is not implemented in v0.1, but every row carries a `keyId` so it can be.

Five kinds of secret are stored (`packages/core/src/secrets/store.ts`): the per-server SSH key
material, git forge tokens, remote-desktop passwords, provider credentials pasted into the UI,
and a session signing key. Each is one row per `(kind, ownerId)` pair, replaced rather than
accumulated.

### The master key

The key comes from `ROCKYSURF_SECRET_KEY` (base64, exactly 32 bytes decoded) if it is set, and
otherwise from `<dataDir>/secret.key`, which is generated on first boot at mode `0600`
(`packages/core/src/secrets/master-key.ts`). The environment wins so a deployment can keep the
key in its own secret manager, in which case nothing is written to disk at all.

Three properties worth knowing:

- **Loose permissions are fatal, not a warning.** If the key file is readable or writable by
  group or other, core refuses to start with an actionable message. A key file another user on
  the box can read makes every secret in the adjacent database readable too. The check is skipped
  on Windows, where POSIX mode bits do not describe the real ACL.
- **First boot prints a back-it-up banner.** Losing the key means every stored secret is
  unrecoverable and every server has to be recreated. Obtaining it means decrypting all of them.
  Back up the file, or set `ROCKYSURF_SECRET_KEY` and hold the key elsewhere.
- **Generation cannot clobber.** The file is written with the `wx` flag, so a race between the
  existence check and the write fails rather than overwriting a key that would render every
  existing row permanently undecryptable.

### Secrets are not returned by the API

The custody rule is that **no HTTP route may return decrypted secret material**, and it is
enforced by a test rather than by review. `packages/core/src/secrets/route-inventory.test.ts`
scans the source tree for files that register routes, fails any that also call a plaintext
accessor, and additionally fails if an exemption names a file that no longer exists or no longer
defines routes.

There is exactly one exemption, and it is an allowlist entry with a stated reason rather than a
loosened rule: `packages/core/src/ssh/routes.ts`, the private-key download. An operator has to be
able to get the key for a server they own. That route authenticates, checks ownership (returning
the same 404 for "no such server" and "not yours", so server ids cannot be probed), and appends an
`ssh_key.downloaded` audit event before writing the body. Re-downloads are allowed deliberately —
the same key remains in the box's `authorized_keys` and in core's database, so download counting
buys little, while a transfer that fails halfway would strand the operator.

`GET /api/v1/servers/:id/ssh-host-key` returns the host **public** key and is deliberately *not*
on the exemption list, because a public key is not a secret. It exists so clients can pin.

### Provider credentials

A provider credential supplied through the environment (`HCLOUD_TOKEN`, `AWS_ACCESS_KEY_ID`,
`AWS_PROFILE`, and the rest) is configuration, not data. It wins at runtime, and `putProviderToken`
**refuses** to persist one while its variable is set. Storing both would create two copies with
different lifetimes, so rotating the environment variable would leave a stale database row still
being offered to the cloud.

### Sessions and the admin password

Session tokens are 32 random bytes, and only their SHA-256 is stored
(`packages/core/src/auth/sessions.ts`). A database leak yields hashes, not live sessions. Tokens
are opaque and deliberately **not signed**: proving the server issued a value is not the question
core needs answered — "is this session still valid" is, and revocation requires a database lookup
regardless. Once there is a lookup, the row's existence is the proof and a signature adds nothing,
so there is no signing key to generate, persist, rotate or leak. Absent, expired and unknown
tokens are indistinguishable to the caller.

The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` only when `server.publicUrl` is an
`https:` URL — a `Secure` cookie over plain `http://localhost` is silently dropped by the browser,
which would break first-run login for every self-hoster. A bearer header is accepted as well, so
the CLI and the MCP server never touch cookies.

The local admin password is hashed with scrypt (N=16384, r=8, p=1, 32-byte output, 16-byte salt)
in a self-describing `scrypt$N$r$p$salt$hash` format. Verification is constant-time, and the
"no password is set" path burns equivalent scrypt work so it is not distinguishable by timing from
a wrong password.

### The box-facing callback routes

Callback-mode bootstrap exposes routes under `/internal` that a machine reaches without a session
— the only such routes in core. They authenticate with a per-server token compared in constant
time and hashed at rest, and the status token and the plan token are separate credentials with
separate lifetimes. No route that returns anything secret accepts the status token, because that
one lives on the box for the whole bootstrap and is readable from instance metadata. Push
bootstrap, the default, uses none of this.

## SSH trust

### Managed servers: pinned, with no trust-on-first-use window

For AWS and Hetzner, core mints both keypairs before the instance exists
(`packages/core/src/ssh/server-keys.ts`), injects the **host** keypair through cloud-init, and
records the host fingerprint on the server row. The first connection is therefore verified against
a key core generated itself. That matters because the first connection is the one carrying
secrets.

Core's own SSH client compares the presented host key's SHA-256 fingerprint against the stored one
and refuses on mismatch (`packages/core/src/bootstrap/push.ts`). `waitForSsh` retries transport
errors — a box that is not up yet — but a `HostKeyMismatchError` is fatal immediately and is never
retried past.

The CLI pins too. `rockysurf ssh` fetches the host public key, writes a `known_hosts` file into a
per-invocation private directory, and runs ssh with `StrictHostKeyChecking=yes`. If no pinned key
is available it says so out loud and falls back to ssh's own prompt rather than silently
downgrading to `accept-new`, which is still trust-on-first-use. `rockysurf ssh-config --write`
emits the same `UserKnownHostsFile` and `StrictHostKeyChecking yes` into the generated include.

Two related properties:

- **`rockysurf ssh` leaves nothing behind.** The private key is fetched into a `0700` temporary
  directory, used for one connection, and removed in a `finally` — on failure as well as success.
  A durable copy on disk exists only if you run `ssh-config --write`, which is what makes plain
  `ssh <name>` work, and which prints the trade before doing it.
- **A user-supplied public key is appended, never substituted.** Core's key is always first and
  always present, because push bootstrap installs software over core's own SSH connection. The
  pasted key is parsed conservatively: newlines are rejected, so a second entry or an
  `authorized_keys` option like `command=` cannot be smuggled in, and the declared key type must
  match what the key blob itself declares.

### Bring-your-own hosts: trust on first use

BYO is the one provider where core cannot pre-place a host key. There is no pre-boot hook, so
`generatesUserData` and `canInjectHostKeys` are both false and bootstrap is SSH push only. The
contract is therefore:

- If you supply a fingerprint in config (`providers.byo.hosts[].fingerprint`), it is **enforced**
  from the first connection — this is pinning, identical in strength to the managed case.
- If you do not, the key seen on the first connection is recorded, and any later change refuses
  the connection.

Trust-on-first-use is weaker than pinning and the difference is real: it trusts whatever answers
first. Supply the fingerprint when you can get it out of band. `terminate` on a BYO host releases
core's record and executes nothing on the machine — core does not own the box and does not
pretend to.

## Network defaults

### The control plane listens on loopback

`server.host` defaults to `127.0.0.1`, so a fresh install is reachable only from the machine it
runs on. Widening it to `0.0.0.0` is a one-line, deliberate change, and it should be paired with
a reverse proxy or a firewall: the UI is a single-password admin surface with no TLS of its own,
and the process behind it holds every provider credential and every managed server's private key.

The container is the one place the value is `0.0.0.0` by default, because a container's loopback
is its own and the published port would otherwise reach nothing. The boundary moves rather than
disappearing: `docker-compose.yaml` publishes on the host's loopback (`127.0.0.1:3000:3000`), and
that `ports:` line is what an operator edits to expose it.

### AWS

One shared security group per region (`rockysurf-ssh`), created on first provision and reused. Its
only ingress rule is **TCP 22 from a CIDR you specify**. Two guards make that deliberate
(`packages/provider-aws/src/config.ts`):

- `sshAllowedCidr` has **no default**, and the AWS provider refuses to load without it — the rest
  of the installation comes up, AWS is reported as not loaded with the provider's own message, and
  no instance is ever created against an unstated rule. A firewall rule is a security decision, so
  the operator states it rather than inheriting it from whatever network they happened to be on. Core never looks up the caller's own address to build the rule:
  that breaks silently when the operator's network changes and hides the decision inside runtime
  behaviour where nobody reviews it.
- `0.0.0.0/0` additionally requires `allowAllCidr: true`. Opening SSH to the internet is two
  deliberate acts, not one typo.

Instances are launched with **IMDSv2 required** (`HttpTokens: 'required'`) and a metadata hop
limit of **1**. These boxes run agent-authored code: IMDSv1 lets anything that can forge a GET
read instance metadata, and a hop limit above 1 lets a container on the box reach it.

### Remote desktop is tunnel-only

Packs that need a desktop install xrdp on the box, but **no rule for port 3389 is ever
authorized** — the shared security group opens 22 and nothing else. Reaching a desktop means
forwarding it over SSH, which inherits the key and host-key pinning above. The RDP password
travels to the box in the pushed secrets file and reaches `chpasswd` on stdin, never in argv,
where every unprivileged step running on the same box could read it out of `ps`.

### Hetzner

No cloud firewall is attached in v0.1. Hetzner servers get a public IP with SSH reachable from
anywhere, protected by key-only authentication and the pinned host key rather than by a network
rule. If you need the AWS-equivalent restriction, apply a Hetzner firewall to the project
yourself. This asymmetry is listed again under residual risks because it is easy to miss.

### Server-side fetch policy

The pack import endpoint fetches a URL an admin types into a control plane holding cloud
credentials — the classic SSRF shape. `packages/core/src/packs/safe-fetch.ts` is the guard:

- Every hostname is resolved first, and **every** resolved address must be publicly routable. If
  any address a name returns is blocked, the whole name is refused — the attacker does not get to
  pick which record the socket ends up using.
- Blocked ranges cover loopback, RFC1918, CGNAT (including Alibaba's metadata address),
  link-local (including `169.254.169.254`), IETF-reserved, benchmarking, multicast and reserved
  space, plus the IPv6 equivalents and the v4-embedded forms — v4-mapped, NAT64, 6to4 and
  v4-compatible all defer to the IPv4 verdict on the embedded bits.
- Only `http:` and `https:` are accepted.
- Redirects are not followed blindly. Each hop is re-screened under the same rule, capped at five.
- The body is capped at 2 MB and the request at 15 seconds, so a "pack file" cannot be a tarpit.

Its residual risk is documented in the module and repeated below.

## The MCP server: threat model

The MCP server (`rockysurf mcp`) lets a coding agent create, inspect, stop and destroy servers
that cost real money. It is the highest-blast-radius feature in v0.1. The honest claim is
"budget-capped", **not** "sandboxed".

### Setting it up, and where the security decision actually is

```bash
rockysurf token          # mints a token, prints it once
```

Then, in your MCP client — for Claude Code, `.mcp.json` in your project:

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

**Nothing in that JSON grants a permission.** Scopes come from your own config file:

```yaml
mcp:
  scopes: [read, stop]                        # the default
  # scopes: [read, stop, create]              # let an agent make servers
  # scopes: [read, stop, create, terminate]   # ...and destroy them
```

The token is the only thing the client is trusted with, and it is not a capability — what the
token may *do* is decided by the file above. [The scope split](#the-scope-split) below is why.

### Blast radius

**In the worst case — a fully compromised or fully injected MCP client, with every scope granted —
an attacker can destroy every server in this installation and spend up to the configured monthly
cap creating new ones, at no more than `createRatePerHour` per hour. It cannot read any stored
secret, cannot obtain an SSH private key, cannot reach a cloud account beyond what the configured
provider credential allows, and cannot exceed those limits by any MCP-shaped route.** With the
default scopes (`read`, `stop`), it can list servers and stop them — reversible, disk preserved —
and nothing else.

That is the whole statement. Everything following is why each half is true.

### The design that makes limits unskippable

The MCP server does **not** import core's service layer. It speaks HTTP to a running control plane
exactly as a browser does (`packages/rockysurf/src/mcp/`). That is the cheapest possible guarantee
that it cannot bypass anything: it has no other way in, so limits, ownership checks and error
shapes are core's by construction, there is no second code path to keep in sync, and an MCP
process with no token is inert.

Authentication is a session token minted by `rockysurf token`, supplied as `ROCKYSURF_TOKEN`.
Sessions are already opaque, hashed at rest, revocable and tested; inventing a second credential
system for this would be a second thing to get wrong.

### Limits, enforced server-side for every caller

All three are enforced in `packages/core/src/jobs/limits.ts`, on the create path, **before** a row
is written — so a rejected create has provisioned nothing:

| Limit | Config | Default | Refusal code |
|---|---|---|---|
| Concurrent servers | `limits.maxServers` | 5 | `max_servers` |
| Creates per hour, per user | `limits.createRatePerHour` | 4 | `create_rate` |
| Estimated month-to-date spend | `limits.spendCap` (`{amount, currency}`) | none | `spend_cap` |

The rate limit is the anti-loop: an agent that terminates and recreates in a cycle is stopped by
`createRatePerHour` no matter which scopes it holds. The cap is compared per currency — a Hetzner
project billed in EUR and an AWS account billed in USD are not summed, because that number would
be fiction.

Refusals reach the agent with the machine-readable reason intact rather than flattened to "request
failed", so an agent can report "the cap is reached" and stop, instead of retrying blindly.

### The scope split

Scopes come from the **config file** (`mcp.scopes`), not from the MCP client's launch command. A
permission a client's launch JSON can set is a permission an agent can eventually talk someone
into setting; config is where an operator reviews it.

| Tool | Scope | Reversible? |
|---|---|---|
| `list_servers`, `get_server`, `get_ssh_command` | `read` | reads only |
| `stop_server` | `stop` | yes — disk preserved, start it again |
| `create_server` | `create` | spends money until stopped or terminated |
| `terminate_server` | `terminate` | **no** — the disk goes with it |

The default is `[read, stop]`. `create` and `terminate` are separate, opt-in scopes on purpose:
"a budget-capped credit card for compute" must never quietly also mean "and a flamethrower".
Making a box costs money; destroying one costs work, and that is not recoverable.

A tool the installation has not granted is neither advertised nor callable, and the scope is
**re-checked at call time** rather than relying on the tool's absence from the list — a client can
call a name it was never offered, and "not listed" is not a security control.

### What an agent never receives

No tool result contains key material or a credential of any kind. `get_ssh_command` returns a
command string and a pointer to where a human can download the key. A private key in a tool result
is a private key in the agent's context, its transcript, and every log that transcript touches,
permanently.

Every result also carries month-to-date spend, the cap and the fraction used, fetched per call
rather than cached — an agent may run for hours, and a stale cap reading is exactly the number it
must not reason from. When cost data cannot be read the result degrades to a note rather than
failing the operation.

### If something goes wrong

Sign out from the web UI. That drops every session, including the MCP token. Then start core if it
is not running and look at Servers and Costs; the reconciler's zero-orphan sweep is what tells you
whether anything survived that the control plane no longer knows about.

## Residual risks

Stated plainly, because a control list without this section is marketing.

- **Scopes are not a sandbox against an agent with shell access.** The token lives in the MCP
  process's environment. An agent that can run shell commands on the same machine can read it and
  call the HTTP API directly, bypassing scopes entirely. What still stops it there is core's
  limits, which do not care who is calling. Treat scopes as a guardrail against mistakes and
  prompt injection, not as a boundary against a hostile agent.
- **The MCP token is a full admin session, valid for a year.** v0.1 reuses the session mechanism
  rather than inventing a second credential system, so the token can do anything the web UI can,
  and revoking it means signing out everywhere. Per-token scopes are the obvious next step.
- **Session tokens are opaque and unsigned.** That is the design ruling, and it is sound given
  that revocation already requires a lookup — but it means a token's validity is entirely a
  property of the database. Anyone who can write the `sessions` table can mint a session.
- **The spend cap is an estimate, not a bill.** It is computed from bundled price data stamped
  with when it was read, and a provider that quotes no price for an offering contributes real
  spend the cap cannot see. The count of such servers rides along in every MCP result and in the
  costs API rather than being hidden.
- **Reaching the cap blocks new servers; it does not stop running ones.** Auto-stopping on the
  strength of a possibly-stale estimate would kill an agent mid-task on a box someone depends on.
  A wrong estimate that blocks a create costs a click; a wrong estimate that stops running work
  costs the work.
- **Prompt injection reaches the tools.** Anything an agent reads — a README in a cloned repo, a
  web page, an issue comment — can try to talk it into calling `terminate_server`. The defence is
  not granting `terminate` unless you need it, and the rate limit if you do.
- **`safe-fetch` does not close DNS rebinding.** The vetted lookup happens before the socket
  connect, so a DNS server that rebinds between the two resolutions could still steer the
  connection inward. Closing it fully needs a connect-time lookup override, a dependency this
  admin-only, session-gated endpoint does not currently justify. Revisit if the endpoint ever
  loosens.
- **The control plane has no TLS of its own.** It binds loopback by default (`server.host`), so
  the traffic does not leave the machine. Setting `server.host` to `0.0.0.0` puts the login form
  and the `/internal` callback routes on your network in cleartext — do that only behind a
  reverse proxy that terminates TLS, or a firewall.
- **Hetzner servers have no network firewall.** See [Hetzner](#hetzner) above.
- **Key rotation is not implemented.** Rows carry a `keyId` so it can be added, but there is no
  re-key path today. Rotating the master key means recreating servers.
- **The control plane is single-admin, with no privilege separation.** Anyone who can read its
  data directory or its process environment has the master key and therefore every secret.
