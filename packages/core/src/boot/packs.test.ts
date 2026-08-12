import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/client.js'
import { listPacks, listTools } from '../db/repositories/packs.js'
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
