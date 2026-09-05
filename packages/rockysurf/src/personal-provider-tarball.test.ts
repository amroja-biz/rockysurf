import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configSchema, type Config } from '@rockysurf/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeRegistry } from './compose.js'
import { loadPersonalProviders } from './personal-providers.js'

/**
 * THE INSTALL PATH A PERSONAL PROVIDER IS ACTUALLY DISTRIBUTED BY (issue #368, ADR-0026).
 *
 * `personal-providers.test.ts` proves the resolver against hand-written fixtures. This proves the
 * whole thing against a REAL artifact: `packages/provider-digitalocean` is packed exactly as
 * `pnpm publish` would pack it, extracted into a temp data directory, and booted through the same
 * loader and composition an operator's Rocky Surf runs. Nothing is mocked and no `npm install` is
 * run, which is the point:
 *
 * **The provider shop's installer never runs a package manager.** It fetches the tarball, extracts
 * it under `<dataDir>/providers`, checks that every runtime dependency the manifest declares
 * resolves from the install directory, and refuses the install naming any that do not. So a
 * personal provider has to be SELF-CONTAINED — no runtime dependencies at all — and the only way
 * to know that stays true is to extract the tarball and load it with nothing else present. A
 * dependency added to that package's manifest in six months' time fails here, in this repository,
 * rather than in an operator's install.
 *
 * The same extraction is the owner's manual verification path, so what this asserts and what a
 * human would do by hand are the same steps.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const packageDir = join(repoRoot, 'packages', 'provider-digitalocean')
const PACKAGE_NAME = '@rockysurf/provider-digitalocean'
const PNPM = process.env['ROCKYSURF_PNPM'] ?? 'pnpm'

const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-shop-'))
  temporary.push(dir)
  return dir
}

/**
 * Build, pack, extract. No install step anywhere.
 *
 * The SDK is built first because the provider's build BUNDLES it — that is what lets the package
 * declare zero runtime dependencies — and `pnpm run check` deliberately runs tests without
 * running builds, so neither `dist/` can be assumed to exist. Both builds are idempotent.
 */
function installedFromTarball(): { providersDir: string; installedAt: string } {
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-package.mjs')], {
    cwd: join(repoRoot, 'packages', 'provider-sdk'),
    stdio: 'pipe',
  })
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-bundled-package.mjs')], {
    cwd: packageDir,
    stdio: 'pipe',
  })

  const work = tempDir()
  const stdout = execFileSync(PNPM, ['pack', '--pack-destination', work], {
    cwd: packageDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const tarball = stdout.trim().split('\n').at(-1)?.trim()
  if (!tarball?.endsWith('.tgz')) throw new Error(`could not read the tarball path out of \`pnpm pack\`:\n${stdout}`)

  // Where npm would put a direct dependency, which is where the loader looks for a name.
  const providersDir = join(work, 'providers')
  const installedAt = join(providersDir, 'node_modules', ...PACKAGE_NAME.split('/'))
  mkdirSync(installedAt, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', installedAt, '--strip-components=1'], { stdio: 'pipe' })
  return { providersDir, installedAt }
}

const configFor = (providers: Record<string, unknown>): Config => configSchema.parse({ providers })

describe('the packed provider tarball', () => {
  let providersDir = ''
  let installedAt = ''

  // Two builds and a pack. Generous rather than tight: this is the one test in the suite that
  // compiles a package, and a machine under load should report a real failure, not a timeout.
  beforeAll(() => {
    ;({ providersDir, installedAt } = installedFromTarball())
  }, 240_000)

  it('declares no runtime dependencies, so an installer that never runs npm can accept it', () => {
    const manifest = JSON.parse(readFileSync(join(installedAt, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([])
    // And nothing anywhere still names a workspace protocol, which no registry could resolve.
    for (const range of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(range.startsWith('workspace:')).toBe(false)
    }
  })

  it('carries its code, with the SDK bundled in rather than imported at runtime', () => {
    const entry = join(installedAt, 'dist', 'index.js')
    expect(existsSync(entry)).toBe(true)
    // The failure this catches: a build that emitted a bare `import … from
    // '@rockysurf/provider-sdk'` would resolve inside this repository and crash in an
    // installation, where that package is not there to import.
    expect(readFileSync(entry, 'utf8')).not.toMatch(/from\s*['"]@rockysurf\/provider-sdk['"]/)
    expect(existsSync(join(installedAt, 'README.md'))).toBe(true)
    expect(existsSync(join(installedAt, 'src'))).toBe(false)
  })

  it('loads through the resolver by package name, out of the data directory', async () => {
    const config = configFor({
      digitalocean: { package: PACKAGE_NAME, enabled: true, token: 'do-token', region: 'nyc3', sshAllowedCidr: '203.0.113.7/32' },
    })
    const loaded = await loadPersonalProviders({ config, providersDir })

    expect([...loaded.failures.entries()]).toEqual([])
    const factory = loaded.factories.get('digitalocean')
    expect(factory?.id).toBe('digitalocean')
    expect(factory?.displayName).toBe('DigitalOcean')
    expect(factory?.credentialField).toBe('token')
    expect(factory?.credentialEnv).toEqual(['DIGITALOCEAN_TOKEN'])
    // The Settings panel is built from this, in tree or out (ADR-0027).
    expect(factory?.settings?.fields.map((field) => field.name)).toContain('sshAllowedCidr')
    expect(dirname(loaded.sources.get('digitalocean') ?? '')).toBe(join(installedAt, 'dist'))
  })

  it('composes into the registry as a real provider, with the capabilities it declares', async () => {
    const config = configFor({
      digitalocean: { package: PACKAGE_NAME, enabled: true, token: 'do-token', region: 'nyc3', sshAllowedCidr: '203.0.113.7/32' },
    })
    const personal = await loadPersonalProviders({ config, providersDir })
    const composed = composeRegistry({ config, env: {}, log: () => {} }, personal)

    const provider = composed.registry.list().find((candidate) => candidate.id === 'digitalocean')
    expect(provider, composed.notes.join('\n')).toBeDefined()
    // A stopped droplet bills at the running rate, and core's meter reads this flag (ADR-0025).
    expect(provider?.capabilities.billsWhileStopped).toBe(true)
    expect(provider?.capabilities.managesSshAccess).toBe(true)
    expect(typeof provider?.syncSshAccess).toBe('function')
    expect(composed.notes.some((note) => note.includes('install ones you trust'))).toBe(true)
  })

  it('reports the provider own sentence when its section is wrong, and never fatally', async () => {
    const config = configFor({
      digitalocean: { package: PACKAGE_NAME, enabled: true, token: 'do-token', region: 'nyc3' },
    })
    const personal = await loadPersonalProviders({ config, providersDir })
    const composed = composeRegistry({ config, env: {}, log: () => {} }, personal)

    expect(composed.registry.has('digitalocean')).toBe(false)
    expect(composed.registry.unavailable().find((entry) => entry.id === 'digitalocean')?.reason).toContain(
      'state which network may reach SSH',
    )
  })
})
