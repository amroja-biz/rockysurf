# Install and configure Rocky Surf

*For a coding agent doing this on someone's behalf. If you are a person, give your agent the
address of this page and ask it to install Rocky Surf for you.*

Read this page to the end before you run anything. Everything you need is on this page or reached
from it by a link, and you are not expected to know anything about Rocky Surf already.

**Rocky Surf v0.1.0 is not on the public npm registry yet**, so `npx -y rockysurf` has nothing to
fetch. Until it is published, installing Rocky Surf means cloning the repository and building it,
and that is the path this page walks. When v0.1.0 ships, one `npx` command replaces the clone and
the build, and a checkout becomes optional — see
[After the install: what a checkout is for](#after-the-install-what-a-checkout-is-for).

Rocky Surf is one process that a person runs on their own computer. It creates a Linux server in
a cloud account that belongs to them, installs coding agents on that server, and hands them an
SSH command. It has a web UI, an HTTP API and one SQLite file. There is nothing hosted, no
account to sign up for, and no telemetry.

Three terms are used throughout, and each one means something specific here:

- A **Provider** is Rocky Surf's connection to one cloud account. Four ship with it: Hetzner
  Cloud, AWS, Azure and Google Cloud. Every Provider is off until someone switches it on.
- A **Surge Pack** is the software bundle installed on a new server, defined in a YAML file.
- **MCP** is the Model Context Protocol. Rocky Surf serves its server lifecycle as MCP tools, so
  a coding agent can list, create, stop and destroy servers.

Your job has six parts, in this order:

1. Check the preconditions on the user's computer.
2. Ask the user the questions in this page, and get an answer to each one.
3. Clone the repository, then print the commands that touch the user's cloud account and let the
   user run them. The clone comes first because three of those commands read a file out of it.
4. Build Rocky Surf, and have the user start it for the first time.
5. Mint a token, and use it to configure the Providers through the HTTP API.
6. Register the MCP server in the user's client, and verify the whole thing.

## What you must never do

These rules hold for every step. Follow them even when the user asks you not to.

- **Never reach the user's cloud account yourself.** No cloud command-line tool, no console, no
  SDK, no API call of your own. Deploying an IAM role, creating a resource group, creating a
  service account, minting an API token, and signing in with `aws sso login`, `az login` or
  `gcloud auth application-default login` are the user's to run. Print the exact command, say
  what it does, and wait.
- **Never create, modify or destroy a machine** by any route, Rocky Surf's own API and MCP tools
  included. Installing Rocky Surf does not include creating a server with it.
- **One thing you may change at the cloud, and only through Rocky Surf.** Saving an SSH
  allow-list is how the product opens SSH on the servers it creates, and Rocky Surf pushes that
  rule to the cloud itself. You may make that call, because it is Rocky Surf acting rather than
  you, and it touches a firewall rule and nothing else. Tell the user exactly which networks it
  will allow before you make it. See [Write the settings](#write-the-settings).
- **Never print, echo, log or repeat a token, password, API key or personal access token**, in a
  chat message, a command, a commit, or a file. This includes the token you mint, the admin
  password Rocky Surf generates, and anything the user pastes to you. Where you must show the
  user a configuration change that contains one, show `<redacted>` in its place.
- **Never write a credential into Rocky Surf's configuration file.** Where a field takes a
  credential, it takes the *name* of an environment variable, and that is what you write. The
  MCP client's own configuration file is the one exception, and that file is not Rocky Surf's:
  see [Register the MCP server](#register-the-mcp-server).
- **Never put a private key anywhere.** Rocky Surf's SSH key list takes public keys, the
  contents of a `.pub` file, and refuses anything else.
- **Never write the user's MCP client configuration without their confirmation.** Show the exact
  change you propose, with the token redacted, and ask first.
- **Mint at most one token per session.** Every run of `rockysurf token` mints another
  credential, so do not run it to find out whether it works. If you are reconfiguring an
  installation and hold no token, mint one and tell the user you did.
- **Never set `0.0.0.0/0` in an SSH allow-list**, and never set `allowAllCidr`. That opens SSH on
  the user's servers to the whole internet.
- **Never change `server.host`.** Rocky Surf listens on `127.0.0.1` on purpose.

If you cannot finish a step without breaking one of these rules, stop and tell the user what you
need from them.

## Check the preconditions

Run these checks yourself, before you ask the user anything. Report any that fail, with the fix.

| Check | Command | What you need |
|---|---|---|
| Node.js | `node --version` | 24 or later, on the host. Rocky Surf refuses to start on anything older, and the pre-publish install builds the workspace on this machine. |
| pnpm | `pnpm --version` | Any version. The pre-publish install needs it to build the workspace. Install it with `corepack enable`. |
| Port 3000 is free | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health` | No answer. An answer of `200` means Rocky Surf is already running here, so this is a reconfiguration rather than an install. |
| An existing configuration | `ls ~/.rockysurf/config.yaml` | If the file exists, the user has an installation already. Read it, patch it through the API described later on this page, and never overwrite it. |
| The cloud's own tool | `hcloud version`, `aws --version`, `az --version` or `gcloud --version` | Only for the cloud the user picks, and only Hetzner needs no tool at all. AWS, Azure and Google Cloud each need their own command-line tool so the user can sign in. |
| Docker | `docker --version` | Only if the user asks for the Docker Compose path, which runs the server process but cannot complete the MCP setup before v0.1.0 is published. See [Install Rocky Surf and start it](#install-rocky-surf-and-start-it). |

To install Node.js 24, tell the user to run `nvm install 24 && nvm use 24`, or to use their
platform's installer.

## Ask the user these questions

Ask all of them before you install anything, because several answers decide what you install and
in what order. Ask them as written. Do not guess an answer, and do not fill one in from something
you found on the machine — an address in a shell history or a project id in another config file
is not consent to use it.

1. **Which cloud do you want Rocky Surf to use?** The choices are Hetzner Cloud, AWS, Azure and
   Google Cloud. You can pick more than one, or none — with no cloud configured, Rocky Surf runs
   an in-memory Provider, so you can create a fake server, watch it boot and destroy it before
   pointing it at a real account. Hetzner is the quickest to set up.
2. **Which region do you want servers created in?** The field is called Location for Hetzner and
   Azure, Region for AWS, and Zone for Google Cloud.
3. **Which account, project or subscription should Rocky Surf use?** Azure needs two answers: the
   subscription id, which `az account show --query id -o tsv` prints, and the name of the
   resource group the user creates for Rocky Surf. Google Cloud needs the project id — the id
   `my-project-123456`, not the display name — which Rocky Surf never infers, because a Google
   credential can be valid for many projects and names none of them. Hetzner and AWS need
   neither: the token names the Hetzner project, and the profile names the AWS account.
4. **What is the name of the environment variable or the profile that holds the credential?** For
   Hetzner, the variable holding the API token, `HETZNER_TOKEN` by default. For AWS, the named
   profile, or nothing to use the default credential chain. For Azure and Google Cloud, nothing:
   both read the credential from the sign-in you already have. Ask for the *name*, never the
   value.
5. **Which public network should be allowed to reach SSH on your servers?** AWS, Azure and Google
   Cloud each require this and have no default; Hetzner has no such setting. Offer to find the
   address for them with the two commands under
   [Find the SSH address](#find-the-ssh-address), then show what you found and ask them to
   confirm it before you write it. Ask whether they work from more than one network, and take a
   list if so.
6. **Do you want to save an SSH public key, so that servers authorize it?** If yes, ask for the
   path to the `.pub` file and a short name for it, such as `laptop`. Read only the `.pub` file.
7. **What limits do you want?** The three are the number of servers that may exist at once, the
   number of creates allowed per hour, and an optional monthly spend cap with a currency. All
   three are enforced before a machine is provisioned, for every caller.
8. **Do you need to clone private repositories onto your servers?** Public repositories need
   nothing. Private ones need a GitHub token, which the user adds themselves on the Settings
   page. Say so and move on: do not ask for a token.
9. **What may a connected agent do?** The default grant is `[read, stop]`, which lets an agent
   list servers and pause or resume them. `create` lets an agent create servers, which spends
   money. `terminate` lets an agent destroy them, which cannot be undone. Recommend the default,
   and change it only if the user asks.
10. **Which MCP client do you use, and do you want it registered for your account or for one
   project?** Claude Code and Codex CLI are the two worked examples on this page, and any other
   MCP client takes the same values in its own file format. Account scope, which Codex CLI calls
   global, is the better default for a tool that manages servers regardless of which repository
   is open.

### Find the SSH address

You may run these two commands: they read the user's own public address and touch no cloud
account. Run them on the machine the user connects to their servers from.

```bash
curl http://portquiz.net:22/          # the address a server sees on port 22 — the one SSH uses
curl -4 https://checkip.amazonaws.com # the address web traffic leaves by
```

The two can differ. On some networks — carrier-grade NAT, and some corporate and mobile gateways
— web traffic and SSH leave by different public addresses, so allowing the web address does not
cover SSH. Use the port-22 address, as a `/32`. Show both results to the user and ask them to
confirm before you write anything.

## Print the cloud setup commands

Everything in this section is the user's to run. Print the commands for the cloud they chose,
say what each one does, and wait for the user to tell you it is done. Do not run them.

Rocky Surf stores no cloud credentials. Each cloud authenticates through the path its own tooling
already uses, so what the user runs here puts a credential where Rocky Surf can read it and
nowhere else.

**Clone the repository first.** Three of the commands in this section read a file out of it, and
the install in the next section needs it anyway before v0.1.0 is published:

```bash
git clone https://github.com/amroja-biz/rockysurf
cd rockysurf
```

The commands below are written with paths relative to the root of that checkout, so have the user
run them from there. The files are `deploy/aws/iam-role.yaml`, `deploy/azure/role.bicep` and
`deploy/gcp/setup.sh`, and each one is also readable on its own:

- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/deploy/aws/iam-role.yaml>
- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/deploy/azure/role.bicep>
- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/deploy/gcp/setup.sh>

Read them there when the user asks what a command will grant. Once v0.1.0 is published and a
checkout is no longer part of installing, the AWS template and the Azure template are each a
single file the user can download with `curl -fsSLO <the address above>` and pass by filename.

**Hetzner Cloud.** Rocky Surf works with any Hetzner Cloud API token that has Read & Write on a
project. A token on the project the user already uses works with no further setup. For reduced
blast radius, recommend a project of its own: a Cloud API token has no per-resource scope, so the
project is the only boundary there is. Ask the user to open console.hetzner.com, choose or create
the project, open **Security**, create an API token with **Read & Write**, and export it in the
shell Rocky Surf will start from:

```bash
export HETZNER_TOKEN=the-token-you-just-created
```

A read-only token passes startup and then fails at the first create. A variable exported after
Rocky Surf started is not visible to it.

**AWS.** Rocky Surf works with any AWS credentials that can manage EC2, and never stores a key —
it uses whatever the AWS CLI on the same machine already uses. If `aws sts get-caller-identity`
works in the user's shell, Rocky Surf has credentials. An administrator SSO profile works with no
further setup. For reduced blast radius, recommend the dedicated role, which Rocky Surf assumes:

```bash
aws cloudformation deploy \
  --template-file deploy/aws/iam-role.yaml \
  --stack-name rocky-surf-iam-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides TrustedPrincipalArn=arn:aws:iam::123456789012:user/you ProviderRegion=us-east-1
```

Tell the user to replace the ARN with the IAM user or SSO role they sign in as, and to add a
profile that assumes the role to `~/.aws/config`. Leave the template's `ManagedByTag` at its
default: it is the tag Rocky Surf writes on every instance it creates, and the role may stop or
terminate only instances carrying it.

**Azure.** Rocky Surf works with any Azure identity that can manage virtual machines in the
resource group it uses, and there is nowhere in its configuration file to put a secret. Signing
in with `az login` as a subscription Owner or Contributor works with no further setup. The
resource group is not optional — Rocky Surf never creates one:

```bash
az provider register --namespace Microsoft.Compute
az provider register --namespace Microsoft.Network
az group create --name rocky-surf-rg --location eastus
```

Rocky Surf tries four credential sources in order: workload identity federation
(`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE`), a service principal
(`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`), a managed identity if Rocky Surf
itself runs on an Azure VM, and finally `az login`. When none answers, the error names every
source it tried.

For reduced blast radius, recommend the dedicated identity and the two custom roles in
`deploy/azure/role.bicep`: an operational role scoped to that one resource group, which is the
only place Rocky Surf creates anything, and a read-only role at subscription scope that reads
Azure's own catalogue. Granting a role needs Owner or User Access Administrator on the
subscription. Print these four commands for the user:

```bash
# 1. Create the identity. It prints an appId, a password and a tenant — the password is shown once
az ad sp create-for-rbac --name rocky-surf

# 2. Read that identity's OBJECT id, which is not its appId. Replace APP_ID with the appId above
az ad sp show --id APP_ID --query id -o tsv

# 3. Create both roles and grant them, at subscription scope
az deployment sub create \
  --location eastus \
  --template-file deploy/azure/role.bicep \
  --parameters resourceGroupName=rocky-surf-rg principalId=00000000-0000-0000-0000-000000000000

# 4. Export the identity's credentials in the shell Rocky Surf will start from
export AZURE_TENANT_ID=TENANT_ID AZURE_CLIENT_ID=APP_ID AZURE_CLIENT_SECRET=PASSWORD
```

Tell the user to put `principalId` from step 2 into step 3, and the three values from step 1 into
step 4.

**Google Cloud.** Rocky Surf works with any Google credentials that can manage Compute Engine in
the project, and never stores one — it uses Application Default Credentials. Signing in as a
project owner works with no further setup. The project and the Compute Engine API are not
optional:

```bash
gcloud services enable compute.googleapis.com --project=my-project-123456
gcloud auth application-default login
```

Warn the user that `gcloud auth login` is a different command that does not write the credentials
Rocky Surf reads. The two logins can even belong to two different Google accounts, which is the
likeliest reason a correct configuration fails on a first run. For reduced blast radius,
recommend `./deploy/gcp/setup.sh --project=my-project-123456`, run from a checkout of the
repository. It creates a custom IAM role carrying exactly the permissions Rocky Surf calls, a
service account to hold it, and the binding between them, and it grants no predefined role, no
owner and no editor. It is idempotent, and `--dry-run` prints every command it would run and
changes nothing.

For the full per-cloud detail, including the least-privilege roles, read the Provider page for
the cloud the user chose:

- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/docs/providers/hetzner.md>
- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/docs/providers/aws.md>
- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/docs/providers/azure.md>
- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/docs/providers/gcp.md>

## Install Rocky Surf and start it

Do this after the user confirms the cloud setup is done, so the credential is in place before the
process starts.

<!-- MAINTAINER NOTE: once v0.1.0 is on npm, this whole section collapses to `npx -y rockysurf`,
     the "read `node <checkout>/…`" sentence goes, the Docker Compose caveat below becomes a
     plain alternative, and the opening of this page and the closing checkout section both stop
     saying a clone is required. -->

**This page says Rocky Surf v0.1.0 is not on npm. Check whether that is still true** before you
commit to the fallback: the page is written to go stale on exactly this point, and one command
settles it.

```bash
npm view rockysurf version
```

If it prints a version, use `npx -y rockysurf` and skip the rest of this section. If it reports
that the package does not exist, carry on.

**Build the checkout.** This is the only complete install path before v0.1.0 is published: it
produces the same binary `npx` will fetch, and every command on the rest of this page has a
working form on it. It needs Node.js 24 or later on the host, and `pnpm`. You cloned the
repository in the previous section, so this runs in that directory:

```bash
pnpm install && pnpm -r build
node packages/rockysurf/dist/bin.js
```

Read `node <checkout>/packages/rockysurf/dist/bin.js` everywhere the rest of this page writes
`rockysurf`. Once v0.1.0 is published, that becomes `npx -y rockysurf` and the clone and the
build both go away.

Start the process from a shell holding the environment variables the user exported, or the
credential will not be visible to it.

**Docker Compose runs the server process, and is not a complete path before publish.** Offer it
only to a user who already knows Docker and only for the server process, and say why it is
partial:

```bash
docker compose up --build
```

- **`rockysurf token` and `rockysurf mcp` have no working host form** on a Compose-only install.
  There is no binary on the host, and `npx -y rockysurf` is dead until v0.1.0 is published. The
  copy inside the container is not addressed by the commands on this page.
- **Only some credentials reach the container.** The Compose file passes through
  `ROCKYSURF_ADMIN_PASSWORD`, `ROCKYSURF_SECRET_KEY`, `HETZNER_TOKEN` and `HCLOUD_TOKEN`, and
  nothing else. An AWS SSO session, an Azure sign-in and Google Application Default Credentials
  all live on the host and do not cross into the container.

So on a machine that has Docker and no checkout, tell the user that Rocky Surf will run but that
you cannot finish the MCP setup, and offer the checkout build instead.

**The user starts Rocky Surf for the first time, in their own terminal.** The first boot prints
an admin password to stderr, once, and stores only its hash. That password is the user's
credential for the web UI. It is not yours: you must not read it, capture it, or redirect the
output it appears in.

So print the start command, tell the user to run it in their own terminal and to save the
password it prints, and wait. On the Docker Compose path the password is in the container log, so
print `docker compose logs rockysurf | grep -A3 'first boot'` for them to run as well.

The user can choose their own password instead, by setting `ROCKYSURF_ADMIN_PASSWORD` in the
shell before that first start. Offer it, and do not ask them what they chose.

Confirm the process is up by polling `GET http://127.0.0.1:3000/health`, which needs no
credential. Do not confirm it by reading any log.

Once the first boot has happened, later starts print no password, and you may start and stop the
process yourself.

## Mint the agent token

The admin password is for the web UI. Your credential is a token, and one command mints it:

```bash
rockysurf token
```

The command reads the SQLite file directly and does not need Rocky Surf running, but it does need
Rocky Surf to have started at least once, because it mints a session for the admin account that
the first boot creates. The token is printed once, is valid for 365 days, and is stored only as a
hash. Capture it into a variable and never echo it:

```bash
ROCKYSURF_TOKEN=$(rockysurf token)
```

Only the token goes to stdout; everything a person reads goes to stderr.

**That token authorizes the HTTP API as well as the MCP tools.** It is what lets you configure
Rocky Surf on the user's behalf in the next section.

**Mint one token per session, and say that you did.** There is no way to revoke a single token:
the user revokes by signing out of the web UI, which drops every session and every token this
installation has issued, including their own browser's. So if you are reconfiguring an
installation that already has one and you do not hold it, mint a new one, tell the user, and tell
them what revoking costs.

## Configure the Providers through the API

Rocky Surf's Settings page edits one YAML configuration file. Two HTTP endpoints edit the same
file, and the token authorizes both. Send it as `Authorization: Bearer $ROCKYSURF_TOKEN`, and
read `http://127.0.0.1:3000` for the base address unless the user chose another port.

Saving applies immediately: Rocky Surf re-reads the file and adopts it before the save answers.

### Read the current state

`GET /api/v1/setup` reports, for each Provider, whether it is enabled in the file, whether a
credential exists where this process can see it, and whether it actually loaded:

```json
{
  "complete": false,
  "needsProvider": true,
  "providers": [
    {
      "id": "hetzner",
      "displayName": "Hetzner Cloud",
      "enabled": false,
      "configured": true,
      "source": "env",
      "envVar": "HETZNER_TOKEN",
      "loaded": false
    }
  ]
}
```

`loaded` is the field that matters: it means the Provider is present in this process and can be
used. When an enabled Provider is not loaded, `unavailableReason` says what was refused.

`GET /api/v1/settings` returns the file itself with every secret already reduced to `set` or
`not set`, the schema defaults, the list of fields the page may write, and — the part you need —
the file's modification time:

```json
{
  "file": { "path": "/home/dana/.rockysurf/config.yaml", "exists": false, "mtimeMs": null },
  "values": {},
  "defaults": { "...": "..." },
  "fields": [{ "path": "providers.aws.region", "kind": "string", "writable": true }]
}
```

`"exists": false` and `"mtimeMs": null` are the normal answer on a fresh install. The first save
creates the file at `~/.rockysurf/config.yaml`.

### Write the settings

`PUT /api/v1/settings` takes the modification time you just read and a list of changes. Each
change names a path as an array of segments and either a `value` or `"unset": true`:

```json
{
  "mtimeMs": null,
  "changes": [
    { "path": ["providers", "aws", "enabled"], "value": true },
    { "path": ["providers", "aws", "region"], "value": "us-east-1" },
    { "path": ["providers", "aws", "sshAllowedCidr"], "value": ["203.0.113.7/32"] },
    { "path": ["providers", "aws", "profile"], "value": "rockysurf" },
    { "path": ["limits", "maxServers"], "value": 5 },
    { "path": ["mcp", "scopes"], "value": ["read", "stop"] }
  ]
}
```

Four rules govern this call:

- **Send only the fields you are changing.** A field absent from the payload keeps its value.
- **`mtimeMs` is a concurrency token.** If the file changed on disk since your read, the call
  answers `409` and writes nothing. Read `GET /api/v1/settings` again and resend.
- **Only paths the field inventory declares are writable.** A path the page does not edit is
  refused by name, with `400`. The `fields` array from the read is the list.
- **The response says what took effect.** `applied` lists the paths already in force,
  `restartRequired` lists any that wait and why, and `networkSyncNeeded` lists the clouds whose
  SSH allow-list is now stale.

When `networkSyncNeeded` is not empty, push the allow-list to those clouds with
`POST /api/v1/network/ssh-access/sync`. It needs no request body: send the `Authorization` header
and nothing else, and it authorizes every CIDR in the file on every cloud that maintains a
firewall. A body of `{"revoke": {"aws": ["203.0.113.7/32"]}}` also *removes* the named ranges, so
send one only when the user has asked for a removal and confirmed the exact list.

This is the one call on this page that changes something in the user's cloud account, and it is
allowed for two reasons: it is Rocky Surf applying its own setting rather than you reaching the
cloud, and it changes a firewall rule and nothing else — it never launches, stops or touches an
instance. Before you make it, tell the user which networks it will allow SSH from, and on which
clouds. Everything else about their cloud account stays off limits: see
[What you must never do](#what-you-must-never-do).

### The fields for each cloud

Each row gives the paths to write under `providers.<id>`. Send the whole section in one call: the
save validates the resulting file as a whole and writes it atomically, so a section that is
enabled without its required fields is refused with the field named rather than half-written.

| Cloud | Path prefix | Fields to write | Required |
|---|---|---|---|
| Hetzner Cloud | `providers.hetzner` | `enabled`, `token`, `location` | `token` holds the *name* of the variable, `HETZNER_TOKEN`, and never the token. Leave it out and Rocky Surf reads `HETZNER_TOKEN`, then `HCLOUD_TOKEN`, from its own environment. `location` defaults to `fsn1`. |
| AWS | `providers.aws` | `enabled`, `region`, `profile`, `sshAllowedCidr` | `sshAllowedCidr` is required and has no default. `region` defaults to `us-east-1` and must be the region the role was deployed for. Leave `profile` unset to use the default credential chain. |
| Azure | `providers.azure` | `enabled`, `subscriptionId`, `resourceGroup`, `location`, `sshAllowedCidr` | All but `location` are required; `location` defaults to `eastus`. There is no credential field. |
| Google Cloud | `providers.gcp` | `enabled`, `projectId`, `zone`, `sshAllowedCidr` | `projectId` and `sshAllowedCidr` are required. `zone` defaults to `us-central1-a`. There is no credential field. |

`sshAllowedCidr` takes a list of CIDRs, and an empty list is refused. AWS, Azure and Google Cloud
each refuse to load without it, and Rocky Surf still starts — the Provider is simply absent, and
the startup log and the New Server page name it and say why.

The other settings the user answered for go at these paths: `ssh.keys` is a list of
`{ "name": "laptop", "publicKey": "ssh-ed25519 AAAA…" }` objects, `limits.maxServers`,
`limits.createRatePerHour`, `limits.spendCap.amount` and `limits.spendCap.currency` carry the
limits, and `mcp.scopes` carries the grant.

## Register the MCP server

`rockysurf mcp` is a separate process that your MCP client starts. It reaches Rocky Surf over
HTTP at the address in `ROCKYSURF_URL`, so Rocky Surf must already be running there.

Every MCP client wants the same four things: a `command`, its `args`, and two environment
variables, `ROCKYSURF_TOKEN` and `ROCKYSURF_URL`.

**How to handle the token here.** The client's configuration file has to hold the real value, and
that file is the client's rather than Rocky Surf's, so writing it there is the intended place —
but the value must not reach anything else. Three rules make that work:

- **Keep the token in the shell variable you captured it into**, `$ROCKYSURF_TOKEN`, and never
  type the literal.
- **For a command-line form, pass the variable**: `--env ROCKYSURF_TOKEN="$ROCKYSURF_TOKEN"`.
  Typing the literal would put it in the user's shell history.
- **For a file form, write the real value into the file, and redact it everywhere else.** The
  change you show the user, and anything you say afterwards, reads
  `"ROCKYSURF_TOKEN": "<redacted>"`.

Show the user the change you propose, in their client's own format and with the token redacted,
and get their confirmation before you write it.

**Claude Code**, account scope, which is the recommended default:

```bash
claude mcp add --scope user --env ROCKYSURF_TOKEN="$ROCKYSURF_TOKEN" \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

Claude Code project scope is this object in `.mcp.json` at the project root, written by hand —
the file is the contract, and this is the form the Rocky Surf help page documents. The same object
works in Claude Code's own account-scope file, `~/.claude.json`, and in Claude Desktop's
configuration file. Write the real token where this shows `<redacted>`:

```json
{
  "mcpServers": {
    "rockysurf": {
      "command": "npx",
      "args": ["-y", "rockysurf", "mcp"],
      "env": {
        "ROCKYSURF_TOKEN": "<redacted>",
        "ROCKYSURF_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

**Codex CLI**, account scope, which Codex calls the global config and writes to
`~/.codex/config.toml`:

```bash
codex mcp add rockysurf --env ROCKYSURF_TOKEN="$ROCKYSURF_TOKEN" \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

Codex CLI project scope is a `.codex/config.toml` at the repository root, loaded only for a
project the user has marked trusted. Codex CLI reads a project-scoped file, but as of Codex CLI
0.153 `codex mcp add` has no flag to write one. Add this table by hand:

```toml
[mcp_servers.rockysurf]
command = "npx"
args = ["-y", "rockysurf", "mcp"]
env = { ROCKYSURF_TOKEN = "<redacted>", ROCKYSURF_URL = "http://127.0.0.1:3000" }
```

**Until v0.1.0 is on npm, none of the four examples works as written**, because `npx` has no
`rockysurf` to fetch. Replace `npx -y rockysurf mcp` with
`node <checkout>/packages/rockysurf/dist/bin.js mcp`: `node` as the command, and the absolute
path and `mcp` as the two args. The two environment variables are unchanged.

Then have the user reconnect the client, which means restarting the session. Nothing changes for
an already-connected client until it reconnects.

## Verify the installation

Do all three checks, in this order, and report each result.

1. **Rocky Surf is up, and the Provider is enabled.** `GET /health` needs no credential and
   lists every enabled Provider by id:

   ```bash
   curl -s http://127.0.0.1:3000/health
   ```

   The output is similar to the following:

   ```json
   { "ok": true, "name": "rockysurf", "authMode": "local", "providers": ["aws"] }
   ```

2. **The Provider loaded.** `GET /api/v1/setup`, with the token, must report `"complete": true`,
   and the Provider the user chose must carry `"loaded": true`. A Provider that is enabled but
   not loaded carries `unavailableReason`, which says what was refused.

3. **The client holds the tools.** Ask the user to have their agent list its Rocky Surf tools. On
   the default grant there are 10: `list_servers`, `get_server`, `get_ssh_command`,
   `list_providers`, `get_provider`, `list_offerings`, `list_packs`, `list_ssh_keys`,
   `stop_server` and `start_server`.

Do not verify by creating a server. Creating a machine costs the user money, and it is their
decision to make.

## If something does not work

The following table lists the failures you are most likely to meet, and what each one means.

| What you see | What it means | What to do |
|---|---|---|
| A cloud is missing from the `providers` list in `/health` | The section is not enabled in the file | Set `providers.<id>.enabled` to `true` and save again |
| `/api/v1/setup` shows `"enabled": true, "loaded": false` with an `unavailableReason` | The Provider refused its own settings — most often a missing `sshAllowedCidr` | Read the reason, correct the field, save again |
| `/api/v1/setup` shows `"loaded": false` and `"source": "none"` for Hetzner | The environment variable is not visible to this process | Ask the user to export it and restart Rocky Surf |
| A credential was exported after Rocky Surf started | A running process cannot be handed a new environment | Restart Rocky Surf |
| `PUT /api/v1/settings` answers `409` | The file changed on disk after your read | `GET /api/v1/settings` again for the new `mtimeMs`, then resend |
| `PUT /api/v1/settings` answers `400` naming a path | That path is not one this API edits | Check the path against the `fields` array from the read |
| Any authenticated call answers `401` or `403` | The token is missing, wrong, or not being sent as `Authorization: Bearer …` | Check the header. Do not mint a second token to find out |
| `rockysurf token` says no admin account exists yet | Rocky Surf has never started against this data directory | Start it once, then mint the token |
| The agent reports there is no `create_server` tool | `mcp.scopes` withholds `create`. This is the default, not a bug | Only if the user asks: add `create` to `mcp.scopes`, save, and reconnect the client |
| A scope change has no effect | The MCP client reads the scopes when it starts | Reconnect the client. Rocky Surf itself needs no restart |
| MCP tool calls fail to connect | Rocky Surf is not running at `ROCKYSURF_URL` | Start it, and check the address and port |
| Rocky Surf refuses to start on the Node version | Node.js is older than 24 | `nvm install 24 && nvm use 24` |

## After the install: what a checkout is for

You already have a checkout, because installing Rocky Surf before v0.1.0 is published means
cloning and building the repository. Once v0.1.0 is on npm, `npx -y rockysurf` replaces all of
that and a checkout stops being part of installing anything.

From then on, clone the repository for one reason: to extend Rocky Surf with your own Surge Packs
or Providers. The published `rockysurf` package on npm ships the runtime, and the Agent Skills
and the Surge Pack smoke harness exist only in the repository.

```bash
git clone https://github.com/amroja-biz/rockysurf
```

For everything else, the installation you have just configured serves its own help at
<http://127.0.0.1:3000/help>, and these pages carry the detail:

- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/docs/self-hosting.md> — running
  Rocky Surf, where the data lives, backups and upgrades.
- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/SECURITY.md> — credential custody,
  SSH trust, and the MCP threat model.
- <https://raw.githubusercontent.com/amroja-biz/rockysurf/main/rockysurf.config.example.yaml> —
  every configuration key, with its default.
