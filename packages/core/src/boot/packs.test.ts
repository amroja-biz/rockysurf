import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/client.js'
import { getPack, listPacks, listTools, upsertPack } from '../db/repositories/packs.js'
import { resolvePacksDir, syncPacksAtBoot } from './packs.js'

/** The repository's own packs/ — the checkout case, and the shipped set gonw.8 authored. */
const repoPacksDir = fileURLToPath(new URL('../../../../packs', import.meta.url))

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-boot-packs-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Every YAML file in `packs/` — what a fixture directory has to hold to load at all. */
const shippedFiles = () => readdirSync(repoPacksDir).filter((f) => f.endsWith('.yaml'))

/**
 * How many of them define a pack. Not the same number since issue #499: `packs/base.yaml` is a
 * TOOL FILE holding the shared base toolchain, so it becomes tool rows and never a pack row.
 */
const shippedPackCount = () =>
  shippedFiles().filter((f) => /^pack:/m.test(readFileSync(join(repoPacksDir, f), 'utf8'))).length

describe('choosing a packs directory', () => {
  it('prefers ./packs when it exists — the checkout case', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'packs'))
    const resolved = resolvePacksDir(join(cwd, 'data'), cwd)

    expect(resolved.source).toBe('checkout')
    expect(resolved.dir).toBe(join(cwd, 'packs'))
  })

  it('falls back to the packs this release ships — the installed case', () => {
    // Was `data-dir`, and an empty one, which is the whole of rockysurf-io02: a published
    // install had no pack files anywhere and came up with an empty picker. `bundled-packs.test.ts`
    // covers the tiering; this asserts the case an `npx` user actually lands in.
    expect(resolvePacksDir(join(tempDir(), 'data'), tempDir())).toMatchObject({ source: 'bundled' })
  })
})

describe('syncing packs at boot', () => {
  it("loads the repository's shipped packs", () => {
    const opened = openTestDatabase()
    const messages: string[] = []
    const cwd = tempDir()
    // Point the checkout branch at the real packs/ directory.
    const result = syncPacksAtBoot({
      db: opened.db,
      dataDir: join(cwd, 'data'),
      cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
      log: (m) => messages.push(m),
    })

    expect(result.source).toBe('checkout')
    expect(result.skippedFiles).toEqual([])
    expect(result.packsSynced).toBe(shippedPackCount())
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount())
    expect(result.toolsSynced).toBeGreaterThan(0)
    expect(messages.join('\n')).toMatch(/packs: \d+ pack\(s\), \d+ tool\(s\)/)
    opened.close()
  })

  it('serves the shipped packs on a fresh installation', () => {
    // The inversion of what this test used to assert. It read "serves with ZERO packs on a fresh
    // installation, creating the directory" and passed, because that was true and wrong: the
    // published package carried no pack files, so a first `npx rockysurf` offered nothing to
    // create a server with (rockysurf-io02). The empty directory was the symptom, and asserting
    // it kept the symptom pinned.
    const opened = openTestDatabase()
    const messages: string[] = []

    const result = syncPacksAtBoot({
      db: opened.db,
      dataDir: join(tempDir(), 'data'),
      cwd: tempDir(),
      log: (m) => messages.push(m),
    })

    expect(result.source).toBe('bundled')
    expect(result.packsSynced).toBeGreaterThan(0)
    expect(listPacks(opened.db).length).toBeGreaterThan(0)
    opened.close()
  })

  it('loads the valid files and logs the broken one, rather than failing the boot', () => {
    const opened = openTestDatabase()
    const cwd = tempDir()
    const packsDir = join(cwd, 'packs')
    mkdirSync(packsDir)

    for (const file of shippedFiles()) copyFileSync(join(repoPacksDir, file), join(packsDir, file))
    // A file that parses as YAML but is not a valid pack: the validator names the field.
    writeFileSync(join(packsDir, 'broken.yaml'), 'version: 1\npack:\n  packId: broken\ntools: []\n')

    const messages: string[] = []
    const result = syncPacksAtBoot({ db: opened.db, dataDir: join(cwd, 'data'), cwd, log: (m) => messages.push(m) })

    // The good ones landed...
    expect(result.packsSynced).toBe(shippedPackCount())
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount())
    expect(listTools(opened.db).length).toBeGreaterThan(0)

    // ...and the bad one was named, verbatim, with its file.
    expect(result.skippedFiles).toEqual(['broken.yaml'])
    const log = messages.join('\n')
    expect(log).toContain('broken.yaml')
    expect(log).toContain('1 file(s) skipped')
    opened.close()
  })

  it('does not throw on a file that is not YAML at all', () => {
    const opened = openTestDatabase()
    const cwd = tempDir()
    mkdirSync(join(cwd, 'packs'))
    writeFileSync(join(cwd, 'packs', 'garbage.yaml'), '{{{ not yaml at all')

    const messages: string[] = []
    expect(() =>
      syncPacksAtBoot({ db: opened.db, dataDir: join(cwd, 'data'), cwd, log: (m) => messages.push(m) }),
    ).not.toThrow()
    expect(messages.join('\n')).toContain('garbage.yaml')
    opened.close()
  })

  it('keeps the database packs when a boot happens away from the checkout (rockysurf-96ce)', () => {
    const opened = openTestDatabase()
    const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
    const dataDir = join(tempDir(), 'data')
    const messages: string[] = []
    const log = (m: string) => messages.push(m)

    // An admin-created pack, which no boot may ever touch: its sourceFile is null.
    upsertPack(opened.db, {
      id: 'admin-made',
      name: 'Admin Made',
      tools: [],
      displayOrder: 99,
      enabled: true,
      requiresRepos: false,
      requiresRdp: false,
      sourceFile: null,
    })

    // Boot A — inside the checkout. The shipped packs land.
    const a = syncPacksAtBoot({ db: opened.db, dataDir, cwd: repoRoot, log })
    expect(a.source).toBe('checkout')
    expect(a.packsSynced).toBe(shippedPackCount())

    // Boot B — same data directory, started from a directory with no packs/ in sight. Since
    // 8wgm the app boots happily from anywhere, so this is an ordinary thing to do.
    //
    // WHAT CHANGED WITH rockysurf-io02, and it is worth being precise. This boot used to have NO
    // pack source at all and therefore drew no conclusion. Now it falls back to the packs the
    // release ships, so it DOES reconcile — against a set identical to the one boot A loaded
    // from the checkout, which is why the catalog is unchanged either way.
    //
    // The consequence, stated rather than discovered: a boot from the bundle reconciles against
    // the SHIPPED set, so a pack that exists only in somebody's checkout is removed by a boot
    // taken outside it. That is the same rule a checkout boot has always had — a file the source
    // no longer offers goes away — applied to a second legitimate source, and it is recoverable
    // by booting from the checkout again. 96ce's actual guarantee is untouched and is asserted
    // by the next test: a boot that loads NO pack at all still deletes nothing.
    const b = syncPacksAtBoot({ db: opened.db, dataDir, cwd: tempDir(), log })
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount() + 1)
    expect(b.reconciled).toBe(true)

    // Boot C — back in the checkout. Still the same set, no duplicates, no losses.
    const c = syncPacksAtBoot({ db: opened.db, dataDir, cwd: repoRoot, log })
    expect(c.packsSynced).toBe(shippedPackCount())
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount() + 1)
    expect(getPack(opened.db, 'admin-made')).toBeDefined()
    opened.close()
  })

  it('leaves the database alone when the packs directory exists but holds no pack files', () => {
    const opened = openTestDatabase()
    const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
    const dataDir = join(tempDir(), 'data')
    const messages: string[] = []
    const log = (m: string) => messages.push(m)

    syncPacksAtBoot({ db: opened.db, dataDir, cwd: repoRoot, log })
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount())

    // A checkout-shaped cwd whose packs/ is present and empty. Indistinguishable from the
    // <dataDir>/packs this very function creates on a fresh install, so it deletes nothing.
    const emptyCheckout = tempDir()
    mkdirSync(join(emptyCheckout, 'packs'))
    const result = syncPacksAtBoot({ db: opened.db, dataDir, cwd: emptyCheckout, log })

    expect(result.source).toBe('checkout')
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount())
    expect(result.reconciled).toBe(false)
    expect(messages.at(-1)).toContain('holds no pack files')
    opened.close()
  })

  it('still deletes the rows of a single pack file that went away (rockysurf-a0ss)', () => {
    const opened = openTestDatabase()
    const cwd = tempDir()
    const packsDir = join(cwd, 'packs')
    mkdirSync(packsDir)

    const shipped = shippedFiles()
    for (const file of shipped) copyFileSync(join(repoPacksDir, file), join(packsDir, file))
    const args = { db: opened.db, dataDir: join(cwd, 'data'), cwd, log: () => {} }

    syncPacksAtBoot(args)
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount())

    // A leaf pack: nothing else references a tool it owns, so removing it is a one-pack change
    // rather than a cascade. (Removing base.yaml is not — it owns the base tools every pack
    // lists, which is the case the guard below covers.) This used to be `open-code.yaml`, which
    // stopped being a leaf when `kitchen-sink` started listing `opencode`; `deepseek-harness` is
    // a web UI rather than a terminal agent, so `kitchen-sink` does not carry it.
    const gone = 'deepseek-harness.yaml'
    expect(shipped).toContain(gone)
    rmSync(join(packsDir, gone))
    const result = syncPacksAtBoot(args)

    expect(result.reconciled).toBe(true)
    expect(listPacks(opened.db)).toHaveLength(shippedPackCount() - 1)
    expect(listPacks(opened.db).map((p) => p.sourceFile)).not.toContain(gone)
    opened.close()
  })

  /**
   * THE POINT OF ISSUE #499, asserted where it actually mattered.
   *
   * A pack file that fails to parse is skipped at boot. While `claude-code.yaml` defined the
   * shared base toolchain, skipping it took every OTHER pack's tool references with it, not one
   * of the packs loaded, and the picker came up empty — one typo in one pack costing the whole
   * catalog. Now the definitions are in `base.yaml`, and the blast radius is exactly the packs
   * that genuinely install Claude Code.
   *
   * That is three packs rather than one, and the other two are the honest kind of dependency:
   * `gas-town` and `kitchen-sink` list the `claude-code` TOOL because those boxes run Claude Code,
   * so a file that can no longer define it costs them too. What ended is the accidental kind,
   * where `omp` needed the Claude Code pack's file to parse in order to find `curl`.
   */
  it('breaking claude-code.yaml costs the packs that install it, not the picker (#499)', () => {
    const opened = openTestDatabase()
    const cwd = tempDir()
    const packsDir = join(cwd, 'packs')
    mkdirSync(packsDir)

    for (const file of shippedFiles()) copyFileSync(join(repoPacksDir, file), join(packsDir, file))
    // Broken the way a hand edit breaks a file: still YAML, no longer a pack.
    writeFileSync(join(packsDir, 'claude-code.yaml'), 'version: 1\npack:\n  packId: claude-code\ntools: []\n')

    const messages: string[] = []
    const result = syncPacksAtBoot({ db: opened.db, dataDir: join(cwd, 'data'), cwd, log: (m) => messages.push(m) })

    expect(result.reconciled).toBe(true)
    // gas-town and kitchen-sink for the reason above; nothing else references a tool the broken
    // file owned (`claude-code` itself, and the herdr hook that only means anything beside it).
    expect(result.skippedFiles).toEqual(['claude-code.yaml', 'gas-town.yaml', 'kitchen-sink.yaml'])
    expect(result.packsSynced).toBe(shippedPackCount() - 3)

    const ids = listPacks(opened.db).map((p) => p.id)
    expect(ids).not.toContain('claude-code')
    expect(ids).toEqual(
      expect.arrayContaining(['amp-agents', 'codex-cli', 'cursor-cli', 'deepseek-harness', 'omp', 'open-code', 'pi']),
    )
    // The base tools are still there for the packs that reference them — the cascade that used
    // to follow is what this file split ended.
    expect(listTools(opened.db).map((t) => t.id)).toEqual(expect.arrayContaining(['git', 'nodejs', 'beads']))
    opened.close()
  })

  it('leaves the database alone when no file validated at all', () => {
    const opened = openTestDatabase()
    const cwd = tempDir()
    const packsDir = join(cwd, 'packs')
    mkdirSync(packsDir)

    /**
     * Two files written here rather than carved out of the repository's `packs/`: `zz-owner`
     * defines the tool, `zz-leaf` only references it, so deleting the owner leaves a directory
     * that HAS a pack file and can load nothing from it — the state under test.
     *
     * The shipped set is not a fixture. This test used to build the same state by deleting
     * `claude-code.yaml` and relying on every other shipped file referencing the base
     * tools it owns — which stops being true the moment anyone adds a self-contained pack, and
     * then this test fails for a reason that has nothing to do with their pack (rockysurf-d5an).
     */
    const yaml = (pack: object, tools: object[]) => JSON.stringify({ version: 1, pack, tools }) // JSON is valid YAML
    const ownedTool = {
      toolId: 'zz-owned-tool',
      name: 'Owned tool',
      description: 'Defined in zz-owner.yaml and referenced from zz-leaf.yaml',
      category: 'base',
      url: 'https://example.com/owned',
      installScript: 'echo owned\n',
      enabled: true,
      installOrder: 20,
      bootstrap: false,
      runAs: 'root',
    }
    writeFileSync(
      join(packsDir, 'zz-owner.yaml'),
      yaml({ packId: 'zz-owner', name: 'Owner', tools: ['zz-owned-tool'], displayOrder: 1, enabled: true }, [
        ownedTool,
      ]),
    )
    writeFileSync(
      join(packsDir, 'zz-leaf.yaml'),
      yaml({ packId: 'zz-leaf', name: 'Leaf', tools: ['zz-owned-tool'], displayOrder: 2, enabled: true }, []),
    )

    const messages: string[] = []
    const args = { db: opened.db, dataDir: join(cwd, 'data'), cwd, log: (m: string) => messages.push(m) }

    expect(syncPacksAtBoot(args).packsSynced).toBe(2)
    upsertPack(opened.db, {
      id: 'admin-made',
      name: 'Admin Made',
      tools: [],
      displayOrder: 99,
      enabled: true,
      requiresRepos: false,
      requiresRdp: false,
      sourceFile: null,
    })

    // Deleting the owner makes the one remaining file fail validation: a file is present, and
    // zero packs are loadable.
    rmSync(join(packsDir, 'zz-owner.yaml'))
    const result = syncPacksAtBoot(args)

    expect(result.reconciled).toBe(false)
    expect(listPacks(opened.db)).toHaveLength(3)
    expect(getPack(opened.db, 'admin-made')).toBeDefined()
    expect(messages.at(-1)).toContain('not one of 1 file(s)')
    opened.close()
  })

  it('is idempotent across boots', () => {
    const opened = openTestDatabase()
    const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
    const args = { db: opened.db, dataDir: join(tempDir(), 'data'), cwd: repoRoot, log: () => {} }

    const first = syncPacksAtBoot(args)
    const second = syncPacksAtBoot(args)

    expect(second.packsSynced).toBe(first.packsSynced)
    expect(listPacks(opened.db)).toHaveLength(first.packsSynced)
    opened.close()
  })
})
