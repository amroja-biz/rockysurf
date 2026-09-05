import { Link } from 'react-router'
import { AppShell } from '../components/AppShell'
import { GITHUB_URL, SHOP_PROVIDERS_URL, repoDocUrl } from '../lib/links'

/**
 * The in-app Help page (issue #16). Each section summarizes and links; the document it links —
 * SECURITY.md, docs/self-hosting.md, a provider page, a pack contract — is the normative
 * reference, so a claim here should never need to be read against the code to be trusted. If a
 * claim below is wrong, fix it or cut it; it should not describe what an older release did.
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
  ['glossary', 'Glossary'],
  ['providers', 'Enabling a cloud provider'],
  ['create', 'Creating a server'],
  ['boot', 'While it boots'],
  ['connect', 'Connecting'],
  ['lifecycle', 'Start, stop, terminate'],
  ['stale-servers', 'Checking for stale servers'],
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
          An agent can create, inspect, stop, and destroy its own servers, under the same
          server-side limits that apply to you — there is no second code path around them.
        </p>
        <div className="agents-grid">
          <div>
            <h3>The MCP server</h3>
            <p>
              Mint a token, then point your MCP client at it. For Claude Code, add this to{' '}
              <code>.mcp.json</code> in your project:
            </p>
            <pre>
              <code>
                # from a built checkout — until v0.1.0 is on npm,{'\n'}
                # this file IS the rockysurf command:{'\n'}
                node packages/rockysurf/dist/bin.js token
              </code>
            </pre>
            <p>
              <strong>Rocky Surf must already be running</strong> wherever{' '}
              <code>ROCKYSURF_URL</code> points — <code>rockysurf serve</code>, or the process
              serving this page. An MCP client may start the server below before that is true; it
              reports the condition on stderr, and every tool call recovers once core is up.
            </p>
            <pre>
              <code>{MCP_CLIENT_SNIPPET}</code>
            </pre>
            <p className="hint">
              That JSON is the shape v0.1.0 ships. Until the packages are on npm, <code>npx</code>{' '}
              has no <code>rockysurf</code> to fetch — use <code>"command": "node"</code> with{' '}
              <code>"args": ["&lt;your-checkout&gt;/packages/rockysurf/dist/bin.js", "mcp"]</code>{' '}
              and the same <code>env</code>.
            </p>
            <p>
              That JSON grants no permission by itself. What the agent may do comes from{' '}
              <code>mcp.scopes</code> in your config file, which defaults to{' '}
              <code>[read, stop]</code>. <code>stop</code> covers pausing a server and starting it
              again; <code>create</code> and <code>terminate</code> are separate opt-ins, because
              creating a server costs money and destroying one is not reversible. Scopes decide
              which tools the MCP server offers at all — a scope you have not granted does not
              appear in the tool list, rather than appearing and then refusing the call.
            </p>
            <p>
              On the default scopes an agent&rsquo;s tool list has no <code>create_server</code>.
              That is <strong>not a bug</strong>; it is this setting. To grant it, tick{' '}
              <code>create</code> under{' '}
              <Link to="/settings?section=mcp">Settings &rarr; MCP</Link> and reconnect the MCP
              client — scopes are read once, when that process starts, so nothing here takes
              effect until it does.
            </p>
          </div>
          <div>
            <h3>Agent Skills</h3>
            <p>
              The repository ships skills a compatible coding agent picks up with no install step
              inside a checkout: <code>create-surge-pack</code> interviews you and writes a pack
              that passes the real smoke harness, <code>register-a-tool</code> does the same for a
              single tool, and <code>add-provider</code> covers enabling a cloud Rocky Surf
              does not support yet. Outside a checkout, copy one in:
            </p>
            <pre>
              <code>cp -r .agents/skills/create-surge-pack ~/.agents/skills/</code>
            </pre>
            <p>
              <a href={repoDocUrl('.agents/skills/README.md')} target="_blank" rel="noreferrer">
                About the skills
              </a>
            </p>
          </div>
        </div>
        <p className="agents-footnote">
          <strong>Rocky Surf is budget-capped, not sandboxed.</strong> A fully compromised MCP
          client with every scope can destroy this installation&rsquo;s servers and spend up to
          the configured cap. It cannot read a stored secret, obtain an SSH key, or exceed the
          limits by any MCP-shaped route. Details:{' '}
          <a href={repoDocUrl('SECURITY.md')} target="_blank" rel="noreferrer">
            the MCP threat model
          </a>
          .
        </p>
      </section>

      <section id="glossary">
        <h2>Glossary</h2>
        <dl className="help-glossary">
          <dt>Provider</dt>
          <dd>
            The cloud, or your own machine, that a server runs on. Rocky Surf ships five: Hetzner,
            AWS, Azure, Google Cloud, and your own machines (BYO). Each is enabled independently
            and translates create, start, stop, and terminate into that cloud&rsquo;s own API.
          </dd>
          <dt>Server</dt>
          <dd>
            One managed machine, launched on a provider from a Surge Pack, tracked through its
            lifecycle — creating, running, stopped, terminated — until you remove it.
          </dd>
          <dt>Surge Pack</dt>
          <dd>
            The software a server is created with: a YAML file naming an ordered list of Tools to
            install, plus a getting-started guide the pack&rsquo;s author wrote for whatever the
            install cannot finish on your behalf.
          </dd>
          <dt>Tool</dt>
          <dd>
            One piece of software a Surge Pack installs: an idempotent, architecture-aware install
            script plus the metadata — name, category, whether it runs as root — the pack contract
            requires. A Tool can also be registered and shared on its own, outside any pack.
          </dd>
        </dl>
      </section>

      <section id="providers">
        <h2>Enabling a cloud provider</h2>
        <p>
          Every provider ships disabled, so a fresh install cannot spend money by accident.
          Enabling one is three things: whatever must exist in the cloud <em>before</em> Rocky
          Surf can be scoped to it, a credential in your environment, and a few keys in the config
          file. Set the config keys on the provider&rsquo;s own tab in{' '}
          <Link to="/settings">Settings</Link>, or by editing the file directly — Settings applies
          immediately, a hand-edit applies at the next start. The <Link to="/setup">setup
          wizard</Link> walks the same ground for a first install, and what you paste there goes
          into the encrypted secrets store rather than the file.
        </p>
        <p>
          <strong>Credentials do not live in the config file.</strong> Each provider reads them
          from wherever your other tooling for that cloud already keeps them. Rocky Surf checks
          the config file first, then its own encrypted store — what the wizard asked you to
          paste — so the file always wins when both are set. Hetzner is the only provider with a
          credential field at all, and even there the value is a reference to an environment
          variable: <code>{'${HETZNER_TOKEN}'}</code>.
        </p>
        <p>
          <strong>AWS, Azure, and Google Cloud will not start without <code>sshAllowedCidr</code></strong>{' '}
          — the networks allowed to reach SSH on your servers. It is always a <strong>list</strong>{' '}
          even for one CIDR, an empty list is refused, and there is no default. Enabling one of
          these providers without it fails at startup; the boot log and the New Server page both
          name the provider that was dropped. <code>0.0.0.0/0</code> anywhere in the list is
          refused unless <code>allowAllCidr: true</code> sits beside it, because opening SSH to
          the internet is two separate decisions. Hetzner has no such key: a Hetzner server is
          reachable the moment it boots, with no firewall object for Rocky Surf to own.
        </p>
        <p>
          <strong>Use the address your SSH connection uses, not the one a &ldquo;what is my
          IP&rdquo; page shows.</strong> On some networks — carrier-grade NAT, some corporate and
          mobile gateways — web traffic (ports 80 and 443) and SSH leave by different public
          addresses. Whitelisting the web address then does not cover SSH: the box reads as{' '}
          <em>filtered</em> even though a CIDR is in the list. Find the SSH-path address with{' '}
          <code>curl http://portquiz.net:22/</code>, which echoes the source IP a server saw on
          port 22, and compare it to the web address from{' '}
          <code>curl -4 https://checkip.amazonaws.com</code>; whitelist whichever one differs.
          These addresses can rotate, so if a network that worked before goes quiet, rerun the
          port-22 command and update its <code>/32</code>. To rule out the box itself: try SSH
          from a different network, such as a phone hotspot — if that works, the address split is
          the cause.
        </p>
        <p>
          <strong>Saving <code>sshAllowedCidr</code> pushes it to the cloud immediately</strong> —
          launching a server is not required for it to take effect. Settings writes the config
          file, this process adopts it, and then a second call updates the security group, network
          security group rule, or firewall rule. Each cloud&rsquo;s result appears in Settings
          under <strong>SSH access at the cloud</strong>. It never launches or touches an instance,
          and it applies to AWS, Azure, and Google Cloud only — Hetzner has no whitelist to sync.
        </p>
        <p>
          <strong>
            The <code>Push SSH access to the clouds</code> button, in the Settings footer, runs the
            same sync on demand
          </strong>{' '}
          — useful when the cloud has drifted independently of your config file, or after an
          upgrade, when it can surface access an earlier release added that your file no longer
          lists. The button needs no unsaved edits and pushes every enabled cloud at once;{' '}
          <code>rockysurf network sync</code> is the CLI equivalent.
        </p>
        <p>
          <strong>Adding a CIDR takes effect on every cloud as soon as it is pushed.</strong>{' '}
          Removing one differs by cloud. On Azure the whole rule is rewritten, so a removal lands
          in the same push. On AWS and Google Cloud, Rocky Surf only removes a range it can prove
          it added: a range it stamped when authorizing is offered under{' '}
          <strong>SSH access at the cloud</strong> as keep-or-remove, default keep, and choosing
          remove is an itemized, confirmed revoke. A range without Rocky Surf&rsquo;s stamp — one
          you or your own tooling added — is never touched automatically; the report names the
          exact <code>aws ec2 revoke-security-group-ingress</code> or{' '}
          <code>gcloud compute firewall-rules update</code> command that removes it yourself.
        </p>
        <p>
          Three of the five clouds ship a deployable least-privilege role, kept in the repository
          so each provider page can justify every action in it, one call at a time.
        </p>

        <h3>Hetzner</h3>
        <p>
          <strong>Before:</strong> a Cloud project, and an API token in it with{' '}
          <strong>Read &amp; Write</strong> — the project&rsquo;s Security section. Read-only
          passes startup validation and fails at the first create. Give Rocky Surf its own
          project: a Cloud API token has no per-resource scope, so the project is the only
          boundary that exists. Nothing to deploy.
        </p>
        <p>
          <strong>Config:</strong> <code>enabled</code>, <code>token</code> (required; write it as{' '}
          <code>{'"${HETZNER_TOKEN}"'}</code>) and <code>location</code> (defaults{' '}
          <code>fsn1</code>). Optional: <code>sizes</code> as an allowlist, and{' '}
          <code>consoleProjectId</code>, which only adds a console link and has to be typed in
          because the API never names the project a token belongs to.
        </p>
        <p>
          <a href={repoDocUrl('docs/providers/hetzner.md')} target="_blank" rel="noreferrer">
            docs/providers/hetzner.md
          </a>{' '}
          &middot; <Link to="/settings?section=providers.hetzner">Settings &rarr; Hetzner</Link>
        </p>

        <h3>AWS</h3>
        <p>
          <strong>Before:</strong> nothing to create. Rocky Surf uses the standard AWS credential
          chain — an SSO session, <code>AWS_PROFILE</code>, <code>AWS_ACCESS_KEY_ID</code> /{' '}
          <code>AWS_SECRET_ACCESS_KEY</code>, or an instance role. If{' '}
          <code>aws sts get-caller-identity</code> works in your shell, so will Rocky Surf, and
          there is nowhere in the config file to put a key.
        </p>
        <p>
          <strong>The role:</strong> <code>deploy/aws/iam-role.yaml</code>, a CloudFormation
          template that creates one IAM role carrying the published policy and nothing else.
        </p>
        <pre>
          <code>
            aws cloudformation deploy \{'\n'}
            {'  '}--template-file deploy/aws/iam-role.yaml \{'\n'}
            {'  '}--stack-name rocky-surf-iam-role \{'\n'}
            {'  '}--capabilities CAPABILITY_NAMED_IAM \{'\n'}
            {'  '}--parameter-overrides TrustedPrincipalArn=&lt;arn&gt; ProviderRegion=us-east-1
          </code>
        </pre>
        <p>
          Then point a profile at the role the way you point any AWS tool at one. The role is
          optional — the same policy attached to a user works — and its <code>ManagedByTag</code>{' '}
          must match <code>managedBy</code>, or Rocky Surf can create instances it is then not
          allowed to stop or terminate.
        </p>
        <p>
          <strong>Config:</strong> <code>enabled</code> and <code>sshAllowedCidr</code>{' '}
          (required, a list); <code>region</code> defaults <code>us-east-1</code>. Optional:{' '}
          <code>profile</code>, and <code>sizes</code> as an allowlist.
        </p>
        <p>
          <a href={repoDocUrl('docs/providers/aws.md')} target="_blank" rel="noreferrer">
            docs/providers/aws.md
          </a>{' '}
          &middot; <Link to="/settings?section=providers.aws">Settings &rarr; AWS</Link>
        </p>

        <h3>Azure</h3>
        <p>
          <strong>Before:</strong> register <code>Microsoft.Compute</code> and{' '}
          <code>Microsoft.Network</code> on the subscription if it has never used them (a fresh
          subscription has not), create the one resource group Rocky Surf owns (
          <code>az group create --name rocky-surf-rg --location eastus</code>), and create an
          identity for it to run as (<code>az ad sp create-for-rbac</code>).{' '}
          <strong>Rocky Surf does not create the resource group.</strong> A role cannot be scoped
          to a group that does not exist yet, so a provider that created its own scope would need
          resource-group write across the whole subscription — permission to delete any group in
          your account. One <code>az group create</code> buys a role that cannot reach outside one
          group.
        </p>
        <p>
          <strong>The role:</strong> <code>deploy/azure/role.bicep</code> — two definitions, one
          on the resource group and one read-only at subscription scope — deployed at{' '}
          <em>subscription</em> scope:
        </p>
        <pre>
          <code>
            az deployment sub create \{'\n'}
            {'  '}--location eastus \{'\n'}
            {'  '}--template-file deploy/azure/role.bicep \{'\n'}
            {'  '}--parameters resourceGroupName=rocky-surf-rg principalId=&lt;object id&gt;
          </code>
        </pre>
        <p>
          <code>principalId</code> is the identity&rsquo;s <strong>object</strong> id, not its
          application id (<code>az ad sp show --id &lt;appId&gt; --query id -o tsv</code>).
        </p>
        <p>
          <strong>Credentials</strong> come from <code>AZURE_TENANT_ID</code> /{' '}
          <code>AZURE_CLIENT_ID</code> / <code>AZURE_CLIENT_SECRET</code>, then a managed identity
          if Rocky Surf runs on an Azure VM, then <code>az login</code> — in that order, and a
          failure names every source it tried. <code>allowAzureCli: false</code> turns the third
          off on a server. There is nowhere in the config file for a client secret.
        </p>
        <p>
          <strong>Config:</strong> <code>enabled</code>, <code>subscriptionId</code>,{' '}
          <code>resourceGroup</code> and <code>sshAllowedCidr</code> (required, a list);{' '}
          <code>location</code> defaults <code>eastus</code>. Optional: <code>sizes</code>.
        </p>
        <p>
          <strong>A create is gated twice</strong> — by SKU availability, then by per-family core
          quota, which a fresh subscription has at zero for most families. The size list reads
          that quota where the credential can, and says when a family is refused for it rather
          than offering a machine the create would turn down.
        </p>
        <p>
          <a href={repoDocUrl('docs/providers/azure.md')} target="_blank" rel="noreferrer">
            docs/providers/azure.md
          </a>{' '}
          &middot; <Link to="/settings?section=providers.azure">Settings &rarr; Azure</Link>
        </p>

        <h3>Google Cloud</h3>
        <p>
          <strong>Before:</strong> a project, and Application Default Credentials — the same chain{' '}
          <code>gcloud</code> itself uses. <strong><code>gcloud auth login</code> does not create
          or refresh ADC</strong>, which is the likeliest reason a correct configuration fails on
          a first run: they are two separate logins, possibly to two different Google accounts,
          and only <code>gcloud auth application-default login</code> writes the one Rocky Surf
          reads. A key file — <code>GOOGLE_APPLICATION_CREDENTIALS</code>, or <code>keyFile</code>{' '}
          in the config as a <em>path</em> — is the last resort rather than the default.
        </p>
        <p>
          <strong>The role:</strong> one script creates a custom role, a service account, and the
          binding between them. It is idempotent, and <code>--dry-run</code> prints every command
          it would run and changes nothing. <code>gcloud</code> is the only prerequisite.
        </p>
        <pre>
          <code>./deploy/gcp/setup.sh --project=my-project-123456</code>
        </pre>
        <p>
          <strong>Config:</strong> <code>enabled</code>, <code>projectId</code> and{' '}
          <code>sshAllowedCidr</code> (required, a list); <code>zone</code> defaults{' '}
          <code>us-central1-a</code>. <code>projectId</code> is never inferred, because a Google
          credential can be valid for many projects and names none of them. The zone default is
          not <code>-c</code> on purpose: arm64 (Tau T2A) is sold in only eight zones and{' '}
          <code>us-central1-c</code> is not one of them. Optional: <code>keyFile</code>,{' '}
          <code>sizes</code>.
        </p>
        <p>
          <a href={repoDocUrl('docs/providers/gcp.md')} target="_blank" rel="noreferrer">
            docs/providers/gcp.md
          </a>{' '}
          &middot;{' '}
          <Link to="/settings?section=providers.gcp">Settings &rarr; Google Cloud</Link>
        </p>

        <h3>Your own machines (BYO)</h3>
        <p>
          <strong>Before:</strong> a machine you can already reach over SSH as root, or as an
          account with passwordless sudo. There is no cloud API, no role to deploy, and no
          credential stored — <code>identityFile</code> is a <em>path</em> to a key your own SSH
          already holds, and with an agent running (<code>SSH_AUTH_SOCK</code>) you can leave it
          out entirely.
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
          later connects as is <code>rocky</code>, which you do not configure — the claim creates
          it, with passwordless sudo, and appends Rocky Surf&rsquo;s key to it. Releasing a host
          undoes none of that: terminate is bookkeeping, and deliberately runs nothing on a
          machine Rocky Surf does not own.
        </p>
        <p>
          <a href={repoDocUrl('docs/providers/byo.md')} target="_blank" rel="noreferrer">
            docs/providers/byo.md
          </a>{' '}
          &middot;{' '}
          <Link to="/settings?section=providers.byo.hosts">
            Settings &rarr; Your own machines
          </Link>
        </p>
      </section>

      <section id="create">
        <h2>Creating a server</h2>
        <p>
          Pick a provider, pick a Surge Pack, describe what the machine should be — architecture
          included, arm64 is first-class — and optionally declare the repositories it will work
          on. Declared repository URLs are checked before any machine is launched, with the same
          token the box would use, so a typo fails in seconds instead of after a full boot on a
          box that then keeps billing. A refusal names the URL and the token that was tried, and
          you can create anyway — the check is a prediction, not a guarantee.
        </p>
      </section>

      <section id="boot">
        <h2>While it boots</h2>
        <p>
          The server page shows the install as it happens: a step timeline fed by the box itself
          and a live log tail. When the box reaches <em>running</em>, the pack&rsquo;s own
          getting-started guide appears — written by the pack author, including anything the
          install could not finish on your behalf (signing agents in, for instance: no credential
          of yours reaches a box during bootstrap). A failed box says why, and says whether the
          underlying instance is still billing.
        </p>
      </section>

      <section id="connect">
        <h2>Connecting</h2>
        <p>
          Every running server shows its SSH command. If you pasted your own public key when you
          created the box, that command uses it directly — no key file to manage. Rocky Surf also
          authorizes a key of its own while it provisions the box, whether or not you supplied
          one: it installs everything over its own SSH connection, so it needs a way in that does
          not depend on a key only you hold. While that key is still authorized it can be
          downloaded as a <code>.pem</code> — the one place in the system that hands out decrypted
          secret material, ownership-checked and audited, and safe to re-download if you lose it —
          and it is your recovery path in the meantime. Once bootstrap finishes on a box you
          supplied a key for, Rocky Surf&rsquo;s own key is removed and that recovery path goes
          with it: your key becomes the only one on the box. Packs that ship a desktop show
          remote-desktop instructions instead of making you guess.
        </p>
      </section>

      <section id="lifecycle">
        <h2>Start, stop, terminate</h2>
        <p>
          A stopped box keeps its disk and loses its compute bill — storage still costs money,
          just much less. On AWS and GCP the public IP changes across a stop/start cycle; on
          Hetzner and Azure it survives. Machines you brought yourself (BYO) cannot be stopped or
          started — their power is not Rocky Surf&rsquo;s to manage — and terminating a BYO host is
          bookkeeping: it returns the host to the pool and runs nothing on a machine Rocky Surf
          does not own. The per-provider evidence:{' '}
          <a href={repoDocUrl('docs/providers/capability-matrix.md')} target="_blank" rel="noreferrer">
            the capability matrix
          </a>
          .
        </p>
      </section>

      {/*
        Issue #126. Stays here regardless of whether the dashboard's own notice has been
        dismissed — dismissing the reminder must not make the advice unfindable, so this
        paragraph is not gated by any of the notice's own localStorage keys.
      */}
      <section id="stale-servers">
        <h2>Checking for stale servers</h2>
        <p>
          Rocky Surf&rsquo;s dashboard shows what core last learned from each provider&rsquo;s own
          API — polled on an interval and pushed over live events, but never a guaranteed,
          up-to-the-second mirror of your cloud account. A server terminated from the cloud
          console between polls, a box created directly on the account outside Rocky Surf, or a
          provider outage that delays a status update can all leave the dashboard saying something
          your cloud bill will not agree with. Treat this page as Rocky Surf&rsquo;s best record,
          not as your account&rsquo;s source of truth, and check your cloud provider&rsquo;s own
          console periodically for anything still running that this page does not show.
        </p>
      </section>

      <section id="repositories">
        <h2>Private repositories</h2>
        <p>
          Access tokens are configured per repository in Settings, and a box receives only the
          tokens its own declared repositories select — a box created for one repo does not carry
          the others&rsquo; credentials. There is no way to add a token to a running box. If you
          later need a private repository nobody declared at create, the options are to terminate
          and recreate with it declared, or to authenticate that one clone by hand. The create form
          resolves each URL as you type and says which token will be used, or that nothing matches
          yet. How to give Rocky Surf a token in the first place is{' '}
          <a href="#git-auth">Git Auth</a>, below.
        </p>
      </section>

      <section id="git-auth">
        <h2>Git Auth</h2>
        <p>
          The repositories you list when creating a server are cloned onto the box during setup.
          Public repositories clone with no credential. Private ones need a GitHub token, and there
          are two ways to give Rocky Surf one — a connected account, or a token per repository.
          Both are set up on the <Link to="/settings">Settings</Link> page, under{' '}
          <em>GitHub access tokens</em>.
        </p>
        <p>
          The catch-all token is also written onto the box as <code>GITHUB_TOKEN</code>, the
          variable <code>gh</code> and most CI-aware scripts read with no further configuration.
        </p>

        <h3>Connect GitHub</h3>
        <p>
          One button, and the token covers every repository your GitHub account can reach. It
          takes a one-time setup by whoever runs this installation, then a connect by each person
          using it.
        </p>
        <p>
          <strong>Setup, once.</strong> Register an OAuth App at{' '}
          <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
            github.com/settings/applications/new
          </a>
          . The form requires a Homepage URL and a callback URL, but the device flow never visits
          either — <code>http://localhost:3000</code> satisfies both. On the same form, tick{' '}
          <strong>Enable Device Flow</strong> and leave <strong>Expire user access tokens</strong>{' '}
          unticked. Copy the app&rsquo;s Client ID into the <em>OAuth App client ID</em> box in
          Settings and save — the button works straight away, with no restart. The Client ID is
          public and needs no client secret; the device flow uses none.
        </p>
        <p>
          <strong>Connecting, per person.</strong> Press <strong>Connect GitHub</strong> in
          Settings. Rocky Surf shows a short code and a link to github.com; enter the code there
          and approve. The token comes back to Rocky Surf.
        </p>
        <p>
          The token is user-level: it can reach every repository your account can, it does not
          expire, and it is stored encrypted rather than in the configuration file. It applies
          immediately, and is used by the servers you create. <strong>Disconnect</strong> makes
          Rocky Surf forget it; revoking it at GitHub is a separate step, at{' '}
          <a href="https://github.com/settings/applications" target="_blank" rel="noreferrer">
            github.com/settings/applications
          </a>
          . Connecting GitHub obtains a credential for cloning; it is not a way to sign in to Rocky
          Surf.
        </p>

        <h3>A token per repository</h3>
        <p>
          Create a fine-grained personal access token on GitHub, scoped to the one repository,
          with contents read and write. In Settings, press <strong>Add a token</strong>, enter the
          repository as <code>owner/name</code>, and paste the token.
        </p>
        <p>
          The token is written into the configuration file, so treat that file as a credential. It
          applies to the next server you create, with no restart. The configuration file also
          accepts <code>{'${GITHUB_PAT}'}</code>-style references to environment variables if you
          edit it by hand.
        </p>

        <h3>Which token a clone uses</h3>
        <p>
          A token entered for a specific repository is used for that repository. Everything else
          uses the catch-all — a connected account if there is one, otherwise the unscoped token
          in the configuration file. A repository matched by neither is cloned anonymously, which
          works for public repositories and fails for private ones.
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
          optional monthly spend cap. Refusals carry a machine-readable reason, so an agent that
          hits the cap can report it and stop instead of retrying blindly.
        </p>
      </section>

      <section id="packs">
        <h2>Surge Packs and tools</h2>
        <p>
          A Surge Pack is the software a box is created with, written as YAML: a list of tools
          with idempotent, architecture-aware install scripts, plus the author&rsquo;s post-boot
          guide. The Tools and Surge Packs admin pages let you inspect and edit what this
          installation offers. Writing your own is a contract, and CI enforces the mechanical half
          of it:{' '}
          <a href={repoDocUrl('docs/writing-a-pack.md')} target="_blank" rel="noreferrer">
            writing a pack
          </a>{' '}
          — or hand that contract to your agent with the <code>create-surge-pack</code> skill
          above.
        </p>
        <p>
          <strong>Pack Shop</strong> is where community packs come from. Packs marked{' '}
          <em>official</em> shipped with the release you are running; everything else carries the
          label you gave its registry in your config file, and no registry can call itself
          official. Installing one takes effect immediately, no restart.
        </p>
        <p>
          Before you install anything from a registry, that page shows you{' '}
          <strong>every script the pack will run, verbatim</strong>, which of them run as root,
          and every URL they download from — read it before you install. The registry&rsquo;s
          automated checks prove a pack is well-formed and survives being resumed; they cannot
          prove it is safe, because an install script is arbitrary shell running as root on your
          box.
        </p>
        <p>
          The same repository also lists <strong>providers</strong> — the clouds Rocky Surf can
          create servers on. Rocky Surf does not install those: unpack the package under the data
          directory&rsquo;s <code>providers</code> folder, name it in your config file, and
          restart. The steps and the packages are in the providers section of the{' '}
          <a href={SHOP_PROVIDERS_URL} target="_blank" rel="noreferrer">
            Rocky Surf Shop
          </a>
          . Once one loads it gets its own panel on the Settings page, the same as a provider that
          shipped with the release. A provider runs with Rocky Surf&rsquo;s full access — install
          ones you trust.
        </p>
      </section>

      <section id="settings">
        <h2>Settings</h2>
        <p>
          Settings is admin-only because it edits the config file — the document that holds
          provider sections, limits, and what the MCP server is allowed to do. Token fields take
          the <em>name</em> of an environment variable, never the secret itself, so credentials
          stay in your environment and out of the file. Saving applies immediately: Rocky Surf
          re-reads the file and adopts it before the save answers. Five settings cannot work that
          way — the port, the address it listens on, the data directory, the auth mode, and the
          MCP server&rsquo;s scopes — and each says so under its own box.
        </p>
      </section>

      <section id="backup">
        <h2>Backing up your data</h2>
        <p>
          Rocky Surf keeps everything it knows in one directory, and there is no hosted copy of
          any of it — back it up yourself, or a lost machine takes your server records, your
          GitHub tokens, and your SSH keys with it. (Your cloud credentials are never stored here:
          they live in your own environment and auth chains.)
        </p>
        <p>
          <strong>Moving to a new computer?</strong> Settings&nbsp;→&nbsp;Backup downloads one JSON
          file — your records, packs, tools, and encrypted secrets as ciphertext, with no key and
          no cleartext tokens in it — and Restore reads it back on the other side. Carry{' '}
          <code>secret.key</code> yourself. The rest of this section is the full-fidelity
          alternative: the whole directory, key included, copied by hand.
        </p>
        <p>
          <strong>Where it is:</strong> <code>~/.rockysurf</code> by default, or whatever{' '}
          <code>server.dataDir</code> is set to in your config file; <code>/data</code> in the
          Docker Compose volume. Rocky Surf prints the config file it read on every start (
          <code>config: &lt;path&gt;</code>), the fastest way to confirm where a running
          installation actually keeps its data.
        </p>
        <p>
          <strong>What is in it, and back up all of it together:</strong>
        </p>
        <ul>
          <li>
            <code>rockysurf.db</code> — the SQLite database: every server row, pack, session, and
            encrypted secret.
          </li>
          <li>
            <code>secret.key</code> — the master key those secrets are encrypted with. Lose it and
            every secret in the database is unrecoverable ciphertext; a database without it is
            undecryptable on its own.
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
          <code>rockysurf.db</code> decrypt every managed server&rsquo;s SSH private key and any
          remote-desktop password Rocky Surf holds for you — a Connect-GitHub token lives there
          too. (Cloud provider credentials are not among them: Rocky Surf stores none.) A backup of
          the directory is that same secret material, copied. Store it somewhere private, encrypt
          it, or keep <code>secret.key</code> out of the backup entirely by setting{' '}
          <code>ROCKYSURF_SECRET_KEY</code> instead of letting Rocky Surf write it to disk.
        </p>
        <p>
          <strong>Stop Rocky Surf before copying the database</strong> — SQLite&rsquo;s
          write-ahead log means a plain file copy from a running installation can silently miss
          the last few minutes of writes. The exact commands, for both an <code>npx</code>
          /from-source install and Docker Compose, plus how to restore, are in{' '}
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
          <a href={repoDocUrl('docs/providers/hetzner.md')} target="_blank" rel="noreferrer">
            Hetzner
          </a>
          ,{' '}
          <a href={repoDocUrl('docs/providers/aws.md')} target="_blank" rel="noreferrer">
            AWS
          </a>
          ,{' '}
          <a href={repoDocUrl('docs/providers/azure.md')} target="_blank" rel="noreferrer">
            Azure
          </a>
          ,{' '}
          <a href={repoDocUrl('docs/providers/gcp.md')} target="_blank" rel="noreferrer">
            Google Cloud
          </a>{' '}
          and{' '}
          <a href={repoDocUrl('docs/providers/byo.md')} target="_blank" rel="noreferrer">
            your own machines
          </a>
          , with{' '}
          <a href={repoDocUrl('docs/providers/capability-matrix.md')} target="_blank" rel="noreferrer">
            the capability matrix
          </a>{' '}
          for what each one can and cannot do. Extending it:{' '}
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
