import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/client.js'
import { listPacks } from '../db/repositories/packs.js'
import { BUNDLED_PACKS_DIR, bundledPacksDir } from '../packs/bundled.js'
import { resolvePacksDir, syncPacksAtBoot } from './packs.js'

/**
 * The packs a release ships (rockysurf-io02).
 *
 * The bug these cover is not subtle once seen and was invisible until someone looked at a
 * published tarball: neither package listed `packs` in its `files`, so a fresh `npx rockysurf`
 * booted with an empty picker. The boot logic was correct throughout — a boot with nothing to
 * compare against deletes nothing (rockysurf-96ce) — so nothing failed, which is exactly why it
 * survived.
 *
 * It stopped being cosmetic when the pack shop landed. The owner's ruling on issue #9 defines an
 * official pack as one shipped with the release you are running, and the registry is community
 * packs only, so a release shipping none could never have an official pack at all.
 */

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `rockysurf-${name}-`))
  scratch.push(dir)
  return dir
}

const PACK = (packId: string) =>
  JSON.stringify({
    version: 1,
    pack: { packId, name: packId, tools: ['a-tool'], displayOrder: 1, enabled: true },
    tools: [
      {
        toolId: 'a-tool',
        name: 'A tool',
        description: 'Does a thing',
        category: 'base',
        url: 'https://example.com',
        installScript: 'echo hi\n',
        enabled: true,
        installOrder: 10,
        bootstrap: false,
        runAs: 'root',
      },
    ],
  })

/** A directory with pack files in it. */
function packsIn(root: string, packIds: string[]): string {
  const dir = join(root, 'packs')
  mkdirSync(dir, { recursive: true })
  for (const id of packIds) writeFileSync(join(dir, `${id}.yaml`), PACK(id))
  return dir
}

const BUILT = existsSync(BUNDLED_PACKS_DIR)

describe('the bundled packs', () => {
  // Skipped in an unbuilt checkout rather than failed: `packages/core/packs` is produced by this
  // package's build, and a contributor running one test file before `pnpm -r build` should get a
  // skip and not a mystery.
  it.skipIf(!BUILT)('exist after a build and hold the repository’s packs', () => {
    const names = readdirSync(BUNDLED_PACKS_DIR).filter((n) => n.endsWith('.yaml'))
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('ai-coding-agents.yaml')
    expect(bundledPacksDir()).toBe(BUNDLED_PACKS_DIR)
  })

  it.skipIf(!BUILT)('resolve two levels below the package root, not inside dist', () => {
    // The mistake this pins: `../packs` from `dist/packs/bundled.js` yields `dist/packs`, a
    // directory that plausibly exists, contains no pack, and fails silently.
    expect(BUNDLED_PACKS_DIR).not.toContain(`${'dist'}${'/'}packs`)
    expect(BUNDLED_PACKS_DIR.endsWith(join('core', 'packs'))).toBe(true)
  })
})

describe('resolvePacksDir', () => {
  it('prefers a checkout over everything else', () => {
    const root = tmp('checkout')
    packsIn(root, ['from-checkout'])
    expect(resolvePacksDir(tmp('data'), root)).toMatchObject({ source: 'checkout' })
  })

  it('prefers a data directory that holds pack files over the bundle', () => {
    // An operator who put files there is running their own catalog and takes over completely —
    // the same either/or that has always applied between a checkout and the data directory.
    const data = tmp('data')
    packsIn(data, ['mine'])
    expect(resolvePacksDir(data, tmp('nowhere'))).toMatchObject({ source: 'data-dir' })
  })

  it.skipIf(!BUILT)('falls back to the bundle when there is no checkout and no operator set', () => {
    // THE npx CASE, which is the bug. Before this, the answer was an empty data directory.
    expect(resolvePacksDir(tmp('data'), tmp('nowhere'))).toMatchObject({
      source: 'bundled',
      dir: BUNDLED_PACKS_DIR,
    })
  })

  it.skipIf(!BUILT)('does not let an EMPTY data directory shadow the bundle', () => {
    // The trap: the boot path creates `<dataDir>/packs` on every non-checkout start, so keying
    // on the directory's existence rather than its contents would make the bundle unreachable
    // after the very first boot — the fix would work exactly once, on a machine nobody has.
    const data = tmp('data')
    mkdirSync(join(data, 'packs'), { recursive: true })
    expect(resolvePacksDir(data, tmp('nowhere'))).toMatchObject({ source: 'bundled' })
  })
})

describe('a boot with no checkout around it', () => {
  it.skipIf(!BUILT)('loads the shipped packs into the picker', () => {
    // The whole bug, end to end through the real boot path: what a fresh `npx rockysurf` does.
    const { db } = openTestDatabase()
    const result = syncPacksAtBoot({ db, dataDir: tmp('data'), cwd: tmp('nowhere'), log: () => {} })

    expect(result.source).toBe('bundled')
    expect(result.reconciled).toBe(true)
    expect(result.packsSynced).toBeGreaterThan(0)
    expect(listPacks(db).map((p) => p.id)).toContain('ai-coding-agents')
  })

  it.skipIf(!BUILT)('marks them file-backed, so a retired pack goes away on upgrade', () => {
    // `sourceFile` is what makes the reconcile own these rows. It is also what makes "official
    // means shipped with the release you are RUNNING" true over time: upgrade to a version that
    // dropped a pack and the reconcile drops it too. Seeding copies into the data directory
    // would have frozen the set at whatever the first install shipped.
    const { db } = openTestDatabase()
    syncPacksAtBoot({ db, dataDir: tmp('data'), cwd: tmp('nowhere'), log: () => {} })
    for (const pack of listPacks(db)) expect(pack.sourceFile).toBeTruthy()
  })

  it.skipIf(!BUILT)('leaves a pack installed from the registry alone', () => {
    // The two kinds coexist: the reconcile owns file-backed rows and never touches one whose
    // `sourceFile` is null, which is what a registry install writes (rockysurf-arym.4).
    const { db } = openTestDatabase()
    const data = tmp('data')
    syncPacksAtBoot({ db, dataDir: data, cwd: tmp('nowhere'), log: () => {} })

    const shipped = listPacks(db).length
    expect(shipped).toBeGreaterThan(0)

    // A second boot must not multiply or drop anything.
    syncPacksAtBoot({ db, dataDir: data, cwd: tmp('nowhere'), log: () => {} })
    expect(listPacks(db)).toHaveLength(shipped)
  })
})
