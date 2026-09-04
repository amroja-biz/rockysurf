/**
 * Provider capabilities — the ONLY thing core is allowed to branch on.
 *
 * The spike's central property, grep-enforced by its tests and confirmed by ADR-0003: there
 * are zero `provider.id` conditionals in shared code. Every behavioural difference between
 * clouds flows through this struct. If core needs to know something a flag here cannot tell
 * it, the answer is a new flag, not a special case.
 *
 * See `docs/providers/capability-matrix.md` for the values each shipped provider declares and
 * the evidence behind them.
 */
export interface ProviderCapabilities {
  /**
   * The provider can stop an instance and start it again with its disk intact.
   *
   * This flag is the single source of truth (ADR-0003, A2). `stop()` and `start()` are
   * REQUIRED methods on every provider; when this is `false` they must throw
   * `ProviderError('invalid_spec')` — see `unsupportedOperationError`. Core checks the flag,
   * never `typeof provider.stop === 'function'`.
   */
  stop: boolean

  /**
   * A stopped-then-started instance comes back on the SAME public IP.
   *
   * `false` on AWS (a new public IPv4 on every start, absent an Elastic IP) and `true` on
   * Hetzner. Core uses this to decide whether it must re-read and re-publish the address
   * after a start, and it is what drives the `previousIp`/`ipChangedAt` UX.
   */
  ipStableAcrossStop: boolean

  /**
   * The provider carries core-generated SSH HOST keys to the box, so the box comes up already
   * presenting a key core minted.
   *
   * Renamed from the sketch's `canPinHostKey` (ADR-0003, E4) because the old name hid what it
   * costs. This is a SECURITY POSTURE, not a feature toggle:
   *
   * - `true` — core rejects an unknown host key on the very first connection. There is no
   *   trust-on-first-use window, which matters because the first connection is the one
   *   carrying the secrets file. Verified on real infrastructure for both shipped providers.
   * - `false` — core has no way to know the host key in advance and MUST fall back to
   *   trust-on-first-use: record the key seen on first contact and refuse any change after.
   *   Weaker, and callers should say so in the UI.
   *
   * Strictly this is a property of the image's cloud-init rather than of the provider API —
   * it works because cloud-init honours `ssh_keys:` in user-data and neither cloud strips it.
   * It lives here because core has nowhere else to ask.
   */
  canInjectHostKeys: boolean

  /**
   * Hard ceiling, in bytes, on the rendered user-data document BEFORE any transport encoding.
   *
   * AWS 16384, Hetzner 32768, BYO 0. Advisory in the sketch and now enforced twice: core
   * checks when rendering, and `ComputeProvider.validateSpec` lets the provider reject a spec
   * before anything is created (ADR-0003, A7). The ceiling bit for real — embedding an agent
   * in-band for callback mode produced 19,130 bytes, which is fine on Hetzner and a
   * provider-side 400 on AWS.
   */
  userDataMaxBytes: number

  /**
   * The provider delivers user-data to the box at all.
   *
   * `false` for BYO, where there is no pre-boot hook and bootstrap is SSH push only. Core
   * renders no document at all in that case, so `canInjectHostKeys` is necessarily `false`
   * too: with no user-data there is no way to place a host key before first contact.
   */
  generatesUserData: boolean

  /**
   * The provider's instances are SIMULATED: there is no machine at the address it reports.
   *
   * Added by amendment E15 (`rockysurf-8fkz`). **Additive and optional; absent means `false`,
   * which is what every provider that touches real hardware declares by saying nothing.** Only
   * the in-memory provider sets it, and only when it is registered as the no-cloud trial run
   * rather than as a test double.
   *
   * What core does with it is narrow and specific: bootstrap drives the box's install plan
   * **in-process** instead of over SSH, because there is nothing to dial. Everything else about
   * the server is unchanged — the same plan, the same journal vocabulary, the same
   * `recordProgress('ready')` promotion, the same uptime accrual. Bootstrap still owns the
   * promotion (`rockysurf-55fx.13`); this flag only says who is holding the other end of it.
   *
   * It exists because the alternative was a `provider.id === 'fake'` conditional in core, which
   * is the one thing this struct is here to prevent. A provider that has no reachable machine is
   * a fact about the provider, so it belongs here — and a third-party provider that simulates
   * (a local libvirt stub, a recorded-fixture provider) gets the same treatment for free.
   *
   * A provider MUST NOT set this while returning addresses that resolve to real hosts. Core
   * takes it as permission to skip the SSH drive entirely, so a provider that lies here would
   * report a box as installed with nothing installed on it.
   */
  simulatedInstances?: boolean

  /**
   * The provider maintains a shared cloud object that decides which networks may reach SSH, and
   * can be asked to bring it in line with `sshAllowedCidr` WITHOUT provisioning anything.
   *
   * Added by ADR-0021 (issue #304). **Additive and optional; absent means `false`**, which is
   * what a provider with no whitelist to maintain declares by saying nothing — Hetzner creates no
   * firewall object at all, and BYO does not own the network its hosts sit on.
   *
   * `true` on `aws`, `azure` and `gcp`, each of which already creates exactly one shared object
   * (a security group, an NSG child rule, a firewall rule) and, before this release, only ever
   * wrote the operator's CIDR into it during `provision()`. That is the bug this flag exists to
   * fix: the setting applied on save (ADR-0017) while the firewall went on enforcing whatever the
   * last launch had left there, so an operator who changed networks could edit the value, be told
   * it was applied, and still be locked out of every box.
   *
   * When this is `true` the provider MUST implement `syncSshAccess()`. Core checks THIS FLAG and
   * never `typeof provider.syncSshAccess === 'function'` — the rule this whole struct exists to
   * enforce. It is the first optional METHOD on the interface, which is a deliberate departure
   * from the `stop`/`start` precedent (ADR-0003 A2: required, and throwing when the flag is
   * false); the reasoning is in ADR-0021, and the short version is that a required method is a
   * breaking change for every provider written outside this repository, while a capability nobody
   * declares costs them nothing.
   */
  managesSshAccess?: boolean

  /**
   * A `stopped` instance still accrues compute charges, at the SAME hourly rate as a running one.
   *
   * Added by ADR-0025 (issue #294, amendment E17 to ADR-0003). **Additive and optional; absent
   * means `false`**, which is what every shipped provider declares by saying nothing: AWS, GCP and
   * Hetzner stop the compute meter at `stopped`, and Azure's provider chooses `deallocate` over
   * `powerOff` for exactly this reason.
   *
   * It exists because the first cloud the `adding-providers` skill was pointed at broke the
   * assumption core's billing predicate had written down — "`stopped` is out because compute
   * billing ends there on every provider core speaks to". A powered-off DigitalOcean droplet keeps
   * billing at the full rate, and DigitalOcean offers no call that releases the compute while
   * keeping the disk. Without this flag such a provider had two answers and both were lies:
   * `stop: true` made core stop accruing while the cloud went on charging (under-reporting, which
   * `isBillingRow` names as THE bug), and `stop: false` denied a real capability and threw away
   * the idle auto-stop cost lever.
   *
   * What core does with it: the meter keeps running through `stopped`, the server page says so,
   * and the New Server page warns before a machine is created. The value is recorded on the server
   * row beside the provider's last reported state, so a provider later disabled or removed cannot
   * silently stop the meter on a machine it is still charging for.
   *
   * MUST: set it when a stopped instance is charged at the running rate. MUST NOT set it for a
   * cloud that charges a REDUCED rate while stopped — core accrues the running rate and would
   * over-report; that cloud needs a new capability, which is an ADR question, never an
   * approximation. A cloud that offers both a billing and a non-billing off-state MUST use the
   * non-billing call and leave this absent, as Azure does.
   */
  billsWhileStopped?: boolean
}
