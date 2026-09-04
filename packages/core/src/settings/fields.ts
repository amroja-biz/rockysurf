/**
 * WHAT THE SETTINGS EDITOR KNOWS ABOUT `rockysurf.config.yaml` (rockysurf-m29b).
 *
 * One hand-written inventory, and everything else in this directory is derived from it: which
 * fields are secret and therefore never leave the process, which are read-only and why, which
 * carry a warning, and — the load-bearing one — which paths a save is allowed to touch at all.
 *
 * IT IS HAND-WRITTEN ON PURPOSE. A form generated from the zod schema would produce a control
 * for every field the schema happens to have, including the three that must not be edited from
 * a browser, and would render a `${VAR}` reference and a literal token as the same text box.
 * The schema stays the validator — a save is checked by `configSchema` itself, server-side, and
 * nothing here re-implements a rule from it — but the schema is not a UI, and pretending it is
 * is how a settings page grows a control that bricks the installation.
 *
 * SECRET CLASSIFICATION IS BY FIELD, NEVER BY VALUE. A field is secret because of what it
 * holds — a provider credential — not because its contents look like one. `kind: 'secret'`
 * below is the whole list, and `fields.test.ts` fails when a credential-shaped field appears in
 * `config/schema.ts` without an entry here, so the classification cannot silently fall behind
 * the schema. `SECRET_KEY_NAMES` backs it up for keys the schema does not know about at all:
 * an operator's typo (`tokenn:`) is still a key holding a token, and the redaction should not
 * hand it back merely because no schema field claims it.
 *
 * WHAT A SECRET FIELD'S BOX TAKES is now a property of the FIELD — `accepts`, below. Since
 * rockysurf-4o3o the answer was "the NAME of an environment variable, and nothing else", and it
 * still is for every credential except the two GitHub PATs, which rockysurf-7fyf.2 turned into
 * paste boxes on the owner's ruling. `fields.test.ts` holds both halves to their own wording, so
 * neither the env-var instruction nor the paste instruction can drift into the other's fields.
 * The FILE is unchanged in both cases: the schema still accepts a literal and still expands
 * `${VAR}`, a hand-written reference still loads, and both are masked on the way out. The policy
 * is about what this product writes into a file it asks people to back up, not about what the
 * format can express.
 *
 * AND SINCE ISSUE #264, EVERY FIELD SAYS WHEN IT STARTS BEING USED. `appliesAt` is the whole of
 * the answer to "do I have to restart?", written per field rather than as one banner over the
 * page — because the true answer was never the same for all of them. Five fields need a restart
 * and each says why in its own words; everything else is in force the moment it is saved. This
 * inventory is the only place that classification is written down: `settings/routes.ts` reports
 * it, the page renders it beside the control, and `fields.test.ts` holds it to
 * `config/live-config.ts`'s `PINNED_PATHS` so the promise and the mechanism cannot drift.
 */

/**
 * How the editor renders a field.
 *
 * `group` is a whole optional block — `limits.spendCap` is the only one — which exists because
 * turning a spend cap off means removing the block, not blanking its two fields. `{ amount: 50 }`
 * with no currency is not a cap with a missing half; it is a config file that will not load.
 */
export type FieldKind = 'string' | 'number' | 'boolean' | 'secret' | 'stringList' | 'group'

export interface FieldSpec {
  /** Dotted path from the document root. `*` stands for one list index. */
  path: string
  kind: FieldKind
  /** False when the editor shows the value but will not write it. `reason` is then required. */
  writable: boolean
  /**
   * WHEN A SAVED VALUE STARTS BEING USED (issue #264).
   *
   * `'save'` is a PROMISE, not a hope: the moment the file is written, `config/live-config.ts`
   * re-reads it, this process adopts it, and whatever was built from the old value — a provider
   * client, the pack shop's client — is rebuilt by its owner. A field marked `'save'` whose
   * consumer still reads a value captured at boot is a bug in that consumer, and the honest fix
   * is to make the consumer live rather than to re-label the field.
   *
   * `'restart'` is the other half of the same honesty, and `restartReason` says why in words an
   * operator can act on. There are five, and each is a fact about a process rather than caution
   * in general: the listener is bound (`server.port`, `server.host`), the database and the
   * master key are open from one directory (`server.dataDir`), the mode that issued every live
   * session cannot be swapped underneath them (`auth.mode`), and `mcp.scopes` is read by a
   * DIFFERENT process altogether — the one an MCP client starts — which Rocky Surf cannot
   * restart on anybody's behalf. The first four are `PINNED_PATHS` in `config/live-config.ts`,
   * so this process keeps running on its own values however the file is edited.
   *
   * REQUIRED BY THE TYPE, on `help`'s precedent: a field added here has to state which of the
   * two it is, so nothing acquires a silent default and the page can never say "applies now"
   * about a value nothing re-reads.
   */
  appliesAt: 'save' | 'restart'
  /** Why a restart is needed, for the note the page prints beside the control. */
  restartReason?: string
  /**
   * What this setting is for, in operator language — rendered under the label, always visible
   * (rockysurf-5qzg).
   *
   * REQUIRED BY THE TYPE, which is the enforcement that matters: a field added to this inventory
   * without help text does not compile, so the rule cannot be forgotten in review the way a
   * lint would be. `fields.test.ts` then checks that what was written is a sentence rather than a
   * placeholder, and the web suite checks that every rendered control actually shows it.
   *
   * The wording is aligned with `rockysurf.config.example.yaml` and `docs/self-hosting.md`, and
   * quotes them where their sentence was already the better one, so the file, the docs and the
   * page cannot tell an operator three different things.
   */
  help: string
  /** Why this field is not writable, in words an operator can act on. */
  reason?: string
  /** A footgun worth naming next to the control. Shown for writable fields. */
  warning?: string
  /**
   * Known to the inventory, deliberately absent from the page (rockysurf-5qzg).
   *
   * THE RULE: a field whose only message to an operator is "you cannot use this" does not render
   * at all. A box with a note under it saying the one other value does not exist yet is not
   * honesty — it is an invitation followed by a refusal, and the page is the GUI for the product
   * that exists, not for the one the schema anticipates.
   *
   * It is a rendering flag and nothing more. The entry stays here, so the file keeps the field,
   * the boot path keeps reading it, and a `PUT` that names it is still refused by `routes.ts`
   * with this entry's `reason` rather than with a vaguer "the page does not edit that".
   *
   * NOT the same as `writable: false`. `server.dataDir` and `providers.aws.sizes` are read-only
   * and DO render: both are real settings with real values an operator wants to read, and both
   * reasons say where the edit is actually made. `auth.mode` is the other case — the edit has no
   * destination, because the mode it would select does not exist.
   */
  hidden?: true
  /**
   * WHAT A CREDENTIAL BOX TAKES — the variable name, or the token (rockysurf-7fyf.2).
   *
   * `'envVarName'` is the default and is rockysurf-4o3o's standing rule: the box takes the NAME
   * of an environment variable, the file gets `${VAR}`, and a copy of the file carries nothing.
   * That reasoning is unchanged and still governs `providers.hetzner.token` and the BYO fields.
   *
   * `'literal'` is set on the two GitHub PAT paths ONLY, on the owner's ruling that for those
   * two the indirection costs more than it buys: three steps, two of them off-screen, and the
   * middle one is the part operators get wrong. Those boxes take a pasted token, which is
   * written into the config file — so the file may now hold a credential, and the docs say to
   * treat it as one.
   *
   * PER FIELD, NOT PER KIND, which is what keeps this a narrowing rather than a repeal.
   * `kind: 'secret'` still means exactly what it meant — redact this field — and the redaction
   * path is untouched: a pasted literal reads back as `state: 'set'` and is never displayed.
   *
   * THE FILE IS UNCHANGED EITHER WAY. `config/interpolate.ts` still expands `${VAR}`, a
   * hand-edited `pat: "${GITHUB_PAT}"` still loads and still round-trips through this editor,
   * and it is still the right shape for anyone who wants the file to carry nothing. What this
   * flag decides is what the GUI ASKS FOR. See ADR-0007.
   */
  accepts?: 'literal' | 'envVarName'
}

/**
 * A section of the page, and what the whole section is for.
 *
 * The page hand-builds its sections — no form generator, per the note above — but their titles
 * and help live here for the same reason field help does: one place where the words are written,
 * and one place a test can check that none of them is missing. `id` is the config path the
 * section is about, which is what makes "does this section exist in the file?" answerable.
 */
export interface SectionSpec {
  id: string
  title: string
  help: string
}

/**
 * THE SAVED TYPES, one field per (cloud, size) — `preferences.tiers` (issue #124).
 *
 * GENERATED FROM A TABLE, which is the one place this file departs from "hand-written on
 * purpose" and does so for the reason the rule exists. The objection to a generated form is
 * that it produces a control per schema field with nothing to say about any of them; here the
 * words are written by hand, once per cloud, and only the three sizes are looped — the sentence
 * an operator reads is as specific as any other in this file, and writing the same paragraph
 * out twelve times would guarantee that eleven of them drift.
 *
 * `example` is that cloud's own vocabulary, because "a machine type" means `t4g.small` on AWS,
 * `cpx21` at Hetzner and `Standard_B2ps_v2` on Azure, and a box that cannot tell you what shape
 * of thing goes in it is a box people leave empty.
 */
const TIER_PREFERENCE_CLOUDS: readonly { id: string; label: string; noun: string; example: string }[] = [
  { id: 'hetzner', label: 'Hetzner', noun: 'server type', example: 'cpx21' },
  { id: 'aws', label: 'AWS', noun: 'instance type', example: 't4g.medium' },
  { id: 'azure', label: 'Azure', noun: 'VM size', example: 'Standard_B2ps_v2' },
  { id: 'gcp', label: 'Google Cloud', noun: 'machine type', example: 't2a-standard-2' },
  { id: 'byo', label: 'your own machines', noun: 'host', example: 'the-nuc-under-the-desk' },
]

const TIER_PREFERENCE_SIZES = ['small', 'medium', 'large'] as const

const TIER_PREFERENCE_FIELDS: readonly FieldSpec[] = TIER_PREFERENCE_CLOUDS.flatMap((cloud) =>
  TIER_PREFERENCE_SIZES.map((size) => ({
    path: `preferences.tiers.${cloud.id}.${size}`,
    kind: 'string' as const,
    writable: true,
    appliesAt: 'save',
    help:
      `The ${cloud.noun} to use whenever you ask ${cloud.label} for a ${size} box — ` +
      `${cloud.example}, for instance. Leave it blank to take the cheapest ${cloud.noun} that ` +
      `meets the ${size} floor, which is what Rocky Surf has always done. A saved type does not ` +
      `have to meet that floor: it is your answer, not a second guess at it.`,
  })),
)

/**
 * The v0.1 field inventory.
 *
 * Three fields are deliberately read-only, and each reason is a specific accident rather than
 * caution in general:
 *
 *  - `server.dataDir` — the database, the master key and the encrypted secrets store live
 *    there and are open in this process right now. Changing the path does not move any of
 *    them, so the next start comes up on an empty directory: no servers, no credentials, no
 *    SSH keys, and every appearance of total data loss. Moving a data directory is stop, move,
 *    edit, start — not a form field on a page served by the process that holds it open.
 *  - `auth.mode` — `local` is the only mode that exists. Switching to `github-device` disables
 *    password login (`app.ts` refuses it by name) and there is no device flow yet to replace
 *    it, so the field's one available edit locks the operator out of the page they made it on.
 *  - `providers.aws.sizes` — an allowlist of opaque instance-type strings, outside the sections
 *    m29b scoped, and a list editor for it would be surface with no demand behind it. It is
 *    shown so the page tells the truth about the file, and edited in the file.
 *
 * ONE OF THE THREE ALSO DOES NOT RENDER (rockysurf-5qzg), and the split between them is the
 * point. `dataDir` and `sizes` are settings that WORK: their values are facts about the running
 * installation, and their reasons name where the edit is made instead. `auth.mode` is a setting
 * whose only other value has not been built, so a control for it can offer nothing — it is
 * `hidden`, and the page never draws it.
 */
export const SETTINGS_FIELDS: readonly FieldSpec[] = [
  /* -------------------------------------------------------------------------- server */
  {
    path: 'server.port',
    kind: 'number',
    writable: true,
    appliesAt: 'restart',
    restartReason:
      'The socket this page arrived on is already bound to the old port, and a running process ' +
      'cannot move a listener without dropping every connection on it. The new port applies at ' +
      'the next restart — and this page moves with it, so the address in your browser changes too.',
    help: 'The port the web UI and the API are served on.',
  },
  {
    path: 'server.host',
    kind: 'string',
    writable: true,
    appliesAt: 'restart',
    restartReason:
      'The listener is already bound to the old interface, and rebinding it would drop every ' +
      'connection including this one. The new address applies at the next restart.',
    help:
      'Which network interface to listen on. The default keeps Rocky Surf reachable from this ' +
      'machine only.',
    warning:
      'Loopback (127.0.0.1) is the default because this process holds your cloud credentials and ' +
      'the SSH key for every server it manages. Use 0.0.0.0 only inside a container, or behind a ' +
      'firewall or a TLS-terminating proxy. A value this machine cannot bind stops Rocky Surf from ' +
      'starting, and the fix is then an edit to the file itself.',
  },
  {
    path: 'server.publicUrl',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The public URL of this control plane. Only callback-mode bootstrap needs it; push mode — ' +
      'the default — needs no inbound connectivity at all, so leave it unset unless this instance ' +
      'is publicly reachable.',
  },
  {
    path: 'server.dataDir',
    kind: 'string',
    writable: false,
    appliesAt: 'restart',
    restartReason:
      'The database, the master key and the encrypted secrets store are open from the old ' +
      'directory right now. Nothing about that can change while Rocky Surf is running.',
    help: 'Where the database, the generated keys and the encrypted secrets live. Back this directory up.',
    reason:
      'The database, the master key and the encrypted secrets store are open from this directory ' +
      'right now, and changing the path here would not move them — the next start would come up on ' +
      'an empty one. Stop Rocky Surf, move the directory, edit this line, then start again.',
  },

  /* ---------------------------------------------------------------------------- auth */
  {
    path: 'auth.mode',
    kind: 'string',
    writable: false,
    appliesAt: 'restart',
    restartReason:
      'Every session open right now was issued by the mode this process started in; swapping it ' +
      'underneath them is not something a running process can do honestly.',
    hidden: true,
    help: 'How you sign in. `local` is a single admin account and no configuration.',
    reason:
      '`local` is the only mode implemented in v0.1. Switching to `github-device` turns off ' +
      'password login with no device flow yet to replace it, which would lock you out of this page.',
  },

  /* -------------------------------------------------------------------------- github */
  /**
   * ONE LIST ON THE PAGE, TWO SHAPES IN THE FILE (rockysurf-5qzg).
   *
   * `github.pat` and `github.tokens[]` are one idea written twice — a token, and the repositories
   * it opens — so the page shows them as one list of access tokens in which the entry naming no
   * scope IS the instance-wide fallback. The schema refuses an unscoped `tokens[]` entry, on
   * purpose (ta7g: it "IS github.pat written longer"), and that refusal is exactly why the
   * unification is a rendering decision rather than a schema change: the page maps the unscoped
   * entry onto `github.pat`, and every path a save names is still a path this file already had.
   *
   * `owner` therefore has no control of its own. The page offers ONE scope box, which writes
   * `repo: "acme/widgets"` in the one-string form (ly2n) or `owner: acme` on its own — the two
   * halves of a scope are not two questions to an operator, who thinks in repository names.
   */
  /**
   * The Connect GitHub button's OAuth App (rockysurf-7fyf.1).
   *
   * `kind: 'string'`, NOT `'secret'`, and that is a classification rather than an oversight. A
   * device-flow client id is public — the flow needs no `client_secret` — so marking it secret
   * would mask it in `redactTree` and hide from the operator the one value they need to be able
   * to proof-read against the app's own settings page.
   *
   * WHEN IT IS UNSET THE BUTTON STILL RENDERS, disabled, with these two steps. That is the
   * opposite of the `auth.mode` rule above, and the difference is where the edit goes: `hidden`
   * is for a control whose only message is "you cannot use this" and whose edit has NO
   * destination. This edit has one — register an app, paste the id, the button works — so
   * hiding it would hide the cure along with the disease.
   */
  {
    path: 'github.oauth.clientId',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The client ID of an OAuth App, which is what the Connect GitHub button signs in against. ' +
      'Register one at github.com/settings/applications/new, tick "Enable Device Flow" in its ' +
      'settings, and leave token expiration off. A client ID is public: it is safe in this file ' +
      'and safe to commit.',
  },
  {
    path: 'github.pat',
    kind: 'secret',
    writable: true,
    appliesAt: 'save',
    accepts: 'literal',
    help:
      'The token used to clone private repositories that no scoped entry below matches. Paste the ' +
      'token itself: it is stored in the configuration file, so treat that file as a credential. ' +
      'The token needs `repo` scope, and every box created here receives it, whoever created it.',
  },
  {
    path: 'github.tokens.*.host',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The forge this entry is for, when it is not github.com — a self-hosted GitHub Enterprise, ' +
      'with a port if it uses one. An entry with a host and nothing else covers everything on it.',
  },
  {
    path: 'github.tokens.*.owner',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The account or organisation an entry covers. The scope box writes it: `acme/widgets` fills ' +
      'in both halves, and `acme` on its own means every repository under that account.',
  },
  {
    path: 'github.tokens.*.repo',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'Which repositories this token opens: `acme/widgets` for one, or `acme` on its own for every ' +
      'repository under that account. Leave it blank and name a host to cover a whole forge, or ' +
      'blank entirely to make this the fallback for everything unmatched.',
  },
  {
    path: 'github.tokens.*.pat',
    kind: 'secret',
    writable: true,
    appliesAt: 'save',
    accepts: 'literal',
    help:
      'The token this scope uses. Paste the token itself: it is stored in the configuration file, ' +
      'so treat that file as a credential. A fine-grained PAT covering only the repositories named ' +
      'above is the narrowest thing that works here.',
  },

  /* ------------------------------------------------------------------------------ ssh */
  /**
   * YOUR OWN SSH PUBLIC KEYS, SAVED BY NAME (issue #302).
   *
   * A list, so the page draws it as a card with Add and Remove — the same machinery
   * `registry.sources` and `providers.byo.hosts` use, and the reason no line of
   * `SettingsPage.tsx` changed to add this. Both fields are plain strings: a public key is
   * published material, `kind: 'secret'` would be a lie about what it is, and the redaction
   * that classification triggers would hide from an operator the one value they need to be
   * able to proof-read against `~/.ssh/*.pub`.
   *
   * `SECRET_KEY_NAME` already leaves `sshPublicKey` alone and says why in its own comment, so
   * the backstop agrees with the classification rather than fighting it.
   */
  {
    path: 'ssh.keys.*.name',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'What you will call this public key when the New Server page offers it — `laptop`, ' +
      '`work desktop`, `yubikey`. It is a label for you, and nothing on a box ever sees it.',
  },
  {
    path: 'ssh.keys.*.publicKey',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The PUBLIC key itself: one line, the whole contents of a `.pub` file — run ' +
      '`cat ~/.ssh/id_ed25519.pub` and paste what it prints. It must start with `ssh-ed25519`, ' +
      '`ssh-rsa` or `ecdsa-sha2-…`.',
    warning:
      'The PUBLIC half only. Never paste a private key here — the file WITHOUT `.pub`, whose ' +
      'contents say `PRIVATE KEY`. Rocky Surf refuses one and will not save it, but a private key ' +
      'that has been copied out of `~/.ssh` should be rotated whether or not anything stored it.',
  },

  /* ----------------------------------------------------------------------- providers */
  {
    path: 'providers.hetzner.enabled',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Whether Rocky Surf may create servers at Hetzner. Every provider is off until you turn it ' +
      'on, so a fresh install cannot spend money by accident.',
  },
  {
    path: 'providers.hetzner.token',
    kind: 'secret',
    writable: true,
    appliesAt: 'save',
    help:
      'The NAME of an environment variable holding a read/write API token from console.hetzner.com ' +
      '— `HETZNER_TOKEN`, not the token itself. The token is scoped to one project, which is the ' +
      'project every server created here appears in.',
  },
  {
    path: 'providers.hetzner.location',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'Which datacentre new servers are created in: fsn1/nbg1/hel1 (Germany, Finland), ash/hil ' +
      '(US), sin (Singapore). ARM (CAX) types are only sold in fsn1, nbg1 and hel1.',
  },
  {
    path: 'providers.hetzner.consoleProjectId',
    kind: 'number',
    writable: true,
    appliesAt: 'save',
    help:
      'Optional, and used only to put a "View in Hetzner Console" link on a server\'s page. The API ' +
      'never reveals the number, so take it from the console address bar: ' +
      'console.hetzner.com/projects/1234567/servers. Leave it out and servers simply have no link.',
  },

  {
    path: 'providers.aws.enabled',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Whether Rocky Surf may create EC2 instances. Credentials come from the standard AWS chain — ' +
      'environment, named profile, instance role — and never from this file.',
  },
  {
    path: 'providers.aws.region',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'Which AWS region new instances are created in.',
  },
  {
    path: 'providers.aws.profile',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'A named profile from your shared AWS credentials file. Leave it unset to take whatever the ' +
      'default AWS chain resolves to.',
  },
  {
    path: 'providers.aws.sshAllowedCidr',
    kind: 'stringList',
    writable: true,
    appliesAt: 'save',
    help:
      'Which networks may reach SSH on the boxes AWS creates here, as CIDRs — your own address as ' +
      'a /32 is the usual answer, and you can keep several so home and the office both work. ' +
      'Required whenever AWS is enabled, with no default on purpose. Saving pushes the change to ' +
      'AWS straight away; you do not have to launch a server for it to take effect.',
    warning:
      'This is a firewall rule: it decides which networks may reach SSH on every box AWS creates ' +
      'here. Removing a CIDR immediately ends new SSH connections from that network; existing ' +
      'sessions survive.',
  },
  {
    path: 'providers.aws.allowAllCidr',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Confirms that you mean 0.0.0.0/0 in the list above. Opening SSH to the whole internet is two ' +
      'decisions, not one typo, so the CIDR alone is refused without this.',
    warning:
      'Turning this on lets SSH be reachable from the entire internet. These boxes run ' +
      'agent-authored code and hold your git token. Leave it off unless you have another control ' +
      'in front of them.',
  },
  {
    path: 'providers.aws.sizes',
    kind: 'stringList',
    writable: false,
    appliesAt: 'save',
    help:
      'The only instance types this installation will create — on the New Server page and through ' +
      'the API, the CLI and MCP alike. Unset offers everything the region sells; ' +
      't4g.* are ARM (Graviton) and are the cheap, fast default.',
    reason: 'An allowlist of instance types, edited in the file — this page does not surface a list editor for it.',
  },

  {
    path: 'providers.azure.enabled',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Whether Rocky Surf may create Azure virtual machines. Credentials come from the environment, ' +
      'from a managed identity, or from the Azure CLI — and never from this file.',
  },
  {
    path: 'providers.azure.subscriptionId',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'The Azure subscription every VM, disk, network interface and address is created in.',
  },
  {
    path: 'providers.azure.resourceGroup',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The one resource group Rocky Surf owns. You create it — `az group create --name ' +
      'rocky-surf-rg --location eastus` — because a role cannot be scoped to a group that does not ' +
      'exist yet, and the published Azure role is granted at exactly this group.',
  },
  {
    path: 'providers.azure.location',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'Which Azure region new VMs are created in, e.g. eastus.',
  },
  {
    path: 'providers.azure.sshAllowedCidr',
    kind: 'stringList',
    writable: true,
    appliesAt: 'save',
    help:
      'Which networks may reach SSH on the boxes Azure creates here, as CIDRs — your own address as ' +
      'a /32 is the usual answer, and you can keep several so home and the office both work. ' +
      'Required whenever Azure is enabled, with no default on purpose. Saving pushes the change to ' +
      'Azure straight away; you do not have to launch a server for it to take effect.',
    warning:
      'This is a firewall rule: it decides which networks may reach SSH on every box Azure creates ' +
      'here. Removing a CIDR immediately ends new SSH connections from that network; existing ' +
      'sessions survive.',
  },
  {
    path: 'providers.azure.allowAllCidr',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Confirms that you mean 0.0.0.0/0 in the list above. Opening SSH to the whole internet is two ' +
      'decisions, not one typo, so the CIDR alone is refused without this.',
    warning:
      'Turning this on lets SSH be reachable from the entire internet. These boxes run ' +
      'agent-authored code and hold your git token. Leave it off unless you have another control ' +
      'in front of them.',
  },
  {
    path: 'providers.azure.sizes',
    kind: 'stringList',
    writable: false,
    appliesAt: 'save',
    help:
      'The only VM sizes this installation will create — on the New Server page and through the ' +
      'API, the CLI and MCP alike. Unset offers everything the region sells; the ' +
      'sizes with a `p` in them (B2ps_v2, D2ps_v5) are ARM (Ampere) and are the cheap, fast default.',
    reason: 'An allowlist of VM sizes, edited in the file — this page does not surface a list editor for it.',
  },

  {
    path: 'providers.gcp.enabled',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Whether Rocky Surf may create Compute Engine instances. Credentials come from Application ' +
      'Default Credentials — the same chain `gcloud` uses — and never from this file.',
  },
  {
    path: 'providers.gcp.projectId',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The project every instance lives in. Required whenever GCP is enabled, and never inferred: ' +
      'a Google credential can be valid for many projects and names none of them, so a guess here ' +
      'would create billable machines in a project you did not pick.',
  },
  {
    path: 'providers.gcp.zone',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The single zone new instances are created in. The default is us-central1-a rather than -c, ' +
      'deliberately — arm64 (Tau T2A) exists in only eight zones, and us-central1-c is not one of ' +
      'them.',
  },
  {
    path: 'providers.gcp.sshAllowedCidr',
    kind: 'stringList',
    writable: true,
    appliesAt: 'save',
    help:
      'Which networks may reach SSH on the boxes GCP creates here, as CIDRs — your own address as ' +
      'a /32 is the usual answer, and you can keep several so home and the office both work. ' +
      'Required whenever GCP is enabled, with no default on purpose. Saving pushes the change to ' +
      'GCP straight away; you do not have to launch a server for it to take effect.',
    warning:
      'This is a firewall rule: it decides which networks may reach SSH on every box GCP creates ' +
      'here. Removing a CIDR immediately ends new SSH connections from that network; existing ' +
      'sessions survive.',
  },
  {
    path: 'providers.gcp.allowAllCidr',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Confirms that you mean 0.0.0.0/0 in the list above. Opening SSH to the whole internet is two ' +
      'decisions, not one typo, so the CIDR alone is refused without this.',
    warning:
      'Turning this on lets SSH be reachable from the entire internet. These boxes run ' +
      'agent-authored code and hold your git token. Leave it off unless you have another control ' +
      'in front of them.',
  },
  {
    path: 'providers.gcp.sizes',
    kind: 'stringList',
    writable: false,
    appliesAt: 'save',
    help:
      'The only machine types this installation will create — on the New Server page and through ' +
      'the API, the CLI and MCP alike. Unset offers everything the zone sells; ' +
      't2a-standard-* and c4a-standard-* are both ARM, in different zones — see docs/providers/gcp.md ' +
      'for which one your zone actually has.',
    reason: 'An allowlist of machine types, edited in the file — this page does not surface a list editor for it.',
  },

  {
    path: 'providers.byo.enabled',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Whether machines you already own can be managed over SSH. No cloud API and no provisioning — ' +
      'Rocky Surf installs onto them and manages them from there.',
  },
  {
    path: 'providers.byo.identityFile',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'A path to the private key used to log in to every host below — never the key itself, which ' +
      'stays where your own SSH keeps it. Leave it unset to use your SSH agent: if you can already ' +
      '`ssh` to these machines, that is usually enough.',
  },
  {
    path: 'providers.byo.hosts.*.name',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'What you will call this machine in the UI. It is also how a new server picks the host.',
  },
  {
    path: 'providers.byo.hosts.*.host',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'The hostname or IP address Rocky Surf connects to.',
  },
  {
    path: 'providers.byo.hosts.*.user',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'The admin login Rocky Surf claims the machine with; it needs root or passwordless sudo. This ' +
      'is not the account it later connects as — that one is `rocky`, and it is created for you.',
  },
  {
    path: 'providers.byo.hosts.*.port',
    kind: 'number',
    writable: true,
    appliesAt: 'save',
    help: 'The SSH port, when it is not 22.',
  },
  {
    path: 'providers.byo.hosts.*.fingerprint',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'Optional host key fingerprint, from `ssh-keyscan` piped through `ssh-keygen -lf`. Supplying it ' +
      'means even the first connection is verified; omit it to trust the key on first connect.',
  },
  /**
   * A PATH, never key material — the schema says so at its declaration and it is worth
   * repeating here, because it is the one field in this file that could be mistaken for a
   * secret. The key stays where the operator's own SSH keeps it.
   */
  {
    path: 'providers.byo.hosts.*.identityFile',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'A private key for this machine alone, overriding the default above. A path, never the key itself.',
  },

  /* -------------------------------------------------------------------------- limits */
  {
    path: 'limits.maxServers',
    kind: 'number',
    writable: true,
    appliesAt: 'save',
    help:
      'The most servers that may exist at once. Enforced server-side, which is what makes it safe to ' +
      'let an agent create its own boxes through the MCP server.',
  },
  {
    path: 'limits.createRatePerHour',
    kind: 'number',
    writable: true,
    appliesAt: 'save',
    help: 'The most servers that may be created per hour. Blunts terminate-and-recreate loops.',
  },
  /** Written and removed as a whole — half a spend cap is not a smaller spend cap. */
  {
    path: 'limits.spendCap',
    kind: 'group',
    writable: true,
    appliesAt: 'save',
    help:
      'Stop creating servers once the running cost estimate passes a figure. Turning it off removes ' +
      'the cap from the file entirely rather than setting it to zero.',
  },
  {
    path: 'limits.spendCap.amount',
    kind: 'number',
    writable: true,
    appliesAt: 'save',
    help: 'The figure the running estimate may not pass.',
  },
  {
    path: 'limits.spendCap.currency',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'An ISO 4217 code — providers do not all quote in USD.',
  },

  /* ------------------------------------------------------------------------ registry */
  /**
   * WHERE PACKS MAY COME FROM, edited here since issue #88.
   *
   * The list was config-file-only, on the reasoning that a source is a thing an operator should
   * have to write down. Editing it here IS writing it down: the page is admin-only, it writes
   * the same file, and it writes the value an operator would have typed. What issue #88 asked
   * for is a person's OWN packs — a single YAML file they published, or a directory of them —
   * and telling them to ssh in and hand-edit YAML for that was the whole of the gap.
   *
   * NOTHING IS FETCHED BY A SAVE. Adding a source records a URL. The packs behind it arrive
   * only when an admin opens Surge Packs, reads every script the disclosure shows them, and
   * installs one. That ordering is the security property, and it is why a URL box here is not
   * a remote-code-execution button.
   */
  {
    path: 'registry.enabled',
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Whether Rocky Surf browses pack sources at all. Off is the air-gapped setting: the shop says ' +
      'it is switched off, and packs that shipped with your release or were imported here are ' +
      'unaffected. Nothing is fetched at startup either way.',
  },
  {
    path: 'registry.sources.*.name',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help: 'What you will call this source in the UI. It is also how an installed pack is attributed.',
  },
  {
    path: 'registry.sources.*.url',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      'An https URL. Ending in `.yaml` means the URL IS one pack — how you publish your own; ' +
      'anything else is a directory serving `index.json` beside its pack files, the way the shop ' +
      'does. Public hosts only: an address on your own network is refused.',
    warning:
      'A pack is install scripts, and they run as ROOT on every box you create with it. Add a ' +
      'source only if you would run its scripts by hand, and read them in the shop before you ' +
      'install: Rocky Surf shows you every one, verbatim, and never runs anything on its own.',
  },
  {
    path: 'registry.sources.*.trust',
    kind: 'string',
    writable: true,
    appliesAt: 'save',
    help:
      "Your own label for this source — `community` or `internal`. It is the only place a source's " +
      'trustworthiness is recorded, deliberately not something the source itself publishes. There is ' +
      'no `official`: that means "shipped in the Rocky Surf release", which nothing you add here is.',
  },
  {
    path: 'registry.cacheTtlSeconds',
    kind: 'number',
    writable: true,
    appliesAt: 'save',
    help:
      'How long a fetched listing is reused before the shop refetches it. The Refresh button ignores ' +
      'it, so this is about not hammering a host while somebody browses, not about how fresh a pack ' +
      'you can get.',
  },

  /* --------------------------------------------------------------------- preferences */
  ...TIER_PREFERENCE_FIELDS,

  /* ----------------------------------------------------------------------------- mcp */
  {
    path: 'mcp.scopes',
    kind: 'stringList',
    writable: true,
    appliesAt: 'restart',
    restartReason:
      'The MCP server is a separate process — the one your MCP client starts with `rockysurf ' +
      'mcp` — and it reads this list when it starts. Rocky Surf itself needs no restart; the MCP ' +
      'client does, so reconnect it (in Claude Code, restart the session) to pick this up.',
    help:
      'What an MCP client connected to this instance may do on your behalf. `read` and `stop` are ' +
      'the default pair — `stop` covers starting a stopped box again as well as stopping a ' +
      'running one, because pausing spend and resuming it are one decision; the other two are ' +
      'granted deliberately. An agent that reports having no create_server tool is reporting this ' +
      'box being unticked: the tool exists, and a scope this list withholds is not offered to the ' +
      'client at all.',
    warning:
      'What an MCP client may do on your behalf. `create` spends money and `terminate` destroys a ' +
      'box an agent may be mid-task on; neither is recoverable by undo.',
  },
] as const

/**
 * The page's sections, in the order it draws them.
 *
 * `id` is the config path the section covers, so a section is answerable to the file the way a
 * field is. `github` covers `pat` and `tokens` together, which is the whole of directive 2: they
 * are one subject, and the page had been drawing them as two.
 */
export const SETTINGS_SECTIONS: readonly SectionSpec[] = [
  {
    id: 'server',
    title: 'Server',
    help: 'Where Rocky Surf itself listens, and where it keeps everything it knows.',
  },
  {
    id: 'github',
    title: 'GitHub access tokens',
    help:
      'Tokens for cloning private repositories onto your boxes. The most specific entry matching a ' +
      'clone URL wins — one repository, then an account, then a forge, then the entry with no scope, ' +
      'which covers everything else. Every entry is instance-wide: scoping one narrows what it is ' +
      'used FOR, not who receives it.',
  },
  /**
   * A TAB, with its keys as a card on it — the nesting `registry`/`registry.sources` uses, for
   * the same reason: there is one subject here, and the list is what the subject consists of.
   */
  {
    id: 'ssh',
    title: 'SSH public keys',
    help:
      'Public keys you reuse, saved by name so the New Server page can offer them instead of you ' +
      'fetching a `.pub` file every time. Saving one here changes nothing on any box that already ' +
      'exists, and you can still paste a key on the New Server page without saving it.',
  },
  {
    id: 'ssh.keys',
    title: 'Your public keys',
    help:
      'Each one is a name and the PUBLIC half of a keypair — never the private half. Removing a key ' +
      'here does not remove it from boxes it was already authorized on; those you change over SSH.',
  },
  {
    id: 'providers.hetzner',
    title: 'Hetzner',
    help: 'The quickest provider to start with: an API token from console.hetzner.com is the whole setup.',
  },
  {
    id: 'providers.aws',
    title: 'AWS',
    help:
      'EC2 instances in one region. Credentials come from the standard AWS chain — environment, ' +
      'named profile, instance role — so there is no credential to type here.',
  },
  {
    id: 'providers.azure',
    title: 'Azure',
    help:
      'Virtual machines in one Azure region, in one resource group you create. Credentials come from ' +
      'the environment, a managed identity, or `az login`, so there is no credential to type here.',
  },
  {
    id: 'providers.gcp',
    title: 'Google Cloud',
    help:
      'Compute Engine instances in one zone, in one project you name. Credentials come from ' +
      'Application Default Credentials — the same chain `gcloud` uses — so there is no credential ' +
      'to type here.',
  },
  {
    id: 'providers.byo',
    title: 'Your own machines',
    help:
      'Machines you already have, managed over SSH. Claiming one creates a `rocky` account on it with ' +
      'passwordless sudo; releasing it hands it back to the pool and undoes nothing on your machine.',
  },
  {
    id: 'providers.byo.hosts',
    title: 'Hosts',
    help: 'The machines Rocky Surf may claim. Enabling the provider above requires at least one.',
  },
  {
    id: 'limits',
    title: 'Limits',
    help:
      'Guardrails, enforced server-side. They are what makes it safe to let an agent create its own ' +
      'boxes through the MCP server.',
  },
  /**
   * A TAB PER SUBJECT, and this one nests (issue #124): `preferences` is the tab, and each
   * cloud below it is a card on that tab, the same way `providers.byo.hosts` is a card on Your
   * own machines. The page derives all of that from these ids alone — the longest id prefixing
   * a field's path owns the field — so no edit to `SettingsPage.tsx` was needed to add any of
   * it, which is the property issue #122 built and this section is the first user of.
   */
  {
    id: 'preferences',
    title: 'Preferences',
    help:
      'Your own answers, remembered. Small, medium and large are floors — the cheapest machine ' +
      'that meets them — until you name the type you actually want, and then that is what you ' +
      'get every time. A saved type applies to the very next server you create.',
  },
  ...TIER_PREFERENCE_CLOUDS.map((cloud) => ({
    id: `preferences.tiers.${cloud.id}`,
    title: cloud.label === 'your own machines' ? 'Your own machines' : cloud.label,
    help:
      `Which ${cloud.noun} each size means on ${cloud.label}. Blank is the default: the cheapest ` +
      `one available that meets the size's floor. A saved ${cloud.noun} that is sold out, ` +
      `quota-refused or no longer offered falls back to that default, and the New Server page ` +
      `says which and why rather than substituting in silence.`,
  })),
  /**
   * A TAB, and its sources are a card on it — the same nesting `providers.byo.hosts` uses, for
   * the same reason: switching the shop on and saying what it points at are one errand.
   */
  {
    id: 'registry',
    title: 'Pack sources',
    help:
      'Where Surge Packs may come from, besides the ones that shipped with your release. A source ' +
      'is one pack file you published, or a directory of them like the community shop. Nothing is ' +
      'fetched until an admin opens Surge Packs, and nothing installs until they have read the ' +
      'scripts it would run as root.',
  },
  {
    id: 'registry.sources',
    title: 'Sources',
    help:
      'The sources this instance browses, in order. Removing one does not remove packs already ' +
      'installed from it — those are yours until you delete them on the Surge Packs page.',
  },
  {
    id: 'mcp',
    title: 'MCP',
    help: 'What an MCP client may do through this instance once it holds a token.',
  },
  /**
   * THE ONE SECTION ID THAT IS NOT A CONFIG PATH (issue #331). Backup and Restore act on the
   * whole installation, not on a field of the file, so no field's path will ever map to this
   * tab — the SPA hand-writes its two cards, the way the Connect GitHub card is hand-written
   * on the `github` tab. It is declared HERE all the same, because the page's rule 1 is that
   * the navigation is the server's inventory, and a tab smuggled in client-side would be the
   * first one core could not see.
   */
  {
    id: 'backup',
    title: 'Backup',
    help:
      'Everything Rocky Surf knows lives on this machine — there is no cloud copy. A backup is ' +
      'one file you keep wherever you keep files; Restore reads it back on your next machine.',
  },
] as const

/**
 * Lists the editor can add to and remove from, and the shape of a new entry.
 *
 * A list is not a field: adding one is an append, removing one deletes the entry AND any
 * comment written above it, which is the one place a GUI save cannot preserve what the file
 * said. That is inherent — the comment described the thing being removed — and it is stated
 * in the UI rather than worked around.
 *
 * `add` IS PART OF THE INVENTORY, and it is here rather than in the SPA because half of it is a
 * claim about the SCHEMA (issue #302 follow-up, reshaped by rsui-9sc). The page's Add button
 * reveals a BLANK form — nothing is written until the operator has typed the entry and pressed
 * its own save. That is the owner's ruling on this flow: no entry appears before the person
 * asked for one, and no entry ever carries a name the person did not choose. What core still
 * has to declare is what that form asks for: `example` supplies the greyed placeholder in each
 * box, and `required` names the fields the form insists on before it will send anything.
 * `fields.test.ts` parses every `example` through the schema, so a placeholder that would
 * mislead — an example URL the schema refuses, a name it will not take — fails the build
 * instead of the operator.
 *
 * `labelField` names the item field that titles a card — the one an operator recognises the
 * entry by. Defaults to the first of `itemFields`.
 */
export interface ListSpec {
  path: string
  itemFields: readonly string[]
  /**
   * How a new entry is collected: the noun on the Add button, placeholder values for the blank
   * form it reveals, and the fields that form requires — the page's whole ability to offer Add
   * for a list it has never heard of.
   *
   * `example` is a complete entry the config schema accepts. It is never written by itself —
   * it exists to be shown greyed in the form's boxes, and keeping it schema-valid keeps the
   * placeholders honest. An empty-string example means "no placeholder for this box"; the
   * field's own help does the explaining.
   *
   * ABSENT means this list is not added to generically, and `github.tokens` is the only one:
   * every shape of entry it takes needs a token, a token cannot be invented as a placeholder,
   * and it has a bespoke card that collects one before writing anything. A list with no `add`
   * still renders its entries generically; it just does not offer Add.
   */
  add?: Readonly<{
    /** The singular the buttons speak — "Add key", "Add this key". */
    noun: string
    example: Readonly<Record<string, string | number | boolean>>
    /** Item fields the new-entry form refuses to send empty, with the reason said in words. */
    required: readonly string[]
  }>
  labelField?: string
  /** Shown in place of the list when it is empty. */
  empty: string
}

export const SETTINGS_LISTS: readonly ListSpec[] = [
  {
    path: 'github.tokens',
    itemFields: ['host', 'owner', 'repo', 'pat'],
    labelField: 'owner',
    empty: 'None yet. The token above covers everything unmatched; add one to narrow a token to an account or a repository.',
  },
  {
    path: 'ssh.keys',
    itemFields: ['name', 'publicKey'],
    // Both fields required: a key with no name cannot be chosen on the New Server page, and a
    // name with no key is the phantom card the owner reported (rsui-9sc). The publicKey example
    // is deliberately empty — a plausible-looking placeholder key would either be refused by
    // the schema or be a real key somebody else holds the other half of.
    add: { noun: 'key', example: { name: 'my-laptop', publicKey: '' }, required: ['name', 'publicKey'] },
    labelField: 'name',
    empty:
      'None yet. Add one and the New Server page will offer it — you can still paste a key there ' +
      'without saving it here.',
  },
  {
    path: 'providers.byo.hosts',
    itemFields: ['name', 'host', 'user', 'port', 'fingerprint', 'identityFile'],
    // `user` and `port` have schema defaults and the rest are optional, so the form only
    // insists on the two things a host cannot be reached without.
    add: { noun: 'host', example: { name: 'build-box', host: '10.0.0.1' }, required: ['name', 'host'] },
    labelField: 'name',
    empty: 'None yet. Enabling this provider requires at least one host.',
  },
  {
    path: 'registry.sources',
    itemFields: ['name', 'url', 'trust'],
    // `trust` is not required: left blank it is omitted, and the schema defaults it to
    // `community` — the label an operator has to opt out of, never into.
    add: {
      noun: 'source',
      example: { name: 'my-packs', url: 'https://example.com/my-pack.yaml', trust: 'community' },
      required: ['name', 'url'],
    },
    labelField: 'name',
    empty:
      "None yet. Add one to browse somebody else's packs — or your own, published as a single " +
      'YAML file at an https URL.',
  },
] as const

/**
 * Key names that hold a credential wherever they appear.
 *
 * The backstop for what the inventory above cannot know about: a key the schema never declared,
 * which is the state a config file is in when it names a provider from a branch that has not
 * merged, or a field added after this build shipped. `providers.newcloud.token` is masked on
 * the strength of its name alone, and the operator's file is still shown to them so they can
 * see what is wrong with it.
 *
 * NAMES, NOT VALUE PATTERNS. A pattern over values would mask whatever happened to look like a
 * credential and miss whatever did not, which is a guess in both directions. The camelCase half
 * catches `apiToken` and `adminPassword` while leaving `sshPublicKey` and `identityFile` alone —
 * the latter is a path to a key, and masking it would hide a field an operator has to be able
 * to read.
 */
const SECRET_KEY_NAME = /^(token|pat|password|secret|apikey)$|[a-z0-9](Token|Pat|Password|Secret|ApiKey)$/

export function isSecretKeyName(name: string): boolean {
  return SECRET_KEY_NAME.test(name)
}

/**
 * Every path that needs a restart before it is used, `*` intact (issue #264).
 *
 * Derived from the inventory rather than written a second time, so the list cannot fall behind
 * the field entries the page renders from.
 */
export const RESTART_REQUIRED_PATHS: readonly string[] = SETTINGS_FIELDS.filter(
  (f) => f.appliesAt === 'restart',
).map((f) => f.path)

/** Every secret-classified path in the inventory, `*` intact. */
export const SECRET_FIELD_PATHS: readonly string[] = SETTINGS_FIELDS.filter((f) => f.kind === 'secret').map(
  (f) => f.path,
)

/** A concrete document path (`['github','tokens',0,'pat']`) as an inventory path. */
export function patternOf(path: readonly (string | number)[]): string {
  return path.map((segment) => (typeof segment === 'number' ? '*' : segment)).join('.')
}

/** The spec for a concrete document path, or undefined when the editor does not know it. */
export function specFor(path: readonly (string | number)[]): FieldSpec | undefined {
  const pattern = patternOf(path)
  return SETTINGS_FIELDS.find((f) => f.path === pattern)
}

/** True when this path — or the key at its tip — holds a credential. */
export function isSecretPath(path: readonly (string | number)[]): boolean {
  if (specFor(path)?.kind === 'secret') return true
  const tip = path[path.length - 1]
  return typeof tip === 'string' && isSecretKeyName(tip)
}
