# Configuring a provider Rocky Surf already ships

Five providers ship in the distribution: `hetzner`, `aws`, `azure`, `gcp` and `byo`. **Every one is
disabled until switched on**, so a fresh install cannot spend money by accident. At least one has to
be enabled before a server can be created.

There are three routes, and they are not equivalent.

| route | what it can do | when to use it |
|---|---|---|
| the config file | everything | the default answer, and the only route for GCP |
| the setup wizard | enable a provider and store its credential | first run |
| the Settings page | edit the fields in the settings inventory | a running install, for the fields it knows |

## The config file is the source of truth

`rockysurf.config.yaml` at the repository root — the committed file is
`rockysurf.config.example.yaml`, and the one *without* `.example` is the one holding real settings.
Under Docker, `docker/rockysurf.config.yaml` is the committed seed for the container's volume.

Start by reading the example file's `providers:` block. It is heavily commented and is the most
current description of every field, including which are required and why.

```yaml
providers:
  hetzner:
    enabled: true
    token: "${HETZNER_TOKEN}"
    location: fsn1
```

### Credentials are environment references, never literals

A token in the config file is written `${VAR}` — a reference to an environment variable, not the
secret itself. The value is substituted at load time.

The mechanics are worth knowing because they are the safe ones:

- Substitution runs over the **parsed** document, not the raw text. So a commented-out `${VAR}` is
  never substituted, and a token containing `#` or a quote cannot reshape the YAML.
- `$${VAR}` is the escape, for a literal `${VAR}`.
- Missing variables are reported **all at once**, not one per run.
- An empty-string variable is legal.
- Every `${VAR}` the example config references must be documented in `.env.example` — a test
  enforces it.

A credential box on the Settings page takes **the name of an environment variable only**, and the
whole value or nothing: `"${HETZNER_TOKEN}"` is a reference, `"tok_live_${SUFFIX}"` is not accepted
as one.

### Where credentials come from, in order

1. **The config file wins.** A credential written in the file is the one an operator can see, diff
   and roll back, so it beats the stored one. Silently preferring a stored token would mean a file
   that lies.
2. **Then the encrypted secrets store** — what the first-run wizard pasted, for the operator who
   does not edit files.
3. **An environment variable supplying the credential beats both at runtime**, and Rocky Surf will
   refuse to persist a credential over one that the environment is providing, rather than store
   something the environment would silently override.

**A credential pasted in the wizard takes effect at the next restart**, because providers are
constructed at boot. This surprises people; say it before they ask.

Three providers take **no credential from the config file at all**, by design — there is nowhere to
put one:

- **AWS**: the standard SDK chain. `AWS_PROFILE`, environment variables, or an instance role.
- **Azure**: `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`, a managed identity if
  Rocky Surf runs on an Azure VM, or `az login`. The wizard deliberately draws no box inviting
  someone to paste a client secret into a file that gets backed up and pasted into bug reports.
- **GCP**: Application Default Credentials — `gcloud auth application-default login`, or
  `GOOGLE_APPLICATION_CREDENTIALS`, or `providers.gcp.keyFile`. `keyFile` is a **path**, never key
  material.

## `sshAllowedCidr` is required, and has no default

For `aws`, `azure` and `gcp`, enabling the provider without `sshAllowedCidr` means the provider
refuses its own section and is dropped at startup. There is no default on purpose: a firewall rule
is a security decision and Rocky Surf will not infer one from whatever address the operator happens
to have today.

```yaml
sshAllowedCidr: "203.0.113.7/32"   # e.g. `curl -s https://checkip.amazonaws.com`, as a /32
```

Opening SSH to the whole internet takes **two** lines, deliberately:

```yaml
sshAllowedCidr: "0.0.0.0/0"
allowAllCidr: true
```

> **Known bug — `rockysurf-p5jr`.** Core's config schema does not declare `allowAllCidr` for `aws`
> or `azure`, so writing the two-line form there is rejected with "unrecognized key" even though
> `SECURITY.md`, `docs/providers/aws.md`, `docs/providers/azure.md` and the example config all
> instruct operators to write it. GCP declares both and works. If a user hits this, that is the
> bead — it is a core schema gap, not their mistake.

Hetzner and BYO have no security-group model and take neither field.

## What "enabled but not working" looks like

A provider that is enabled and cannot be built is **reported and skipped, never fatal**. The
control plane still starts, because the UI is where an operator fixes it. So the symptom is a
provider that is simply absent rather than an error at startup.

Where to look, in order:

1. **The boot log** — one line per provider: `disabled in config`, `no credential found — <hint>`,
   or `not loaded — <the rejection, as a sentence>`.
2. **The New Server page and `/api/v1/setup`** — an unavailable provider carries its reason.
3. **A restart** — if the credential was pasted in the wizard.

The common causes, in the order they actually occur: `enabled: false` still set; a missing
`sshAllowedCidr`; an environment variable named in the config but absent from the environment; and
a credential pasted in the wizard without a restart since.

## The Settings page does not cover everything

The settings inventory is hand-written per provider, not generated from the schema — a generated
form would produce a control for every field the schema happens to have, including ones that must
not be editable from a browser, and would render an env reference and a literal token as the same
box. The API refuses to save any path not in that inventory.

The consequence for a user right now: **GCP has no Settings-page presence at all**. It is a fully
wired provider — compose row, config section, docs, bundled prices — with zero rows in the settings
inventory and no section in the SPA. Configuring GCP means editing YAML by hand. Do not send
someone hunting through Settings for it.

## Provider-specific notes worth volunteering

- **Hetzner** is the quickest start: a project at `console.hetzner.com`, a read/write API token,
  exported as `HETZNER_TOKEN`. Note that arm64 (CAX) types are sold only in `fsn1`, `nbg1` and
  `hel1`, and stock varies. `consoleProjectId` is optional and only adds a "View in Hetzner
  Console" link — the API never reveals the numeric project id, so it has to be typed in.
- **Azure** needs the resource group to **exist first** (`az group create`). Rocky Surf does not
  create it, because a role cannot be scoped to a resource group that does not exist yet.
- **GCP** requires `projectId` with no default and no inference: a Google credential can be valid
  for many projects and names none of them, so a guess would create billable machines in a project
  the operator did not pick. Note also that a default VPC ships with Google's own
  `default-allow-ssh` rule opening port 22 to the whole internet; Rocky Surf never touches that
  rule, but it is worth telling the operator to look.
- **BYO** manages machines the operator already has, over SSH. Claiming a host creates a `rocky`
  account with passwordless sudo and appends Rocky Surf's key to it. **Releasing a host does not
  undo any of that** — terminate gives the host back to the pool and never runs anything on the
  machine. Say this before someone claims a production box.

## Least-privilege credentials

For AWS, Azure and GCP, the repository ships infrastructure-as-code for a least-privilege role
under `deploy/{aws,gcp,azure}`, and the per-provider pages under `docs/providers/` document the
minimal policy. Point operators at those rather than letting them start from an administrator
credential — and note that CI has checks (`scripts/check-iam-policy.mjs`,
`scripts/check-azure-role.mjs`, `scripts/check-gcp-role.mjs`) asserting the published roles stay in
step with what the providers actually call.
