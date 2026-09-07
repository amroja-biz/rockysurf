/**
 * `testbox` — a Provider-shaped stand-in that exists ONLY for `scripts/e2e/bootstrap-host.mjs`.
 *
 * WHAT IT IS FOR. The subject of that run is core's PUSH BOOTSTRAP against a real OpenSSH
 * server: the SSH-push path, the `generatesUserData: false` semantics core applies to a
 * provider that has no pre-boot hook, and the NOHUP launcher fallback. Core will not push to a
 * machine it has no server row for, and it will not make a server row without a provider — so
 * something has to answer `listOfferings()` and `provision()`. This is that something, and it
 * is deliberately not a product: it is not in `packages/`, not in `compose.ts`, not published,
 * and nothing outside `scripts/e2e/` imports it. Core loads it through the personal-provider
 * path (ADR-0026) by absolute path, which is the shipped mechanism for a provider that lives
 * in a checkout rather than in npm.
 *
 * WHAT IT STANDS IN FOR. Cloud-init. On a real cloud, core renders `#cloud-config` and the
 * image creates the `rocky` account, installs core's minted public key and grants passwordless
 * sudo before the box finishes booting. A provider with `generatesUserData: false` gets no such
 * hook, so the account preparation happens in `provision()` instead — which is exactly why that
 * capability exists and why this harness declares it. The preparation runs through `docker exec`
 * rather than over SSH: the connection under test is CORE'S, and a second SSH implementation in
 * the harness would only add a way for the harness to be the thing that broke.
 *
 * WHAT IT DOES NOT FAKE. The box. Every fact it reports — cpu, memory, architecture, the host
 * key fingerprint core pins — is read off a real container running a real sshd, so core is
 * pinning a key some other process really presents and dialling a port something is really
 * listening on.
 *
 * NO DEPENDENCIES, plain JavaScript, never built: the loader has to cope with a package that
 * resolves its own copy of nothing, and `scripts/` has no build step.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

/** A command on the box, as root, through docker rather than ssh. See the header. */
function box(container, command) {
  return execFileSync('docker', ['exec', container, '/bin/sh', '-c', command], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim()
}

/** Shell single-quoting, so an authorized-keys line reaches the box byte for byte. */
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`

/**
 * Read the hardware off the container.
 *
 * The same four numbers a machine can be asked for over any transport, and the reason the
 * offering below is not a table of literals: an offering whose cpu count disagrees with `nproc`
 * on the box would let the harness pass while describing a machine that does not exist.
 */
function readFacts(container) {
  const out = box(
    container,
    "nproc; awk '/^MemTotal:/{print $2}' /proc/meminfo; uname -m; df -Pk / | awk 'NR==2{print $2}'",
  ).split('\n')
  const [cpu, memKb, machine, diskKb] = out.map((line) => line.trim())
  if (machine !== 'x86_64' && machine !== 'aarch64') {
    throw new Error(`testbox: unrecognised machine '${machine}' — refusing to guess an architecture`)
  }
  return {
    cpu: Number(cpu),
    memoryGb: Number(memKb) / 1024 / 1024,
    diskGb: Math.round(Number(diskKb) / 1024 / 1024),
    arch: machine === 'x86_64' ? 'amd64' : 'arm64',
  }
}

/**
 * The box's ed25519 host key, as the fingerprint core pins and as the `known_hosts` line.
 *
 * `ssh-keygen -lf` computes the digest the same way core's `fingerprintFromBlob` does, which is
 * what makes the two comparable at all. The container is built with ed25519 as its ONLY host
 * key (see the harness's Dockerfile), so there is exactly one answer here and no negotiation
 * can make core pin a key this function did not report.
 */
function readHostKey(container) {
  const fingerprint = box(container, "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'")
  const publicKey = box(container, 'cat /etc/ssh/ssh_host_ed25519_key.pub')
  return { fingerprint, publicKey: publicKey.split(/\s+/).slice(0, 2).join(' ') }
}

/**
 * What cloud-init would have done before boot, done after it instead.
 *
 * Idempotent line by line, because `provision()` is: `useradd` only when the account is absent,
 * a whole-line literal match before appending a key so one key can never be read as a prefix of
 * another, and the sudoers rule written rather than appended to.
 */
function prepareAccount(container, user, authorizedKeys) {
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error(`testbox: unsafe account name '${user}'`)
  const addKeys = authorizedKeys
    .map((key) => `grep -qxF ${quote(key.trim())} "$home/.ssh/authorized_keys" || printf '%s\\n' ${quote(key.trim())} >> "$home/.ssh/authorized_keys"`)
    .join('\n')
  box(
    container,
    `set -eu
user=${quote(user)}
id -u "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
home=$(getent passwd "$user" | cut -d: -f6)
mkdir -p "$home/.ssh"
chmod 700 "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
chown -R "$user" "$home/.ssh"
${addKeys}
mkdir -p /etc/sudoers.d
printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "$user" > "/etc/sudoers.d/90-rockysurf-$user"
chmod 440 "/etc/sudoers.d/90-rockysurf-$user"
echo prepared`,
  )
}

const unsupported = (what) =>
  Object.assign(new Error(`testbox cannot ${what}: it is a bootstrap harness, not a cloud`), {
    code: 'invalid_spec',
  })

/** Claims this process has handed out, by the opaque handle core stores. */
const claims = new Map()

const factory = {
  id: 'testbox',
  displayName: 'Bootstrap harness box',
  configSchema: {
    parse(input) {
      if (input === null || typeof input !== 'object') throw new Error('testbox: config must be an object')
      const config = { ...input }
      for (const field of ['container', 'host', 'sshUser', 'specRecordPath']) {
        if (typeof config[field] !== 'string' || config[field] === '') {
          throw new Error(`testbox: ${field} is required`)
        }
      }
      if (!Number.isInteger(config.port)) throw new Error('testbox: port is required')
      return config
    },
  },
  createProvider(config) {
    let facts
    return {
      id: 'testbox',
      displayName: 'Bootstrap harness box',
      /**
       * The three flags that make this harness the thing it replaced.
       *
       * `generatesUserData: false` is the one under test: core renders no `#cloud-config` for
       * this provider, so `ProvisionSpec.userData` arrives empty and everything the box needs
       * arrives over SSH instead. `canInjectHostKeys: false` follows — with no pre-boot hook
       * there is nowhere to put a key core minted, so the box keeps its own and this provider
       * reports the fingerprint for core to verify strictly. `stop: false` because nothing here
       * owns a power state; both methods still exist and both throw (ADR-0003, A2).
       */
      capabilities: {
        stop: false,
        ipStableAcrossStop: true,
        canInjectHostKeys: false,
        userDataMaxBytes: 0,
        generatesUserData: false,
      },
      async validateCredentials() {
        box(config.container, 'true')
      },
      async validateSpec() {},
      async listOfferings() {
        facts ??= readFacts(config.container)
        return [
          {
            id: 'the-box',
            cpu: facts.cpu,
            memoryGb: facts.memoryGb,
            diskGb: facts.diskGb,
            arch: facts.arch,
            // Not free — unknown. A container costs the runner something; this provider has no
            // catalogue to price it from and says so rather than implying zero.
            hourly: null,
            available: claims.size === 0,
            region: 'container',
          },
        ]
      },
      async provision(spec) {
        // THE EVIDENCE FOR THE `generatesUserData: false` ASSERTION. The harness reads this
        // file back and checks what core actually sent, rather than checking the flag core
        // reports about itself.
        writeFileSync(
          config.specRecordPath,
          `${JSON.stringify({ serverId: spec.serverId, userData: spec.userData, sshPublicKeys: spec.sshPublicKeys, offeringId: spec.offeringId, arch: spec.arch }, null, 2)}\n`,
        )
        prepareAccount(config.container, config.sshUser, spec.sshPublicKeys)
        const hostKey = readHostKey(config.container)
        const handle = { box: config.container, serverId: spec.serverId }
        claims.set(spec.serverId, handle)
        return {
          data: handle,
          initial: {
            state: 'running',
            publicIp: config.host,
            sshPort: config.port,
            hostKeyFingerprint: hostKey.fingerprint,
            hostPublicKey: hostKey.publicKey,
          },
        }
      },
      async describe(data) {
        const held = claims.get(String(data.serverId))
        if (!held) return { state: 'terminated' }
        return { state: 'running', publicIp: config.host, sshPort: config.port }
      },
      async terminate(data) {
        // Bookkeeping only, and that is asserted: the harness counts the connections sshd saw.
        claims.delete(String(data.serverId))
      },
      async listManaged() {
        return [...claims.values()].map((held) => ({
          kind: 'host',
          providerNativeId: held.box,
          ownership: 'server-owned',
          serverId: held.serverId,
        }))
      },
      async stop() {
        throw unsupported('stop a machine')
      },
      async start() {
        throw unsupported('start a machine')
      },
    }
  },
}

export default factory
