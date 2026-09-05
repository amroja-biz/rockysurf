import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { providerPackageMembers, tarBytes, tarballBytes } from './tar.fixture.js'
import { readNpmTarball, TarballError } from './tarball.js'

/**
 * The tarball reader (ADR-0028), tested against the shapes it must REFUSE.
 *
 * Every test below except the first one is a member a hostile or broken archive could carry, and
 * the reason each is here is that the alternative — a general-purpose extractor with the right
 * options passed — is a thing a future caller can get wrong silently. A refusal that is asserted
 * cannot be optioned away.
 */

describe('reading an npm tarball', () => {
  it('returns every regular file, with the package/ prefix stripped', () => {
    const files = readNpmTarball(
      tarballBytes([
        ...providerPackageMembers({ name: '@x/p', version: '1.0.0' }),
        { name: 'package/dist/', type: '5' },
        { name: 'package/dist/thing.js', body: 'export const a = 1\n' },
      ]),
    )

    expect([...files.keys()].sort()).toEqual(['dist/thing.js', 'index.js', 'package.json'])
    expect(files.get('dist/thing.js')?.toString('utf8')).toBe('export const a = 1\n')
  })

  it('refuses a symbolic link, naming it', () => {
    const bytes = tarballBytes([
      ...providerPackageMembers({ name: '@x/p', version: '1.0.0' }),
      { name: 'package/keys', type: '2', linkname: '/home/you/.rockysurf/master.key' },
    ])
    expect(() => readNpmTarball(bytes)).toThrow(/symbolic link \(package\/keys\)/)
  })

  it('refuses a hard link and a device node', () => {
    for (const [type, word] of [
      ['1', 'hard link'],
      ['3', 'character device'],
    ] as const) {
      const bytes = tarballBytes([
        ...providerPackageMembers({ name: '@x/p', version: '1.0.0' }),
        { name: 'package/odd', type, linkname: '/etc/passwd' },
      ])
      expect(() => readNpmTarball(bytes)).toThrow(new RegExp(word))
    }
  })

  it('refuses an absolute path and one that climbs out of the package', () => {
    expect(() => readNpmTarball(tarballBytes([{ name: '/etc/cron.d/evil', body: 'x' }]))).toThrow(/absolute path/)
    expect(() =>
      readNpmTarball(
        tarballBytes([
          ...providerPackageMembers({ name: '@x/p', version: '1.0.0' }),
          { name: 'package/../../escaped.js', body: 'x' },
        ]),
      ),
    ).toThrow(/climbs out of the package/)
  })

  it('refuses an archive rooted anywhere but package/', () => {
    expect(() => readNpmTarball(tarballBytes([{ name: 'somewhere/index.js', body: 'x' }]))).toThrow(
      /outside "package\/"/,
    )
  })

  it('refuses more than the entry limit, and more than the total-size limit', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `package/f${i}.js`, body: 'x' }))
    expect(() => readNpmTarball(tarballBytes(many), { maxEntries: 4, maxTotalBytes: 1_000 })).toThrow(
      /more than 4 files/,
    )
    // A gzip bomb is small on the wire and large after: the cap that catches it is this one.
    const big = tarballBytes([{ name: 'package/big.js', body: 'a'.repeat(4096) }])
    expect(big.length).toBeLessThan(2_000)
    expect(() => readNpmTarball(big, { maxEntries: 10, maxTotalBytes: 1_000 })).toThrow(/unpacks to more than/)
  })

  it('refuses something that is not gzip, and something that is not a tarball', () => {
    expect(() => readNpmTarball(Buffer.from('not gzip at all'))).toThrow(TarballError)
    expect(() => readNpmTarball(gzipSync(Buffer.alloc(512 * 3, 7)))).toThrow(/not a ustar tarball/)
  })

  it('refuses an archive with no files in it', () => {
    expect(() => readNpmTarball(gzipSync(tarBytes([])))).toThrow(/contains no files/)
  })

  it('reads a long member name out of its pax header', () => {
    const long = `package/dist/${'d/'.repeat(30)}deep.js`
    const files = readNpmTarball(
      tarballBytes([
        ...providerPackageMembers({ name: '@x/p', version: '1.0.0' }),
        { name: 'package/PaxHeader', type: 'x', body: `${long.length + 8} path=${long}\n` },
        { name: 'package/truncated', body: 'deep\n' },
      ]),
    )
    expect(files.has(long.slice('package/'.length))).toBe(true)
  })
})
