import { useCallback } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AppShell } from '../components/AppShell'
import { Tabs } from '../components/Tabs'
import { GITHUB_URL, SHOP_PROVIDERS_URL, repoDocUrl } from '../lib/links'

/**
 * The in-app Help page (issue #16, reorganized for #364).
 *
 * WHAT IT IS. Each section summarizes and links; the document it links — SECURITY.md,
 * docs/self-hosting.md, a provider page, the pack contract — is the normative reference, so a
 * claim here should never need to be read against the code to be trusted. If a claim below is
 * wrong, fix it or cut it; it should not describe what an older release did.
 *
 * HOW IT IS ORGANIZED (issue #364). It used to be fifteen headings in one column under a
 * wrapped strip of anchor links: everything was on screen at once and nothing was findable. It
 * is now the Settings page's sidebar — the same `Tabs` widget, the same layout rules — with one
 * panel showing at a time. Each panel opens with a sentence saying what it covers, and anything
 * the reader does is a numbered procedure.
 *
 * WHAT ORDER THE PANELS ARE IN (issue #441). The sidebar follows the sequence a reader actually
 * goes through, and `SECTIONS` below is the single place that order is written. Start here is
 * an index rather than a section: it states no fact that the panel it links to does not already
 * state, so nothing has to be kept true in two places. All documentation lists every document
 * the README's table lists, under the README's own audience headings — a reader who opens it
 * should not have to go to the repository to find out what else exists.
 *
 * WHY EVERY PANEL STAYS MOUNTED. Other pages link into this one by fragment
 * (`/help#stale-servers`, `/help#backup`) and so does the repository's own documentation. Every
 * panel and every block inside one keeps its `id`, `SECTIONS` maps an incoming fragment to the
 * panel that holds it, and `AppShell`'s `useScrollToHash` then scrolls to the element. An `id`
 * in this file is therefore a public address: rename one and the links pointing at it break.
 */

/**
 * Which panel each section is, what the sidebar calls it, and every `id` it contains.
 *
 * THE ORDER IS THE ORDER A READER DOES THINGS IN (issue #441). Start here says what Rocky Surf
 * is and numbers the setup; then the four steps that setup names, in the order it names them —
 * a Provider, a Server and the Surge Pack it is created from, repositories, an agent over MCP;
 * then the three things a reader looks up once a box is running — costs, settings, backups; then
 * the two reference panels, the Glossary and All documentation. `SECTIONS[0]` is the panel an
 * unknown fragment falls back to and the one the page opens on, so Start here has to stay first.
 */
const SECTIONS = [
  { id: 'start', label: 'Start here', anchors: [] },
  {
    id: 'providers',
    label: 'Cloud Providers',
    anchors: ['enable-a-cloud', 'ssh-access', 'hetzner', 'aws', 'azure', 'gcp', 'byo'],
  },
  {
    id: 'servers',
    label: 'Servers',
    anchors: ['create', 'boot', 'connect', 'lifecycle', 'stale-servers'],
  },
  { id: 'packs', label: 'Surge Packs and tools', anchors: [] },
  { id: 'repositories', label: 'Private repositories', anchors: ['git-auth'] },
  { id: 'agents', label: 'MCP & Skills', anchors: ['mcp', 'mcp-scopes', 'skills'] },
  { id: 'costs', label: 'Costs and caps', anchors: [] },
  { id: 'settings', label: 'Settings', anchors: [] },
  { id: 'backup', label: 'Backups', anchors: ['backup-move', 'backup-directory'] },
  { id: 'glossary', label: 'Glossary', anchors: [] },
  { id: 'docs', label: 'All documentation', anchors: [] },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** Every fragment this page answers to, panel ids included. Exported for the test. */
export const HELP_ANCHORS: readonly string[] = SECTIONS.flatMap((section) => [
  section.id,
  ...section.anchors,
])

/** The panel holding a fragment, or the first panel when the fragment names nothing here. */
export function panelForAnchor(anchor: string): SectionId {
  const match = SECTIONS.find(
    (section) => section.id === anchor || (section.anchors as readonly string[]).includes(anchor),
  )
  return match?.id ?? SECTIONS[0].id
}

const CLAUDE_CODE_USER_SCOPE_SNIPPET = `claude mcp add --scope user --env ROCKYSURF_TOKEN=the-token-you-just-minted \\
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp`

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

const CODEX_USER_SCOPE_SNIPPET = `codex mcp add rockysurf --env ROCKYSURF_TOKEN=the-token-you-just-minted \\
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp`

const CODEX_CONFIG_SNIPPET = `[mcp_servers.rockysurf]
command = "npx"
args = ["-y", "rockysurf", "mcp"]
env = { ROCKYSURF_TOKEN = "the-token-you-just-minted", ROCKYSURF_URL = "http://127.0.0.1:3000" }`

/** The scopes, and what each one puts in an agent's tool list. */
const SCOPE_TOOLS = [
  {
    scope: 'read',
    granted: 'By default',
    tools:
      'list_servers, get_server, get_ssh_command, list_providers, get_provider, list_offerings, list_packs, list_ssh_keys',
  },
  { scope: 'stop', granted: 'By default', tools: 'stop_server, start_server' },
  { scope: 'create', granted: 'On request', tools: 'create_server' },
  { scope: 'terminate', granted: 'On request', tools: 'terminate_server' },
] as const

/** The skills in the repository, and the job each one does. */
const SKILLS = [
  ['create-surge-pack', 'Write a Surge Pack that passes the real smoke harness.'],
  ['register-a-tool', 'Register one tool, reusable across packs and exportable as a file.'],
  ['contribute-surge-pack', 'Get a working pack listed in the community shop.'],
  ['contribute-provider', 'Get a working provider listed in the community shop.'],
  ['add-provider', 'Switch on a cloud, or add support for one Rocky Surf does not have yet.'],
  ['rockysurf-design', 'Change the web UI, or make something that looks like Rocky Surf.'],
] as const

/**
 * Every document the README's table lists, grouped under the README's own audience headings
 * (issue #441). The per-cloud Provider pages and the capability matrix sit with Operators,
 * which is the audience the README gives them.
 *
 * THIS LIST AND THE README'S TABLE ARE THE SAME LIST. The owner's complaint about the panel
 * this replaced was that it carried a subset and gave no sign of it, so a document added to the
 * README belongs here as well, with the same one-line summary. Every path is a real file on
 * `main`; a rename that misses this file is a 404 the page renders happily.
 */
const DOC_GROUPS = [
  {
    audience: 'Operators',
    docs: [
      [
        'docs/self-hosting.md',
        'Self-hosting',
        'Install paths, data, upgrades, backup and restore.',
      ],
      ['SECURITY.md', 'Security', 'Credential custody, SSH trust, the MCP threat model.'],
      [
        'docs/providers/capability-matrix.md',
        'The capability matrix',
        'What each Provider can do, and the evidence for it.',
      ],
      [
        'docs/providers/hetzner.md',
        'Hetzner',
        'Setting Hetzner up, with its least-privilege credential.',
      ],
      ['docs/providers/aws.md', 'AWS', 'Setting AWS up, with its least-privilege role.'],
      ['docs/providers/azure.md', 'Azure', 'Setting Azure up, with its least-privilege role.'],
      [
        'docs/providers/gcp.md',
        'Google Cloud',
        'Setting Google Cloud up, with its least-privilege role.',
      ],
      [
        'docs/providers/byo.md',
        'Your own machines',
        'Setting up machines you already own, which need no cloud API.',
      ],
    ],
  },
  {
    audience: 'Surge Pack authors',
    docs: [
      [
        'docs/writing-a-surge-pack.md',
        'Writing a Surge Pack',
        'How one runs, the four rules, a worked example, the checklist.',
      ],
      [
        'docs/surge-pack-contract.md',
        'The Surge Pack contract',
        'The normative half — file format, rules in full, environment, the CI smoke test.',
      ],
    ],
  },
  {
    audience: 'Contributors',
    docs: [
      [
        'docs/adr/llms.txt',
        'The architecture decisions',
        'Start here for the design.',
      ],
      [
        'docs/writing-a-provider.md',
        'Writing a Provider',
        'Adding a cloud against the frozen SDK.',
      ],
      ['CONTRIBUTING.md', 'Contributing', 'Development setup, gates, conventions.'],
      [
        'docs/contributing/TESTING.md',
        'Testing',
        'The testing strategy — every layer, where it runs, and the nightly real-cloud run.',
      ],
    ],
  },
  {
    audience: 'The maintainer',
    docs: [
      [
        'docs/contributing/RELEASING.md',
        'Releasing',
        'Publishing to npm — the procedure, and the reasons behind each step.',
      ],
    ],
  },
] as const

export function HelpPage() {
  const { hash } = useLocation()
  const navigate = useNavigate()

  /**
   * WHICH PANEL IS OPEN LIVES IN THE URL, as it does on Settings — here as the fragment rather
   * than a query parameter, because the fragment is the address other pages already link by.
   * One mechanism, so `/help#backup` from the dashboard and a click in the sidebar are the same
   * navigation, and `useScrollToHash` scrolls for both.
   *
   * `replace`, so a Back press leaves Help rather than walking back through every section the
   * reader looked at on the way in.
   */
  const active = panelForAnchor(hash.replace(/^#/, ''))
  const openSection = useCallback(
    (id: SectionId) => {
      navigate(`/help#${id}`, { replace: true })
    },
    [navigate],
  )

  return (
    <AppShell title="Help" className="help">
      <div className="help-layout">
        <Tabs
          label="Help sections"
          panelId="help"
          className="help-nav"
          tabs={SECTIONS.map((section) => ({
            key: section.id,
            label: section.label,
            controls: section.id,
          }))}
          active={active}
          onSelect={openSection}
        />

        <div className="help-panels">
          {/*
            START HERE (issue #441). An index, not a section: every claim in it is already made
            by the panel the step links to, so this panel can never be the one that goes stale
            on its own. Add a fact here only after adding it there.
          */}
          <section
            className="help-panel"
            id="start"
            role="tabpanel"
            aria-labelledby="help-tab-start"
            hidden={active !== 'start'}
          >
            <h2>Start here</h2>
            <p className="help-lead">
              Rocky Surf creates a machine on a cloud account of your own, installs a Surge Pack
              of software on it, and gives you an SSH command to connect with. Every Provider
              ships disabled and Rocky Surf stores no cloud credentials, so a fresh install
              cannot spend money until you switch a cloud on. Each panel of this page covers one
              subject; the following steps are the order to take them in.
            </p>
            <ol className="help-steps">
              <li>
                <strong>Configure a cloud Provider.</strong> Put the credential where that
                cloud&rsquo;s own tooling already reads it, then set <code>enabled</code> and that
                cloud&rsquo;s required keys in Settings. AWS, Azure, and Google Cloud will not
                start without <code>sshAllowedCidr</code>. For the steps, and for what each cloud
                wants created first, see <Link to="/help#providers">Cloud Providers</Link>.
              </li>
              <li>
                <strong>Create a Server, choosing a Surge Pack.</strong> Pick a Provider and a
                Surge Pack on the New Server page, describe the machine you want, and create it.
                The server&rsquo;s own page shows the install as it happens, and then the SSH
                command that connects you to it. For a server&rsquo;s whole life, see{' '}
                <Link to="/help#servers">Servers</Link>; for what a Surge Pack is and where
                community ones come from, see{' '}
                <Link to="/help#packs">Surge Packs and tools</Link>.
              </li>
              <li>
                <strong>Optional: Connect private repositories.</strong> The repositories you
                list when you create a server are cloned onto the box during setup. Public ones
                clone with no credential; private ones need a GitHub token, and Settings takes
                one two ways. For both, see{' '}
                <Link to="/help#repositories">Private repositories</Link>.
              </li>
              <li>
                <strong>Connect your coding agent over MCP.</strong> Mint a token, add Rocky Surf
                to your MCP client, and reconnect the client. What an agent may then do is{' '}
                <code>mcp.scopes</code> in your config file, which defaults to{' '}
                <code>[read, stop]</code>. For the commands and the table of scopes, see{' '}
                <Link to="/help#agents">MCP &amp; Skills</Link>.
              </li>
            </ol>
            <p>
              Two more panels are worth reading before you leave a machine running:{' '}
              <Link to="/help#costs">Costs and caps</Link>, for the limits Rocky Surf enforces
              before a machine is provisioned, and <Link to="/help#backup">Backups</Link>, for
              what to copy so that a lost computer does not take your server records with it.
            </p>
          </section>

          <section
            className="help-panel"
            id="providers"
            role="tabpanel"
            aria-labelledby="help-tab-providers"
            hidden={active !== 'providers'}
          >
            <h2>Cloud Providers</h2>
            <p className="help-lead">
              This section covers how to switch a cloud on: what must exist in the cloud first, where
              the credential comes from, which config keys are required, and how the SSH allow-list
              reaches the cloud. Every Provider ships disabled, so a fresh install cannot spend money
              by accident.
            </p>

            <section className="help-block" id="enable-a-cloud">
              <h3>Enable a cloud</h3>
              <p>To switch a cloud on, follow these steps:</p>
              <ol className="help-steps">
                <li>
                  Create whatever must exist in the cloud before Rocky Surf can be scoped to it. Each
                  cloud&rsquo;s heading in this section starts with that list, under{' '}
                  <strong>Before you start</strong>.
                </li>
                <li>
                  Put the credential where that cloud&rsquo;s own tooling already reads it — an
                  environment variable, an SSO session, a login. Rocky Surf stores no cloud
                  credentials.
                </li>
                <li>
                  In Rocky Surf, go to <Link to="/settings">Settings</Link> and open the
                  cloud&rsquo;s own tab. The <Link to="/setup">setup wizard</Link> walks the same
                  ground for a first install.
                </li>
                <li>
                  Set <code>enabled</code> and the keys listed under <strong>Config</strong> for that
                  cloud, then save. Settings applies immediately; a hand-edit of the config file
                  applies at the next start.
                </li>
                <li>
                  Open the <Link to="/servers/new">New Server</Link> page and confirm the cloud is in
                  the provider list. A cloud that failed validation is named there and in the boot
                  log, with the reason.
                </li>
              </ol>
              <p>
                <strong>Credentials do not live in the config file.</strong> Each provider reads them
                from wherever your other tooling for that cloud already keeps them. Rocky Surf checks
                the config file first, then its own encrypted store — what the wizard asked you to
                paste — so the file always wins when both are set. Hetzner is the only provider with
                a credential field at all, and even there the value is a reference to an environment
                variable: <code>{'${HETZNER_TOKEN}'}</code>.
              </p>
            </section>

            <section className="help-block" id="ssh-access">
              <h3>Set the SSH allow-list</h3>
              <p>
                <strong>AWS, Azure, and Google Cloud will not start without <code>sshAllowedCidr</code></strong>{' '}
                — the networks allowed to reach SSH on your servers. It is always a{' '}
                <strong>list</strong> even for one CIDR, an empty list is refused, and there is no
                default. Enabling one of these providers without it fails at startup; the boot log
                and the New Server page both name the provider that was dropped.{' '}
                <code>0.0.0.0/0</code> anywhere in the list is refused unless{' '}
                <code>allowAllCidr: true</code> sits beside it, because opening SSH to the internet
                is two separate decisions. Hetzner has no such key: a Hetzner server is reachable the
                moment it boots, with no firewall object for Rocky Surf to own.
              </p>
              <p>
                Use the address your SSH connection uses, not the one a &ldquo;what is my IP&rdquo;
                page shows. On some networks — carrier-grade NAT, some corporate and mobile gateways
                — web traffic and SSH leave by different public addresses, so allowing the web
                address does not cover SSH, and the box reads as <em>filtered</em> even though a CIDR
                is in the list. To find the right address, follow these steps:
              </p>
              <ol className="help-steps">
                <li>
                  Read the address a server sees on port 22. This is the one SSH uses:
                  <pre>
                    <code>curl http://portquiz.net:22/</code>
                  </pre>
                </li>
                <li>
                  Read the address your web traffic leaves by:
                  <pre>
                    <code>curl -4 https://checkip.amazonaws.com</code>
                  </pre>
                </li>
                <li>
                  Compare the two. Add whichever one differs to <code>sshAllowedCidr</code> as a{' '}
                  <code>/32</code>.
                </li>
                <li>
                  If a network that worked before goes quiet, run the port-22 command again and
                  update its <code>/32</code>. These addresses can rotate. To rule out the box
                  itself, try SSH from a different network, such as a phone hotspot — if that works,
                  the address split is the cause.
                </li>
              </ol>
              <p>
                <strong>Saving <code>sshAllowedCidr</code> pushes it to the cloud immediately</strong>{' '}
                — launching a server is not required for it to take effect. Settings writes the
                config file, this process adopts it, and then a second call updates the security
                group, network security group rule, or firewall rule. Each cloud&rsquo;s result
                appears in Settings under <strong>SSH access at the cloud</strong>. It never launches
                or touches an instance, and it applies to AWS, Azure, and Google Cloud only.
              </p>
              <p>
                The <strong>Push SSH access to the clouds</strong> button, in the Settings footer,
                runs the same sync on demand — useful when the cloud has drifted independently of
                your config file, or after an upgrade, when it can surface access an earlier release
                added that your file no longer lists. The button needs no unsaved edits and pushes
                every enabled cloud at once; <code>rockysurf network sync</code> is the CLI
                equivalent.
              </p>
              <p>
                <strong>Adding a CIDR takes effect on every cloud as soon as it is pushed.</strong>{' '}
                Removing one differs by cloud. On Azure the whole rule is rewritten, so a removal
                lands in the same push. On AWS and Google Cloud, Rocky Surf only removes a range it
                can prove it added: a range it stamped when authorizing is offered under{' '}
                <strong>SSH access at the cloud</strong> as keep-or-remove, default keep, and
                choosing remove is an itemized, confirmed revoke. A range without Rocky Surf&rsquo;s
                stamp — one you or your own tooling added — is never touched automatically; the
                report names the exact <code>aws ec2 revoke-security-group-ingress</code> or{' '}
                <code>gcloud compute firewall-rules update</code> command that removes it yourself.
              </p>
            </section>

            <section className="help-block" id="hetzner">
              <h3>Hetzner</h3>
              <p>
                <strong>Before you start:</strong> a Cloud project, and an API token in it with{' '}
                <strong>Read &amp; Write</strong> — the project&rsquo;s Security section. Read-only
                passes startup validation and fails at the first create. Give Rocky Surf its own
                project: a Cloud API token has no per-resource scope, so the project is the only
                boundary that exists. There is nothing to deploy.
              </p>
              <p>
                <strong>Config:</strong> <code>enabled</code>, <code>token</code> (required; write it
                as <code>{'"${HETZNER_TOKEN}"'}</code>) and <code>location</code> (defaults{' '}
                <code>fsn1</code>). Optional: <code>sizes</code> as an allowlist, and{' '}
                <code>consoleProjectId</code>, which only adds a console link and has to be typed in
                because the API never names the project a token belongs to.
              </p>
              <p className="help-links">
                <a href={repoDocUrl('docs/providers/hetzner.md')} target="_blank" rel="noreferrer">
                  docs/providers/hetzner.md
                </a>{' '}
                &middot; <Link to="/settings?section=providers.hetzner">Settings &rarr; Hetzner</Link>
              </p>
            </section>

            <section className="help-block" id="aws">
              <h3>AWS</h3>
              <p>
                <strong>Before you start:</strong> nothing to create. Rocky Surf uses the standard
                AWS credential chain — an SSO session, <code>AWS_PROFILE</code>,{' '}
                <code>AWS_ACCESS_KEY_ID</code> / <code>AWS_SECRET_ACCESS_KEY</code>, or an instance
                role. If <code>aws sts get-caller-identity</code> works in your shell, so will Rocky
                Surf, and there is nowhere in the config file to put a key.
              </p>
              <p>
                <strong>The role</strong> is optional — the same policy attached to a user works —
                and <code>deploy/aws/iam-role.yaml</code> is a CloudFormation template that creates
                one IAM role carrying the published policy and nothing else. To deploy it, follow
                these steps:
              </p>
              <ol className="help-steps">
                <li>
                  From a checkout, create the stack:
                  <pre>
                    <code>
                      aws cloudformation deploy \{'\n'}
                      {'  '}--template-file deploy/aws/iam-role.yaml \{'\n'}
                      {'  '}--stack-name rocky-surf-iam-role \{'\n'}
                      {'  '}--capabilities CAPABILITY_NAMED_IAM \{'\n'}
                      {'  '}--parameter-overrides TrustedPrincipalArn=&lt;arn&gt;
                      ProviderRegion=us-east-1
                    </code>
                  </pre>
                </li>
                <li>Point a profile at the role the way you point any AWS tool at one.</li>
                <li>
                  Confirm the template&rsquo;s <code>ManagedByTag</code> matches your{' '}
                  <code>managedBy</code> setting. If the two differ, Rocky Surf can create instances
                  it is then not allowed to stop or terminate.
                </li>
              </ol>
              <p>
                <strong>Config:</strong> <code>enabled</code> and <code>sshAllowedCidr</code>{' '}
                (required, a list); <code>region</code> defaults <code>us-east-1</code>. Optional:{' '}
                <code>profile</code>, and <code>sizes</code> as an allowlist.
              </p>
              <p className="help-links">
                <a href={repoDocUrl('docs/providers/aws.md')} target="_blank" rel="noreferrer">
                  docs/providers/aws.md
                </a>{' '}
                &middot; <Link to="/settings?section=providers.aws">Settings &rarr; AWS</Link>
              </p>
            </section>

            <section className="help-block" id="azure">
              <h3>Azure</h3>
              <p>
                <strong>Before you start</strong>, do the following in your subscription:
              </p>
              <ol className="help-steps">
                <li>
                  Register <code>Microsoft.Compute</code> and <code>Microsoft.Network</code>, if the
                  subscription has never used them. A fresh subscription has not.
                </li>
                <li>
                  Create the one resource group Rocky Surf owns:
                  <pre>
                    <code>az group create --name rocky-surf-rg --location eastus</code>
                  </pre>
                  <strong>Rocky Surf does not create the resource group.</strong> A role cannot be
                  scoped to a group that does not exist yet, so a provider that created its own scope
                  would need resource-group write across the whole subscription — permission to
                  delete any group in your account. One <code>az group create</code> buys a role that
                  cannot reach outside one group.
                </li>
                <li>
                  Create an identity for Rocky Surf to run as:
                  <pre>
                    <code>az ad sp create-for-rbac</code>
                  </pre>
                </li>
                <li>
                  Deploy the two role definitions — one on the resource group, one read-only at
                  subscription scope — at <em>subscription</em> scope:
                  <pre>
                    <code>
                      az deployment sub create \{'\n'}
                      {'  '}--location eastus \{'\n'}
                      {'  '}--template-file deploy/azure/role.bicep \{'\n'}
                      {'  '}--parameters resourceGroupName=rocky-surf-rg principalId=&lt;object
                      id&gt;
                    </code>
                  </pre>
                  <code>principalId</code> is the identity&rsquo;s <strong>object</strong> id, not
                  its application id (
                  <code>az ad sp show --id &lt;appId&gt; --query id -o tsv</code>).
                </li>
              </ol>
              <p>
                <strong>Credentials</strong> come from <code>AZURE_TENANT_ID</code> /{' '}
                <code>AZURE_CLIENT_ID</code> / <code>AZURE_CLIENT_SECRET</code>, then a managed
                identity if Rocky Surf runs on an Azure VM, then <code>az login</code> — in that
                order, and a failure names every source it tried. <code>allowAzureCli: false</code>{' '}
                turns the third off on a server. There is nowhere in the config file for a client
                secret.
              </p>
              <p>
                <strong>Config:</strong> <code>enabled</code>, <code>subscriptionId</code>,{' '}
                <code>resourceGroup</code> and <code>sshAllowedCidr</code> (required, a list);{' '}
                <code>location</code> defaults <code>eastus</code>. Optional: <code>sizes</code>.
              </p>
              <p>
                <strong>A create is gated twice</strong> — by SKU availability, then by per-family
                core quota, which a fresh subscription has at zero for most families. The size list
                reads that quota where the credential can, and says when a family is refused for it
                rather than offering a machine the create would turn down.
              </p>
              <p className="help-links">
                <a href={repoDocUrl('docs/providers/azure.md')} target="_blank" rel="noreferrer">
                  docs/providers/azure.md
                </a>{' '}
                &middot; <Link to="/settings?section=providers.azure">Settings &rarr; Azure</Link>
              </p>
            </section>

            <section className="help-block" id="gcp">
              <h3>Google Cloud</h3>
              <p>
                <strong>Before you start:</strong> a project, and Application Default Credentials —
                the same chain <code>gcloud</code> itself uses.{' '}
                <strong>
                  <code>gcloud auth login</code> does not create or refresh ADC
                </strong>
                , which is the likeliest reason a correct configuration fails on a first run: they
                are two separate logins, possibly to two different Google accounts, and only{' '}
                <code>gcloud auth application-default login</code> writes the one Rocky Surf reads. A
                key file — <code>GOOGLE_APPLICATION_CREDENTIALS</code>, or <code>keyFile</code> in
                the config as a <em>path</em> — is the last resort rather than the default.
              </p>
              <p>
                <strong>The role</strong> is one script that creates a custom role, a service
                account, and the binding between them. It is idempotent, and <code>--dry-run</code>{' '}
                prints every command it would run and changes nothing. <code>gcloud</code> is the
                only prerequisite:
              </p>
              <pre>
                <code>./deploy/gcp/setup.sh --project=my-project-123456</code>
              </pre>
              <p>
                <strong>Config:</strong> <code>enabled</code>, <code>projectId</code> and{' '}
                <code>sshAllowedCidr</code> (required, a list); <code>zone</code> defaults{' '}
                <code>us-central1-a</code>. <code>projectId</code> is never inferred, because a
                Google credential can be valid for many projects and names none of them. The zone
                default is not <code>-c</code> on purpose: arm64 (Tau T2A) is sold in only eight
                zones and <code>us-central1-c</code> is not one of them. Optional:{' '}
                <code>keyFile</code>, <code>sizes</code>.
              </p>
              <p className="help-links">
                <a href={repoDocUrl('docs/providers/gcp.md')} target="_blank" rel="noreferrer">
                  docs/providers/gcp.md
                </a>{' '}
                &middot; <Link to="/settings?section=providers.gcp">Settings &rarr; Google Cloud</Link>
              </p>
            </section>

            <section className="help-block" id="byo">
              <h3>Your own machines (BYO)</h3>
              <p>
                <strong>Before you start:</strong> a machine you can already reach over SSH as root,
                or as an account with passwordless sudo. There is no cloud API, no role to deploy,
                and no credential stored — <code>identityFile</code> is a <em>path</em> to a key your
                own SSH already holds, and with an agent running (<code>SSH_AUTH_SOCK</code>) you can
                leave it out entirely.
              </p>
              <p>
                <strong>Config:</strong> <code>enabled</code>, and <code>hosts</code> — one entry per
                machine with <code>name</code> (what you call it in the UI, and how you pick it),{' '}
                <code>host</code>, <code>user</code> (default <code>root</code>), <code>port</code>{' '}
                (default <code>22</code>, and the port bootstrap dials too), an optional{' '}
                <code>fingerprint</code> so even the first connection is verified, and an optional
                per-host <code>identityFile</code>. Enabling the provider with no hosts is refused.
              </p>
              <p>
                <strong>Two accounts, and confusing them is the mistake worth avoiding.</strong>{' '}
                <code>user</code> is the admin login Rocky Surf <em>claims</em> with. The account it
                later connects as is <code>rocky</code>, which you do not configure — the claim
                creates it, with passwordless sudo, and appends Rocky Surf&rsquo;s key to it.
                Releasing a host undoes none of that: terminate is bookkeeping, and deliberately runs
                nothing on a machine Rocky Surf does not own.
              </p>
              <p className="help-links">
                <a href={repoDocUrl('docs/providers/byo.md')} target="_blank" rel="noreferrer">
                  docs/providers/byo.md
                </a>{' '}
                &middot;{' '}
                <Link to="/settings?section=providers.byo.hosts">
                  Settings &rarr; Your own machines
                </Link>
              </p>
            </section>
          </section>

          <section
            className="help-panel"
            id="servers"
            role="tabpanel"
            aria-labelledby="help-tab-servers"
            hidden={active !== 'servers'}
          >
            <h2>Servers</h2>
            <p className="help-lead">
              This section covers a server&rsquo;s whole life: creating one, watching the software
              install, connecting to it, stopping and destroying it, and checking that what this page
              shows still matches your cloud account.
            </p>

            <section className="help-block" id="create">
              <h3>Create a server</h3>
              <p>To launch a machine, follow these steps:</p>
              <ol className="help-steps">
                <li>
                  Go to the <Link to="/servers/new">New Server</Link> page.
                </li>
                <li>Pick a provider and a Surge Pack.</li>
                <li>
                  Describe the machine you want, architecture included. arm64 is first-class, not a
                  fallback.
                </li>
                <li>
                  Optional: List the repositories the box will work on. The form resolves each URL as
                  you type and says which token will be used, or that nothing matches yet.
                </li>
                <li>
                  Create the server. Declared repository URLs are checked before any machine is
                  launched, with the same token the box would use, so a typo fails in seconds instead
                  of after a full boot on a box that then keeps billing. A refusal names the URL and
                  the token that was tried, and you can create anyway — the check is a prediction,
                  not a guarantee.
                </li>
              </ol>
            </section>

            <section className="help-block" id="boot">
              <h3>While it boots</h3>
              <p>
                The server page shows the install as it happens: a step timeline fed by the box
                itself and a live log tail. When the box reaches <em>running</em>, the pack&rsquo;s
                own getting-started guide appears — written by the pack author, including anything
                the install could not finish on your behalf, such as signing agents in. No credential
                of yours reaches a box during bootstrap. A failed box says why, and says whether the
                underlying instance is still billing.
              </p>
            </section>

            <section className="help-block" id="connect">
              <h3>Connect to a server</h3>
              <p>To get a shell on a running server, follow these steps:</p>
              <ol className="help-steps">
                <li>Open the server&rsquo;s page.</li>
                <li>
                  Copy the SSH command it shows. If you pasted your own public key when you created
                  the box, that command uses it directly and there is no key file to manage.
                </li>
                <li>
                  Optional: If you supplied no key of your own, download Rocky Surf&rsquo;s key for
                  the box as a <code>.pem</code> first, and pass it to <code>ssh</code>.
                </li>
              </ol>
              <p>
                Rocky Surf authorizes a key of its own while it provisions the box, whether or not
                you supplied one: it installs everything over its own SSH connection, so it needs a
                way in that does not depend on a key only you hold. While that key is still
                authorized it can be downloaded as a <code>.pem</code> — the one place in the system
                that hands out decrypted secret material, ownership-checked and audited, and safe to
                re-download if you lose it. Once bootstrap finishes on a box you supplied a key for,
                Rocky Surf&rsquo;s own key is removed and that recovery path goes with it: your key
                becomes the only one on the box. Packs that ship a desktop show remote-desktop
                instructions instead of making you guess.
              </p>
            </section>

            <section className="help-block" id="lifecycle">
              <h3>Start, stop, and terminate</h3>
              <p>
                A stopped box keeps its disk and loses its compute bill — storage still costs money,
                just much less. On AWS and Google Cloud the public IP changes across a stop/start
                cycle; on Hetzner and Azure it survives. Machines you brought yourself (BYO) cannot be
                stopped or started — their power is not Rocky Surf&rsquo;s to manage — and
                terminating a BYO host is bookkeeping: it returns the host to the pool and runs
                nothing on a machine Rocky Surf does not own. For what each cloud can and cannot do,
                see{' '}
                <a
                  href={repoDocUrl('docs/providers/capability-matrix.md')}
                  target="_blank"
                  rel="noreferrer"
                >
                  the capability matrix
                </a>
                .
              </p>
            </section>

            {/*
              Issue #126. Stays here regardless of whether the dashboard's own notice has been
              dismissed — dismissing the reminder must not make the advice unfindable, so this
              block is not gated by any of the notice's own localStorage keys.
            */}
            <section className="help-block" id="stale-servers">
              <h3>Checking for stale servers</h3>
              <p>
                Rocky Surf&rsquo;s dashboard shows what core last learned from each provider&rsquo;s
                own API — polled on an interval and pushed over live events, but never a guaranteed,
                up-to-the-second mirror of your cloud account. A server terminated from the cloud
                console between polls, a box created directly on the account outside Rocky Surf, or a
                provider outage that delays a status update can all leave the dashboard saying
                something your cloud bill will not agree with. Treat this page as Rocky Surf&rsquo;s
                best record, not as your account&rsquo;s source of truth, and check your cloud
                provider&rsquo;s own console periodically for anything still running that this page
                does not show.
              </p>
            </section>
          </section>

          <section
            className="help-panel"
            id="packs"
            role="tabpanel"
            aria-labelledby="help-tab-packs"
            hidden={active !== 'packs'}
          >
            <h2>Surge Packs and tools</h2>
            <p className="help-lead">
              This section covers the software a box is created with: what a Surge Pack is, where
              community packs and providers come from, and what to read before you install one.
            </p>
            <p>
              A Surge Pack is written as YAML: a list of tools with idempotent, architecture-aware
              install scripts, plus the author&rsquo;s post-boot guide. The{' '}
              <Link to="/admin/tools">Tools</Link> and <Link to="/packs">Surge Packs</Link> pages let
              you inspect and edit what this installation offers. Writing your own means satisfying
              a contract, and CI enforces the mechanical half of it. Start with{' '}
              <a href={repoDocUrl('docs/writing-a-surge-pack.md')} target="_blank" rel="noreferrer">
                writing a surge pack
              </a>
              , the author guide; the file format field by field is{' '}
              <a href={repoDocUrl('docs/surge-pack-contract.md')} target="_blank" rel="noreferrer">
                the surge pack contract
              </a>
              . You can also hand both to your agent with the <code>create-surge-pack</code> skill.
            </p>
            <p>
              The <Link to="/shop">Rocky Surf Shop</Link> tab is where community packs and providers
              come from. Packs marked <em>official</em> shipped with the release you are running;
              everything else carries the label you gave its registry in your config file, and no
              registry can call itself official. Installing a pack takes effect immediately, with no
              restart; the packs on this installation are on the Surge Packs page, and its Community
              sub-tab links back to the shop.
            </p>
            <p>
              Before you install anything from a registry, the shop shows you{' '}
              <strong>every script the pack will run, verbatim</strong>, which of them run as root,
              and every URL they download from. Read it before you install. The registry&rsquo;s
              automated checks prove a pack is well-formed and survives being resumed; they cannot
              prove it is safe, because an install script is arbitrary shell running as root on your
              box.
            </p>
            <p>
              The same tab lists <strong>providers</strong> — the clouds Rocky Surf can create
              servers on. Each card shows the version, what the provider will ask you to configure,
              and what its machines can do, including whether a stopped machine still bills. Install
              fetches the package over https, checks its digest against the listing, unpacks it under
              the data directory&rsquo;s <code>providers</code> folder and writes two lines to the
              config file; nothing in the package runs until you restart Rocky Surf, and the card
              says so. A listing whose digest does not match, or that points at an <code>http</code>{' '}
              address, is refused and nothing is written. The same install can be done from the
              command line — for the steps, see the providers section of the{' '}
              <a href={SHOP_PROVIDERS_URL} target="_blank" rel="noreferrer">
                Rocky Surf Shop
              </a>
              . Once a provider loads it gets its own panel on the Settings page, the same as a
              provider that shipped with the release. A provider runs with Rocky Surf&rsquo;s full
              access — install ones you trust.
            </p>
          </section>

          <section
            className="help-panel"
            id="repositories"
            role="tabpanel"
            aria-labelledby="help-tab-repositories"
            hidden={active !== 'repositories'}
          >
            <h2>Private repositories</h2>
            <p className="help-lead">
              This section covers how your repositories get onto a box: which token each clone uses,
              and the two ways to give Rocky Surf a GitHub token in the first place.
            </p>
            <p>
              Access tokens are configured per repository in Settings, and a box receives only the
              tokens its own declared repositories select — a box created for one repo does not carry
              the others&rsquo; credentials. There is no way to add a token to a running box. If you
              later need a private repository nobody declared at create, the options are to terminate
              and recreate with it declared, or to authenticate that one clone by hand.
            </p>

            <section className="help-block" id="git-auth">
              <h3>Git Auth</h3>
              <p>
                The repositories you list when creating a server are cloned onto the box during
                setup. Public repositories clone with no credential. Private ones need a GitHub
                token, and there are two ways to give Rocky Surf one — a connected account, or a
                token per repository. Both are set up on the <Link to="/settings">Settings</Link>{' '}
                page, under <em>GitHub access tokens</em>.
              </p>
              <p>
                The catch-all token is also written onto the box as <code>GITHUB_TOKEN</code>, the
                variable <code>gh</code> and most CI-aware scripts read with no further
                configuration.
              </p>

              <h4>Connect GitHub</h4>
              <p>
                One button, and the token covers every repository your GitHub account can reach. It
                takes a one-time setup by whoever runs this installation, then a connect by each
                person using it. To do the one-time setup, follow these steps:
              </p>
              <ol className="help-steps">
                <li>
                  Register an OAuth App at{' '}
                  <a
                    href="https://github.com/settings/applications/new"
                    target="_blank"
                    rel="noreferrer"
                  >
                    github.com/settings/applications/new
                  </a>
                  . The form requires a Homepage URL and a callback URL, but the device flow never
                  visits either — <code>http://localhost:3000</code> satisfies both.
                </li>
                <li>
                  On the same form, tick <strong>Enable Device Flow</strong> and leave{' '}
                  <strong>Expire user access tokens</strong> unticked.
                </li>
                <li>
                  Copy the app&rsquo;s Client ID into the <em>OAuth App client ID</em> box in
                  Settings and save — the button works straight away, with no restart. The Client ID
                  is public and needs no client secret; the device flow uses none.
                </li>
              </ol>
              <p>Then each person connects their own account:</p>
              <ol className="help-steps">
                <li>
                  In Settings, press <strong>Connect GitHub</strong>.
                </li>
                <li>
                  Open the github.com link Rocky Surf shows, enter the short code beside it, and
                  approve. The token comes back to Rocky Surf.
                </li>
              </ol>
              <p>
                The token is user-level: it can reach every repository your account can, it does not
                expire, and it is stored encrypted rather than in the configuration file. It applies
                immediately, and is used by the servers you create. <strong>Disconnect</strong> makes
                Rocky Surf forget it; revoking it at GitHub is a separate step, at{' '}
                <a href="https://github.com/settings/applications" target="_blank" rel="noreferrer">
                  github.com/settings/applications
                </a>
                . Connecting GitHub obtains a credential for cloning; it is not a way to sign in to
                Rocky Surf.
              </p>

              <h4>A token per repository</h4>
              <p>To scope a token to one repository, follow these steps:</p>
              <ol className="help-steps">
                <li>
                  On GitHub, create a fine-grained personal access token scoped to the one
                  repository, with contents read and write.
                </li>
                <li>
                  In Settings, press <strong>Add a token</strong>.
                </li>
                <li>
                  Enter the repository as <code>owner/name</code>, paste the token, and save.
                </li>
              </ol>
              <p>
                The token is written into the configuration file, so treat that file as a credential.
                It applies to the next server you create, with no restart. The configuration file
                also accepts <code>{'${GITHUB_PAT}'}</code>-style references to environment variables
                if you edit it by hand.
              </p>

              <h4>Which token a clone uses</h4>
              <p>
                A token entered for a specific repository is used for that repository. Everything
                else uses the catch-all — a connected account if there is one, otherwise the unscoped
                token in the configuration file. A repository matched by neither is cloned
                anonymously, which works for public repositories and fails for private ones.
              </p>
              <p className="help-links">
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
          </section>

          <section
            className="help-panel"
            id="agents"
            role="tabpanel"
            aria-labelledby="help-tab-agents"
            hidden={active !== 'agents'}
          >
            <h2>MCP &amp; Skills</h2>
            <p className="help-lead">
              This section covers the two things a coding agent uses. The MCP server lets an agent
              create, inspect, stop, and destroy servers under the same server-side limits that
              apply to you. The Agent Skills teach an agent this project&rsquo;s own file formats,
              so it can write a Surge Pack or a Provider correctly the first time. Both work with
              any coding agent that supports the underlying standard — Claude Code and Codex CLI
              are given as the two representative examples, and the same shapes carry over to
              another MCP client or Agent Skills–compatible agent.
            </p>

            <section className="help-block" id="mcp">
              <h3>Install the MCP server</h3>
              <p>
                The MCP server is a separate process. Any MCP client starts it with{' '}
                <code>rockysurf mcp</code>, and it reaches Rocky Surf over HTTP at the address in{' '}
                <code>ROCKYSURF_URL</code>. <strong>Rocky Surf must already be running there</strong>{' '}
                — <code>rockysurf serve</code>, or the process serving this page. A client may start
                the MCP server before that is true; it reports the condition on stderr, and every
                tool call recovers once Rocky Surf is up.
              </p>
              <p>To connect an agent, follow these steps:</p>
              <ol className="help-steps">
                <li>
                  Confirm Rocky Surf is running. This page is served by it, so if you are reading
                  this, it is.
                </li>
                <li>
                  Mint a token. It is printed once, it is valid for 365 days, and it is stored only
                  as a hash:
                  <pre>
                    <code>
                      # from a built checkout — until v0.1.0 is on npm,{'\n'}
                      # this file IS the rockysurf command:{'\n'}
                      node packages/rockysurf/dist/bin.js token
                    </code>
                  </pre>
                  The token is the only thing the command writes to stdout, so{' '}
                  <code>ROCKYSURF_TOKEN=$(rockysurf token)</code> captures it and nothing else.
                </li>
                <li>
                  Add Rocky Surf to your MCP client. Every client wants the same three things — a
                  <code>command</code>, its <code>args</code>, and two <code>env</code> vars,{' '}
                  <code>ROCKYSURF_TOKEN</code> and <code>ROCKYSURF_URL</code> — in that client&rsquo;s
                  own file format. Claude Code and Codex CLI are given here as the two
                  representative examples.
                  <h4>Claude Code</h4>
                  <p>
                    <strong>User scope</strong> registers the server once for your account, so it
                    is available in every project you open. This is the recommended default,
                    because Rocky Surf manages servers regardless of which repository you have
                    open:
                  </p>
                  <pre>
                    <code>{CLAUDE_CODE_USER_SCOPE_SNIPPET}</code>
                  </pre>
                  <p>
                    <strong>Project scope</strong> checks the server into a repository instead, for
                    a team that wants it shared. Add this object to <code>.mcp.json</code> in your
                    project. The same object also works in Claude Code&rsquo;s user-scope file (
                    <code>~/.claude.json</code>) and in Claude Desktop&rsquo;s configuration file,
                    which is global by nature:
                  </p>
                  <pre>
                    <code>{MCP_CLIENT_SNIPPET}</code>
                  </pre>
                  <h4>Codex CLI</h4>
                  <p>
                    <strong>User scope</strong> — Codex calls it the global config — is what{' '}
                    <code>codex mcp add</code> writes to today, at <code>~/.codex/config.toml</code>:
                  </p>
                  <pre>
                    <code>{CODEX_USER_SCOPE_SNIPPET}</code>
                  </pre>
                  <p>
                    <strong>Project scope</strong> is a <code>.codex/config.toml</code> at your
                    repository root, loaded only for a project you have marked trusted. Codex CLI
                    reads a project-scoped file but, as of Codex CLI 0.153, <code>codex mcp add</code>{' '}
                    has no flag to write one — add this table by hand instead:
                  </p>
                  <pre>
                    <code>{CODEX_CONFIG_SNIPPET}</code>
                  </pre>
                  <p className="hint">
                    Those are the shapes v0.1.0 ships. Until the packages are on npm,{' '}
                    <code>npx</code> has no <code>rockysurf</code> to fetch — use{' '}
                    <code>"command": "node"</code> (Claude Code, JSON) or{' '}
                    <code>command = "node"</code> (Codex CLI, TOML) with{' '}
                    <code>"&lt;your-checkout&gt;/packages/rockysurf/dist/bin.js"</code> and{' '}
                    <code>"mcp"</code> as the two args, and the same env vars. For a command-line
                    form, replace <code>npx -y rockysurf mcp</code> with{' '}
                    <code>node &lt;your-checkout&gt;/packages/rockysurf/dist/bin.js mcp</code>.
                  </p>
                </li>
                <li>Reconnect the MCP client so it starts the new server. Restart the session.</li>
                <li>
                  Ask the agent to list your servers. On the default scopes it holds ten tools, and
                  a refusal names what it needs.
                </li>
              </ol>
              <p>
                To revoke the token, sign out of the web UI. That drops every session this
                installation has issued, your own browser&rsquo;s included, and there is no
                per-token revoke.
              </p>
            </section>

            <section className="help-block" id="mcp-scopes">
              <h3>Choose what an agent may do</h3>
              <p>
                A token grants no permission by itself. <code>mcp.scopes</code> in your config file
                decides which tools the MCP server offers, and it defaults to{' '}
                <code>[read, stop]</code>. <code>stop</code> covers pausing a server and starting it
                again. <code>create</code> and <code>terminate</code> are separate opt-ins, because
                creating a server costs money and destroying one cannot be undone. A scope you have
                not granted does not appear in the tool list at all, rather than appearing and then
                refusing the call.
              </p>
              <p>The following table lists each scope and the tools it puts in an agent&rsquo;s hands.</p>
              <table className="help-table">
                <thead>
                  <tr>
                    <th scope="col">Scope</th>
                    <th scope="col">Granted</th>
                    <th scope="col">Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {SCOPE_TOOLS.map((row) => (
                    <tr key={row.scope}>
                      <th scope="row">
                        <code>{row.scope}</code>
                      </th>
                      <td>{row.granted}</td>
                      <td>{row.tools}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>To change what this installation grants, follow these steps:</p>
              <ol className="help-steps">
                <li>
                  Go to <Link to="/settings?section=mcp">Settings &rarr; MCP</Link>.
                </li>
                <li>Tick the scopes you want to grant, and untick the ones you do not.</li>
                <li>Save.</li>
                <li>
                  Reconnect the MCP client. Rocky Surf itself needs no restart: the scopes are read
                  when your client starts <code>rockysurf mcp</code>, so nothing here takes effect
                  until it does.
                </li>
              </ol>
              <p>
                On the default scopes an agent&rsquo;s tool list has no <code>create_server</code>.
                That is <strong>not a bug</strong>; it is this setting. Tools that name a withheld
                one say so in their own description, so the agent can report the setting instead of
                a missing feature.
              </p>
            </section>

            <section className="help-block" id="skills">
              <h3>Install the Agent Skills</h3>
              <p>
                The repository ships six skills. A coding agent that supports the Agent Skills
                format loads the right one from what you ask it for; you never call a skill by name.
              </p>
              <p>
                <strong>
                  To extend Rocky Surf with your own Surge Packs or Providers, clone the repository.
                </strong>{' '}
                The published <code>rockysurf</code> package on npm ships only the runtime; the
                skills and the Surge Pack smoke harness exist only in the repository. To use any
                skill, follow these steps:
              </p>
              <ol className="help-steps">
                <li>
                  Clone the repository, if you have not already:
                  <pre>
                    <code>git clone https://github.com/amroja-biz/rockysurf</code>
                  </pre>
                </li>
                <li>
                  Install dependencies and build the workspace:
                  <pre>
                    <code>cd rockysurf &amp;&amp; pnpm install &amp;&amp; pnpm -r build</code>
                  </pre>
                </li>
                <li>
                  Install Docker if you plan to create a Surge Pack. <code>create-surge-pack</code>,{' '}
                  <code>register-a-tool</code>, and <code>contribute-surge-pack</code> verify a pack
                  with the repository&rsquo;s real run-twice smoke harness, which needs a container.
                  Writing your own Provider does not need Docker: the <code>add-provider</code>{' '}
                  skill&rsquo;s conformance suite is unit tests.
                </li>
                <li>
                  Work inside the checkout, where a compatible agent finds{' '}
                  <code>.agents/skills/&lt;name&gt;/SKILL.md</code> on its own. To make a skill
                  available in every project instead, copy it out of the checkout. The first
                  destination covers every project you work on; the second checks the skill into one
                  project, for a team:
                  <pre>
                    <code>
                      cp -r .agents/skills/create-surge-pack ~/.agents/skills/{'\n'}
                      cp -r .agents/skills/create-surge-pack &lt;your-project&gt;/.agents/skills/
                    </code>
                  </pre>
                  Restart the agent session so the skill is picked up.
                </li>
              </ol>
              <dl className="help-glossary">
                {SKILLS.map(([name, purpose]) => (
                  <div key={name} className="help-glossary-row">
                    <dt>
                      <code>{name}</code>
                    </dt>
                    <dd>{purpose}</dd>
                  </div>
                ))}
              </dl>
              <p>
                Each <code>SKILL.md</code> opens with the tools it assumes and the command that
                checks each one. No skill installs anything on your computer.
              </p>
              <p className="help-links">
                <a href={repoDocUrl('.agents/skills/README.md')} target="_blank" rel="noreferrer">
                  About the skills
                </a>
              </p>
              <p className="help-note">
                <strong>Rocky Surf is budget-capped, not sandboxed.</strong> A fully compromised MCP
                client with every scope can destroy this installation&rsquo;s servers and spend up to
                the configured cap. It cannot read a stored secret, obtain an SSH key, or exceed the
                limits by any MCP-shaped route. For the full account, see{' '}
                <a href={repoDocUrl('SECURITY.md')} target="_blank" rel="noreferrer">
                  the MCP threat model
                </a>
                .
              </p>
            </section>
          </section>

          <section
            className="help-panel"
            id="costs"
            role="tabpanel"
            aria-labelledby="help-tab-costs"
            hidden={active !== 'costs'}
          >
            <h2>Costs and caps</h2>
            <p className="help-lead">
              This section covers what Rocky Surf can tell you about spend, and the three limits it
              enforces before a machine is provisioned.
            </p>
            <p>
              Every server row is priced at create from the provider&rsquo;s own quote, and the{' '}
              <Link to="/costs">Costs</Link> page shows month-to-date and lifetime estimates — per
              currency, never summed across them, because that number would be fiction.
            </p>
            <p>Three limits are enforced server-side on the create path:</p>
            <ul className="help-list">
              <li>Concurrent servers.</li>
              <li>Creates per hour.</li>
              <li>An optional monthly spend cap.</li>
            </ul>
            <p>
              All three are set in <Link to="/settings?section=limits">Settings</Link>, and all three
              apply to every caller — the web UI, the CLI, and an agent over MCP. A refusal carries a
              machine-readable reason, so an agent that hits the cap can report it and stop instead
              of retrying blindly.
            </p>
          </section>

          <section
            className="help-panel"
            id="settings"
            role="tabpanel"
            aria-labelledby="help-tab-settings"
            hidden={active !== 'settings'}
          >
            <h2>Settings</h2>
            <p className="help-lead">
              This section covers what the Settings page edits and when a change takes effect.
            </p>
            <p>
              Settings is admin-only because it edits the config file — the document that holds
              provider sections, limits, and what the MCP server is allowed to do. Token fields take
              the <em>name</em> of an environment variable, never the secret itself, so credentials
              stay in your environment and out of the file.
            </p>
            <p>
              Saving applies immediately: Rocky Surf re-reads the file and adopts it before the save
              answers. Five settings cannot work that way — the port, the address it listens on, the
              data directory, the auth mode, and the MCP server&rsquo;s scopes — and each says so
              under its own box.
            </p>
          </section>

          <section
            className="help-panel"
            id="backup"
            role="tabpanel"
            aria-labelledby="help-tab-backup"
            hidden={active !== 'backup'}
          >
            <h2>Backing up your data</h2>
            <p className="help-lead">
              This section covers where your data lives, the two ways to copy it, and what makes a
              copy sensitive. Rocky Surf keeps everything it knows in one directory and there is no
              hosted copy of any of it — back it up yourself, or a lost machine takes your server
              records, your GitHub tokens, and your SSH keys with it. Your cloud credentials are
              never stored here.
            </p>
            <p>
              <strong>Where it is:</strong> <code>~/.rockysurf</code> by default, or whatever{' '}
              <code>server.dataDir</code> is set to in your config file; <code>/data</code> in the
              Docker Compose volume. Rocky Surf prints the config file it read on every start (
              <code>config: &lt;path&gt;</code>), the fastest way to confirm where a running
              installation actually keeps its data.
            </p>

            <section className="help-block" id="backup-move">
              <h3>Move to a new computer</h3>
              <p>To carry an installation to another machine, follow these steps:</p>
              <ol className="help-steps">
                <li>
                  In <Link to="/settings?section=backup">Settings &rarr; Backup</Link>, download the
                  backup. It is one JSON file: your records, packs, tools, and encrypted secrets as
                  ciphertext, with no key and no cleartext tokens in it.
                </li>
                <li>
                  Copy <code>secret.key</code> from the data directory yourself, by a route you
                  trust. The backup file does not contain it, and without it the secrets in the
                  backup stay ciphertext.
                </li>
                <li>Install Rocky Surf on the new computer and start it once.</li>
                <li>
                  Put <code>secret.key</code> in the new data directory, or set{' '}
                  <code>ROCKYSURF_SECRET_KEY</code> to its contents.
                </li>
                <li>In Settings on the new computer, restore from the JSON file.</li>
              </ol>
            </section>

            <section className="help-block" id="backup-directory">
              <h3>Copy the whole data directory</h3>
              <p>
                This is the full-fidelity alternative: the whole directory, key included, copied by
                hand. To make one, follow these steps:
              </p>
              <ol className="help-steps">
                <li>
                  <strong>Stop Rocky Surf before copying the database.</strong> SQLite&rsquo;s
                  write-ahead log means a plain file copy from a running installation can silently
                  miss the last few minutes of writes.
                </li>
                <li>Copy the whole data directory, with everything in the following list.</li>
                <li>Store the copy somewhere private, or encrypt it.</li>
              </ol>
              <p>Back up all of the following together:</p>
              <ul className="help-list">
                <li>
                  <code>rockysurf.db</code> — the SQLite database: every server row, pack, session,
                  and encrypted secret.
                </li>
                <li>
                  <code>secret.key</code> — the master key those secrets are encrypted with. Lose it
                  and every secret in the database is unrecoverable ciphertext; a database without it
                  is undecryptable on its own.
                </li>
                <li>
                  <code>rockysurf.config.yaml</code> — your configuration. If you pasted a
                  per-repository GitHub token directly into a Settings field rather than referencing
                  an environment variable, that token is written into this file too.
                </li>
                <li>
                  <code>packs/</code>, if you keep your own pack files here — the software your
                  servers are created with.
                </li>
              </ul>
              <p className="help-note">
                <strong>This is sensitive.</strong> Together, <code>secret.key</code> and{' '}
                <code>rockysurf.db</code> decrypt every managed server&rsquo;s SSH private key and any
                remote-desktop password Rocky Surf holds for you — a Connect-GitHub token lives there
                too. Cloud provider credentials are not among them: Rocky Surf stores none. A backup
                of the directory is that same secret material, copied. Keep{' '}
                <code>secret.key</code> out of the backup entirely by setting{' '}
                <code>ROCKYSURF_SECRET_KEY</code> instead of letting Rocky Surf write it to disk.
              </p>
              <p className="help-links">
                For the exact commands, for both an <code>npx</code>/from-source install and Docker
                Compose, and for how to restore, see{' '}
                <a
                  href={repoDocUrl('docs/self-hosting.md#backup-and-restore')}
                  target="_blank"
                  rel="noreferrer"
                >
                  Backup and restore
                </a>
                .
              </p>
            </section>
          </section>

          <section
            className="help-panel"
            id="glossary"
            role="tabpanel"
            aria-labelledby="help-tab-glossary"
            hidden={active !== 'glossary'}
          >
            <h2>Glossary</h2>
            <p className="help-lead">
              This section defines the four words the rest of this page is written in.
            </p>
            <dl className="help-glossary">
              <div className="help-glossary-row">
                <dt>Provider</dt>
                <dd>
                  The cloud, or your own machine, that a server runs on. Rocky Surf ships five:
                  Hetzner, AWS, Azure, Google Cloud, and your own machines (BYO). Each is enabled
                  independently and translates create, start, stop, and terminate into that
                  cloud&rsquo;s own API.
                </dd>
              </div>
              <div className="help-glossary-row">
                <dt>Server</dt>
                <dd>
                  One managed machine, launched on a provider from a Surge Pack, tracked through its
                  lifecycle — creating, running, stopped, terminated — until you remove it.
                </dd>
              </div>
              <div className="help-glossary-row">
                <dt>Surge Pack</dt>
                <dd>
                  The software a server is created with: a YAML file naming an ordered list of Tools
                  to install, plus a getting-started guide the pack&rsquo;s author wrote for whatever
                  the install cannot finish on your behalf.
                </dd>
              </div>
              <div className="help-glossary-row">
                <dt>Tool</dt>
                <dd>
                  One piece of software a Surge Pack installs: an idempotent, architecture-aware
                  install script plus the metadata — name, category, whether it runs as root — the
                  pack contract requires. A Tool can also be registered and shared on its own,
                  outside any pack.
                </dd>
              </div>
            </dl>
          </section>

          <section
            className="help-panel"
            id="docs"
            role="tabpanel"
            aria-labelledby="help-tab-docs"
            hidden={active !== 'docs'}
          >
            <h2>All documentation</h2>
            <p className="help-lead">
              This page summarizes; the documents in the following list decide. Each one is
              grouped under the audience it was written for, and each link opens that file on
              GitHub in a new tab.
            </p>

            {DOC_GROUPS.map((group) => (
              <section className="help-block" key={group.audience}>
                <h3>{group.audience}</h3>
                <dl className="help-glossary">
                  {group.docs.map(([path, title, summary]) => (
                    <div className="help-glossary-row" key={path}>
                      <dt>
                        <a href={repoDocUrl(path)} target="_blank" rel="noreferrer">
                          {title}
                        </a>
                      </dt>
                      <dd>{summary}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}

            <section className="help-block">
              <h3>Everything else</h3>
              <dl className="help-glossary">
                <div className="help-glossary-row">
                  <dt>
                    <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                      The repository
                    </a>
                  </dt>
                  <dd>
                    Everything this list does not name, including the source, the issues, and the
                    Agent Skills.
                  </dd>
                </div>
              </dl>
            </section>
          </section>
        </div>
      </div>
    </AppShell>
  )
}
