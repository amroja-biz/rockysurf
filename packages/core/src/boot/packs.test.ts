import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

const shippedPackFiles = () => readdirSync(repoPacksDir).filter((f) => f.endsWith('.yaml'))

describe('choosing a packs directory', () => {
  it('prefers ./packs when it exists — the checkout case', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'packs'))
    const resolved = resolvePacksDir(join(cwd, 'data'), cwd)

    expect(resolved.source).toBe('checkout')
    expect(resolved.dir).toBe(join(cwd, 'packs'))
  })

  it('falls back to <dataDir>/packs — the installed case', () => {
    const cwd = tempDir()
    const dataDir = join(tempDir(), 'data')
    const resolved = resolvePacksDir(dataDir, cwd)

    expect(resolved.source).toBe('data-dir')
    expect(resolved.dir).toBe(join(dataDir, 'packs'))
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
    expect(result.packsSynced).toBe(shippedPackFiles().length)
    expect(listPacks(opened.db)).toHaveLength(shippedPackFiles().length)
    expect(result.toolsSynced).toBeGreaterThan(0)
    expect(messages.join('\n')).toMatch(/packs: \d+ pack\(s\), \d+ tool\(s\)/)
    opened.close()
  })

  it('serves with zero packs on a fresh installation, creating the directory', () => {
    const opened = openTestDatabase()
    const dataDir = join(tempDir(), 'data')
    const messages: string[] = []

    const result = syncPacksAtBoot({ db: opened.db, dataDir, cwd: tempDir(), log: (m) => messages.push(m) })

    expect(result.source).toBe('data-dir')
    expect(result.packsSynced).toBe(0)
    expect(result.toolsSynced).toBe(0)
    // An empty packs directory is a legitimate state, not an error.
    expect(readdirSync(result.dir)).toEqual([])
    expect(listPacks(opened.db)).toHaveLength(0)
    opened.close()
  })

  it('loads the valid files and logs the broken one, rather than failing the boot', () => {
    const opened = openTestDatabase()
    const cwd = tempDir()
    const packsDir = join(cwd, 'packs')
    mkdirSync(packsDir)

    const shipped = shippedPackFiles()
    for (const file of shipped) copyFileSync(join(repoPacksDir, file), join(packsDir, file))
    // A file that parses as YAML but is not a valid pack: the validator names the field.
    writeFileSync(join(packsDir, 'broken.yaml'), 'version: 1\npack:\n  packId: broken\ntools: []\n')

    const messages: string[] = []
    const result = syncPacksAtBoot({ db: opened.db, dataDir: join(cwd, 'data'), cwd, log: (m) => messages.push(m) })

    // The good ones landed...
    expect(result.packsSynced).toBe(shipped.length)
    expect(listPacks(opened.db)).toHaveLength(shipped.length)
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
    expect(a.packsSynced).toBe(shippedPackFiles().length)

    // Boot B — same data directory, started from a directory with no packs/ in sight.
    // Since 8wgm the app boots happily from anywhere, so this is an ordinary thing to do.
    const b = syncPacksAtBoot({ db: opened.db, dataDir, cwd: tempDir(), log })
    expect(listPacks(opened.db)).toHaveLength(shippedPackFiles().length + 1)
    expect(b.reconciled).toBe(false)
    // The count in the message is the file-backed rows boot A left behind, so it comes from
    // disk. A literal here fails the day someone adds a pack file, which is a bug in the test
    // and not in their pack (rockysurf-d5an).
    expect(messages.at(-1)).toMatch(
      new RegExp(`no checkout detected .* — leaving ${shippedPackFiles().length} database pack\\(s\\) as they are`),
    )

    // Boot C — back in the checkout. Still the same set, no duplicates, no losses.
    const c = syncPacksAtBoot({ db: opened.db, dataDir, cwd: repoRoot, log })
    expect(c.packsSynced).toBe(shippedPackFiles().length)
    expect(listPacks(opened.db)).toHaveLength(shippedPackFiles().length + 1)
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
    expect(listPacks(opened.db)).toHaveLength(shippedPackFiles().length)

    // A checkout-shaped cwd whose packs/ is present and empty. Indistinguishable from the
    // <dataDir>/packs this very function creates on a fresh install, so it deletes nothing.
    const emptyCheckout = tempDir()
    mkdirSync(join(emptyCheckout, 'packs'))
    const result = syncPacksAtBoot({ db: opened.db, dataDir, cwd: emptyCheckout, log })

    expect(result.source).toBe('checkout')
    expect(listPacks(opened.db)).toHaveLength(shippedPackFiles().length)
    expect(result.reconciled).toBe(false)
    expect(messages.at(-1)).toContain('holds no pack files')
    opened.close()
  })

  it('still deletes the rows of a single pack file that went away (rockysurf-a0ss)', () => {
    const opened = openTestDatabase()
    const cwd = tempDir()
    const packsDir = join(cwd, 'packs')
    mkdirSync(packsDir)

    const shipped = shippedPackFiles()
    for (const file of shipped) copyFileSync(join(repoPacksDir, file), join(packsDir, file))
    const args = { db: opened.db, dataDir: join(cwd, 'data'), cwd, log: () => {} }

    syncPacksAtBoot(args)
    expect(listPacks(opened.db)).toHaveLength(shipped.length)

    // A leaf pack: it owns one tool and no other pack references it, so removing it is a
    // one-pack change rather than a cascade. (Removing ai-coding-agents.yaml is not — it owns
    // the base tools every other pack lists, which is the case the guard below covers.)
    const gone = 'open-code.yaml'
    expect(shipped).toContain(gone)
    rmSync(join(packsDir, gone))
    const result = syncPacksAtBoot(args)

    expect(result.reconciled).toBe(true)
    expect(listPacks(opened.db)).toHaveLength(shipped.length - 1)
    expect(listPacks(opened.db).map((p) => p.sourceFile)).not.toContain(gone)
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
     * `ai-coding-agents.yaml` and relying on every other shipped file referencing the base
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
