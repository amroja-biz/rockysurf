import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The `~/.ssh/config.d/rockysurf` include, and the one line in `~/.ssh/config` that activates
 * it (rockysurf-ftl9.2).
 *
 * THE KEY-HANDLING DECISION, recorded because the handoff notes asked for it in writing.
 *
 * The bead offers two options — cache each `.pem` on disk, or avoid a second copy with a
 * ProxyCommand — and the honest finding is that they are not alternatives for the same
 * requirement. `ssh <name>` typed by hand reads `~/.ssh/config` and nothing else: it needs an
 * `IdentityFile` on disk, because ProxyCommand governs the CONNECTION, not the identity, and
 * an agent-loaded key only helps if something already loaded it. So the acceptance criterion
 * "plain `ssh <name>` connects" REQUIRES a durable key file. There is no clever way around it.
 *
 * The resolution is therefore not one policy but two, split by who asked for what:
 *
 *  - **`rockysurf ssh <name>` writes NOTHING durable.** It fetches the key, uses it for that
 *    one connection from a private per-invocation directory, and removes it when ssh exits.
 *    The everyday path leaves no second copy of anything.
 *  - **`rockysurf ssh-config --write` does create durable keys**, because that is the only way
 *    to honour the requirement it exists to serve. It is opt-in behind a flag, it says exactly
 *    what it wrote, and the generated file carries the same warning in a comment.
 *
 * A user who never runs the flag never has a second copy of a private key on disk. A user who
 * does has chosen it, in one explicit command, with the trade printed in front of them.
 */

export const INCLUDE_LINE = 'Include ~/.ssh/config.d/rockysurf'

export interface SshConfigServer {
  id: string
  name: string
  publicIp: string
  sshUser: string
  /** sshd's port when it is not 22 — a machine core adopted rather than created (ADR-0003, E13). */
  sshPort?: number
  /**
   * The host key core can prove this box presents — minted for a machine core provisioned,
   * observed by the provider for one core adopted (rockysurf-ftl9.13/.14). Either way it is a
   * real `known_hosts` entry, and the generated block demands strict verification against it.
   */
  hostPublicKey?: string
  /**
   * The pin core holds when it has no key to go with it: a row written before the provider
   * reported keys, or one where nothing has been observed yet. Never enough for `known_hosts`
   * — it goes in a comment, beside a block that still refuses rather than prompts.
   */
  reportedFingerprint?: string
}

export interface SshConfigPaths {
  /** `~/.ssh/config` — the user's own file. Only ever touched behind `--write`. */
  userConfig: string
  /** `~/.ssh/config.d/rockysurf` — ours, rewritten wholesale. */
  include: string
  /** Where durable keys live when `--write` is used. */
  keyDir: string
  /** `known_hosts` for pinned host keys, ours alone. */
  knownHosts: string
}

export function defaultPaths(home: string = homedir()): SshConfigPaths {
  return {
    userConfig: join(home, '.ssh', 'config'),
    include: join(home, '.ssh', 'config.d', 'rockysurf'),
    keyDir: join(home, '.rockysurf', 'keys'),
    knownHosts: join(home, '.rockysurf', 'known_hosts'),
  }
}

/**
 * Render the include file.
 *
 * BYTE-IDENTICAL ON REGENERATE, which is an explicit acceptance criterion and the reason there
 * is no timestamp in the header: a generated file that changes every run is a file nobody can
 * diff, and a diff is how someone notices a host they did not expect.
 */
export function renderInclude(servers: readonly SshConfigServer[], paths: SshConfigPaths): string {
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  const header = [
    '# Managed by Rocky Surf — regenerate with `rockysurf ssh-config --write`.',
    '# Edits here are lost on the next run. Deliberately carries no timestamp, so an',
    '# unchanged fleet regenerates byte-identically and a real change shows up in a diff.',
    '#',
    '# The IdentityFile paths below are PRIVATE KEYS on disk, outside the encrypted store.',
    '# They exist because plain `ssh <name>` cannot read a key from anywhere else. If you would',
    '# rather not keep them, delete this file and the key directory and use `rockysurf ssh <name>`,',
    '# which fetches a key per connection and removes it afterwards.',
    '',
  ]

  const blocks = sorted.map((server) =>
    [
      `Host ${server.name}`,
      `  HostName ${server.publicIp}`,
      ...(server.sshPort ? [`  Port ${server.sshPort}`] : []),
      `  User ${server.sshUser}`,
      `  IdentityFile ${join(paths.keyDir, `${server.id}.pem`)}`,
      `  IdentitiesOnly yes`,
      `  UserKnownHostsFile ${paths.knownHosts}`,
      // UNCONDITIONAL, for every host and every provider (ADR-0002). Core knows the key this
      // box presents — minted before it existed on a machine core provisioned, observed by the
      // provider during the handshake it pinned on a machine core adopted (ADR-0003 E14) — so
      // there is no trust-on-first-use window to accept anywhere, and no class of host that
      // settles for a prompt.
      //
      // A host with no key available keeps this line and gets a comment, not a downgrade: ssh
      // then REFUSES with "No ED25519 host key is known", which is a loud, correct failure. The
      // fix is to get the key, and the CLI says which hosts need one.
      ...(server.hostPublicKey
        ? []
        : [
            `  # No pinned host key is available for this host yet, so ssh will refuse to connect.`,
            server.reportedFingerprint
              ? `  # Core holds only this fingerprint for it: ${server.reportedFingerprint}`
              : `  # Core has observed no host key for it at all.`,
          ]),
      `  StrictHostKeyChecking yes`,
      '',
    ].join('\n'),
  )

  return [...header, ...blocks].join('\n')
}

/**
 * A `known_hosts` line pinning one server's host key.
 *
 * The bracket form is not cosmetic: ssh looks up a host on a non-default port as
 * `[address]:port`, and a bare-address entry simply does not match — which is a prompt for a
 * host that was supposed to be pinned.
 */
export function renderKnownHostsLine(server: SshConfigServer, hostPublicKey: string): string {
  const host = server.sshPort ? `[${server.publicIp}]:${server.sshPort}` : server.publicIp
  return `${host} ${hostPublicKey.trim()}\n`
}

/**
 * Write a file that must not be group- or world-readable.
 *
 * THE UMASK TRAP, which the handoff notes flagged and which is worth stating: the `mode`
 * argument to `writeFileSync` is masked by the process umask, so a `0o600` request under a
 * `0o022` umask lands as `0o600` but under a looser umask can land readable. `chmodSync`
 * afterwards is not belt-and-braces, it is the part that actually holds.
 */
export function writePrivate(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export interface IncludeEditResult {
  /** True when the line was already there — the common case on every run after the first. */
  alreadyPresent: boolean
  /** What the file would become. Returned even in dry-run so a caller can show it. */
  contents: string
}

/**
 * Add the `Include` line to `~/.ssh/config`, or report that it is already there.
 *
 * THE ONE FILE HERE THE USER OWNS AND DID NOT ASK US TO TOUCH. It is only ever written behind
 * an explicit `--write`, the line goes at the TOP because ssh takes the first matching value
 * for most keywords — an `Include` placed after a user's own `Host *` block would be silently
 * overridden — and an existing line is left exactly where the user put it.
 */
export function planIncludeEdit(existing: string): IncludeEditResult {
  const lines = existing.split('\n')
  const present = lines.some((line) => line.trim() === INCLUDE_LINE)
  if (present) return { alreadyPresent: true, contents: existing }

  const banner = [
    '# Added by Rocky Surf (`rockysurf ssh-config --write`). Safe to move or delete.',
    INCLUDE_LINE,
    '',
  ].join('\n')

  return { alreadyPresent: false, contents: `${banner}${existing}` }
}

/** Read a file, treating "not there" as empty rather than as an error. */
export function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
