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

const DOCKER_CONFIG_SNIPPET = `docker compose cp rockysurf:/data/rockysurf.config.yaml ./rockysurf.config.yaml
$EDITOR rockysurf.config.yaml
docker compose cp ./rockysurf.config.yaml rockysurf:/data/rockysurf.config.yaml
docker compose restart`

const BACKUP_SNIPPET = `# npx or from source — stop it first (Ctrl-C, or systemctl stop)
tar czf rockysurf-backup-$(date +%F).tar.gz -C ~ .rockysurf

# Docker Compose
docker compose stop
docker run --rm -v rockysurf-data:/data -v "$PWD":/backup alpine \\
  tar czf /backup/rockysurf-backup-$(date +%F).tar.gz -C /data .
docker compose start`

/** The provider rows, same wording as the README's table. */
const PROVIDERS: readonly (readonly [string, ReactNode])[] = [
  [
    'Hetzner',
    <>
      The quickest start. Make a project at console.hetzner.com, mint a read/write API token, and
      export it — the config file references the environment variable.
    </>,
  ],
  [
    'AWS',
    <>
      The standard credential chain, never a key in the config file. Needs an IAM policy and an
      explicit <code>sshAllowedCidr</code>.
    </>,
  ],
  [
    'Azure',
    <>
      Your environment, a managed identity, or <code>az login</code>. Needs a resource group you
      create and a least-privilege role.
    </>,
  ],
  [
    'GCP',
    <>
      Application Default Credentials. Needs a project and an explicit <code>sshAllowedCidr</code>.
    </>,
  ],
  ['BYO', <>Machines you already have, driven over SSH. No cloud API involved.</>],
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
  ['docs/self-hosting.md', 'Both install paths, data, upgrades, backup and restore'],
  ['SECURITY.md', 'Credential custody, SSH trust, network defaults, the MCP threat model'],
  ['docs/adr/llms.txt', 'The architecture decisions — start here for the design'],
  [
    'docs/providers/capability-matrix.md',
    'What each provider can do, and the evidence behind each claim',
  ],
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

      <h1>Rocky Surf gives coding agents a real Linux server that stays put.</h1>
      <p className="home-lede">
        It creates the box on your own cloud account, installs your agents and their tools before
        you first log in, and hands you an SSH command. Stop the box when you are done for the day;
        start it tomorrow and your repo, your branches and your shell history are where you left
        them. A stopped box costs storage, not compute.
      </p>
      <p className="home-lede">
        It is one process you run yourself: a web UI, an HTTP API, and a SQLite file beside them.
        One admin, no accounts, no tenant, no telemetry, nothing hosted anywhere.
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
          Rocky Surf resells nothing and sits in the middle of nothing. Any feature that would make
          it a party to those relationships — proxying your cloud spend, pooling your API keys,
          holding your code — is out of bounds by definition, not by preference.
        </p>
      </section>

      <section className="home-section">
        <h2>Five principles</h2>
        <p>
          These five principles decide what gets built. The long version is in{' '}
          <a href={repoDocUrl('CORE-PRINCIPLES.md')} target="_blank" rel="noreferrer">
            CORE-PRINCIPLES.md
          </a>
          , and issues and pull requests should name the principle they serve.
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
          Open <code>http://127.0.0.1:3000</code> and sign in with it.
        </p>
        <p>
          Once v0.1.0 is on npm there is a second path, <code>npx rockysurf</code>, which needs Node
          24 or newer. It is not published yet — until then use Compose, or run{' '}
          <code>pnpm -r build</code> in a checkout and start{' '}
          <code>node packages/rockysurf/dist/bin.js</code>, which is the same binary{' '}
          <code>npx</code> will fetch.
        </p>
        <p>
          With no cloud configured, Rocky Surf still starts on an in-memory provider, so you can
          create a server, watch it boot and terminate it before deciding whether to paste a real
          token.
        </p>

        <h3>Configuration</h3>
        <p>
          Settings live in one YAML file. Rocky Surf reads the first of these it finds and prints
          the path it used on startup:
        </p>
        <ol className="home-paths">
          <li>
            <code>--config &lt;path&gt;</code>
          </li>
          <li>
            <code>./rockysurf.config.yaml</code>, in the directory you ran the command from
          </li>
          <li>
            <code>~/.rockysurf/config.yaml</code>
          </li>
        </ol>
        <p>
          Copy{' '}
          <a href={repoDocUrl('rockysurf.config.example.yaml')} target="_blank" rel="noreferrer">
            rockysurf.config.example.yaml
          </a>{' '}
          to one of the last two and edit it. Every value in the example is the default, so delete
          whatever you do not care about. Rocky Surf writes settings you save from the web UI back
          into whichever file it loaded.
        </p>
        <p>
          Under Docker the live config is inside the <code>rockysurf-data</code> volume at{' '}
          <code>/data/rockysurf.config.yaml</code>, not in your checkout. Copy it out, edit, copy it
          back, restart:
        </p>
        <pre>
          <code>{DOCKER_CONFIG_SNIPPET}</code>
        </pre>
        <p>
          Rocky Surf listens on <code>127.0.0.1</code> only. It holds your cloud credentials and an
          SSH private key for every server it creates, and it has one password in front of it and no
          TLS of its own — so if you widen <code>server.host</code>, put a reverse proxy or a
          firewall in front of it. Full detail:{' '}
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
        <p>
          Rocky Surf ships every provider switched off until you enable it in the config file, so a
          fresh install cannot spend money by accident.
        </p>
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
          <strong>You may need a live session with your cloud before a create will work.</strong>{' '}
          AWS, Azure and GCP read credentials from the same place the rest of your tooling keeps
          them, which for most people is a login that expires: <code>aws sso login</code>,{' '}
          <code>az login</code>, <code>gcloud auth application-default login</code>. If that session
          has lapsed, so has Rocky Surf&rsquo;s access, and the fix is to log in again rather than to
          change anything here. Hetzner is the exception — its token is a long-lived string you
          paste once.
        </p>
        <p>
          Per-provider setup, including the IAM policy and the least-privilege roles, is in{' '}
          <a href={`${GITHUB_URL}/tree/main/docs/providers`} target="_blank" rel="noreferrer">
            docs/providers/
          </a>
          .
        </p>

        <h3>Pick a Surge Pack</h3>
        <p>
          A <strong>Surge Pack</strong> is the software your box is built with, written as one YAML
          file:
        </p>
        <pre>
          <code>{PACK_SNIPPET}</code>
        </pre>
        <p>
          A pack is a readable list of tools and their install scripts, reviewable in a pull request
          rather than baked into an image someone else built months ago, and your box is assembled
          from it while you watch the install feed. Ten ship in{' '}
          <a href={`${GITHUB_URL}/tree/main/packs`} target="_blank" rel="noreferrer">
            packs/
          </a>
          , covering Claude Code, Codex CLI, Amp, OpenCode, Gas Town and others, and they share one
          base toolchain by referencing tool ids rather than redefining them.
        </p>
        <p>
          Each pack carries a <code>guide</code> its author wrote, shown on the server&rsquo;s page
          the moment the box is running. No credential of yours reaches a box during bootstrap, so
          the guide is where a pack tells you how to sign the agents in, and where it admits
          anything the install could not finish for you.
        </p>
        <p>
          Every install script has to be idempotent, architecture-aware, non-interactive and honest
          about which user it runs as. CI proves it the tedious way: every shipped pack&rsquo;s
          scripts run twice in the same container, on amd64 and arm64, with the resume journal
          thrown away in between.
        </p>
        <p>
          The authoring contract is{' '}
          <a href={repoDocUrl('docs/writing-a-pack.md')} target="_blank" rel="noreferrer">
            docs/writing-a-pack.md
          </a>
          , and the repository ships a Claude Code skill that will interview you and write the file
          for you.
        </p>

        <h3>Connect a GitHub repo</h3>
        <p>
          The create form has a <strong>Repositories</strong> field: one git URL per line, each
          cloned into the home directory of the box during setup. Public URLs clone anonymously,
          with no credentials and nothing to configure.
        </p>
        <p>
          Private repositories need a GitHub token, and the <Link to="/settings">Settings</Link> page
          takes one two ways:
        </p>
        <ul className="home-claims">
          <li>
            <strong>Connect GitHub</strong> — press the button, type the short code it shows on
            github.com, approve, and the token comes back. Nothing to export and no restart. It asks
            for the <code>repo</code> scope, which is read and write on every repository the account
            can reach, and Rocky Surf stores that token encrypted under your account instead of
            writing it to the config file. The button needs a GitHub OAuth App you register
            yourself, which takes about a minute — Rocky Surf ships none of its own, because an app
            somebody else registered could have its tokens revoked by them. The card walks you
            through it and stays visible, disabled, until you paste the client ID.
          </li>
          <li>
            <strong>Access tokens</strong> — paste a personal access token instead. One
            instance-wide token covers everything, and you can add a token per repository, owner or
            host when a fine-grained PAT only reaches one repo. Most specific match wins. The
            settings page writes these into the config file, so treat that file as a credential once
            you have used them, or point it at an environment variable with{' '}
            <code>${'{'}GITHUB_PAT{'}'}</code> and keep the token out of the file entirely.
          </li>
        </ul>
        <p>
          The box receives the token in a <code>0600</code> file and clones with it in a way that
          keeps it out of <code>ps</code> output and out of the checkout&rsquo;s{' '}
          <code>.git/config</code>. Packs read it as <code>$GITHUB_TOKEN</code>, which is also the
          name <code>gh</code> picks up with no further setup.
        </p>
      </section>

      <section className="home-section">
        <h2>Where your servers and settings are kept</h2>
        <p>
          One directory holds everything Rocky Surf knows: <code>~/.rockysurf</code> by default,{' '}
          <code>/data</code> inside the container, <code>server.dataDir</code> in general. Rocky Surf
          creates it owner-only on first boot.
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
          <strong>Back up the whole directory.</strong> The database and the key are useless without
          each other: a database without its key is undecryptable, and a key without its database
          knows nothing about your servers.
        </p>
        <p>
          <strong>Stop the process before you copy it.</strong> The database runs in WAL mode, and a
          clean shutdown folds the write-ahead log back in. Copy <code>rockysurf.db</code> from a
          running installation and you may get a file quietly missing the last few minutes.
        </p>
        <pre>
          <code>{BACKUP_SNIPPET}</code>
        </pre>
        <p>
          If you cannot stop it, use SQLite&rsquo;s own online backup (
          <code>sqlite3 rockysurf.db &quot;.backup out.db&quot;</code>) and copy{' '}
          <code>secret.key</code> alongside. Restoring is putting the directory back and starting
          up; migrations run on boot.
        </p>
        <p>
          <strong>
            The backup holds every provider credential and every server&rsquo;s private key
          </strong>
          , with the key to decrypt them sitting in the same archive — so encrypt it, or hold{' '}
          <code>secret.key</code> outside the filesystem with <code>ROCKYSURF_SECRET_KEY</code> and
          back up only the database. And <strong>
            <code>docker compose down -v</code> destroys the volume
          </strong>
          , taking your credentials and the SSH keys for boxes that are still running and still
          billing.
        </p>
      </section>

      <section className="home-section">
        <h2>Put a safety net under your cloud account</h2>
        <p>
          Rocky Surf enforces its own guardrails server-side, so they apply to the web UI, the CLI
          and an agent driving the MCP tools alike:
        </p>
        <pre>
          <code>{LIMITS_SNIPPET}</code>
        </pre>
        <p>
          Those limits are worth setting, but they should not be your only defence. The spend cap is
          an estimate, not a bill: it is computed from bundled price data, and an offering your
          provider quotes no price for contributes real spend the cap cannot see. Hitting the cap
          blocks new servers without stopping the ones already running, which is the difference
          between a budget cap and a sandbox.
        </p>
        <p>Set limits at the cloud too, where the numbers come from your actual bill:</p>
        <ul className="home-claims">
          <li>
            <strong>Billing alerts and budgets.</strong> AWS Budgets with an alert threshold, plus
            Cost Anomaly Detection; budgets in Azure Cost Management; budget alerts on your GCP
            billing account. Most of them notify rather than stop, so set the threshold well below
            the number that would hurt.
          </li>
          <li>
            <strong>A blast radius you chose.</strong> Give Rocky Surf its own AWS account, Azure
            subscription, GCP project or Hetzner project. A mistake then costs you that project and
            nothing else, and the bill tells you which spending was Rocky Surf&rsquo;s.
          </li>
          <li>
            <strong>A credential that can only do this job.</strong> The AWS role in{' '}
            <a href={repoDocUrl('deploy/aws/iam-role.yaml')} target="_blank" rel="noreferrer">
              deploy/aws/iam-role.yaml
            </a>{' '}
            and the least-privilege roles in the provider docs exist so the token in Rocky
            Surf&rsquo;s hands cannot reach the rest of your account.
          </li>
          <li>
            <strong>An occasional look at the console.</strong> Rocky Surf reconciles what it
            believes against what the cloud reports and tells you when the two disagree, but it only
            knows about resources it created.
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
          Rocky Surf is deliberately small: there is no devcontainer support, no per-task throwaway
          sandboxes, no Windows targets and no multi-tenancy — one admin, one password, no privilege
          separation inside the process. <code>rockysurf mcp</code> exposes the lifecycle as MCP
          tools so an agent can create, inspect, stop and destroy its own boxes, with{' '}
          <code>create</code> and <code>terminate</code> as separate opt-in scopes.
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
