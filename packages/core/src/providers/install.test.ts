import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SafeFetchBytesResult } from '../packs/safe-fetch.js'
import {
  installProviderPackage,
  installedProviderManifest,
  providerInstallChanges,
  providerPackageDir,
  providerRemovalChanges,
  removeProviderPackage,
} from './install.js'
import type { ProviderRegistryEntry } from './shop-index.js'
import { providerPackageMembers, tarballBytes, type TarMember } from './tar.fixture.js'

/**
 * The installer (ADR-0028): fetch, verify, unpack, and refuse.
 *
 * Every test builds its own tarball, so what is being asserted is visible in the test rather
 * than in a binary fixture. The refusals matter more than the happy path: an install writes code
 * that the next restart will run inside this process, so the interesting question is not "does
 * it install" but "what does it decline to install, and does the operator learn why".
 */

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tempProvidersDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-providers-'))
  scratch.push(dir)
  return join(dir, 'providers')
}

const TARBALL_URL = 'https://example.test/artifacts/nimbus-1.0.0.tgz'

function entryFor(bytes: Buffer, overrides: Partial<ProviderRegistryEntry> = {}): ProviderRegistryEntry {
  return {
    providerId: 'nimbus',
    name: 'Nimbus Cloud',
    description: 'A fixture cloud.',
    version: '1.0.0',
    package: '@fixture/rockysurf-provider-nimbus',
    tarball: TARBALL_URL,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    settings: [],
    capabilities: {
      stop: true,
      ipStableAcrossStop: true,
      canInjectHostKeys: false,
      generatesUserData: false,
      userDataMaxBytes: 0,
    },
    ...overrides,
  }
}

/** A fetch that serves exactly one URL, so a request for anything else is a visible failure. */
function serve(bytes: Buffer, url = TARBALL_URL) {
  return vi.fn(
    async (requested: string): Promise<SafeFetchBytesResult> =>
      requested === url ? { ok: true, bytes, url } : { ok: false, reason: `Could not fetch ${requested}` },
  )
}

const packageOf = (members: readonly TarMember[]) => tarballBytes(members)

describe('installing a provider package', () => {
  it('unpacks it under the providers directory, where the loader looks for it', async () => {
    const bytes = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }))
    const providersDir = tempProvidersDir()

    const result = await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes: serve(bytes) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.installed.packageDir).toBe(
      join(providersDir, 'node_modules', '@fixture', 'rockysurf-provider-nimbus'),
    )
    expect(result.installed.version).toBe('1.0.0')
    expect(existsSync(join(result.installed.packageDir, 'index.js'))).toBe(true)
    // The manifest lands verbatim — including the `scripts` block nothing ever runs.
    expect(readFileSync(join(result.installed.packageDir, 'package.json'), 'utf8')).toContain('postinstall')
    // And `<dataDir>/providers` is now a place npm names resolve from, as ADR-0026 describes.
    expect(existsSync(join(providersDir, 'package.json'))).toBe(true)
    expect(installedProviderManifest(providersDir, '@fixture/rockysurf-provider-nimbus')).toEqual({
      name: '@fixture/rockysurf-provider-nimbus',
      version: '1.0.0',
    })
  })

  it('refuses an artifact whose digest is not the one the listing published', async () => {
    const bytes = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }))
    const providersDir = tempProvidersDir()
    const entry = entryFor(bytes, { sha256: 'f'.repeat(64) })

    const result = await installProviderPackage(entry, { providersDir, fetchBytes: serve(bytes) })

    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('does not match the digest')
    expect(existsSync(join(providersDir, 'node_modules'))).toBe(false)
  })

  it('refuses an artifact whose manifest names a different package than the listing', async () => {
    const bytes = packageOf(providerPackageMembers({ name: '@someone-else/provider', version: '1.0.0' }))
    const providersDir = tempProvidersDir()

    const result = await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes: serve(bytes) })

    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('the listing says it is "@fixture/rockysurf-provider-nimbus"')
  })

  it('refuses a package whose exports point at a file the tarball does not carry', async () => {
    const bytes = packageOf([
      {
        name: 'package/package.json',
        body: JSON.stringify({
          name: '@fixture/rockysurf-provider-nimbus',
          version: '1.0.0',
          exports: { '.': { import: './dist/index.js' } },
        }),
      },
      { name: 'package/README.md', body: '# nothing was built\n' },
    ])
    const providersDir = tempProvidersDir()

    const result = await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes: serve(bytes) })

    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('is the package built?')
    expect(existsSync(providerPackageDir(providersDir, '@fixture/rockysurf-provider-nimbus'))).toBe(false)
  })

  it('refuses a package with runtime dependencies nothing here can resolve, and names them', async () => {
    const bytes = packageOf(
      providerPackageMembers({
        name: '@fixture/rockysurf-provider-nimbus',
        version: '1.0.0',
        dependencies: { zod: '^4.0.0', 'left-pad': '^1.0.0' },
      }),
    )
    const providersDir = tempProvidersDir()

    const result = await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes: serve(bytes) })

    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('zod, left-pad')
    expect(result.reason).toContain('never runs npm')
  })

  it('accepts a declared dependency that IS resolvable, because npm may have put it there', async () => {
    const bytes = packageOf(
      providerPackageMembers({
        name: '@fixture/rockysurf-provider-nimbus',
        version: '1.0.0',
        dependencies: { zod: '^4.0.0' },
      }),
    )
    const providersDir = tempProvidersDir()
    mkdirSync(join(providersDir, 'node_modules', 'zod'), { recursive: true })
    writeFileSync(join(providersDir, 'node_modules', 'zod', 'package.json'), '{"name":"zod"}')

    const result = await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes: serve(bytes) })

    expect(result.ok).toBe(true)
  })

  it('refuses a tarball fetched over anything but https', async () => {
    const bytes = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }))
    const providersDir = tempProvidersDir()
    const fetchBytes = serve(bytes, 'http://example.test/x.tgz')

    const result = await installProviderPackage(entryFor(bytes, { tarball: 'http://example.test/x.tgz' }), {
      providersDir,
      fetchBytes,
    })

    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.reason).toContain('http is refused')
    // Refused before the socket: the fetch seam was never called.
    expect(fetchBytes).not.toHaveBeenCalled()
  })

  it('replaces the whole tree on an update, leaving nothing of the old version behind', async () => {
    const providersDir = tempProvidersDir()
    const first = packageOf([
      ...providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }),
      { name: 'package/removed-in-2.js', body: 'export const gone = true\n' },
    ])
    await installProviderPackage(entryFor(first), { providersDir, fetchBytes: serve(first) })

    const second = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '2.0.0' }))
    const result = await installProviderPackage(entryFor(second, { version: '2.0.0' }), {
      providersDir,
      fetchBytes: serve(second),
    })

    expect(result).toMatchObject({ ok: true })
    const dir = providerPackageDir(providersDir, '@fixture/rockysurf-provider-nimbus')
    expect(existsSync(join(dir, 'removed-in-2.js'))).toBe(false)
    expect(installedProviderManifest(providersDir, '@fixture/rockysurf-provider-nimbus')?.version).toBe('2.0.0')
  })

  it('leaves the previous install untouched when the new one is refused', async () => {
    const providersDir = tempProvidersDir()
    const good = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }))
    await installProviderPackage(entryFor(good), { providersDir, fetchBytes: serve(good) })

    const bad = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '2.0.0' }))
    const refused = await installProviderPackage(entryFor(bad, { version: '2.0.0', sha256: '0'.repeat(64) }), {
      providersDir,
      fetchBytes: serve(bad),
    })

    expect(refused).toMatchObject({ ok: false })
    expect(installedProviderManifest(providersDir, '@fixture/rockysurf-provider-nimbus')?.version).toBe('1.0.0')
  })

  it('carries the fetch guard’s own refusal through, rather than inventing one', async () => {
    const providersDir = tempProvidersDir()
    const bytes = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }))
    const fetchBytes = vi.fn(
      async (): Promise<SafeFetchBytesResult> => ({
        ok: false,
        reason: 'Refusing to fetch https://example.test/x.tgz: example.test resolves to a non-public address',
      }),
    )

    const result = await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes })

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('non-public address') })
  })
})

describe('removing a provider package', () => {
  it('deletes the package and the now-empty scope directory', async () => {
    const providersDir = tempProvidersDir()
    const bytes = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }))
    await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes: serve(bytes) })

    removeProviderPackage(providersDir, '@fixture/rockysurf-provider-nimbus')

    expect(existsSync(providerPackageDir(providersDir, '@fixture/rockysurf-provider-nimbus'))).toBe(false)
    expect(existsSync(join(providersDir, 'node_modules', '@fixture'))).toBe(false)
    expect(installedProviderManifest(providersDir, '@fixture/rockysurf-provider-nimbus')).toBeUndefined()
  })

  it('keeps a scope directory that still holds another package', async () => {
    const providersDir = tempProvidersDir()
    mkdirSync(join(providersDir, 'node_modules', '@fixture', 'other'), { recursive: true })
    const bytes = packageOf(providerPackageMembers({ name: '@fixture/rockysurf-provider-nimbus', version: '1.0.0' }))
    await installProviderPackage(entryFor(bytes), { providersDir, fetchBytes: serve(bytes) })

    removeProviderPackage(providersDir, '@fixture/rockysurf-provider-nimbus')

    expect(existsSync(join(providersDir, 'node_modules', '@fixture', 'other'))).toBe(true)
  })
})

describe('the config-file edits an install and a removal make', () => {
  it('names the package and switches the provider on', () => {
    expect(providerInstallChanges('nimbus', '@fixture/rockysurf-provider-nimbus')).toEqual([
      { path: ['providers', 'nimbus', 'package'], value: '@fixture/rockysurf-provider-nimbus' },
      { path: ['providers', 'nimbus', 'enabled'], value: true },
    ])
  })

  it('removes the whole section, so nothing configured for it is left behind', () => {
    expect(providerRemovalChanges('nimbus')).toEqual([{ path: ['providers', 'nimbus'], unset: true }])
  })
})
