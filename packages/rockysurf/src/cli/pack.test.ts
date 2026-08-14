import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRockysurfCli } from '../cli.js'
import { runPackCommand } from './pack.js'

/**
 * `rockysurf pack`, tested through the real dispatch.
 *
 * CONTRIBUTING.md's seam rule applies here for a reason that is specific rather than
 * ceremonial: this command exists so that a repository which is NOT this one — the pack shop
 * (rockysurf-arym.1) — can run it as `npx rockysurf pack lint`. A test that called
 * `runPackCommand` directly would pass while `rockysurf pack` printed a usage error, and the
 * only person to find out would be a contributor whose pull request could not be checked. So
 * the wiring tests go through `runRockysurfCli`, which is what the published binary calls.
 *
 * The exit codes are part of the contract too. The shop's CI has to tell a pack that FAILED the
 * check (1) from a runner that could not RUN it (2), because those need different humans.
 */

const shippedPacksDir = fileURLToPath(new URL('../../../../packs/', import.meta.url))

const scratchDirs: string[] = []
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const TOOL = {
  toolId: 'a-tool',
  name: 'A tool',
  description: 'Does a thing',
  category: 'base',
  url: 'https://example.com',
  installScript: 'echo hi\n',
  enabled: true,
  installOrder: 30,
  bootstrap: false,
  runAs: 'root',
}
const PACK = { packId: 'a-pack', name: 'A pack', tools: ['a-tool'], displayOrder: 1, enabled: true }

function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-pack-cli-'))
  scratchDirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

/** Capture what the command wrote, without touching the real streams. */
function capture() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

describe('rockysurf pack lint', () => {
  it('passes this repository’s own packs/', () => {
    const io = capture()
    expect(runPackCommand(['lint', shippedPacksDir], io.io)).toBe(0)
    expect(io.out.join('\n')).toContain('no findings')
  })

  it('exits 1 and prints the finding when a pack is malformed', () => {
    const io = capture()
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: { ...PACK, tools: ['nope'] }, tools: [] } })
    expect(runPackCommand(['lint', dir], io.io)).toBe(1)
    expect(io.err.join('\n')).toContain('unknown tool "nope"')
  })

  it('exits 1 on a directory with no pack files rather than reporting success', () => {
    // The commonest way to get a green check you have not earned is to point it at the wrong
    // path. A gate that congratulates you for that is worse than no gate: the shop would merge
    // on it.
    const io = capture()
    expect(runPackCommand(['lint', dirWith({})], io.io)).toBe(1)
    expect(io.err.join('\n')).toContain('holds no pack files')
  })

  it('accepts an empty directory under --allow-empty', () => {
    // A registry's community tier is empty until its first contribution, and its CI would
    // otherwise be red from the day the repository is created. The caller says so explicitly;
    // this function cannot tell that case from a typo.
    const io = capture()
    expect(runPackCommand(['lint', dirWith({}), '--allow-empty'], io.io)).toBe(0)
  })

  it('--allow-empty does not excuse a directory whose packs are broken', () => {
    // It relaxes "there is nothing here", never "what is here is wrong".
    const io = capture()
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: { ...PACK, tools: ['nope'] }, tools: [] } })
    expect(runPackCommand(['lint', dir, '--allow-empty'], io.io)).toBe(1)
  })

  it('resolves references against --base-packs, repeatably', () => {
    const io = capture()
    const dir = dirWith({
      'rust-dev.yaml': {
        version: 1,
        pack: { packId: 'rust-dev', name: 'Rust', tools: ['claude-code'], displayOrder: 9, enabled: true },
        tools: [],
      },
    })
    expect(runPackCommand(['lint', dir], capture().io)).toBe(1)
    expect(runPackCommand(['lint', dir, '--base-packs', shippedPacksDir], io.io)).toBe(0)
  })

  it('accepts --flag=value as well as --flag value', () => {
    const dir = dirWith({
      'rust-dev.yaml': {
        version: 1,
        pack: { packId: 'rust-dev', name: 'Rust', tools: ['claude-code'], displayOrder: 9, enabled: true },
        tools: [],
      },
    })
    expect(runPackCommand(['lint', dir, `--base-packs=${shippedPacksDir}`], capture().io)).toBe(0)
  })

  it('finds the directory when it follows a flag that takes a value', () => {
    // `pack lint --base-packs <dir> <target>` is the order a CI YAML tends to produce, and a
    // naive "first non-flag argument" reads the base directory as the target — which lints the
    // wrong tree and passes.
    const io = capture()
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: PACK, tools: [TOOL] } })
    expect(runPackCommand(['lint', '--base-packs', shippedPacksDir, dir], io.io)).toBe(0)
    expect(io.out.join('\n')).toContain('a-pack')
  })

  it('emits a machine-readable document under --json', () => {
    const io = capture()
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: PACK, tools: [{ ...TOOL, bootstrap: true }] } })
    expect(runPackCommand(['lint', dir, '--json'], io.io)).toBe(1)
    const report = JSON.parse(io.out.join('\n'))
    expect(report.ok).toBe(false)
    expect(report.findings[0]).toMatchObject({ rule: 'reserved-field', file: 'a-pack.yaml' })
  })

  it('groups findings by rule in the summary', () => {
    const io = capture()
    const dir = dirWith({
      'a-pack.yaml': {
        version: 1,
        pack: PACK,
        tools: [{ ...TOOL, bootstrap: true, installOrder: 999, installScript: 'read -p "x" y\n' }],
      },
    })
    expect(runPackCommand(['lint', dir], io.io)).toBe(1)
    expect(io.err.join('\n')).toMatch(/pack lint: \d+ finding\(s\) — /)
  })
})

describe('usage', () => {
  it.each([[[]], [['lint']], [['check']], [['nonsense']]])('exits 1 and prints usage for %j', (argv) => {
    const io = capture()
    expect(runPackCommand(argv, io.io)).toBe(1)
    expect(io.err.join('\n')).toContain('usage: rockysurf pack')
  })

  it('says plainly that it is not a security scan', () => {
    // The issue this command comes from (#9) asks for packs to be "scanned to ensure they are
    // secure". An install script is arbitrary root-privileged shell and no static check can
    // decide whether it is benign, so the help must not let anyone believe otherwise.
    const io = capture()
    runPackCommand([], io.io)
    expect(io.err.join('\n')).toContain('Neither command is a security scan')
  })
})

describe('rockysurf pack check', () => {
  it('rejects an architecture it cannot run, with exit 2', () => {
    // 2 is "could not run the check", distinct from 1's "the pack failed it".
    const io = capture()
    expect(runPackCommand(['check', shippedPacksDir, '--arch', 'riscv'], io.io)).toBe(2)
    expect(io.err.join('\n')).toContain('--arch must be one of')
  })

  it('refuses to smoke-test a directory that does not lint, and says why', () => {
    // The fast check has to come first or it is not worth having: a schema error should not
    // surface as a container failure twenty minutes later.
    const io = capture()
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: { ...PACK, tools: ['nope'] }, tools: [] } })
    expect(runPackCommand(['check', dir], io.io)).toBe(2)
    expect(io.err.join('\n')).toContain('does not validate')
  })

  it('exits 2 rather than 1 when no pack matches --pack', () => {
    const io = capture()
    expect(runPackCommand(['check', shippedPacksDir, '--pack', 'not-a-pack'], io.io)).toBe(2)
    expect(io.err.join('\n')).toContain('no pack called "not-a-pack"')
  })
})

describe('rockysurf pack index', () => {
  /**
   * `--source` paths are resolved against the CWD, because the path recorded in the index has
   * to be the path a client fetches — which only holds if the generator ran from the registry
   * root. So these tests chdir, and restore.
   */
  const inDir = <T,>(dir: string, fn: () => T): T => {
    const previous = process.cwd()
    process.chdir(dir)
    try {
      return fn()
    } finally {
      process.chdir(previous)
    }
  }

  function registry(): string {
    const root = mkdtempSync(join(tmpdir(), 'rockysurf-registry-cli-'))
    scratchDirs.push(root)
    mkdirSync(join(root, 'packs/official'), { recursive: true })
    mkdirSync(join(root, 'packs/community'), { recursive: true })
    writeFileSync(
      join(root, 'packs/official/base.yaml'),
      JSON.stringify({
        version: 1,
        pack: { packId: 'base', name: 'Base', tools: ['a-tool'], displayOrder: 1, enabled: true },
        tools: [TOOL],
      }),
    )
    writeFileSync(
      join(root, 'packs/community/extra.yaml'),
      JSON.stringify({
        version: 1,
        pack: { packId: 'extra', name: 'Extra', tools: ['a-tool'], displayOrder: 2, enabled: true },
        tools: [],
      }),
    )
    return root
  }

  const SOURCES = ['--source', 'packs/official=official', '--source', 'packs/community=community']

  it('writes an index that labels each tier and resolves references across them', () => {
    const io = capture()
    const root = registry()
    const code = inDir(root, () => runPackCommand(['index', ...SOURCES], io.io))
    expect(code).toBe(0)

    const index = JSON.parse(io.out.join('\n'))
    expect(index.packs.map((p: { packId: string; tier: string }) => [p.packId, p.tier])).toEqual([
      ['base', 'official'],
      ['extra', 'community'],
    ])
    expect(index.packs[1].referencesTools).toEqual(['a-tool'])
  })

  it('writes to --out and says where', () => {
    const io = capture()
    const root = registry()
    const code = inDir(root, () => runPackCommand(['index', ...SOURCES, '--out', 'index.json'], io.io))
    expect(code).toBe(0)
    // stdout stays empty so a caller redirecting it to a file does not get the document twice.
    expect(io.out).toEqual([])
    expect(io.err.join('\n')).toContain('wrote index.json')
    expect(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')).version).toBe(1)
  })

  it('exits 2 when a --source directory is not there', () => {
    // The silent-failure shape this guards: a CI job renames a directory, the index publishes
    // without half the registry, and nothing errors — every operator's shop quietly loses its
    // community packs.
    const io = capture()
    const root = registry()
    const code = inDir(root, () => runPackCommand(['index', '--source', 'packs/nope=community'], io.io))
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('does not exist')
  })

  it.each([
    ['no sources at all', ['index']],
    ['a source with no tier', ['index', '--source', 'packs/community']],
    ['a tier nobody defined', ['index', '--source', 'packs/community=verified']],
  ])('exits 1 on %s', (_label, argv) => {
    const io = capture()
    const root = registry()
    expect(inDir(root, () => runPackCommand(argv, io.io))).toBe(1)
  })

  it('exits 1 when a pack in the registry does not load', () => {
    const io = capture()
    const root = registry()
    writeFileSync(join(root, 'packs/community/broken.yaml'), 'pack: [unclosed\n')
    expect(inDir(root, () => runPackCommand(['index', ...SOURCES], io.io))).toBe(1)
    expect(io.err.join('\n')).toContain('cannot be indexed')
  })
})

describe('the seam: `rockysurf pack` reaches the command through the real dispatch', () => {
  // This is the assertion the shop actually depends on. Everything above could pass while
  // `npx rockysurf pack lint` printed a usage error from the top-level CLI.
  it('dispatches lint and returns its exit code, without booting core', async () => {
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(runRockysurfCli(['pack', 'lint', shippedPacksDir])).resolves.toBe(0)
    expect(written.join('')).toContain('no findings')
  })

  it('dispatches a failing lint as a non-zero exit code', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: { ...PACK, tools: ['nope'] }, tools: [] } })
    await expect(runRockysurfCli(['pack', 'lint', dir])).resolves.toBe(1)
  })
})
