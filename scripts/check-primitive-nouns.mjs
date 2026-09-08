#!/usr/bin/env node
/**
 * The four primitives are capitalized in prose: Provider, Surge Pack, Tool, Server (#464).
 *
 * The rule and its reasoning live in `docs/memories/2026-09-08-capitalized-product-nouns.md`.
 * This script is the part that keeps it applied. The 2026-09-07 ruling was written into the
 * files touched that day and lived in a pass-along; within a day the next agent had lowercased
 * "provider" again in new copy. A convention nothing checks is a convention that lasts one
 * session.
 *
 * WHAT IT SCANS. Markdown only, and only the markdown that describes the product as it is:
 *
 *   - `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, `CLAUDE.md`,
 *     `CORE-PRINCIPLES.md`, `TRADEMARK.md`
 *   - `docs/**` except `docs/adr/` and `docs/memories/` and `docs/history/`
 *   - every `README.md` under `packages/`, and `packs/README.md`
 *   - `.agents/skills/**`
 *
 * The exclusions are all the same kind of thing: a dated record of what was true when it was
 * written. An ADR body is never rewritten, a memory is a stamped decision, `docs/history/` says
 * of itself "read them as history, not as documentation", and `.pass-along/` is a handoff note.
 * Editing any of them to satisfy a style rule would be falsifying a record.
 *
 * String literals under a package's `src` are NOT scanned. Deciding whether a `'server'` inside a
 * TypeScript file is prose, an identifier, a URL segment or an API field needs a parser and a
 * judgement, and a check that guesses would either miss most of them or block on the ones it got
 * wrong. The sweep did those by hand instead (#464); this script guards the surface where a
 * regex can be right.
 *
 * WHAT IT LOOKS FOR. The lowercase forms of the four nouns, outside code spans and fenced code
 * blocks, minus the allow-list below of senses that are correctly lowercase. Every allow-list
 * entry is a phrase where the word is somebody else's term or an ordinary noun — the same list
 * the memory gives in prose. If this check fires on a sentence where the lowercase word really
 * is the ordinary sense, add the phrase to ALLOWED with a comment saying why; do not capitalize
 * a word that is not the Rocky Surf concept just to make the check pass.
 *
 * Exits 0 when every lowercase use is an allowed sense, 1 with a file:line list when it is not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Top-level markdown that describes the product now. */
const ROOT_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CORE-PRINCIPLES.md',
  'TRADEMARK.md',
]

/** Trees walked for `.md`. */
const TREES = ['docs', '.agents/skills', 'packages', 'packs']

/** Paths under those trees that are dated records rather than documentation — see the header. */
const SKIP = ['docs/adr', 'docs/memories', 'docs/history', 'node_modules', '.pass-along']

/**
 * Lowercase senses that are correct, longest first so a longer phrase wins over a shorter one.
 * Each is a real sentence shape from this repository, and each is here for a stated reason.
 */
const ALLOWED = [
  // --- provider: somebody else's term for a different thing ---
  'identity provider', // AWS/GitHub OIDC sign-in, docs/providers/aws.md
  'oidc provider', // the workload identity pool's provider, docs/providers/gcp.md
  'sign-in provider', // the same IAM object, said in plainer words
  'service provider', // the generic industry term
  'resource provider', // Azure's own name for a namespace you register
  'pool provider', // GCP's workload identity pool provider resource
  'providers section of the rocky surf shop', // the shop repository's own anchor text
  'providers directory', // the `<dataDir>/providers` folder, a path
  'providers.json', // a file name that happens to survive the code-span strip
  // --- tool: MCP's word, a CLI, or the ordinary noun ---
  'mcp tool', // covers "MCP tools", "MCP tool call", "MCP tool list"
  'command-line tool', // hcloud, aws, az, gcloud — the cloud's own CLI
  'command line tool', // the same phrase without the hyphen
  'cloud’s own tool', // the table row in docs/agent-quickstart.md
  "cloud's own tool",
  'scheduling tool', // "a determinism guarantee, not a scheduling tool"
  'right tool for the job', // the idiom, if it ever appears
  'aws tool', // "point any AWS tool at one" — the vendor CLI
  'gcloud` tool', // "signs in the `gcloud` tool" — the span strip leaves the backtick
  'developer tools', // Apple's command line developer tools
  'system tools', // "tsc and vitest are not system tools"
  'admin tools', // the settings/costs/admin screens, .agents/skills/rockysurf-design/github.md
  'other amazing tools', // HomePage's marketing line about the wider world
  'the tools it assumes', // a skill's prerequisites — Docker, node, gh
  'tools, their install', // the same, in the reference-list rows
  'every tool the skill assumes',
  'install a tool on the user', // "no skill installs a tool on the user's machine"
  'name the tool, quote the check', // the prerequisites failure line
  'a tool is absent', // ditto
  'a tool is missing', // ditto
  'the missing tool', // ditto
  'which tool and where it comes from', // ditto
  'no tool can check', // "the naming rules, which no tool can check"
  'a tool treat it as a page', // rockysurf-design, about editors and `.prompt.md`
  'the same tool', // "logins performed by the same tool" — gcloud
  'productivity tool', // HomePage: "a personal productivity tool for software engineers"
  'coding tools', // HomePage: "pre-installed with coding tools"
  'tool calls', // an agent's tool calls, not a Surge Pack Tool
  'tool call', // the same, singular
  'script’s tools', // "let your script's tools talk" — apt-get and curl
  "script's tools",
  // --- server: the Rocky Surf process, a protocol server, or a vendor's product ---
  'mcp server', // the `rockysurf mcp` process
  'http server', // the test stubs and the embedded API
  'https server',
  'web server', // "no separate web server and no CORS anywhere"
  'ssh server', // OpenSSH, in the e2e harness
  'x server', // a display server, in the may-not-assume table
  'dns server', // the rebinding note in SECURITY.md
  'metadata server', // GCE's instance metadata endpoint
  'openssh server',
  'stub server', // the test-setup comment
  'the server is listening', // the Rocky Surf process
  'the server is still stopping', // the error copy is about a Server, but reads mid-sentence
  'the server process', // "the alternative to npx for the server process"
  'the server from starting', // "a bad file never stops the server from starting"
  'server mode', // beads' embedded/server mode, docs/surge-pack-contract.md
  'server types', // Hetzner's own catalogue word, and the Settings field that mirrors it
  'server and every client command', // `rockysurf token` mints for the MCP server
  'the server also inherits', // sshd, in the shell-environment table
  'on a server you can turn', // "on a server you can turn the fourth source off"
  'worth doing on a server', // provider-azure/README.md, about the host Rocky Surf runs on
  'somebody’s server', // "caught here rather than on somebody's server"
  "somebody's server",
  'operator’s server', // "they run as root on an operator's server" — that IS a Server, but the
  "operator's server", // shop's CONTRIBUTING is quoted here and its wording is not ours to change
  'github enterprise server', // a product name
  'server-side', // an adjective, kept for the hyphen-blind matcher
  'no such server', // the 404's meaning, quoted, in SECURITY.md
  'server with the', // "the client launches the server with the env block" — the MCP server
  'server checked into the repo', // README: the MCP config, project scope
  'server and workload identity', // the GCE metadata server, wrapped across two lines
  'destroy any server in it', // what a Hetzner token can do to the project, not to Servers
  'your other servers', // the same sentence's other half
  'server means the daemon is not running', // Docker's Server block, in a prerequisites table
  // --- the MCP threat model in SECURITY.md and the MCP sections elsewhere: every "tool" there
  //     is an MCP tool, named one per sentence, and MCP's word stays MCP's word ---
  'a tool the installation has not granted',
  'the tool’s absence',
  "the tool's absence",
  'a tool that *is* advertised',
  'which scope that tool needs',
  'a tool it was deliberately not granted',
  'no tool result',
  'a private key in a tool',
  'the route behind this tool',
  'tool surface',
  'without one — the tool',
  'injection reaches the tools',
  'default for a tool that', // "the default for a tool that manages Servers" — the MCP client
  'means the tool is not offered', // a withheld MCP tool
  'there is no tool', // "the agent reports there is no create_server tool"
  'tool is reporting this setting', // the same sentence in docs/self-hosting.md
  'a tool the', // "the default grant withholds it, and a tool the installation…"
  'the tools that do get offered', // the MCP tools an agent can see
  'holds the tools', // "The client holds the tools" — the MCP list
  'rocky surf tools', // "ask their agent to list its Rocky Surf tools"
  'from any tool', // "grant, from any tool" — any Azure client
  'needs no tool at all', // Hetzner needs no cloud CLI
  'signed in to both tools', // gh and npm, in the release SOP
  'a tool on the user', // "no skill installs a tool on the user's machine"
  'never install a tool', // the same rule, said again
  'some other tool already reads', // an environment variable another program on the box reads
  'four tools, all on', // Docker, node, gh, pnpm — the skill's prerequisites
  'only added one tool', // a quoted thing an author says to themselves
  'unknown tool', // quoted loader and harness output
  'references unknown tool', // the same, in full
  // --- quoted output, quoted titles, and words being discussed as words ---
  'adr-0003 — provider sdk shape', // an ADR's own title, in a link
  'rename the section to providers', // the composition error, quoted
  'the word "provider" covers', // the word itself, under discussion
  'add a provider', // a quoted user request the skill matches on
  'then a providers', // "then a `providers.<id>` section" — a config key across a wrapped span
  'composition root is missing', // a quoted CI failure that ends "— providers"
  'pack defines its own tools', // the shop CONTRIBUTING's section title, quoted
  'providers section of the rocky surf', // the shop repository's anchor text, wrapped
  'its pack.tools is', // a config key whose span opened on the previous line
  'tools: …', // the same, in a fenced-looking fragment
  'pack.tools', // the config key, when its code span opened on the line before
  'package: providers', // `providers.<id>`, the config key, across a wrapped span
  '… — providers', // the tail of the quoted composition-root failure in wiring.md
  'setting.** the tool', // "…is reporting this setting.** The tool exists" — an MCP tool
]

const WORD = /(?<![A-Za-z0-9_/-])(providers?|surge packs?|tools?|servers?)(?![A-Za-z0-9_/-])/g

/**
 * Blank out code so a `serverId`, a `providers:` key or a `#tool` anchor is never read as prose.
 *
 * Code spans collapse to one space, which is what lets an allow-list phrase span one: "no
 * `create_server` tool" reads as "no tool". An UNMATCHED backtick means a span that opened on an
 * earlier line and closes on a later one, so everything after it is code until proven otherwise —
 * the conservative direction for a check that must not cry wolf. Markdown link targets go too:
 * `](#tool)` and `](…#providers)` are addresses, not sentences.
 */
function stripCode(line) {
  const withoutTargets = line.replace(/\]\([^)]*\)/g, ']')
  let out = ''
  let i = 0
  while (i < withoutTargets.length) {
    if (withoutTargets[i] === '`') {
      const close = withoutTargets.indexOf('`', i + 1)
      if (close === -1) break // an open span: the rest of the line belongs to it
      out += ' '
      i = close + 1
    } else {
      out += withoutTargets[i]
      i += 1
    }
  }
  return out
}

function markdownFiles() {
  const files = ROOT_FILES.filter((name) => {
    try {
      return statSync(join(root, name)).isFile()
    } catch {
      return false
    }
  })
  for (const tree of TREES) walk(tree, files)
  return files
}

function walk(rel, into) {
  if (SKIP.some((skip) => rel === skip || rel.startsWith(`${skip}/`))) return
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) walk(child, into)
    else if (entry.name.endsWith('.md')) into.push(child)
  }
}

const failures = []

for (const file of markdownFiles()) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  let fenced = false
  /**
   * A skill's YAML frontmatter is not prose. Its `description:` is a matcher: it carries the
   * user's own words back ("add a provider", "make me a surge pack for X") so a harness can
   * recognise the request, and rewriting a quoted utterance would be rewriting the user.
   */
  let frontmatter = lines[0] === '---'
  lines.forEach((line, index) => {
    if (frontmatter) {
      if (index > 0 && line === '---') frontmatter = false
      return
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fenced = !fenced
      return
    }
    if (fenced) return

    // One space between words, so an allow-list phrase can span a code span that collapsed:
    // "no `create_server` tool" is matched by "there is no tool".
    let text = stripCode(line).replace(/\s+/g, ' ')
    const lowered = () => text.toLowerCase()
    for (const phrase of ALLOWED) {
      let at = lowered().indexOf(phrase)
      while (at !== -1) {
        text = text.slice(0, at) + ' '.repeat(phrase.length) + text.slice(at + phrase.length)
        at = lowered().indexOf(phrase, at + phrase.length)
      }
    }

    for (const match of text.matchAll(WORD)) {
      const word = match[0]
      if (word[0] === word[0].toUpperCase()) continue
      // The prose as this check reads it, so a phrase for ALLOWED can be copied straight out.
      failures.push(`${file}:${index + 1}: "${word}" in: ${text.trim()}`)
    }
  })
}

if (failures.length > 0) {
  console.error('check-primitive-nouns: lowercase primitives in prose (see')
  console.error('docs/memories/2026-09-08-capitalized-product-nouns.md for the rule):')
  console.error('')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('')
  console.error(`${failures.length} to fix. If one of these really is the ordinary sense of the`)
  console.error('word, add the phrase to ALLOWED in this script with a comment saying why.')
  process.exit(1)
}

console.log('check-primitive-nouns: ok — no lowercase primitives in prose')
