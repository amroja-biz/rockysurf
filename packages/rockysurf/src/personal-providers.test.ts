import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema, type Config } from '@rockysurf/core'
import { afterAll, describe, expect, it } from 'vitest'
import {
  asProviderFactory,
  isPathSpecifier,
  loadPersonalProviders,
  resolvePackageEntry,
  resolveProviderPackage,
} from './personal-providers.js'

/**
 * Loading a provider Rocky Surf did not ship (ADR-0026).
 *
 * Every fixture here is a real package on disk in a temp directory, imported by the real
 * `import()`, because the failure this file exists to prevent was found by running the obvious
 * resolver against a real manifest: `createRequire().resolve()` refuses every provider package in
 * this repository (import-only `exports`), and a test with a bare `index.js` fixture would have
 * stayed green while the real case broke. So the first fixture has exactly Hetzner's manifest
 * shape, and the rest cover the other shapes real published packages use.
 */

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-personal-'))
  tempDirs.push(dir)
  return dir
}

/** A minimal but complete factory module, as ESM source text. */
function factorySource(id: string, extra = ''): string {
  return `
const factory = {
  id: ${JSON.stringify(id)},
  displayName: ${JSON.stringify(`${id} cloud`)},
  configSchema: { parse: (input) => input },
  createProvider: (config) => ({
    id: ${JSON.stringify(id)},
    displayName: ${JSON.stringify(`${id} cloud`)},
    capabilities: { stop: true, ipStableAcrossStop: true, canInjectHostKeys: false, userDataMaxBytes: 0, generatesUserData: false, simulatedInstances: true },
    config,
    validateCredentials: async () => {},
    validateSpec: async () => {},
    listOfferings: async () => [],
    provision: async () => ({ data: {}, initial: { state: 'pending' } }),
    describe: async () => ({ state: 'terminated' }),
    terminate: async () => {},
    listManaged: async () => [],
    stop: async () => {},
    start: async () => {},
  }),
  ${extra}
}
export default factory
`
}

/** Install a package under `<providersDir>/node_modules/<name>` with the given manifest and files. */
function installPackage(providersDir: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>): string {
  const dir = join(providersDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', ...manifest }, null, 2))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

function configWith(providers: Record<string, unknown>): Config {
  return configSchema.parse({ providers })
}

describe('what counts as a path', () => {
  it('treats absolute, relative and tilde specifiers as paths, and everything else as a name', () => {
    for (const path of ['/opt/p', './p', '../p', '~', '~/p']) expect(isPathSpecifier(path)).toBe(true)
    for (const name of ['nimbus', '@scope/nimbus', 'rockysurf-provider-nimbus']) expect(isPathSpecifier(name)).toBe(false)
  })
})

describe('the entry a manifest points at', () => {
  it('honours import-only conditional exports — the shape every shipped provider has', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.js'), '')
    const manifest = { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }
    expect(resolvePackageEntry(dir, manifest)).toBe(join(dir, 'dist', 'index.js'))
  })

  it('takes require as the LAST condition rather than refusing it — import() loads CommonJS', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'index.cjs'), '')
    expect(resolvePackageEntry(dir, { exports: { '.': { require: './index.cjs' } } })).toBe(join(dir, 'index.cjs'))
  })

  it('handles the sugar form, arrays of fallbacks and nested conditions', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.js'), '')
    writeFileSync(join(dir, 'b.js'), '')
    expect(resolvePackageEntry(dir, { exports: { import: './a.js', require: './b.js' } })).toBe(join(dir, 'a.js'))
    // An array is a list of fallbacks by SHAPE (Node's rule): the first well-formed target wins,
    // so an entry with only an unknown condition is skipped and the string after it is taken.
    expect(resolvePackageEntry(dir, { exports: [{ 'some-runtime': './x.js' }, './a.js'] })).toBe(join(dir, 'a.js'))
    expect(resolvePackageEntry(dir, { exports: { '.': { node: { import: './b.js' } } } })).toBe(join(dir, 'b.js'))
    expect(resolvePackageEntry(dir, { exports: './a.js' })).toBe(join(dir, 'a.js'))
  })

  it('falls back to module, then main, then index.js', () => {
    const dir = tempDir()
    for (const f of ['m.js', 'main.js', 'index.js']) writeFileSync(join(dir, f), '')
    expect(resolvePackageEntry(dir, { module: './m.js', main: './main.js' })).toBe(join(dir, 'm.js'))
    expect(resolvePackageEntry(dir, { main: './main.js' })).toBe(join(dir, 'main.js'))
    expect(resolvePackageEntry(dir, {})).toBe(join(dir, 'index.js'))
  })

  it('names the manifest when exports has no "." entry, and the file when it is missing', () => {
    const dir = tempDir()
    expect(() => resolvePackageEntry(dir, { exports: { './sub': './sub.js' } })).toThrow(/no "\." entry/)
    expect(() => resolvePackageEntry(dir, { main: './built.js' })).toThrow(/does not exist — is the package built\?/)
  })
})

describe('resolving a package: value', () => {
  it('finds a package installed under <dataDir>/providers by name', () => {
    const providersDir = tempDir()
    installPackage(providersDir, '@someone/rockysurf-provider-nimbus', { exports: { '.': { import: './index.js' } } }, { 'index.js': '' })
    expect(resolveProviderPackage('@someone/rockysurf-provider-nimbus', providersDir)).toBe(
      join(providersDir, 'node_modules', '@someone', 'rockysurf-provider-nimbus', 'index.js'),
    )
  })

  it('says where to install a name it cannot find, with the commands', () => {
    const providersDir = tempDir()
    expect(() => resolveProviderPackage('nope', providersDir)).toThrow(
      new RegExp(`nope is not installed under ${providersDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*npm install nope`),
    )
  })

  it('imports a path to a package directory through its manifest, a path to a file as is, and expands ~', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, 'pkg', 'package.json'), JSON.stringify({ type: 'module', main: './entry.js' }))
    writeFileSync(join(dir, 'pkg', 'entry.js'), '')
    writeFileSync(join(dir, 'single.mjs'), '')
    expect(resolveProviderPackage(join(dir, 'pkg'), '/unused')).toBe(join(dir, 'pkg', 'entry.js'))
    expect(resolveProviderPackage(join(dir, 'single.mjs'), '/unused')).toBe(join(dir, 'single.mjs'))
    expect(resolveProviderPackage('~/pkg', '/unused', dir)).toBe(join(dir, 'pkg', 'entry.js'))
    expect(() => resolveProviderPackage(join(dir, 'absent'), '/unused')).toThrow(/does not exist/)
  })
})

describe('what a loaded module has to look like', () => {
  const good = { id: 'nimbus', displayName: 'Nimbus', configSchema: { parse: (x: unknown) => x }, createProvider: () => ({}) }

  it('accepts a default export or the module namespace itself', () => {
    expect(asProviderFactory({ default: good }, 'nimbus')).toBe(good)
    expect(asProviderFactory(good, 'nimbus')).toBe(good)
  })

  it('refuses an id that disagrees with the section key, and says which section to rename', () => {
    expect(() => asProviderFactory({ default: good }, 'cumulus')).toThrow(/rename the section to providers\.nimbus/)
  })

  it('refuses a module that is not a factory, naming what is missing', () => {
    expect(() => asProviderFactory({ default: 42 }, 'nimbus')).toThrow(/does not export a provider factory/)
    expect(() => asProviderFactory({ default: { ...good, configSchema: {} } }, 'nimbus')).toThrow(/configSchema\.parse/)
    expect(() => asProviderFactory({ default: { ...good, createProvider: 'no' } }, 'nimbus')).toThrow(/createProvider/)
    expect(() => asProviderFactory({ default: { ...good, credentialEnv: 'DO_TOKEN' } }, 'nimbus')).toThrow(/credentialEnv/)
  })
})

describe('loading every personal provider the config names', () => {
  it('loads a real package by name with import-only exports, and a second by path', async () => {
    const providersDir = tempDir()
    installPackage(
      providersDir,
      'rockysurf-provider-nimbus',
      { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } },
      { 'dist/index.js': factorySource('nimbus', "credentialEnv: ['NIMBUS_TOKEN'], credentialField: 'token'") },
    )
    const byPath = tempDir()
    writeFileSync(join(byPath, 'package.json'), JSON.stringify({ type: 'module', main: './index.js' }))
    writeFileSync(join(byPath, 'index.js'), factorySource('cumulus'))

    const loaded = await loadPersonalProviders({
      config: configWith({
        nimbus: { package: 'rockysurf-provider-nimbus', enabled: true, token: 't' },
        cumulus: { package: byPath, enabled: false },
      }),
      providersDir,
    })

    expect([...loaded.factories.keys()].sort()).toEqual(['cumulus', 'nimbus'])
    expect(loaded.factories.get('nimbus')?.credentialEnv).toEqual(['NIMBUS_TOKEN'])
    expect(loaded.failures.size).toBe(0)
    expect(loaded.sources.get('nimbus')).toContain(join('node_modules', 'rockysurf-provider-nimbus', 'dist', 'index.js'))
  })

  it('loads a CommonJS package through import(), taking module.exports as the factory', async () => {
    const providersDir = tempDir()
    installPackage(
      providersDir,
      'nimbus-cjs',
      { type: 'commonjs', exports: { '.': { require: './index.cjs' } } },
      {
        'index.cjs':
          "module.exports = { id: 'nimbus', displayName: 'Nimbus', configSchema: { parse: (x) => x }, createProvider: () => ({ id: 'nimbus' }) }",
      },
    )
    const loaded = await loadPersonalProviders({ config: configWith({ nimbus: { package: 'nimbus-cjs' } }), providersDir })
    expect(loaded.failures.size).toBe(0)
    expect(loaded.factories.get('nimbus')?.displayName).toBe('Nimbus')
  })

  it('never throws — every way a package can be wrong is a failure naming the section', async () => {
    const providersDir = tempDir()
    installPackage(providersDir, 'throws-on-import', { main: './index.js' }, { 'index.js': "throw new Error('boom at import')" })
    installPackage(providersDir, 'not-a-factory', { main: './index.js' }, { 'index.js': 'export default 42' })
    installPackage(providersDir, 'wrong-id', { main: './index.js' }, { 'index.js': factorySource('other') })

    const loaded = await loadPersonalProviders({
      config: configWith({
        missing: { package: 'never-installed' },
        crashes: { package: 'throws-on-import' },
        shapeless: { package: 'not-a-factory' },
        renamed: { package: 'wrong-id' },
      }),
      providersDir,
    })

    expect(loaded.factories.size).toBe(0)
    expect(loaded.failures.get('missing')).toMatch(/could not be found: never-installed is not installed under/)
    expect(loaded.failures.get('crashes')).toMatch(/failed to load from .*boom at import/)
    expect(loaded.failures.get('shapeless')).toMatch(/is not a Rocky Surf provider: the package does not export a provider factory/)
    expect(loaded.failures.get('renamed')).toMatch(/factory id is 'other' but the config section is providers\.renamed/)
  })

  it('loads a section whether or not it is enabled, so it can be switched on from the page without a restart', async () => {
    const providersDir = tempDir()
    installPackage(providersDir, 'off', { main: './index.js' }, { 'index.js': factorySource('nimbus') })
    const loaded = await loadPersonalProviders({ config: configWith({ nimbus: { package: 'off', enabled: false } }), providersDir })
    expect(loaded.factories.has('nimbus')).toBe(true)
  })
})
