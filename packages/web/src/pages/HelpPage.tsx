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
              — <code>stop</code> lets an agent both pause a box and start it again, while{' '}
              <code>create</code> and <code>terminate</code> are separate opt-ins, because making a
              box costs money and destroying one costs work.
            </p>
          </div>
          <div>
            <h3>Agent Skills</h3>
            <p>
              The repository ships skills a compatible coding agent started in a checkout picks up
              with no install step: <code>create-surge-pack</code> interviews you and writes a pack
              that passes the real smoke harness, <code>register-a-tool</code> does the same for a
              single tool you want to reuse or send someone, and <code>adding-providers</code>{' '}
              covers switching on a cloud or adding one Rocky Surf does not have yet. Outside a
              checkout, copy one in:
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

      {/*
        ENABLING A CLOUD PROVIDER (issue #112).

        Written to this page's first rule harder than any other section: `docs/providers/*.md`
        are the canonical reference and this is the PATH to them, not a second copy. What each
        sub-section carries is the set of facts a competent operator cannot guess — what must
        exist before Rocky Surf can be scoped to it, which keys the schema actually refuses to
        start without, where the credential is read from, and the name of the deployable role —
        and then it hands over. Anything that explains a cloud concept, or restates a policy
        the linked page justifies action by action, belongs there instead.

        Every required/optional claim below is the provider package's own zod schema — each
        `config.ts` under `packages/provider-<cloud>` — and not the example file's comments,
        because the schema is what refuses a boot. The credential order is `compose.ts`'s:
        config first, then the encrypted store.
      */}
      <section id="providers">
        <h2>Enabling a cloud provider</h2>
        <p>
          Every provider ships disabled, so a fresh install cannot spend money by accident.
          Turning one on is three things: whatever has to exist in the cloud <em>before</em>{' '}
          Rocky Surf can be scoped to it, a credential in your environment, and a few keys in
          the config file. Do the last part on the provider&rsquo;s own tab in{' '}
          <Link to="/settings">Settings</Link>, or by editing the file. Saving on the Settings
          page loads the provider straight away — no restart; a hand-edit to the file applies at
          the next start. The{' '}
          <Link to="/setup">setup wizard</Link> walks the same ground for a first install, and
          what you paste there goes into the encrypted secrets store rather than into the file.
        </p>
        <p>
          <strong>Credentials do not live in the config file.</strong> Each provider reads them
          from wherever your other tooling for that cloud already keeps them. Rocky Surf looks in
          the config file first and in its own encrypted store — what the wizard asked you to
          paste — second; the file wins on purpose, so it is never a lie about which credential
          is in force. Hetzner is the only provider with a credential field at all, and even
          there the value belongs in an environment variable that the file merely references as{' '}
          <code>{'${HETZNER_TOKEN}'}</code>.
        </p>
        <p>
          <strong>AWS, Azure and Google Cloud will not start without <code>sshAllowedCidr</code></strong>{' '}
          — which networks may reach SSH on your boxes. It is a <strong>list</strong> of CIDRs, so
          home and the office can both work; a single value is still read as a list of one, and an
          empty list is refused. There is no default and none is inferred; enabling one of them
          without it drops that provider at startup, and the boot log and the New Server page both
          say which. <code>0.0.0.0/0</code> <em>anywhere</em> in the list is refused unless{' '}
          <code>allowAllCidr: true</code> sits beside it, because opening SSH to the internet is
          two decisions. Hetzner has no such key: a Hetzner server is reachable the moment it
          boots, and there is no firewall object for Rocky Surf to own.
        </p>
        <p>
          <strong>Use the address your SSH connection uses, not the one a &ldquo;what is my IP&rdquo; page
          shows you.</strong> On some networks — carrier-grade NAT, a few corporate and mobile gateways —
          web traffic (ports 80 and 443) leaves by a different public address than everything else, SSH
          included. Whitelist the web address on such a network and the cloud correctly allows it while your
          SSH packets, carrying a different address, are still dropped — the box reads as{' '}
          <em>filtered</em> even though the CIDR is in the list. Find the SSH-path address with{' '}
          <code>curl http://portquiz.net:22/</code>, which echoes back the source IP a server saw on port 22,
          and compare it to your web address from <code>curl -4 https://checkip.amazonaws.com</code>; if they
          differ, whitelist the port-22 one. These NAT addresses can rotate, so if a network that used to
          work goes quiet, re-run the port-22 command and update its <code>/32</code>. A quick check that it
          is the network and not the box: if you can SSH in from a different network — a phone hotspot, say —
          the box is fine and this egress split is the cause.
        </p>
        <p>
          <strong>Saving <code>sshAllowedCidr</code> pushes it to the cloud straight away</strong> —
          you do not have to launch a server for it to take effect, which is what used to be
          required. Settings writes your file, this process adopts it, and then a second call
          updates the security group, the network security group rule or the firewall rule. Each
          cloud&rsquo;s answer appears on the Settings page under <strong>SSH access at the cloud</strong>.
          It never launches or touches an instance, and it applies to AWS, Azure and Google Cloud
          only — Hetzner has no whitelist to sync.
        </p>
        <p>
          <strong>
            The <code>Push SSH access to the clouds</code> button at the foot of Settings does the
            same on demand
          </strong>{' '}
          — and it is not the same errand as saving. A save pushes only what the save changed, and
          a cloud can drift while your file never does: Google Cloud&rsquo;s firewall rule read{' '}
          <code>sshAllowedCidr</code> once, when it was created, and ignored it from then on. No
          save would catch that, so the button is the repair. It needs no unsaved edits and pushes
          every cloud at once; <code>rockysurf network sync</code> is the CLI equivalent.
        </p>
        <p>
          <strong>Adding a CIDR takes effect everywhere; removing one does not, yet.</strong> On
          Azure the rule is rewritten whole, so a removal lands. On AWS and Google Cloud a range
          you delete is <em>reported</em> rather than removed — Rocky Surf only takes away access
          it can prove it granted, and what is already there may be the network you are reading
          this from — so the report hands you the exact{' '}
          <code>aws ec2 revoke-security-group-ingress</code> or{' '}
          <code>gcloud compute firewall-rules update</code> command that finishes the job.
        </p>
        <p>
          Three of the five ship a <strong>deployable least-privilege role</strong>, and the role
          is the one part of this that stays in the repository — each provider page justifies
          every action in it, one call at a time.
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
          <strong>Before</strong>, and this is the provider with real prerequisites: register{' '}
          <code>Microsoft.Compute</code> and <code>Microsoft.Network</code> on the subscription if
          it has never used them — a fresh subscription has not — create the one resource group
          Rocky Surf owns (<code>az group create --name rocky-surf-rg --location eastus</code>),
          and have an identity for it to run as (<code>az ad sp create-for-rbac</code>).{' '}
          <strong>Rocky Surf does not create the resource group, deliberately:</strong> a role
          cannot be scoped to a group that does not exist yet, so a provider that created its own
          scope would need resource-group write across the whole subscription — permission to
          delete any group in your account. One <code>az group create</code> buys a role that
          cannot reach outside one group.
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
          One Azure-specific thing to expect: <strong>a create is gated twice</strong> — by SKU
          availability, then by per-family core quota, which a fresh subscription has at zero for
          most families. The size list reads that quota where the credential can, and says when a
          family is refused for it rather than offering a machine the create would turn down.
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
          <code>gcloud</code> itself uses.{' '}
          <strong>
            <code>gcloud auth login</code> does not create or refresh ADC
          </strong>
          , and that is the likeliest reason a correct configuration fails on a first run: they
          are two separate logins, possibly to two different Google accounts, and only{' '}
          <code>gcloud auth application-default login</code> writes the one Rocky Surf reads. A
          key file — <code>GOOGLE_APPLICATION_CREDENTIALS</code>, or <code>keyFile</code> in the
          config as a <em>path</em> — is the last resort rather than the default.
        </p>
        <p>
          <strong>The role:</strong> one script creates the 22-permission custom role, a service
          account, and the binding between them. It is idempotent, and <code>--dry-run</code>{' '}
          prints every command it would run and changes nothing. <code>gcloud</code> is the only
          prerequisite.
        </p>
        <pre>
          <code>./deploy/gcp/setup.sh --project=my-project-123456</code>
        </pre>
        <p>
          <strong>Config:</strong> <code>enabled</code>, <code>projectId</code> and{' '}
          <code>sshAllowedCidr</code> (required, a list); <code>zone</code> defaults{' '}
          <code>us-central1-a</code>. <code>projectId</code> is never inferred, because a Google
          credential can be valid for many projects and names none of them — a guess would create
          billable machines in a project you did not pick. The zone default is not{' '}
          <code>-c</code> on purpose: arm64 (Tau T2A) is sold in only eight zones and{' '}
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
          account with passwordless sudo. There is no cloud API, no role to deploy and no
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

      {/*
        Issue #126. Stays here regardless of whether the dashboard's own notice has been
        dismissed — DISMISSING THE REMINDER MUST NOT MAKE THE ADVICE UNFINDABLE, so this
        paragraph is not gated by any of the notice's own localStorage keys.
      */}
      <section id="stale-servers">
        <h2>Checking for stale servers</h2>
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

        Every claim below is a fact about the shipped code rather than about the plan. Since issue
        #264 neither the client ID nor a pasted PAT needs a restart: the config file is re-read
        when Settings saves it, and both are read per use rather than at boot.
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
          Client ID into the <em>OAuth App client ID</em> box in Settings and save — the button
          works straight away, with no restart. The Client ID is public and needs no client secret;
          the device flow uses none.
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
          The token is written into the configuration file, so treat that file as a credential. It
          applies to the next server you create, with no restart. The configuration file also
          accepts{' '}
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
          — or hand that contract to your agent via the <code>create-surge-pack</code> skill
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
          your environment and out of the file. Saving applies straight away: Rocky Surf re-reads
          the file and adopts it before the save answers. Five settings cannot work that way — the
          port, the address it listens on, the data directory, the auth mode, and the MCP
          server&rsquo;s scopes — and each says so under its own box.
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
