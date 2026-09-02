#!/usr/bin/env node
/**
 * Milestone exit check: the PRODUCTION stack against a real cloud.
 *
 *   node scripts/e2e/lifecycle.mjs hetzner
 *   node scripts/e2e/lifecycle.mjs aws
 *   node scripts/e2e/lifecycle.mjs gcp        (needs ROCKYSURF_E2E_GCP_PROJECT)
 *   node scripts/e2e/lifecycle.mjs azure      (needs ROCKYSURF_E2E_AZURE_SUBSCRIPTION
 *                                              and ROCKYSURF_E2E_AZURE_RESOURCE_GROUP)
 *
 * THIS SPENDS MONEY. It creates one real server per run and destroys it again, and the
 * teardown is in a `finally` so a failure anywhere still cleans up. Exits non-zero if anything
 * is left behind.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE SPIKE CAPSTONE. The spike drove its own harness against
 * provider code directly. This drives the shipped article: the `rockysurf` binary — the
 * composition root that wires real providers into core — booted from a real config file, and
 * then everything through core's own HTTP API, exactly as the SPA would. Create, bootstrap,
 * SSH, stop/start, terminate, and the zero-orphan audit all go through the production path.
 *
 * SECURITY CONTRACT ON DISPLAY: `sshAllowedCidr` is looked up at RUN time and written into the
 * config FILE. The provider refuses to discover it at runtime, which is the point — a firewall
 * rule is a reviewable decision, not an inference. This script is the caller, so this script
 * owns that decision and records it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  AuditCredentialError,
  assertDistinctPrincipals,
  resolveAuditCredentials,
  resolveRunCredentials,
} from './aws-audit-credentials.mjs'
import { CI_SSH_SG_NAME } from './aws-ci-ssh-sg.mjs'

/**
 * The offerings this exit run uses, and THE ARCHITECTURE EACH ONE IS EXPECTED TO BE.
 *
 * Written down here rather than read back from `/api/v1/providers`, because the run has to be
 * able to catch a provider that reports the wrong architecture for a machine type — and a
 * check that takes its expectation from the thing it is checking cannot fail. AWS and GCP carry
 * two each because arch-correct image selection is only proven by running both: an Arm box and
 * an x86_64 one, from the same code path with nothing but the offering id different.
 *
 * GCP's arm64 entry is `t2a-standard-1` rather than a `c4a-standard-*`, and that is a zone fact
 * rather than a preference: T2A exists in eight zones and `us-central1-a` — this leg's default,
 * and the provider's — is one of them, while C4A additionally needs `bootDiskType:
 * hyperdisk-balanced`, which is one provider-wide setting for both legs of the matrix and would
 * therefore break the amd64 leg to fix the arm64 one. `t2a-standard-1` is also the type the
 * 2026-08-14 hand run used, so a failure here is a regression rather than an unknown.
 *
 * AZURE'S PAIR IS NOT THE HAND RUN'S PAIR (gh issue #170). rockysurf-ihtq.8 proved the
 * published role with `Standard_B2ls_v2`/`Standard_B2ps_v2` on 2026-08-26, but every B-series
 * v2 family ships with ZERO vCPU quota on a fresh subscription, and the CI subscription's SKU
 * lists restrict those sizes outright — a leg built on them could never start (verified
 * 2026-08-30). `Standard_D2ls_v6` (amd64, 2c/4 GiB) and `Standard_D2pls_v6` (arm64 Ampere,
 * 2c/4 GiB, the cheaper of the two) are the commodity Dv6 equivalents: their families default
 * to 10 vCPUs with no quota request, and both are unrestricted in westus3 and centralus. Same
 * 4 GiB memory floor as the other legs, so the nightly stays a regression check rather than a
 * memory experiment.
 *
 * Cheapest type per cloud that runs the pack. Budget discipline is not optional here.
 */
const RUNS = {
  hetzner: { cpx12: 'amd64' },
  aws: { 't4g.small': 'arm64', 't3.small': 'amd64' },
  gcp: { 't2a-standard-1': 'arm64', 'e2-small': 'amd64' },
  azure: { Standard_D2pls_v6: 'arm64', Standard_D2ls_v6: 'amd64' },
}

const CLOUD = process.argv[2]
if (!Object.hasOwn(RUNS, CLOUD ?? '')) {
  console.error(`usage: node scripts/e2e/lifecycle.mjs <${Object.keys(RUNS).join('|')}> [offeringId]`)
  process.exit(2)
}

const OFFERING = process.argv[3] ?? Object.keys(RUNS[CLOUD])[0]
const ARCH = RUNS[CLOUD][OFFERING]
if (!ARCH) {
  console.error(`unknown offering '${OFFERING}' for ${CLOUD}; known: ${Object.keys(RUNS[CLOUD]).join(', ')}`)
  process.exit(2)
}

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const BIN = join(REPO, 'packages/rockysurf/dist/bin.js')
/** One region for the config, the direct provider build and the raw volume audit alike. */
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1'

/**
 * The GCP project and zone, for the config and the direct provider build alike.
 *
 * NO DEFAULT PROJECT, and no fallback to `gcloud config get-value project` — the same rule the
 * provider itself enforces, for the same reason: a credential can be valid for many projects and
 * names none of them, so a guess here creates billable machines somewhere nobody chose. In CI it
 * is a repository variable pointing at a project that exists only for this workflow.
 *
 * The zone default matches the provider's own (`us-central1-a`), which is one of the eight zones
 * with T2A stock — the reason it is the provider's default too.
 */
const GCP_PROJECT = process.env.ROCKYSURF_E2E_GCP_PROJECT ?? ''
const GCP_ZONE = process.env.ROCKYSURF_E2E_GCP_ZONE || 'us-central1-a'

/**
 * The Azure subscription, resource group and region (gh issue #170).
 *
 * NO DEFAULTS for the first two, on the same rule GCP's project follows and for the same reason:
 * a credential is valid for a subscription it does not name, so a guess creates billable machines
 * in an account nobody chose. The resource group is additionally the SCOPE the published
 * operational role is granted at — Rocky Surf never creates one — so inventing a name would
 * produce an `AuthorizationFailed` that reads like a missing action rather than a missing group.
 *
 * In CI both are repository variables naming a group that exists only for this workflow.
 */
const AZURE_SUBSCRIPTION = process.env.ROCKYSURF_E2E_AZURE_SUBSCRIPTION ?? ''
const AZURE_RESOURCE_GROUP = process.env.ROCKYSURF_E2E_AZURE_RESOURCE_GROUP ?? ''
const AZURE_LOCATION = process.env.ROCKYSURF_E2E_AZURE_LOCATION || 'westus3'
const PORT = 3200 + Math.floor(Math.random() * 300)
const ADMIN_PASSWORD = 'e2e-admin-password'

const READY_TIMEOUT_MS = 12 * 60_000
const GONE_TIMEOUT_MS = 8 * 60_000
const POLL_MS = 5_000

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

/* ------------------------------------------------------------------ run configuration */

const workDir = mkdtempSync(join(tmpdir(), `rockysurf-e2e-${CLOUD}-`))
const dataDir = join(workDir, 'data')
const configPath = join(workDir, 'rockysurf.config.yaml')

/** The operator's current public address, resolved ONCE, here, and written to the config. */
async function currentPublicIp() {
  const res = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(10_000) })
  const ip = (await res.text()).trim()
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error(`unexpected address from checkip: ${ip}`)
  return ip
}

/** Hetzner's token, from the same file the spike used. Never printed. */
function hetznerToken() {
  const path = join(process.env.HOME ?? '', '.config/rockysurf/spike.env')
  const out = spawnSync('bash', ['-c', `set -a; . ${JSON.stringify(path)}; set +a; printf %s "$HETZNER_TOKEN"`], {
    encoding: 'utf8',
  })
  const token = out.stdout?.trim()
  if (!token) throw new Error(`no HETZNER_TOKEN in ${path}`)
  return token
}

async function writeConfig() {
  const lines = [`server:`, `  port: ${PORT}`, `  dataDir: ${dataDir}`, `providers:`]

  if (CLOUD === 'hetzner') {
    lines.push(`  hetzner:`, `    enabled: true`, `    token: ${hetznerToken()}`, `    location: fsn1`)
  } else if (CLOUD === 'gcp') {
    const cidr = `${await currentPublicIp()}/32`
    log(`sshAllowedCidr resolved at run time and written to config: ${cidr}`)
    // NO `keyFile`, ever. The credential comes from the ambient ADC chain, which in CI is the
    // federated credential file `google-github-actions/auth` wrote from GitHub's own OIDC token
    // and locally is `gcloud auth application-default login`. There is no long-lived key in
    // either path, and the config schema has nowhere to put key material anyway.
    lines.push(
      `  gcp:`,
      `    enabled: true`,
      `    projectId: ${GCP_PROJECT}`,
      `    zone: ${GCP_ZONE}`,
      `    sshAllowedCidr: ${cidr}`,
    )
  } else if (CLOUD === 'azure') {
    const cidr = `${await currentPublicIp()}/32`
    log(`sshAllowedCidr resolved at run time and written to config: ${cidr}`)
    // NO SECRET, ever — the Azure config schema has nowhere to put one. The credential comes
    // from `CredentialChain`, which in CI is workload identity federation: the three standard
    // AZURE_* variables and a file holding GitHub's own OIDC token (gh issue #170).
    //
    // `allowAzureCli: false` IS LOAD-BEARING HERE, NOT HARDENING THEATRE. The nightly's sweep
    // step logs `az` in as the CI-ONLY identity on the same runner, so a chain permitted to fall
    // through to `az account get-access-token` could quietly run the lifecycle as the sweep
    // account — every check would pass and the run would prove nothing whatsoever about the role
    // this project publishes. It is also what the 2026-08-26 hand run set, for the same reason.
    lines.push(
      `  azure:`,
      `    enabled: true`,
      `    subscriptionId: ${AZURE_SUBSCRIPTION}`,
      `    resourceGroup: ${AZURE_RESOURCE_GROUP}`,
      `    location: ${AZURE_LOCATION}`,
      `    sshAllowedCidr: ${cidr}`,
      `    allowAzureCli: false`,
    )
  } else {
    const cidr = `${await currentPublicIp()}/32`
    log(`sshAllowedCidr resolved at run time and written to config: ${cidr}`)
    lines.push(`  aws:`, `    enabled: true`, `    region: ${AWS_REGION}`)
    // Pin the nightly to its own SSH group (issue #326). Without this the provider defaults to
    // `rockysurf-ssh`, the group a real user's box would also use — and the `if: always()` sweep,
    // aimed at the CI group, would then clean a group the run never filled while the shared one
    // leaked. The sweep imports this same const, so the two can never name different groups.
    lines.push(`    securityGroupName: ${CI_SSH_SG_NAME}`)
    // A named profile locally, the default credential chain in CI — where there is no
    // ~/.aws/config to name and the credentials arrive as environment variables. Set
    // ROCKYSURF_E2E_AWS_PROFILE to '' to force the chain.
    const { profile } = resolveRunCredentials(process.env)
    if (profile) lines.push(`    profile: ${profile}`)
    lines.push(`    sshAllowedCidr: ${cidr}`)
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  writeFileSync(configPath, `${lines.join('\n')}\n`, { mode: 0o600 })
}

/* ------------------------------------------------ what THIS run is allowed to destroy */

/**
 * The ids of servers this run created, written down the instant they exist.
 *
 * THE SWEEP READS THIS, AND NOTHING ELSE (rockysurf-rkh3). `managed-by=rockysurf` is an
 * ownership claim shared by every Rocky Surf installation pointed at this cloud account — it
 * says "a Rocky Surf made this", not "this run made this". A sweep selecting on it deletes
 * whatever the label matches, and on 2026-08-12 that was the repository owner's own live
 * server: they launched it from their laptop's Rocky Surf against the same Hetzner project at
 * 16:11:00, our audit saw it 37 seconds later, and our sweep destroyed it at 16:11:37 while
 * reporting it as a leak. The `server-id` label is the per-server marker, and this file is how
 * a shell step three minutes and one process later gets to know which ones were ours.
 *
 * WRITTEN AT CREATE TIME, NOT AT EXIT, and flushed synchronously: the whole point of the sweep
 * is the paths where this process does not reach its own cleanup — cancelled, timed out,
 * killed. A file written on the way out would be empty in exactly those cases.
 *
 * The residual window is the create call itself: a kill between the provider creating the
 * machine and the API answering 201 leaves a server this file never names. The sweep reports
 * those rather than deleting them, because "we cannot prove it is ours" and "it is safe to
 * destroy" are not the same sentence.
 */
const RUN_IDS_FILE = process.env.ROCKYSURF_E2E_RUN_IDS_FILE ?? join(workDir, 'run-ids.txt')

function recordCreatedServer(id) {
  appendFileSync(RUN_IDS_FILE, `${id}\n`)
}

/* ------------------------------------------------------------------ the server under test */

let child
let serverStderr = ''

async function startCore() {
  child = spawn(process.execPath, [BIN, '--config', configPath], {
    cwd: REPO, // so packs/ is found by the checkout branch of the pack sync
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

/* ------------------------------------------------------------------ the API, as the SPA sees it */

let cookie = ''
const api = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  })
  return res
}

/**
 * Poll the same GET the SPA polls until the row settles on a status, or give up.
 *
 * The GET syncs from the provider, so this is asking the cloud, not the database. The row may
 * legitimately bounce on the way — a provider reporting `stopping` maps to `running`, because a
 * machine that is still shutting down is still billing — which is exactly why this waits for
 * the status it wants rather than for "anything but the one I had".
 */
async function waitForStatus(id, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await (await api(`/api/v1/servers/${id}`)).json()
    if (row.status === want) return true
    await sleep(POLL_MS)
  }
  return false
}

async function login() {
  const res = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ password: ADMIN_PASSWORD }) })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

/* ------------------------------------------------------------------ the run */

async function main() {
  // FIRST, because it is the one check that can fail for free. Everything below this line either
  // creates a real server or is a step towards creating one.
  if (CLOUD === 'aws') await preflightAuditCredentials()
  // Same idea, one line: a GCP run with no project would write a config core refuses to parse,
  // twenty seconds later and with a message about a regex rather than about the missing variable.
  if (CLOUD === 'gcp' && !GCP_PROJECT) {
    throw new Error(
      'ROCKYSURF_E2E_GCP_PROJECT is not set. It names the CI-only Google Cloud project this run ' +
        'creates machines in; there is deliberately no default and gcloud\'s ambient project is not consulted.',
    )
  }
  // Same idea again for Azure, and it names BOTH variables rather than failing twice: the group
  // is not a detail of the subscription here, it is the scope the published role is granted at.
  if (CLOUD === 'azure' && (!AZURE_SUBSCRIPTION || !AZURE_RESOURCE_GROUP)) {
    throw new Error(
      'ROCKYSURF_E2E_AZURE_SUBSCRIPTION and ROCKYSURF_E2E_AZURE_RESOURCE_GROUP must both be set. ' +
        'They name the CI-only subscription and the resource group this run creates machines in — ' +
        'the group Rocky Surf does not create and the published operational role is scoped to. ' +
        'There is deliberately no default and no ambient `az` context is consulted.',
    )
  }

  await writeConfig()
  log(`=== ${CLOUD.toUpperCase()} milestone exit run — production stack — ${OFFERING} (${ARCH}) ===`)
  log(`binary ${BIN}`)
  log(`config ${configPath} (dataDir ${dataDir})`)

  await startCore()
  check(true, 'rockysurf booted from a real config file')
  await login()

  const providers = await (await api('/api/v1/providers')).json()
  const provider = providers.find((p) => p.id === CLOUD)
  check(!!provider, `composition root registered the real ${CLOUD} provider`, provider?.displayName)
  check(
    provider?.offerings?.some((o) => o.id === OFFERING),
    `${OFFERING} is offered`,
    `${provider?.offerings?.length ?? 0} offerings`,
  )
  const offering = provider?.offerings?.find((o) => o.id === OFFERING)
  check(offering?.arch === ARCH, `${OFFERING} is ${ARCH}`, offering?.arch)
  // `available: false` is a published fact about the location, not a stock reading, and GCP is
  // the only provider that reports it today: T2A exists in eight zones and c4a in about seventy,
  // so a leg pointed at a zone without the family is a create that fails twelve minutes from now
  // for a reason the catalogue already knew. Catch it here, for free.
  check(offering?.available !== false, `${OFFERING} is available in ${offering?.region ?? '?'}`)

  const packs = await (await api('/api/v1/surge-packs')).json()
  const pack = packs.find((p) => p.packId === 'ai-coding-agents') ?? packs[0]
  check(!!pack, 'a pack is available to install', pack?.packId)

  let serverId
  try {
    /* ---- create, through the real API ---- */
    const created = await api('/api/v1/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: `e2e-${CLOUD}-${Date.now().toString(36)}`,
        size: 'small',
        provider: CLOUD,
        offeringId: OFFERING,
        arch: ARCH,
        packId: pack.packId,
        ...(pack.requiresRepos ? { repositories: ['https://github.com/octocat/Hello-World.git'] } : {}),
        ...(pack.requiresRdp ? { rdpPassword: 'e2e-desktop-password' } : {}),
      }),
    })
    const body = await created.json()
    check(created.status === 201, 'POST /api/v1/servers created a server', `${created.status} ${body.error ?? ''}`)
    if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(body)}`)
    serverId = body.serverId
    recordCreatedServer(serverId)
    log(`server ${serverId}`)

    /* ---- bootstrap to ready ---- */
    const deadline = Date.now() + READY_TIMEOUT_MS
    let server = body
    let lastStep
    while (Date.now() < deadline) {
      server = await (await api(`/api/v1/servers/${serverId}`)).json()
      if (server.provisioningStep !== lastStep) {
        lastStep = server.provisioningStep
        log(`  status=${server.status} step=${server.provisioningStep ?? '-'} ip=${server.publicIp ?? '-'}`)
      }
      if (server.status === 'running' && server.provisioningStep === 'ready') break
      if (server.status === 'failed') throw new Error(`provisioning failed: ${server.errorMessage}`)
      // A row that goes `terminated` while provisioning is the WORST outcome this run can
      // find, not a reason to keep waiting: core has stopped tracking a machine that may still
      // be running and billing, and `terminate()` on a terminated row is a no-op, so the
      // script's own cleanup will not save it either. Stop immediately and say so — this is
      // exactly what the eventual-consistency bug in the AWS provider did (gyp1.4).
      if (server.status === 'terminated') {
        throw new Error(
          `server went TERMINATED while provisioning — check the cloud for a live instance ` +
            `tagged server-id=${serverId} before trusting this cleanup`,
        )
      }
      await sleep(POLL_MS)
    }
    check(server.status === 'running', 'server reached running', `status=${server.status}`)
    check(server.provisioningStep === 'ready', 'push bootstrap reported ready', `step=${server.provisioningStep}`)
    check(!!server.publicIp, 'server has a public address', server.publicIp)

    /* ---- claude --version over SSH, using the key the API hands out ---- */
    const keyRes = await api(`/api/v1/servers/${serverId}/ssh-key`)
    check(keyRes.status === 200, 'private key downloadable from the API', String(keyRes.status))
    const keyPath = join(workDir, 'id_ed25519')
    writeFileSync(keyPath, await keyRes.text(), { mode: 0o600 })
    chmodSync(keyPath, 0o600)

    const ssh = spawnSync(
      'ssh',
      [
        '-i', keyPath,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${join(workDir, 'known_hosts')}`,
        '-o', 'ConnectTimeout=20',
        `${server.sshUser ?? 'rocky'}@${server.publicIp}`,
        // `-ic`, an INTERACTIVE shell, because that is what a human who SSHes in gets, and it
        // is the only kind that reads ~/.bashrc to the end. Ubuntu's stock ~/.bashrc returns
        // early for non-interactive shells, so `bash -lc` never sees the PATH lines the pack
        // appends — it would report "claude: command not found" for a box that is perfectly
        // set up for the person who will actually use it.
        'bash -ic "claude --version && node --version && dpkg --print-architecture"',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )
    // Assertions read STDOUT only. An interactive shell with no tty writes "no job control in
    // this shell" to stderr, which is noise, not a result — reporting it beside a PASS makes a
    // healthy run look broken to whoever reads the nightly log.
    const out = (ssh.stdout ?? '').trim().split('\n').filter(Boolean)
    const detail = (line) => line ?? (ssh.stderr ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
    check(/\d+\.\d+\.\d+/.test(ssh.stdout ?? ''), 'claude --version over SSH', detail(out[0]))
    check((ssh.stdout ?? '').includes(ARCH), `box architecture is ${ARCH}`, detail(out.at(-1)))

    /* ---- stop / start, both clouds support it ---- */
    if (provider.capabilities.stop) {
      // The address BEFORE the stop, so `ipStableAcrossStop` can be checked rather than assumed
      // (rockysurf-eanp). That flag was carried as measured on Hetzner for months on the
      // strength of the rest of the column being measured — and nothing in this script or in any
      // committed transcript had ever re-read the address after a restart. Captured here rather
      // than derived from `previousIp` afterwards, because core only stamps `previousIp` when the
      // address CHANGED: reading it back would prove the stable case by its own absence.
      const addressBeforeStop = (await (await api(`/api/v1/servers/${serverId}`)).json()).publicIp
      // `stop` answers with what the PROVIDER has reached, not with the request being accepted
      // (rockysurf-55fx.15). On Hetzner that is `stopped` in this very response; on EC2 it is
      // still `running`, because an instance in `stopping` is up and billing. Both are correct,
      // so the assertion is the one thing true of both clouds: the row did not lie.
      const stopped = await (await api(`/api/v1/servers/${serverId}/stop`, { method: 'POST' })).json()
      check(
        stopped.status === 'stopped' || stopped.status === 'running',
        'stop accepted, status is provider-confirmed',
        `status=${stopped.status}`,
      )

      // WAIT FOR THE STOP TO BE REAL BEFORE STARTING. This is what any client does, and it is
      // now what the API rewards: a start attempted mid-`stopping` is refused with a 409 saying
      // so, rather than surfacing EC2's IncorrectInstanceState.
      const settled = await waitForStatus(serverId, 'stopped', 3 * 60_000)
      check(settled, 'instance actually reached stopped before start was attempted')

      const started = await (await api(`/api/v1/servers/${serverId}/start`, { method: 'POST' })).json()
      // Symmetrically, this can legitimately still say `stopped`: EC2 keeps answering `stopped`
      // for a beat after it accepts StartInstances, and core no longer papers over that with an
      // optimistic `running` it has to retract. The assertion is that the server COMES BACK.
      check(started.status !== undefined, 'start accepted', `status=${started.status}`)
      check(await waitForStatus(serverId, 'running', 3 * 60_000), 'server came back up after start')
      /*
       * WHAT THE MATRIX CLAIMS, CHECKED (rockysurf-eanp).
       *
       * Both readings are asserted, not just the unstable one. The old code logged the new
       * address when the flag was `false` and did nothing at all when it was `true` — so the
       * claim that costs a user something, "your box keeps its address", was the one nothing
       * watched. A cloud that changes this behaviour should turn the nightly red, because at
       * that moment docs/providers/capability-matrix.md has become wrong.
       */
      const after = await (await api(`/api/v1/servers/${serverId}`)).json()
      if (provider.capabilities.ipStableAcrossStop) {
        check(
          Boolean(after.publicIp) && after.publicIp === addressBeforeStop,
          'address survived the restart, as ipStableAcrossStop claims',
          `${addressBeforeStop} -> ${after.publicIp ?? '-'}`,
        )
      } else {
        // `false` promises nothing either way. EC2 releases the address on every stop and
        // hands out a fresh one, but GCE releases an ephemeral address and frequently hands
        // the SAME one back seconds later — the first real GCP power cycle (2026-08-26, run
        // 33002562621) came back on its own address and this check, then written as "must
        // change", turned a correct run red. What `false` actually claims is the breadcrumb:
        // the box comes back with an address, and IF it moved, core recorded where from.
        const moved = after.publicIp !== addressBeforeStop
        check(
          Boolean(after.publicIp) && (!moved || after.previousIp === addressBeforeStop),
          moved
            ? 'address moved across the restart and core recorded the previous one'
            : 'address came back unchanged, which ipStableAcrossStop=false permits',
          `${addressBeforeStop} -> ${after.publicIp ?? '-'} (previous ${after.previousIp ?? '-'})`,
        )
      }
    }
  } finally {
    /* ---- terminate, always ---- */
    if (serverId) {
      log('terminating')
      try {
        const res = await api(`/api/v1/servers/${serverId}/terminate`, { method: 'POST' })
        check(res.ok, 'terminate accepted', String(res.status))
      } catch (err) {
        check(false, 'TERMINATE FAILED — RESOURCE MAY BE LEAKED', String(err))
      }
    }
  }

  /* ---- reconciler-grade zero-orphan audit ---- */
  log('zero-orphan audit (reconciler semantics)')
  const audit = await auditManagedResources(serverId)
  check(audit.mine.length === 0, 'THIS RUN left nothing behind', audit.mine.join(', '))
  check(audit.ownershipValid, 'every managed resource carries a valid ownership', audit.ownershipNote)
  // NOT A CHECK, AND THAT IS THE FIX (rockysurf-rkh3). `listManaged()` answers for the whole
  // account, because that is what a reconciler needs to see — so anything a person is running
  // on their own Rocky Surf against this same project lands in this list too. Failing on it
  // meant the nightly went red whenever somebody used their own cloud, and, far worse, taught
  // the sweep to treat their machine as garbage. It is printed because it is worth knowing what
  // else is out there; it is not a verdict on this run.
  if (audit.foreign.length > 0) log(`  not this run's, left alone: ${audit.foreign.join(', ')}`)
  if (CLOUD === 'hetzner') {
    check(audit.mineSshKeys.length === 0, 'this run\'s ssh-key objects were reaped with its server', audit.mineSshKeys.join(', '))
  } else if (CLOUD === 'azure') {
    // TWO shared resources, not one, and both are asserted (gh issue #170). Azure's analogue of
    // AWS's shared security group is a PAIR — the virtual network and the network security group
    // — created on the first launch into an empty group and adopted forever after, reported
    // `shared` so a reconciler never reaps them: deleting either detaches the network from, or
    // closes port 22 on, every running box at once. A first run in a fresh resource group is also
    // the only thing that exercises the create half of `virtualNetworks/write` and
    // `networkSecurityGroups/write`, so this is the check that says those actions are really in
    // the published role.
    check(audit.shared.length >= 2, 'the shared vnet and NSG survive, as designed', audit.shared.join(', '))
    // No separate disk assertion, and unlike GCP that is not because the disk is invisible here:
    // `listManaged()` lists the whole resource group, disks included. It is because a disk that
    // outlived its VM has lost the `managedBy` it was attributed through, so the name-prefix rule
    // in auditManagedResources() is what keeps it in `mine` — see the comment there.
  } else if (CLOUD === 'gcp') {
    // The GCE analogue of AWS's shared security group: ONE firewall rule per project, matching
    // instances by network tag, reported `shared` so a reconciler never reaps it — deleting it
    // closes port 22 on every running box at once. A first run in a fresh project is the only
    // one that exercises `firewalls.create`, so this is also the check that says the published
    // role's `compute.networks.updatePolicy` is really there.
    check(audit.shared.length >= 1, 'the shared SSH firewall rule survives, as designed', audit.shared.join(', '))
    // No disk assertion here, and that is deliberate rather than an omission: the boot disk is
    // created with `autoDelete: true`, so it goes with the instance, and `compute.disks.list` is
    // absent from the published role on purpose — an orphan the credentials under test cannot SEE
    // would be an orphan this audit calls clean. The workflow's sweep step reads disks as the
    // operator identity instead, which is where the AWS leg puts the same reasoning.
  } else {
    check(audit.shared.length >= 1, 'the shared SSH security group survives, as designed', audit.shared.join(', '))
    check(audit.volumes.length === 0, 'no EBS volumes survived termination', audit.volumes.join(', '))
  }

  log('--- server log tail ---')
  for (const line of serverStderr.trim().split('\n').slice(-6)) log(`  ${line}`)
}

/**
 * Ask the provider what it still owns, the way the reconciler does.
 *
 * Imported directly here rather than driven through core, because the reconciler's input IS
 * `listManaged()` and this run has to check the shape of what it returns — specifically that
 * `ownership` is populated, since a reconciler that trusts a missing field would either orphan
 * Hetzner's owned keys or delete AWS's shared group out from under running servers.
 */
async function auditManagedResources(runServerId) {
  const result = {
    shared: [],
    volumes: [],
    ownershipValid: true,
    ownershipNote: '',
    /** Still present AND attributable to the server this run created: the only failure. */
    mine: [],
    /** The ssh-key half of `mine`, which is the half Hetzner's terminate is asked about. */
    mineSshKeys: [],
    /** Still present, attributable to another server or to nothing: reported, never acted on. */
    foreign: [],
  }
  const deadline = Date.now() + GONE_TIMEOUT_MS

  /**
   * When each resource was first seen, so a thing that APPEARS during the teardown poll can be
   * told from a thing that refuses to leave. They look identical in a list of ids and mean
   * opposite things: the first is something creating resources while we tear down, the second
   * is a delete that did not take. Run 31615322014 spent 618 seconds looking like the second
   * and was the first, and there was no way to tell from the log.
   */
  const firstSeen = new Map()
  let poll = 0

  /** `117001639(srv-d9552a55b12d)` — the attribution the reconciler already has, printed. */
  const describe = (r) => {
    const who = r.serverId ?? 'unattributed'
    const late = firstSeen.get(r.providerNativeId) > 0 ? ' APPEARED-DURING-AUDIT' : ''
    return `${r.providerNativeId}(${who})${late}`
  }

  for (;;) {
    const provider = await buildProviderDirectly()
    const managed = await provider.listManaged()
    for (const r of managed) {
      if (!firstSeen.has(r.providerNativeId)) firstSeen.set(r.providerNativeId, poll)
    }
    poll++

    const bad = managed.filter((r) => r.ownership !== 'server-owned' && r.ownership !== 'shared')
    if (bad.length > 0) {
      result.ownershipValid = false
      result.ownershipNote = bad.map((r) => `${r.kind}/${r.providerNativeId}=${r.ownership}`).join(', ')
    }

    const leaked = managed.filter((r) => r.ownership === 'server-owned')
    // `undefined === undefined` would make every unattributed resource in the account this
    // run's, on the one path where this run demonstrably created nothing.
    const mine = runServerId
      ? leaked.filter((r) => r.serverId === runServerId || azureNameBelongsTo(runServerId, r))
      : []

    result.shared = managed.filter((r) => r.ownership === 'shared').map((r) => `${r.kind}/${r.providerNativeId}`)
    result.mine = mine.map(describe)
    result.mineSshKeys = mine.filter((r) => r.kind === 'ssh-key').map(describe)
    // The complement of `mine`, rather than a second predicate that could disagree with it: a
    // resource attributed by name would otherwise be reported as this run's leak AND as somebody
    // else's, in the same log.
    result.foreign = leaked.filter((r) => !mine.includes(r)).map(describe)

    if (CLOUD === 'aws') result.volumes = await rawAwsVolumes(runServerId)

    // WAITING ONLY ON WHAT THIS RUN CAN STILL AFFECT. Somebody else's server is not going to
    // disappear because we watched it for another eight minutes — the old loop waited out the
    // full deadline on exactly that, then reported it as our leak.
    const settled = result.mine.length === 0 && result.volumes.length === 0
    if (settled || Date.now() >= deadline) return result
    log(`  still present: ${[...result.mine, ...result.volumes].join(', ')}`)
    await sleep(POLL_MS)
  }
}

/**
 * AZURE ONLY: attribution by resource NAME, for the one orphan a tag cannot name (gh issue #170).
 *
 * Azure does not copy a VM's tags onto the OS disk it creates from an image, so the provider
 * attributes a disk through `managedBy` — the resource id of the VM it is attached to. That works
 * right up until the moment it matters: once the VM is deleted, a disk the `deleteOption` cascade
 * failed to reap has no tag AND no `managedBy`, so `listManaged()` reports it as an owned
 * resource nobody can attribute, and this audit would file it under "not this run's, left alone"
 * — a billable leak, reported as somebody else's business, on the one cloud where terminate is a
 * cascade rather than a call per resource.
 *
 * The names close that gap exactly, because the provider derives every one of them from the
 * server id: the VM is `<serverId>`, and its three companions are `<serverId>-nic`,
 * `<serverId>-ip` and `<serverId>-osdisk`. So a name that is the server id or the server id plus
 * a `-suffix` is this run's, and nothing else can collide with it — a second run's server id is a
 * different random id, not a suffix of this one.
 */
function azureNameBelongsTo(runServerId, resource) {
  if (CLOUD !== 'azure') return false
  const name = String(resource.providerNativeId).split('/').pop() ?? ''
  return name === runServerId || name.startsWith(`${runServerId}-`)
}

async function buildProviderDirectly() {
  if (CLOUD === 'hetzner') {
    const { hetznerProviderFactory } = await import(`${REPO}/packages/provider-hetzner/dist/index.js`)
    return hetznerProviderFactory.createProvider(
      hetznerProviderFactory.configSchema.parse({ token: hetznerToken(), location: 'fsn1' }),
    )
  }
  if (CLOUD === 'gcp') {
    const { gcpProviderFactory } = await import(`${REPO}/packages/provider-gcp/dist/index.js`)
    return gcpProviderFactory.createProvider(
      gcpProviderFactory.configSchema.parse({
        projectId: GCP_PROJECT,
        zone: GCP_ZONE,
        // The audit only reads, and the credential is the ambient ADC chain — the same one the
        // run itself used. A CIDR is required by the schema, deliberately, so nobody creates a
        // server without deciding who may reach it; this one authorizes nothing.
        sshAllowedCidr: '127.0.0.1/32',
      }),
    )
  }
  if (CLOUD === 'azure') {
    const { azureProviderFactory } = await import(`${REPO}/packages/provider-azure/dist/index.js`)
    return azureProviderFactory.createProvider(
      azureProviderFactory.configSchema.parse({
        subscriptionId: AZURE_SUBSCRIPTION,
        resourceGroup: AZURE_RESOURCE_GROUP,
        location: AZURE_LOCATION,
        // The audit only reads, through the same federated credential the run itself used. A
        // CIDR is required by the schema, deliberately, so nobody creates a server without
        // deciding who may reach it; this one authorizes nothing.
        sshAllowedCidr: '127.0.0.1/32',
        // The same reason the config file above sets it: `az` on this runner is logged in as the
        // CI-only sweep identity, and an audit that silently ran as that identity would be an
        // audit of a different principal than the one under test.
        allowAzureCli: false,
      }),
    )
  }
  const { awsProviderFactory } = await import(`${REPO}/packages/provider-aws/dist/index.js`)
  const { profile } = resolveRunCredentials(process.env)
  return awsProviderFactory.createProvider(
    awsProviderFactory.configSchema.parse({
      region: AWS_REGION,
      ...(profile ? { profile } : {}),
      // The audit only reads. A CIDR is required by the schema — deliberately, so nobody
      // creates a server without deciding who may reach it — and this one authorizes nothing.
      sshAllowedCidr: '127.0.0.1/32',
    }),
  )
}

/**
 * The AWS SDK, resolved FROM the provider package rather than guessed at.
 *
 * Under pnpm the real path is a content-addressed store directory, so a hand-built
 * `node_modules/...` path is a guess that happens to be wrong, and the bare-specifier fallback
 * cannot work either because the repo root does not depend on the AWS SDK. This asks node the same
 * question the provider asks.
 */
async function ec2Sdk() {
  const require = createRequire(join(REPO, 'packages/provider-aws/package.json'))
  return import(pathToFileURL(require.resolve('@aws-sdk/client-ec2')).href)
}

/**
 * WHOSE CREDENTIALS THE VOLUME AUDIT USES — decided ONCE, before the run spends anything.
 *
 * THE CREDENTIALS ARE NOT OPTIONAL. This machine's default AWS identity is a read-only user in an
 * entirely different account, so a client built without any is one that silently audits the wrong
 * account and reports "no volumes" about somebody else's — worse than failing.
 *
 * AND THEY ARE NOT THE RUN'S (rockysurf-gyp1.5, rockysurf-ufwn). `ec2:DescribeVolumes` is not a
 * call the provider makes, so it is deliberately absent from the published IAM policy; the run
 * under test cannot make it, and should not — an orphan the credentials under test cannot SEE
 * would otherwise be an orphan this audit calls clean. See ./aws-audit-credentials.mjs for the two
 * ways the operator's credentials arrive and what strict mode demands of them.
 *
 * Called from main() before the first server exists, on purpose: the failure this guards against
 * used to surface as an UnauthorizedOperation twelve minutes into a clean lifecycle, reported as
 * `RESULT: FAIL — unhandled error` and blaming the wrong thing entirely.
 */
let auditCredentials
async function preflightAuditCredentials() {
  try {
    auditCredentials = resolveAuditCredentials(process.env)
    log(`orphan volume audit reads with ${auditCredentials.describe}`)
    if (!auditCredentials.strict) return

    const { EC2Client } = await ec2Sdk()
    // Resolved, compared to each other, and never logged.
    const accessKeyId = async (clientConfig, whose) => {
      const client = new EC2Client({ region: AWS_REGION, ...clientConfig })
      try {
        return (await client.config.credentials()).accessKeyId
      } catch (err) {
        throw new AuditCredentialError(`could not resolve the ${whose} AWS credentials: ${err.message}`)
      } finally {
        client.destroy()
      }
    }
    assertDistinctPrincipals(
      await accessKeyId(auditCredentials.clientConfig, 'orphan audit'),
      await accessKeyId(resolveRunCredentials(process.env).clientConfig, "run's own"),
    )
    log('orphan audit credentials confirmed distinct from the identity under test')
  } catch (err) {
    if (!(err instanceof AuditCredentialError)) throw err
    log('ORPHAN AUDIT CREDENTIALS ARE MISCONFIGURED — refusing to start:')
    log(`  ${err.message}`)
    for (const line of err.remediation ?? []) log(`  ${line}`)
    throw err
  }
}

/**
 * Behind the interface, because listManaged() does not walk volumes.
 *
 * The credentials were decided and vetted by the preflight, which main() runs before anything
 * exists to audit — so this reads that decision rather than making it again per poll.
 */
async function rawAwsVolumes(runServerId) {
  if (!runServerId) return []
  const { DescribeVolumesCommand, EC2Client } = await ec2Sdk()
  const ec2 = new EC2Client({ region: AWS_REGION, ...auditCredentials.clientConfig })
  const res = await ec2.send(
    // `server-id` RATHER THAN `managed-by` (rockysurf-rkh3): RunInstances tags the volume with
    // everything it tags the instance with, so the narrow filter works — and `managed-by` alone
    // would report an operator's own Rocky Surf volume as this run's orphan, which is the
    // account-wide-label mistake that cost somebody a live server on the Hetzner leg.
    new DescribeVolumesCommand({ Filters: [{ Name: 'tag:server-id', Values: [runServerId] }] }),
  )
  return (res.Volumes ?? []).map((v) => `${v.VolumeId}=${v.State}`)
}

main()
  .then(async () => {
    await stopCore()
    log(failures === 0 ? `RESULT: PASS — ${CLOUD} production lifecycle, zero orphans` : `RESULT: FAIL — ${failures} check(s)`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(async (err) => {
    await stopCore()
    log('RESULT: FAIL — unhandled error')
    console.error(err)
    process.exit(1)
  })
