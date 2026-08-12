import { ProviderError } from '@rockysurf/provider-sdk'
import { shellQuote } from './ssh.js'

/**
 * What a BYO host has done to it, and what is read off it.
 *
 * THE SHAPE OF THIS FILE IS THE WHOLE BYO IDEA. On a cloud provider, cloud-init creates the
 * `rocky` account, writes `authorized_keys` and grants passwordless sudo before the box has ever
 * been reachable. BYO has no pre-boot hook — `capabilities.generatesUserData` is `false`, so core
 * renders nothing — and the answer is not a second mechanism but the SAME setup performed over
 * SSH, once, at claim time. Everything after that point is byte-for-byte the push bootstrap both
 * clouds already use, which is what `docs/providers/capability-matrix.md` means when it says BYO
 * is a subset rather than a separate path.
 *
 * The scripts are POSIX `sh`, not bash: an operator's existing box is not guaranteed to be the
 * Ubuntu image the cloud providers pin. They are also IDEMPOTENT, for the same reason the pack
 * author contract demands it of install steps — a re-claim, a retried provision and a restart
 * recovery pass all re-run this, and a script that only works once turns those into failures.
 */

/** Accounts this provider will create. Constrained so the sudoers filename cannot be smuggled. */
const SAFE_ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/

export function assertSafeAccount(user: string): void {
  if (!SAFE_ACCOUNT.test(user)) {
    throw new ProviderError(
      'invalid_spec',
      `sshUser '${user}' is not a portable account name: expected [a-z_][a-z0-9_-]* of 32 characters or fewer`,
    )
  }
}

/**
 * Make the box look like a freshly provisioned one: the account exists, core's keys authorize it,
 * and it can sudo without a password.
 *
 * Passwordless sudo is not a convenience here. The bootstrap agent runs installers as root and
 * asks the launcher for liveness through `sudo systemctl is-active`, so a box without it fails
 * bootstrap several minutes in with an error that looks like a pack bug.
 *
 * Keys are APPENDED, never rewritten. The file may already hold the operator's own access, and a
 * provider that truncated it would lock its owner out of their own machine on the way to
 * installing a dev environment.
 */
export function buildPrepareScript(sshUser: string, authorizedKeys: readonly string[]): string {
  assertSafeAccount(sshUser)
  const addKeys = authorizedKeys.map((key) => `add_key ${shellQuote(key.trim())}`).join('\n')

  return `set -eu
user=${shellQuote(sshUser)}

if ! id -u "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$user"
fi

home=$(getent passwd "$user" | cut -d: -f6)
if [ -z "$home" ]; then
  echo "account $user has no home directory" >&2
  exit 1
fi

mkdir -p "$home/.ssh"
chmod 700 "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
chown -R "$user" "$home/.ssh"

add_key() {
  # -x -F: a whole-line literal match, so one key can never be read as a prefix of another.
  grep -qxF "$1" "$home/.ssh/authorized_keys" || printf '%s\\n' "$1" >> "$home/.ssh/authorized_keys"
}
${addKeys}

mkdir -p /etc/sudoers.d
printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$user" > "/etc/sudoers.d/90-rockysurf-$user"
chmod 440 "/etc/sudoers.d/90-rockysurf-$user"

echo prepared
`
}

/**
 * Read the hardware, because BYO has no catalogue to look it up in.
 *
 * `listOfferings()` on a cloud provider asks an API what it sells. There is no such API here, and
 * the alternative — asking the operator to declare cores and memory in the config file — is a
 * number nobody keeps up to date. The box knows; ask the box.
 */
export const PROBE_SCRIPT = `set -eu
nproc
awk '/^MemTotal:/{print $2}' /proc/meminfo
uname -m
df -Pk / | awk 'NR==2{print $2}'
`

export interface HostFacts {
  cpu: number
  memoryGb: number
  diskGb?: number
  arch: 'amd64' | 'arm64'
}

/**
 * Parse the probe, or say why it cannot be parsed.
 *
 * Throws rather than guessing. An unrecognised `uname -m` is the case worth being strict about:
 * defaulting it to amd64 would hand core an architecture the packs then install the wrong
 * binaries for, and the failure would surface an hour later as a broken install.
 */
export function parseHostFacts(stdout: string): HostFacts {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const [cpuText, memText, machine, diskText] = lines

  const cpu = Number(cpuText)
  const memKb = Number(memText)
  if (!Number.isInteger(cpu) || cpu <= 0) throw new Error(`could not read cpu count from probe output: ${cpuText ?? ''}`)
  if (!Number.isFinite(memKb) || memKb <= 0) throw new Error(`could not read memory from probe output: ${memText ?? ''}`)

  const arch = machine === 'x86_64' || machine === 'amd64' ? 'amd64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : undefined
  if (!arch) throw new Error(`unsupported machine architecture '${machine ?? ''}': v0.1 supports x86_64 and aarch64`)

  const diskKb = Number(diskText)
  const facts: HostFacts = {
    cpu,
    // One decimal: a 16GiB box reports 16.0, not 15.62, and a caller comparing sizes is not
    // shown noise from the kernel's reserved pages.
    memoryGb: Math.round((memKb / 1024 / 1024) * 10) / 10,
    arch,
  }
  if (Number.isFinite(diskKb) && diskKb > 0) facts.diskGb = Math.round(diskKb / 1024 / 1024)
  return facts
}
