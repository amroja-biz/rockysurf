import { describe, expect, it } from 'vitest'
import { describePack, urlsIn } from './disclosure.js'
import { packFileSchema, type PackFile, type ToolDefinition } from './schema.js'

/**
 * The disclosure — what an operator reads before consenting to run somebody's shell as root.
 *
 * The tests worth having here are about honesty rather than coverage. The derived summary is a
 * reading aid over a thing that cannot be summarised safely, and the two ways it goes wrong are
 * both tested: it must not miss a root step or a URL it could have seen, and it must not claim
 * to be complete when it structurally cannot be.
 */

const tool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  toolId: 'a-tool',
  name: 'A tool',
  description: 'Does a thing',
  category: 'base',
  url: 'https://example.com/a-tool',
  installScript: 'echo hi\n',
  enabled: true,
  installOrder: 30,
  bootstrap: false,
  runAs: 'root',
  ...overrides,
})

const packFile = (tools: ToolDefinition[], packTools?: string[]): PackFile =>
  packFileSchema.parse({
    version: 1,
    pack: {
      packId: 'a-pack',
      name: 'A pack',
      tools: packTools ?? tools.map((t) => t.toolId),
      displayOrder: 1,
      enabled: true,
    },
    tools,
  })

describe('urlsIn', () => {
  it('finds http and https URLs and deduplicates them', () => {
    const urls = urlsIn('curl https://a.example/x\nwget http://b.example/y\ncurl https://a.example/x\n')
    expect(urls).toEqual(['https://a.example/x', 'http://b.example/y'])
  })

  it('stops at quotes, whitespace and shell punctuation', () => {
    // `https://example.com/x",` is not a URL anybody wants to read out of a report.
    expect(urlsIn('curl -fsSL "https://example.com/install.sh" | sh')).toEqual([
      'https://example.com/install.sh',
    ])
    expect(urlsIn('URL=https://example.com/x; curl $URL')).toEqual(['https://example.com/x'])
  })

  it('trims trailing sentence punctuation', () => {
    expect(urlsIn('# see https://example.com/docs.')).toEqual(['https://example.com/docs'])
  })

  it('finds nothing in a script that fetches nothing', () => {
    expect(urlsIn('apt-get install -y ripgrep\n')).toEqual([])
  })
})

describe('describePack', () => {
  it('lists tools in the order they will actually run', () => {
    // installOrder ascending, ties broken on toolId — `resolveInstallPlan`'s ordering. A
    // disclosure in file order would describe a sequence that never happens.
    const file = packFile([
      tool({ toolId: 'third', installOrder: 50 }),
      tool({ toolId: 'first', installOrder: 10 }),
      tool({ toolId: 'b-second', installOrder: 20 }),
      tool({ toolId: 'a-second', installOrder: 20 }),
    ])
    expect(describePack({ file }).tools.map((t) => t.toolId)).toEqual([
      'first',
      'a-second',
      'b-second',
      'third',
    ])
  })

  it('counts root steps and collects every URL across both scripts', () => {
    const file = packFile([
      tool({ toolId: 'one', runAs: 'root', installScript: 'curl https://a.example/x\n' }),
      tool({
        toolId: 'two',
        runAs: 'rocky',
        installScript: 'echo hi\n',
        setupScript: 'curl https://b.example/y\n',
      }),
    ])
    const disclosure = describePack({ file })
    expect(disclosure.rootStepCount).toBe(1)
    expect(disclosure.fetchesUrls).toEqual(['https://a.example/x', 'https://b.example/y'])
  })

  it('carries each script verbatim, byte for byte', () => {
    // The scripts are the thing an operator consents to; everything else on the page is
    // derived. A disclosure that reformatted them would be describing something else.
    const script = 'set -euo pipefail\n\n  curl   https://x.example/y   |  sh\n'
    const disclosure = describePack({ file: packFile([tool({ installScript: script })]) })
    expect(disclosure.tools[0]!.installScript).toBe(script)
  })

  it('never claims the summary is complete', () => {
    // Structural, not a value judgement: a script can assemble a URL from variables, or read
    // one out of a file it fetched, and no pattern match sees either.
    expect(describePack({ file: packFile([tool()]) }).summaryIsComplete).toBe(false)
  })

  it('demonstrates why: a URL built from variables does not appear in the summary', () => {
    // This test exists to keep anyone from "fixing" summaryIsComplete to true. The script below
    // fetches from example.com and the summary cannot say so.
    const file = packFile([
      tool({ installScript: 'HOST=example.com\ncurl -fsSL "https://$HOST/install.sh" | sh\n' }),
    ])
    const disclosure = describePack({ file })
    expect(disclosure.fetchesUrls).not.toContain('https://example.com/install.sh')
    expect(disclosure.summaryIsComplete).toBe(false)
    // And the script itself, which the operator reads, does say so.
    expect(disclosure.tools[0]!.installScript).toContain('$HOST/install.sh')
  })

  it('resolves referenced tools from the local catalog, so the install is described in full', () => {
    // A pack referencing `claude-code` runs that tool's script too, and an operator consenting
    // to the install is consenting to that. Describing only the file's own tools would show
    // them less than will happen.
    const referenced = tool({ toolId: 'claude-code', installOrder: 20, installScript: 'curl https://c.example/i\n' })
    const file = packFile([tool({ toolId: 'own', installOrder: 40 })], ['claude-code', 'own'])
    const disclosure = describePack({ file, knownTools: new Map([['claude-code', referenced]]) })

    expect(disclosure.tools.map((t) => t.toolId)).toEqual(['claude-code', 'own'])
    expect(disclosure.fetchesUrls).toContain('https://c.example/i')
    expect(disclosure.referencesTools).toEqual([])
  })

  it('names references it cannot resolve rather than silently dropping them', () => {
    // A pack whose references this installation cannot satisfy would half-install. Saying which
    // ones are missing is what lets the UI refuse it with a reason.
    const file = packFile([tool({ toolId: 'own' })], ['own', 'nowhere'])
    expect(describePack({ file }).referencesTools).toEqual(['nowhere'])
  })

  it('carries the pack’s guide and its behaviour flags', () => {
    const file = packFileSchema.parse({
      version: 1,
      pack: {
        packId: 'a-pack',
        name: 'A pack',
        tools: ['a-tool'],
        displayOrder: 1,
        enabled: true,
        guide: 'Log in with `gh auth login`.',
        requiresRepos: true,
        requiresRdp: true,
        desktop: 'xfce',
      },
      tools: [tool()],
    })
    expect(describePack({ file })).toMatchObject({
      guide: 'Log in with `gh auth login`.',
      requiresRepos: true,
      requiresRdp: true,
      desktop: 'xfce',
    })
  })
})

/**
 * WHAT THE PACK WILL ASK YOU FOR, before you consent to installing it (issue #189, ADR-0013).
 *
 * The disclosure is the control that carries what scanning cannot, and "this pack wants an API
 * key on your box" is exactly that kind of fact — it belongs beside "how many steps run as
 * root", not on the create form the operator only reaches after saying yes.
 */
describe('the inputs a pack declares', () => {
  const withInputs = (inputs: unknown) =>
    packFileSchema.parse({
      version: 1,
      pack: { packId: 'a-pack', name: 'A pack', tools: ['a-tool'], displayOrder: 1, enabled: true, inputs },
      tools: [tool()],
    })

  it('names and labels them, and says which are required and which are secret', () => {
    const file = withInputs([
      { name: 'HEADLONG_HEADLESS', label: 'Headless install', required: true, default: '1' },
      { name: 'HEADLONG_API_KEY', label: 'Headlong API key', secret: true },
    ])
    expect(describePack({ file }).inputs).toEqual([
      { name: 'HEADLONG_HEADLESS', label: 'Headless install', required: true, secret: false },
      { name: 'HEADLONG_API_KEY', label: 'Headlong API key', required: false, secret: true },
    ])
  })

  it('carries no value, not even a declared default', () => {
    // The question this list answers is "what will I be asked", not "what will be sent". A
    // default is a value, and a reader who saw one would take it for an answer already given.
    const file = withInputs([{ name: 'A', label: 'A', default: 'a-default-value' }])
    expect(JSON.stringify(describePack({ file }).inputs)).not.toContain('a-default-value')
  })

  it('is an empty list, not undefined, for a pack that asks for nothing', () => {
    // A field a UI has to render something for, like `summaryIsComplete` — an absent one is a
    // page that quietly says nothing.
    expect(describePack({ file: withInputs(undefined) }).inputs).toEqual([])
  })
})
