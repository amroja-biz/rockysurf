import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/client.js'
import type { Db } from '../db/client.js'
import { getPack, getTool, listPacks, listTools, upsertPack, upsertTool } from '../db/repositories/packs.js'
import { formatFindings, lintPacksDir } from './lint.js'
import { loadPacksFromDir, parsePackFile, parseToolFile, renderPackFile } from './loader.js'
import { packFileSchema, toolFileSchema } from './schema.js'
import { PackValidationError, syncPacksToDb } from './sync.js'

/**
 * Two things are under test here, and only one of them is code.
 *
 * The first is the loader: does it accept what the contract accepts and reject what the
 * contract rejects. The second is the SHIPPED PACK FILES — every `packs/*.yaml` in this
 * repository is validated against the same four rules the contract asks contributors to
 * follow, because a contract the reference implementation violates is not a contract.
 */

const packsDir = fileURLToPath(new URL('../../../../packs/', import.meta.url))

/**
 * Every YAML document in `packs/`, split by which of the two formats it is in.
 *
 * A file with no `pack:` block is a TOOL FILE (ADR-0018) — `packs/base.yaml` holds the shared
 * base toolchain and defines no pack (issue #499) — so it contributes tools and never a row in
 * the picker. Told apart by the same rule the loader uses, read off the text rather than
 * hardcoded, because a list of names here is a list that goes stale.
 */
const shippedFiles = readdirSync(packsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
const isToolFile = (name: string): boolean => !/^pack:/m.test(readFileSync(join(packsDir, name), 'utf8'))
const shippedToolFiles = shippedFiles.filter(isToolFile)
const shippedPackFiles = shippedFiles.filter((name) => !isToolFile(name))

/**
 * Counted from disk rather than hardcoded: the assertion worth making is "every pack file
 * became a row", not "there are exactly N packs". A literal here means adding a pack fails
 * three unrelated tests and teaches the next author to edit the number rather than read it.
 */
const shippedPackCount = shippedPackFiles.length

const MINIMAL_TOOL = {
  toolId: 'a-tool',
  name: 'A tool',
  description: 'Does a thing',
  category: 'base' as const,
  url: 'https://example.com',
  installScript: 'echo hi\n',
  enabled: true,
  installOrder: 10,
  bootstrap: false,
  runAs: 'root' as const,
}

const MINIMAL_PACK = {
  packId: 'a-pack',
  name: 'A pack',
  tools: ['a-tool'],
  displayOrder: 1,
  enabled: true,
}

const fileText = (pack: object = MINIMAL_PACK, tools: object[] = [MINIMAL_TOOL]) =>
  JSON.stringify({ version: 1, pack, tools }) // JSON is valid YAML

describe('the frozen format', () => {
  it('accepts a minimal file and defaults the two required booleans', () => {
    const { file, issues } = parsePackFile('a-pack.yaml', fileText())
    expect(issues).toEqual([])
    expect(file?.pack.requiresRepos).toBe(false)
    expect(file?.pack.requiresRdp).toBe(false)
    expect(file?.pack.desktop).toBeUndefined()
  })

  it('rejects an unknown key rather than ignoring it', () => {
    // The failure mode of ignoring a misspelled `requiresRdp` is a pack that quietly never
    // asks for a password, which nobody discovers until they cannot log in.
    const { issues } = parsePackFile('a-pack.yaml', fileText({ ...MINIMAL_PACK, requiresRDP: true }))
    expect(issues.some((i) => i.message.includes('requiresRDP'))).toBe(true)
  })

  it('accepts a declared web-UI port and rejects one no TCP port can have', () => {
    const { file } = parsePackFile('a-pack.yaml', fileText({ ...MINIMAL_PACK, webPort: 3080 }))
    expect(file?.pack.webPort).toBe(3080)
    for (const bad of [0, 65536, 3080.5]) {
      const { issues } = parsePackFile('a-pack.yaml', fileText({ ...MINIMAL_PACK, webPort: bad }))
      expect(issues.length, `webPort: ${bad}`).toBeGreaterThan(0)
    }
  })

  it('rejects a wrong version, so a future format cannot be silently misread', () => {
    const { issues } = parsePackFile('a-pack.yaml', JSON.stringify({ version: 2, pack: MINIMAL_PACK, tools: [] }))
    expect(issues.some((i) => i.message.includes('version'))).toBe(true)
  })

  it.each([
    ['SHOUTY', 'Shouty-Case'],
    ['under_scores', 'under_scores'],
    ['trailing hyphen', 'a-'],
    ['spaces', 'a b'],
  ])('rejects a %s toolId', (_label, toolId) => {
    const { issues } = parsePackFile('a-pack.yaml', fileText(MINIMAL_PACK, [{ ...MINIMAL_TOOL, toolId }]))
    expect(issues.length).toBeGreaterThan(0)
  })

  it('rejects a pack with no tools', () => {
    const { issues } = parsePackFile('a-pack.yaml', fileText({ ...MINIMAL_PACK, tools: [] }, []))
    expect(issues.some((i) => i.message.includes('installs nothing'))).toBe(true)
  })

  it('rejects a filename that disagrees with the packId', () => {
    const { issues } = parsePackFile('something-else.yaml', fileText())
    expect(issues.some((i) => i.message.includes('does not match the filename'))).toBe(true)
  })

  it('reports invalid YAML as invalid YAML', () => {
    const { file, issues } = parsePackFile('a-pack.yaml', 'pack: [unclosed\n')
    expect(file).toBeUndefined()
    expect(issues[0]?.message).toContain('not valid YAML')
  })
})

describe('loading a directory', () => {
  it('resolves a tool defined in one file and referenced from another', () => {
    const loaded = loadPacksFromDir(packsDir)
    expect(loaded.issues).toEqual([])
    // `claude-code` is defined in claude-code.yaml and referenced by gas-town.yaml.
    expect(loaded.tools.get('claude-code')?.sourceFile).toBe('claude-code.yaml')
    expect(loaded.packs.find((p) => p.packId === 'gas-town')?.tools).toContain('claude-code')
  })

  it('treats a missing packs directory as empty, not as an error', () => {
    const loaded = loadPacksFromDir(join(packsDir, 'does-not-exist'))
    expect(loaded).toMatchObject({ packs: [], issues: [] })
    expect(loaded.tools.size).toBe(0)
  })

  /**
   * The tool-file arm (issue #499). A directory may hold files in either frozen format, and a
   * file with no `pack:` block contributes definitions and no pack — which is what lets the
   * shared base toolchain stop belonging to whichever pack happened to be written first.
   */
  it('reads a tool file as definitions, resolves them for a pack, and lists no pack for it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-loader-'))
    try {
      writeFileSync(
        join(dir, 'zz-base.yaml'),
        JSON.stringify({ version: 1, tools: [{ ...MINIMAL_TOOL, toolId: 'zz-shared' }] }),
      )
      writeFileSync(
        join(dir, 'zz-user.yaml'),
        fileText({ ...MINIMAL_PACK, packId: 'zz-user', tools: ['zz-shared'] }, []),
      )
      const loaded = loadPacksFromDir(dir)

      expect(loaded.issues).toEqual([])
      expect(loaded.toolFiles).toEqual(['zz-base.yaml'])
      expect(loaded.packs.map((p) => p.packId)).toEqual(['zz-user'])
      expect(loaded.tools.get('zz-shared')?.sourceFile).toBe('zz-base.yaml')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a tool a pack file and a tool file both define', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-loader-'))
    try {
      writeFileSync(join(dir, 'zz-base.yaml'), JSON.stringify({ version: 1, tools: [MINIMAL_TOOL] }))
      writeFileSync(join(dir, 'zz-user.yaml'), fileText({ ...MINIMAL_PACK, packId: 'zz-user' }))
      const loaded = loadPacksFromDir(dir)

      expect(loaded.issues.map((i) => i.message).join('\n')).toContain(
        'toolId "a-tool" is already defined in zz-base.yaml',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the shipped packs', () => {
  const files = shippedFiles
  const loaded = loadPacksFromDir(packsDir)

  it('there are pack files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('load with zero issues', () => {
    expect(loaded.issues).toEqual([])
  })

  it.each(shippedPackFiles)('%s validates against the frozen pack schema', (name) => {
    const parsed = packFileSchema.safeParse(
      // Re-parsed through the raw schema so a filename or cross-file issue cannot mask a
      // shape problem in the file itself.
      parsePackFile(name, readFileSync(join(packsDir, name), 'utf8')).file,
    )
    expect(parsed.success).toBe(true)
  })

  it.each(shippedToolFiles)('%s validates against the frozen tool-file schema', (name) => {
    const parsed = toolFileSchema.safeParse(parseToolFile(name, readFileSync(join(packsDir, name), 'utf8')).file)
    expect(parsed.success).toBe(true)
  })

  /**
   * The base toolchain is a file of its own (issue #499), and this is the pair of facts that
   * makes the split worth having: the definitions are in `base.yaml`, and the Claude Code pack
   * owns only what is Claude Code's. Pinned by name because both halves are the point —
   * "some file defines git" would still pass with the base tools back where they were.
   *
   * `herdr` is a base tool like the rest of them; `herdr-claude-integration` is not, and that
   * is the line the second half draws — a hook that means nothing without Claude Code installed
   * belongs in Claude Code's file, which is where `gas-town` and `kitchen-sink` reference it from.
   */
  it("defines the shared base toolchain in base.yaml, and Claude Code's own tools in claude-code.yaml", () => {
    expect(loaded.toolFiles).toContain('base.yaml')
    for (const id of ['build-essential', 'curl', 'gh', 'git', 'nodejs', 'playwright', 'beads', 'herdr']) {
      expect(loaded.tools.get(id)?.sourceFile, id).toBe('base.yaml')
    }
    const ownedByClaudeCode = [...loaded.tools.values()].filter((t) => t.sourceFile === 'claude-code.yaml')
    expect(ownedByClaudeCode.map((t) => t.toolId)).toEqual(['claude-code', 'herdr-claude-integration'])
  })

  it('every pack references only tools that exist', () => {
    for (const pack of loaded.packs) {
      for (const toolId of pack.tools) expect(loaded.tools.has(toolId), `${pack.packId} → ${toolId}`).toBe(true)
    }
  })

  /* --- the four rules, mechanically, on the repository's own packs --- */

  /**
   * THE RULES THEMSELVES MOVED TO `lint.ts` (rockysurf-arym.2), and this asserts them from
   * there rather than keeping a second copy.
   *
   * They lived here as a dozen inline regexes for as long as every pack lived in `packs/`.
   * That stopped being tenable when packs started arriving from a registry: the shop's CI has
   * to gate a community pull request with the same rules, and it cannot run this repository's
   * vitest suite. A rule that exists in two places is a rule that will eventually mean two
   * things — and the divergence would show up as a pack this repository rejects and the shop
   * accepts, which is the worst direction for it to fail in.
   *
   * So the shipped packs are now checked by exactly the command contributors are told to run.
   * `lint.test.ts` covers the rules themselves, each with a fixture that breaks it.
   */
  it('satisfy the published author contract, checked by `rockysurf pack lint`', () => {
    expect(formatFindings(lintPacksDir({ dir: packsDir }).findings)).toBe('')
  })

  it('open-claw expresses itself through fields rather than through its name', () => {
    const pack = loaded.packs.find((p) => p.packId === 'open-claw')
    expect(pack).toMatchObject({ requiresRepos: false, requiresRdp: true, desktop: 'xfce' })
  })

  it('deepseek-harness declares its web UI as metadata, not only as guide prose', () => {
    // The field the server page's Connect section renders the tunnel from (rockysurf-bbmi).
    const pack = loaded.packs.find((p) => p.packId === 'deepseek-harness')
    expect(pack).toMatchObject({ webPort: 3080 })
  })
})

describe('rendering back to YAML', () => {
  // Every shipped pack, not just one: this is the property the export/import route depends
  // on, and a pack that only round-trips for the file it was modelled on is the failure the
  // route would surface to an operator rather than to CI.
  it.each(loadPacksFromDir(packsDir).packs.map((p) => p.packId))(
    '%s round-trips: parse(render(x)) equals x, and render is stable',
    (packId) => {
      const loaded = loadPacksFromDir(packsDir)
      const pack = loaded.packs.find((p) => p.packId === packId)!
      const tools = pack.tools.map((id) => loaded.tools.get(id)!)

      const once = renderPackFile(pack, tools)
      const reparsed = parsePackFile(`${packId}.yaml`, once)
      expect(reparsed.issues).toEqual([])

      const twice = renderPackFile(reparsed.file!.pack, reparsed.file!.tools)
      // Byte-identical on the second render — the property the export/import path needs.
      expect(twice).toBe(once)
    },
  )

  it('preserves multi-line scripts exactly', () => {
    const script = 'set -euo pipefail\nif [ -f x ]; then\n  echo "  indented"\nfi\n'
    const rendered = renderPackFile(MINIMAL_PACK as never, [{ ...MINIMAL_TOOL, installScript: script }])
    const back = parsePackFile('a-pack.yaml', rendered)
    expect(back.issues).toEqual([])
    expect(back.file?.tools[0]?.installScript).toBe(script)
  })
})

describe('syncing to the database', () => {
  let db: Db

  beforeEach(() => {
    db = openTestDatabase().db
  })

  it('loads every shipped pack and tool', () => {
    const result = syncPacksToDb(db, loadPacksFromDir(packsDir))
    expect(result.packsUpserted).toBe(shippedPackCount)
    expect(listPacks(db)).toHaveLength(shippedPackCount)
    expect(listTools(db).length).toBe(result.toolsUpserted)
    expect(getPack(db, 'open-claw')).toMatchObject({ requiresRdp: true, desktop: 'xfce' })
    expect(getPack(db, 'deepseek-harness')).toMatchObject({ webPort: 3080 })
    expect(getTool(db, 'claude-code')?.sourceFile).toBe('claude-code.yaml')
  })

  it('is idempotent, and a second sync does not duplicate anything', () => {
    const loaded = loadPacksFromDir(packsDir)
    syncPacksToDb(db, loaded)
    const first = listTools(db).find((t) => t.id === 'claude-code')!
    const again = syncPacksToDb(db, loaded)

    expect(again.toolsRemoved).toEqual([])
    expect(listPacks(db)).toHaveLength(shippedPackCount)
    // An upsert is an edit, so the row keeps the moment it first appeared.
    expect(listTools(db).find((t) => t.id === 'claude-code')?.createdAt).toBe(first.createdAt)
  })

  it('refuses to sync a set that failed validation', () => {
    const broken = loadPacksFromDir(packsDir)
    broken.issues.push({ file: 'x.yaml', message: 'boom' })
    expect(() => syncPacksToDb(db, broken)).toThrow(PackValidationError)
  })

  it('removes a file-backed row whose file has gone, and keeps a UI-created one', () => {
    syncPacksToDb(db, loadPacksFromDir(packsDir))
    upsertPack(db, {
      id: 'hand-made',
      name: 'Hand made',
      tools: ['claude-code'],
      displayOrder: 99,
      enabled: true,
      requiresRepos: false,
      requiresRdp: false,
      sourceFile: null,
    })
    upsertTool(db, { ...MINIMAL_TOOL, id: 'hand-tool', sourceFile: null })

    const shrunk = loadPacksFromDir(packsDir)
    shrunk.packs = shrunk.packs.filter((p) => p.packId !== 'codex-cli')
    shrunk.tools.delete('codex')
    const result = syncPacksToDb(db, shrunk)

    expect(result.packsRemoved).toEqual(['codex-cli'])
    expect(result.toolsRemoved).toEqual(['codex'])
    expect(getPack(db, 'hand-made')).toBeDefined()
    expect(getTool(db, 'hand-tool')).toBeDefined()
  })
})
