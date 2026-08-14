import { AppShell } from '../components/AppShell'
import { GITHUB_URL, repoDocUrl } from '../lib/links'

/**
 * Everything the UI can do, on one page (rockysurf-n0zr.3, issue #16).
 *
 * Two rules shaped this file:
 *
 *  - EVERY SECTION SUMMARIZES AND LINKS; NONE FORKS. The normative statements live in the
 *    repository's docs (SECURITY.md, docs/self-hosting.md, the pack and provider contracts) —
 *    a help page that restates them in full is a second copy waiting to drift. Each section
 *    says enough to act on and names the document that wins.
 *
 *  - NOTHING HERE PROMISES WHAT THE PRODUCT DOES NOT DO. The billing sentences, the token
 *    model, the scope defaults and the blast-radius line are lifted from documents that were
 *    themselves written against the code — if a claim below surprises you, the linked doc has
 *    the evidence.
 *
 * The agents callout sits first because it is the request this page was built around: the MCP
 * server and the Agent Skills are how the power of Rocky Surf reaches a coding agent.
 */

const MCP_CLIENT_SNIPPET = `{
  "mcpServers": {
    "rockysurf": {
      "command": "npx",
      "args": ["-y", "rockysurf", "mcp"],
      "env": {
        "ROCKYSURF_TOKEN": "the-token-you-just-minted",
        "ROCKYSURF_URL": "http://127.0.0.1:3000"
      }
    }
  }
}`

const SECTIONS = [
  ['agents', 'Your coding agents'],
  ['create', 'Creating a server'],
  ['boot', 'While it boots'],
  ['connect', 'Connecting'],
  ['lifecycle', 'Start, stop, terminate'],
  ['repositories', 'Private repositories'],
  ['costs', 'Costs and the caps'],
  ['packs', 'Surge Packs and tools'],
  ['settings', 'Settings'],
  ['docs', 'The full documentation'],
] as const

export function HelpPage() {
  return (
    <AppShell title="Help" className="help">
      <nav className="help-toc" aria-label="On this page">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <section className="agents-callout" id="agents">
        <h2>Give the power of Rocky Surf to your coding agents</h2>
        <p>
          An agent can create, inspect, stop and destroy its own boxes — under the same server-side
          limits that apply to you, because there is no second code path to escape through.
        </p>
        <div className="agents-grid">
          <div>
            <h3>The MCP server</h3>
            <p>Mint a token, then point your MCP client at it — for Claude Code, <code>.mcp.json</code> in your project:</p>
            <pre>
              <code>
                # from a built checkout — until v0.1.0 is on npm,{'\n'}
                # this file IS the rockysurf command:{'\n'}
                node packages/rockysurf/dist/bin.js token
              </code>
            </pre>
            <pre>
              <code>{MCP_CLIENT_SNIPPET}</code>
            </pre>
            <p className="hint">
              That JSON is the shape v0.1.0 ships. Until the packages are on npm, <code>npx</code>{' '}
              has no <code>rockysurf</code> to fetch — use{' '}
              <code>"command": "node"</code> with{' '}
              <code>"args": ["&lt;your-checkout&gt;/packages/rockysurf/dist/bin.js", "mcp"]</code>{' '}
              and the same <code>env</code>.
            </p>
            <p>
              Nothing in that JSON grants a permission. What the agent may do comes from{' '}
              <code>mcp.scopes</code> in your config file, and defaults to <code>[read, stop]</code>{' '}
              — <code>create</code> and <code>terminate</code> are separate opt-ins, because making
              a box costs money and destroying one costs work.
            </p>
          </div>
          <div>
            <h3>Agent Skills</h3>
            <p>
              The repository ships two skills a Claude Code session started in a checkout picks up
              with no install step: <code>creating-surge-packs</code> interviews you and writes a
              pack that passes the real smoke harness, and <code>adding-providers</code> covers
              switching on a cloud or adding one Rocky Surf does not have yet. Outside a checkout,
              copy one in:
            </p>
            <pre>
              <code>cp -r .claude/skills/creating-surge-packs ~/.claude/skills/</code>
            </pre>
            <p>
              <a href={repoDocUrl('.claude/skills/README.md')} target="_blank" rel="noreferrer">
                About the skills
              </a>
            </p>
          </div>
        </div>
        <p className="agents-footnote">
          The honest claim is <em>budget-capped, not sandboxed</em>: in the worst case, a fully
          compromised client with every scope can destroy this installation&rsquo;s servers and
          spend up to your configured cap — and cannot read a stored secret, obtain an SSH key, or
          exceed the limits by any MCP-shaped route. The whole argument:{' '}
          <a href={repoDocUrl('SECURITY.md')} target="_blank" rel="noreferrer">
            the MCP threat model
          </a>
          .
        </p>
      </section>

      <section id="create">
        <h2>Creating a server</h2>
        <p>
          Pick a cloud, pick a Surge Pack (the software the box is born with), describe what the
          machine should be — architecture included, arm64 is first-class — and optionally declare
          the repositories it will work on. Declared repository URLs are checked before any machine
          is launched, with the same token the box would use, so a typo fails in seconds instead of
          after a full boot on a box that then keeps billing. A refusal names the URL and the token
          that was tried, and you can create anyway — the check is a prediction, not a guarantee.
        </p>
      </section>

      <section id="boot">
        <h2>While it boots</h2>
        <p>
          The server page shows the install as it happens: a step timeline fed by the box itself and
          a live log tail. When the box reaches <em>running</em>, the pack&rsquo;s own getting-started
          guide appears — written by the pack author, including anything the install could not
          finish on your behalf (signing agents in, for instance: no credential of yours reaches a
          box during bootstrap). A failed box says why, and says whether the underlying instance is
          still billing.
        </p>
      </section>

      <section id="connect">
        <h2>Connecting</h2>
        <p>
          Every running server shows its SSH command, and its private key can be downloaded as a{' '}
          <code>.pem</code> — the one place in the system that hands out decrypted secret material,
          and it is ownership-checked and audited. Packs that ship a desktop show remote-desktop
          instructions instead of making you guess.
        </p>
      </section>

      <section id="lifecycle">
        <h2>Start, stop, terminate</h2>
        <p>
          A stopped box keeps its disk and loses its compute bill — storage still costs money, just
          much less. On AWS and GCP the public IP changes across a stop/start cycle; on Hetzner and
          Azure it survives. Machines you brought yourself (BYO) cannot be stopped or started — their
          power is not Rocky Surf&rsquo;s to manage — and terminating a BYO host is bookkeeping: it
          returns the host to the pool and deliberately runs nothing on a machine Rocky Surf does
          not own. The per-provider evidence:{' '}
          <a href={repoDocUrl('docs/providers/capability-matrix.md')} target="_blank" rel="noreferrer">
            the capability matrix
          </a>
          .
        </p>
      </section>

      <section id="repositories">
        <h2>Private repositories</h2>
        <p>
          Access tokens are configured per repository in Settings, and a box receives only the
          tokens its own declared repositories select — a box created for one repo does not carry
          the others&rsquo; credentials. The trade worth knowing before you meet it: there is no way
          to add a token to a running box. If you later need a private repository nobody declared at
          create, the options are to terminate and recreate with it declared, or to authenticate
          that one clone by hand. The create form resolves each URL as you type and says which
          token will be used, or that nothing matches yet.
        </p>
      </section>

      <section id="costs">
        <h2>Costs and the caps</h2>
        <p>
          Every server row is priced at create from the provider&rsquo;s own quote, and the Costs
          page shows month-to-date and lifetime estimates — per currency, never summed across them,
          because that number would be fiction. Three limits are enforced server-side on the create
          path, before anything is provisioned: concurrent servers, creates per hour, and an
          optional monthly spend cap. Refusals carry the machine-readable reason, so an agent that
          hits the cap can report it and stop instead of retrying blindly.
        </p>
      </section>

      <section id="packs">
        <h2>Surge Packs and tools</h2>
        <p>
          A Surge Pack is the software a box is created with, written as YAML: a list of tools with
          idempotent, architecture-aware install scripts, plus the author&rsquo;s post-boot guide.
          Six ship with Rocky Surf, and the Tools and Surge Packs admin pages let you inspect and
          edit what this installation offers. Writing your own is a contract, and CI enforces the
          mechanical half of it:{' '}
          <a href={repoDocUrl('docs/writing-a-pack.md')} target="_blank" rel="noreferrer">
            writing a pack
          </a>{' '}
          — or hand that contract to your agent via the <code>creating-surge-packs</code> skill
          above.
        </p>
        <p>
          <strong>Pack Shop</strong> is where community packs come from. Packs marked{' '}
          <em>official</em> shipped with the release you are running; everything else carries the
          label you gave its registry in your config file, and no registry can call itself
          official. Installing one takes effect immediately — no restart.
        </p>
        <p>
          Before you install anything from a registry, that page shows you{' '}
          <strong>every script the pack will run, verbatim</strong>, which of them run as root, and
          every URL they download from. Read it. The registry&rsquo;s automated checks prove a pack
          is well-formed and survives being resumed; they cannot prove it is safe, because an
          install script is arbitrary shell running as root on your box.
        </p>
      </section>

      <section id="settings">
        <h2>Settings</h2>
        <p>
          Settings is admin-only because it edits the config file — the document that holds provider
          sections, limits, and what the MCP server is allowed to do. Token fields take the{' '}
          <em>name</em> of an environment variable, never the secret itself, so credentials stay in
          your environment and out of the file. Changes to the file are picked up when the process
          restarts, and the create form will tell you when an entry exists that the running process
          has not restarted into.
        </p>
      </section>

      <section id="docs">
        <h2>The full documentation</h2>
        <p>
          This page summarizes; these documents decide. Self-hosting (install paths, where the data
          lives, backup):{' '}
          <a href={repoDocUrl('docs/self-hosting.md')} target="_blank" rel="noreferrer">
            docs/self-hosting.md
          </a>
          . Security (credential custody, SSH trust, the MCP threat model):{' '}
          <a href={repoDocUrl('SECURITY.md')} target="_blank" rel="noreferrer">
            SECURITY.md
          </a>
          . Providers, each with its least-privilege credential:{' '}
          <a href={repoDocUrl('docs/providers/capability-matrix.md')} target="_blank" rel="noreferrer">
            the capability matrix
          </a>
          . Extending it:{' '}
          <a href={repoDocUrl('docs/writing-a-pack.md')} target="_blank" rel="noreferrer">
            writing a pack
          </a>{' '}
          and{' '}
          <a href={repoDocUrl('docs/writing-a-provider.md')} target="_blank" rel="noreferrer">
            writing a provider
          </a>
          . Everything else starts at{' '}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            the repository
          </a>
          .
        </p>
      </section>
    </AppShell>
  )
}
