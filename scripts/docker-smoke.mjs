#!/usr/bin/env node
/**
 * The container smoke test (rockysurf-ftl9.4).
 *
 * Answers the two questions the packaging acceptance criteria ask, by doing them rather than
 * by inspecting the Dockerfile:
 *
 *   1. does `docker compose up` from a clean checkout reach the first-run wizard?
 *   2. does the data survive a container restart?
 *
 * Neither is provable by reading YAML. The first depends on a config file existing at all (the
 * entrypoint seeds one), on the SPA having been copied where core looks for it, and on a
 * non-root process being able to write the volume. The second depends on the volume actually
 * holding the config file, the database AND the master key — a restart that silently
 * regenerated `secret.key` would still serve a login page, and every stored secret would be
 * quietly unreadable. So the test makes the wizard's one write — switching a cloud on, which
 * lands in the volume's config file (issue #280: the wizard stores no credentials, so there is
 * no credential to round-trip) — and after each restart checks that the enable survived, the
 * ORIGINAL password still logs in, and `secret.key` is byte-identical.
 *
 * ISOLATION. Runs under a compose project name and a host port that belong to THIS PROCESS —
 * the project is suffixed with the pid and the port comes from the OS — and tears down with
 * `down -v` on every exit path. Both halves matter and the project name matters more: teardown
 * deletes volumes, so a shared name means the first run to finish destroys the other's data.
 * It must never be able to delete the volume of a Rocky Surf someone is actually using
 * (rockysurf-rt80).
 *
 * Usage: node scripts/docker-smoke.mjs [--keep]
 *   --keep   leave the stack up after a successful run, for poking at by hand
 *
 * Environment:
 *   ROCKYSURF_SMOKE_PROJECT   pin the compose project name (default: rockysurf-smoke-<pid>)
 *   ROCKYSURF_SMOKE_PORT      pin the host port (default: one the OS says is free)
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * A PROJECT NAME AND A PORT THIS RUN OWNS ALONE (rockysurf-rt80).
 *
 * Both used to be constants — project `rockysurf-smoke`, port 3999 — and on a machine running
 * more than one thing that produced three separate collisions in a single session: a run whose
 * containers were adopted by a second run, a `up` that failed because another process held
 * 3999, and a container left in `Created` state under the shared name for the next run to clean
 * up by hand. The dangerous half is the project name rather than the port: teardown is
 * `down -v`, so the first run to finish deletes the other's volume, which is a failure that
 * looks like data loss rather than like a conflict.
 *
 * The pid makes the default unique per invocation, so a concurrent run cannot name the same
 * project and `down -v` can only ever reach containers this process started. An operator who
 * WANTS a stable name — to inspect a stack afterwards, or in CI — sets the variable, and then
 * cleaning that project is precisely what they asked for.
 */
const PROJECT = process.env['ROCKYSURF_SMOKE_PROJECT'] ?? `rockysurf-smoke-${process.pid}`
const KEEP = process.argv.includes('--keep')

/** Resolved in `main`: an OS-assigned free port unless the operator named one. */
let HOST_PORT = Number(process.env['ROCKYSURF_SMOKE_PORT'] ?? 0)
let BASE = ''

/**
 * A free port from the OS, rather than a number we hope is free.
 *
 * The gap between closing this probe and Docker binding it is a race in principle. It is a much
 * smaller one than a fixed 3999, which on this repository's own machines is also what
 * `bin.e2e.test.ts` and a hand-started core reach for.
 */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const steps = []
let stackUp = false

function step(name, detail) {
  steps.push({ name, detail })
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}

function compose(args, options = {}) {
  const result = spawnSync('docker', ['compose', '-p', PROJECT, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ROCKYSURF_HOST_PORT: String(HOST_PORT) },
    ...options,
  })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker compose ${args.join(' ')} failed (${result.status})\n${result.stderr ?? ''}`)
  }
  return result
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll `/health` from the HOST, not from inside the container.
 *
 * Deliberate: it proves the published port works and that core is listening on an interface
 * reachable from outside the container, which an in-container check would not.
 */
async function waitForHealth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await sleep(1000)
  }
  const logs = compose(['logs', '--no-color', '--tail', '40'], { allowFailure: true })
  throw new Error(`${BASE}/health never came up (${lastError})\n\n${logs.stdout ?? ''}${logs.stderr ?? ''}`)
}

/** The generated admin password, from the once-only banner on stderr. */
function adminPasswordFromLogs() {
  const logs = compose(['logs', '--no-color']).stdout
  const lines = logs.split('\n')
  const marker = lines.findIndex((line) => line.includes('your admin password is'))
  if (marker === -1) throw new Error(`no first-boot password banner in the logs:\n${logs}`)
  // Banner shape: marker, blank line, the indented password. Take the next non-empty line and
  // strip the compose log prefix ("rockysurf-1  | ") the container name adds.
  for (const line of lines.slice(marker + 1)) {
    const value = line.replace(/^\S+\s*\|\s*/, '').trim()
    if (value) return value
  }
  throw new Error(`the password banner had no password after it:\n${logs}`)
}

function countFirstBootBanners() {
  return compose(['logs', '--no-color']).stdout.split('\n').filter((l) => l.includes('your admin password is')).length
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

async function login(password) {
  const result = await api('/api/v1/auth/login', { method: 'POST', body: { password } })
  if (result.status !== 200) throw new Error(`login failed: HTTP ${result.status} ${result.text}`)
  const token = result.json?.data?.token ?? result.json?.token
  if (!token) throw new Error(`login returned no token: ${result.text}`)
  return token
}

/** Unwrap the success envelope, whatever shape it has. */
function payload(result) {
  return result.json?.data ?? result.json
}

function teardown() {
  if (!stackUp) return
  compose(['down', '-v', '--remove-orphans'], { allowFailure: true, stdio: 'ignore' })
}

async function main() {
  if (!HOST_PORT) HOST_PORT = await freePort()
  BASE = `http://127.0.0.1:${HOST_PORT}`
  console.log(`docker smoke test — project ${PROJECT}, host port ${HOST_PORT}\n`)

  // A leftover volume from an interrupted run would make "first boot" a lie. Safe to do
  // unconditionally now: the project name is this process's own unless somebody asked for a
  // shared one, and cleaning the one they named is what they asked for.
  compose(['down', '-v', '--remove-orphans'], { allowFailure: true, stdio: 'ignore' })

  console.log('building and starting…')
  compose(['up', '-d', '--build'], { stdio: 'inherit' })
  stackUp = true

  /* ------------------------------------------------- AC: reaches the first-run wizard */

  const health = await waitForHealth()
  step('the published port answers /health', `authMode ${(health?.data ?? health)?.authMode}`)

  const uid = execFileSync('docker', ['compose', '-p', PROJECT, 'exec', '-T', 'rockysurf', 'id', '-u'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ROCKYSURF_HOST_PORT: String(HOST_PORT) },
  }).trim()
  const user = execFileSync('docker', ['compose', '-p', PROJECT, 'exec', '-T', 'rockysurf', 'id', '-un'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ROCKYSURF_HOST_PORT: String(HOST_PORT) },
  }).trim()
  if (uid === '0') throw new Error('the container is running as root')
  step('runs as a non-root user', `uid ${uid} (${user})`)

  const index = await fetch(BASE)
  const html = await index.text()
  if (!index.ok || !html.includes('id="root"')) {
    throw new Error(`the SPA was not served at / (HTTP ${index.status}):\n${html.slice(0, 400)}`)
  }
  step('the SPA is served from the container', `${html.length} bytes of index.html`)

  const password = adminPasswordFromLogs()
  const token = await login(password)
  step('the generated admin password logs in', 'session issued')

  const setup = payload(await api('/api/v1/setup', { token }))
  if (setup?.complete !== false || setup?.needsProvider !== true) {
    throw new Error(`expected the first-run wizard state, got ${JSON.stringify(setup)}`)
  }
  step(
    'the first-run wizard is what a new install lands on',
    `complete=false, needsProvider=true, ${setup.providers.length} providers offered`,
  )

  /* --------------------------------------------------- AC: data survives a restart */

  // The wizard's one write (issue #280): switch a cloud on. It lands in the volume's config
  // file, which is one of the three files that must survive; the database is proven by the
  // original password still logging in, and the master key by `secret.key` staying identical.
  const enabled = await api('/api/v1/setup/providers/hetzner', { token, method: 'POST', body: {} })
  if (enabled.status !== 200) throw new Error(`enabling a cloud failed: HTTP ${enabled.status} ${enabled.text}`)
  step('a cloud is switched on through the wizard endpoint', 'providers.hetzner.enabled written into the volume')

  // And the same endpoint REFUSES a credential — the regression this release must never allow.
  const refused = await api('/api/v1/setup/providers/hetzner', { token, method: 'POST', body: { token: 'nope' } })
  if (refused.status !== 400 || !refused.text.includes('no longer accepts credentials')) {
    throw new Error(`the wizard endpoint accepted a credential: HTTP ${refused.status} ${refused.text}`)
  }
  step('the wizard endpoint refuses a credential', 'HTTP 400, in as many words')

  /** The master key file, hashed inside the container so nothing secret leaves it. */
  function secretKeyDigest() {
    return execFileSync(
      'docker',
      ['compose', '-p', PROJECT, 'exec', '-T', 'rockysurf', 'sha256sum', '/data/secret.key'],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ROCKYSURF_HOST_PORT: String(HOST_PORT) } },
    ).split(/\s+/)[0]
  }
  const keyDigest = secretKeyDigest()

  /** The volume's three lives: the enable in the config file, the login row, the master key. */
  async function assertDataIntact(what) {
    const freshToken = await login(password)
    const state = payload(await api('/api/v1/setup', { token: freshToken }))
    const hetzner = state?.providers?.find((p) => p.id === 'hetzner')
    if (hetzner?.enabled !== true) {
      throw new Error(`the enabled cloud did not survive ${what}: ${JSON.stringify(hetzner)}`)
    }
    const digest = secretKeyDigest()
    if (digest !== keyDigest) {
      throw new Error(`secret.key changed across ${what} — the master key did not survive`)
    }
  }

  compose(['restart'], { stdio: 'ignore' })
  await waitForHealth()
  if (countFirstBootBanners() !== 1) {
    throw new Error('the restart announced a first boot again — the data directory did not survive')
  }
  await assertDataIntact('a restart')
  step('a restart keeps the data', 'same password, cloud still enabled, same master key, no second first-boot banner')

  /**
   * NOW THE ONE THAT PROVES THE VOLUME.
   *
   * `restart` keeps the container's writable layer, so everything above would pass just as
   * happily if `dataDir` pointed at some path that is not mounted at all — which is exactly the
   * mistake this test is supposed to catch. `--force-recreate` throws the container away and
   * builds a new one from the image, so the only thing carried across is the volume.
   *
   * The log assertion inverts here for a good reason: a recreated container starts with an
   * empty log, and a fresh data directory would make it print the first-boot password banner
   * again. Zero banners plus a successful login with the ORIGINAL password is the pair that
   * can only happen if `/data` came back.
   */
  compose(['up', '-d', '--force-recreate'], { stdio: 'ignore' })
  await waitForHealth()
  if (countFirstBootBanners() !== 0) {
    throw new Error('the recreated container announced a first boot — it did not find the volume')
  }
  await assertDataIntact('the container being recreated')
  step('a recreated container finds its data', 'new container, empty writable layer, same volume')

  console.log(`\n${steps.length} checks passed.`)
  if (KEEP) {
    console.log(`\nStack left running: ${BASE}  (docker compose -p ${PROJECT} down -v to clean up)`)
    stackUp = false
  }
}

main()
  .then(() => {
    teardown()
    process.exit(0)
  })
  .catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
    teardown()
    process.exit(1)
  })
