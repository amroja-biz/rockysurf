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
    // A registry has no packs until its first contribution, and its CI would otherwise be red
    // from the day the repository is created. The caller says so explicitly; this function
    // cannot tell that case from a typo.
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
    // An explicit empty base directory REPLACES the bundled default, which is what makes this
    // a test of --base-packs rather than of the fallback behind it.
    expect(runPackCommand(['lint', dir, '--base-packs', dirWith({})], capture().io)).toBe(1)
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

describe('--base-packs defaults to the packs this rockysurf ships', () => {
  // rockysurf-io02. Before the packs were in the tarball, a registry's CI had to clone the Rocky
  // Surf repository just to point this flag somewhere; now it resolves out of the version the
  // registry already pins.
  const community = () =>
    dirWith({
      'rust-dev.yaml': {
        version: 1,
        pack: { packId: 'rust-dev', name: 'Rust', tools: ['claude-code'], displayOrder: 9, enabled: true },
        tools: [],
      },
    })

  it('resolves a base tool reference with no flag at all', () => {
    const io = capture()
    expect(runPackCommand(['lint', community()], io.io)).toBe(0)
  })

  it('an explicit --base-packs replaces the default rather than adding to it', () => {
    // Somebody who names a directory means that directory. Quietly unioning it with a set they
    // did not ask for is how a check passes against tools the target installation will not have.
    const io = capture()
    const empty = dirWith({})
    expect(runPackCommand(['lint', community(), '--base-packs', empty], io.io)).toBe(1)
    expect(io.err.join('\n')).toContain('unknown tool "claude-code"')
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

describe('rockysurf pack describe', () => {
  /**
   * The reviewer-side half of the disclosure (rockysurf-arym.8). What the control plane shows an
   * operator before they consent, on the command line, so a registry's CI can put it in front of
   * whoever is reviewing a community pull request.
   */
  const OWN = {
    ...TOOL,
    toolId: 'my-tool',
    runAs: 'rocky',
    installScript: 'curl -fsSL https://example.com/install.sh | sh\n',
  }
  const community = () =>
    dirWith({
      'my-pack.yaml': {
        version: 1,
        pack: {
          packId: 'my-pack',
          name: 'My Pack',
          tools: ['claude-code', 'my-tool'],
          displayOrder: 9,
          enabled: true,
        },
        tools: [OWN],
      },
    })

  it('reports the root-step count and every URL the scripts fetch', () => {
    const io = capture()
    expect(runPackCommand(['describe', community(), '--pack', 'my-pack'], io.io)).toBe(0)
    const out = io.out.join('\n')
    expect(out).toContain('https://example.com/install.sh')
    // claude-code and its own dependencies run as root; my-tool does not.
    expect(out).toMatch(/install step\(s\), of which \d+ run as root/)
  })

  it('shows the pack’s OWN scripts in full and only names the ones it borrows', () => {
    // A pack borrowing nine base tools would otherwise bury its own twenty lines under six
    // hundred a reviewer has read a hundred times, which is how a review becomes a scroll.
    const io = capture()
    runPackCommand(['describe', community(), '--pack', 'my-pack', '--markdown'], io.io)
    const out = io.out.join('\n')
    expect(out).toContain('curl -fsSL https://example.com/install.sh')
    expect(out).toContain('Tools it borrows, defined elsewhere')
    expect(out).toContain('`claude-code`')
    // The borrowed tool's script body is NOT dumped into the comment.
    expect(out).not.toContain('claude-code@latest')
  })

  it('carries the incompleteness caveat in every form', () => {
    // A list of URLs without this sentence tells a reader they have seen every download, and a
    // script that builds one from a variable makes that false. It travels with the output.
    for (const extra of [[], ['--markdown']]) {
      const io = capture()
      runPackCommand(['describe', community(), '--pack', 'my-pack', ...extra], io.io)
      expect(io.out.join('\n')).toContain('cannot be complete')
    }
  })

  it('emits the whole derivation under --json, matching what an operator’s page is built from', () => {
    const io = capture()
    expect(runPackCommand(['describe', community(), '--pack', 'my-pack', '--json'], io.io)).toBe(0)
    const parsed = JSON.parse(io.out.join('\n'))
    expect(parsed.packId).toBe('my-pack')
    expect(parsed.definesTools).toEqual(['my-tool'])
    // Nothing is hidden by the markdown split — the borrowed tools are all here.
    expect(parsed.disclosure.tools.length).toBeGreaterThan(1)
    expect(parsed.disclosure.summaryIsComplete).toBe(false)
  })

  it('refuses to describe a pack that does not validate', () => {
    // A pack the runtime would refuse cannot be described honestly, and 2 says "could not run"
    // rather than "the pack failed a check".
    const io = capture()
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: { ...PACK, tools: ['nope'] }, tools: [] } })
    expect(runPackCommand(['describe', dir], io.io)).toBe(2)
    expect(io.err.join('\n')).toContain('does not validate')
  })

  it('resolves the base toolchain, so a well-behaved pack is describable at all', () => {
    // Without this it would report every correctly-referenced base tool as unknown and refuse —
    // the same trap the lint's --base-packs default exists for.
    const io = capture()
    expect(runPackCommand(['describe', community(), '--pack', 'my-pack'], io.io)).toBe(0)
  })

  it('exits 2 when no pack matches --pack', () => {
    const io = capture()
    expect(runPackCommand(['describe', community(), '--pack', 'nope'], io.io)).toBe(2)
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
    mkdirSync(join(root, 'packs/one'), { recursive: true })
    mkdirSync(join(root, 'packs/two'), { recursive: true })
    writeFileSync(
      join(root, 'packs/one/base.yaml'),
      JSON.stringify({
        version: 1,
        pack: { packId: 'base', name: 'Base', tools: ['a-tool'], displayOrder: 1, enabled: true },
        tools: [TOOL],
      }),
    )
    writeFileSync(
      join(root, 'packs/two/extra.yaml'),
      JSON.stringify({
        version: 1,
        pack: { packId: 'extra', name: 'Extra', tools: ['a-tool'], displayOrder: 2, enabled: true },
        tools: [],
      }),
    )
    return root
  }

  const SOURCES = ['--source', 'packs/one', '--source', 'packs/two']

  it('writes an index resolving references across its source directories', () => {
    const io = capture()
    const root = registry()
    const code = inDir(root, () => runPackCommand(['index', ...SOURCES], io.io))
    expect(code).toBe(0)

    const index = JSON.parse(io.out.join('\n'))
    expect(index.packs.map((p: { packId: string }) => p.packId)).toEqual(['base', 'extra'])
    expect(index.packs[1].referencesTools).toEqual(['a-tool'])
    // No trust label anywhere in the document: a pack's label comes from where the OPERATOR got
    // it, never from something the registry wrote about itself.
    expect(index.packs.every((p: Record<string, unknown>) => !('tier' in p) && !('trust' in p))).toBe(true)
  })

  it('resolves against --base-packs, which a purely-community registry needs', () => {
    // The shop holds no base toolchain — it ships in the Rocky Surf tarball — so a pack
    // referencing `claude-code` cannot be indexed without being told where that lives.
    const io = capture()
    const root = registry()
    writeFileSync(
      join(root, 'packs/two/borrows.yaml'),
      JSON.stringify({
        version: 1,
        pack: { packId: 'borrows', name: 'Borrows', tools: ['claude-code'], displayOrder: 3, enabled: true },
        tools: [],
      }),
    )
    // Against an explicitly empty base directory it fails; against the real one it resolves.
    // Naming a directory replaces the bundled default rather than adding to it, so the negative
    // half of this test still means something now that a default exists.
    const empty = dirWith({})
    expect(inDir(root, () => runPackCommand(['index', ...SOURCES, '--base-packs', empty], capture().io))).toBe(1)
    expect(
      inDir(root, () => runPackCommand(['index', ...SOURCES, '--base-packs', shippedPacksDir], io.io)),
    ).toBe(0)
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
    const code = inDir(root, () => runPackCommand(['index', '--source', 'packs/nope'], io.io))
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('does not exist')
  })

  it('exits 1 when given no sources at all', () => {
    const io = capture()
    const root = registry()
    expect(inDir(root, () => runPackCommand(['index'], io.io))).toBe(1)
    expect(io.err.join('\n')).toContain('--source')
  })

  it('exits 1 when a pack in the registry does not load', () => {
    const io = capture()
    const root = registry()
    writeFileSync(join(root, 'packs/two/broken.yaml'), 'pack: [unclosed\n')
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
