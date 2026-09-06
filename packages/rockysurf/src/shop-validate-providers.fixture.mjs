#!/usr/bin/env node
// VENDORED, VERBATIM, FROM THE SHOP (issue #418).
//
// Source: https://raw.githubusercontent.com/amroja-biz/rockysurf-shop/main/scripts/validate-providers.mjs
// Fetched: 2026-09-06.
//
// `rockysurf-shop-entry` prints an object that has to survive this script's check in a pull
// request against a repository whose CI this one does not run. A test that asserted the shape by
// hand would be a third description of the format — beside the generator and beside the shop —
// and the two that live here would agree with each other while drifting from the one that
// decides. So the shop's own script is copied in and run unmodified over a `providers.json` built
// from the generator's output; refresh the copy from the URL above when the shop changes it, and
// the diff is the whole review.
//
// Nothing below this line is edited. The shop's file starts here — its shebang is the line above
// this comment block, where Node needs it, and that is the only difference from the source.

/**
 * Check `providers.json` before a control plane has to.
 *
 * WHY THIS FILE IS HAND-WRITTEN AND `index.json` IS GENERATED. A pack lives in this repository, so
 * its listing can be derived from the files beside it — digest included. A provider's artifact
 * does NOT live here: it is a tarball on npm or on a release page, and the only thing this
 * repository holds is a description of it. There is nothing to generate from, so the file is
 * written by hand, reviewed in a pull request, and checked by this script.
 *
 * WHAT THE AUTHORITY IS. Rocky Surf's own schema
 * (`packages/core/src/providers/shop-index.ts`, ADR-0028) decides what a control plane will
 * accept; this is a courtesy pre-check so a contributor learns about a typo here rather than from
 * an operator's shelf saying "this is not a provider listing". Where the two disagree, the
 * control plane is right and this script is stale — say so in a pull request.
 *
 * NO DEPENDENCIES, on purpose: this runs on a bare `actions/setup-node` with no install step.
 *
 * Usage: node scripts/validate-providers.mjs [path]
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'providers.json'
const problems = []
const fail = (where, message) => problems.push(`${where}: ${message}`)

/** The kinds a Settings page knows how to draw. Anything else has no control behind it. */
const KINDS = new Set(['string', 'number', 'boolean', 'secret', 'stringList', 'sshCidrList'])

/** An RFC 1123 label, lowercased — the same rule a `providers:` config section key follows. */
const PROVIDER_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const SHA256 = /^[0-9a-f]{64}$/

const REQUIRED_CAPABILITIES = {
  stop: 'boolean',
  ipStableAcrossStop: 'boolean',
  canInjectHostKeys: 'boolean',
  generatesUserData: 'boolean',
  userDataMaxBytes: 'number',
}
const OPTIONAL_CAPABILITIES = {
  managesSshAccess: 'boolean',
  billsWhileStopped: 'boolean',
  simulatedInstances: 'boolean',
}

const ENTRY_KEYS = new Set([
  'providerId',
  'name',
  'description',
  'version',
  'package',
  'tarball',
  'sha256',
  'settings',
  'capabilities',
])

let document
try {
  document = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  console.error(`${path} is not valid JSON: ${error.message}`)
  process.exit(1)
}

if (document.version !== 1) fail('version', 'must be 1')
if (typeof document.generatedAt !== 'string' || Number.isNaN(Date.parse(document.generatedAt))) {
  fail('generatedAt', 'must be an ISO-8601 timestamp')
}
if (!Array.isArray(document.providers)) fail('providers', 'must be an array')

for (const [key] of Object.entries(document)) {
  if (!['version', 'generatedAt', 'providers'].includes(key)) {
    fail(key, 'is not a field of a provider listing — the control plane refuses unknown fields')
  }
}

const seen = new Set()
for (const [index, entry] of (document.providers ?? []).entries()) {
  const where = `providers[${index}]`
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(where, 'must be an object')
    continue
  }

  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) {
      // The one worth naming specifically: a shop does not get to say how far it is trusted.
      const extra =
        key === 'trust' || key === 'tier'
          ? ' — a registry never publishes a trust label; the operator writes one in their own config file'
          : ''
      fail(`${where}.${key}`, `is not a field of a provider entry${extra}`)
    }
  }

  const string = (field, pattern) => {
    const value = entry[field]
    if (typeof value !== 'string' || value === '') {
      fail(`${where}.${field}`, 'must be a non-empty string')
      return undefined
    }
    if (pattern && !pattern.test(value)) fail(`${where}.${field}`, `does not match ${pattern}`)
    return value
  }

  const id = string('providerId', PROVIDER_ID)
  if (id) {
    if (seen.has(id)) fail(`${where}.providerId`, `"${id}" appears twice — one id, one entry`)
    seen.add(id)
  }
  string('name')
  string('description')
  string('version')
  string('package', PACKAGE_NAME)
  string('sha256', SHA256)

  const tarball = string('tarball')
  if (tarball) {
    let url
    try {
      url = new URL(tarball)
    } catch {
      fail(`${where}.tarball`, 'is not a valid URL')
    }
    if (url && url.protocol !== 'https:') {
      fail(`${where}.tarball`, 'must be https — a provider artifact is code, and http is refused')
    }
  }

  if (!Array.isArray(entry.settings)) {
    fail(`${where}.settings`, 'must be an array (empty if the provider takes no configuration)')
  } else {
    for (const [i, field] of entry.settings.entries()) {
      const at = `${where}.settings[${i}]`
      if (field === null || typeof field !== 'object') {
        fail(at, 'must be an object')
        continue
      }
      for (const key of Object.keys(field)) {
        if (!['name', 'label', 'kind'].includes(key)) fail(`${at}.${key}`, 'is not a field of a settings summary')
      }
      if (typeof field.name !== 'string' || field.name === '') fail(`${at}.name`, 'must be a non-empty string')
      if (typeof field.label !== 'string' || field.label === '') fail(`${at}.label`, 'must be a non-empty string')
      if (!KINDS.has(field.kind)) fail(`${at}.kind`, `must be one of ${[...KINDS].join(', ')}`)
    }
  }

  const capabilities = entry.capabilities
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    fail(`${where}.capabilities`, 'must be an object')
    continue
  }
  for (const [key, type] of Object.entries(REQUIRED_CAPABILITIES)) {
    if (typeof capabilities[key] !== type) fail(`${where}.capabilities.${key}`, `must be a ${type}`)
  }
  if (typeof capabilities.userDataMaxBytes === 'number' && capabilities.userDataMaxBytes < 0) {
    fail(`${where}.capabilities.userDataMaxBytes`, 'must not be negative')
  }
  for (const key of Object.keys(capabilities)) {
    if (key in REQUIRED_CAPABILITIES) continue
    if (!(key in OPTIONAL_CAPABILITIES)) {
      fail(`${where}.capabilities.${key}`, 'is not a capability Rocky Surf knows')
      continue
    }
    if (typeof capabilities[key] !== OPTIONAL_CAPABILITIES[key]) {
      fail(`${where}.capabilities.${key}`, `must be a ${OPTIONAL_CAPABILITIES[key]} when present`)
    }
  }
}

if (problems.length > 0) {
  console.error(`${path} is not a valid provider listing:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`${path}: ${document.providers.length} provider entr${document.providers.length === 1 ? 'y' : 'ies'}, all valid`)
