import { Link } from 'react-router'
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
  ['git-auth', 'Git Auth'],
  ['costs', 'Costs and the caps'],
  ['packs', 'Surge Packs and tools'],
  ['settings', 'Settings'],
  ['backup', 'Backing up your data'],
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
          Every running server shows its SSH command. If you pasted your own public key when you
          created the box, that command uses it directly — no key file to manage. Rocky Surf also
          authorizes a key of its own while it provisions the box, whether or not you supplied one:
          it installs everything over its own SSH connection, so it needs a way in that does not
          depend on a key only you hold. While that key is still authorized it can be downloaded as
          a <code>.pem</code> — the one place in the system that hands out decrypted secret
          material, ownership-checked and audited, and safe to re-download if you lose it — and it
          is your recovery path in the meantime. Once bootstrap finishes on a box you supplied a key
          for, Rocky Surf&rsquo;s own key is removed and that recovery path goes with it: your key
          becomes the only one on the box, on purpose. Packs that ship a desktop show remote-desktop
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
          token will be used, or that nothing matches yet. How to give Rocky Surf a token in the
          first place is <a href="#git-auth">Git Auth</a>, below.
        </p>
      </section>

      {/*
        GIT AUTH (rockysurf-7fyf.3, owner scope addition).

        Written to the same rule as every other section here — summarize, link the normative doc,
        promise nothing the code does not do — with one extra constraint the owner set: plain
        sentences, no recommendations and no trade-off talk. What each approach IS and how to set
        it up. The comparison between them belongs in SECURITY.md and ADR-0007, which are linked.

        Every claim below is a fact about the shipped code rather than about the plan: the client
        ID needs a restart (it lives in the config file, read once at boot) while the connected
        token does not (it lives in the encrypted store, read at create). Both are stated.
      */}
      <section id="git-auth">
        <h2>Git Auth</h2>
        <p>
          The repositories you list when creating a server are cloned onto the box during setup.
          Public repositories clone with no credential. Private ones need a GitHub token, and there
          are two ways to give Rocky Surf one — a connected account, or a token per repository. Both
          are set up on the <Link to="/settings">Settings</Link> page, under{' '}
          <em>GitHub access tokens</em>.
        </p>
        <p>
          The catch-all token is also written onto the box as <code>GITHUB_TOKEN</code>, which is the
          variable <code>gh</code> and most CI-aware scripts read with no further configuration.
        </p>

        <h3>Connect GitHub</h3>
        <p>
          One button, and the token covers every repository your GitHub account can reach. It takes
          a one-time setup by whoever runs this installation, then a connect by each person using
          it.
        </p>
        <p>
          <strong>Setup, once.</strong> Register an OAuth App at{' '}
          <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
            github.com/settings/applications/new
          </a>
          . The form requires a Homepage URL and a callback URL, but the device flow never visits
          either — <code>http://localhost:3000</code> satisfies both. On the same form, tick{' '}
          <strong>Enable Device Flow</strong> and leave <strong>Expire user access tokens</strong>{' '}
          unticked. Copy the app&rsquo;s
          Client ID into the <em>OAuth App client ID</em> box in Settings and restart Rocky Surf. The
          Client ID is public and needs no client secret; the device flow uses none.
        </p>
        <p>
          <strong>Connecting, per person.</strong> Press <strong>Connect GitHub</strong> in Settings.
          Rocky Surf shows a short code and a link to github.com; enter the code there and approve.
          The token comes back to Rocky Surf.
        </p>
        <p>
          The token is user-level: it can reach every repository your account can, it does not
          expire, and it is stored encrypted rather than in the configuration file. It applies
          immediately — no restart — and is used by the servers you create. <strong>Disconnect</strong>{' '}
          makes Rocky Surf forget it; revoking it at GitHub is a separate step, at{' '}
          <a href="https://github.com/settings/applications" target="_blank" rel="noreferrer">
            github.com/settings/applications
          </a>
          . Connecting GitHub obtains a credential for cloning; it is not a way to sign in to Rocky
          Surf.
        </p>

        <h3>A token per repository</h3>
        <p>
          Create a fine-grained personal access token on GitHub, scoped to the one repository, with
          contents read and write. In Settings, press <strong>Add a token</strong>, enter the
          repository as <code>owner/name</code>, and paste the token.
        </p>
        <p>
          The token is written into the configuration file, so treat that file as a credential, and
          it applies after Rocky Surf is restarted. The configuration file also accepts{' '}
          <code>{'${GITHUB_PAT}'}</code>-style references to environment variables if you edit it by
          hand.
        </p>

        <h3>Which token a clone uses</h3>
        <p>
          A token entered for a specific repository is used for that repository. Everything else
          uses the catch-all — a connected account if there is one, otherwise the unscoped token in
          the configuration file. A repository matched by neither is cloned anonymously, which works
          for public repositories and fails for private ones.
        </p>
        <p>
          <a href={repoDocUrl('docs/self-hosting.md')} target="_blank" rel="noreferrer">
            Repositories and how private ones clone
          </a>{' '}
          &middot;{' '}
          <a
            href={repoDocUrl('docs/adr/0007-github-credentials-two-paths.md')}
            target="_blank"
            rel="noreferrer"
          >
            ADR-0007: where each credential lives
          </a>
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

      {/*
        BACKUP (rockysurf-prqc, issue #89). Every path and filename below is stated, not
        summarized further, because "exactly what to back up" is the request — a reader who
        wants to act on this should not have to open self-hosting.md first to find a filename.
        The normative version, including the stop-first WAL caveat and the restore procedure,
        stays in docs/self-hosting.md; this section is the answer to "what" and "why it's
        sensitive," linked from the reminder shown on the dashboard.
      */}
      <section id="backup">
        <h2>Backing up your data</h2>
        <p>
          Rocky Surf keeps everything it knows in one directory, and there is no hosted copy of
          any of it — back it up yourself, or a lost machine takes your server records, your
          cloud credentials and your SSH keys with it.
        </p>
        <p>
          <strong>Where it is:</strong> <code>~/.rockysurf</code> by default, or whatever{' '}
          <code>server.dataDir</code> is set to in your config file; <code>/data</code> in the
          Docker Compose volume. Rocky Surf prints the config file it read on every start
          (<code>config: &lt;path&gt;</code>), which is the fastest way to confirm where a
          running installation actually keeps its data.
        </p>
        <p>
          <strong>What is in it, and back up all of it together:</strong>
        </p>
        <ul>
          <li>
            <code>rockysurf.db</code> — the SQLite database: every server row, pack, session and
            encrypted secret.
          </li>
          <li>
            <code>secret.key</code> — the master key those secrets are encrypted with. Lose it
            and every secret in the database is unrecoverable ciphertext; a database without it
            is undecryptable on its own.
          </li>
          <li>
            <code>rockysurf.config.yaml</code> — your configuration. If you pasted a per-repository
            GitHub token directly into a Settings field rather than referencing an environment
            variable, that token is written into this file too.
          </li>
          <li>
            <code>packs/</code>, if you keep your own pack files here — the software your servers
            are created with.
          </li>
        </ul>
        <p>
          <strong>This is sensitive.</strong> Together, <code>secret.key</code> and{' '}
          <code>rockysurf.db</code> decrypt every provider credential, every managed server&rsquo;s
          SSH private key, and any remote-desktop password Rocky Surf holds for you — a
          Connect-GitHub token lives there too. A backup is that same secret material, copied.
          Store it somewhere private, encrypt it, or keep <code>secret.key</code> out of the
          backup entirely by setting <code>ROCKYSURF_SECRET_KEY</code> instead of letting Rocky
          Surf write it to disk.
        </p>
        <p>
          <strong>Stop Rocky Surf before copying the database</strong> — SQLite&rsquo;s write-ahead
          log means a plain file copy from a running installation can silently miss the last few
          minutes of writes. The exact commands, for both an <code>npx</code>/from-source install
          and Docker Compose, plus how to restore, are in{' '}
          <a href={repoDocUrl('docs/self-hosting.md#backup-and-restore')} target="_blank" rel="noreferrer">
            Backup and restore
          </a>
          .
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
