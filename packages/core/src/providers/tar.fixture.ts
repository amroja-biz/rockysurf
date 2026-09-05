import { gzipSync } from 'node:zlib'

/**
 * A ustar tarball writer, for tests only (ADR-0028).
 *
 * `tarball.ts` reads npm tarballs and has to be tested against the shapes it refuses — a
 * symlink member, an absolute path, a `..`, an archive rooted somewhere other than `package/`,
 * something that unpacks far larger than it arrived. Shelling out to `npm pack` produces none of
 * those, and a checked-in binary fixture would be a file nobody can read in a diff. So a test
 * writes the exact archive it means to assert about, member by member.
 *
 * NOT SHIPPED: `tsconfig.build.json` excludes `*.fixture.ts` alongside `*.test.ts`, so this is
 * compiled by the typechecker and by vitest and is absent from `dist/`.
 */

const BLOCK = 512

export interface TarMember {
  /** The full path INSIDE the archive, `package/` prefix and all. A test writes it verbatim. */
  name: string
  /** File contents. Ignored for directories and links. */
  body?: string
  /** ustar type flag: '0' file, '5' directory, '2' symlink, '1' hard link, '3' char device. */
  type?: string
  /** Where a link points. Only meaningful for '1' and '2'. */
  linkname?: string
  mode?: number
}

function writeField(block: Buffer, value: string, offset: number, length: number): void {
  block.write(value.slice(0, length - 1), offset, 'utf8')
}

function writeOctal(block: Buffer, value: number, offset: number, length: number): void {
  // `length - 1` digits, NUL-terminated — the form GNU tar and npm both emit.
  writeField(block, value.toString(8).padStart(length - 1, '0'), offset, length)
}

function header(member: TarMember, size: number): Buffer {
  const block = Buffer.alloc(BLOCK)
  writeField(block, member.name, 0, 100)
  writeOctal(block, member.mode ?? 0o644, 100, 8)
  writeOctal(block, 0, 108, 8)
  writeOctal(block, 0, 116, 8)
  writeOctal(block, size, 124, 12)
  writeOctal(block, 0, 136, 12)
  block.write('        ', 148, 8, 'utf8') // checksum placeholder: spaces, per the format
  block.write(member.type ?? '0', 156, 1, 'utf8')
  if (member.linkname) writeField(block, member.linkname, 157, 100)
  block.write('ustar\0', 257, 6, 'binary')
  block.write('00', 263, 2, 'utf8')

  let checksum = 0
  for (const byte of block) checksum += byte
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return block
}

/** The members as an uncompressed ustar archive, ending in the two zero blocks. */
export function tarBytes(members: readonly TarMember[]): Buffer {
  const chunks: Buffer[] = []
  for (const member of members) {
    const body = Buffer.from(member.body ?? '', 'utf8')
    const size = member.type === '5' || member.type === '2' || member.type === '1' ? 0 : body.length
    chunks.push(header(member, size))
    if (size > 0) {
      chunks.push(body)
      const padding = (BLOCK - (size % BLOCK)) % BLOCK
      if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(chunks)
}

/** The same, gzipped — what a registry actually serves. */
export const tarballBytes = (members: readonly TarMember[]): Buffer => gzipSync(tarBytes(members))

/**
 * A minimal, valid provider package: a manifest with import-only `exports` (the shape every
 * provider in this repository has, and the one that broke `require.resolve`) and the file it
 * points at.
 */
export function providerPackageMembers(options: {
  name: string
  version: string
  /** Extra or replacement members, applied after the two below. */
  extra?: readonly TarMember[]
  /** Written into the manifest as `dependencies`. */
  dependencies?: Record<string, string>
}): TarMember[] {
  const manifest = {
    name: options.name,
    version: options.version,
    type: 'module',
    exports: { '.': { import: './index.js' } },
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    scripts: { postinstall: 'node -e "throw new Error(\'this must never run\')"' },
  }
  return [
    { name: 'package/package.json', body: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'package/index.js', body: 'export default { id: "fixture" }\n' },
    ...(options.extra ?? []),
  ]
}
