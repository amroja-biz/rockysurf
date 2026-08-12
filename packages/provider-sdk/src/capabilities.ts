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
}
