import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/client.js'
import { getTool, listPacks, listTools, upsertTool } from '../db/repositories/packs.js'
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

describe('the bundled packs', () => {
  // NOT SKIPPED WHEN ABSENT, which was the earlier shape and the wrong one. `packages/core/packs`
  // is a COMMITTED copy kept honest by `scripts/check-packs-bundle.mjs`, so its absence is a
  // failure rather than a reason to sit the test out — a guard here would turn "this release
  // ships no packs" into "those tests did not run", which reads as a pass.
  it('exist and hold the repository’s packs', () => {
    const names = readdirSync(BUNDLED_PACKS_DIR).filter((n) => n.endsWith('.yaml'))
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('ai-coding-agents.yaml')
    expect(bundledPacksDir()).toBe(BUNDLED_PACKS_DIR)
  })

  it('resolve two levels below the package root, not inside dist', () => {
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

  it('falls back to the bundle when there is no checkout and no operator set', () => {
    // THE npx CASE, which is the bug. Before this, the answer was an empty data directory.
    expect(resolvePacksDir(tmp('data'), tmp('nowhere'))).toMatchObject({
      source: 'bundled',
      dir: BUNDLED_PACKS_DIR,
    })
  })

  it('does not let an EMPTY data directory shadow the bundle', () => {
    // The trap: the boot path creates `<dataDir>/packs` on every non-checkout start, so keying
    // on the directory's existence rather than its contents would make the bundle unreachable
    // after the very first boot — the fix would work exactly once, on a machine nobody has.
    const data = tmp('data')
    mkdirSync(join(data, 'packs'), { recursive: true })
    expect(resolvePacksDir(data, tmp('nowhere'))).toMatchObject({ source: 'bundled' })
  })
})

describe('a boot with no checkout around it', () => {
  it('loads the shipped packs into the picker', () => {
    // The whole bug, end to end through the real boot path: what a fresh `npx rockysurf` does.
    const { db } = openTestDatabase()
    const result = syncPacksAtBoot({ db, dataDir: tmp('data'), cwd: tmp('nowhere'), log: () => {} })

    expect(result.source).toBe('bundled')
    expect(result.reconciled).toBe(true)
    expect(result.packsSynced).toBeGreaterThan(0)
    expect(listPacks(db).map((p) => p.id)).toContain('ai-coding-agents')
  })

  it('marks them file-backed, so a retired pack goes away on upgrade', () => {
    // `sourceFile` is what makes the reconcile own these rows. It is also what makes "official
    // means shipped with the release you are RUNNING" true over time: upgrade to a version that
    // dropped a pack and the reconcile drops it too. Seeding copies into the data directory
    // would have frozen the set at whatever the first install shipped.
    const { db } = openTestDatabase()
    syncPacksAtBoot({ db, dataDir: tmp('data'), cwd: tmp('nowhere'), log: () => {} })
    for (const pack of listPacks(db)) expect(pack.sourceFile).toBeTruthy()
  })

  it('leaves a pack installed from the registry alone', () => {
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

  /**
   * "INSTALL THIS ON EVERY BOX" SURVIVES THE RECONCILE (issue #295).
   *
   * This is the one field of a file-backed tool an operator may set, and it is exactly the
   * field the reconcile is most likely to eat: `syncPacksToDb` re-upserts every shipped tool
   * from its YAML on every single start, and no file format carries `alwaysInstall` — it is
   * installation state, not file content, and a shared file that promised "installs
   * everywhere" would be making a promise about somebody else's machine.
   *
   * So `upsertTool` treats an omitted `alwaysInstall` as "leave it alone" rather than as
   * false. Without that, the operator's choice would be silently reset at the next restart —
   * silently being the word that matters: nothing would error, the tool would still be listed,
   * and it would just stop arriving on new boxes.
   */
  it('keeps an operator\'s "install on every box" through a restart', () => {
    const { db } = openTestDatabase()
    const data = tmp('data')
    syncPacksAtBoot({ db, dataDir: data, cwd: tmp('nowhere'), log: () => {} })

    const shipped = listTools(db).find((t) => t.sourceFile)
    expect(shipped, 'a shipped tool to mark').toBeTruthy()
    upsertTool(db, { ...shipped!, alwaysInstall: true })
    expect(getTool(db, shipped!.id)!.alwaysInstall).toBe(true)

    // The next boot rewrites this row's name and scripts from its file, and must not touch this.
    syncPacksAtBoot({ db, dataDir: data, cwd: tmp('nowhere'), log: () => {} })

    expect(getTool(db, shipped!.id)!.alwaysInstall).toBe(true)
    expect(getTool(db, shipped!.id)!.sourceFile).toBeTruthy()
  })
})
