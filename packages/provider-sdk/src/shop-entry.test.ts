import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readNpmTarball, shopEntryFor, TarballError } from './shop-entry.js'
import { providerPackageMembers, tarballBytes, type TarMember } from './tar.fixture.js'

/**
 * The generator, against archives written member by member (issue #418).
 *
 * These are the shapes `pnpm pack` will not produce for you: a manifest with a dependency, a
 * symlink, a member that climbs out of the package. The one test that runs it on a REAL packed
 * provider and checks the output against the shop's own validator is
 * `packages/rockysurf/src/shop-entry.test.ts`, which needs a package to pack and so cannot live
 * in the SDK.
 */

/** A provider factory as a package's `index.js` — structural, because that is all the reader checks. */
function factorySource(options: {
  id: string
  displayName?: string
  title?: string
  fields?: string
  capabilities?: string
}): string {
  const settings =
    options.title === undefined && options.fields === undefined
      ? ''
      : `  settings: {
    title: ${JSON.stringify(options.title ?? options.id)},
    help: 'A provider that exists to be read by a test, and nothing else at all.',
    fields: [${options.fields ?? ''}],
    offering: { noun: 'box', example: 'small' },
  },
`
  return `export default {
  id: ${JSON.stringify(options.id)},
  displayName: ${JSON.stringify(options.displayName ?? options.id)},
  configSchema: { parse: (value) => value },
  createProvider: () => ({
    id: ${JSON.stringify(options.id)},
    capabilities: ${options.capabilities ?? '{ stop: true, ipStableAcrossStop: false, canInjectHostKeys: false, generatesUserData: false, userDataMaxBytes: 0 }'},
  }),
${settings}}
`
}

function packageWith(options: {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  source?: string
  extra?: readonly TarMember[]
}): Buffer {
  return tarballBytes(
    providerPackageMembers({
      name: options.name ?? '@you/rockysurf-provider-mycloud',
      version: options.version ?? '1.0.0',
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      extra: [
        { name: 'package/index.js', body: options.source ?? factorySource({ id: 'mycloud' }) },
        ...(options.extra ?? []),
      ],
    }),
  )
}

const generate = (tarball: Buffer, overrides: { tarballUrl?: string; description?: string } = {}) =>
  shopEntryFor({
    tarball,
    tarballUrl: overrides.tarballUrl ?? 'https://example.com/mycloud-1.0.0.tgz',
    description: overrides.description ?? 'MyCloud compute, one API token, four regions.',
  })

describe('the shop listing entry a packed provider describes', () => {
  it('reads every field but the URL and the description out of the artifact', async () => {
    const tarball = packageWith({
      source: factorySource({
        id: 'mycloud',
        displayName: 'MyCloud',
        title: 'MyCloud',
        fields: `
      { name: 'token', kind: 'secret', label: 'API token variable', help: 'The name of the variable holding the token.', example: 'MYCLOUD_TOKEN' },
      { name: 'region', kind: 'string', label: 'Region', help: 'Which datacentre new machines are created in.', example: 'eu-1' },
    `,
        capabilities:
          '{ stop: true, ipStableAcrossStop: false, canInjectHostKeys: true, generatesUserData: true, userDataMaxBytes: 16384, billsWhileStopped: true }',
      }),
    })

    const entry = await generate(tarball)

    expect(entry).toEqual({
      providerId: 'mycloud',
      name: 'MyCloud',
      description: 'MyCloud compute, one API token, four regions.',
      version: '1.0.0',
      package: '@you/rockysurf-provider-mycloud',
      tarball: 'https://example.com/mycloud-1.0.0.tgz',
      sha256: createHash('sha256').update(tarball).digest('hex'),
      settings: [
        { name: 'token', label: 'API token variable', kind: 'secret' },
        { name: 'region', label: 'Region', kind: 'string' },
      ],
      capabilities: {
        stop: true,
        ipStableAcrossStop: false,
        canInjectHostKeys: true,
        generatesUserData: true,
        userDataMaxBytes: 16384,
        billsWhileStopped: true,
      },
    })
    // The key order is the shop file's, so a generated entry diffs against its neighbours.
    expect(Object.keys(entry)).toEqual([
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
  })

  it('carries only the optional capabilities the provider actually sets', async () => {
    const entry = await generate(packageWith({}))
    expect(Object.keys(entry.capabilities)).toEqual([
      'stop',
      'ipStableAcrossStop',
      'canInjectHostKeys',
      'generatesUserData',
      'userDataMaxBytes',
    ])
    // Not `managesSshAccess: false` — absent means false, and a listing that says so invents a
    // claim the provider did not make.
    expect(entry.capabilities['managesSshAccess']).toBeUndefined()
  })

  it('names the panel title, then the display name, when there is no declaration', async () => {
    const declared = await generate(packageWith({ source: factorySource({ id: 'mycloud', displayName: 'MyCloud', title: 'MyCloud Compute' }) }))
    expect(declared.name).toBe('MyCloud Compute')

    const undeclared = await generate(packageWith({ source: factorySource({ id: 'mycloud', displayName: 'MyCloud' }) }))
    expect(undeclared.name).toBe('MyCloud')
    expect(undeclared.settings).toEqual([])
  })

  it('refuses a package with runtime dependencies, naming them', async () => {
    await expect(generate(packageWith({ dependencies: { zod: '^4.0.0', undici: '^7.0.0' } }))).rejects.toThrow(
      /declares runtime dependencies \(zod, undici\)/,
    )
  })

  it('refuses a tarball URL that is not https', async () => {
    await expect(generate(packageWith({}), { tarballUrl: 'http://example.com/x.tgz' })).rejects.toThrow(
      /must be https — a provider artifact is code/,
    )
    await expect(generate(packageWith({}), { tarballUrl: 'not a url' })).rejects.toThrow(/is not a URL/)
  })

  it('refuses an empty description, which is the one field it cannot read', async () => {
    await expect(generate(packageWith({}), { description: '   ' })).rejects.toThrow(/cannot be empty/)
  })

  it('says what to do when the package is not a provider', async () => {
    await expect(generate(packageWith({ source: 'export default 42\n' }))).rejects.toThrow(
      /does not export a provider factory/,
    )
  })

  it('refuses a manifest that points at a file the tarball does not carry', async () => {
    const tarball = tarballBytes([
      {
        name: 'package/package.json',
        body: JSON.stringify({ name: '@you/p', version: '1.0.0', type: 'module', exports: { '.': { import: './dist/index.js' } } }),
      },
      { name: 'package/README.md', body: '# nothing built\n' },
    ])
    await expect(generate(tarball)).rejects.toThrow(/is the package built\?/)
  })
})

describe('the tar reader, on archives pnpm pack will not write for you', () => {
  const manifest: TarMember = { name: 'package/package.json', body: '{}' }

  it('refuses a symbolic link', () => {
    expect(() => readNpmTarball(tarballBytes([manifest, { name: 'package/evil', type: '2', linkname: '/etc/passwd' }]))).toThrow(
      TarballError,
    )
  })

  it('refuses a member that climbs out of the package, or names an absolute path', () => {
    expect(() => readNpmTarball(tarballBytes([manifest, { name: 'package/../../escape', body: 'x' }]))).toThrow(/climbs out/)
    expect(() => readNpmTarball(tarballBytes([{ name: '/etc/passwd', body: 'x' }]))).toThrow(/absolute path/)
  })

  it('refuses an archive not rooted under package/', () => {
    expect(() => readNpmTarball(tarballBytes([{ name: 'somewhere/else.js', body: 'x' }]))).toThrow(/outside "package\/"/)
  })

  it('caps what an archive may unpack to', () => {
    expect(() => readNpmTarball(tarballBytes([manifest]), { maxEntries: 4_000, maxTotalBytes: 1 })).toThrow(
      /unpacks to more than 1 bytes/,
    )
  })

  it('refuses bytes that are not gzip at all', () => {
    expect(() => readNpmTarball(Buffer.from('not a tarball'))).toThrow(/not gzip data/)
  })
})
