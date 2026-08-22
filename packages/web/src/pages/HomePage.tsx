import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { AppShell } from '../components/AppShell'
import { GITHUB_URL, repoDocUrl } from '../lib/links'

/**
 * What Rocky Surf is, how to run it, and how to keep it from surprising your cloud bill
 * (rockysurf-n0zr.2, issue #16).
 *
 * THIS PAGE AND THE README CARRY THE SAME WORDS. Not a summary of them and not a variation on
 * them — the same sentences, in the same order, adapted only from markdown to components. A
 * reader who lands here and a reader who lands on GitHub should come away having read the same
 * document. If you change a sentence here, change it in `README.md` in the same commit; a
 * paraphrase in one of the two is the drift this arrangement exists to prevent.
 *
 * Every claim below is grounded in a document that was itself written against the code —
 * `docs/self-hosting.md` for the paths and the data directory, `CORE-PRINCIPLES.md` for the five,
 * `SECURITY.md` for the caps, `docs/providers/` for the credentials. Nothing here promises what
 * the product does not do.
 *
 * `title=""` suppresses the shell's `<h1>`; the thesis line below the hero is this page's real
 * heading.
 */

const LIMITS_SNIPPET = `limits:
  maxServers: 5
  createRatePerHour: 4
  spendCap:
    amount: 50
    currency: USD`

const PACK_SNIPPET = `version: 1
pack:  { packId: rust-dev, name: Rust, tools: [build-essential, git, rustup] }
tools: [ … ]`

const COMPOSE_SNIPPET = `git clone https://github.com/amroja-biz/rockysurf
cd rockysurf
docker compose up --build`

const PASSWORD_SNIPPET = `docker compose logs rockysurf | grep -A3 'first boot'`

const BACKUP_SNIPPET = `tar czf rockysurf-backup-$(date +%F).tar.gz -C ~ .rockysurf

# Docker Compose: stop, then tar the volume out
docker run --rm -v rockysurf-data:/data -v "$PWD":/backup alpine \\
  tar czf /backup/rockysurf-backup-$(date +%F).tar.gz -C /data .`

/** The provider rows, same wording as the README's table. */
const PROVIDERS: readonly (readonly [string, ReactNode])[] = [
  [
    'Hetzner',
    <>Quickest start. Mint a read/write API token at console.hetzner.com and export it.</>,
  ],
  [
    'AWS',
    <>
      The standard credential chain. Needs an IAM policy and an explicit <code>sshAllowedCidr</code>
      .
    </>,
  ],
  [
    'Azure',
    <>
      Environment, managed identity, or <code>az login</code>. Needs a resource group and a
      least-privilege role.
    </>,
  ],
  [
    'GCP',
    <>
      Application Default Credentials. Needs a project and an explicit <code>sshAllowedCidr</code>.
    </>,
  ],
  ['BYO', <>Machines you already have, over SSH. No cloud API.</>],
]

/** The data directory, same wording as the README's table. */
const DATA_FILES: readonly (readonly [string, string])[] = [
  ['rockysurf.db', 'SQLite: your servers, packs, sessions and encrypted secrets'],
  ['secret.key', 'The master key those secrets are encrypted with'],
  ['rockysurf.config.yaml', 'Your configuration'],
  ['packs/', 'Your own pack files, if you keep any'],
]

/** The documentation table, same wording as the README's — linked out to the repository. */
const DOCS: readonly (readonly [string, string])[] = [
  ['docs/self-hosting.md', 'Install paths, data, upgrades, backup and restore'],
  ['SECURITY.md', 'Credential custody, SSH trust, the MCP threat model'],
  ['docs/adr/llms.txt', 'The architecture decisions — start here for the design'],
  ['docs/providers/capability-matrix.md', 'What each provider can do, and the evidence for it'],
  ['docs/writing-a-pack.md', 'The pack-author contract'],
  ['docs/writing-a-provider.md', 'Adding a cloud against the frozen SDK'],
  ['CONTRIBUTING.md', 'Development setup, gates, conventions'],
]

export function HomePage() {
  return (
    <AppShell title="" className="home">
      <img
        className="home-hero"
        src="/images/logo.png"
        alt="Rocky Surf — a lighthouse on a moonlit rocky shore"
        width={800}
        height={600}
      />

      <h1>Are your coding agents telling you they need their own space?</h1>
      <p className="home-lede">
        Have they been snooping around your laptop, exposing API keys? Or connecting to other apps
        without being told? And aren't you getting a little tired of killing them when you close
        your laptop by mistake?
      </p>
      <p className="home-lede">
        Rocky Surf solves this problem by making it easy to run agents where they belong — in
        cloud accounts that you own, preinstalled with your favorite tools and repos.
      </p>
      <p className="home-lede">
        Rocky Surf creates a Linux box on your own cloud account, installs your coding agents on
        it, and hands you an SSH command. Stop it tonight, start it tomorrow: your repo, your
        branches and your shell history are where you left them. A stopped box costs storage, not
        compute.
      </p>
      <p className="home-lede">
        One process you run yourself — web UI, HTTP API, SQLite file. One admin, no accounts, no
        telemetry, nothing hosted.
      </p>

      <section className="home-section">
        <h2>Bring your own cloud, keys and repos</h2>
        <ul className="home-claims">
          <li>
            <strong>BYOC — bring your own cloud.</strong> Your AWS account, your Hetzner project,
            Azure, GCP, or a machine you already own. Rocky Surf holds the credential and calls the
            API. The resources and the bill are yours.
          </li>
          <li>
            <strong>BYOK — bring your own keys.</strong> Your Claude Code subscription, your Codex
            login, your API keys. Rocky Surf installs the agents; you sign them in.
          </li>
          <li>
            <strong>BYOR — bring your own repos.</strong> Your GitHub repositories, cloned onto the
            box during setup using a token you supply.
          </li>
        </ul>
        <p>
          Rocky Surf resells nothing and sits in the middle of nothing. Proxying your cloud spend,
          pooling your API keys, holding your code — out of bounds by definition, not by
          preference.
        </p>
      </section>

      <section className="home-section">
        <h2>Five principles</h2>
        <p>
          Every issue and pull request should name the principle it serves. Long version:{' '}
          <a href={repoDocUrl('CORE-PRINCIPLES.md')} target="_blank" rel="noreferrer">
            CORE-PRINCIPLES.md
          </a>
          .
        </p>
        <ol className="home-principles">
          <li>
            <strong>
              Make it as easy as possible to create and manage cloud servers for agentic coding.
            </strong>{' '}
            The distance between &ldquo;I want a box&rdquo; and &ldquo;I am SSH&rsquo;d into a box
            with my agents installed&rdquo; is the number we are always shrinking.
          </li>
          <li>
            <strong>Make it as easy as possible to add a new cloud provider.</strong> A new cloud is
            one package and one config block, never a change to core.
          </li>
          <li>
            <strong>Make it as easy as possible to create Surge Packs.</strong> A pack is one YAML
            file. No registration, no gatekeeping, no build step.
          </li>
          <li>
            <strong>Make Rocky Surf easy to extend via modular components.</strong> Extension
            happens behind seams — the provider SDK, packs as data, thin clients over one API — not
            through them.
          </li>
          <li>
            <strong>Make it easy to combine components without coding.</strong> Composition is
            configuration. An operator wires up providers and caps spending without touching
            TypeScript.
          </li>
        </ol>
      </section>

      <section className="home-section">
        <h2>Install</h2>
        <p>Docker Compose, from a checkout — the path that works today:</p>
        <pre>
          <code>{COMPOSE_SNIPPET}</code>
        </pre>
        <p>It prints an admin password once:</p>
        <pre>
          <code>{PASSWORD_SNIPPET}</code>
        </pre>
        <p>
          Open <code>http://127.0.0.1:3000</code> and sign in with it. <code>npx rockysurf</code>{' '}
          (Node 24 or newer) arrives with v0.1.0.
        </p>
        <p>
          With no cloud configured you get an in-memory provider: create a server, watch it boot,
          terminate it, before pasting a real token.
        </p>

        <h3>Configuration</h3>
        <p>
          Settings live in one YAML file — <code>--config &lt;path&gt;</code>, else{' '}
          <code>./rockysurf.config.yaml</code>, else <code>~/.rockysurf/config.yaml</code>. Rocky
          Surf prints the one it used and writes web-UI changes back to it. Start from{' '}
          <a href={repoDocUrl('rockysurf.config.example.yaml')} target="_blank" rel="noreferrer">
            rockysurf.config.example.yaml
          </a>
          , where every value is the default. Under Docker the live file is in the{' '}
          <code>rockysurf-data</code> volume, not your checkout.
        </p>
        <p>
          Rocky Surf listens on <code>127.0.0.1</code> only, behind one password and no TLS, and it
          holds your cloud credentials and an SSH key per server — widen <code>server.host</code>{' '}
          and put a proxy or firewall in front. Detail:{' '}
          <a href={repoDocUrl('docs/self-hosting.md')} target="_blank" rel="noreferrer">
            docs/self-hosting.md
          </a>{' '}
          and{' '}
          <a href={repoDocUrl('SECURITY.md')} target="_blank" rel="noreferrer">
            SECURITY.md
          </a>
          .
        </p>
      </section>

      <section className="home-section">
        <h2>Creating a server</h2>

        <h3>Pick a provider</h3>
        <p>Every provider ships switched off, so a fresh install cannot spend money by accident.</p>
        <div className="home-table">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Getting the credential</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map(([name, detail]) => (
                <tr key={name}>
                  <td>
                    <strong>{name}</strong>
                  </td>
                  <td>{detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>A create can fail because your cloud login expired.</strong> AWS, Azure and GCP
          use the same credentials as the rest of your tooling, and for most people those expire:{' '}
          <code>aws sso login</code>, <code>az login</code>,{' '}
          <code>gcloud auth application-default login</code>. Hetzner&rsquo;s token is long-lived.
          Setup per provider:{' '}
          <a href={`${GITHUB_URL}/tree/main/docs/providers`} target="_blank" rel="noreferrer">
            docs/providers/
          </a>
          .
        </p>

        <h3>Pick a Surge Pack</h3>
        <p>
          A <strong>Surge Pack</strong> is the software your box is built with, one YAML file:
        </p>
        <pre>
          <code>{PACK_SNIPPET}</code>
        </pre>
        <p>
          A readable list of tools and install scripts — reviewable in a pull request, not baked
          into someone else&rsquo;s image — and your box is built from it while you watch the
          install feed. Ten ship in{' '}
          <a href={`${GITHUB_URL}/tree/main/packs`} target="_blank" rel="noreferrer">
            packs/
          </a>
          , covering Claude Code, Codex CLI, Amp, OpenCode, Gas Town and others.
        </p>
        <p>
          Each pack carries a <code>guide</code>, shown once the box is running. No credential of
          yours reaches a box during bootstrap, so that is where a pack tells you how to sign the
          agents in.
        </p>
        <p>
          Scripts must be idempotent, architecture-aware and non-interactive; CI runs every shipped
          pack&rsquo;s twice, on amd64 and arm64. Contract:{' '}
          <a href={repoDocUrl('docs/writing-a-pack.md')} target="_blank" rel="noreferrer">
            docs/writing-a-pack.md
          </a>{' '}
          — or let the repo&rsquo;s Claude Code skill write yours.
        </p>

        <h3>Connect a GitHub repo</h3>
        <p>
          The create form&rsquo;s <strong>Repositories</strong> field takes one git URL per line,
          cloned into the box&rsquo;s home directory. Public URLs clone anonymously; private ones
          need a GitHub token, and <Link to="/settings">Settings</Link> takes one two ways:
        </p>
        <ul className="home-claims">
          <li>
            <strong>Connect GitHub</strong> — press the button, enter the code it shows on
            github.com, approve. It asks for the <code>repo</code> scope: read and write on every
            repository the account can reach. The token is stored encrypted, not in the config file.
            You register the OAuth App yourself; Rocky Surf ships none of its own, because whoever
            registers one can revoke its tokens.
          </li>
          <li>
            <strong>Access tokens</strong> — paste a personal access token. One covers everything,
            or add tokens per repository, owner or host; most specific wins. These land in the
            config file, so treat it as a credential, or point it at{' '}
            <code>${'{'}GITHUB_PAT{'}'}</code>.
          </li>
        </ul>
        <p>
          Packs read the token as <code>$GITHUB_TOKEN</code>, kept out of <code>ps</code> output and{' '}
          <code>.git/config</code>.
        </p>
      </section>

      <section className="home-section">
        <h2>Where your servers and settings are kept</h2>
        <p>
          One directory holds everything: <code>~/.rockysurf</code>, <code>/data</code> in the
          container, <code>server.dataDir</code> in general. Created owner-only on first boot.
        </p>
        <div className="home-table">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>What it is</th>
              </tr>
            </thead>
            <tbody>
              {DATA_FILES.map(([file, what]) => (
                <tr key={file}>
                  <td>
                    <code>{file}</code>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Back up the whole directory</strong> — the database and the key are useless
          without each other — and <strong>stop the process first</strong>, because the database
          runs in WAL mode and copying it live can silently lose the last few minutes.
        </p>
        <pre>
          <code>{BACKUP_SNIPPET}</code>
        </pre>
        <p>
          If you cannot stop it, use SQLite&rsquo;s online backup (
          <code>sqlite3 rockysurf.db &quot;.backup out.db&quot;</code>) and copy{' '}
          <code>secret.key</code> alongside. Restoring is putting the directory back; migrations run
          on boot.
        </p>
        <p>
          <strong>
            The backup holds every provider credential and every server&rsquo;s private key
          </strong>
          , next to the key that decrypts them — so encrypt it, or keep <code>secret.key</code>{' '}
          outside the filesystem with <code>ROCKYSURF_SECRET_KEY</code>. And <strong>
            <code>docker compose down -v</code> destroys the volume
          </strong>
          , taking the SSH keys for boxes that may still be running and billing.
        </p>
      </section>

      <section className="home-section">
        <h2>Put a safety net under your cloud account</h2>
        <p>
          Rocky Surf enforces guardrails server-side, so they cover the web UI, the CLI and the MCP
          tools alike:
        </p>
        <pre>
          <code>{LIMITS_SNIPPET}</code>
        </pre>
        <p>
          Set them, but do not stop there. The spend cap is an estimate from bundled price data, not
          a bill: an offering your provider quotes no price for spends money the cap cannot see. And
          hitting it blocks new servers without stopping running ones — a budget cap, not a sandbox.
        </p>
        <p>Set limits at the cloud too, where the numbers come from your actual bill:</p>
        <ul className="home-claims">
          <li>
            <strong>Billing alerts and budgets.</strong> AWS Budgets and Cost Anomaly Detection;
            Azure Cost Management; GCP billing alerts. Most notify rather than stop, so set the
            threshold well below the number that would hurt.
          </li>
          <li>
            <strong>A blast radius you chose.</strong> Give Rocky Surf its own AWS account, Azure
            subscription, GCP or Hetzner project, and a mistake costs you that project and nothing
            else.
          </li>
          <li>
            <strong>A credential that can only do this job.</strong> The AWS role in{' '}
            <a href={repoDocUrl('deploy/aws/iam-role.yaml')} target="_blank" rel="noreferrer">
              deploy/aws/iam-role.yaml
            </a>
            , and the least-privilege roles in the provider docs.
          </li>
          <li>
            <strong>An occasional look at the console.</strong> Rocky Surf flags disagreements
            between its records and the cloud&rsquo;s, but it only knows about resources it created.
          </li>
        </ul>
      </section>

      <section className="home-section">
        <h2>More</h2>
        <div className="home-table">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>What it covers</th>
              </tr>
            </thead>
            <tbody>
              {DOCS.map(([path, covers]) => (
                <tr key={path}>
                  <td>
                    <a href={repoDocUrl(path)} target="_blank" rel="noreferrer">
                      <code>{path}</code>
                    </a>
                  </td>
                  <td>{covers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Rocky Surf is deliberately small: no devcontainers, no throwaway per-task sandboxes, no
          Windows, no multi-tenancy. <code>rockysurf mcp</code> exposes the lifecycle as MCP tools,
          so an agent can create, inspect, stop and destroy its own boxes — <code>create</code> and{' '}
          <code>terminate</code> are separate opt-in scopes.
        </p>
      </section>

      <section className="home-section">
        <h2>License</h2>
        <p>
          <a href={repoDocUrl('LICENSE')} target="_blank" rel="noreferrer">
            MIT
          </a>
          . <strong>The Rocky Surf name and logo are not covered by it</strong> — fork the code
          freely and give the fork its own name. See{' '}
          <a href={repoDocUrl('TRADEMARK.md')} target="_blank" rel="noreferrer">
            TRADEMARK.md
          </a>
          .
        </p>
      </section>

      <p className="home-links">
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <Link to="/help">Help</Link>
        <Link to="/servers/new">Create a server</Link>
      </p>
    </AppShell>
  )
}
