import { describe, expect, it } from 'vitest'
import { parsePackFile, parseToolFile, renderToolFile } from './loader.js'
import type { ToolDefinition } from './schema.js'

/**
 * The tool file format (issue #289, ADR-0018).
 *
 * The format exists to travel BETWEEN installations, so the tests that matter most are the
 * round-trip ones: what one installation exports, another must import to the same bytes. A
 * script that changes on the way through is not a formatting nit — it is a different program
 * running as root on somebody's box.
 */

const TOOL: ToolDefinition = {
  toolId: 'my-tool',
  name: 'My Tool',
  description: 'A tool for testing',
  category: 'base',
  url: 'https://example.com',
  installScript: 'set -euo pipefail\nmy-tool --version >/dev/null\n',
  enabled: true,
  installOrder: 40,
  bootstrap: false,
  runAs: 'root',
}

const render = (tools: ToolDefinition[]) => renderToolFile(tools)
const parse = (text: string) => parseToolFile('imported.yaml', text)

describe('renderToolFile / parseToolFile', () => {
  it('round-trips a tool unchanged', () => {
    const { file, issues } = parse(render([TOOL]))
    expect(issues).toEqual([])
    expect(file?.tools).toEqual([TOOL])
  })

  it('renders byte-identically on a second pass, so a re-export is not a diff', () => {
    const once = render([TOOL])
    const twice = render(parse(once).file!.tools)
    expect(twice).toBe(once)
  })

  it('orders tools by installOrder then id, matching the executor', () => {
    const yaml = render([
      { ...TOOL, toolId: 'zzz', installOrder: 10 },
      { ...TOOL, toolId: 'aaa', installOrder: 40 },
      { ...TOOL, toolId: 'bbb', installOrder: 10 },
    ])
    expect(parse(yaml).file?.tools.map((t) => t.toolId)).toEqual(['bbb', 'zzz', 'aaa'])
  })

  it('carries setupScript when present and omits the key when absent', () => {
    expect(render([TOOL])).not.toContain('setupScript')
    const withSetup = render([{ ...TOOL, setupScript: 'echo hi\n' }])
    expect(parse(withSetup).file?.tools[0]?.setupScript).toBe('echo hi\n')
  })

  /**
   * THE EDGE CASES THAT BREAK A NAIVE YAML ROUND TRIP. Every one of these is a real thing to
   * find in an install script, and every one has a spelling in YAML that loses information if
   * the writer picks the wrong scalar style. A literal block cannot hold a line with trailing
   * whitespace, so the writer must fall back to quoting — the assertion is that whatever it
   * picks, the string comes back.
   */
  describe('script round trips survive', () => {
    const cases: Array<[string, string]> = [
      ['trailing whitespace on a line', 'echo one   \necho two\n'],
      ['tabs', 'if true; then\n\techo indented\nfi\n'],
      ['CRLF line endings', 'echo one\r\necho two\r\n'],
      ['a line that itself parses as YAML', 'echo hi\nkey: value\n- item\n'],
      ['a line that looks like a document marker', 'echo hi\n---\necho bye\n'],
      ['trailing newlines', 'echo hi\n\n\n'],
      ['no trailing newline at all', 'echo hi'],
      ['a colon-space inside a comment', '# note: this is fine\necho hi\n'],
      ['leading whitespace on the first line', '  echo indented\n'],
      ['a lone # line', '#\necho hi\n'],
    ]

    for (const [label, script] of cases) {
      it(label, () => {
        const { file, issues } = parse(render([{ ...TOOL, installScript: script }]))
        expect(issues).toEqual([])
        expect(file?.tools[0]?.installScript).toBe(script)
      })
    }
  })

  it('round-trips across installations: export A, import B, scripts identical', () => {
    // "Installation B" has only the bytes — no database, no shared memory of the object.
    const onTheWire = render([{ ...TOOL, installScript: 'set -euo pipefail\n\tcurl -fsSL x | tee  \n' }])
    const arrived = parse(onTheWire).file!
    expect(render(arrived.tools)).toBe(onTheWire)
  })
})

describe('parseToolFile rejections', () => {
  it('rejects a pack file with the door it should have used', () => {
    const packFile = 'version: 1\npack:\n  packId: p\n  name: P\n  tools: [a]\n  displayOrder: 1\n  enabled: true\ntools: []\n'
    const { file, issues } = parse(packFile)
    expect(file).toBeUndefined()
    expect(issues[0]?.message).toContain('this is a pack file')
    expect(issues[0]?.message).toContain('Surge Packs')
  })

  it('rejects bootstrap: true with the same words as the lint rule', () => {
    const { file, issues } = parse(render([{ ...TOOL, bootstrap: true }]))
    expect(file).toBeUndefined()
    expect(issues[0]?.message).toContain('reserved for the tools the runtime guarantees')
  })

  /**
   * `alwaysInstall` is issue #295's proposed column. It is NOT a member of this format, and the
   * strict schema is what makes that a loud refusal instead of a promise silently dropped on
   * the way in — a tool that believed it would be installed everywhere and simply is not.
   */
  it('rejects an unknown key rather than dropping it', () => {
    const yaml = render([TOOL]).replace('  enabled: true', '  alwaysInstall: true\n  enabled: true')
    const { file, issues } = parse(yaml)
    expect(file).toBeUndefined()
    expect(JSON.stringify(issues)).toContain('alwaysInstall')
  })

  it('rejects a file carrying sourceFile, which is this installation’s fact about its own disk', () => {
    const yaml = render([TOOL]).replace('  enabled: true', '  sourceFile: packs/x.yaml\n  enabled: true')
    expect(parse(yaml).file).toBeUndefined()
  })

  it('never emits sourceFile or alwaysInstall when exporting', () => {
    const yaml = render([{ ...TOOL, sourceFile: 'packs/x.yaml' } as ToolDefinition])
    expect(yaml).not.toContain('sourceFile')
    expect(yaml).not.toContain('alwaysInstall')
    expect(parse(yaml).issues).toEqual([])
  })

  it('rejects an empty tool list, which would share nothing', () => {
    expect(parse('version: 1\ntools: []\n').file).toBeUndefined()
  })

  it('rejects a duplicate toolId within one file', () => {
    const { issues } = parse(render([TOOL, { ...TOOL, name: 'Other' }]))
    expect(JSON.stringify(issues)).toContain('duplicate toolId')
  })

  it('rejects a future version rather than guessing', () => {
    expect(parse(render([TOOL]).replace('version: 1', 'version: 2')).file).toBeUndefined()
  })

  it('reports invalid YAML as such', () => {
    expect(parse('\tnot: [valid').issues[0]?.message).toContain('not valid YAML')
  })
})

describe('the two formats stay siblings', () => {
  /**
   * The point of reusing `toolSchema` verbatim: a tool lifted out of a pack file and shared as
   * a tool file is the same object, with no translation step to drift.
   */
  it('a tool defined in a pack file parses identically from a tool file', () => {
    const packYaml = [
      'version: 1',
      'pack:',
      '  packId: a-pack',
      '  name: A Pack',
      '  tools:',
      '    - my-tool',
      '  displayOrder: 1',
      '  enabled: true',
      'tools:',
      '  - toolId: my-tool',
      '    name: My Tool',
      '    description: A tool for testing',
      '    category: base',
      '    url: https://example.com',
      '    installOrder: 40',
      '    runAs: root',
      '    bootstrap: false',
      '    enabled: true',
      '    installScript: |',
      '      set -euo pipefail',
      '      my-tool --version >/dev/null',
      '',
    ].join('\n')

    const fromPack = parsePackFile('a-pack.yaml', packYaml).file!.tools[0]!
    const fromTool = parse(render([fromPack])).file!.tools[0]!
    expect(fromTool).toEqual(fromPack)
  })
})
