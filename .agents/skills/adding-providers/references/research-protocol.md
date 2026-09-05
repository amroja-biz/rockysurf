# The research protocol

Read this before writing a line of provider code. Every question below is a place two clouds have
already been found to differ, and every answer lands somewhere specific: a capability core computes
with, a field of a type, a setting the operator edits, or an advisory a human reads. Answer each one
**with a citation into the cloud's own documentation** — a URL and the sentence — and write the
mapping down beside it in the package README's "Capabilities" section, so a reader can check the
claim without re-doing the research.

**The hard rule.** When the cloud's honest answer fits no existing capability, field or setting,
**stop and file the ADR question** rather than choosing the nearest thing. An approximated
capability passes conformance and lies to the spend cap, the reconciler or the operator, and nothing
looks broken. The worked example below is the case that produced this rule.

## The questions

| # | question | where the answer lands |
|---|---|---|
| 1 | **Can an instance be stopped and started again with its disk intact?** | `capabilities.stop`. If not, `stop`/`start` throw `unsupportedOperationError` and the flag is `false` (BYO is the model) |
| 2 | **Does a STOPPED instance still bill compute, and at what rate?** | `capabilities.billsWhileStopped` (ADR-0025). `true` if the running rate. **A reduced rate fits no capability — stop and file.** A cloud with both a billing and a non-billing off-state uses the non-billing call (Azure `deallocate`) and leaves it absent |
| 3 | **Does the public IP survive a stop/start?** | `capabilities.ipStableAcrossStop` |
| 4 | **Can it take user-data at create, and what is the DOCUMENTED size ceiling, before or after encoding?** | `capabilities.generatesUserData`, `capabilities.userDataMaxBytes` (the ceiling on the rendered document, before transport encoding). **No documented ceiling: do not invent a round number** — see the traps in `contract.md` |
| 5 | **Can the box come up presenting a host key we minted (cloud-init `ssh_keys:` honoured, not stripped)?** | `capabilities.canInjectHostKeys`. `false` is legal and obliges the README to say what the operator trusts instead |
| 6 | **What is the firewall model? Is there a shared object (security group, NSG rule, firewall)? Can a RULE carry proof of who wrote it (a description, a name)?** | `capabilities.managesSshAccess` and how `syncSshAccess()` converges — per-rule authorship (AWS stamp, GCP description) or whole-object authorship (Azure; DigitalOcean). `ssh-access.md` |
| 7 | **Which architectures does it sell, and is availability permanent or a stock level?** | `Offering.arch` and `Offering.available` per offering. A cloud with no ARM SKUs reports amd64 only; core derives the architectures on offer. Not a capability |
| 8 | **What does it cost, in which currency, and does the API return prices inline on the call `listOfferings()` already makes?** | `Offering.hourly` as `{ amount, currency, fetchedAt }` or `null` (unknown, never free). Inline prices may be used live (the Hetzner exception); otherwise a bundled or fed table with a stamp |
| 9 | **What is the status vocabulary, and which of its words collide with the SDK's?** | `describe()`'s state map, exported and pinned by literal tests; `terminated` reached by ABSENCE after the grace, never by a status. `contract.md`, trap 1 |
| 10 | **Is the API eventually consistent after create? Does it have an async operation model (HTTP 200 = accepted)?** | The absence grace (`DESCRIBE_ABSENCE_GRACE`, lengthen never skip) and, for operations, polling inside the method until the cloud says done |
| 11 | **What idempotency primitive exists for create?** | `ProvisionSpec.idempotencyKey` → a client token (AWS), a unique name (Hetzner), or a pre-create lookup by tag when the API has none |
| 12 | **How are resources tagged or labelled — charset, length, key=value or flat strings?** | The provider's own encoding of `ProvisionSpec.tags` (`managed-by`, `server-id`), and `listManaged()`'s filter. **If `managed-by=rockysurf` is not expressible as written, choose an injective encoding and refuse a spec you cannot round-trip** — see the traps |
| 13 | **What secondary resources does a create make (keys, IPs, NICs, disks), which survive a delete, and which are shared?** | `ManagedResource.ownership` per kind, `terminate()` reaping the server-owned ones, `listManaged()` reporting all of them |
| 14 | **Does the API take raw SSH public keys inline, or need first-class key objects?** | `ProvisionSpec.sshPublicKeys` load-bearing (key objects the provider owns and reaps) or asserted-only (cloud-init) |
| 15 | **How does it authenticate — bearer token, signed requests, a credential chain?** | The vendor-SDK decision (`vendor-sdks.md`); `credentialField` + `credentialEnv` on the factory for a token cloud, `credentialEnv` alone for detection on a chain cloud, nothing stored anywhere |
| 16 | **What must exist in the account before a create (a VPC, a resource group, a project)? Does the provider create it or the operator?** | Required config fields with NO defaults and instructional refusal messages; a `docs/providers/<cloud>.md` page; least-privilege IaC where the cloud has a role model |
| 17 | **Does a console URL for one instance exist, and is everything it needs in the API's responses?** | `InstanceView.consoleUrl` — absent rather than guessed when a part (Hetzner's project id) is not in any response |
| 18 | **What does the base image ship without that the bootstrap agent assumes?** | Nothing in the SDK; a note in the README (Hetzner's Ubuntu has no `jq`). The agent bootstraps what it needs |
| 19 | **What would a human be surprised by that core does not compute with?** | `settings.advisories` — a sentence on the Settings panel or the New Server page. Never a capability, never text where a number is due |
| 20 | **Which of these facts has been OBSERVED against the real API, and which are read from documentation?** | The capability-matrix column's daggers, and the README's "Verified" section. A value nobody has exercised says so |

## The worked example: DigitalOcean, on paper

Read against the DigitalOcean API as documented in September 2026. Every claim here is a reading of
their documentation, not an observation — the column a DigitalOcean provider ships would be fully
daggered until the nightly leg exists (`wiring.md`, "Real-cloud verification").

| # | answer | lands in |
|---|---|---|
| 1 | Yes: `POST /v2/droplets/{id}/actions` with `type: power_off` / `power_on`; the disk persists | `stop: true` |
| 2 | **Yes, at the full rate.** A powered-off droplet keeps billing because the hypervisor resources stay reserved, and there is no `deallocate`-shaped action. Before ADR-0025 this fitted no capability and both available answers were lies (`stop: true` made core stop the meter; `stop: false` denied the API). This is gap S1, and the rule above exists because of it | `billsWhileStopped: true` |
| 3 | Yes: a droplet's public IPv4 is retained across power off/on | `ipStableAcrossStop: true` |
| 4 | `user_data` at create, cloud-init on the official Ubuntu images. The user-data HOW-TO page publishes no ceiling — **but the API reference does**, and that is the one to read: the droplet-create body documents `user_data` as "plain text and may not exceed 64 KiB in size". Plain text, so there is no encoding step to read the number two ways and the honest value is 65,536. The lesson generalises: when a how-to says nothing, look in the reference before concluding the cloud published nothing (found while building the provider, issue #368) | `generatesUserData: true`; `userDataMaxBytes: 65_536`, still daggered until a create is actually refused at 65,537 |
| 5 | Yes: cloud-init on the Ubuntu images honours `ssh_keys:` | `canInjectHostKeys: true` |
| 6 | **Cloud firewalls exist and a rule is `{ protocol, ports, sources }` with no description or name field.** Per-rule authorship is unprovable, so the AWS stamp and the GCP description have no equivalent. **Ruling (gap S2): authorship belongs to the whole firewall object Rocky Surf created and named** — converge in one write (`PUT`/`POST`/`DELETE /v2/firewalls/{id}/rules` to exactly the list), `removable` always empty, `reported` always empty, the Azure shape. Anti-lockout is unchanged: provision is additive, only an explicit confirmed sync revokes, authorize before revoke | `managesSshAccess: true`; `syncSshAccess()` whole-object; `settings` declares `sshAllowedCidr` as `sshCidrList` |
| 7 | **No arm64 droplets are sold at all.** `GET /v2/sizes` lists amd64 sizes with an `available` flag per region | every `Offering.arch: 'amd64'`; sold-out sizes reported with `available: false`, never omitted |
| 8 | `GET /v2/sizes` returns `price_hourly` inline, in USD, on the very call `listOfferings()` makes — the Hetzner exception applies | `Offering.hourly` live, `currency: 'USD'`, `fetchedAt` the moment of the call |
| 9 | `new` / `active` / `off` / `archive`. `off` is the SDK's `stopped` — never `terminated`; `archive` maps to `unknown` with the cloud's words in `failureReason` | the state map, pinned |
| 10 | Actions are asynchronous (`GET /v2/actions/{id}` until `completed`); a just-created droplet can be absent from a read | the absence grace at the floor or longer; poll actions inside `stop`/`start`/`terminate` |
| 11 | None native. Dedupe by a pre-create lookup on the `server-id` tag, the way an API with no client token has to | `idempotencyKey` → tag lookup |
| 12 | Tags are flat strings; letters, digits, `:`, `-`, `_`. **`managed-by=rockysurf` is not expressible.** Encode `key:value` (`managed-by:rockysurf`, `server-id:<id>`), which is injective for these keys because neither key nor value may contain `:`; refuse a spec whose tag values contain `:` rather than mangling them | the provider's tag encoding, `listManaged()`'s filter, `validateSpec()`'s refusal |
| 13 | A droplet and, if Rocky Surf creates one, a firewall it names and reuses across droplets (`shared`); SSH keys registered as account objects (`server-owned` if the provider creates them per server) | `ManagedResource.ownership` |
| 14 | Create takes SSH key IDs or fingerprints, not raw material — first-class key objects, like Hetzner | `sshPublicKeys` load-bearing; the provider owns and reaps the keys it makes |
| 15 | Bearer personal access token. Documented REST with JSON bodies — raw `fetch`, no vendor library | `credentialField: 'token'`, `credentialEnv: ['DIGITALOCEAN_TOKEN']`; nothing stored |
| 16 | A region; optionally a VPC (a default exists per region) and a project | `region` required with no default; `vpcUuid`/`projectId` optional |
| 17 | `https://cloud.digitalocean.com/droplets/{id}` — everything needed is the droplet id | `consoleUrl` on every instance |
| 18 | Not established on paper | a README note once observed |
| 19 | "A powered-off droplet bills at the full rate — only destroying it ends the charge" belongs on the New Server page as well as in the capability (the capability makes the meter honest; the sentence makes the person informed) | `settings.advisories` (`create`) |
| 20 | Everything above is reasoned from documentation | every value daggered; the "Verified" section says "not yet run against the real API" |

Two things the walk-through shows about the protocol itself. First, questions 2 and 6 are the ones
that needed rulings — one became a capability (ADR-0025), one became a documented convergence shape
(ADR-0021's amendment on whole-object authorship) — and neither could have been guessed into
correctness. Second, three answers (4, 7, 12) fit existing fields but not the way the skill used to
describe them; those are the "traps for token-and-firewall clouds" in `contract.md`.
