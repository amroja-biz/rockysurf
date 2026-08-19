#!/usr/bin/env node
/**
 * Milestone exit check for the BYO provider: the PRODUCTION stack against a REAL sshd
 * (rockysurf-ftl9.10).
 *
 *   node scripts/e2e/byo-host.mjs [--keep] [--port <n>]
 *
 * `--keep` leaves the container and its `/var/log/sshd.log` behind for inspection, which is what
 * you want the first time something in here fails. `--port` publishes the container's sshd
 * somewhere specific; the default is a random non-22 port, for the reason below.
 *
 * WHY THIS EXISTS. `provider-byo` shipped with six integration tests that drive a real ssh2
 * client against a real in-process ssh2 server, which is enough to prove the handshake — the
 * fingerprint that is recorded, the mismatch that is refused, the key that later authorizes a
 * login. It cannot prove anything on the other side of the handshake, because there is no other
 * side: `useradd` never ran, `/etc/sudoers.d` was never parsed by sudo, no sshd ever consulted
 * an `authorized_keys` file, and no SFTP subsystem ever accepted the agent script. Every one of
 * those is a line the provider writes and a real machine interprets.
 *
 * So this run puts a genuine OpenSSH server on the other end. The vehicle is a container rather
 * than borrowed hardware for the same reason the cloud runs use the cheapest instance type:
 * repeatability and cost. `ubuntu:24.04` + `openssh-server` is not a simulation of the thing —
 * it IS sshd, useradd, sudo and the pam stack, with a kernel underneath.
 *
 * WHAT IT DRIVES. The shipped article, exactly like `lifecycle.mjs`: the `rockysurf` binary
 * booted from a real config file, then everything through core's own HTTP API. The provider is
 * reached only through that stack — except in the last two phases, which build the provider
 * directly because their subject is the provider's own refusal behaviour and core is not
 * involved in it.
 *
 * ISOLATION. Its own image tag, its own container name, its own data directory, all stamped
 * with the run id, and a `finally` that removes every one of them on any exit path. It never
 * touches a container it did not create.
 *
 * THE PORT IS PART OF THE SUBJECT, not an incidental. The container's sshd is published on a
 * NON-22 port by default (override with `--port`), which is what a hardened box in somebody's
 * rack actually looks like — and which this run's first outing could not do, because core's push
 * bootstrap dialled 22 unconditionally: `providers.byo.hosts[].port` reached the provider, the
 * provider claimed the box on it, and core then dialled a port nothing was listening on until
 * the provisioning timeout. That gap is `rockysurf-ftl9.12`, fixed by ADR-0003 amendment E13,
 * and every claim-then-bootstrap check below now runs across it end to end.
 */
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const BIN = join(REPO, 'packages/rockysurf/dist/bin.js')

/** One stamp on everything this run creates, so a leftover is always attributable. */
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const IMAGE = `rockysurf-byo-e2e:${STAMP}`
const CONTAINER = `rockysurf-byo-e2e-${STAMP}`
const HOST_NAME = 'e2e-box'
const PORT = 3400 + Math.floor(Math.random() * 300)
const ADMIN_PASSWORD = 'e2e-admin-password'
/**
 * Where the container's sshd is published. NOT 22 by default: a BYO fleet is other people's
 * machines, and sshd somewhere else is an ordinary hardening choice on one. `--port <n>` pins it
 * (`--port 22` reproduces the original run, if the host has no sshd of its own).
 */
const SSH_PORT = (() => {
  const flag = process.argv.indexOf('--port')
  const given = flag >= 0 ? Number(process.argv[flag + 1]) : NaN
  if (flag >= 0 && (!Number.isInteger(given) || given < 1 || given > 65535)) {
    throw new Error(`--port needs a TCP port, got ${String(process.argv[flag + 1])}`)
  }
  return flag >= 0 ? given : 2200 + Math.floor(Math.random() * 300)
})()
const KEEP = process.argv.includes('--keep')

/**
 * What the branding step is supposed to put on somebody's screen, as literals.
 *
 * Deliberately NOT imported from `@rockysurf/core`: the subject here is whether the bytes
 * SURVIVED the trip through a JSON plan, a bash heredoc and PAM, and an assertion that reads
 * the same constant the renderer read cannot fail when they do not. The first of these is the
 * backslash-heavy art line — the one an unquoted heredoc silently strips to `____`.
 */
const LOGO_ART_LINE = '/_/ |_|\\____/\\___/_/|_|\\__, /   /____/\\__,_/_/  /_/'
const LOGO_LAST_LINE = '                      /____/'
const BRANDING_URL = 'https://github.com/amroja-biz/rockysurf'

const READY_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 3_000

const t0 = Date.now()
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...args)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (ok, what, detail = '') => {
  if (ok) log(`  PASS  ${what}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
  }
}
/** An observation that is not a verdict. Used for gaps this run FOUND but does not own. */
const note = (what, detail = '') => log(`  NOTE  ${what}${detail ? ` — ${detail}` : ''}`)

const workDir = mkdtempSync(join(tmpdir(), `rockysurf-byo-e2e-`))
const dataDir = join(workDir, 'data')
const configPath = join(workDir, 'rockysurf.config.yaml')
const adminKeyPath = join(workDir, 'admin_ed25519')
/**
 * A throwaway trust store for the readiness probe ONLY, and deliberately NOT the `known_hosts`
 * phase 5 uses (rockysurf-qogr).
 *
 * Phase 5's file is evidence: the fingerprint OpenSSH records there, having learned it for
 * itself, is checked against the one the provider reported and the one core pinned — three
 * independent parties agreeing on one key. A probe that wrote into that file would hand OpenSSH
 * the answer before it was asked, and the check would then be comparing the provider's value
 * with a copy of the provider's value.
 */
const probeKnownHosts = join(workDir, 'probe_known_hosts')

/* ------------------------------------------------------------------ shelling out */

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15 * 60_000, ...options })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (${result.status ?? result.signal})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  }
  return result
}

const docker = (args, options = {}) => run('docker', args, options)

/** A command on the box, as root. The whole assertion vocabulary for phases 4 and 6. */
function box(command, options = {}) {
  const result = docker(['exec', CONTAINER, '/bin/sh', '-c', command], { ...options })
  return (result.stdout ?? '').trim()
}

/** A command on the box as an unprivileged account — the only way to test sudo honestly. */
function boxAs(user, command, options = {}) {
  const result = docker(['exec', '-u', user, CONTAINER, '/bin/sh', '-c', command], { ...options })
  return { out: (result.stdout ?? '').trim(), code: result.status, err: (result.stderr ?? '').trim() }
}

/* ------------------------------------------------------------------ the box */

/**
 * A real Ubuntu with a real OpenSSH server, and NOTHING Rocky Surf needs pre-installed.
 *
 * Deliberately spartan: no `rocky` account, no sudoers drop-in, no `jq` — those are the things
 * the provider and the bootstrap agent are supposed to put there, and an image that already had
 * them would hide exactly the failure this run exists to catch. `procps` is here because a real
 * host has it (push mode's `pgrep` liveness check needs it) and the slim image does not.
 */
const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update -qq \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server sudo procps ca-certificates \\
 && mkdir -p /run/sshd
RUN ssh-keygen -A
CMD ["sleep", "infinity"]
`

/** `SHA256:…` for every host key the box holds, keyed by type. Ground truth for the pin. */
function containerHostKeyFingerprints() {
  const raw = box(
    'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f" | awk \'{print $2, $4}\'; done',
  )
  const map = new Map()
  for (const line of raw.split('\n').filter(Boolean)) {
    const [fingerprint, type] = line.trim().split(/\s+/)
    map.set(type.replace(/[()]/g, ''), fingerprint)
  }
  return map
}

/**
 * Start sshd, and do not return until it will actually complete a login.
 *
 * `-E` so every connection is journalled to a file this script can count lines in, and
 * `LogLevel VERBOSE` because that count is the evidence for two negatives — terminate() opens no
 * connection at all, and a host whose key changed never reaches authentication — and at the
 * default INFO level sshd logs nothing per connection, only per successful auth. A check whose
 * subject is "no connection happened" must be able to see connections that DO happen.
 *
 * The authenticated probe at the end is not belt and braces: a listener that has answered one
 * banner can still reset the next handshake while it finishes starting, which is exactly the
 * flake this run hit on its first pass (the provider got ECONNRESET a second after the banner
 * check passed).
 */
async function startSshd() {
  // FRESH EVERY CALL, and that is load-bearing rather than tidy: phase 8 deletes the box's host
  // keys, runs `ssh-keygen -A` and restarts sshd, then calls this again. A trust store that
  // survived across calls would still hold the pre-rotation key, `accept-new` would refuse the
  // very login this probe waits for, and the failure would surface as a 30-second timeout
  // claiming sshd never came up rather than as anything resembling its actual cause.
  rmSync(probeKnownHosts, { force: true })
  docker(['exec', '-d', CONTAINER, '/usr/sbin/sshd', '-D', '-e', '-o', 'LogLevel=VERBOSE', '-E', '/var/log/sshd.log'])
  const banner = await waitForSshBanner()
  const deadline = Date.now() + 30_000
  for (;;) {
    const probe = spawnSync(
      'ssh',
      [
        '-i', adminKeyPath,
        '-p', String(SSH_PORT),
        // `accept-new`, never the disabling value: pinning is mandatory (ADR-0002), and core's
        // guard in packages/core/src/ssh/routes.test.ts fails on ANY occurrence of that value in
        // an executable — including in a comment like this one, which is why the flag is
        // described here rather than quoted. A script whose subject is proving BYO's host-key
        // pinning is the last place it should appear. Against the throwaway store above, this
        // waits for sshd without ever telling OpenSSH to skip verification.
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${probeKnownHosts}`,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        'root@127.0.0.1',
        'true',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    if (probe.status === 0) return banner
    if (Date.now() > deadline) throw new Error(`sshd never accepted a login: ${(probe.stderr ?? '').trim()}`)
    await sleep(500)
  }
}

async function waitForSshBanner(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const banner = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: SSH_PORT })
      const done = (value) => {
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(3000, () => done(''))
      socket.on('error', () => done(''))
      socket.on('data', (chunk) => done(chunk.toString('utf8')))
    })
    if (banner.startsWith('SSH-2.0')) return banner.trim()
    await sleep(500)
  }
  throw new Error(`the container never answered on 127.0.0.1:${SSH_PORT} with an SSH banner`)
}

/** Accepted publickey authentications so far, from sshd's own log. */
function acceptedLogins() {
  return Number(box('grep -c "Accepted publickey" /var/log/sshd.log 2>/dev/null || true') || '0')
}
function sshdConnections() {
  return Number(box('grep -c "Connection from" /var/log/sshd.log 2>/dev/null || true') || '0')
}

/* ------------------------------------------------------------------ run configuration */

/**
 * A pack that installs nothing and proves everything.
 *
 * The subject of this run is the provider, not the catalogue: a real pack would spend ten
 * minutes downloading toolchains to tell us what these four lines tell us in four seconds. What
 * each step is here to prove is stated on the step, and every one of them is a claim about the
 * account and the sudo rule THE PROVIDER created — the parts the in-process ssh2 server faked.
 *
 * `packs/README.md` and the real packs stay untouched: core resolves `<dataDir>/packs` whenever
 * the working directory has no `packs/`, which is why this script runs the binary from its own
 * temp directory.
 */
const E2E_PACK = `version: 1
pack:
  packId: e2e-byo
  name: BYO end-to-end probe
  tools:
    - e2e-root-probe
    - e2e-user-probe
  displayOrder: 1
  enabled: true
  requiresRepos: false
  requiresRdp: false
tools:
  - toolId: e2e-root-probe
    name: Root probe
    description: Proves a root step really ran as root, through the sudo rule the provider wrote.
    category: base
    url: https://github.com/amroja-biz/rockysurf
    installOrder: 10
    runAs: root
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail
      mkdir -p /var/lib/rockysurf
      id -un > /var/lib/rockysurf/e2e-root-probe
      uname -m >> /var/lib/rockysurf/e2e-root-probe
  - toolId: e2e-user-probe
    name: Unprivileged probe
    description: Proves the account core connects as exists, owns its home, and can sudo without a password.
    category: base
    url: https://github.com/amroja-biz/rockysurf
    installOrder: 20
    runAs: rocky
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail
      id -un > "$HOME/e2e-user-probe"
      sudo -n id -un >> "$HOME/e2e-user-probe"
`

function writeConfig() {
  mkdirSync(join(dataDir, 'packs'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dataDir, 'packs', 'e2e-byo.yaml'), E2E_PACK, { mode: 0o600 })
  writeFileSync(
    configPath,
    [
      'server:',
      `  port: ${PORT}`,
      `  dataDir: ${dataDir}`,
      'providers:',
      '  byo:',
      '    enabled: true',
      `    identityFile: ${adminKeyPath}`,
      '    hosts:',
      `      - name: ${HOST_NAME}`,
      '        host: 127.0.0.1',
      `        port: ${SSH_PORT}`,
      '        user: root',
      // NO fingerprint: this run takes the trust-on-first-use path deliberately, because that
      // is the one with a decision in it. The strict-pin path is exercised in phase 8, against
      // the fingerprint recorded here.
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
}

/* ------------------------------------------------------------------ the server under test */

let child
let serverStderr = ''

async function startCore() {
  child = spawn(process.execPath, [BIN, '--config', configPath], {
    // The TEMP directory, not the repo: `resolvePacksDir` prefers `./packs` when it exists, and
    // this run wants its own four-second pack rather than the shipped catalogue.
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ROCKYSURF_ADMIN_PASSWORD: ADMIN_PASSWORD },
  })
  child.stderr.on('data', (c) => {
    serverStderr += c.toString('utf8')
  })
  child.stdout.on('data', () => {})

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`rockysurf exited early (${child.exitCode}):\n${serverStderr}`)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (res.ok) return
    } catch {
      /* not listening yet */
    }
    await sleep(300)
  }
  throw new Error(`rockysurf never became healthy:\n${serverStderr}`)
}

async function stopCore() {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(15_000)])
}

let cookie = ''
const api = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  })
  return res
}

async function login() {
  const res = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ password: ADMIN_PASSWORD }) })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

async function byoOffering() {
  const providers = await (await api('/api/v1/providers')).json()
  const byo = providers.find((p) => p.id === 'byo')
  return { byo, offering: byo?.offerings?.find((o) => o.id === HOST_NAME) }
}

/* ------------------------------------------------------------------ the provider, directly */

/**
 * Build the provider outside core, the way `lifecycle.mjs` builds one for its orphan audit.
 *
 * Two phases need this and neither is testable through the API: the idempotence of a re-claim
 * (core will not claim a host twice with the same keys) and the refusal of a rotated host key
 * (core never gets far enough to ask). Both are provider behaviour, so both are asserted
 * against the provider.
 */
async function buildProviderDirectly(fingerprint) {
  const { byoProviderFactory } = await import(`${REPO}/packages/provider-byo/dist/index.js`)
  return byoProviderFactory.createProvider(
    byoProviderFactory.configSchema.parse({
      identityFile: adminKeyPath,
      hosts: [
        {
          name: HOST_NAME,
          host: '127.0.0.1',
          port: SSH_PORT,
          user: 'root',
          ...(fingerprint ? { fingerprint } : {}),
        },
      ],
    }),
  )
}

const specFor = (serverId, publicKey, arch) => ({
  serverId,
  name: serverId,
  offeringId: HOST_NAME,
  arch,
  sshPublicKeys: [publicKey],
  userData: '',
  tags: { 'managed-by': 'rockysurf', 'server-id': serverId },
  idempotencyKey: `${serverId}-key`,
})

/* ------------------------------------------------------------------ the run */

async function main() {
  log('=== BYO milestone exit run — production stack against a real sshd ===')
  log(`binary ${BIN}`)
  log(`workdir ${workDir}`)

  /* ---------------------------------------------------- phase 0: preflight */

  const dockerVersion = docker(['version', '--format', '{{.Server.Version}}']).stdout.trim()
  check(!!dockerVersion, 'docker daemon reachable', dockerVersion)

  const occupied = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: SSH_PORT })
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
  if (occupied) {
    throw new Error(
      `something is already listening on 127.0.0.1:${SSH_PORT}. This run publishes the container's ` +
        'sshd there. Re-run without --port to pick another one.',
    )
  }
  log(`the container's sshd will be published on 127.0.0.1:${SSH_PORT}`)

  /* ---------------------------------------------------- phase 1: a real host */

  log('--- phase 1: a real host, with a real sshd')
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'rockysurf-byo-e2e-admin', '-f', adminKeyPath], {
    stdio: 'ignore',
  })
  chmodSync(adminKeyPath, 0o600)

  writeFileSync(join(workDir, 'Dockerfile'), DOCKERFILE)
  log('building the host image (ubuntu:24.04 + openssh-server)…')
  docker(['build', '-q', '-t', IMAGE, '-f', join(workDir, 'Dockerfile'), workDir], { stdio: 'ignore' })
  docker(['run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${SSH_PORT}:22`, IMAGE])

  // The operator's own key, installed the way an operator would have it: root's authorized_keys.
  // Nothing else is prepared. The `rocky` account does not exist yet, and that is the point.
  const adminPublicKey = run('cat', [`${adminKeyPath}.pub`]).stdout.trim()
  box(`mkdir -p /root/.ssh && chmod 700 /root/.ssh && printf '%s\\n' ${JSON.stringify(adminPublicKey)} > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`)
  check(box('id -u rocky 2>/dev/null || echo absent') === 'absent', 'the box starts with no rocky account')
  check(
    box('ls /etc/sudoers.d/90-rockysurf-rocky 2>/dev/null || echo absent') === 'absent',
    'the box starts with no rockysurf sudoers rule',
  )

  const banner = await startSshd()
  check(banner.includes('OpenSSH'), `a real OpenSSH server is listening on 127.0.0.1:${SSH_PORT}`, banner)

  const hostKeys = containerHostKeyFingerprints()
  log(`  host keys on the box: ${[...hostKeys].map(([type, fp]) => `${type} ${fp}`).join(', ')}`)

  const boxFacts = {
    cpu: Number(box('nproc')),
    memKb: Number(box("awk '/^MemTotal:/{print $2}' /proc/meminfo")),
    machine: box('uname -m'),
    diskKb: Number(box("df -Pk / | awk 'NR==2{print $2}'")),
  }
  const ARCH = boxFacts.machine === 'x86_64' ? 'amd64' : 'arm64'
  log(`  box facts: ${boxFacts.cpu} cpu, ${(boxFacts.memKb / 1024 / 1024).toFixed(1)} GiB, ${boxFacts.machine}`)

  // A workload that was running before Rocky Surf ever connected. Phase 6 asserts it survives
  // terminate() — "the operator's machine" is not an abstraction if something of theirs is on it.
  docker(['exec', '-d', CONTAINER, '/bin/sh', '-c', 'sleep 987654'])
  check(box("pgrep -f 'sleep 987654' >/dev/null && echo yes || echo no") === 'yes', "the operator's own workload is running")

  /* ---------------------------------------------------- phase 2: core sees the host */

  log('--- phase 2: the production stack, booted from a real config file')
  writeConfig()
  await startCore()
  check(true, 'rockysurf booted with providers.byo enabled')
  await login()

  const { byo, offering } = await byoOffering()
  check(!!byo, 'the composition root registered the real byo provider', byo?.displayName)
  check(byo?.capabilities?.stop === false, 'capabilities.stop is false')
  check(byo?.capabilities?.canInjectHostKeys === false, 'capabilities.canInjectHostKeys is false')
  check(byo?.capabilities?.generatesUserData === false, 'capabilities.generatesUserData is false')

  // These four numbers were READ OFF THE BOX over SSH by `listOfferings()`, so this is the first
  // real proof that the probe script runs on a machine that is not a fake: they have to agree
  // with what docker exec sees.
  check(!!offering, `the registered host is offered as '${HOST_NAME}'`)
  check(offering?.available === true, 'an unclaimed host is available')
  check(offering?.cpu === boxFacts.cpu, 'the probe read the real cpu count', `${offering?.cpu} vs ${boxFacts.cpu}`)
  check(offering?.arch === ARCH, 'the probe read the real architecture', `${offering?.arch} vs ${boxFacts.machine}`)
  check(
    Math.abs((offering?.memoryGb ?? 0) - boxFacts.memKb / 1024 / 1024) < 0.11,
    'the probe read the real memory size',
    `${offering?.memoryGb} GiB vs ${(boxFacts.memKb / 1024 / 1024).toFixed(1)} GiB`,
  )
  check(offering?.hourly === null, 'the operator’s own hardware is priced as unknown, not free')

  /* ---------------------------------------------------- phase 3: claim + push bootstrap */

  log('--- phase 3: claim the host and let core push-bootstrap it')
  let serverId
  let server
  try {
    const created = await api('/api/v1/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: `e2e-byo-${STAMP}`,
        size: 'small',
        provider: 'byo',
        offeringId: HOST_NAME,
        arch: ARCH,
        packId: 'e2e-byo',
      }),
    })
    const body = await created.json()
    check(created.status === 201, 'POST /api/v1/servers claimed the host', `${created.status} ${body.error ?? ''}`)
    if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(body)}`)
    serverId = body.serverId
    log(`  server ${serverId}`)

    const deadline = Date.now() + READY_TIMEOUT_MS
    let lastStep
    server = body
    while (Date.now() < deadline) {
      server = await (await api(`/api/v1/servers/${serverId}`)).json()
      if (server.provisioningStep !== lastStep) {
        lastStep = server.provisioningStep
        log(`  status=${server.status} step=${server.provisioningStep ?? '-'} ip=${server.publicIp ?? '-'}`)
      }
      if (server.status === 'running' && server.provisioningStep === 'ready') break
      if (server.status === 'failed') throw new Error(`provisioning failed: ${server.errorMessage}`)
      if (server.status === 'terminated') throw new Error('the row went terminated while provisioning')
      await sleep(POLL_MS)
    }
    check(server.status === 'running', 'server reached running', `status=${server.status}`)
    check(server.provisioningStep === 'ready', 'push bootstrap reported ready', `step=${server.provisioningStep}`)
    check(server.bootstrapMode === 'push', 'byo bootstrapped in push mode', server.bootstrapMode)
    check(server.publicIp === '127.0.0.1', 'the row carries the registered address', server.publicIp)
    check(server.sshUser === 'rocky', 'core connects as the account the provider created', server.sshUser)
    // The whole of rockysurf-ftl9.12 in two lines: the registry's port reached the API, and the
    // bootstrap above — which only reported `ready` because it connected — used it. On the
    // broken code this box is claimed and prepared exactly as it was, and then core dials 22
    // until the provisioning timeout, so `ready` above is itself the proof.
    check(
      SSH_PORT === 22 ? server.sshPort === undefined : server.sshPort === SSH_PORT,
      'the API reports the port the host was registered on (22 is reported as absent)',
      `sshPort=${String(server.sshPort)} port=${SSH_PORT}`,
    )

    const afterClaim = (await byoOffering()).offering
    check(afterClaim?.available === false, 'a claimed host is reported unavailable, not hidden')

    /* -------------------------------------------- phase 4: what is actually on the box */

    log('--- phase 4: the box itself')
    check(box('id -u rocky >/dev/null 2>&1 && echo yes || echo no') === 'yes', 'a real useradd created the rocky account')
    const home = box("getent passwd rocky | cut -d: -f6")
    check(home === '/home/rocky', 'the account has a real home directory', home)
    check(box('stat -c %a /home/rocky/.ssh') === '700', '~/.ssh is 700')
    check(box('stat -c %a /home/rocky/.ssh/authorized_keys') === '600', 'authorized_keys is 600')
    check(box('stat -c %U /home/rocky/.ssh/authorized_keys') === 'rocky', 'authorized_keys is owned by the account')

    const sudoers = box('cat /etc/sudoers.d/90-rockysurf-rocky')
    check(sudoers === 'rocky ALL=(ALL) NOPASSWD:ALL', 'the sudoers drop-in says what the provider wrote', sudoers)
    check(box('stat -c %a /etc/sudoers.d/90-rockysurf-rocky') === '440', 'the sudoers drop-in is 440')
    // THE ASSERTION THE IN-PROCESS SERVER COULD NOT MAKE: sudo itself parsed that file and
    // agreed. A syntactically valid string in the right path is not the same fact.
    const sudoProbe = boxAs('rocky', 'sudo -n id -un', { allowFailure: true })
    check(sudoProbe.out === 'root', 'sudo -n really works for the account, per sudo itself', sudoProbe.out || sudoProbe.err)

    // The key core minted authorizes the account, according to sshd's own authorized_keys file.
    const keyRes = await api(`/api/v1/servers/${serverId}/ssh-key`)
    check(keyRes.status === 200, 'private key downloadable from the API', String(keyRes.status))
    const keyPath = join(workDir, 'server_key')
    writeFileSync(keyPath, await keyRes.text(), { mode: 0o600 })
    chmodSync(keyPath, 0o600)
    const corePublicKey = run('ssh-keygen', ['-y', '-f', keyPath]).stdout.trim().split(' ').slice(0, 2).join(' ')
    const authorized = box('cat /home/rocky/.ssh/authorized_keys')
    check(authorized.includes(corePublicKey), "core's minted public key is in the account's authorized_keys")
    check(authorized.split('\n').filter(Boolean).length === 1, 'exactly one key was installed', `${authorized.split('\n').filter(Boolean).length} line(s)`)

    // The pack steps, which only ran because the sudo rule and the account are real.
    check(box('head -1 /var/lib/rockysurf/e2e-root-probe') === 'root', 'the root pack step ran as root')
    check(box('head -1 /home/rocky/e2e-user-probe') === 'rocky', 'the unprivileged pack step ran as rocky')
    check(box('tail -1 /home/rocky/e2e-user-probe') === 'root', 'a pack step can sudo without a password')
    check(box('cat /etc/rockysurf/server-info 2>/dev/null || true') === `serverId=${serverId}`, 'the branding step named THIS server on the box')

    // The banner itself, on disk. `/etc/motd` is the file PAM prints last, immediately above
    // the prompt — the login below is what proves it actually reaches a screen.
    const motd = box('cat /etc/motd')
    check(motd.includes(LOGO_ART_LINE), 'the logo reached /etc/motd with its backslashes intact', LOGO_ART_LINE)
    check(motd.includes(LOGO_LAST_LINE), "/etc/motd carries the logo's last art line")
    check(motd.includes(BRANDING_URL), '/etc/motd carries the project URL the issue asks for')
    // `present, not executable` and not merely `not executable`: an absent file would satisfy a
    // bare `! -x` on any non-Ubuntu box and prove nothing about the step having done anything.
    const motdScriptState = (name) =>
      box(`if [ ! -f /etc/update-motd.d/${name} ]; then echo absent; elif [ -x /etc/update-motd.d/${name} ]; then echo executable; else echo quiet; fi`)
    check(motdScriptState('00-header') === 'quiet', "Ubuntu's stock welcome header is present and no longer runs")
    check(motdScriptState('50-motd-news') === 'quiet', 'the MOTD news fetch — a network call at login — no longer runs')

    // CONVERGENCE, MEASURED. `agent.sh` re-runs any step it has not journalled `done`, so the
    // branding step meets its own script a second time on every resume. Re-run the exact script
    // from the plan the agent executed, and the file must not move a byte.
    const motdBefore = box('sha256sum /etc/motd')
    box("jq -r '.steps[] | select(.id == \"branding\") | .run' /var/lib/rockysurf/plan.json > /tmp/branding-rerun.sh && bash /tmp/branding-rerun.sh")
    const motdAfter = box('sha256sum /etc/motd')
    check(motdBefore === motdAfter, 'running the branding step twice leaves /etc/motd byte-identical', motdAfter)
    const agentStatus = box("grep -o '\"status\":\"[a-z]*\"' /var/lib/rockysurf/state.json | head -1")
    check(agentStatus.includes('done'), "the agent's own journal says the plan completed", agentStatus)

    // WHICH LAUNCHER THIS RUN PROVES, stated rather than assumed. A container has no
    // `/run/systemd/system`, so push mode takes its nohup fallback (contract #10) — the branch
    // the cloud runs never reach, since both cloud images boot systemd. `agent.log` exists only
    // on that branch: systemd-run sends the agent's output to the journal instead. The
    // complementary half of #10 is covered by `lifecycle.mjs` on AWS and Hetzner.
    const systemd = box('test -d /run/systemd/system && echo yes || echo no')
    const agentLog = box('test -f /var/lib/rockysurf/agent.log && echo yes || echo no')
    check(
      systemd === 'no' && agentLog === 'yes',
      'on a box with no systemd the agent was launched with the nohup fallback and outlived the session',
      `systemd=${systemd}, agent.log=${agentLog}`,
    )

    /* -------------------------------------------- phase 5: an SSH login, the way a user makes it */

    log('--- phase 5: a real login with the key the API hands out')
    const knownHosts = join(workDir, 'known_hosts')
    const ssh = spawnSync(
      'ssh',
      [
        '-i', keyPath,
        '-p', String(SSH_PORT),
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ConnectTimeout=20',
        `rocky@127.0.0.1`,
        'id -un && sudo -n id -un && cat /var/lib/rockysurf/e2e-root-probe',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    const sshOut = (ssh.stdout ?? '').trim().split('\n').filter(Boolean)
    check(sshOut[0] === 'rocky', 'ssh rocky@host succeeds with the key core minted', sshOut[0] ?? (ssh.stderr ?? '').trim())
    check(sshOut[1] === 'root', 'that session can sudo without a password', sshOut[1] ?? '')
    check(!sshOut.some((line) => line.includes(BRANDING_URL)), 'a non-interactive `ssh host cmd` prints no MOTD, which is why the login below forces a TTY')

    // THE CLAIM ISSUE #33 ACTUALLY MAKES, asserted by OpenSSH and PAM rather than by us reading
    // a file: somebody who logs in SEES the logo. `-tt` forces a pty and no remote command, so
    // this is a login shell and `pam_motd` fires; the command form above deliberately does not.
    const login = spawnSync(
      'ssh',
      [
        '-tt',
        '-i', keyPath,
        '-p', String(SSH_PORT),
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ConnectTimeout=20',
        `rocky@127.0.0.1`,
      ],
      { encoding: 'utf8', timeout: 60_000, input: 'exit\n' },
    )
    // A pty terminates lines with CRLF; the banner's own bytes are LF and unchanged.
    const welcome = (login.stdout ?? '').replaceAll('\r', '')
    log('--- what the login printed:')
    for (const line of welcome.split('\n')) log(`      | ${line}`)
    check(welcome.includes(LOGO_ART_LINE), 'an interactive login PRINTS the logo, backslashes and all', LOGO_ART_LINE)
    check(welcome.includes(LOGO_LAST_LINE), "the logo's last art line reached the screen")
    check(welcome.includes(BRANDING_URL), 'the login screen carries the project URL')
    check(!welcome.includes('Welcome to Ubuntu'), "Ubuntu's stock welcome header did not print above it")
    // Columns, not bytes. Bash's own prompt arrives wrapped in colour, bracketed-paste and
    // xterm-title escapes, none of which occupy a column — measuring those would fail a banner
    // that fits perfectly.
    const columns = (line) =>
      line
        .replaceAll(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '') // OSC — the window title
        .replaceAll(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '').length // CSI — colour, bracketed paste
    const tooWide = welcome.split('\n').filter((line) => columns(line) > 80)
    check(tooWide.length === 0, 'nothing the login printed wraps an 80-column terminal', tooWide[0] ?? '')

    // The fingerprint OpenSSH recorded for the box, independently of the provider, is the one
    // the provider reported to core. Three parties now agree on one key.
    const learned = run('ssh-keygen', ['-lf', knownHosts]).stdout.trim().split('\n')[0]?.split(/\s+/)[1]
    check([...hostKeys.values()].includes(learned), "OpenSSH pinned the box's own host key", learned)

    // THE ROUTE SERVES THE BOX'S OWN KEY (rockysurf-ftl9.13, rockysurf-ftl9.14). It exists so a
    // client can write a real known_hosts entry and connect with no trust-on-first-use window.
    // It used to answer with the key core MINTED, which this box will never present — an entry
    // guaranteed to fail verification, which is the alarm that means interception. The provider
    // now reports the key it saw during the handshake it pinned, so the answer is the real one.
    const hostKeyResponse = await api(`/api/v1/servers/${serverId}/ssh-host-key`)
    const hostKeyRoute = await hostKeyResponse.json()
    check(hostKeyResponse.status === 200, 'GET /ssh-host-key answers for a box core did not key', `HTTP ${hostKeyResponse.status}`)
    check(
      hostKeyRoute?.source === 'observed',
      'and says the key was OBSERVED by the provider, not minted by core',
      String(hostKeyRoute?.source),
    )
    check(
      [...hostKeys.values()].includes(hostKeyRoute?.fingerprint),
      "the fingerprint it returns is the box's own, the one core pinned",
      String(hostKeyRoute?.fingerprint),
    )
    // The strongest form of this check: OpenSSH itself learned the key independently in phase 5
    // above, and the route's key is byte-identical to what it wrote into known_hosts.
    const routeKey = String(hostKeyRoute?.hostPublicKey ?? '').trim().split(/\s+/).slice(0, 2).join(' ')
    const learnedKey = run('ssh-keygen', ['-f', knownHosts, '-F', `[127.0.0.1]:${SSH_PORT}`], { allowFailure: true })
      .stdout.split('\n')
      .find((line) => line && !line.startsWith('#'))
    check(
      !!routeKey && !!learnedKey && learnedKey.includes(routeKey.split(' ')[1]),
      'and the KEY it returns is the one OpenSSH independently pinned for this box',
      routeKey.slice(0, 40),
    )

    /* -------------------------------------------- phase 6: terminate touches nothing */

    log('--- phase 6: terminate releases the claim and leaves the machine alone')
    const before = {
      passwd: box('getent passwd rocky'),
      sudoers: box('sha256sum /etc/sudoers.d/90-rockysurf-rocky'),
      authorized: box('sha256sum /home/rocky/.ssh/authorized_keys'),
      home: box('ls -la /home/rocky | sha256sum'),
      state: box('sha256sum /var/lib/rockysurf/state.json'),
      processes: box("ps -eo comm= | sort | uniq -c | sort -k2"),
      logins: acceptedLogins(),
      connections: sshdConnections(),
    }

    const terminated = await api(`/api/v1/servers/${serverId}/terminate`, { method: 'POST' })
    check(terminated.ok, 'terminate accepted', String(terminated.status))
    serverId = undefined // the finally-block cleanup has nothing left to do

    const after = {
      passwd: box('getent passwd rocky'),
      sudoers: box('sha256sum /etc/sudoers.d/90-rockysurf-rocky'),
      authorized: box('sha256sum /home/rocky/.ssh/authorized_keys'),
      home: box('ls -la /home/rocky | sha256sum'),
      state: box('sha256sum /var/lib/rockysurf/state.json'),
      processes: box("ps -eo comm= | sort | uniq -c | sort -k2"),
      logins: acceptedLogins(),
      connections: sshdConnections(),
    }

    check(after.passwd === before.passwd, 'the account still exists, unchanged', after.passwd)
    check(after.sudoers === before.sudoers, 'the sudoers drop-in is untouched')
    check(after.authorized === before.authorized, 'authorized_keys is untouched')
    check(after.home === before.home, 'the home directory is untouched')
    check(after.state === before.state, "the agent's state directory is untouched")
    check(after.processes === before.processes, 'every process that was running is still running')
    check(box("pgrep -f 'sleep 987654' >/dev/null && echo yes || echo no") === 'yes', "the operator's workload survived")
    // The sharpest of them: sshd never even saw a connection. terminate() is bookkeeping.
    check(
      after.connections === before.connections,
      'terminate opened NO connection to the box',
      `${before.connections} before, ${after.connections} after`,
    )
    check(after.logins === before.logins, 'and therefore authenticated nothing')

    const released = (await byoOffering()).offering
    check(released?.available === true, 'the host is available again once the claim is released')
  } finally {
    if (serverId) {
      try {
        await api(`/api/v1/servers/${serverId}/terminate`, { method: 'POST' })
      } catch {
        /* the box is a container this script is about to delete anyway */
      }
    }
  }

  /* ---------------------------------------------------- phase 7: re-claiming is idempotent */

  log('--- phase 7: a second claim on the same box changes nothing it should not')
  const pinned = [...hostKeys.values()]
  const provider = await buildProviderDirectly()

  const beforeReclaim = {
    passwd: box('getent passwd rocky'),
    uid: box('id -u rocky'),
    homeStat: box('stat -c "%U %G %a" /home/rocky'),
    authorizedLines: Number(box('wc -l < /home/rocky/.ssh/authorized_keys')),
    sudoers: box('cat /etc/sudoers.d/90-rockysurf-rocky'),
  }

  const reclaimKey = run('ssh-keygen', ['-y', '-f', adminKeyPath]).stdout.trim().split(' ').slice(0, 2).join(' ')
  check((await provider.listManaged()).length === 0, 'an unclaimed registered host is not reported as managed')

  const first = await provider.provision(specFor('srv-reclaim-a', reclaimKey, ARCH))
  check(pinned.includes(first.initial.hostKeyFingerprint), 'TOFU recorded the fingerprint the box actually presents', first.initial.hostKeyFingerprint)
  const afterFirst = Number(box('wc -l < /home/rocky/.ssh/authorized_keys'))
  check(afterFirst === beforeReclaim.authorizedLines + 1, 'a new key is APPENDED, never written over the existing one', `${beforeReclaim.authorizedLines} → ${afterFirst}`)

  // The reconciler's input, checked the way lifecycle.mjs checks a cloud's: a claim is the only
  // thing BYO can leak, and reaping one costs a bookkeeping record rather than a machine.
  const managed = await provider.listManaged()
  check(
    managed.length === 1 && managed[0].kind === 'host' && managed[0].ownership === 'server-owned' && managed[0].serverId === 'srv-reclaim-a',
    'a claim is reported as one server-owned host, attributed to its server',
    JSON.stringify(managed),
  )

  await provider.terminate(first.data)
  check((await provider.listManaged()).length === 0, 'releasing the claim removes it from the managed list')
  const second = await provider.provision(specFor('srv-reclaim-b', reclaimKey, ARCH))
  const afterSecond = Number(box('wc -l < /home/rocky/.ssh/authorized_keys'))
  check(afterSecond === afterFirst, 're-running the claim with the same key adds no duplicate line', `${afterFirst} → ${afterSecond}`)
  check(box('id -u rocky') === beforeReclaim.uid, 'the account was not recreated', `uid ${beforeReclaim.uid}`)
  check(box('stat -c "%U %G %a" /home/rocky') === beforeReclaim.homeStat, 'the home directory kept its ownership and mode')
  check(box('cat /etc/sudoers.d/90-rockysurf-rocky') === beforeReclaim.sudoers, 'the sudoers rule is written once, not appended to')
  check(
    Number(box('wc -l < /etc/sudoers.d/90-rockysurf-rocky')) === 1,
    'the sudoers drop-in is still a single line',
  )
  await provider.terminate(second.data)

  /* ---------------------------------------------------- phase 8: a changed host key is refused */

  log('--- phase 8: the box changes its identity, and every path refuses it')
  box('rm -f /etc/ssh/ssh_host_*')
  box('ssh-keygen -A >/dev/null')
  // `[s]shd` so the pattern cannot match the shell carrying it — without the bracket, pkill
  // finds this very `sh -c`, kills it, and the exec reports 143.
  box("pkill -f '[s]shd -D' || true")
  await sleep(500)
  await startSshd()

  // Baselines AFTER the restart probe, so the probe's own login is not counted as a refusal.
  const loginsBeforeRotation = acceptedLogins()
  const connectionsBeforeRotation = sshdConnections()
  const rotated = containerHostKeyFingerprints()
  check(
    [...rotated.values()].every((fp) => !pinned.includes(fp)),
    'the box now presents entirely different host keys',
    [...rotated.values()][0],
  )

  // (a) the pin this very provider LEARNED, on a host it has already claimed once.
  const learnedRefusal = await provider.provision(specFor('srv-rotated-a', reclaimKey, ARCH)).catch((err) => err)
  check(
    learnedRefusal?.code === 'auth' && learnedRefusal?.providerCode === 'host_key_mismatch',
    'a TOFU-learned pin refuses the changed key',
    `${learnedRefusal?.code}/${learnedRefusal?.providerCode ?? ''}`,
  )

  // (b) a fresh provider carrying the operator's CONFIGURED fingerprint — the strict path, which
  // has no first-connection window at all.
  const strict = await buildProviderDirectly(pinned[0])
  const strictRefusal = await strict.validateCredentials().catch((err) => err)
  check(
    strictRefusal?.code === 'auth' && strictRefusal?.providerCode === 'host_key_mismatch',
    'a configured pin refuses the changed key',
    `${strictRefusal?.code}/${strictRefusal?.providerCode ?? ''}`,
  )

  check(
    acceptedLogins() === loginsBeforeRotation,
    'neither refusal authenticated — no credential reached the wrong host',
    `${loginsBeforeRotation} accepted logins, unchanged`,
  )
  // The pair matters. Unchanged logins alone would also be true of a script that never dialled;
  // the connection count rising is what says the refusal happened DURING a real handshake with a
  // real sshd, after the host key was on the wire and before anything was authenticated.
  check(
    sshdConnections() >= connectionsBeforeRotation + 2,
    'both refusals reached sshd and stopped inside the handshake',
    `${connectionsBeforeRotation} → ${sshdConnections()} connections`,
  )

  log('--- server log tail ---')
  for (const line of serverStderr.trim().split('\n').slice(-6)) log(`  ${line}`)
}

function teardown() {
  if (KEEP) {
    log(`--keep: container ${CONTAINER} and image ${IMAGE} left behind (docker rm -f ${CONTAINER})`)
    log(`        workdir ${workDir}`)
    return
  }
  docker(['rm', '-f', CONTAINER], { allowFailure: true, stdio: 'ignore' })
  docker(['rmi', '-f', IMAGE], { allowFailure: true, stdio: 'ignore' })
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

main()
  .then(async () => {
    await stopCore()
    teardown()
    log(failures === 0 ? 'RESULT: PASS — byo against a real sshd' : `RESULT: FAIL — ${failures} check(s)`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(async (err) => {
    await stopCore()
    teardown()
    log('RESULT: FAIL — unhandled error')
    console.error(err)
    process.exit(1)
  })
