#!/usr/bin/env node
/**
 * dry-run-provision — run a provider's `provision()` against the REAL cloud with the billable
 * create refused, and log every request it made and what the cloud said.
 *
 * WHY THIS EXISTS. A provider's unit suite runs against a fake of the cloud, and a fake asserts
 * only that the provider does what its author believed the cloud does. The first live run of a
 * provider built with this skill failed on a precondition the fake did not model (a firewall
 * naming a tag nobody had created), after seventy-four green tests. A personal provider gets no
 * nightly real-cloud leg, so this is the cheap way its author — and whoever installs it — sees
 * the real API's answer to every write in the provision chain, without paying for a machine.
 *
 * HOW IT WORKS. `globalThis.fetch` is replaced BEFORE the provider package is imported, so a
 * transport that captures `fetch` at import time and one that takes it at construction time
 * both go through the interceptor. Then the factory is driven exactly the way Rocky Surf's
 * composition root drives it: `configSchema.parse` (the credential taken from `credentialEnv`
 * when the config field is empty, nothing stored anywhere), `createProvider`,
 * `validateCredentials`, `listOfferings`, `validateSpec`, `provision`.
 *
 * THE POLICY. Reads (GET/HEAD/OPTIONS) always pass. A write (POST/PUT/PATCH/DELETE) is REFUSED —
 * answered locally with a 422 and never sent — unless its `METHOD /path` matches an `--allow`
 * pattern, and is refused regardless when it matches a `--refuse` pattern. With no `--allow` at
 * all nothing is written, which is the right first run: it shows the first write and its body.
 * Then allow the non-billable objects (a firewall, a key) one pattern at a time, and never the
 * instance create. The instance create is what `--refuse` is for: naming it makes the refusal
 * explicit rather than a consequence of forgetting to allow it.
 *
 * EXIT CODES.
 *   0  provision() threw AFTER a refused write — the chain was walked to the billable create
 *   1  provision() threw BEFORE any write was refused — a precondition failed; read the log
 *   2  provision() RESOLVED — nothing was refused, so a billable instance may now exist
 *   3  the script itself could not run (bad arguments, package not found, config rejected)
 *
 * Zero dependencies; Node 24. The only per-provider knowledge is what you pass in flags.
 *
 * USAGE
 *   node dry-run-provision.mjs --package <dir-or-entry> [options]
 *
 *   --package <p>        the provider package: a directory with a package.json, or its entry file
 *   --config <file>      JSON with the provider's config section (no `enabled`, no `package`)
 *   --config-json <s>    the same, inline
 *   --allow <regex>      a write to let through, matched against "METHOD /path" (repeatable)
 *   --refuse <regex>     a write to refuse even if allowed (repeatable) — name the instance create
 *   --refuse-status <n>  the HTTP status a refused write is answered with (default 422)
 *   --offering <id>      the offering to provision; default: the first available one for --arch
 *   --arch <a>           amd64 (default) or arm64
 *   --server-id <id>     hostname-safe; default dryrun-<hhmmss>
 *   --managed-by <s>     the managed-by tag value; default config.managedBy, then "rockysurf"
 *   --ssh-key <file>     an OpenSSH public key to hand the spec; default: a throwaway ed25519 key
 *   --user-data <file>   user-data to hand the spec; default: a two-line #cloud-config marker
 *   --body-max <n>       characters of a body to print before truncating (default 4000)
 *   --help
 *
 * The credential is read from the environment under the names the factory declares in
 * `credentialEnv`, the same way Rocky Surf reads it. Export it in the shell that runs this and
 * nowhere else; the script never prints request headers.
 */

import { readFileSync, statSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { resolve, join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function usage(exitCode) {
  const header = readFileSync(new URL(import.meta.url), 'utf8').split('\n')
  const start = header.findIndex((l) => l.includes(' * USAGE'))
  const end = header.findIndex((l, i) => i > start && l.startsWith(' */'))
  console.error(header.slice(start, end).map((l) => l.replace(/^ \* ?/, '')).join('\n'))
  process.exit(exitCode)
}

function parseArgs(argv) {
  const out = { allow: [], refuse: [], refuseStatus: 422, arch: 'amd64', bodyMax: 4000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) fail(3, `${a} needs a value`)
      return argv[++i]
    }
    switch (a) {
      case '--package': out.package = next(); break
      case '--config': out.config = next(); break
      case '--config-json': out.configJson = next(); break
      case '--allow': out.allow.push(next()); break
      case '--refuse': out.refuse.push(next()); break
      case '--refuse-status': out.refuseStatus = Number(next()); break
      case '--offering': out.offering = next(); break
      case '--arch': out.arch = next(); break
      case '--server-id': out.serverId = next(); break
      case '--managed-by': out.managedBy = next(); break
      case '--ssh-key': out.sshKey = next(); break
      case '--user-data': out.userData = next(); break
      case '--body-max': out.bodyMax = Number(next()); break
      case '--help': case '-h': usage(0); break
      default: fail(3, `unknown argument ${a} (try --help)`)
    }
  }
  if (!out.package) fail(3, '--package is required (try --help)')
  if (!Number.isInteger(out.refuseStatus) || out.refuseStatus < 400 || out.refuseStatus > 599) {
    fail(3, '--refuse-status must be a 4xx or 5xx status')
  }
  if (out.arch !== 'amd64' && out.arch !== 'arm64') fail(3, '--arch must be amd64 or arm64')
  return out
}

function fail(code, message) {
  console.error(`dry-run-provision: ${message}`)
  process.exit(code)
}

/**
 * A pattern that would let through a write to a path it does not name is not an allow-list
 * entry, it is a hole. `.*`, `POST`, `^POST /` and the like all match the probe; a pattern that
 * names a collection (`POST /v2/firewalls`) does not.
 */
function compilePatterns(list, flag) {
  return list.map((source) => {
    let re
    try {
      re = new RegExp(source)
    } catch (err) {
      fail(3, `${flag} '${source}' is not a valid regular expression: ${err.message}`)
    }
    if (flag === '--allow') {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        if (re.test(`${method} /dry-run-probe/nothing-is-called-this`)) {
          fail(3, `--allow '${source}' would let through every ${method}; name the collection it is for`)
        }
      }
    }
    return re
  })
}

// ---------------------------------------------------------------------------------------------
// The interceptor — installed before the package is imported
// ---------------------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
const allow = compilePatterns(args.allow, '--allow')
const refuse = compilePatterns(args.refuse, '--refuse')
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Every request, in order: { n, method, path, url, kind: 'read'|'passed'|'refused', status, ms, body?, response? } */
const log = []
const realFetch = globalThis.fetch

async function bodyTextOf(input, init) {
  const body = init?.body
  if (body === undefined || body === null) {
    if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
      try { return await input.clone().text() } catch { return undefined }
    }
    return undefined
  }
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8')
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8')
  if (typeof body === 'object' && typeof body.text === 'function') {
    try { return await body.text() } catch { return '<unreadable body>' }
  }
  return '<stream body>'
}

function pretty(text, max) {
  if (text === undefined) return undefined
  let shown = text
  try { shown = JSON.stringify(JSON.parse(text), null, 2) } catch { /* not JSON; print as is */ }
  return shown.length > max ? `${shown.slice(0, max)}\n… (${shown.length - max} more characters)` : shown
}

/** 'read' | 'passed' | 'refused', and for a refusal WHY: named by --refuse, or matched by no --allow. */
function decide(method, path) {
  const key = `${method} ${path}`
  if (READ_METHODS.has(method)) return { kind: 'read' }
  if (refuse.some((re) => re.test(key))) return { kind: 'refused', reason: 'refuse' }
  if (allow.some((re) => re.test(key))) return { kind: 'passed' }
  return { kind: 'refused', reason: 'unallowed' }
}

globalThis.fetch = async function interceptedFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
  let path = url
  try { path = new URL(url).pathname } catch { /* leave the raw string */ }
  const entry = { n: log.length + 1, method, path, url, ...decide(method, path) }
  log.push(entry)

  if (entry.kind !== 'read') entry.body = await bodyTextOf(input, init)

  if (entry.kind === 'refused') {
    entry.status = args.refuseStatus
    entry.ms = 0
    entry.response = JSON.stringify({
      id: 'dry_run_refused',
      message: `refused by dry-run-provision: ${method} ${path} was not sent to the cloud`,
    })
    printEntry(entry)
    return new Response(entry.response, {
      status: args.refuseStatus,
      statusText: 'Refused By Dry Run',
      headers: { 'content-type': 'application/json' },
    })
  }

  const started = performance.now()
  let response
  try {
    response = await realFetch(input, init)
  } catch (err) {
    entry.status = 'network error'
    entry.ms = Math.round(performance.now() - started)
    entry.response = String(err?.message ?? err)
    printEntry(entry)
    throw err
  }
  entry.status = response.status
  entry.ms = Math.round(performance.now() - started)
  // The cloud's own words on a write, and on any read that failed — that is the point of the run.
  if (entry.kind === 'passed' || !response.ok) {
    try { entry.response = await response.clone().text() } catch { entry.response = '<unreadable response>' }
  }
  printEntry(entry)
  return response
}

function printEntry(e) {
  const tag = e.kind === 'read' ? 'read   ' : e.kind === 'passed' ? 'PASSED ' : 'REFUSED'
  const query = e.url.includes('?') ? e.url.slice(e.url.indexOf('?')) : ''
  console.log(`#${String(e.n).padStart(2)} ${tag} ${e.method} ${e.path}${query} → ${e.status}${e.ms ? ` (${e.ms} ms)` : ''}`)
  if (e.kind !== 'read' && e.body !== undefined) {
    console.log(indent('request body:', 4))
    console.log(indent(pretty(e.body, args.bodyMax), 6))
  }
  if (e.response !== undefined && e.response !== '' && (e.kind !== 'read' || typeof e.status !== 'number' || e.status >= 400)) {
    console.log(indent(e.kind === 'refused' ? 'answered locally with:' : 'the cloud answered:', 4))
    console.log(indent(pretty(e.response, args.bodyMax), 6))
  }
}

function indent(text, n) {
  const pad = ' '.repeat(n)
  return String(text).split('\n').map((l) => pad + l).join('\n')
}

// ---------------------------------------------------------------------------------------------
// Load the package the way the composition root does
// ---------------------------------------------------------------------------------------------

function resolveEntry(spec) {
  const abs = isAbsolute(spec) ? spec : resolve(process.cwd(), spec)
  let st
  try { st = statSync(abs) } catch { fail(3, `--package ${spec}: not found`) }
  if (st.isFile()) return abs
  let manifest
  try { manifest = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8')) } catch {
    fail(3, `--package ${spec}: no readable package.json in that directory`)
  }
  const exp = manifest.exports
  const dot = exp && typeof exp === 'object' && !Array.isArray(exp) ? (exp['.'] ?? exp) : exp
  const entry =
    (typeof dot === 'string' && dot) ||
    (dot && typeof dot === 'object' && (dot.import ?? dot.default)) ||
    manifest.main
  if (typeof entry !== 'string') fail(3, `--package ${spec}: package.json names no importable entry (exports["."].import or main)`)
  return join(abs, entry)
}

async function loadFactory(spec) {
  const entry = resolveEntry(spec)
  let mod
  try {
    mod = await import(pathToFileURL(entry).href)
  } catch (err) {
    fail(3, `could not import ${entry}: ${err.message}\n  (a package that has not been built has no dist/ — build it first)`)
  }
  const factory = mod.default ?? mod
  for (const key of ['id', 'configSchema', 'createProvider']) {
    if (!factory?.[key]) fail(3, `${entry} does not default-export a ProviderFactory (missing ${key})`)
  }
  return { factory, entry }
}

function loadConfig(factory) {
  let raw = {}
  if (args.config && args.configJson) fail(3, 'pass --config or --config-json, not both')
  if (args.config) {
    try { raw = JSON.parse(readFileSync(resolve(args.config), 'utf8')) } catch (err) { fail(3, `--config: ${err.message}`) }
  } else if (args.configJson) {
    try { raw = JSON.parse(args.configJson) } catch (err) { fail(3, `--config-json: ${err.message}`) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(3, 'the config must be a JSON object')
  for (const reserved of ['enabled', 'package']) {
    if (reserved in raw) fail(3, `the config must not carry '${reserved}' — that is the installation's field, and core strips it before the schema sees it`)
  }
  // The composition root's rule (ADR-0026): a value in the file wins; otherwise the first
  // non-empty variable in credentialEnv, handed to the schema under credentialField. Nothing stored.
  const field = factory.credentialField
  const envNames = factory.credentialEnv ?? []
  let credentialSource = field ? (raw[field] ? 'the config' : 'nothing') : 'no credential field declared'
  if (field && !raw[field]) {
    for (const name of envNames) {
      const value = process.env[name]
      if (value) { raw = { ...raw, [field]: value }; credentialSource = `$${name}`; break }
    }
  }
  let config
  try {
    config = factory.configSchema.parse(raw)
  } catch (err) {
    fail(3, `the config was rejected by ${factory.id}'s schema:\n${indent(err.message, 2)}`)
  }
  return { config, credentialSource }
}

// ---------------------------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------------------------

/** An OpenSSH-format ed25519 public key nobody holds the private half of after this process exits. */
function throwawayPublicKey(comment) {
  const { publicKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  const type = Buffer.from('ssh-ed25519')
  const len = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return l }
  const wire = Buffer.concat([len(type), type, len(raw), raw])
  return `ssh-ed25519 ${wire.toString('base64')} ${comment}`
}

function hhmmss() {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('')
}

function buildSpec({ offering, config }) {
  const serverId = args.serverId ?? `dryrun-${hhmmss()}`
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(serverId)) fail(3, `--server-id '${serverId}' is not hostname-safe`)
  const managedBy = args.managedBy ?? (typeof config?.managedBy === 'string' ? config.managedBy : 'rockysurf')
  const sshPublicKey = args.sshKey
    ? readFileSync(resolve(args.sshKey), 'utf8').trim()
    : throwawayPublicKey(`${serverId}@dry-run`)
  const userData = args.userData
    ? readFileSync(resolve(args.userData), 'utf8')
    : `#cloud-config\n# dry-run-provision ${serverId}: this document must never reach a booting machine\n`
  return {
    serverId,
    name: serverId,
    offeringId: offering.id,
    arch: args.arch,
    sshPublicKeys: [sshPublicKey],
    userData,
    tags: { 'managed-by': managedBy, 'server-id': serverId },
    idempotencyKey: `${serverId}-dry-run-1`,
  }
}

function pickOffering(offerings) {
  if (args.offering) {
    const found = offerings.find((o) => o.id === args.offering)
    if (!found) fail(3, `--offering ${args.offering} is not in listOfferings(); it returned ${offerings.length} offerings, e.g. ${offerings.slice(0, 5).map((o) => o.id).join(', ')}`)
    return found
  }
  const found = offerings.find((o) => o.arch === args.arch && o.available !== false)
  if (!found) fail(3, `listOfferings() returned no available ${args.arch} offering; pass --offering explicitly`)
  return found
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

function describeError(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && 'retryable' in err) {
    return `ProviderError ${err.code} (retryable: ${err.retryable}): ${err.message}`
  }
  return `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`
}

function section(title) {
  console.log(`\n== ${title}`)
}

/** Every value under a key named `id` in a JSON document, at any depth — what a later DELETE would name. */
function idsIn(text) {
  const out = new Set()
  let doc
  try { doc = JSON.parse(text) } catch { return out }
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'id' && (typeof val === 'string' || typeof val === 'number')) out.add(String(val))
        else walk(val)
      }
    }
  }
  walk(doc)
  return out
}

/** The later successful DELETE that named an id the create returned, if there was one. */
function reapedBy(create, passed) {
  const ids = idsIn(create.response ?? '')
  if (ids.size === 0) return undefined
  return passed.find(
    (e) => e.n > create.n && e.method === 'DELETE' && typeof e.status === 'number' && e.status < 300 &&
      [...ids].some((id) => e.path.endsWith(`/${id}`) || e.path.endsWith(`/${encodeURIComponent(id)}`)),
  )
}

function summary() {
  const reads = log.filter((e) => e.kind === 'read')
  const passed = log.filter((e) => e.kind === 'passed')
  const refused = log.filter((e) => e.kind === 'refused')
  section('summary')
  console.log(`${log.length} requests: ${reads.length} reads, ${passed.length} writes sent, ${refused.length} writes refused`)
  const created = passed.filter((e) => typeof e.status === 'number' && e.status < 300 && (e.method === 'POST' || e.method === 'PUT'))
  if (created.length > 0) {
    console.log('writes the cloud accepted — check the account and remove what the provider did not:')
    for (const e of created) {
      const reaper = reapedBy(e, passed)
      console.log(`  #${e.n} ${e.method} ${e.path} → ${e.status}${reaper ? ` (reaped by #${reaper.n} ${reaper.method} ${reaper.path})` : ''}`)
    }
  }
  const failedWrites = passed.filter((e) => typeof e.status !== 'number' || e.status >= 400)
  if (failedWrites.length > 0) {
    console.log('writes the cloud REJECTED — each one is a finding:')
    for (const e of failedWrites) console.log(`  #${e.n} ${e.method} ${e.path} → ${e.status}`)
  }
  for (const e of refused) {
    const why = e.reason === 'refuse' ? 'named by --refuse' : 'no --allow matched it'
    console.log(`refused before it left the machine: #${e.n} ${e.method} ${e.path} (${why})`)
  }
  return { reads, passed, refused, failedWrites }
}

async function main() {
  const { factory, entry } = await loadFactory(args.package)
  const { config, credentialSource } = loadConfig(factory)

  section(`provider ${factory.id} (${factory.displayName ?? ''}) from ${entry}`)
  console.log(`credential: ${credentialSource}`)
  console.log(`policy: reads pass; writes refused unless --allow matches; --refuse always wins`)
  console.log(`allow: ${args.allow.length ? args.allow.map((s) => `'${s}'`).join(', ') : '(none — every write will be refused)'}`)
  console.log(`refuse: ${args.refuse.length ? args.refuse.map((s) => `'${s}'`).join(', ') : '(none named — name the instance create so the refusal is deliberate)'}`)

  const provider = factory.createProvider(config)
  if (provider.id !== factory.id) fail(3, `createProvider() returned id '${provider.id}', factory says '${factory.id}'`)

  section('validateCredentials()')
  try {
    await provider.validateCredentials()
    console.log('ok')
  } catch (err) {
    console.log(describeError(err))
    summary()
    process.exit(1)
  }

  section('listOfferings()')
  let offering
  try {
    const offerings = await provider.listOfferings()
    offering = pickOffering(offerings)
    const price = offering.hourly ? `${offering.hourly.amount} ${offering.hourly.currency}/h` : 'price unknown'
    console.log(`${offerings.length} offerings; using ${offering.id} (${offering.arch}, ${offering.cpu} cpu, ${offering.memoryGb} GB, ${price})`)
  } catch (err) {
    console.log(describeError(err))
    summary()
    process.exit(1)
  }

  const spec = buildSpec({ offering, config })
  section(`validateSpec() for ${spec.serverId}`)
  try {
    await provider.validateSpec(spec)
    console.log('ok')
  } catch (err) {
    console.log(describeError(err))
    summary()
    process.exit(1)
  }

  section('provision()')
  let result
  let thrown
  try {
    result = await provider.provision(spec)
  } catch (err) {
    thrown = err
  }

  const { refused, failedWrites } = summary()

  section('verdict')
  if (thrown === undefined) {
    console.log('provision() RESOLVED. Nothing was refused, so a billable instance may now exist.')
    console.log(`handle: ${JSON.stringify(result?.data)}`)
    console.log('Terminate it yourself, through Rocky Surf or the cloud console — this script does not.')
    process.exit(2)
  }
  console.log(`provision() threw: ${describeError(thrown)}`)
  if (refused.length > 0 && failedWrites.length === 0) {
    const first = refused[0]
    console.log(`The chain was walked up to #${first.n} ${first.method} ${first.path} and nothing the cloud saw was rejected.`)
    if (first.reason === 'refuse') {
      console.log('That write is the one --refuse names: the dry run went as far as it can go.')
      console.log('Record it in the README\'s Verified section, with the date and the region.')
    } else {
      console.log('That write was refused only because no --allow matched it. If it is not the billable')
      console.log('instance create, allow exactly that collection and run again; if it is, name it with --refuse.')
    }
    process.exit(0)
  }
  if (refused.length > 0) {
    console.log('A refused write was reached, but the cloud rejected an earlier write on the way — read it above.')
    process.exit(1)
  }
  console.log('provision() failed BEFORE any write was refused: a precondition or a read failed. Read the log above.')
  process.exit(1)
}

main().catch((err) => {
  console.error(`dry-run-provision: ${describeError(err)}`)
  process.exit(3)
})
