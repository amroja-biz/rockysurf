# SSH access: the whitelist that has to reach the cloud

Read this when the cloud has any firewall model at all. It is the part of the contract the skill
used to leave out entirely, and the omission was the most consequential in the document: a provider
built without it reintroduces, for a fourth cloud, the defect ADR-0021 fixed for three.

## The defect, so you recognise it

Until ADR-0021 (issue #304), the ONLY thing that ever wrote `sshAllowedCidr` to a cloud was
`provision()`. The setting applied on save (ADR-0017), the Settings page said "applied", and the
security group, the NSG rule and the firewall rule went on enforcing whatever the last launch had
written. An operator who moved from home to a cafe edited the value, was told it took effect, and
could not SSH to anything. AWS had latched the write for the life of the process; Azure re-wrote on
the next launch; GCP wrote `sourceRanges` at create time and **never again**.

"Rewrite the rule on every provision" — the old trap 5 — is not the fix. It makes the whitelist true
at the next launch, which is the Azure failure exactly. The fix is a way for core to push the saved
list at the cloud without launching anything.

## The shape

Three pieces, and they are one claim checked in both directions by conformance:

1. **`capabilities.managesSshAccess: true`** — the provider maintains a shared cloud object that
   decides which networks may reach SSH, and can bring it in line with its own `sshAllowedCidr`
   without provisioning. Absent means false (Hetzner has no whitelist object; BYO does not own the
   network).
2. **`syncSshAccess(options?): Promise<SshAccessSyncResult>`** — the one OPTIONAL method on the
   interface. REQUIRED when the flag is true, absent otherwise; `assertProviderShape` fails on
   either mismatch. It takes **no CIDR list**: the provider reads its own config, which after a
   settings save is the one the operator approved. Handing it a list would be a second source of
   truth for the one value this exists to make authoritative. `options.revoke` is the only argument:
   extras the operator confirmed for removal at the keep-or-remove prompt (issue #309).
3. **`sshAllowedCidr` is a LIST** in the config. A bare string is a list of one; an empty list is
   refused by the schema (a whitelist allowing nothing is a lockout dressed as a setting);
   `0.0.0.0/0` anywhere in it still requires `allowAllCidr: true`. Normalize with
   `normalizeSshCidrs` from the SDK (trim, drop blanks, fold EXACT duplicates only — overlapping
   ranges are deliberately never collapsed) and gate with `opensSshToTheInternet`. Both helpers
   are in the SDK precisely so every provider agrees character for character.

`SshAccessSyncResult` is `{ status, applied, reported, removable?, detail }`:

- `status`: `updated` (the object did not match and now does), `unchanged` (it already matched — a
  first-class answer, because "did my earlier save land" is the question being asked), `skipped`
  (nothing attempted, `detail` says why — the shared object does not exist yet, or a config reload
  did not take), `failed` (the cloud refused; `detail` carries the remediation).
- `applied`: the CIDRs the cloud allows now. Empty on `skipped`/`failed`.
- `reported`: ranges on the object the provider deliberately did NOT touch — anything it cannot prove
  it created, surfaced with the command that removes it by hand.
- `removable`: the subset of `reported` the provider CAN revoke if the operator confirms — the
  stamped extras a keep-or-remove prompt offers, DEFAULT KEEP.
- `detail`: one or two plain sentences for a human. Never a raw provider error.

## The rules every implementation follows

- **Never create the shared object from a sync** — report `skipped`. A settings save must not create
  billable cloud objects in an account nobody has launched into.
- **Never delete it, and never delete-and-recreate it.** It is `ownership: 'shared'` (ADR-0003 D1);
  removing it cuts SSH to every box in the account at once, including the operator's own.
- **Provision is ADDITIVE and never revokes.** Every configured CIDR is authorized on every launch.
- **Only remove what you can prove you created, and only what `options.revoke` names.** Everything
  else goes in `reported` with the manual command.
- **Authorize before revoke**, so a sync that dies half-way leaves MORE access than it found, never
  less. That is the anti-lockout floor, and no shortcut is worth weakening it.
- **Own your deadline** (the shipped REST clients hold 30 seconds), so one unreachable cloud cannot
  hang the caller; return `failed` with "I do not know" rather than "applied".
- **Skip when the file and the process disagree** — core does this for you at the route
  (`network/routes.ts`): if the config file says one list and this process is running another, the
  provider was built from the older one and a push would undo the operator's last save at the
  firewall.

## Proof of authorship: two shapes, and which one your cloud is

The rules above turn on one question from the research protocol: **can a RULE carry proof of who
wrote it?**

**Per-rule authorship** (AWS, GCP). A security-group ingress entry has a description; a GCE firewall
rule has one. Rocky Surf stamps its own — `rockysurf sshAllowedCidr` on AWS; the description it
writes at create time on GCP — and touches only entries carrying the stamp. Anything unstamped is
the operator's or an older release's, and is reported, never revoked. Converging to exactly the
list means revoking stamped extras the operator confirmed (issue #309).

**Whole-object authorship** (Azure, and **DigitalOcean**). An Azure NSG child rule
`securityRules/rockysurf-ssh` is rewritten whole with `sourceAddressPrefixes`; a DigitalOcean
firewall inbound rule is `{ protocol, ports, sources }` with **no description or name field at all**,
so per-CIDR authorship is unprovable. **The ruling (ADR-0021, amended for issue #294's gap S2):
authorship belongs to the whole firewall object Rocky Surf created and named.** Converge it in one
write to exactly the configured list; `removable` is always empty and `reported` is always empty,
because there is no stamped extra to offer and no unstamped entry to keep — the object is Rocky
Surf's by construction, or it is not touched. Azure is the shape to copy. The operator's protection
against surprise is that the object is created ONLY by a launch, is named for Rocky Surf, and holds
only SSH; a firewall the operator made themselves is never the one Rocky Surf converges.

Which shape you are does not change anti-lockout: provision additive, revoke only under explicit
confirmation, authorize before revoke.

## The Settings control

Declare the field as `kind: 'sshCidrList'` in `settings` (ADR-0027). That one kind is the two-act
guard: the page draws the list with its Add box, the last-entry lock, the `0.0.0.0/0` confirmation
and the `allowAllCidr` checkbox that appears only once the dangerous value is in the list. Do not
declare `allowAllCidr` yourself — the list implies it. Conformance refuses an `sshCidrList` on a
provider without `managesSshAccess`, because a firewall editor whose saves land in a file and
nowhere else is the defect at the top of this page, with a nicer control on it.

After a save, core reports which clouds are now stale (`networkSyncNeeded`) and the SPA calls the
sync route; the "Push SSH access to the clouds" button calls it for every capable cloud at once,
which is what repairs a cloud that drifted while the file stayed the same.

## What to write in the README

Under "Who can reach SSH": that the list is required with no default and why; that saving it pushes
it; which authorship shape the cloud has and therefore whether removing a CIDR takes effect in one
step (whole-object) or via the keep-or-remove prompt (per-rule); and which permission the sync
needs, if the cloud has a role model.
