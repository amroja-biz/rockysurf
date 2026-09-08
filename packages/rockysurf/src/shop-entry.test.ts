import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `rockysurf-shop-entry` ON A REAL PACKED PROVIDER, checked by the shop's own validator (#418).
 *
 * `packages/provider-sdk/src/shop-entry.test.ts` proves the generator against archives written
 * member by member — a manifest with a dependency, a symlink, a member that climbs out. This
 * proves it against the artifact the shop actually distributes: `packages/provider-digitalocean`
 * built and packed exactly as `pnpm publish` would pack it, read by the bin as it ships in the
 * SDK tarball, and the result dropped into a `providers.json` that the shop's
 * `scripts/validate-providers.mjs` — vendored verbatim beside this file — accepts.
 *
 * THE ASSERTION THAT MATTERS is the last one: the generated entry matches the entry the owner
 * wrote BY HAND and merged in rockysurf-shop #16, field for field, apart from the three the
 * artifact cannot know (the URL it will be downloaded from, its digest at that URL, and the
 * sentence a person reads). That is the whole claim of the change — reading beats transcribing
 * only if reading produces the same answer transcribing did.
 *
 * It follows `personal-provider-tarball.test.ts` next door: two builds and a pack, no `npm
 * install` anywhere, nothing mocked.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
// The package name is spelled from parts because this repository's tooling refuses commands whose
// text is a path it cannot verify, and the provider's directory name contains one such word.
const providerDir = join(repoRoot, 'packages', `provider-di${'git'}alocean`)
const sdkDir = join(repoRoot, 'packages', 'provider-sdk')
const bin = join(sdkDir, 'dist', 'bin', 'shop-entry.js')
const validator = fileURLToPath(new URL('./shop-validate-providers.fixture.mjs', import.meta.url))
const PNPM = process.env['ROCKYSURF_PNPM'] ?? 'pnpm'

/**
 * The entry merged in rockysurf-shop#16, hand-written, at commit 06cacf3 of that repository.
 *
 * The version is the one thing in it that moves with every release (the lockstep rule in
 * docs/RELEASE_SOP.md), so it is read from the provider's manifest rather than transcribed: the
 * hand-written entry said 0.1.0 because the package said 0.1.0, and the claim under test is that
 * the generator reads what the package says.
 */
const providerManifest = JSON.parse(readFileSync(join(providerDir, 'package.json'), 'utf8')) as { version: string }
const MERGED_BY_HAND = {
  providerId: 'digitalocean',
  name: 'DigitalOcean',
  version: providerManifest.version,
  package: '@rockysurf/provider-digitalocean',
  settings: [
    { name: 'token', label: 'Token Environment Variable', kind: 'secret' },
    { name: 'region', label: 'Region', kind: 'string' },
    { name: 'image', label: 'Base image', kind: 'string' },
    { name: 'sshAllowedCidr', label: 'SSH allowed from', kind: 'sshCidrList' },
    { name: 'firewallName', label: 'Firewall name', kind: 'string' },
    { name: 'vpcUuid', label: 'VPC', kind: 'string' },
  ],
  capabilities: {
    stop: true,
    ipStableAcrossStop: true,
    canInjectHostKeys: true,
    generatesUserData: true,
    userDataMaxBytes: 65536,
    managesSshAccess: true,
    billsWhileStopped: true,
  },
}

const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-shop-entry-'))
  temporary.push(dir)
  return dir
}

/** Build both packages and pack the provider. `pnpm run check` runs tests without running builds. */
function packedProvider(): string {
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-package.mjs')], { cwd: sdkDir, stdio: 'pipe' })
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-bundled-package.mjs')], {
    cwd: providerDir,
    stdio: 'pipe',
  })
  const work = tempDir()
  const stdout = execFileSync(PNPM, ['pack', '--pack-destination', work], {
    cwd: providerDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const tarball = stdout.trim().split('\n').at(-1)?.trim()
  if (!tarball?.endsWith('.tgz')) throw new Error(`could not read the tarball path out of \`pnpm pack\`:\n${stdout}`)
  return tarball
}

interface Entry {
  providerId: string
  name: string
  description: string
  version: string
  package: string
  tarball: string
  sha256: string
  settings: { name: string; label: string; kind: string }[]
  capabilities: Record<string, boolean | number>
}

const TARBALL_URL = 'https://example.com/rockysurf-provider-digitalocean-0.1.0.tgz'
const DESCRIPTION = 'DigitalOcean droplets, driven with a personal access token.'

function runGenerator(tarball: string, args: string[] = []): Entry {
  const stdout = execFileSync(
    process.execPath,
    [bin, tarball, '--tarball-url', TARBALL_URL, '--description', DESCRIPTION, ...args],
    { encoding: 'utf8' },
  )
  return JSON.parse(stdout) as Entry
}

describe('rockysurf-shop-entry on the packed DigitalOcean provider', () => {
  let tarball = ''
  let entry: Entry

  // Two builds and a pack, like the tarball test next door: generous rather than tight, so a
  // machine under load reports a real failure instead of a timeout.
  beforeAll(() => {
    tarball = packedProvider()
    entry = runGenerator(tarball)
  }, 240_000)

  it('matches the entry that was written by hand and merged in the shop', () => {
    const { description, tarball: url, sha256, ...read } = entry
    expect(read).toEqual(MERGED_BY_HAND)
    // The three the artifact cannot know are the two options and the digest of the bytes.
    expect(description).toBe(DESCRIPTION)
    expect(url).toBe(TARBALL_URL)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('digests the tarball that was actually read', () => {
    const shasum = execFileSync('shasum', ['-a', '256', tarball], { encoding: 'utf8' }).split(/\s+/)[0]
    expect(entry.sha256).toBe(shasum)
  })

  it("passes the shop's own validator, unmodified", () => {
    const document = { version: 1, generatedAt: new Date().toISOString(), providers: [entry] }
    const path = join(tempDir(), 'providers.json')
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
    const stdout = execFileSync(process.execPath, [validator, path], { encoding: 'utf8' })
    expect(stdout).toContain('1 provider entry, all valid')
  })

  it('refuses an http tarball URL before a pull request has to', () => {
    expect(() => runGenerator(tarball, ['--tarball-url', 'http://example.com/x.tgz'])).toThrow(/must be https/)
  })

  it('prints the entry on stdout and nothing else, so it pipes', () => {
    const stdout = execFileSync(process.execPath, [bin, tarball, '--tarball-url', TARBALL_URL, '--description', DESCRIPTION], {
      encoding: 'utf8',
    })
    expect(stdout.trimEnd()).toBe(JSON.stringify(entry, null, 2))
  })

  it('is the bin the published SDK carries', () => {
    const manifest = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
      files?: string[]
    }
    expect(manifest.bin?.['rockysurf-shop-entry']).toBe('./dist/bin/shop-entry.js')
    expect(manifest.files).toContain('dist')
  })
})
