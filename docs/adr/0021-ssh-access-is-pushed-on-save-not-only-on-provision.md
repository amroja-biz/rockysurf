# ADR-0021: `sshAllowedCidr` is a list, and saving it pushes it at the clouds that enforce it

## Status

Accepted — 2026-09-01. Issue #304. **Amends [ADR-0003](0003-provider-sdk-shape-and-exclusions.md)
amendment E11**, which rejected an `ensureAccess()` method for v0.1 and said "Revisit if a second
provider needs the same call" — this is that revisit. **Amends
[ADR-0017](0017-settings-apply-on-save.md)** by settling what `appliesAt: 'save'` means for a
field whose consumer lives outside this process; the label on `sshAllowedCidr` does not move.

## Context

`sshAllowedCidr` is the operator's own network, written down in the config file because a firewall
rule is a security decision that belongs somewhere reviewable (the ruling is in
`docs/providers/aws.md`, "Who can reach SSH", and in `SECURITY.md`). It is required on AWS, Azure
and GCP, has no default, and none is inferred.

Until this ADR, **the only thing that ever wrote it to a cloud was `provision()`.** That was not a
gap in the documentation; it was a gap between the documentation and the product, and the three
clouds failed it three different ways:

- **AWS** authorized the CIDR inside `ensureSecurityGroup()`, behind an `ingressEnsured` flag set
  for the **lifetime of the process**. So a corrected CIDR did not reach EC2 on the next launch
  either — it took a restart. The latch bought one skipped API call per boot.
- **Azure** PUT its `securityRules/rockysurf-ssh` child resource unconditionally on every
  provision, so the setting did take effect — at the next launch, and not before.
- **GCP** was the worst. `sourceRanges` was written at create time and **never again**: a
  `firewallEnsured` latch, and beneath it a GET that returned early whenever the rule existed. A
  changed `sshAllowedCidr` had no effect for the life of the rule, on any launch, after any
  restart. The only remedy was `gcloud compute firewall-rules update` by hand.

The operator this hurts is the one who moves — home to office, office to a cafe, a new ISP lease.
Their laptop's address changes, every Rocky Surf box on three clouds stops accepting new SSH
connections, and the Settings page tells them the change they just made has been applied. It had
been applied to the file. It had not been applied to the firewall.

Two further facts shaped the decision rather than merely motivating it. The first is that
`sshAllowedCidr` was a **single string**, so "add the network I am on now" meant "lose the one I
was on before" — which is how an operator who works from two places ends up reaching for
`0.0.0.0/0`, the exact outcome the two-act guard around that value exists to discourage. The
second is that ADR-0003 E11 already considered giving core a way to refresh its own access and
rejected it, on a reason that has since expired: *"Adding an interface method to solve one
provider's problem, with no second implementation to generalize from, is the same premature
generality this ADR rejects … Revisit if a second provider needs the same call."* Three providers
need it.

## Decision

1. **`sshAllowedCidr` is a list of CIDRs** on `aws`, `azure` and `gcp`. A bare string is still
   accepted and read as a list of one, so no existing config file changes meaning or stops
   loading. An **empty list is refused by the schema** rather than quietly meaning "nobody": a
   whitelist allowing nothing produces boxes nobody can reach, which is a lockout dressed as a
   setting.
2. **The two-act guard is unchanged, and it reads the whole list.** `0.0.0.0/0` in **any**
   position still requires `allowAllCidr: true`. A list of five careful office ranges with a `/0`
   appended is open to the entire internet, and hiding the guard behind "the list is exactly
   `[/0]`" would let the dangerous value in through the door the guard is standing at.
3. **Exact duplicates are folded away; overlapping ranges are never collapsed.** It is tempting to
   notice that `203.0.113.7/32` sits inside `203.0.113.0/24` and merge them, and it would be
   wrong: the two entries mean different things to the person maintaining the file — the wide one
   is the office, the narrow one is that laptop at the office — and an operator who later removes
   the office range expects to keep their laptop. Collapsing also makes removal lossy in a way no
   UI can explain, because the entry the operator clicks remove on is not the entry that
   disappears.
4. **A new capability, `ProviderCapabilities.managesSshAccess`.** Optional; absent means `false`.
   `true` on `aws`, `azure` and `gcp`; absent on `hetzner` (no whitelist object of any kind exists
   to bring into line) and on `byo` (the machine and its network are already the operator's).
5. **A new OPTIONAL interface method, `syncSshAccess(): Promise<SshAccessSyncResult>`, taking no
   arguments.** The provider reads its **own** configuration. Passing a CIDR list in would create
   a second source of truth for the one value this whole change exists to make authoritative, and
   would let core push a list a provider had never been built with. The result is
   `{ status: 'updated' | 'unchanged' | 'skipped' | 'failed', applied, reported, detail }`;
   `unchanged` is a first-class answer rather than a hidden no-op, because "did my earlier save
   actually land" is the question the operator is usually asking.
6. **`POST /api/v1/network/ssh-access/sync`, admin-only, provisions nothing.** It pushes the list
   at every cloud whose capability flag is true, and reports per cloud. It is selected by the
   **flag**, never by `typeof provider.syncSshAccess === 'function'` — see clause 10.
7. **The settings PUT stays pure.** It writes the file, adopts it, and returns
   `networkSyncNeeded: [providerIds]`; the SPA makes the second call when that list is non-empty,
   and renders the per-cloud report under "SSH access at the cloud". `rockysurf network sync` is
   the CLI equivalent.
8. **The push is ALSO offered as a button, and that is not redundant with the save.**
   `Push SSH access to the clouds`, in the Settings page footer, calls the same route for every
   capable cloud at once and is enabled whether or not there are unsaved edits. The automatic push only
   ever carries what a save changed, and **the state this issue was reported from is a cloud that
   drifted while the config file stayed exactly as it was** — GCP's `sourceRanges`, frozen at
   create time, ignoring the setting for the life of the rule. Nothing in a save fixes that,
   because nothing about it is a change. Without the button that repair would be reachable only
   from the CLI, which is the wrong answer for a setting whose home is a web page. A save is local, cheap and
   atomic, and ADR-0017 leans on all three.
9. **The sync route SKIPS a provider whose config file and running process disagree**, with an
   explanation, rather than making a best effort. If the file says one thing and this process is
   running another, the provider in the registry was built from the **older** value — so syncing
   would write the CIDRs the operator had *before* their last save, quietly undoing it at the
   firewall while the page showed the new ones. The route therefore can never push a CIDR the
   process has not adopted.
10. **Core still branches on the flag, never on the method's presence.** ADR-0003 A2's rule is
    kept: `capabilities.*` is the only thing core is allowed to see, and a
    `typeof provider.x === 'function'` check would be a second vocabulary for the same fact, one
    the capability matrix could not describe.
11. **The method is OPTIONAL, which deliberately departs from A2's own precedent.** A2 made
    `stop`/`start` **required** methods that throw when their capability is false, and openly
    priced that as "boilerplate for providers that cannot stop". That price is different now than
    it was at the freeze: a required method is a **breaking change for a provider written outside
    this repository**, while a capability nobody declares costs its author nothing at all. The
    property A2 was protecting is clause 10's, and clause 10 holds either way. So the flag stays
    mandatory reading and the method becomes the first optional one on the interface.
12. **AWS provisions additively, and syncs without revoking.** The `ingressEnsured` latch is
    deleted and every configured CIDR is authorized on every provision (one call per range: EC2
    rejects a whole request containing one duplicate). `syncSshAccess()` authorizes what is
    missing and **reports** what is extra. It will only ever consider removing a range stamped
    with its own description, `rockysurf sshAllowedCidr`; anything else — operator-added, or left
    by a release older than the stamp — is reported with the exact
    `aws ec2 revoke-security-group-ingress` command that would remove it. **No new AWS IAM
    permission is needed**: Describe and Authorize were already granted, and nothing revokes.
13. **Azure is unchanged in spirit.** Still a **child-resource PUT** of
    `securityRules/rockysurf-ssh`, never a PUT of the parent NSG, which would replace its
    `securityRules` array and silently delete rules the operator added. Multi-entry lists use
    `sourceAddressPrefixes`, single entries keep `sourceAddressPrefix` — ARM accepts exactly one
    of the two — so a one-CIDR installation's NSG does not churn on upgrade. Because the whole
    rule is written every time, **Azure is the only cloud where removing a CIDR takes effect in
    one step**, and its `reported` list is always empty. The sync skips only when the **group** is
    absent; a missing rule on an existing group is simply created by the same PUT. **No new Azure
    permission**: `securityRules/write` was already granted.
14. **GCP uses `compute.firewalls.patch`, gated on the description, and widens only.** The
    `firewallEnsured` latch is deleted. The patch is issued only against a rule whose
    **description** matches the one Rocky Surf writes at create time — the name is configuration
    and proves nothing about authorship — and it sends **only `sourceRanges`**, so changing who
    may connect cannot re-assert the network, the tags or the ports as a side effect. A rule
    carrying any other description is left exactly as found and reported as **`failed`**, not
    `skipped`: the operator asked for their list to be in force, it is not, and `skipped` would be
    the second time this setting told somebody it had applied when it had not. The ranges written
    are **the operator's list plus any extras already on the rule**, which are kept and reported
    with the `gcloud` command that removes them — see "Deliberately unresolved". It **never
    deletes** and never delete-and-recreates: the rule is `ownership: 'shared'` (ADR-0003 D1) and
    deleting it cuts SSH to every box in the project at once. This is the one new permission in
    the release: `compute.firewalls.update` in `deploy/gcp/rockysurf-role.yaml` and in
    `docs/providers/gcp.md`, taking that list from 22 to 23. A 403 is a **`failed`** result naming
    that permission and carrying the exact `gcloud compute firewall-rules update` remediation.
15. **`sshAllowedCidr` keeps `appliesAt: 'save'`.** See "Amending ADR-0017", below.

## Amending ADR-0003 E11

E11 asked for "a way for core to refresh its own access" and was rejected for v0.1 with the
condition for revisiting written into it. Both halves of the rejection are worth restating,
because only one of them has expired.

**What expired:** "no second implementation to generalize from". There are three. AWS, Azure and
GCP each maintain a shared, long-lived object whose contents are exactly this setting, each of
them is wrong in the same way for the same reason, and the shape that fixes one fixes all three.
That is precisely the evidence E11 said it was waiting for.

**What did not expire:** the ruling that the *decision* stays in the config file. E11's fallback
was "documented as provider configuration", and this ADR does not walk that back — the operator
still types the CIDR, it still lands in a file they can diff, and nothing here discovers an
address. What changes is only that the file's value now reaches the cloud without a launch.

The generalization arrives in the smallest shape that covers all three: **a capability flag plus
one optional method**. Not a reconcile loop (nothing polls), not a lifecycle hook (a provider has
none — ADR-0003), and not a required method (clause 11).

## Amending ADR-0017

ADR-0017 gave every setting `appliesAt: 'save' | 'restart'` and made the classification a required
field so it could not be forgotten. `sshAllowedCidr` was marked `'save'`, and it was **half
true**: this process adopted the value immediately, and the security group, the NSG rule and the
firewall rule went on enforcing whatever the last launch had written.

ADR-0017 anticipated exactly this and ruled on it in its own risk note: a field marked `'save'`
whose consumer still reads a captured value is **"a bug in the consumer, not a reason to
relabel"**. This ADR takes that ruling literally. `sshAllowedCidr` keeps `'save'`, and the
consumer — the cloud object — was fixed.

The amendment ADR-0017 needs is therefore not to the label but to its scope: **a `'save'`
consumer may live outside this process.** ADR-0017 was written about in-process readers, where
adoption and effect are the same event. Here they are two, and the second one crosses a network.

What preserves ADR-0017's all-or-nothing adoption is that the two are **kept separate**:

- The save is local and atomic, exactly as before. It validates, adopts or does not adopt, and
  answers. Nothing about it can now fail on a network timeout.
- The push is a **separate, bounded, best-effort call**, and **config adoption never depends on
  it**. A cloud that cannot be reached is one row in a per-cloud report — which is also the only
  shape that can honestly say "AWS updated, Azure updated, GCP refused".

Putting the three cloud calls *inside* the settings save was the tempting version and is rejected
below for this reason: it would have made an atomic local write fail on somebody else's outage,
and turned one transaction into a partial one.

## Considered options

- **Push inside the settings save.** Rejected. It is one fewer round trip and it breaks
  ADR-0017's central property: adoption is all-or-nothing and nothing may become half-applied. A
  file write that fails because ARM was slow is a worse product than a save that succeeds and a
  report that says GCP did not answer.
- **Discover the operator's address at runtime** — a "what is my IP" service, or the source
  address of their own HTTP request. **Rejected on the standing ruling**
  (`docs/providers/aws.md`, "Who can reach SSH"; `SECURITY.md`). An earlier prototype did this
  and it was removed on purpose: it breaks silently when the network changes, it makes a third
  party's availability decide a firewall rule, and it hides a security decision inside runtime
  behaviour where no reviewer sees it. Making the list plural is the part of issue #304 that
  actually serves the operator who moves, and it needs no discovery at all: they can now keep
  home *and* the office, rather than trading one for the other.
- **Delete and recreate the GCP rule**, which needs `firewalls.delete` instead of
  `firewalls.update`. Rejected outright. The rule is shared by every box in the project, so the
  window between the delete and the insert is a window in which nobody can reach anything —
  including the operator, if the insert then fails. ADR-0003 D1 reports the rule as
  `ownership: 'shared'` precisely so the reconciler cannot reap it; doing by hand what the
  reconciler is forbidden to do would be worse, not better.
- **Revoke anything not in the list.** Rejected. Rocky Surf removes only what it can prove it
  created — a stamped AWS ingress range, a GCP rule carrying its own description. A shared
  security group may hold an operator's own office range, or ranges a release older than the
  stamp authorized, and deleting those would be the product removing access it did not create and
  cannot explain.
- **A reconcile loop that periodically compares cloud to config.** Not built and not wanted. It
  would make a firewall change something the application does to itself on a timer, which is the
  posture `docs/providers/gcp.md` promised against and which this ADR deliberately keeps: the
  push happens on an explicit operator action and at no other time.
- **Passing the CIDR list into `syncSshAccess(cidrs)`.** Rejected — clause 5. Two sources of
  truth for the one value the feature exists to make authoritative.
- **A required `syncSshAccess()` that throws when the capability is false**, the literal A2
  shape. Rejected — clause 11, with the reasoning stated there rather than merely asserted.

## Consequences

### Positive

- The operator who moves is served by the feature they can actually act on: keep both networks,
  save, and the change is at the cloud in seconds without launching anything.
- GCP's `sourceRanges` can be changed at all, for the first time.
- AWS's corrected CIDR reaches EC2 on the next provision instead of after a restart, which is a
  bug fixed on the provision path independently of the sync route.
- ADR-0017's honesty claim gets stronger, not weaker: `appliesAt: 'save'` on this field is now
  true about the thing the operator cares about.
- `hetzner` and `byo` are untouched and cost nothing — they declare no capability, appear in no
  sync report, and their authors implement nothing.

### Negative

- **Neither AWS nor GCP converges to the list.** A CIDR removed from the file is still authorized
  on EC2, and still on the GCE firewall rule, until the operator runs the command they are given.
  Removing a range is therefore a two-step operation on two of the three clouds and a one-step
  operation only on Azure, and the provider docs say so plainly rather than implying parity. This
  is the largest honesty cost in the release: `sshAllowedCidr` is now fully true about *adding* a
  network on all three clouds, and only true about *removing* one on Azure.
- One more permission on GCP (`compute.firewalls.update`), and an operator upgrading from an
  older release must re-run `deploy/gcp/setup.sh` or their first sync 403s.
- The interface now has an optional method, so "implement `ComputeProvider`" is no longer a single
  complete list. The capability matrix carries the mapping, and clause 10 keeps core from having to
  care.
- A cloud can be out of date with the config file between a save and its sync — a window that did
  not exist when nothing ever synced, because everything was always out of date.

### Risks and mitigations

- **Risk:** the sync pushes a list this process never adopted, quietly undoing the operator's last
  save at the firewall. **Mitigation:** clause 9 — the route compares the file to the in-force
  config per provider and skips with an explanation when they disagree.
- **Risk:** Rocky Surf removes a range an operator added themselves. **Mitigation:** the stamp and
  the description gate; nothing unstamped is ever revoked or patched, on any cloud.
- **Risk:** a `firewalls.patch` edits a rule Rocky Surf did not create, because the name collided.
  **Mitigation:** the gate is the description Rocky Surf writes at create time, not the name,
  which is configuration.
- **Risk:** a settings save hangs because a cloud does not answer. **Mitigation:** the push is a
  separate call, and the two providers that talk to a REST API through their own client — Azure
  and GCP — hold a 30-second deadline and return `failed` with "I do not know" rather than
  "applied". The abandoned call is not cancelled, because a request already in flight may land and
  there is no way to un-issue it. AWS relies on the SDK's own timeouts and holds no deadline of
  its own, which is a difference worth knowing rather than one worth hiding.
- **Risk:** none of this has run against real cloud infrastructure. **Mitigation:** stated, not
  papered over — `managesSshAccess` carries a dagger in all three columns of the capability
  matrix, `deploy/gcp/rockysurf-role.yaml` marks `compute.firewalls.update` as derived rather than
  proven, and `docs/providers/gcp.md`'s real-cloud status block names it as the one permission
  outside that run's evidence.

## Deliberately unresolved

> **Update — resolved in issue #309 (2026-09-02).** Everything this section names as the plan has
> since shipped. AWS and GCP now CONVERGE: a stamped extra is offered keep-or-remove on the Settings
> page (default keep), and REMOVE sends it back as a confirmed, itemized revoke — AWS revokes the
> stamped ingress range authorize-before-revoke, GCP patches `sourceRanges` down to the list plus
> what was kept. Provision stays additive forever and never revokes; only this explicit confirmed
> sync may, so a half-failed sync leaves more access, never less. AWS gains the one permission this
> section anticipated — `ec2:RevokeSecurityGroupIngress` as `RevokeSshOnOwnGroupOnly` — and GCP needs
> none. An unstamped range the operator asks to remove is surfaced as a failure Rocky Surf will not
> perform, with the manual command. The reasoning below is kept as the record of why the release
> before #309 stopped short.

**Converging AWS and GCP to EXACTLY the list is not in this release.** On AWS that means revoking
the *stamped* extras — ranges Rocky Surf can prove it authorized and which the config file no
longer names. On GCP it means patching `sourceRanges` to the list alone instead of to the union of
the list and what is already there. Both are technically available today (the stamp and the
description are the proof, and GCP's permission is already granted) and both are deliberately not
done. Extras are reported, never removed, because the operator has not yet been offered the
choice — and on GCP the case is the stronger one: `sourceRanges` were frozen at create time for
the whole life of the previous release, so what is on the rule is very often an *older* config,
quite possibly the network the operator is saving from.

The right shape is a keep-or-remove prompt per extra with **keep** as the default, since the
alternative is a product that cuts off a network the operator may be sitting on the moment they
first save. What unblocks it is that prompt existing, plus — for AWS only —
`ec2:RevokeSecurityGroupIngress` being added to `deploy/aws/iam-role.yaml` and to the policy in
`docs/providers/aws.md` in the same PR. GCP needs no further permission.

**Detect-and-propose is not built.** Issue #304 opened by asking Rocky Surf to notice that the
operator's address no longer matches and offer the new one. The issue itself named this as the
droppable half ("if automatic detection turns out to be a hassle, do the smaller thing instead")
and named the push as the half that must not be dropped. Any future version of it inherits the
standing ruling above: the address may be *offered*, never adopted, and the decision still lands
in the config file after the operator says yes.

## Amendment — clouds whose rules carry no authorship (2026-09-04, issue #294, gap S2)

Clauses 12–14 rest on being able to prove Rocky Surf created a specific range: the AWS ingress
description stamp, the GCP rule description. The DigitalOcean audit on #294 found the first cloud
where that is impossible — a DigitalOcean firewall inbound rule is `{ protocol, ports, sources }`
and has **no description or name field at all** — and so needed a ruling before an honest provider
could exist.

**The ruling: where a rule cannot carry authorship, authorship belongs to the whole firewall object
Rocky Surf created and named.** Such a provider converges the object in ONE write to exactly the
configured list; `removable` is always empty and `reported` is always empty, because there is no
stamped extra to offer and no unstamped entry to preserve — the object is Rocky Surf's by
construction, or it is not touched at all. This is Azure's shape (clause 13), which already
converges `securityRules/rockysurf-ssh` whole, and it is why Azure is the model such a provider
copies. The operator's protection against surprise is unchanged: the object is created only by a
launch, is named for Rocky Surf, holds only SSH, and a firewall the operator made themselves is
never the one converged.

Anti-lockout is unchanged under either shape: provision is additive and never revokes, only an
explicit confirmed sync revokes, and what is missing is authorized before what is extra is removed.
The `add-provider` skill's `references/ssh-access.md` carries the two shapes and how to tell
which one a cloud is.

## References

- Issue #304.
- `packages/provider-sdk/src/ssh-access.ts` — `SshAccessSyncResult` and the status vocabulary.
- `packages/provider-sdk/src/ssh-cidr.ts` — `normalizeSshCidrs`, `opensSshToTheInternet`.
- `packages/provider-sdk/src/capabilities.ts` — `managesSshAccess`.
- `packages/core/src/network/routes.ts` — the sync route, and the file-versus-process skip.
- `packages/provider-aws/src/provider.ts`, `packages/provider-azure/src/provider.ts`,
  `packages/provider-gcp/src/provider.ts` — the three implementations.
- `deploy/gcp/rockysurf-role.yaml`, `docs/providers/gcp.md` — the 23-permission list, checked for
  drift by `scripts/check-gcp-role.mjs`.
- `docs/providers/{aws,azure,gcp,hetzner}.md`, "Who can reach SSH".
- `docs/providers/capability-matrix.md` — the daggered `managesSshAccess` row.
- `SECURITY.md`, the AWS section — the runtime-discovery ruling, unchanged.

## Related decisions

- ADR-0003 — amendment E11 (rejected `ensureAccess()`, "revisit if a second provider needs the
  same call") and A2 (core branches on flags; `stop`/`start` are required-and-throwing). This ADR
  is E11's revisit and A2's first deliberate exception.
- ADR-0017 — `appliesAt: 'save'`, and its ruling that a stale `'save'` consumer is a bug in the
  consumer. Amended in scope, not in label.
- ADR-0001 — the single control plane whose settings save this hangs off.
