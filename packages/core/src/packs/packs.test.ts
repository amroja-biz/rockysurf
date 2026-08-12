import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/client.js'
import type { Db } from '../db/client.js'
import { getPack, getTool, listPacks, listTools, upsertPack, upsertTool } from '../db/repositories/packs.js'
import { loadPacksFromDir, parsePackFile, renderPackFile } from './loader.js'
import { packFileSchema } from './schema.js'
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
    // `claude-code` is defined in ai-coding-agents.yaml and referenced by gas-town.yaml.
    expect(loaded.tools.get('claude-code')?.sourceFile).toBe('ai-coding-agents.yaml')
    expect(loaded.packs.find((p) => p.packId === 'gas-town')?.tools).toContain('claude-code')
  })

  it('treats a missing packs directory as empty, not as an error', () => {
    const loaded = loadPacksFromDir(join(packsDir, 'does-not-exist'))
    expect(loaded).toMatchObject({ packs: [], issues: [] })
    expect(loaded.tools.size).toBe(0)
  })
})

describe('the shipped packs', () => {
  const files = readdirSync(packsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  const loaded = loadPacksFromDir(packsDir)

  it('there are pack files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('load with zero issues', () => {
    expect(loaded.issues).toEqual([])
  })

  it.each(files)('%s validates against the frozen schema', (name) => {
    const parsed = packFileSchema.safeParse(
      // Re-parsed through the raw schema so a filename or cross-file issue cannot mask a
      // shape problem in the file itself.
      parsePackFile(name, readFileSync(join(packsDir, name), 'utf8')).file,
    )
    expect(parsed.success).toBe(true)
  })

  it('every pack references only tools that exist', () => {
    for (const pack of loaded.packs) {
      for (const toolId of pack.tools) expect(loaded.tools.has(toolId), `${pack.packId} → ${toolId}`).toBe(true)
    }
  })

  it('no shipped tool claims the runtime-reserved bootstrap flag', () => {
    for (const tool of loaded.tools.values()) expect(tool.bootstrap, tool.toolId).toBe(false)
  })

  /* --- the four rules, mechanically, on the repository's own packs --- */

  const scripts = () =>
    [...loaded.tools.values()].flatMap((t) =>
      (['installScript', 'setupScript'] as const)
        .filter((f) => t[f])
        .map((f) => ({ id: `${t.toolId}.${f}`, runAs: t.runAs, body: t[f]! })),
    )

  it('rule 2: no script hardcodes an architecture without branching on $ARCH', () => {
    for (const s of scripts()) {
      if (/x86_64|aarch64|linux-x64|linux-arm64/.test(s.body)) {
        expect(s.body, s.id).toContain('$ARCH')
      }
    }
  })

  it('rule 3: no apt-get install without -y, and no npx without --yes', () => {
    for (const s of scripts()) {
      expect(s.body, s.id).not.toMatch(/apt-get install(?![^\n]*(-y|--yes))/)
      expect(s.body, s.id).not.toMatch(/\bnpx\b(?![^\n]*--yes)/)
      expect(s.body, s.id).not.toMatch(/\bread -p\b/)
    }
  })

  it('rule 4: no sudo inside a runAs: rocky script', () => {
    // The one that only fails in the container CI runs in, which is exactly why it is here
    // and not left to review.
    for (const s of scripts()) {
      if (s.runAs !== 'root') expect(s.body, s.id).not.toMatch(/\bsudo\b/)
    }
  })

  it('rule 1: every append to a file is guarded', () => {
    for (const s of scripts()) {
      if (/>>\s*\S/.test(s.body)) expect(s.body, s.id).toContain('grep -q')
    }
  })

  it('rule 1: no cache-busted download URLs', () => {
    for (const s of scripts()) expect(s.body, s.id).not.toMatch(/date \+%s/)
  })

  it('assumes nothing about the cloud: no AWS CLI, no s3://, no metadata service', () => {
    for (const s of scripts()) {
      expect(s.body, s.id).not.toMatch(/\baws\s+(s3|ec2|configure)\b/)
      expect(s.body, s.id).not.toContain('s3://')
      expect(s.body, s.id).not.toContain('169.254.169.254')
    }
  })

  it('every apt-installing script refreshes the package list first', () => {
    for (const s of scripts()) {
      if (s.body.includes('apt-get install')) expect(s.body, s.id).toContain('apt-updated')
    }
  })

  it('installOrder respects the documented bands', () => {
    for (const tool of loaded.tools.values()) {
      expect(tool.installOrder, tool.toolId).toBeGreaterThanOrEqual(10)
      expect(tool.installOrder, tool.toolId).toBeLessThanOrEqual(60)
    }
  })

  it('open-claw expresses itself through fields rather than through its name', () => {
    const pack = loaded.packs.find((p) => p.packId === 'open-claw')
    expect(pack).toMatchObject({ requiresRepos: false, requiresRdp: true, desktop: 'xfce' })
  })
})

describe('rendering back to YAML', () => {
  it('round-trips: parse(render(x)) equals x, and render is stable', () => {
    const loaded = loadPacksFromDir(packsDir)
    const pack = loaded.packs.find((p) => p.packId === 'open-claw')!
    const tools = pack.tools.map((id) => loaded.tools.get(id)!)

    const once = renderPackFile(pack, tools)
    const reparsed = parsePackFile('open-claw.yaml', once)
    expect(reparsed.issues).toEqual([])

    const twice = renderPackFile(reparsed.file!.pack, reparsed.file!.tools)
    // Byte-identical on the second render — the property the export/import path needs.
    expect(twice).toBe(once)
  })

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
    expect(result.packsUpserted).toBe(5)
    expect(listPacks(db)).toHaveLength(5)
    expect(listTools(db).length).toBe(result.toolsUpserted)
    expect(getPack(db, 'open-claw')).toMatchObject({ requiresRdp: true, desktop: 'xfce' })
    expect(getTool(db, 'claude-code')?.sourceFile).toBe('ai-coding-agents.yaml')
  })

  it('is idempotent, and a second sync does not duplicate anything', () => {
    const loaded = loadPacksFromDir(packsDir)
    syncPacksToDb(db, loaded)
    const first = listTools(db).find((t) => t.id === 'claude-code')!
    const again = syncPacksToDb(db, loaded)

    expect(again.toolsRemoved).toEqual([])
    expect(listPacks(db)).toHaveLength(5)
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
