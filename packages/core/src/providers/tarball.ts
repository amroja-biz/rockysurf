import { gunzipSync } from 'node:zlib'

/**
 * Reading an npm-style tarball, by hand, refusing everything that is not a plain file (ADR-0028).
 *
 * WHY NOT A TAR LIBRARY. Core's dependency list is short on purpose and every entry in it is a
 * thing an `npx rockysurf` cold start pays for. More to the point, the security properties this
 * module has to hold — no absolute paths, no `..`, no symlinks, no hardlinks, no device nodes, a
 * cap on entry count and on total uncompressed size — are ones a general-purpose extractor
 * offers as options that a caller can forget to pass. Written here they are not optional: the
 * parser has no code path that produces a symlink, because it refuses the header rather than
 * ignoring it.
 *
 * WHAT AN NPM TARBALL IS. `npm pack` and `pnpm pack` both emit a gzipped ustar archive in which
 * every member is rooted at a single `package/` directory. That prefix is the contract rather
 * than a convention worth being lenient about: requiring it means a member cannot name a path
 * outside the tree even before the traversal checks run, and an archive that is not an npm
 * package is refused for being the wrong shape instead of being half-extracted.
 *
 * WHAT IS NOT EXECUTED. Nothing. This module returns bytes in a map; the caller writes them to
 * disk. `scripts` in a `package.json` are data here — never run, at install time or ever, because
 * nothing in Rocky Surf invokes npm. A provider package's code runs at the NEXT restart, when the
 * personal-provider loader imports it, and that is the moment the operator consented to.
 */

/** 512 bytes, the ustar block. */
const BLOCK = 512

/** The prefix every member of an npm tarball is under, and the only one accepted. */
const NPM_ROOT = 'package/'

export interface ExtractLimits {
  /** How many members the archive may have. A package with more is not a provider. */
  maxEntries: number
  /** Total UNCOMPRESSED bytes. The cap a gzip bomb runs into, since the wire cap cannot see it. */
  maxTotalBytes: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 4_000,
  maxTotalBytes: 64 * 1024 * 1024,
}

export class TarballError extends Error {}

const field = (block: Buffer, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8')
}

/** Octal, space-padded, occasionally empty. Base-256 sizes are a GNU extension npm never emits. */
function octal(block: Buffer, offset: number, length: number): number {
  const text = field(block, offset, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) throw new TarballError('the archive has a malformed header field')
  return value
}

/** A block of nothing but NULs — the end-of-archive marker, and the padding after it. */
const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0)

/**
 * The path checks, applied to every member before it is ever a filename.
 *
 * Each refusal names what it refused rather than saying "invalid": an operator looking at this
 * message is deciding whether a package is hostile or merely built oddly, and the difference is
 * the whole content of the answer.
 */
function safeRelativePath(name: string): string {
  if (name.includes('\0')) throw new TarballError('the archive names a path containing a NUL byte')
  if (name.startsWith('/')) throw new TarballError(`the archive names an absolute path (${name})`)
  if (/^[a-zA-Z]:[\\/]/.test(name)) throw new TarballError(`the archive names an absolute path (${name})`)
  if (name.includes('\\')) throw new TarballError(`the archive names a path with a backslash in it (${name})`)
  if (!name.startsWith(NPM_ROOT)) {
    throw new TarballError(
      `the archive has a member outside "${NPM_ROOT}" (${name}) — an npm package tarball roots everything under it`,
    )
  }
  const relative = name.slice(NPM_ROOT.length)
  if (relative.split('/').some((segment) => segment === '..')) {
    throw new TarballError(`the archive names a path that climbs out of the package (${name})`)
  }
  return relative
}

/** The member kinds this refuses, each with the word an operator would search for. */
const REFUSED_TYPES: Record<string, string> = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  '7': 'a contiguous file',
}

/**
 * Every regular file in a gzipped npm tarball, keyed by its path WITHOUT the `package/` prefix.
 *
 * Directories are dropped: the writer creates whatever a file's path needs, so an archive that
 * omits its directory members (some do) and one that lists them produce the same tree. Empty
 * directories are therefore not preserved, which no package depends on.
 */
export function readNpmTarball(gzipped: Buffer, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Map<string, Buffer> {
  let tar: Buffer
  try {
    tar = gunzipSync(gzipped)
  } catch (err) {
    throw new TarballError(`the archive is not gzip data: ${(err as Error).message}`)
  }
  if (tar.length % BLOCK !== 0) throw new TarballError('the archive is truncated (its length is not a multiple of 512)')

  const files = new Map<string, Buffer>()
  let total = 0
  /** A pax header's `path=` record applies to the NEXT member and nothing after it. */
  let paxPath: string | undefined

  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (isZeroBlock(header)) break

    // POSIX writes "ustar\0", GNU writes "ustar " — both are read, nothing else is.
    if (field(header, 257, 6).trimEnd() !== 'ustar') {
      throw new TarballError('the archive is not a ustar tarball')
    }

    const size = octal(header, 124, 12)
    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK
    if (offset + dataBlocks > tar.length) throw new TarballError('the archive is truncated')
    const data = tar.subarray(offset, offset + size)
    offset += dataBlocks

    const type = field(header, 156, 1)
    if (type === 'x' || type === 'X') {
      paxPath = paxPathOf(data) ?? paxPath
      continue
    }
    // A GLOBAL pax header applies to every following member, which is a thing npm does not emit
    // and a thing this parser will not guess at. Skipped, and any per-member override still wins.
    if (type === 'g') continue
    if (type === 'L' || type === 'K') {
      throw new TarballError('the archive uses GNU long-name headers, which this installer does not read')
    }

    const prefix = field(header, 345, 155)
    const name = paxPath ?? (prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`)
    paxPath = undefined

    if (type === '5') {
      safeRelativePath(name.endsWith('/') ? name : `${name}/`)
      continue
    }
    const refused = REFUSED_TYPES[type]
    if (refused) throw new TarballError(`the archive contains ${refused} (${name}), which this installer refuses`)
    if (type !== '' && type !== '0') {
      throw new TarballError(`the archive contains a member of an unknown kind (${name}, type "${type}")`)
    }

    const relative = safeRelativePath(name)
    if (relative === '') continue
    if (files.size + 1 > limits.maxEntries) {
      throw new TarballError(`the archive has more than ${limits.maxEntries} files`)
    }
    total += size
    if (total > limits.maxTotalBytes) {
      throw new TarballError(`the archive unpacks to more than ${limits.maxTotalBytes} bytes`)
    }
    files.set(relative, Buffer.from(data))
  }

  if (files.size === 0) throw new TarballError('the archive contains no files')
  return files
}

/** The `path=` record of a pax extended header, which is how a long member name arrives. */
function paxPathOf(data: Buffer): string | undefined {
  let found: string | undefined
  for (const line of data.toString('utf8').split('\n')) {
    // "%d path=%s" — the length prefix is redundant once the record is split on newlines.
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match) found = match[1]
  }
  return found
}
